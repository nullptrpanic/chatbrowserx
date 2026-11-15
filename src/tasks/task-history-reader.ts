import type { AttachmentRecord } from '../attachments/attachment-types';
import type { AttachmentRepository } from '../persistence/attachment-repository';
import type { ConversationRepository } from '../persistence/conversation-repository';
import type { TaskRepository } from '../persistence/task-repository';
import type { ConversationId, TaskId } from '../shared/ids';
import type { MessageRecord } from './message-types';
import { orderedTaskEvents, isHistoricalTask, orderedHistoricalTasks } from './task-history-order';
import type { Task, TaskEvent, TaskStatus } from './task-types';
import type { ToolResult } from './tool-result-types';

export interface TaskHistoryContext {
  readonly conversationId: ConversationId;
  readonly currentTaskId: TaskId;
  /** Host-owned boundary; never supplied by the model. */
  readonly currentTaskLastEventSequence?: number;
}

export interface HistoryReadInput {
  readonly taskId: TaskId | null;
  readonly offset: number | null;
  readonly cursor: string;
  readonly limit: number;
  readonly messageId?: string | null | undefined;
}

export interface HistorySearchInput {
  readonly query: string;
  readonly cursor: string;
  readonly limit: number;
}

interface HistoryMessagePreview {
  readonly messageId: string;
  readonly role: MessageRecord['role'];
  readonly status: MessageRecord['status'];
  readonly createdAt: number;
  readonly text: string;
  readonly textLength: number;
}

export type HistorySearchResponse =
  | {
      readonly ok: true;
      readonly items: readonly {
        readonly taskId: TaskId;
        readonly taskStatus: TaskStatus;
        readonly messageId: string;
        readonly context: readonly HistoryMessagePreview[];
      }[];
      readonly nextCursor: string | null;
    }
  | HistoryReadError;

interface TextRange {
  readonly offset: number;
  readonly limit: number;
}

export interface ResultReadInput extends TextRange {
  readonly taskId: TaskId;
  readonly callId: string;
}

export interface MessageReadInput extends TextRange {
  readonly taskId: TaskId;
  readonly messageId: string;
}

type HistoryItem = {
  readonly at: number;
  readonly runId: string;
} & (
  | {
      readonly type: 'message' | 'supplement';
      readonly messageId: string;
      readonly role: MessageRecord['role'];
      readonly status: MessageRecord['status'];
      readonly text: string;
      readonly textLength: number;
      readonly attachmentIds: readonly string[];
      readonly applied?: boolean;
      readonly replyTo?: { readonly messageId: string; readonly taskId: TaskId };
    }
  | { readonly type: 'reasoning_summary'; readonly summary: string }
  | {
      readonly type: 'tool_call';
      readonly callId: string;
      readonly name: string;
      readonly argumentsJson: string;
    }
  | {
      readonly type: 'tool_result';
      readonly callId: string;
      readonly toolName: string;
      readonly preview: string;
      readonly outputLength: number;
      readonly attachmentIds: readonly string[];
    }
  | {
      readonly type: 'status';
      readonly taskStatus: TaskStatus;
      readonly runStatus: TaskStatus;
      readonly reason: string;
      readonly error: string | null;
    }
);

interface HistoryReadError {
  readonly ok: false;
  readonly code: 'HISTORY_NOT_FOUND' | 'INVALID_CURSOR' | 'RESULT_NOT_FOUND';
  readonly message: string;
  readonly retryable: false;
}

export type HistoryReadResponse =
  | {
      readonly ok: true;
      readonly task: Pick<Task, 'id' | 'ordinal' | 'goal' | 'status' | 'createdAt' | 'updatedAt'>;
      readonly items: readonly HistoryItem[];
      readonly nextCursor: string | null;
    }
  | HistoryReadError;

interface TextPage {
  readonly ok: true;
  readonly content: string;
  readonly nextOffset: number | null;
}

export type ResultReadResponse =
  | (TextPage & { readonly taskId: TaskId; readonly callId: string; readonly toolName: string })
  | HistoryReadError;

export type MessageReadResponse =
  | (TextPage &
      Pick<MessageRecord, 'taskId' | 'role' | 'status' | 'attachmentIds'> & {
        readonly messageId: string;
      })
  | HistoryReadError;

export interface TaskHistoryReaderPort {
  searchHistory(
    context: TaskHistoryContext,
    input: HistorySearchInput,
  ): Promise<HistorySearchResponse>;
  readAttachments(
    context: TaskHistoryContext,
    attachmentIds: readonly string[],
  ): Promise<readonly AttachmentRecord[] | null>;
  readHistory(context: TaskHistoryContext, input: HistoryReadInput): Promise<HistoryReadResponse>;
  readMessage(context: TaskHistoryContext, input: MessageReadInput): Promise<MessageReadResponse>;
  readResult(context: TaskHistoryContext, input: ResultReadInput): Promise<ResultReadResponse>;
}

interface CursorPayload {
  readonly version: 1;
  readonly taskId: TaskId;
  readonly lastSequence: number;
  readonly throughSequence?: number;
  readonly messageId?: string;
}

const HISTORY_PROJECTION_VERSION = 1;
const TOOL_RESULT_PREVIEW_CHARACTERS = 1_000;
const HISTORY_FIELD_PREVIEW_CHARACTERS = 2_000;
const HISTORY_ITEMS_CHARACTER_LIMIT = 40_000;

function historyNotFound(): HistoryReadError {
  return {
    ok: false,
    code: 'HISTORY_NOT_FOUND',
    message: 'The requested task history is unavailable in this conversation.',
    retryable: false,
  };
}

function invalidCursor(): HistoryReadError {
  return {
    ok: false,
    code: 'INVALID_CURSOR',
    message: 'The history cursor is invalid for this request. Restart with an empty cursor.',
    retryable: false,
  };
}

function resultNotFound(): HistoryReadError {
  return {
    ok: false,
    code: 'RESULT_NOT_FOUND',
    message: 'The requested tool result is unavailable in this conversation history.',
    retryable: false,
  };
}

function encodeReference(payload: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeReference(value: string): Record<string, unknown> | null {
  try {
    const padded = value
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function decodeCursor(value: string): CursorPayload | null {
  const parsed = decodeReference(value);
  if (
    parsed === null ||
    !('version' in parsed) ||
    parsed.version !== HISTORY_PROJECTION_VERSION ||
    !('taskId' in parsed) ||
    typeof parsed.taskId !== 'string' ||
    !('lastSequence' in parsed) ||
    !Number.isSafeInteger(parsed.lastSequence) ||
    ('throughSequence' in parsed && !Number.isSafeInteger(parsed.throughSequence)) ||
    ('messageId' in parsed && typeof parsed.messageId !== 'string')
  ) {
    return null;
  }
  return parsed as unknown as CursorPayload;
}

function searchPreview(message: MessageRecord, terms: readonly string[]): HistoryMessagePreview {
  const lower = message.text.toLowerCase();
  const match = terms.map((term) => lower.indexOf(term)).find((index) => index >= 0) ?? 0;
  const start = Math.max(0, match - 100);
  const end = Math.min(message.text.length, start + 350);
  return {
    messageId: message.id,
    role: message.role,
    status: message.status,
    createdAt: message.createdAt,
    text: `${start > 0 ? '…' : ''}${message.text.slice(start, end)}${end < message.text.length ? '…' : ''}`,
    textLength: message.text.length,
  };
}

function preview(text: string): string {
  return text.slice(0, HISTORY_FIELD_PREVIEW_CHARACTERS);
}

function messageItem(
  event: Pick<TaskEvent, 'at' | 'runId'> & {
    readonly type: 'message.recorded' | 'supplement.queued';
  },
  message: MessageRecord,
  appliedSupplements: ReadonlySet<string>,
): HistoryItem {
  const supplement = event.type === 'supplement.queued';
  return {
    at: event.at,
    runId: event.runId,
    type: supplement ? 'supplement' : 'message',
    messageId: message.id,
    role: message.role,
    status: message.status,
    text: preview(message.text),
    textLength: message.text.length,
    attachmentIds: message.attachmentIds,
    ...(supplement ? { applied: appliedSupplements.has(message.id) } : {}),
    ...(message.replyTo === undefined
      ? {}
      : { replyTo: { messageId: message.replyTo.messageId, taskId: message.replyTo.taskId } }),
  };
}

function validatedTaskMessages(
  task: Task,
  events: readonly TaskEvent[],
  messages: readonly MessageRecord[],
): ReadonlyMap<string, MessageRecord> {
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const messageEvents = events.filter(
    (
      event,
    ): event is Extract<TaskEvent, { readonly type: 'message.recorded' | 'supplement.queued' }> =>
      event.type === 'message.recorded' || event.type === 'supplement.queued',
  );
  const recordedMessageIds = new Set(messageEvents.map(({ messageId }) => messageId));
  if (
    messageById.size !== messages.length ||
    recordedMessageIds.size !== messages.length ||
    recordedMessageIds.size !== messageEvents.length ||
    messages.some(({ taskId }) => taskId !== task.id) ||
    messageEvents.some((event) => {
      const message = messageById.get(event.messageId);
      return (
        message === undefined ||
        message.taskId !== event.taskId ||
        (event.type === 'message.recorded'
          ? message.kind !== 'conversation'
          : message.kind !== 'supplement')
      );
    })
  ) {
    throw new Error('Task history record association is invalid.');
  }
  return messageById;
}

function visibleHistoryEvent(event: TaskEvent): boolean {
  return (
    event.type === 'message.recorded' ||
    event.type === 'supplement.queued' ||
    event.type === 'reasoning.summary' ||
    event.type === 'tool.call' ||
    event.type === 'tool.result' ||
    event.type === 'status.changed'
  );
}

function historyItems(
  events: readonly TaskEvent[],
  messageById: ReadonlyMap<string, MessageRecord>,
  resultByCall: ReadonlyMap<string, ToolResult>,
  appliedSupplements: ReadonlySet<string>,
  callsById: ReadonlyMap<string, Extract<TaskEvent, { readonly type: 'tool.call' }>>,
): readonly HistoryItem[] {
  return events.map((event): HistoryItem => {
    const base = { at: event.at, runId: event.runId };
    switch (event.type) {
      case 'message.recorded':
      case 'supplement.queued': {
        const message = messageById.get(event.messageId);
        if (
          message === undefined ||
          message.taskId !== event.taskId ||
          message.kind !== (event.type === 'message.recorded' ? 'conversation' : 'supplement')
        )
          throw new Error('Task history message association is invalid.');
        return messageItem({ ...base, type: event.type }, message, appliedSupplements);
      }
      case 'reasoning.summary':
        return { ...base, type: 'reasoning_summary', summary: preview(event.summary) };
      case 'tool.call':
        return {
          ...base,
          type: 'tool_call',
          callId: event.callId,
          name: event.name,
          argumentsJson: preview(event.argumentsJson),
        };
      case 'tool.result': {
        const result = resultByCall.get(event.callId);
        const call = callsById.get(event.callId);
        if (
          result === undefined ||
          call === undefined ||
          result.taskId !== event.taskId ||
          result.runId !== event.runId ||
          result.toolName !== call.name ||
          call.sequence >= event.sequence
        )
          throw new Error('Task history tool-result association is invalid.');
        return {
          ...base,
          type: 'tool_result',
          callId: event.callId,
          toolName: result.toolName,
          preview: result.output.slice(0, TOOL_RESULT_PREVIEW_CHARACTERS),
          outputLength: result.output.length,
          attachmentIds: result.attachmentIds,
        };
      }
      case 'status.changed':
        return {
          ...base,
          type: 'status',
          taskStatus: event.taskStatus,
          runStatus: event.runStatus,
          reason: preview(event.reason),
          error: event.error === null ? null : preview(event.error.userMessage),
        };
      default:
        throw new Error('Unexpected event in task history.');
    }
  });
}

function boundedHistoryItems(items: readonly HistoryItem[]): readonly HistoryItem[] {
  const page: HistoryItem[] = [];
  for (const item of items) {
    const candidate = [...page, item];
    if (page.length > 0 && JSON.stringify(candidate).length > HISTORY_ITEMS_CHARACTER_LIMIT) {
      break;
    }
    page.push(item);
  }
  return page;
}

function characterRange(value: string, { offset, limit }: TextRange): TextPage {
  const content = value.slice(offset, offset + limit);
  const next = offset + content.length;
  return { ok: true, content, nextOffset: next < value.length ? next : null };
}

export class TaskHistoryReader implements TaskHistoryReaderPort {
  readonly #tasks: Pick<
    TaskRepository,
    'listByConversation' | 'listEvents' | 'getToolResult' | 'get'
  >;
  readonly #conversations: Pick<ConversationRepository, 'listTaskMessages' | 'listMessages'>;
  readonly #attachments: Pick<AttachmentRepository, 'get'>;

  constructor(dependencies: {
    readonly tasks: Pick<
      TaskRepository,
      'listByConversation' | 'listEvents' | 'getToolResult' | 'get'
    >;
    readonly conversations: Pick<ConversationRepository, 'listTaskMessages' | 'listMessages'>;
    readonly attachments: Pick<AttachmentRepository, 'get'>;
  }) {
    this.#tasks = dependencies.tasks;
    this.#conversations = dependencies.conversations;
    this.#attachments = dependencies.attachments;
  }

  #isReadable(task: Task, context: TaskHistoryContext): boolean {
    return (
      isHistoricalTask(task, context) ||
      (task.conversationId === context.conversationId &&
        task.id === context.currentTaskId &&
        Number.isSafeInteger(context.currentTaskLastEventSequence) &&
        (context.currentTaskLastEventSequence ?? -1) >= 0)
    );
  }

  /** Reads an immutable event prefix, excluding messages appended after that boundary. */
  async #records(selected: Task, throughSequence?: number) {
    const [storedEvents, storedMessages] = await Promise.all([
      this.#tasks.listEvents(selected.id),
      this.#conversations.listTaskMessages(selected.id),
    ]);
    const boundary = throughSequence ?? selected.lastEventSequence;
    const task = { ...selected, lastEventSequence: boundary };
    const events = orderedTaskEvents(
      task,
      storedEvents.filter((event) => event.sequence <= boundary),
    );
    const messageIds = new Set(
      events.flatMap((event) =>
        event.type === 'message.recorded' || event.type === 'supplement.queued'
          ? [event.messageId]
          : [],
      ),
    );
    const messages =
      throughSequence === undefined
        ? storedMessages
        : storedMessages.filter((message) => messageIds.has(message.id));
    const cutoff = events.at(-1)?.at ?? selected.createdAt;
    const messageById = new Map(
      [...validatedTaskMessages(task, events, messages)].filter(
        ([, message]) =>
          message.status !== 'streaming' &&
          (throughSequence === undefined || message.updatedAt <= cutoff),
      ),
    );
    return { events, messageById };
  }

  async searchHistory(
    context: TaskHistoryContext,
    input: HistorySearchInput,
  ): Promise<HistorySearchResponse> {
    const query = input.query.trim().toLowerCase().replace(/\s+/gu, ' ');
    const cursor = input.cursor === '' ? null : decodeReference(input.cursor);
    if (
      input.cursor !== '' &&
      (cursor === null ||
        cursor.version !== 1 ||
        cursor.conversationId !== context.conversationId ||
        cursor.query !== query ||
        typeof cursor.messageId !== 'string')
    )
      return invalidCursor();
    const tasks = new Map(
      (await this.#tasks.listByConversation(context.conversationId))
        .filter((task) => this.#isReadable(task, context))
        .map((task) => [task.id, task]),
    );
    const records = new Map<
      string,
      {
        events: readonly TaskEvent[];
        messageById: ReadonlyMap<string, MessageRecord>;
      }
    >();
    const current = tasks.get(context.currentTaskId);
    let activeMessageId: string | undefined;
    if (current) {
      const record = await this.#records(
        current,
        Math.min(current.lastEventSequence, context.currentTaskLastEventSequence ?? 0),
      );
      records.set(current.id, record);
      const activeInput = record.events.findLast(
        (event) =>
          (event.type === 'message.recorded' || event.type === 'supplement.applied') &&
          record.messageById.get(event.messageId)?.role === 'user',
      );
      if (activeInput && 'messageId' in activeInput) activeMessageId = activeInput.messageId;
    }
    const messages = (await this.#conversations.listMessages(context.conversationId)).flatMap(
      (message) => {
        const saved =
          message.taskId === context.currentTaskId
            ? records.get(message.taskId)?.messageById.get(message.id)
            : message;
        if (
          !saved ||
          saved.id === activeMessageId ||
          saved.conversationId !== context.conversationId ||
          !tasks.has(saved.taskId) ||
          saved.status === 'streaming' ||
          saved.role === 'system'
        )
          return [];
        return [saved];
      },
    );
    const terms = query === '' ? [] : query.split(' ');
    const matches =
      terms.length === 0
        ? messages
        : messages.filter(({ text }) => {
            const lower = text.toLowerCase();
            return terms.every((term) => lower.includes(term));
          });
    matches.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const anchor =
      cursor === null ? -1 : matches.findIndex((message) => message.id === cursor.messageId);
    if (cursor !== null && anchor < 0) return invalidCursor();
    const page = matches.slice(anchor + 1, anchor + 1 + input.limit);
    const matchedIds = new Set(page.map(({ id }) => id));
    const excerptIds = new Set<string>();
    const items = [];
    for (const message of page) {
      const task = tasks.get(message.taskId);
      if (!task) throw new Error('Task history search owner is invalid.');
      let record = records.get(task.id);
      if (!record) {
        record = await this.#records(task);
        records.set(task.id, record);
      }
      const neighbors = record.events.flatMap((event) => {
        const value =
          event.type === 'message.recorded' || event.type === 'supplement.queued'
            ? record.messageById.get(event.messageId)
            : undefined;
        return value && value.id !== activeMessageId && value.role !== 'system' ? [value] : [];
      });
      const index = neighbors.findIndex(({ id }) => id === message.id);
      if (index < 0) throw new Error('Task history search message association is invalid.');
      const question = neighbors.findLastIndex(
        (neighbor, position) => position <= index && neighbor.role === 'user',
      );
      const positions = [...new Set([question, index - 1, index, index + 1])]
        .filter((position) => position >= 0 && position < neighbors.length)
        .sort((a, b) => a - b);
      items.push({
        taskId: task.id,
        taskStatus: task.status,
        messageId: message.id,
        context: positions.flatMap((position) => {
          const neighbor = neighbors[position];
          if (!neighbor) return [];
          // Each hit keeps its own excerpt. Share any other excerpts once per page.
          if (neighbor.id !== message.id) {
            if (matchedIds.has(neighbor.id) || excerptIds.has(neighbor.id)) return [];
            excerptIds.add(neighbor.id);
          }
          return [searchPreview(neighbor, terms)];
        }),
      });
    }
    const hasMore = anchor + 1 + page.length < matches.length;
    return {
      ok: true,
      items,
      nextCursor: hasMore
        ? encodeReference({
            version: 1,
            conversationId: context.conversationId,
            query,
            messageId: page.at(-1)?.id,
          })
        : null,
    };
  }

  async readAttachments(
    context: TaskHistoryContext,
    attachmentIds: readonly string[],
  ): Promise<readonly AttachmentRecord[] | null> {
    const records = await Promise.all(
      [...new Set(attachmentIds)].map((id) => this.#attachments.get(id, context.conversationId)),
    );
    return records.every((record) => record !== undefined) ? records : null;
  }

  async readHistory(
    context: TaskHistoryContext,
    input: HistoryReadInput,
  ): Promise<HistoryReadResponse> {
    let selected: Task | undefined;
    if (input.taskId === null) {
      if (input.offset === null) throw new Error('Task history selector is invalid.');
      selected = orderedHistoricalTasks(
        await this.#tasks.listByConversation(context.conversationId),
        context,
      )[input.offset - 1];
    } else {
      if (input.offset !== null) throw new Error('Task history selector is invalid.');
      selected = await this.#tasks.get(input.taskId);
    }
    if (selected === undefined || !this.#isReadable(selected, context)) return historyNotFound();
    return this.#readSelectedHistory(selected, context, input);
  }

  async #readSelectedHistory(
    selected: Task,
    context: TaskHistoryContext,
    input: Pick<HistoryReadInput, 'cursor' | 'limit' | 'messageId'>,
  ): Promise<HistoryReadResponse> {
    const cursor = input.cursor === '' ? null : decodeCursor(input.cursor);
    if (
      input.cursor !== '' &&
      (cursor === null ||
        cursor.taskId !== selected.id ||
        (cursor.messageId ?? null) !== (input.messageId ?? null))
    ) {
      return invalidCursor();
    }
    const boundary =
      selected.id === context.currentTaskId
        ? Math.min(selected.lastEventSequence, context.currentTaskLastEventSequence ?? 0)
        : selected.lastEventSequence;
    const throughSequence = cursor?.throughSequence ?? boundary;
    if (throughSequence < 0 || throughSequence > boundary) return invalidCursor();
    const { events, messageById } = await this.#records(
      selected,
      selected.id === context.currentTaskId || cursor?.throughSequence !== undefined
        ? throughSequence
        : undefined,
    );
    const visibleEvents = events.filter((event) => {
      if (event.type === 'message.recorded' || event.type === 'supplement.queued')
        return messageById.has(event.messageId);
      return !input.messageId && visibleHistoryEvent(event);
    });
    let start =
      cursor === null
        ? 0
        : visibleEvents.findIndex(({ sequence }) => sequence > cursor.lastSequence);
    if (input.messageId && cursor === null) {
      const anchor = visibleEvents.findIndex(
        (event) => 'messageId' in event && event.messageId === input.messageId,
      );
      if (anchor < 0) return historyNotFound();
      start = Math.max(0, anchor - 1);
    }
    if (cursor !== null && start < 0) return invalidCursor();
    const pageEvents = visibleEvents.slice(start, start + input.limit);
    const pageResultEvents = pageEvents.filter(
      (event): event is Extract<TaskEvent, { readonly type: 'tool.result' }> =>
        event.type === 'tool.result',
    );
    const pageResults = await Promise.all(
      pageResultEvents.map(({ callId }) => this.#tasks.getToolResult(selected.id, callId)),
    );
    if (pageResults.some((result) => result === undefined)) {
      throw new Error('Task history tool-result association is invalid.');
    }
    const resultByCall = new Map(
      pageResults.flatMap((result) =>
        result === undefined ? [] : [[result.callId, result] as const],
      ),
    );
    const appliedSupplements = new Set(
      events.flatMap((event) => (event.type === 'supplement.applied' ? [event.messageId] : [])),
    );
    const callsById = new Map(
      events.flatMap((event) =>
        event.type === 'tool.call' ? [[event.callId, event] as const] : [],
      ),
    );
    const projectedItems = historyItems(
      pageEvents,
      messageById,
      resultByCall,
      appliedSupplements,
      callsById,
    );
    const page = boundedHistoryItems(projectedItems);
    const lastSequence = pageEvents[page.length - 1]?.sequence;
    return {
      ok: true,
      task: {
        id: selected.id,
        ordinal: selected.ordinal,
        goal: preview(selected.goal),
        status: selected.status,
        createdAt: selected.createdAt,
        updatedAt: selected.updatedAt,
      },
      items: page,
      nextCursor:
        start + page.length < visibleEvents.length && lastSequence !== undefined
          ? encodeReference({
              version: HISTORY_PROJECTION_VERSION,
              taskId: selected.id,
              lastSequence,
              throughSequence,
              ...(input.messageId ? { messageId: input.messageId } : {}),
            })
          : null,
    };
  }

  async readMessage(
    context: TaskHistoryContext,
    input: MessageReadInput,
  ): Promise<MessageReadResponse> {
    const task = await this.#tasks.get(input.taskId);
    if (!task || !this.#isReadable(task, context)) return historyNotFound();
    const { messageById } = await this.#records(
      task,
      task.id === context.currentTaskId
        ? Math.min(task.lastEventSequence, context.currentTaskLastEventSequence ?? 0)
        : undefined,
    );
    const message = messageById.get(input.messageId);
    if (!message) return historyNotFound();
    return {
      taskId: task.id,
      messageId: message.id,
      role: message.role,
      status: message.status,
      attachmentIds: message.attachmentIds,
      ...characterRange(message.text, input),
    };
  }

  async readResult(
    context: TaskHistoryContext,
    input: ResultReadInput,
  ): Promise<ResultReadResponse> {
    const task = await this.#tasks.get(input.taskId);
    if (
      task === undefined ||
      task.conversationId !== context.conversationId ||
      !this.#isReadable(task, context)
    ) {
      return resultNotFound();
    }
    const result = await this.#tasks.getToolResult(task.id, input.callId);
    if (result === undefined) return resultNotFound();
    if (
      task.id === context.currentTaskId &&
      !(await this.#tasks.listEvents(task.id)).some(
        (event) =>
          event.type === 'tool.result' &&
          event.callId === input.callId &&
          event.sequence <= (context.currentTaskLastEventSequence ?? -1),
      )
    )
      return resultNotFound();
    return {
      taskId: result.taskId,
      callId: result.callId,
      toolName: result.toolName,
      ...characterRange(result.output, input),
    };
  }
}
