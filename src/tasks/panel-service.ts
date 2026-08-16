import type { AttachmentRepository } from '../persistence/attachment-repository';
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
import type { MessageRecord } from './message-types';
import type { TaskCommandPort, TaskSnapshot } from './task-command-service';
import type { TaskRun } from './task-types';

const ATTACHMENT_GC_GRACE_MS = 24 * 60 * 60 * 1_000;
const MAX_PANEL_MESSAGES = 500;
const MAX_PANEL_EVENTS = 100;
const terminalTaskStatuses = new Set<TaskRun['status']>(['completed', 'failed', 'cancelled']);

export interface PanelServiceDependencies {
  readonly conversations: Pick<
    ConversationRepository,
    | 'listByTab'
    | 'get'
    | 'create'
    | 'listMessages'
    | 'appendMessage'
    | 'updateMessage'
    | 'clearConversation'
  >;
  readonly tasks: Pick<TaskRepository, 'listByConversation' | 'listEvents' | 'getCheckpoint'>;
  readonly attachments: Pick<AttachmentRepository, 'get' | 'deleteUnreferenced'>;
  readonly settings: Pick<SettingsStore, 'get' | 'save'>;
  readonly credentials: Pick<CredentialStore, 'getCodexAccessToken' | 'setCodexAccessToken'>;
  readonly commands: Pick<TaskCommandPort, 'create'>;
  readonly tabs: {
    get(tabId: number): Promise<{
      readonly id?: number | undefined;
      readonly title?: string | undefined;
      readonly url?: string | undefined;
    }>;
  };
  readonly permissions: {
    contains(permissions: { readonly origins: readonly string[] }): Promise<boolean>;
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

export interface SavePanelSettingsInput {
  readonly reasoningEffort: ReasoningEffort;
  readonly systemPrompt: string;
  readonly language: AppLanguage;
  readonly codexAccessToken?: string | undefined;
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

export class PanelService {
  readonly #dependencies: PanelServiceDependencies;

  /** Creates the sanitized Side Panel query and command boundary. */
  constructor(dependencies: PanelServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /** Builds a fresh per-tab panel snapshot with no Blob bytes or credential values. */
  async getSnapshot(tabId: number, conversationId?: string): Promise<PanelSnapshot> {
    const [tab, conversations, settings] = await Promise.all([
      this.#dependencies.tabs.get(tabId),
      this.#dependencies.conversations.listByTab(tabId),
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
    const selectedIndex =
      conversationId === undefined
        ? summaries.length === 0
          ? -1
          : 0
        : summaries.findIndex((conversation) => conversation.id === conversationId);
    const selected = selectedIndex < 0 ? null : (conversations[selectedIndex] ?? null);
    const selectedSummary = selectedIndex < 0 ? null : (summaries[selectedIndex] ?? null);
    const selectedTasks = selectedIndex < 0 ? [] : (taskLists[selectedIndex] ?? []);
    const latestTask = selectedTasks.at(-1) ?? null;
    const messages =
      selected === null
        ? []
        : (await this.#dependencies.conversations.listMessages(selected.id)).slice(
            -MAX_PANEL_MESSAGES,
          );
    const attachments = await this.#readAttachmentMetadata(messages);
    const panelTask = latestTask === null ? null : await this.#readTask(latestTask);

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
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        status: message.status,
        text: message.text,
        attachmentIds: [...message.attachmentIds],
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      })),
      attachments,
      task: panelTask,
      settings,
    };
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

    const now = this.#dependencies.clock.now();
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
    if (conversation === undefined || conversation.tabId !== input.tabId) {
      throw new Error('Conversation is unavailable for this tab.');
    }
    if (input.conversationId !== undefined) {
      const tasks = await this.#dependencies.tasks.listByConversation(conversation.id);
      if (tasks.some((task) => !terminalTaskStatuses.has(task.status))) {
        throw new Error('Conversation already has an unfinished task.');
      }
    }
    if (input.conversationId === undefined) {
      await this.#dependencies.conversations.create(conversation);
    }

    const message: MessageRecord = {
      id: this.#createId('message'),
      conversationId: conversation.id,
      taskId: null,
      role: 'user',
      status: 'complete',
      text,
      attachmentIds,
      createdAt: now,
      updatedAt: now,
    };
    await this.#dependencies.conversations.appendMessage(message);
    const snapshot = await this.#dependencies.commands.create({
      conversationId: conversation.id,
      tabId: input.tabId,
      goal: taskGoal(text),
    });
    await this.#dependencies.conversations.updateMessage({
      ...message,
      taskId: snapshot.task.id,
      updatedAt: Math.max(message.updatedAt, snapshot.task.createdAt),
    });
    await this.#dependencies.scheduleTask(snapshot.task.id);
    return snapshot;
  }

  /** Clears one terminal conversation and then collects only aged unreferenced attachments. */
  async clearConversation(
    conversationId: string,
  ): Promise<{ readonly deletedAttachments: number }> {
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
    });
    if (input.codexAccessToken !== undefined) {
      await this.#dependencies.credentials.setCodexAccessToken(input.codexAccessToken);
    }
    return this.#readSettings();
  }

  /** Reads editable settings, including credentials, only for the explicit trusted UI query. */
  async getSettings(): Promise<PanelEditableSettings> {
    const [settings, codexAccessToken] = await Promise.all([
      this.#dependencies.settings.get(),
      this.#dependencies.credentials.getCodexAccessToken(),
    ]);
    return {
      ...settings,
      codexAccessToken: codexAccessToken ?? '',
    };
  }

  /** Reads a bounded task projection with its current checkpoint and latest audit events. */
  async #readTask(task: TaskRun): Promise<PanelTask> {
    const [checkpoint, events] = await Promise.all([
      task.checkpointId === null
        ? Promise.resolve(undefined)
        : this.#dependencies.tasks.getCheckpoint(task.checkpointId),
      this.#dependencies.tasks.listEvents(task.id),
    ]);
    return {
      id: task.id,
      status: task.status,
      goal: task.goal,
      tabId: task.tabId,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      sequence: checkpoint?.sequence ?? events.at(-1)?.sequence ?? 0,
      lastError:
        task.lastError === null
          ? null
          : {
              code: task.lastError.code,
              retryable: task.lastError.retryable,
              userMessage: task.lastError.userMessage,
            },
      events: events.slice(-MAX_PANEL_EVENTS).map((event) => ({
        sequence: event.sequence,
        type: event.type,
        reason: event.reason,
        at: event.at,
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
    const [settings, codexToken] = await Promise.all([
      this.#dependencies.settings.get(),
      this.#dependencies.credentials.getCodexAccessToken().catch(() => undefined),
    ]);
    return {
      ...settings,
      hasCodexToken: codexToken !== undefined,
    };
  }

  /** Requests one stable nonblank identifier from the injected generator. */
  #createId(prefix: string): string {
    const id = this.#dependencies.ids.create(prefix).trim();
    if (id.length === 0) throw new Error('Panel identifier generation failed.');
    return id;
  }
}
