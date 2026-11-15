import type { AttachmentRepository } from '../persistence/attachment-repository';
import { IMAGE_POLICY } from '../attachments/attachment-policy';
import type { ConversationRepository } from '../persistence/conversation-repository';
import type { CredentialStore } from '../persistence/credential-store';
import type { SettingsStore, AppLanguage, ReasoningEffort } from '../persistence/settings-store';
import type {
  PersistedTaskDetailWindow,
  PersistedTaskTimeline,
  TaskRepository,
} from '../persistence/task-repository';
import type {
  PanelAttachment,
  PanelConversationSummary,
  PanelEditableSettings,
  PanelMessage,
  PanelSettingsSnapshot,
  PanelSnapshot,
  PanelTask,
} from '../shared/protocol/panel-types';
import type { IdGenerator } from '../shared/ids';
import { bytesToBase64 } from '../shared/base64';
import type { Clock } from '../shared/time';
import type { Agent } from '../agent/agent';
import type { CredentialSyncSelection } from '../providers/provider';
import type { MessageRecord, MessageSourcePage, TaskMessageDraft } from './message-types';
import type { TaskSnapshot } from './task-command-service';
import type { Task, TaskEvent } from './task-types';
import type { MaterializedToolResult } from './tool-result-types';
import { taskGoal } from './task-factory';

const ATTACHMENT_GC_GRACE_MS = 24 * 60 * 60 * 1_000;
const MAX_PANEL_MESSAGES = 500;
const MAX_PANEL_EVENTS = 100;
const MAX_PANEL_TOOL_ARGUMENTS = 20_000;
const MAX_PANEL_TOOL_OUTPUT = 100_000;
const MAX_PANEL_SUPPLEMENTS = 100;
const MAX_SOURCE_FAVICON_URL = 8_192;
const terminalTaskStatuses = new Set<Task['status']>(['completed', 'failed', 'cancelled']);
const previewImageTypes = new Set<string>(IMAGE_POLICY.acceptedMimeTypes);

export interface PanelServiceDependencies {
  readonly conversations: Pick<
    ConversationRepository,
    'listAll' | 'get' | 'listRecentMessages' | 'listTaskMessages' | 'clearConversation'
  >;
  readonly tasks: Pick<
    TaskRepository,
    | 'get'
    | 'listAll'
    | 'listByConversation'
    | 'listEvents'
    | 'readTaskTimelines'
    | 'readTaskDetailWindow'
  >;
  readonly attachments: Pick<AttachmentRepository, 'get' | 'deleteUnreferenced'>;
  readonly settings: Pick<SettingsStore, 'get' | 'save'>;
  readonly credentials: Pick<
    CredentialStore,
    'getTavilyKey' | 'setTavilyKey' | 'getSandboxToken' | 'setSandboxToken'
  >;
  readonly agent: Pick<
    Agent,
    | 'start'
    | 'supplement'
    | 'cancel'
    | 'listModels'
    | 'getProviderConfiguration'
    | 'readProviderToken'
    | 'saveProviderToken'
    | 'syncProviderToken'
  >;
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
  readonly stateVersion: {
    readonly get: () => number;
    readonly changed: () => void;
  };
}

export interface SubmitPanelMessageInput {
  readonly tabId: number;
  readonly conversationId?: string | undefined;
  readonly text: string;
  readonly attachmentIds: readonly string[];
  readonly replyTo?: { readonly messageId: string; readonly taskId: string } | undefined;
}

export interface SupplementPanelMessageInput {
  readonly taskId: string;
  readonly text: string;
  readonly attachmentIds: readonly string[];
}

export interface SavePanelSettingsInput {
  readonly providerId?: string | undefined;
  readonly credentialSource?: 'manual' | 'sandbox' | undefined;
  readonly authPath?: string | undefined;
  readonly model?: string | undefined;
  readonly reasoningEffort: ReasoningEffort;
  readonly systemPrompt: string;
  readonly language: AppLanguage;
  readonly historyMessageLimit?: number | undefined;
  readonly accessToken?: string | undefined;
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

interface TaskDetailIndexes {
  readonly itemCount: number;
  readonly resultIndexes: ReadonlyMap<string, number>;
  readonly supplementIndexes: ReadonlyMap<string, number>;
  readonly appliedSupplementIds: ReadonlySet<string>;
  readonly forwardedSupplementIds: ReadonlySet<string>;
}

/** Assigns stable display positions across completed tools and applied or pending supplements. */
function taskDetailIndexes(
  events: readonly TaskEvent[],
  materializedResults: readonly MaterializedToolResult[],
  supplements: readonly MessageRecord[],
): TaskDetailIndexes {
  const resultIndexes = new Map<string, number>();
  const supplementIndexes = new Map<string, number>();
  const appliedSupplementIds = new Set(
    events.flatMap((event) => (event.type === 'supplement.applied' ? [event.messageId] : [])),
  );
  const forwardedSupplementIds = new Set(
    events.flatMap((event) => (event.type === 'supplement.forwarded' ? [event.messageId] : [])),
  );
  const callIds = new Set(materializedResults.map(({ callId }) => callId));
  const supplementIds = new Set(supplements.map(({ id }) => id));
  let itemCount = 0;
  for (const event of events) {
    if (event.type === 'tool.result') {
      itemCount += 1;
      if (callIds.has(event.callId)) resultIndexes.set(event.callId, itemCount);
    } else if (event.type === 'supplement.queued') {
      itemCount += 1;
      if (supplementIds.has(event.messageId)) supplementIndexes.set(event.messageId, itemCount);
    }
  }
  if (resultIndexes.size !== materializedResults.length) {
    throw new Error('A permanent tool result is missing its TaskEvent association.');
  }
  if (supplementIndexes.size !== supplements.length) {
    throw new Error('A permanent supplement is missing its TaskEvent association.');
  }
  return {
    itemCount,
    resultIndexes,
    supplementIndexes,
    appliedSupplementIds,
    forwardedSupplementIds,
  };
}

/** Reads one index that was assigned from the same permanent task event stream. */
function requiredDetailIndex(indexes: ReadonlyMap<string, number>, id: string): number {
  const index = indexes.get(id);
  if (index === undefined) throw new Error('Task detail index is missing.');
  return index;
}

function eventDisplayType(event: TaskEvent): string {
  if (event.type === 'tool.result') return 'tool.result-recorded';
  if (event.type === 'tool.call') return 'tool.call-recorded';
  if (event.type === 'reasoning.summary') return 'reasoning.summary-recorded';
  if (event.type === 'supplement.applied' || event.type === 'supplement.queued') {
    return 'task.supplements-applied';
  }
  if (event.type === 'status.changed') return event.reason;
  return event.type;
}

function eventReason(event: TaskEvent): string {
  if (event.type === 'status.changed') return event.reason;
  if (event.type === 'tool.call') return `${event.name}_call_recorded`;
  if (event.type === 'tool.result') return `${event.callId}_result_recorded`;
  return event.type;
}

function supplementQuote(message: MessageRecord) {
  return {
    id: message.id,
    text: message.text.slice(0, 20_000),
    attachmentIds: message.attachmentIds.slice(0, 8),
  };
}

export class PanelService {
  readonly #dependencies: PanelServiceDependencies;

  /** Creates the sanitized Side Panel query and command boundary. */
  constructor(dependencies: PanelServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /** Builds a fresh global-conversation snapshot with current-tab page context. */
  async getSnapshot(tabId: number, conversationId?: string): Promise<PanelSnapshot> {
    const stateVersion = this.#dependencies.stateVersion.get();
    const [tab, conversations, settings, allTasks] = await Promise.all([
      this.#dependencies.tabs.get(tabId),
      this.#dependencies.conversations.listAll(),
      this.#readSettings(),
      this.#dependencies.tasks.listAll(),
    ]);
    const url = (tab.url ?? '').slice(0, 4_096);
    const webOrigin = readWebOrigin(url);
    const hasPermission =
      webOrigin === null
        ? false
        : await this.#dependencies.permissions
            .contains({ origins: [webOrigin.pattern] })
            .catch(() => false);
    const tasksByConversation = new Map<string, Task[]>();
    for (const task of allTasks) {
      const tasks = tasksByConversation.get(task.conversationId);
      if (tasks === undefined) tasksByConversation.set(task.conversationId, [task]);
      else tasks.push(task);
    }
    const taskLists = conversations.map((conversation) =>
      [...(tasksByConversation.get(conversation.id) ?? [])].sort(
        (left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id),
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
    const readMessages = () =>
      selected === null
        ? Promise.resolve([])
        : this.#dependencies.conversations.listRecentMessages(selected.id, MAX_PANEL_MESSAGES);
    let storedMessages = await readMessages();
    const visibleTaskIds = new Set(storedMessages.map((message) => message.taskId));
    if (latestTask !== null) visibleTaskIds.add(latestTask.id);
    const visibleTasks = selectedTasks.filter((task) => visibleTaskIds.has(task.id));
    const timelines = await this.#dependencies.tasks.readTaskTimelines(
      visibleTasks.map(({ id }) => id),
    );
    const timelineByTaskId = new Map(timelines.map((timeline) => [timeline.task.id, timeline]));
    // A final message can be committed between the message and timeline reads.
    if (
      visibleTasks.some(
        (task) =>
          task.status !== 'completed' && timelineByTaskId.get(task.id)?.task.status === 'completed',
      )
    ) {
      storedMessages = await readMessages();
    }
    const messages = storedMessages.filter((message) => message.kind === 'conversation');
    const attachments = await this.#readAttachmentMetadata(storedMessages);
    const messageRunById = new Map<string, string>();
    const messageSequenceById = new Map<string, number>();
    const replySegmentById = new Map<string, NonNullable<PanelMessage['replySegment']>>();
    const liveSupplementsByTask = new Map<string, NonNullable<PanelTask['liveSupplements']>>();
    const storedById = new Map(storedMessages.map((message) => [message.id, message]));
    for (const timeline of timelines) {
      const { task } = timeline;
      const live = new Map<string, ReturnType<typeof supplementQuote>>();
      const segments = new Map<
        string,
        {
          id: string;
          supplements: NonNullable<PanelMessage['replySegment']>['supplements'];
          hasReply: boolean;
        }
      >();
      for (const event of [...timeline.events].sort((a, b) => a.sequence - b.sequence)) {
        if (event.type === 'supplement.queued' || event.type === 'supplement.applied') {
          const supplement = storedById.get(event.messageId);
          if (supplement?.kind !== 'supplement' || supplement.taskId !== task.id) continue;
          const quote = supplementQuote(supplement);
          if (event.runId === task.latestRunId) live.set(quote.id, quote);
          if (event.type === 'supplement.queued') continue;
          const previous = segments.get(event.runId);
          const segment =
            !previous || previous.hasReply
              ? { id: event.messageId, supplements: [], hasReply: false }
              : previous;
          segments.set(event.runId, {
            ...segment,
            supplements: [...segment.supplements, quote].slice(-MAX_PANEL_SUPPLEMENTS),
          });
          continue;
        }
        if (event.type !== 'message.recorded') continue;
        const existing = messageRunById.get(event.messageId);
        if (existing !== undefined && existing !== event.runId) {
          throw new Error('Conversation message has conflicting TaskEvent associations.');
        }
        messageRunById.set(event.messageId, event.runId);
        messageSequenceById.set(event.messageId, event.sequence);
        const segment = segments.get(event.runId);
        if (segment) {
          replySegmentById.set(event.messageId, {
            id: segment.id,
            supplements: segment.supplements,
          });
          const message = storedById.get(event.messageId);
          if (
            message?.role === 'assistant' &&
            (message.status !== 'interrupted' || message.text || message.attachmentIds.length)
          ) {
            segment.hasReply = true;
            for (const { id } of segment.supplements) live.delete(id);
          }
        }
      }
      if (!terminalTaskStatuses.has(task.status)) {
        liveSupplementsByTask.set(task.id, [...live.values()].slice(-MAX_PANEL_SUPPLEMENTS));
      }
    }
    const taskOrdinals = new Map(selectedTasks.map((task) => [task.id, task.ordinal]));
    messages.sort(
      (a, b) =>
        (taskOrdinals.get(a.taskId) ?? 0) - (taskOrdinals.get(b.taskId) ?? 0) ||
        (messageSequenceById.get(a.id) ?? Infinity) - (messageSequenceById.get(b.id) ?? Infinity) ||
        a.createdAt - b.createdAt,
    );
    const panelTasks = visibleTasks.flatMap((task) => {
      const timeline = timelineByTaskId.get(task.id);
      if (timeline === undefined) return [];
      const liveSupplements = liveSupplementsByTask.get(task.id);
      return [
        {
          ...this.#projectTask(timeline, [], 'summary'),
          ...(liveSupplements ? { liveSupplements } : {}),
        },
      ];
    });
    const panelTask =
      latestTask === null ? null : (panelTasks.find((task) => task.id === latestTask.id) ?? null);

    return {
      stateVersion,
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
          ...(messageRunById.has(message.id) ? { runId: messageRunById.get(message.id) } : {}),
          role: message.role,
          status: message.status,
          ...(message.phase === undefined ? {} : { phase: message.phase }),
          text: message.text,
          attachmentIds: [...message.attachmentIds],
          ...(sourcePage === undefined ? {} : { sourcePage }),
          ...(message.replyTo === undefined ? {} : { replyTo: { ...message.replyTo } }),
          ...(message.role === 'assistant' && replySegmentById.has(message.id)
            ? { replySegment: replySegmentById.get(message.id) }
            : {}),
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

  /** Returns the cheap process-wide durable-state version used by recovery polling. */
  getStateVersion(): { readonly stateVersion: number } {
    return { stateVersion: this.#dependencies.stateVersion.get() };
  }

  /** Loads result bodies aligned with the retained event window for one expanded task. */
  async getTaskDetails(taskId: string): Promise<PanelTask> {
    const normalizedTaskId = taskId.trim();
    if (normalizedTaskId.length === 0 || normalizedTaskId.length > 256) {
      throw new Error('Task detail request is invalid.');
    }
    const window = await this.#dependencies.tasks.readTaskDetailWindow(
      normalizedTaskId,
      MAX_PANEL_EVENTS,
    );
    if (window === undefined) throw new Error('Task details are unavailable.');
    const messages = await this.#dependencies.conversations.listTaskMessages(window.task.id);
    return this.#projectTask(window, messages, 'full');
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

    const sourceTab = await this.#dependencies.tabs.get(input.tabId);
    const sourcePage = readMessageSourcePage({
      title: sourceTab.title ?? '',
      url: sourceTab.url ?? '',
      favIconUrl: sourceTab.favIconUrl ?? null,
    });
    const now = this.#dependencies.clock.now();
    let latestTask: Task | undefined;
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
    const replyTo =
      input.replyTo === undefined
        ? undefined
        : await this.#readReplyReference(conversation.id, input.replyTo);
    if (input.conversationId !== undefined) {
      latestTask = (await this.#dependencies.tasks.listByConversation(conversation.id)).at(-1);
    }
    const message: TaskMessageDraft = {
      id: this.#createId('message'),
      kind: 'conversation',
      conversationId: conversation.id,
      role: 'user',
      status: 'complete',
      text,
      attachmentIds,
      ...(sourcePage === undefined ? {} : { sourceTabId: input.tabId, sourcePage }),
      ...(replyTo === undefined ? {} : { replyTo }),
      createdAt: now,
      updatedAt: now,
    };
    const goal = taskGoal(text);
    if (
      latestTask !== undefined &&
      (latestTask.status === 'cancelled' || latestTask.status === 'failed')
    ) {
      const contextWasCleared = (await this.#dependencies.tasks.listEvents(latestTask.id)).some(
        (event) => event.type === 'context.cleared',
      );
      if (!contextWasCleared) {
        return this.#dependencies.agent.start({
          kind: 'continue',
          submission: {
            sourceTaskId: latestTask.id,
            tabId: input.tabId,
            conversation,
            message,
          },
        });
      }
    }
    return this.#dependencies.agent.start({
      kind: 'create',
      submission: {
        conversation,
        createConversation: input.conversationId === undefined,
        conversationId: conversation.id,
        tabId: input.tabId,
        goal,
        message,
      },
    });
  }

  /** Resolves one client-supplied lookup hint to a bounded canonical assistant reply reference. */
  async #readReplyReference(
    conversationId: string,
    input: { readonly messageId: string; readonly taskId: string },
  ): Promise<NonNullable<MessageRecord['replyTo']>> {
    const messageId = input.messageId.trim();
    const taskId = input.taskId.trim();
    if (
      messageId.length === 0 ||
      messageId.length > 256 ||
      taskId.length === 0 ||
      taskId.length > 256
    ) {
      throw new Error('Reply target is invalid.');
    }
    const target = (await this.#dependencies.conversations.listTaskMessages(taskId)).find(
      (message) => message.id === messageId,
    );
    if (
      target === undefined ||
      target.taskId !== taskId ||
      target.conversationId !== conversationId ||
      target.kind !== 'conversation' ||
      target.role !== 'assistant' ||
      target.status === 'streaming' ||
      (target.text.length === 0 && target.attachmentIds.length === 0)
    ) {
      throw new Error('Reply target is unavailable.');
    }
    return {
      messageId: target.id,
      taskId: target.taskId,
      excerpt: target.text.slice(0, 1_000),
      attachmentCount: target.attachmentIds.length,
      createdAt: target.createdAt,
    };
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
    await this.#dependencies.agent.supplement(message);
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
        await this.#dependencies.agent.cancel(task.id);
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
      providerId: input.providerId ?? current.providerId ?? '',
      model: input.model ?? current.model,
      reasoningEffort: input.reasoningEffort,
      systemPrompt: input.systemPrompt,
      language: input.language,
      historyMessageLimit: input.historyMessageLimit ?? current.historyMessageLimit,
      sandboxServer,
      credentialSource: input.credentialSource ?? current.credentialSource ?? 'manual',
      authPath: input.authPath ?? current.authPath ?? '',
    });
    if (input.accessToken !== undefined) {
      await this.#dependencies.agent.saveProviderToken(input.accessToken);
    }
    if (input.tavilyKey !== undefined) {
      await this.#dependencies.credentials.setTavilyKey(input.tavilyKey);
    }
    if (input.sandboxToken !== undefined) {
      await this.#dependencies.credentials.setSandboxToken(input.sandboxToken);
    }
    this.#dependencies.stateVersion.changed();
    return this.#readSettings();
  }

  /** Reads editable settings, including credentials, only for the explicit trusted UI query. */
  async getSettings(): Promise<PanelEditableSettings> {
    const [settings, accessToken, tavilyKey, sandboxToken, catalog] = await Promise.all([
      this.#dependencies.settings.get(),
      this.#dependencies.agent.readProviderToken(),
      this.#dependencies.credentials.getTavilyKey(),
      this.#dependencies.credentials.getSandboxToken(),
      this.#dependencies.agent
        .listModels(AbortSignal.timeout(15_000))
        .then((models) => ({ models, modelDiscoveryFailed: false }))
        .catch(() => ({ models: [], modelDiscoveryFailed: true })),
    ]);
    const configuration = await this.#dependencies.agent.getProviderConfiguration();
    if (configuration.credentialSource === 'sandbox') this.#dependencies.stateVersion.changed();
    return {
      ...settings,
      ...configuration,
      ...catalog,
      sandboxServer: settings.sandboxServer ?? '',
      accessToken: accessToken ?? '',
      tavilyKey: tavilyKey ?? '',
      sandboxToken: sandboxToken ?? '',
    };
  }

  /** Reuses the agent's credential path for both trusted UI requests and background ticks. */
  async syncProviderToken(selection?: CredentialSyncSelection) {
    const status = await this.#dependencies.agent.syncProviderToken(selection);
    if (status !== 'idle') this.#dependencies.stateVersion.changed();
    return status;
  }

  /** Projects permanent task facts without reading or inferring from a runtime Checkpoint. */
  #projectTask(
    archive: PersistedTaskTimeline | PersistedTaskDetailWindow,
    messages: readonly MessageRecord[],
    detailLevel: 'summary' | 'full',
  ): PanelTask {
    const { task, events, runs } = archive;
    const allResults = 'toolResults' in archive ? archive.toolResults : [];
    const supplements = messages.filter(
      (message) => message.kind === 'supplement' && message.taskId === task.id,
    );
    const detailIndexes = taskDetailIndexes(events, allResults, supplements);
    const visibleDetailEvents = events.filter(
      (event) => event.type === 'tool.result' || event.type === 'supplement.queued',
    );
    const projectedEvents =
      detailLevel === 'full' ? visibleDetailEvents.slice(-MAX_PANEL_EVENTS) : events.slice(-1);
    const retainedCallIds = new Set(
      projectedEvents.flatMap((event) => (event.type === 'tool.result' ? [event.callId] : [])),
    );
    const retainedSupplementIds = new Set(
      projectedEvents.flatMap((event) =>
        event.type === 'supplement.queued' ? [event.messageId] : [],
      ),
    );
    const results =
      detailLevel === 'full' ? allResults.filter(({ callId }) => retainedCallIds.has(callId)) : [];
    const commentaryLinks = new Map(
      events.flatMap((event) =>
        event.type === 'assistant.commentary-linked' ? [[event.itemId, event.callId] as const] : [],
      ),
    );
    const commentaryCall = (event: Extract<TaskEvent, { type: 'assistant.commentary' }>) =>
      (event.itemId === undefined ? undefined : commentaryLinks.get(event.itemId)) ?? event.callId;
    const firstVisibleSequence =
      visibleDetailEvents.length > MAX_PANEL_EVENTS ? (projectedEvents[0]?.sequence ?? 0) : 0;
    const commentaryEvents =
      detailLevel === 'full'
        ? events
            .filter(
              (event) =>
                event.type === 'assistant.commentary' &&
                (event.sequence >= firstVisibleSequence ||
                  retainedCallIds.has(commentaryCall(event) ?? '')),
            )
            .slice(-MAX_PANEL_EVENTS)
        : [];
    const projectedSupplements =
      detailLevel === 'full'
        ? supplements
            .filter(({ id }) => retainedSupplementIds.has(id))
            .slice(-MAX_PANEL_SUPPLEMENTS)
        : [];
    const lastError = runs.at(-1)?.error ?? null;
    const supplementRuns = new Map(
      events.flatMap((event) =>
        event.type === 'supplement.queued' ? [[event.messageId, event.runId] as const] : [],
      ),
    );
    const compaction = events.findLast(
      (event) =>
        event.runId === task.latestRunId &&
        (event.type === 'context.compacted' ||
          (event.type === 'status.changed' &&
            ['context_compaction_started', 'context_compaction_failed'].includes(event.reason))),
    );
    return {
      id: task.id,
      latestRunId: task.latestRunId,
      runs: runs.slice(-MAX_PANEL_MESSAGES).map((run) => ({
        id: run.id,
        attempt: run.attempt,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        lastError:
          run.error === null
            ? null
            : {
                code: run.error.code,
                retryable: run.error.retryable,
                userMessage: run.error.userMessage,
              },
      })),
      detailLevel,
      reasoningSummary:
        events.findLast(
          (event): event is Extract<TaskEvent, { type: 'reasoning.summary' }> =>
            event.type === 'reasoning.summary' && event.runId === task.latestRunId,
        )?.summary ?? '',
      ...(compaction
        ? {
            contextCompaction:
              compaction.type === 'context.compacted'
                ? ('completed' as const)
                : compaction.type === 'status.changed' &&
                    compaction.reason === 'context_compaction_failed'
                  ? ('failed' as const)
                  : ('started' as const),
          }
        : {}),
      status: task.status,
      goal: task.goal,
      tabId: task.tabId,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      sequence: task.lastEventSequence,
      completedToolCallCount: events.filter((event) => event.type === 'tool.result').length,
      detailItemCount: detailIndexes.itemCount,
      contextCleared: events.some((event) => event.type === 'context.cleared'),
      lastError:
        lastError === null
          ? null
          : {
              code: lastError.code,
              retryable: lastError.retryable,
              userMessage: lastError.userMessage,
            },
      events: [...projectedEvents, ...commentaryEvents]
        .sort((a, b) => a.sequence - b.sequence)
        .map((event) => {
          const callId = event.type === 'assistant.commentary' ? commentaryCall(event) : undefined;
          return {
            sequence: event.sequence,
            type: eventDisplayType(event),
            reason: eventReason(event),
            at: event.at,
            ...(event.type === 'supplement.queued'
              ? { supplementIds: [event.messageId.slice(0, 256)] }
              : {}),
            ...(event.type === 'tool.result' ? { callId: event.callId.slice(0, 256) } : {}),
            ...(detailLevel === 'full' && event.type === 'assistant.commentary'
              ? {
                  commentary: {
                    text: event.text.slice(0, 20_000),
                    ...(callId ? { callId: callId.slice(0, 256) } : {}),
                  },
                }
              : {}),
          };
        }),
      toolResults: results.map((result) => ({
        callId: result.callId.slice(0, 256),
        toolName: result.toolName.slice(0, 128),
        argumentsJson: result.argumentsJson.slice(0, MAX_PANEL_TOOL_ARGUMENTS),
        output: result.output.slice(0, MAX_PANEL_TOOL_OUTPUT),
        attachmentIds: [...result.attachmentIds].slice(0, 8),
        detailIndex: requiredDetailIndex(detailIndexes.resultIndexes, result.callId),
      })),
      supplements: projectedSupplements.map((message) => ({
        ...supplementQuote(message),
        runId: supplementRuns.get(message.id),
        createdAt: message.createdAt,
        applicationState: detailIndexes.appliedSupplementIds.has(message.id)
          ? 'applied'
          : detailIndexes.forwardedSupplementIds.has(message.id)
            ? 'forwarded'
            : 'pending',
        detailIndex: requiredDetailIndex(detailIndexes.supplementIndexes, message.id),
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
    const [settings, configuration, tavilyKey, sandboxToken] = await Promise.all([
      this.#dependencies.settings.get(),
      this.#dependencies.agent.getProviderConfiguration(),
      this.#dependencies.credentials.getTavilyKey().catch(() => undefined),
      this.#dependencies.credentials.getSandboxToken().catch(() => undefined),
    ]);
    return {
      ...settings,
      ...configuration,
      sandboxServer: settings.sandboxServer ?? '',
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
