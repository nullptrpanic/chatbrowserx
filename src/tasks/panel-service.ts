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
import type { Clock } from '../shared/time';
import type { MessageRecord, MessageSourcePage } from './message-types';
import { TaskCommandError, type TaskCommandPort, type TaskSnapshot } from './task-command-service';
import type { TaskRun } from './task-types';

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
    'getCodexAccessToken' | 'setCodexAccessToken' | 'getTavilyKey' | 'setTavilyKey'
  >;
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

/** Encodes bounded image bytes without exceeding function argument limits. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 8 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
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
    const storedMessages =
      selected === null
        ? []
        : (await this.#dependencies.conversations.listMessages(selected.id)).slice(
            -MAX_PANEL_MESSAGES,
          );
    const messages = storedMessages.filter((message) => message.kind === 'conversation');
    const attachments = await this.#readAttachmentMetadata(storedMessages);
    const visibleTaskIds = new Set(
      storedMessages.flatMap((message) => (message.taskId === null ? [] : [message.taskId])),
    );
    if (latestTask !== null) visibleTaskIds.add(latestTask.id);
    const panelTasks = await Promise.all(
      selectedTasks
        .filter((task) => visibleTaskIds.has(task.id))
        .map((task) => this.#readTask(task, storedMessages)),
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
    const messages = await this.#dependencies.conversations.listMessages(task.conversationId);
    return this.#readTask(task, messages, 'full');
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
        latestTask?.status === 'cancelled'
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
    await this.#dependencies.settings.save({
      ...current,
      reasoningEffort: input.reasoningEffort,
      systemPrompt: input.systemPrompt,
      language: input.language,
      historyMessageLimit: input.historyMessageLimit ?? current.historyMessageLimit,
    });
    if (input.codexAccessToken !== undefined) {
      await this.#dependencies.credentials.setCodexAccessToken(input.codexAccessToken);
    }
    if (input.tavilyKey !== undefined) {
      await this.#dependencies.credentials.setTavilyKey(input.tavilyKey);
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
      codexAccessToken: codexAccessToken ?? '',
      tavilyKey: tavilyKey ?? '',
    };
  }

  /** Keeps summaries light and returns only completed tools plus supplements in full mode. */
  async #readTask(
    task: TaskRun,
    messages: readonly MessageRecord[] = [],
    detailLevel: 'summary' | 'full' = 'summary',
  ): Promise<PanelTask> {
    const [checkpoint, events] = await Promise.all([
      task.checkpointId === null
        ? Promise.resolve(undefined)
        : this.#dependencies.tasks.getCheckpoint(task.checkpointId),
      this.#dependencies.tasks.listEvents(task.id),
    ]);
    const completedResults = checkpoint?.completedToolResults ?? [];
    const projectedEvents =
      detailLevel === 'full'
        ? [
            ...events
              .filter((event) => event.type === 'tool.result-recorded')
              .slice(-MAX_PANEL_EVENTS),
            ...events
              .filter((event) => event.type === 'task.supplements-applied')
              .slice(-MAX_PANEL_SUPPLEMENTS),
          ].sort((left, right) => left.sequence - right.sequence)
        : events.slice(-MAX_PANEL_EVENTS);
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
      sequence: checkpoint?.sequence ?? events.at(-1)?.sequence ?? 0,
      completedToolCallCount: completedResults.length,
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
      })),
      supplements: messages
        .filter((message) => message.kind === 'supplement' && message.taskId === task.id)
        .slice(-MAX_PANEL_SUPPLEMENTS)
        .map((message) => ({
          id: message.id,
          text: message.text.slice(0, 20_000),
          attachmentIds: [...message.attachmentIds].slice(0, 8),
          createdAt: message.createdAt,
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
    const [settings, codexToken, tavilyKey] = await Promise.all([
      this.#dependencies.settings.get(),
      this.#dependencies.credentials.getCodexAccessToken().catch(() => undefined),
      this.#dependencies.credentials.getTavilyKey().catch(() => undefined),
    ]);
    return {
      ...settings,
      hasCodexToken: codexToken !== undefined,
      hasTavilyKey: tavilyKey !== undefined,
    };
  }

  /** Requests one stable nonblank identifier from the injected generator. */
  #createId(prefix: string): string {
    const id = this.#dependencies.ids.create(prefix).trim();
    if (id.length === 0) throw new Error('Panel identifier generation failed.');
    return id;
  }
}
