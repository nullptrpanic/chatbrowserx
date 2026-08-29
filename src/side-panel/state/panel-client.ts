import type { RuntimePort } from '../../platform/chrome/runtime-port';
import type {
  PanelEditableSettings,
  PanelMessageSourcePage,
  PanelSnapshot,
  PanelSettingsSnapshot,
} from '../../shared/protocol/panel-types';
import { PROTOCOL_VERSION, type ExtensionMessage } from '../../shared/protocol/message-types';
import type { SavePanelSettingsInput } from '../../tasks/panel-service';
import {
  parsePanelEditableSettings,
  parsePanelSettings,
  parsePanelSnapshot,
  parsePanelTaskDetails,
} from './panel-state';

export type PanelConnectionStatus = 'idle' | 'loading' | 'ready' | 'error';
export type SandboxConsoleConnectionStatus = 'checking' | 'connected' | 'unavailable';

export interface PanelClientState {
  readonly status: PanelConnectionStatus;
  readonly snapshot: PanelSnapshot | null;
  readonly error: string | null;
  readonly activeConversationId: string | null | undefined;
  readonly sandboxConsoleUrl: string | null;
  readonly sandboxConsoleStatus: SandboxConsoleConnectionStatus;
}

export interface PanelEnvironment {
  getActiveTab(): Promise<{ readonly id: number } | null>;
  openSourcePage?(source: PanelMessageSourcePage): Promise<void>;
  openSandboxConsole?(url: string): Promise<void>;
}

export interface PanelClientOptions {
  readonly pollIntervalMs?: number;
}

type PanelListener = () => void;

function snapshotVersion(snapshot: PanelSnapshot | null): number {
  return snapshot?.stateVersion ?? -1;
}

function readStateVersion(value: unknown): number | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('stateVersion' in value) ||
    typeof value.stateVersion !== 'number' ||
    !Number.isSafeInteger(value.stateVersion) ||
    value.stateVersion < 0
  ) {
    return null;
  }
  return value.stateVersion;
}

function readPushedStateVersion(value: unknown): number | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== PROTOCOL_VERSION ||
    !('type' in value) ||
    value.type !== 'panel.stateChanged'
  ) {
    return null;
  }
  return readStateVersion(value);
}

function readSandboxConsoleUrl(value: unknown): string | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('url' in value) ||
    typeof value.url !== 'string' ||
    value.url.length === 0 ||
    value.url.length > 2_048
  ) {
    return null;
  }
  try {
    const protocol = new URL(value.url).protocol;
    return protocol === 'http:' || protocol === 'https:' ? value.url : null;
  } catch {
    return null;
  }
}

/** Creates one cryptographically unique runtime request identifier. */
function requestId(): string {
  return `panel_${crypto.randomUUID()}`;
}

/** Creates the production Chrome tab boundary for the Side Panel. */
export function createChromePanelEnvironment(): PanelEnvironment {
  return {
    async getActiveTab() {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      return tab?.id === undefined ? null : { id: tab.id };
    },
    async openSourcePage(source) {
      await chrome.tabs.create({ url: source.url, active: true });
    },
    async openSandboxConsole(url) {
      await chrome.tabs.create({ url, active: true });
    },
  };
}

export class PanelClient {
  readonly #runtime: RuntimePort;
  readonly #environment: PanelEnvironment;
  readonly #pollIntervalMs: number;
  readonly #listeners = new Set<PanelListener>();
  #state: PanelClientState = {
    status: 'idle',
    snapshot: null,
    error: null,
    activeConversationId: undefined,
    sandboxConsoleUrl: null,
    sandboxConsoleStatus: 'checking',
  };
  #tabId: number | null = null;
  #generation = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #unsubscribeRuntime: (() => void) | null = null;
  #notificationRefresh: Promise<void> | null = null;
  #sandboxConsoleRefresh: Promise<void> | null = null;
  #requestedStateVersion = -1;
  #disposed = false;
  #featuresEnsuredKey: string | null = null;
  readonly #detailedTasks = new Map<string, NonNullable<PanelSnapshot['task']>>();
  readonly #taskDetailLoads = new Map<string, Promise<void>>();
  readonly #taskDetailTargets = new Map<string, number>();

  /** Creates a full-snapshot polling client resilient to MV3 worker and UI reconnection. */
  constructor(
    runtime: RuntimePort,
    environment: PanelEnvironment,
    options: PanelClientOptions = {},
  ) {
    this.#runtime = runtime;
    this.#environment = environment;
    this.#pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 5_000);
  }

  /** Returns the immutable external-store snapshot consumed through useSyncExternalStore. */
  getSnapshot = (): PanelClientState => this.#state;

  /** Subscribes one React external-store listener and returns its idempotent cleanup callback. */
  subscribe = (listener: PanelListener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Connects to the active tab, requests recovery, loads state, and begins bounded polling. */
  async connect(): Promise<void> {
    if (this.#disposed) return;
    this.#unsubscribeRuntime ??= this.#runtime.subscribe?.(this.#handleRuntimeNotification) ?? null;
    this.#setState({ ...this.#state, status: 'loading', error: null });
    await this.#send({
      version: PROTOCOL_VERSION,
      requestId: requestId(),
      type: 'system.ping',
      payload: {},
    }).catch(() => undefined);
    await this.refresh();
    this.#queueSandboxConsoleRefresh();
    this.#schedulePoll();
  }

  /** Loads the latest full snapshot and ignores responses superseded by a newer tab/request. */
  async refresh(): Promise<void> {
    const generation = ++this.#generation;
    try {
      const activeTab = await this.#environment.getActiveTab();
      if (activeTab === null) throw new Error('No active browser tab is available.');
      if (this.#tabId !== activeTab.id) {
        this.#tabId = activeTab.id;
      }
      const activeConversationId = this.#state.activeConversationId;
      const data = await this.#send({
        version: PROTOCOL_VERSION,
        requestId: requestId(),
        type: 'panel.getSnapshot',
        payload: {
          tabId: activeTab.id,
          ...(typeof activeConversationId === 'string'
            ? { conversationId: activeConversationId }
            : {}),
        },
      });
      if (this.#disposed || generation !== this.#generation) return;
      let snapshot = this.#mergeDetailedTasks(parsePanelSnapshot(data));
      if (activeConversationId === null) {
        snapshot = {
          ...snapshot,
          conversation: null,
          messages: [],
          attachments: [],
          tasks: [],
          task: null,
        };
      }
      this.#setState({
        status: 'ready',
        snapshot,
        error: null,
        sandboxConsoleUrl: this.#state.sandboxConsoleUrl,
        sandboxConsoleStatus: this.#state.sandboxConsoleStatus,
        activeConversationId:
          activeConversationId === undefined
            ? undefined
            : activeConversationId === null
              ? null
              : (snapshot.conversation?.id ?? undefined),
      });
      const featureKey = `${String(snapshot.tab.id)}:${snapshot.tab.origin}`;
      if (snapshot.tab.hasPermission && this.#featuresEnsuredKey !== featureKey) {
        this.#featuresEnsuredKey = featureKey;
        void this.#ensurePageFeatures(snapshot.tab.id).catch(() => {
          if (this.#featuresEnsuredKey === featureKey) this.#featuresEnsuredKey = null;
        });
      }
    } catch {
      if (this.#disposed || generation !== this.#generation) return;
      this.#setState({
        ...this.#state,
        status: 'error',
        error: 'PANEL_UNAVAILABLE',
      });
    }
  }

  /** Switches to an existing global conversation and refreshes its full durable state. */
  async selectConversation(conversationId: string): Promise<void> {
    this.#setState({ ...this.#state, activeConversationId: conversationId });
    await this.refresh();
  }

  /** Loads and caches the complete persisted execution detail for one expanded task card. */
  loadTaskDetails(taskId: string): Promise<void> {
    const visibleTask = this.#state.snapshot?.tasks.find((task) => task.id === taskId);
    if (visibleTask !== undefined) {
      this.#taskDetailTargets.set(
        taskId,
        Math.max(this.#taskDetailTargets.get(taskId) ?? 0, visibleTask.sequence),
      );
    }
    const existing = this.#taskDetailLoads.get(taskId);
    if (existing !== undefined) return existing;
    const loading = this.#loadTaskDetailsThroughTarget(taskId).finally(() => {
      if (this.#taskDetailLoads.get(taskId) === loading) this.#taskDetailLoads.delete(taskId);
      this.#taskDetailTargets.delete(taskId);
    });
    this.#taskDetailLoads.set(taskId, loading);
    return loading;
  }

  /** Starts a clean local draft while retaining the history list from the latest snapshot. */
  newConversation(): void {
    this.#detailedTasks.clear();
    const snapshot = this.#state.snapshot;
    this.#setState({
      ...this.#state,
      activeConversationId: null,
      snapshot:
        snapshot === null
          ? null
          : {
              ...snapshot,
              conversation: null,
              messages: [],
              attachments: [],
              tasks: [],
              task: null,
            },
    });
  }

  /** Submits one text/image goal and activates the newly created durable conversation if needed. */
  async submit(
    text: string,
    attachmentIds: readonly string[],
    replyTo?: { readonly messageId: string; readonly taskId: string },
  ): Promise<void> {
    const activeTab = await this.#environment.getActiveTab();
    if (activeTab === null) throw new Error('No active browser tab is available.');
    const tabId = activeTab.id;
    this.#tabId = tabId;
    const stateConversationId = this.#state.activeConversationId;
    const submissionConversationId =
      stateConversationId === undefined
        ? this.#state.snapshot?.conversation?.id
        : stateConversationId;
    const data = await this.#send({
      version: PROTOCOL_VERSION,
      requestId: requestId(),
      type: 'chat.submit',
      payload: {
        tabId,
        ...(typeof submissionConversationId === 'string'
          ? { conversationId: submissionConversationId }
          : {}),
        text,
        attachmentIds,
        ...(replyTo === undefined ? {} : { replyTo }),
      },
    });
    if (
      typeof data === 'object' &&
      data !== null &&
      'task' in data &&
      typeof data.task === 'object' &&
      data.task !== null &&
      'conversationId' in data.task &&
      typeof data.task.conversationId === 'string'
    ) {
      this.#state = {
        ...this.#state,
        activeConversationId: data.task.conversationId,
      };
    }
    await this.refresh();
  }

  /** Queues text or images for the next safe Agent Loop boundary of the running task. */
  async supplement(text: string, attachmentIds: readonly string[]): Promise<void> {
    const taskId = this.#state.snapshot?.task?.id;
    if (taskId === undefined) throw new Error('No active task is available for supplementation.');
    await this.#send({
      version: PROTOCOL_VERSION,
      requestId: requestId(),
      type: 'chat.supplement',
      payload: { taskId, text, attachmentIds },
    });
    await this.refresh();
  }

  /** Captures a viewport or selected region and returns its new attachment identifier. */
  async captureScreenshot(mode: 'viewport' | 'region'): Promise<string | null> {
    const data = await this.#send({
      version: PROTOCOL_VERSION,
      requestId: requestId(),
      type: 'screenshot.capture',
      payload: { tabId: this.#requireTabId(), mode },
    });
    if (data === null) return null;
    if (typeof data !== 'object' || !('id' in data) || typeof data.id !== 'string') {
      throw new Error('Screenshot response is invalid.');
    }
    return data.id;
  }

  /** Opens an attachment on the current page, falling back to the Side Panel when unavailable. */
  async openImagePreview(attachmentId: string): Promise<boolean> {
    try {
      const data = await this.#send({
        version: PROTOCOL_VERSION,
        requestId: requestId(),
        type: 'image.preview.open',
        payload: { tabId: this.#requireTabId(), attachmentId },
      });
      return typeof data === 'object' && data !== null && 'opened' in data && data.opened === true;
    } catch {
      return false;
    }
  }

  /** Opens the immutable URL captured when one user message was submitted. */
  async openSourcePage(source: PanelMessageSourcePage): Promise<void> {
    if (this.#environment.openSourcePage === undefined) return;
    await this.#environment.openSourcePage(source);
  }

  /** Opens the current ephemeral Sandbox console link without persisting it in panel data. */
  async openSandboxConsole(): Promise<void> {
    const url = this.#state.sandboxConsoleUrl;
    if (url === null || this.#environment.openSandboxConsole === undefined) return;
    await this.#environment.openSandboxConsole(url);
  }

  /** Ensures page commands are installed on one already-authorized tab. */
  async #ensurePageFeatures(tabId: number): Promise<void> {
    await this.#send({
      version: PROTOCOL_VERSION,
      requestId: requestId(),
      type: 'page.features.ensure',
      payload: { tabId },
    });
  }

  /** Loads credential-bearing settings only when the trusted settings screen requests them. */
  async getSettings(): Promise<PanelEditableSettings> {
    const data = await this.#send({
      version: PROTOCOL_VERSION,
      requestId: requestId(),
      type: 'settings.get',
      payload: {},
    });
    return parsePanelEditableSettings(data);
  }

  /** Persists trusted settings fields and refreshes the sanitized settings projection. */
  async saveSettings(input: SavePanelSettingsInput): Promise<PanelSettingsSnapshot> {
    const data = await this.#send({
      version: PROTOCOL_VERSION,
      requestId: requestId(),
      type: 'settings.save',
      payload: input,
    });
    await this.refresh();
    return parsePanelSettings(data);
  }

  /** Clears the active conversation and returns to a clean local draft. */
  async clearActiveConversation(): Promise<void> {
    const conversationId = this.#state.snapshot?.conversation?.id;
    if (conversationId === undefined) return;
    await this.deleteConversation(conversationId);
  }

  /** Deletes any history conversation while preserving a different active selection. */
  async deleteConversation(conversationId: string): Promise<void> {
    const deletingCurrent = this.#state.snapshot?.conversation?.id === conversationId;
    await this.#send({
      version: PROTOCOL_VERSION,
      requestId: requestId(),
      type: 'conversation.clear',
      payload: { conversationId },
    });
    if (deletingCurrent) this.newConversation();
    await this.refresh();
  }

  /** Pauses the active task after aborting its in-memory runner. */
  pauseTask(): Promise<void> {
    return this.#runTaskCommand('task.pause');
  }

  /** Resumes the active task from its durable model boundary. */
  resumeTask(): Promise<void> {
    return this.#runTaskCommand('task.resume');
  }

  /** Retries the active failed task without appending a duplicate user message. */
  retryTask(): Promise<void> {
    return this.#runTaskCommand('task.retry');
  }

  /** Cancels the active task without deleting its conversation history. */
  cancelTask(): Promise<void> {
    return this.#runTaskCommand('task.cancel');
  }

  /** Discards one cancelled task's continuation while retaining visible history and audit data. */
  async clearTaskContext(taskId: string): Promise<void> {
    await this.#send({
      version: PROTOCOL_VERSION,
      requestId: requestId(),
      type: 'task.clearContext',
      payload: { taskId },
    });
    await this.refresh();
  }

  /** Stops polling and invalidates every in-flight response. */
  dispose(): void {
    this.#disposed = true;
    this.#generation += 1;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#unsubscribeRuntime?.();
    this.#unsubscribeRuntime = null;
    this.#listeners.clear();
    this.#detailedTasks.clear();
    this.#taskDetailLoads.clear();
    this.#taskDetailTargets.clear();
  }

  /** Coalesces pushed versions and refreshes only when they are newer than rendered state. */
  readonly #handleRuntimeNotification = (value: unknown): void => {
    const stateVersion = readPushedStateVersion(value);
    if (
      this.#disposed ||
      stateVersion === null ||
      stateVersion <= snapshotVersion(this.#state.snapshot) ||
      stateVersion <= this.#requestedStateVersion
    ) {
      return;
    }
    this.#requestedStateVersion = stateVersion;
    this.#queueNotificationRefresh();
  };

  /** Runs at most one pushed refresh at a time and follows only genuinely newer queued versions. */
  #queueNotificationRefresh(): void {
    if (this.#notificationRefresh !== null || this.#disposed) return;
    const refreshTarget = this.#requestedStateVersion;
    this.#notificationRefresh = Promise.resolve()
      .then(() => this.refresh())
      .finally(() => {
        this.#notificationRefresh = null;
        if (this.#requestedStateVersion > refreshTarget) this.#queueNotificationRefresh();
      });
  }

  /** Coalesces non-blocking probes so a slow Sandbox never delays chat state or stacks requests. */
  #queueSandboxConsoleRefresh(): void {
    if (this.#sandboxConsoleRefresh !== null || this.#disposed) return;
    const refresh = this.#refreshSandboxConsole().finally(() => {
      if (this.#sandboxConsoleRefresh === refresh) this.#sandboxConsoleRefresh = null;
    });
    this.#sandboxConsoleRefresh = refresh;
  }

  /** Publishes the validated console link and the completed non-blocking probe status. */
  async #refreshSandboxConsole(): Promise<void> {
    const url = await this.#send({
      version: PROTOCOL_VERSION,
      requestId: requestId(),
      type: 'sandbox.getConsole',
      payload: {},
    })
      .then((data) => readSandboxConsoleUrl(data))
      .catch(() => null);
    const sandboxConsoleStatus = url === null ? 'unavailable' : 'connected';
    if (
      this.#disposed ||
      (url === this.#state.sandboxConsoleUrl &&
        sandboxConsoleStatus === this.#state.sandboxConsoleStatus)
    ) {
      return;
    }
    this.#setState({
      ...this.#state,
      sandboxConsoleUrl: url,
      sandboxConsoleStatus,
    });
  }

  /** Repeats a local detail read when an in-flight response predates a newer requested boundary. */
  async #loadTaskDetailsThroughTarget(taskId: string): Promise<void> {
    while (!this.#disposed) {
      const visibleTask = this.#state.snapshot?.tasks.find((task) => task.id === taskId);
      if (visibleTask === undefined) return;
      await this.#loadTaskDetails(taskId);
      const requestedSequence = this.#taskDetailTargets.get(taskId) ?? visibleTask.sequence;
      const loadedSequence = this.#detailedTasks.get(taskId)?.sequence ?? -1;
      if (loadedSequence >= requestedSequence) return;
    }
  }

  /** Fetches one detail projection and applies it only while that task remains visible. */
  async #loadTaskDetails(taskId: string): Promise<void> {
    const data = await this.#send({
      version: PROTOCOL_VERSION,
      requestId: requestId(),
      type: 'panel.getTaskDetails',
      payload: { taskId },
    });
    const detailedTask = parsePanelTaskDetails(data);
    if (detailedTask.id !== taskId) throw new Error('Panel task detail identifier is invalid.');
    const snapshot = this.#state.snapshot;
    const current = snapshot?.tasks.find((task) => task.id === taskId);
    if (snapshot === null || current === undefined || detailedTask.sequence < current.sequence) {
      return;
    }
    this.#detailedTasks.set(taskId, detailedTask);
    const tasks = snapshot.tasks.map((task) => (task.id === taskId ? detailedTask : task));
    this.#setState({
      ...this.#state,
      snapshot: {
        ...snapshot,
        tasks,
        task: snapshot.task?.id === taskId ? detailedTask : snapshot.task,
      },
    });
  }

  /** Keeps loaded detail nodes mounted until a newer full projection replaces them. */
  #mergeDetailedTasks(snapshot: PanelSnapshot): PanelSnapshot {
    const visibleIds = new Set(snapshot.tasks.map(({ id }) => id));
    for (const taskId of this.#detailedTasks.keys()) {
      if (!visibleIds.has(taskId)) this.#detailedTasks.delete(taskId);
    }
    const tasks = snapshot.tasks.map((task) => {
      const detailed = this.#detailedTasks.get(task.id);
      if (detailed === undefined) return task;
      if (detailed.sequence > task.sequence) return detailed;
      return {
        ...task,
        detailLevel: detailed.sequence === task.sequence ? ('full' as const) : ('summary' as const),
        events: detailed.events,
        toolResults: detailed.toolResults,
        supplements: task.supplements,
      };
    });
    const task =
      snapshot.task === null
        ? null
        : (tasks.find(({ id }) => id === snapshot.task?.id) ?? snapshot.task);
    return { ...snapshot, tasks, task };
  }

  /** Sends one task command for the current snapshot and reloads its resulting boundary. */
  async #runTaskCommand(
    type: 'task.pause' | 'task.resume' | 'task.retry' | 'task.cancel',
  ): Promise<void> {
    const taskId = this.#state.snapshot?.task?.id;
    if (taskId === undefined) return;
    const message: ExtensionMessage = {
      version: PROTOCOL_VERSION,
      requestId: requestId(),
      type,
      payload: { taskId },
    };
    await this.#send(message);
    await this.refresh();
  }

  /** Sends one runtime message and returns only a successful response data field. */
  async #send(message: ExtensionMessage): Promise<unknown> {
    const response = await this.#runtime.send(message);
    if (!response.ok) throw new Error(response.error.code);
    return response.data;
  }

  /** Returns the current active tab identifier or rejects commands before connection. */
  #requireTabId(): number {
    if (this.#tabId === null) throw new Error('Panel is not connected to a browser tab.');
    return this.#tabId;
  }

  /** Publishes one immutable state replacement to a stable listener snapshot. */
  #setState(state: PanelClientState): void {
    this.#state = state;
    for (const listener of [...this.#listeners]) listener();
  }

  /** Performs a cheap recovery check and reloads only for a changed tab or durable version. */
  async #recoverIfChanged(): Promise<void> {
    const activeTab = await this.#environment.getActiveTab();
    if (activeTab === null || activeTab.id !== this.#tabId || this.#state.snapshot === null) {
      await this.refresh();
      return;
    }
    const data = await this.#send({
      version: PROTOCOL_VERSION,
      requestId: requestId(),
      type: 'panel.getStateVersion',
      payload: {},
    });
    const stateVersion = readStateVersion(data);
    if (stateVersion === null) throw new Error('Panel state version is invalid.');
    if (stateVersion > snapshotVersion(this.#state.snapshot)) await this.refresh();
  }

  /** Schedules the next cheap recovery probe after the current event loop remains idle. */
  #schedulePoll(): void {
    if (this.#disposed || this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#queueSandboxConsoleRefresh();
      void this.#recoverIfChanged()
        .catch(() => undefined)
        .finally(() => this.#schedulePoll());
    }, this.#pollIntervalMs);
  }
}
