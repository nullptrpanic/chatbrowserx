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

interface HistorySearchPage {
  readonly items: readonly {
    readonly taskId: TaskId;
    readonly taskStatus: TaskStatus;
    readonly messageId: string;
    readonly context: readonly HistoryMessagePreview[];
  }[];
  readonly totalCount: number;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export type HistorySearchResponse =
  | (HistorySearchPage & { readonly ok: true; readonly recent?: HistorySearchPage })
  | HistoryReadError;

export interface ResultReadInput {
  readonly resultId: string;
  readonly offset: number;
  readonly limit: number;
}

export interface HistoryDetailReadInput {
  readonly detailId: string;
  readonly offset: number;
  readonly limit: number;
}

export type HistoryDetailField =
  | 'task_goal'
  | 'message_text'
  | 'reasoning_summary'
  | 'tool_arguments'
  | 'status_reason'
  | 'status_error';

export type HistoryItem =
  | {
      readonly sequence: number;
      readonly at: number;
      readonly runId: string;
      readonly type: 'message' | 'supplement';
      readonly messageId: string;
      readonly role: MessageRecord['role'];
      readonly status: MessageRecord['status'];
      readonly text: string;
      readonly textLength: number;
      readonly textDetailId: string | null;
      readonly attachmentCount: number;
      readonly attachmentIds: readonly string[];
      readonly applied?: boolean;
      readonly replyTo?: {
        readonly messageId: string;
        readonly taskId: TaskId;
      };
    }
  | {
      readonly sequence: number;
      readonly at: number;
      readonly runId: string;
      readonly type: 'reasoning_summary';
      readonly summary: string;
      readonly summaryLength: number;
      readonly summaryDetailId: string | null;
    }
  | {
      readonly sequence: number;
      readonly at: number;
      readonly runId: string;
      readonly type: 'tool_call';
      readonly callId: string;
      readonly name: string;
      readonly argumentsJson: string;
      readonly argumentsLength: number;
      readonly argumentsDetailId: string | null;
    }
  | {
      readonly sequence: number;
      readonly at: number;
      readonly runId: string;
      readonly type: 'tool_result';
      readonly callId: string;
      readonly resultId: string;
      readonly toolName: string;
      readonly preview: string;
      readonly outputLength: number;
      readonly attachmentCount: number;
      readonly attachmentIds: readonly string[];
    }
  | {
      readonly sequence: number;
      readonly at: number;
      readonly runId: string;
      readonly type: 'status';
      readonly taskStatus: TaskStatus;
      readonly runStatus: TaskStatus;
      readonly reason: string;
      readonly reasonLength: number;
      readonly reasonDetailId: string | null;
      readonly error: string | null;
      readonly errorLength: number;
      readonly errorDetailId: string | null;
    };

interface HistoryReadError {
  readonly ok: false;
  readonly code: 'HISTORY_NOT_FOUND' | 'INVALID_CURSOR' | 'DETAIL_NOT_FOUND' | 'RESULT_NOT_FOUND';
  readonly message: string;
  readonly retryable: false;
}

export type HistoryReadResponse =
  | {
      readonly ok: true;
      readonly task: Pick<
        Task,
        'id' | 'ordinal' | 'goal' | 'status' | 'createdAt' | 'updatedAt'
      > & {
        readonly goalLength: number;
        readonly goalDetailId: string | null;
      };
      readonly items: readonly HistoryItem[];
      readonly itemsCharacterCount: number;
      readonly itemsCharacterLimit: number;
      readonly returnedCount: number;
      readonly consumedCount: number;
      readonly totalCount: number;
      readonly remainingCount: number;
      readonly nextCursor: string | null;
      readonly hasMore: boolean;
    }
  | HistoryReadError;

export type ResultReadResponse =
  | {
      readonly ok: true;
      readonly resultId: string;
      readonly taskId: TaskId;
      readonly toolName: string;
      readonly content: string;
      readonly offset: number;
      readonly returnedCount: number;
      readonly consumedCount: number;
      readonly totalCount: number;
      readonly remainingCount: number;
      readonly nextOffset: number | null;
      readonly hasMore: boolean;
    }
  | HistoryReadError;

export type HistoryDetailReadResponse =
  | {
      readonly ok: true;
      readonly detailId: string;
      readonly taskId: TaskId;
      readonly sequence: number;
      readonly field: HistoryDetailField;
      readonly content: string;
      readonly offset: number;
      readonly returnedCount: number;
      readonly consumedCount: number;
      readonly totalCount: number;
      readonly remainingCount: number;
      readonly nextOffset: number | null;
      readonly hasMore: boolean;
    }
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
  readDetail(
    context: TaskHistoryContext,
    input: HistoryDetailReadInput,
  ): Promise<HistoryDetailReadResponse>;
  readResult(context: TaskHistoryContext, input: ResultReadInput): Promise<ResultReadResponse>;
}

interface CursorPayload {
  readonly version: 1;
  readonly taskId: TaskId;
  readonly lastSequence: number;
  readonly throughSequence?: number;
  readonly messageId?: string;
}

interface DetailPayload {
  readonly version: 1;
  readonly taskId: TaskId;
  readonly sequence: number;
  readonly field: HistoryDetailField;
}

const HISTORY_PROJECTION_VERSION = 1;
const HISTORY_DETAIL_VERSION = 1;
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

function detailNotFound(): HistoryReadError {
  return {
    ok: false,
    code: 'DETAIL_NOT_FOUND',
    message: 'The requested history detail is unavailable in this conversation history.',
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

function isHistoryDetailField(value: unknown): value is HistoryDetailField {
  return (
    value === 'task_goal' ||
    value === 'message_text' ||
    value === 'reasoning_summary' ||
    value === 'tool_arguments' ||
    value === 'status_reason' ||
    value === 'status_error'
  );
}

function decodeDetail(value: string): DetailPayload | null {
  const parsed = decodeReference(value);
  if (
    parsed === null ||
    !('version' in parsed) ||
    parsed.version !== HISTORY_DETAIL_VERSION ||
    !('taskId' in parsed) ||
    typeof parsed.taskId !== 'string' ||
    !('sequence' in parsed) ||
    !Number.isSafeInteger(parsed.sequence) ||
    !('field' in parsed) ||
    !isHistoryDetailField(parsed.field)
  ) {
    return null;
  }
  return parsed as unknown as DetailPayload;
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

function projectedField(
  value: string,
  payload: DetailPayload,
): {
  readonly preview: string;
  readonly length: number;
  readonly detailId: string | null;
} {
  return {
    preview: value.slice(0, HISTORY_FIELD_PREVIEW_CHARACTERS),
    length: value.length,
    detailId: value.length > HISTORY_FIELD_PREVIEW_CHARACTERS ? encodeReference(payload) : null,
  };
}

function messageItem(
  event: Pick<TaskEvent, 'sequence' | 'at' | 'runId'> & {
    readonly type: 'message.recorded' | 'supplement.queued';
  },
  message: MessageRecord,
  appliedSupplements: ReadonlySet<string>,
): HistoryItem {
  const supplement = event.type === 'supplement.queued';
  const text = projectedField(message.text, {
    version: HISTORY_DETAIL_VERSION,
    taskId: message.taskId,
    sequence: event.sequence,
    field: 'message_text',
  });
  return {
    sequence: event.sequence,
    at: event.at,
    runId: event.runId,
    type: supplement ? 'supplement' : 'message',
    messageId: message.id,
    role: message.role,
    status: message.status,
    text: text.preview,
    textLength: text.length,
    textDetailId: text.detailId,
    attachmentCount: message.attachmentIds.length,
    attachmentIds: message.attachmentIds,
    ...(supplement ? { applied: appliedSupplements.has(message.id) } : {}),
    ...(message.replyTo === undefined
      ? {}
      : {
          replyTo: {
            messageId: message.replyTo.messageId,
            taskId: message.replyTo.taskId,
          },
        }),
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
  resultById: ReadonlyMap<string, ToolResult>,
  appliedSupplements: ReadonlySet<string>,
  callsById: ReadonlyMap<string, Extract<TaskEvent, { readonly type: 'tool.call' }>>,
): readonly HistoryItem[] {
  return [...events].flatMap((event): HistoryItem[] => {
    if (event.type === 'message.recorded') {
      const message = messageById.get(event.messageId);
      if (
        message === undefined ||
        message.taskId !== event.taskId ||
        message.kind !== 'conversation'
      )
        throw new Error('Task history message association is invalid.');
      return [messageItem(event, message, appliedSupplements)];
    }
    if (event.type === 'supplement.queued') {
      const message = messageById.get(event.messageId);
      if (message === undefined || message.taskId !== event.taskId || message.kind !== 'supplement')
        throw new Error('Task history message association is invalid.');
      return [messageItem({ ...event, type: 'supplement.queued' }, message, appliedSupplements)];
    }
    if (event.type === 'reasoning.summary') {
      const summary = projectedField(event.summary, {
        version: HISTORY_DETAIL_VERSION,
        taskId: event.taskId,
        sequence: event.sequence,
        field: 'reasoning_summary',
      });
      return [
        {
          sequence: event.sequence,
          at: event.at,
          runId: event.runId,
          type: 'reasoning_summary',
          summary: summary.preview,
          summaryLength: summary.length,
          summaryDetailId: summary.detailId,
        },
      ];
    }
    if (event.type === 'tool.call') {
      const argumentsJson = projectedField(event.argumentsJson, {
        version: HISTORY_DETAIL_VERSION,
        taskId: event.taskId,
        sequence: event.sequence,
        field: 'tool_arguments',
      });
      return [
        {
          sequence: event.sequence,
          at: event.at,
          runId: event.runId,
          type: 'tool_call',
          callId: event.callId,
          name: event.name,
          argumentsJson: argumentsJson.preview,
          argumentsLength: argumentsJson.length,
          argumentsDetailId: argumentsJson.detailId,
        },
      ];
    }
    if (event.type === 'tool.result') {
      const result = resultById.get(event.resultId);
      const call = callsById.get(event.callId);
      if (
        result === undefined ||
        call === undefined ||
        result.taskId !== event.taskId ||
        result.runId !== event.runId ||
        result.callId !== event.callId ||
        result.toolName !== call.name ||
        call.sequence >= event.sequence
      ) {
        throw new Error('Task history tool-result association is invalid.');
      }
      return [
        {
          sequence: event.sequence,
          at: event.at,
          runId: event.runId,
          type: 'tool_result',
          callId: event.callId,
          resultId: result.id,
          toolName: result.toolName,
          preview: result.output.slice(0, TOOL_RESULT_PREVIEW_CHARACTERS),
          outputLength: result.output.length,
          attachmentCount: result.attachmentIds.length,
          attachmentIds: result.attachmentIds,
        },
      ];
    }
    if (event.type === 'status.changed') {
      const reason = projectedField(event.reason, {
        version: HISTORY_DETAIL_VERSION,
        taskId: event.taskId,
        sequence: event.sequence,
        field: 'status_reason',
      });
      const error =
        event.error == null
          ? null
          : projectedField(event.error.userMessage, {
              version: HISTORY_DETAIL_VERSION,
              taskId: event.taskId,
              sequence: event.sequence,
              field: 'status_error',
            });
      return [
        {
          sequence: event.sequence,
          at: event.at,
          runId: event.runId,
          type: 'status',
          taskStatus: event.taskStatus,
          runStatus: event.runStatus,
          reason: reason.preview,
          reasonLength: reason.length,
          reasonDetailId: reason.detailId,
          error: error?.preview ?? null,
          errorLength: error?.length ?? 0,
          errorDetailId: error?.detailId ?? null,
        },
      ];
    }
    return [];
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

function characterRange(
  detailId: string,
  payload: DetailPayload,
  value: string,
  input: Pick<HistoryDetailReadInput, 'offset' | 'limit'>,
): HistoryDetailReadResponse {
  const content = value.slice(input.offset, input.offset + input.limit);
  const consumedCount = Math.min(input.offset + content.length, value.length);
  const remainingCount = value.length - consumedCount;
  return {
    ok: true,
    detailId,
    taskId: payload.taskId,
    sequence: payload.sequence,
    field: payload.field,
    content,
    offset: input.offset,
    returnedCount: content.length,
    consumedCount,
    totalCount: value.length,
    remainingCount,
    nextOffset: remainingCount > 0 ? consumedCount : null,
    hasMore: remainingCount > 0,
  };
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
    let terms = query === '' ? [] : query.split(' ');
    let matches =
      terms.length === 0
        ? messages
        : messages.filter(({ text }) => {
            const lower = text.toLowerCase();
            return terms.every((term) => lower.includes(term));
          });
    const recentFallback =
      query !== '' &&
      matches.length === 0 &&
      cursor === null &&
      messages.length > 0 &&
      messages.length <= input.limit &&
      !messages.some(({ text }) => {
        const lower = text.toLowerCase();
        return terms.some((term) => lower.includes(term));
      });
    if (recentFallback) {
      terms = [];
      matches = messages;
    }
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
    const result = {
      items,
      totalCount: matches.length,
      hasMore,
      nextCursor: hasMore
        ? encodeReference({
            version: 1,
            conversationId: context.conversationId,
            query,
            messageId: page.at(-1)?.id,
          })
        : null,
    };
    return recentFallback
      ? { ok: true, items: [], totalCount: 0, nextCursor: null, hasMore: false, recent: result }
      : { ok: true, ...result };
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
      pageResultEvents.map(({ resultId }) => this.#tasks.getToolResult(resultId)),
    );
    if (pageResults.some((result) => result === undefined)) {
      throw new Error('Task history tool-result association is invalid.');
    }
    const resultById = new Map(
      pageResults.flatMap((result) => (result === undefined ? [] : [[result.id, result] as const])),
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
      resultById,
      appliedSupplements,
      callsById,
    );
    const page = boundedHistoryItems(projectedItems);
    const consumedCount = start + page.length;
    const remainingCount = visibleEvents.length - consumedCount;
    const hasMore = remainingCount > 0;
    const lastSequence = page.at(-1)?.sequence;
    const goal = projectedField(selected.goal, {
      version: HISTORY_DETAIL_VERSION,
      taskId: selected.id,
      sequence: 0,
      field: 'task_goal',
    });
    const itemsCharacterCount = JSON.stringify(page).length;
    return {
      ok: true,
      task: {
        id: selected.id,
        ordinal: selected.ordinal,
        goal: goal.preview,
        goalLength: goal.length,
        goalDetailId: goal.detailId,
        status: selected.status,
        createdAt: selected.createdAt,
        updatedAt: selected.updatedAt,
      },
      items: page,
      itemsCharacterCount,
      itemsCharacterLimit: HISTORY_ITEMS_CHARACTER_LIMIT,
      returnedCount: page.length,
      consumedCount,
      totalCount: visibleEvents.length,
      remainingCount,
      nextCursor:
        hasMore && lastSequence !== undefined
          ? encodeReference({
              version: HISTORY_PROJECTION_VERSION,
              taskId: selected.id,
              lastSequence,
              throughSequence,
              ...(input.messageId ? { messageId: input.messageId } : {}),
            })
          : null,
      hasMore,
    };
  }

  async readDetail(
    context: TaskHistoryContext,
    input: HistoryDetailReadInput,
  ): Promise<HistoryDetailReadResponse> {
    const payload = decodeDetail(input.detailId);
    if (payload === null) return detailNotFound();
    const selected = await this.#tasks.get(payload.taskId);
    if (selected === undefined || !this.#isReadable(selected, context)) return detailNotFound();
    if (payload.field === 'task_goal' && payload.sequence === 0) {
      return characterRange(input.detailId, payload, selected.goal, input);
    }

    const { events, messageById } = await this.#records(
      selected,
      selected.id === context.currentTaskId
        ? Math.min(selected.lastEventSequence, context.currentTaskLastEventSequence ?? 0)
        : undefined,
    );
    const event = events.find(({ sequence }) => sequence === payload.sequence);
    if (event === undefined) return detailNotFound();

    let value: string | null = null;
    if (
      payload.field === 'message_text' &&
      (event.type === 'message.recorded' || event.type === 'supplement.queued')
    ) {
      const message = messageById.get(event.messageId);
      value = message?.status === 'streaming' ? null : (message?.text ?? null);
    } else if (payload.field === 'reasoning_summary' && event.type === 'reasoning.summary') {
      value = event.summary;
    } else if (payload.field === 'tool_arguments' && event.type === 'tool.call') {
      value = event.argumentsJson;
    } else if (payload.field === 'status_reason' && event.type === 'status.changed') {
      value = event.reason;
    } else if (payload.field === 'status_error' && event.type === 'status.changed') {
      value = event.error?.userMessage ?? null;
    }
    return value === null
      ? detailNotFound()
      : characterRange(input.detailId, payload, value, input);
  }

  async readResult(
    context: TaskHistoryContext,
    input: ResultReadInput,
  ): Promise<ResultReadResponse> {
    const result = await this.#tasks.getToolResult(input.resultId);
    if (result === undefined) return resultNotFound();
    const task = await this.#tasks.get(result.taskId);
    if (
      task === undefined ||
      task.conversationId !== context.conversationId ||
      !this.#isReadable(task, context)
    ) {
      return resultNotFound();
    }
    if (
      task.id === context.currentTaskId &&
      !(await this.#tasks.listEvents(task.id)).some(
        (event) =>
          event.type === 'tool.result' &&
          event.resultId === result.id &&
          event.callId === result.callId &&
          event.sequence <= (context.currentTaskLastEventSequence ?? -1),
      )
    )
      return resultNotFound();
    const content = result.output.slice(input.offset, input.offset + input.limit);
    const consumedCount = Math.min(input.offset + content.length, result.output.length);
    const remainingCount = result.output.length - consumedCount;
    return {
      ok: true,
      resultId: result.id,
      taskId: result.taskId,
      toolName: result.toolName,
      content,
      offset: input.offset,
      returnedCount: content.length,
      consumedCount,
      totalCount: result.output.length,
      remainingCount,
      nextOffset: remainingCount > 0 ? consumedCount : null,
      hasMore: remainingCount > 0,
    };
  }
}
