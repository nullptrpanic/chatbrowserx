import type { ConversationRepository } from '../persistence/conversation-repository';
import type { TaskRepository } from '../persistence/task-repository';
import type { ConversationId, TaskId } from '../shared/ids';
import type { MessageRecord } from './message-types';
import { isHistoricalTask, orderedHistoricalTasks } from './task-history-order';
import type { Task, TaskEvent, TaskStatus } from './task-types';
import type { ToolResult } from './tool-result-types';

export interface TaskHistoryContext {
  readonly conversationId: ConversationId;
  readonly currentTaskId: TaskId;
}

export interface HistoryReadInput {
  readonly taskId: TaskId | null;
  readonly offset: number | null;
  readonly cursor: string;
  readonly limit: number;
}

export interface ResultReadInput {
  readonly resultId: string;
  readonly offset: number;
  readonly limit: number;
}

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
      readonly attachmentCount: number;
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
    }
  | {
      readonly sequence: number;
      readonly at: number;
      readonly runId: string;
      readonly type: 'tool_call';
      readonly callId: string;
      readonly name: string;
      readonly argumentsJson: string;
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
    }
  | {
      readonly sequence: number;
      readonly at: number;
      readonly runId: string;
      readonly type: 'status';
      readonly taskStatus: TaskStatus;
      readonly runStatus: TaskStatus;
      readonly reason: string;
      readonly error: string | null;
    };

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

export interface TaskHistoryReaderPort {
  readHistory(context: TaskHistoryContext, input: HistoryReadInput): Promise<HistoryReadResponse>;
  readResult(context: TaskHistoryContext, input: ResultReadInput): Promise<ResultReadResponse>;
}

interface CursorPayload {
  readonly version: 1;
  readonly taskId: TaskId;
  readonly lastSequence: number;
}

const HISTORY_PROJECTION_VERSION = 1;
const TOOL_RESULT_PREVIEW_CHARACTERS = 1_000;

function historyNotFound(): HistoryReadError {
  return {
    ok: false,
    code: 'HISTORY_NOT_FOUND',
    message: 'The requested previous task is unavailable in this conversation.',
    retryable: false,
  };
}

function invalidCursor(): HistoryReadError {
  return {
    ok: false,
    code: 'INVALID_CURSOR',
    message: 'The history cursor is invalid for the requested task.',
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

function encodeCursor(payload: CursorPayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeCursor(value: string): CursorPayload | null {
  try {
    const padded = value
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('version' in parsed) ||
      parsed.version !== HISTORY_PROJECTION_VERSION ||
      !('taskId' in parsed) ||
      typeof parsed.taskId !== 'string' ||
      !('lastSequence' in parsed) ||
      !Number.isSafeInteger(parsed.lastSequence)
    ) {
      return null;
    }
    return parsed as unknown as CursorPayload;
  } catch {
    return null;
  }
}

function messageItem(
  event: Pick<TaskEvent, 'sequence' | 'at' | 'runId'> & {
    readonly type: 'message.recorded' | 'supplement.queued';
  },
  message: MessageRecord,
  appliedSupplements: ReadonlySet<string>,
): HistoryItem {
  const supplement = event.type === 'supplement.queued';
  return {
    sequence: event.sequence,
    at: event.at,
    runId: event.runId,
    type: supplement ? 'supplement' : 'message',
    messageId: message.id,
    role: message.role,
    status: message.status,
    text: message.text,
    attachmentCount: message.attachmentIds.length,
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

function orderedTaskEvents(task: Task, events: readonly TaskEvent[]): readonly TaskEvent[] {
  const ordered = [...events].sort(
    (left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
  if (
    ordered.length !== task.lastEventSequence ||
    ordered.some((event, index) => event.taskId !== task.id || event.sequence !== index + 1)
  ) {
    throw new Error('Task history event records are inconsistent.');
  }
  return ordered;
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
      return [
        {
          sequence: event.sequence,
          at: event.at,
          runId: event.runId,
          type: 'reasoning_summary',
          summary: event.summary,
        },
      ];
    }
    if (event.type === 'tool.call') {
      return [
        {
          sequence: event.sequence,
          at: event.at,
          runId: event.runId,
          type: 'tool_call',
          callId: event.callId,
          name: event.name,
          argumentsJson: event.argumentsJson,
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
        },
      ];
    }
    if (event.type === 'status.changed') {
      return [
        {
          sequence: event.sequence,
          at: event.at,
          runId: event.runId,
          type: 'status',
          taskStatus: event.taskStatus,
          runStatus: event.runStatus,
          reason: event.reason,
          error: event.error?.userMessage ?? null,
        },
      ];
    }
    return [];
  });
}

export class TaskHistoryReader implements TaskHistoryReaderPort {
  readonly #tasks: Pick<
    TaskRepository,
    'listByConversation' | 'listEvents' | 'getToolResult' | 'get'
  >;
  readonly #conversations: Pick<ConversationRepository, 'listTaskMessages'>;

  constructor(dependencies: {
    readonly tasks: Pick<
      TaskRepository,
      'listByConversation' | 'listEvents' | 'getToolResult' | 'get'
    >;
    readonly conversations: Pick<ConversationRepository, 'listTaskMessages'>;
  }) {
    this.#tasks = dependencies.tasks;
    this.#conversations = dependencies.conversations;
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
    if (selected === undefined || !isHistoricalTask(selected, context)) return historyNotFound();
    return this.#readSelectedHistory(selected, input);
  }

  async #readSelectedHistory(
    selected: Task,
    input: Pick<HistoryReadInput, 'cursor' | 'limit'>,
  ): Promise<HistoryReadResponse> {
    const cursor = input.cursor === '' ? null : decodeCursor(input.cursor);
    if (input.cursor !== '' && (cursor === null || cursor.taskId !== selected.id)) {
      return invalidCursor();
    }

    const [storedEvents, messages] = await Promise.all([
      this.#tasks.listEvents(selected.id),
      this.#conversations.listTaskMessages(selected.id),
    ]);
    const events = orderedTaskEvents(selected, storedEvents);
    const messageById = validatedTaskMessages(selected, events, messages);
    const visibleEvents = events.filter(visibleHistoryEvent);
    const start =
      cursor === null
        ? 0
        : visibleEvents.findIndex(({ sequence }) => sequence > cursor.lastSequence);
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
    const page = historyItems(pageEvents, messageById, resultById, appliedSupplements, callsById);
    const consumedCount = start + page.length;
    const remainingCount = visibleEvents.length - consumedCount;
    const hasMore = remainingCount > 0;
    const lastSequence = page.at(-1)?.sequence;
    return {
      ok: true,
      task: {
        id: selected.id,
        ordinal: selected.ordinal,
        goal: selected.goal,
        status: selected.status,
        createdAt: selected.createdAt,
        updatedAt: selected.updatedAt,
      },
      items: page,
      returnedCount: page.length,
      consumedCount,
      totalCount: visibleEvents.length,
      remainingCount,
      nextCursor:
        hasMore && lastSequence !== undefined
          ? encodeCursor({
              version: HISTORY_PROJECTION_VERSION,
              taskId: selected.id,
              lastSequence,
            })
          : null,
      hasMore,
    };
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
      task.id === context.currentTaskId ||
      !isHistoricalTask(task, context)
    ) {
      return resultNotFound();
    }
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
