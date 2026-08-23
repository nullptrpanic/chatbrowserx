import type { AttachmentRepository } from '../persistence/attachment-repository';
import { IMAGE_POLICY } from '../attachments/attachment-policy';
import type { ConversationRepository } from '../persistence/conversation-repository';
import type { CredentialStore } from '../persistence/credential-store';
import type { SettingsStore, AppLanguage, ReasoningEffort } from '../persistence/settings-store';
import type { TaskRepository } from '../persistence/task-repository';
import type {
  PanelAttachment,
  PanelConversationSummary,
  PanelEditableSettings,
  PanelSettingsSnapshot,
  PanelSnapshot,
  PanelTask,
} from '../shared/protocol/panel-types';
import type { IdGenerator } from '../shared/ids';
import { bytesToBase64 } from '../shared/base64';
import type { Clock } from '../shared/time';
import type { SkillCatalogPort } from '../sandbox/skill-catalog';
import type { Checkpoint, CompletedToolResult } from './checkpoint-types';
import type { MessageRecord, MessageSourcePage } from './message-types';
import { TaskCommandError, type TaskCommandPort, type TaskSnapshot } from './task-command-service';
import type { TaskEvent, TaskRun } from './task-types';

const ATTACHMENT_GC_GRACE_MS = 24 * 60 * 60 * 1_000;
const MAX_PANEL_MESSAGES = 500;
const MAX_PANEL_EVENTS = 100;
const MAX_PANEL_TOOL_ARGUMENTS = 20_000;
const MAX_PANEL_TOOL_OUTPUT = 100_000;
const MAX_PANEL_REASONING_SUMMARY = 20_000;
const MAX_PANEL_SUPPLEMENTS = 100;
const MAX_SOURCE_FAVICON_URL = 8_192;
const terminalTaskStatuses = new Set<TaskRun['status']>(['completed', 'failed', 'cancelled']);
const previewImageTypes = new Set<string>(IMAGE_POLICY.acceptedMimeTypes);

export interface PanelServiceDependencies {
  readonly conversations: Pick<
    ConversationRepository,
    | 'listAll'
    | 'get'
    | 'create'
    | 'listMessages'
    | 'appendMessage'
    | 'appendSupplement'
    | 'updateMessage'
    | 'clearConversation'
  >;
  readonly tasks: Pick<
    TaskRepository,
    'get' | 'listByConversation' | 'listEvents' | 'getCheckpoint' | 'listUnfinished'
  >;
  readonly attachments: Pick<AttachmentRepository, 'get' | 'deleteUnreferenced'>;
  readonly settings: Pick<SettingsStore, 'get' | 'save'>;
  readonly credentials: Pick<
    CredentialStore,
    | 'getCodexAccessToken'
    | 'setCodexAccessToken'
    | 'getTavilyKey'
    | 'setTavilyKey'
    | 'getSandboxToken'
    | 'setSandboxToken'
  >;
  readonly sandboxCatalog?: Pick<SkillCatalogPort, 'invalidate'>;
  readonly commands: Pick<TaskCommandPort, 'create' | 'continueCancelled'>;
  readonly cancelTask: (taskId: string) => Promise<TaskSnapshot>;
  readonly tabs: {
    get(tabId: number): Promise<{
      readonly id?: number | undefined;
      readonly title?: string | undefined;
      readonly url?: string | undefined;
      readonly favIconUrl?: string | undefined;
    }>;
  };
  readonly permissions: {
    contains(permissions: { readonly origins: readonly string[] }): Promise<boolean>;
  };
  readonly imagePreview: {
    open(tabId: number, preview: { readonly src: string; readonly alt: string }): Promise<void>;
  };
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly scheduleTask: (taskId: string) => Promise<void>;
}

export interface SubmitPanelMessageInput {
  readonly tabId: number;
  readonly conversationId?: string | undefined;
  readonly text: string;
  readonly attachmentIds: readonly string[];
}

export interface SupplementPanelMessageInput {
  readonly taskId: string;
  readonly text: string;
  readonly attachmentIds: readonly string[];
}

export interface SavePanelSettingsInput {
  readonly reasoningEffort: ReasoningEffort;
  readonly systemPrompt: string;
  readonly language: AppLanguage;
  readonly historyMessageLimit?: number | undefined;
  readonly codexAccessToken?: string | undefined;
  readonly tavilyKey?: string | undefined;
  readonly sandboxServer?: string | undefined;
  readonly sandboxToken?: string | undefined;
}

/** Returns a supported origin and permission pattern without accepting internal browser pages. */
function readWebOrigin(
  value: string,
): { readonly origin: string; readonly pattern: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return { origin: url.origin, pattern: `${url.origin}/*` };
  } catch {
    return null;
  }
}

/** Keeps only bounded favicon URLs that are safe to render in the trusted panel. */
function readFaviconUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SOURCE_FAVICON_URL) {
    return null;
  }
  if (value.startsWith('data:image/')) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/** Validates and bounds one durable page snapshot before persistence or panel projection. */
function readMessageSourcePage(
  source: MessageSourcePage | undefined,
): MessageSourcePage | undefined {
  if (source === undefined) return undefined;
  const url = source.url.slice(0, 4_096);
  const webOrigin = readWebOrigin(url);
  if (webOrigin === null) return undefined;
  const title = source.title.trim().slice(0, 500) || new URL(url).hostname;
  return {
    title,
    url,
    favIconUrl: readFaviconUrl(source.favIconUrl),
  };
}

/** Derives a compact conversation title from the first nonblank message line. */
function conversationTitle(text: string, hasAttachments: boolean): string {
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (line.length > 0) return line.slice(0, 60);
  return hasAttachments ? '图片任务' : '新对话';
}

/** Derives the nonblank task goal accepted by the durable task factory. */
function taskGoal(text: string): string {
  const normalized = text.trim();
  return normalized.length > 0 ? normalized : '请根据所附图片完成当前页面任务。';
}

interface TaskDetailIndexes {
  readonly itemCount: number;
  readonly resultIndexes: ReadonlyMap<string, number>;
  readonly supplementIndexes: ReadonlyMap<string, number>;
  readonly appliedSupplementIds: ReadonlySet<string>;
}

interface TaskReadCache {
  readonly checkpoints: Map<string, Promise<Checkpoint | undefined>>;
  readonly events: Map<string, Promise<readonly TaskEvent[]>>;
}

/** Matches the durable WorkSession continuation ordering. */
function compareWorkSessionTasks(left: TaskRun, right: TaskRun): number {
  return (
    left.createdAt - right.createdAt ||
    left.updatedAt - right.updatedAt ||
    left.id.localeCompare(right.id)
  );
}

/** Selects one task and every earlier TaskRun in the same WorkSession. */
function workSessionTaskPrefix(tasks: readonly TaskRun[], target: TaskRun): readonly TaskRun[] {
  const candidates = tasks.some(({ id }) => id === target.id) ? tasks : [...tasks, target];
  const ordered = candidates
    .filter(({ workSessionId }) => workSessionId === target.workSessionId)
    .sort(compareWorkSessionTasks);
  const targetIndex = ordered.findIndex(({ id }) => id === target.id);
  return targetIndex < 0 ? [target] : ordered.slice(0, targetIndex + 1);
}

function createTaskReadCache(): TaskReadCache {
  return { checkpoints: new Map(), events: new Map() };
}

/** Assigns stable display positions across completed tools and applied or pending supplements. */
function taskDetailIndexes(
  completedResults: readonly CompletedToolResult[],
  events: readonly TaskEvent[],
  supplements: readonly MessageRecord[],
): TaskDetailIndexes {
  const resultIndexes = new Map<string, number>();
  const supplementIndexes = new Map<string, number>();
  const assignedSupplements = new Set<string>();
  const resultEvents = events.filter((event) => event.type === 'tool.result-recorded');
  const pairedCount = Math.min(resultEvents.length, completedResults.length);
  const firstPairedEvent = resultEvents.length - pairedCount;
  const firstPairedResult = completedResults.length - pairedCount;
  const resultByEvent = new Map<TaskEvent, CompletedToolResult>();
  let itemCount = 0;

  for (const result of completedResults.slice(0, firstPairedResult)) {
    resultIndexes.set(result.callId, ++itemCount);
  }
  for (let index = 0; index < pairedCount; index += 1) {
    const event = resultEvents[firstPairedEvent + index];
    const result = completedResults[firstPairedResult + index];
    if (event !== undefined && result !== undefined) {
      resultByEvent.set(event, result);
    }
  }

  for (const event of events) {
    const result = resultByEvent.get(event);
    if (result !== undefined) {
      resultIndexes.set(result.callId, ++itemCount);
      continue;
    }
    if (event.type !== 'task.supplements-applied') continue;

    const explicitIds = event.supplementIds === undefined ? null : new Set(event.supplementIds);
    const applied = supplements
      .filter(
        (message) =>
          !assignedSupplements.has(message.id) &&
          (explicitIds === null ? message.createdAt <= event.at : explicitIds.has(message.id)),
      )
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.updatedAt - right.updatedAt ||
          left.id.localeCompare(right.id),
      );
    for (const message of applied) {
      assignedSupplements.add(message.id);
      supplementIndexes.set(message.id, ++itemCount);
    }
  }

  for (const message of supplements
    .filter((candidate) => !assignedSupplements.has(candidate.id))
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt ||
        left.updatedAt - right.updatedAt ||
        left.id.localeCompare(right.id),
    )) {
    supplementIndexes.set(message.id, ++itemCount);
  }
  return {
    itemCount,
    resultIndexes,
    supplementIndexes,
    appliedSupplementIds: assignedSupplements,
  };
}

export class PanelService {
  readonly #dependencies: PanelServiceDependencies;
  #submissionInFlight = false;

  /** Creates the sanitized Side Panel query and command boundary. */
  constructor(dependencies: PanelServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /** Builds a fresh global-conversation snapshot with current-tab page context. */
  async getSnapshot(tabId: number, conversationId?: string): Promise<PanelSnapshot> {
    const [tab, conversations, settings] = await Promise.all([
      this.#dependencies.tabs.get(tabId),
      this.#dependencies.conversations.listAll(),
      this.#readSettings(),
    ]);
    const url = (tab.url ?? '').slice(0, 4_096);
    const webOrigin = readWebOrigin(url);
    const hasPermission =
      webOrigin === null
        ? false
        : await this.#dependencies.permissions
            .contains({ origins: [webOrigin.pattern] })
            .catch(() => false);
    const taskLists = await Promise.all(
      conversations.map((conversation) =>
        this.#dependencies.tasks.listByConversation(conversation.id),
      ),
    );
    const summaries: PanelConversationSummary[] = conversations.map((conversation, index) => {
      const task = taskLists[index]?.at(-1) ?? null;
      return {
        id: conversation.id,
        title: conversation.title,
        tabId: conversation.tabId,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        taskStatus: task?.status ?? null,
      };
    });
    const requestedIndex =
      conversationId === undefined
        ? -1
        : summaries.findIndex((conversation) => conversation.id === conversationId);
    const selectedIndex = summaries.length === 0 ? -1 : Math.max(0, requestedIndex);
    const selected = selectedIndex < 0 ? null : (conversations[selectedIndex] ?? null);
    const selectedSummary = selectedIndex < 0 ? null : (summaries[selectedIndex] ?? null);
    const selectedTasks = selectedIndex < 0 ? [] : (taskLists[selectedIndex] ?? []);
    const latestTask = selectedTasks.at(-1) ?? null;
    const allStoredMessages =
      selected === null ? [] : await this.#dependencies.conversations.listMessages(selected.id);
    const storedMessages = allStoredMessages.slice(-MAX_PANEL_MESSAGES);
    const messages = storedMessages.filter((message) => message.kind === 'conversation');
    const taskReadCache = createTaskReadCache();
    const [attachments, appliedSupplementIdsByWorkSession] = await Promise.all([
      this.#readAttachmentMetadata(storedMessages),
      this.#readAppliedSupplementIdsByWorkSession(selectedTasks, allStoredMessages, taskReadCache),
    ]);
    const visibleTaskIds = new Set(
      storedMessages.flatMap((message) => (message.taskId === null ? [] : [message.taskId])),
    );
    if (latestTask !== null) visibleTaskIds.add(latestTask.id);
    const panelTasks = await Promise.all(
      selectedTasks
        .filter((task) => visibleTaskIds.has(task.id))
        .map((task) =>
          this.#readTask(
            task,
            allStoredMessages,
            'summary',
            appliedSupplementIdsByWorkSession.get(task.workSessionId),
            selectedTasks,
            taskReadCache,
          ),
        ),
    );
    const panelTask =
      latestTask === null ? null : (panelTasks.find((task) => task.id === latestTask.id) ?? null);

    return {
      generatedAt: this.#dependencies.clock.now(),
      tab: {
        id: tab.id ?? tabId,
        title: (tab.title ?? '').slice(0, 500),
        url,
        origin: webOrigin?.origin ?? '',
        supported: webOrigin !== null,
        hasPermission,
      },
      conversation: selectedSummary,
      conversations: summaries,
      messages: messages.map((message) => {
        const sourcePage = readMessageSourcePage(message.sourcePage);
        return {
          id: message.id,
          taskId: message.taskId,
          role: message.role,
          status: message.status,
          text: message.text,
          attachmentIds: [...message.attachmentIds],
          ...(sourcePage === undefined ? {} : { sourcePage }),
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        };
      }),
      attachments,
      tasks: panelTasks,
      task: panelTask,
      settings,
    };
  }

  /** Loads result bodies aligned with the retained event window for one expanded task. */
  async getTaskDetails(taskId: string): Promise<PanelTask> {
    const normalizedTaskId = taskId.trim();
    if (normalizedTaskId.length === 0 || normalizedTaskId.length > 256) {
      throw new Error('Task detail request is invalid.');
    }
    const task = await this.#dependencies.tasks.get(normalizedTaskId);
    if (task === undefined) throw new Error('Task details are unavailable.');
    const [messages, conversationTasks] = await Promise.all([
      this.#dependencies.conversations.listMessages(task.conversationId),
      this.#dependencies.tasks.listByConversation(task.conversationId),
    ]);
    const taskReadCache = createTaskReadCache();
    const appliedSupplementIdsByWorkSession = await this.#readAppliedSupplementIdsByWorkSession(
      conversationTasks,
      messages,
      taskReadCache,
    );
    return this.#readTask(
      task,
      messages,
      'full',
      appliedSupplementIdsByWorkSession.get(task.workSessionId),
      conversationTasks,
      taskReadCache,
    );
  }

  /** Persists a user message before creating and scheduling its recoverable browser task. */
  async submit(input: SubmitPanelMessageInput): Promise<TaskSnapshot> {
    if (!Number.isInteger(input.tabId) || input.tabId < 0) throw new Error('Tab is invalid.');
    const text = input.text.trim();
    const attachmentIds = [...new Set(input.attachmentIds.map((id) => id.trim()))];
    if (text.length > 20_000 || (text.length === 0 && attachmentIds.length === 0)) {
      throw new Error('Message content is invalid.');
    }
    if (
      attachmentIds.length > 8 ||
      attachmentIds.some((id) => id.length === 0 || id.length > 256)
    ) {
      throw new Error('Message attachments are invalid.');
    }

    if (this.#submissionInFlight) {
      throw new TaskCommandError('TASK_ALREADY_RUNNING', '已有任务运行中');
    }
    this.#submissionInFlight = true;

    try {
      if ((await this.#dependencies.tasks.listUnfinished()).length > 0) {
        throw new TaskCommandError('TASK_ALREADY_RUNNING', '已有任务运行中');
      }

      const sourceTab = await this.#dependencies.tabs.get(input.tabId);
      const sourcePage = readMessageSourcePage({
        title: sourceTab.title ?? '',
        url: sourceTab.url ?? '',
        favIconUrl: sourceTab.favIconUrl ?? null,
      });
      const now = this.#dependencies.clock.now();
      let latestTask: TaskRun | undefined;
      const conversation =
        input.conversationId === undefined
          ? {
              id: this.#createId('conversation'),
              tabId: input.tabId,
              title: conversationTitle(text, attachmentIds.length > 0),
              createdAt: now,
              updatedAt: now,
            }
          : await this.#dependencies.conversations.get(input.conversationId);
      if (conversation === undefined) {
        throw new Error('Conversation is unavailable.');
      }
      if (input.conversationId !== undefined) {
        const tasks = await this.#dependencies.tasks.listByConversation(conversation.id);
        latestTask = tasks.at(-1);
        if (tasks.some((task) => !terminalTaskStatuses.has(task.status))) {
          throw new TaskCommandError('TASK_ALREADY_RUNNING', '已有任务运行中');
        }
      }
      if (input.conversationId === undefined) {
        await this.#dependencies.conversations.create(conversation);
      }

      const message: MessageRecord = {
        id: this.#createId('message'),
        kind: 'conversation',
        conversationId: conversation.id,
        taskId: null,
        role: 'user',
        status: 'complete',
        text,
        attachmentIds,
        ...(sourcePage === undefined ? {} : { sourcePage }),
        createdAt: now,
        updatedAt: now,
      };
      await this.#dependencies.conversations.appendMessage(message);
      const goal = taskGoal(text);
      const snapshot =
        latestTask?.status === 'cancelled' &&
        !(await this.#dependencies.tasks
          .listEvents(latestTask.id)
          .then((events) => events.some((event) => event.type === 'task.context-cleared')))
          ? await this.#dependencies.commands.continueCancelled({
              sourceTaskId: latestTask.id,
              tabId: input.tabId,
              goal,
              userMessageId: message.id,
            })
          : await this.#dependencies.commands.create({
              conversationId: conversation.id,
              tabId: input.tabId,
              goal,
              userMessageId: message.id,
            });
      await this.#dependencies.conversations.updateMessage({
        ...message,
        taskId: snapshot.task.id,
        updatedAt: Math.max(message.updatedAt, snapshot.task.createdAt),
      });
      await this.#dependencies.scheduleTask(snapshot.task.id);
      return snapshot;
    } finally {
      this.#submissionInFlight = false;
    }
  }

  /** Persists additional text or images for the next safe loop boundary of a running task. */
  async supplement(
    input: SupplementPanelMessageInput,
  ): Promise<{ readonly accepted: true; readonly id: string }> {
    const taskId = input.taskId.trim();
    const text = input.text.trim();
    const attachmentIds = [...new Set(input.attachmentIds.map((id) => id.trim()))];
    if (
      taskId.length === 0 ||
      taskId.length > 256 ||
      text.length > 20_000 ||
      (text.length === 0 && attachmentIds.length === 0) ||
      attachmentIds.length > 8 ||
      attachmentIds.some((id) => id.length === 0 || id.length > 256)
    ) {
      throw new Error('Supplement content is invalid.');
    }
    const task = await this.#dependencies.tasks.get(taskId);
    if (task === undefined) {
      throw new Error('Supplement task is unavailable.');
    }

    const now = this.#dependencies.clock.now();
    const message: MessageRecord = {
      id: this.#createId('supplement'),
      kind: 'supplement',
      conversationId: task.conversationId,
      taskId: task.id,
      role: 'user',
      status: 'complete',
      text,
      attachmentIds,
      createdAt: now,
      updatedAt: now,
    };
    await this.#dependencies.conversations.appendSupplement(message);
    return { accepted: true, id: message.id };
  }

  /** Opens one validated persisted image in the current page's full-viewport overlay. */
  async openImagePreview(tabId: number, attachmentId: string): Promise<{ readonly opened: true }> {
    if (!Number.isInteger(tabId) || tabId < 0 || attachmentId.trim().length === 0) {
      throw new Error('Image preview request is invalid.');
    }
    const attachment = await this.#dependencies.attachments.get(attachmentId);
    const mimeType = attachment?.mimeType.toLowerCase() ?? '';
    if (
      attachment === undefined ||
      !previewImageTypes.has(mimeType) ||
      attachment.byteSize <= 0 ||
      attachment.byteSize > IMAGE_POLICY.maxBytesPerImage ||
      attachment.byteSize !== attachment.blob.size ||
      attachment.blob.type.toLowerCase() !== mimeType
    ) {
      throw new Error('Image preview attachment is invalid.');
    }
    const bytes = new Uint8Array(await attachment.blob.arrayBuffer());
    await this.#dependencies.imagePreview.open(tabId, {
      src: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
      alt: (attachment.fileName ?? 'Image preview').slice(0, 500),
    });
    return { opened: true };
  }

  /** Stops unfinished work, deletes the complete conversation aggregate, then runs safe GC. */
  async clearConversation(
    conversationId: string,
  ): Promise<{ readonly deletedAttachments: number }> {
    const tasks = await this.#dependencies.tasks.listByConversation(conversationId);
    for (const task of tasks) {
      if (!terminalTaskStatuses.has(task.status)) {
        await this.#dependencies.cancelTask(task.id);
      }
    }
    await this.#dependencies.conversations.clearConversation(conversationId);
    const deletedAttachments = await this.#dependencies.attachments.deleteUnreferenced(
      this.#dependencies.clock.now() - ATTACHMENT_GC_GRACE_MS,
    );
    return { deletedAttachments };
  }

  /** Saves non-secret settings and only credential fields explicitly supplied by the trusted UI. */
  async saveSettings(input: SavePanelSettingsInput): Promise<PanelSettingsSnapshot> {
    const current = await this.#dependencies.settings.get();
    const currentSandboxServer = current.sandboxServer ?? '';
    const sandboxServer = input.sandboxServer ?? currentSandboxServer;
    await this.#dependencies.settings.save({
      ...current,
      reasoningEffort: input.reasoningEffort,
      systemPrompt: input.systemPrompt,
      language: input.language,
      historyMessageLimit: input.historyMessageLimit ?? current.historyMessageLimit,
      sandboxServer,
    });
    if (input.codexAccessToken !== undefined) {
      await this.#dependencies.credentials.setCodexAccessToken(input.codexAccessToken);
    }
    if (input.tavilyKey !== undefined) {
      await this.#dependencies.credentials.setTavilyKey(input.tavilyKey);
    }
    if (input.sandboxToken !== undefined) {
      await this.#dependencies.credentials.setSandboxToken(input.sandboxToken);
    }
    if (sandboxServer !== currentSandboxServer || input.sandboxToken !== undefined) {
      await this.#dependencies.sandboxCatalog?.invalidate();
    }
    return this.#readSettings();
  }

  /** Reads editable settings, including credentials, only for the explicit trusted UI query. */
  async getSettings(): Promise<PanelEditableSettings> {
    const [settings, codexAccessToken, tavilyKey] = await Promise.all([
      this.#dependencies.settings.get(),
      this.#dependencies.credentials.getCodexAccessToken(),
      this.#dependencies.credentials.getTavilyKey(),
    ]);
    return {
      ...settings,
      sandboxServer: settings.sandboxServer ?? '',
      codexAccessToken: codexAccessToken ?? '',
      tavilyKey: tavilyKey ?? '',
      sandboxToken: '',
    };
  }

  /** Reads the latest durable continuation only for WorkSessions that own supplements. */
  async #readAppliedSupplementIdsByWorkSession(
    tasks: readonly TaskRun[],
    messages: readonly MessageRecord[],
    readCache: TaskReadCache,
  ): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
    const supplementTaskIds = new Set(
      messages.flatMap((message) =>
        message.kind === 'supplement' && message.taskId !== null ? [message.taskId] : [],
      ),
    );
    const relevantWorkSessionIds = new Set(
      tasks.flatMap((task) => (supplementTaskIds.has(task.id) ? [task.workSessionId] : [])),
    );
    const latestTasks = new Map<string, TaskRun>();
    for (const task of tasks) {
      if (!relevantWorkSessionIds.has(task.workSessionId)) continue;
      const current = latestTasks.get(task.workSessionId);
      if (current === undefined || compareWorkSessionTasks(current, task) < 0) {
        latestTasks.set(task.workSessionId, task);
      }
    }
    const entries = await Promise.all(
      [...latestTasks.entries()].map(async ([workSessionId, task]) => {
        const checkpoint = await this.#readCheckpoint(task, readCache);
        const messageIds = new Set(
          checkpoint?.continuationItems.flatMap((item) =>
            item.type === 'message_ref' ? [item.messageId] : [],
          ) ?? [],
        );
        return [workSessionId, messageIds] as const;
      }),
    );
    return new Map(entries);
  }

  /** Deduplicates checkpoint reads within one panel request. */
  #readCheckpoint(task: TaskRun, readCache: TaskReadCache): Promise<Checkpoint | undefined> {
    if (task.checkpointId === null) return Promise.resolve(undefined);
    const cached = readCache.checkpoints.get(task.checkpointId);
    if (cached !== undefined) return cached;
    const pending = this.#dependencies.tasks.getCheckpoint(task.checkpointId);
    readCache.checkpoints.set(task.checkpointId, pending);
    return pending;
  }

  /** Deduplicates event reads while several visible tasks share a WorkSession prefix. */
  #readEvents(task: TaskRun, readCache: TaskReadCache): Promise<readonly TaskEvent[]> {
    const cached = readCache.events.get(task.id);
    if (cached !== undefined) return cached;
    const pending = this.#dependencies.tasks.listEvents(task.id);
    readCache.events.set(task.id, pending);
    return pending;
  }

  /** Keeps summaries light and returns only completed tools plus supplements in full mode. */
  async #readTask(
    task: TaskRun,
    messages: readonly MessageRecord[] = [],
    detailLevel: 'summary' | 'full' = 'summary',
    appliedSupplementIds: ReadonlySet<string> = new Set(),
    conversationTasks: readonly TaskRun[] = [task],
    readCache: TaskReadCache = createTaskReadCache(),
  ): Promise<PanelTask> {
    const workSessionTasks = workSessionTaskPrefix(conversationTasks, task);
    const [checkpoint, taskEventLists] = await Promise.all([
      this.#readCheckpoint(task, readCache),
      Promise.all(workSessionTasks.map((candidate) => this.#readEvents(candidate, readCache))),
    ]);
    const events = taskEventLists.flat();
    const currentTaskEvents = taskEventLists.at(-1) ?? [];
    const completedResults = checkpoint?.completedToolResults ?? [];
    const workSessionTaskIds = new Set(workSessionTasks.map(({ id }) => id));
    const taskSupplements = messages.filter(
      (message) =>
        message.kind === 'supplement' &&
        message.taskId !== null &&
        workSessionTaskIds.has(message.taskId),
    );
    const detailIndexes = taskDetailIndexes(completedResults, events, taskSupplements);
    const retainedFullEvents = new Set(
      detailLevel === 'full'
        ? [
            ...events
              .filter((event) => event.type === 'tool.result-recorded')
              .slice(-MAX_PANEL_EVENTS),
            ...events
              .filter((event) => event.type === 'task.supplements-applied')
              .slice(-MAX_PANEL_SUPPLEMENTS),
          ]
        : [],
    );
    const projectedEvents =
      detailLevel === 'full'
        ? events.filter((event) => retainedFullEvents.has(event))
        : currentTaskEvents.slice(-MAX_PANEL_EVENTS);
    const completedToolResults =
      detailLevel === 'full' ? completedResults.slice(-MAX_PANEL_EVENTS) : [];
    return {
      id: task.id,
      detailLevel,
      status: task.status,
      goal: task.goal,
      tabId: task.tabId,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      sequence: checkpoint?.sequence ?? currentTaskEvents.at(-1)?.sequence ?? 0,
      completedToolCallCount: completedResults.length,
      detailItemCount: detailIndexes.itemCount,
      contextCleared: currentTaskEvents.some((event) => event.type === 'task.context-cleared'),
      lastError:
        task.lastError === null
          ? null
          : {
              code: task.lastError.code,
              retryable: task.lastError.retryable,
              userMessage: task.lastError.userMessage,
            },
      events: projectedEvents.map((event) => ({
        sequence: event.sequence,
        type: event.type,
        reason: event.reason,
        at: event.at,
        ...(event.reasoningSummary === undefined
          ? {}
          : { reasoningSummary: event.reasoningSummary.slice(0, MAX_PANEL_REASONING_SUMMARY) }),
        ...(event.supplementIds === undefined
          ? {}
          : {
              supplementIds: event.supplementIds
                .slice(-MAX_PANEL_SUPPLEMENTS)
                .map((id) => id.slice(0, 256)),
            }),
      })),
      completedToolResults: completedToolResults.map((result) => ({
        callId: result.callId.slice(0, 256),
        toolName: result.toolName.slice(0, 128),
        argumentsJson: result.argumentsJson.slice(0, MAX_PANEL_TOOL_ARGUMENTS),
        output: result.output.slice(0, MAX_PANEL_TOOL_OUTPUT),
        resultRef: result.resultRef.slice(0, 512),
        attachmentIds: [...(result.attachmentIds ?? [])].slice(0, 8),
        detailIndex: detailIndexes.resultIndexes.get(result.callId),
      })),
      supplements: taskSupplements.slice(-MAX_PANEL_SUPPLEMENTS).map((message) => ({
        id: message.id,
        text: message.text.slice(0, 20_000),
        attachmentIds: [...message.attachmentIds].slice(0, 8),
        createdAt: message.createdAt,
        applicationState:
          appliedSupplementIds.has(message.id) || detailIndexes.appliedSupplementIds.has(message.id)
            ? 'applied'
            : 'pending',
        detailIndex: detailIndexes.supplementIndexes.get(message.id),
      })),
    };
  }

  /** Loads unique attachment metadata while omitting every Blob and storage-only field. */
  async #readAttachmentMetadata(messages: readonly MessageRecord[]): Promise<PanelAttachment[]> {
    const ids = [...new Set(messages.flatMap((message) => [...message.attachmentIds]))];
    const records = await Promise.all(ids.map((id) => this.#dependencies.attachments.get(id)));
    return records.flatMap((record) =>
      record === undefined
        ? []
        : [
            {
              id: record.id,
              mimeType: record.mimeType,
              byteSize: record.byteSize,
              width: record.width,
              height: record.height,
              source: record.source,
              fileName: record.fileName ?? null,
            },
          ],
    );
  }

  /** Reads persisted app settings plus credential-presence booleans without exposing their values. */
  async #readSettings(): Promise<PanelSettingsSnapshot> {
    const [settings, codexToken, tavilyKey, sandboxToken] = await Promise.all([
      this.#dependencies.settings.get(),
      this.#dependencies.credentials.getCodexAccessToken().catch(() => undefined),
      this.#dependencies.credentials.getTavilyKey().catch(() => undefined),
      this.#dependencies.credentials.getSandboxToken().catch(() => undefined),
    ]);
    return {
      ...settings,
      sandboxServer: settings.sandboxServer ?? '',
      hasCodexToken: codexToken !== undefined,
      hasTavilyKey: tavilyKey !== undefined,
      hasSandboxToken: sandboxToken !== undefined,
    };
  }

  /** Requests one stable nonblank identifier from the injected generator. */
  #createId(prefix: string): string {
    const id = this.#dependencies.ids.create(prefix).trim();
    if (id.length === 0) throw new Error('Panel identifier generation failed.');
    return id;
  }
}
