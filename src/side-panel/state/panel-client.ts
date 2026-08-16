import type { RuntimePort } from '../../platform/chrome/runtime-port';
import type {
  PanelEditableSettings,
  PanelSnapshot,
  PanelSettingsSnapshot,
} from '../../shared/protocol/panel-types';
import { PROTOCOL_VERSION, type ExtensionMessage } from '../../shared/protocol/message-types';
import type { SavePanelSettingsInput } from '../../tasks/panel-service';
import { parsePanelEditableSettings, parsePanelSettings, parsePanelSnapshot } from './panel-state';

export type PanelConnectionStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PanelClientState {
  readonly status: PanelConnectionStatus;
  readonly snapshot: PanelSnapshot | null;
  readonly error: string | null;
  readonly activeConversationId: string | null | undefined;
}

export interface PanelEnvironment {
  getActiveTab(): Promise<{ readonly id: number } | null>;
}

export interface PanelClientOptions {
  readonly pollIntervalMs?: number;
}

type PanelListener = () => void;

/** Creates one cryptographically unique runtime request identifier. */
function requestId(): string {
  return `panel_${crypto.randomUUID()}`;
}

/** Creates the production Chrome tab boundary for the Side Panel. */
export function createChromePanelEnvironment(): PanelEnvironment {
  return {
    async getActiveTab() {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab?.id === undefined ? null : { id: tab.id };
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
  };
  #tabId: number | null = null;
  #generation = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;
  #featuresEnsuredKey: string | null = null;

  /** Creates a full-snapshot polling client resilient to MV3 worker and UI reconnection. */
  constructor(
    runtime: RuntimePort,
    environment: PanelEnvironment,
    options: PanelClientOptions = {},
  ) {
    this.#runtime = runtime;
    this.#environment = environment;
    this.#pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 750);
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
    this.#setState({ ...this.#state, status: 'loading', error: null });
    await this.#send({
      version: PROTOCOL_VERSION,
      requestId: requestId(),
      type: 'system.ping',
      payload: {},
    }).catch(() => undefined);
    await this.refresh();
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
        this.#state = { ...this.#state, activeConversationId: undefined };
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
      let snapshot = parsePanelSnapshot(data);
      if (activeConversationId === null) {
        snapshot = { ...snapshot, conversation: null, messages: [], attachments: [], task: null };
      }
      this.#setState({
        status: 'ready',
        snapshot,
        error: null,
        activeConversationId:
          activeConversationId === undefined ? snapshot.conversation?.id : activeConversationId,
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
      this.#setState({ ...this.#state, status: 'error', error: 'PANEL_UNAVAILABLE' });
    }
  }

  /** Switches to an existing per-tab conversation and refreshes its full durable state. */
  async selectConversation(conversationId: string): Promise<void> {
    this.#setState({ ...this.#state, activeConversationId: conversationId });
    await this.refresh();
  }

  /** Starts a clean local draft while retaining the history list from the latest snapshot. */
  newConversation(): void {
    const snapshot = this.#state.snapshot;
    this.#setState({
      ...this.#state,
      activeConversationId: null,
      snapshot:
        snapshot === null
          ? null
          : { ...snapshot, conversation: null, messages: [], attachments: [], task: null },
    });
  }

  /** Submits one text/image goal and activates the newly created durable conversation if needed. */
  async submit(text: string, attachmentIds: readonly string[]): Promise<void> {
    const tabId = this.#requireTabId();
    const stateConversationId = this.#state.activeConversationId;
    const data = await this.#send({
      version: PROTOCOL_VERSION,
      requestId: requestId(),
      type: 'chat.submit',
      payload: {
        tabId,
        ...(typeof stateConversationId === 'string' ? { conversationId: stateConversationId } : {}),
        text,
        attachmentIds,
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
      this.#state = { ...this.#state, activeConversationId: data.task.conversationId };
    }
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

  /** Ensures screenshot and selected-text listeners are installed on one already-authorized tab. */
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

  /** Clears the active terminal conversation and returns to a clean local draft. */
  async clearActiveConversation(): Promise<void> {
    const conversationId = this.#state.snapshot?.conversation?.id;
    if (conversationId === undefined) return;
    await this.#send({
      version: PROTOCOL_VERSION,
      requestId: requestId(),
      type: 'conversation.clear',
      payload: { conversationId },
    });
    this.newConversation();
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

  /** Cancels the active task without deleting its conversation history. */
  cancelTask(): Promise<void> {
    return this.#runTaskCommand('task.cancel');
  }

  /** Stops polling and invalidates every in-flight response. */
  dispose(): void {
    this.#disposed = true;
    this.#generation += 1;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#listeners.clear();
  }

  /** Sends one task command for the current snapshot and reloads its resulting boundary. */
  async #runTaskCommand(type: 'task.pause' | 'task.resume' | 'task.cancel'): Promise<void> {
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

  /** Schedules the next full snapshot after the current event loop remains idle. */
  #schedulePoll(): void {
    if (this.#disposed || this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.refresh().finally(() => this.#schedulePoll());
    }, this.#pollIntervalMs);
  }
}
