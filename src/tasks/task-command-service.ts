import type { ConversationRepository } from '../persistence/conversation-repository';
import type { TaskRepository } from '../persistence/task-repository';
import type { IdGenerator, MessageId, TaskId } from '../shared/ids';
import type { Clock } from '../shared/time';
import type { Checkpoint } from './checkpoint-types';
import type { ContinuationItem, PendingToolCall } from './continuation-types';
import { createTask, type CreateTaskInput } from './task-factory';
import { retainTaskReply } from './task-reply-retention';
import { transitionTask } from './task-transition';
import type { TaskEvent, TaskEventType, TaskRun } from './task-types';

export type TaskCommandErrorCode =
  'TASK_NOT_FOUND' | 'TASK_STATE_INVALID' | 'CHECKPOINT_NOT_FOUND' | 'TASK_ALREADY_RUNNING';

export interface TaskSnapshot {
  readonly task: TaskRun;
  readonly checkpoint: Checkpoint;
  readonly events: readonly TaskEvent[];
}

export interface CreateTaskCommandInput extends CreateTaskInput {
  readonly userMessageId?: MessageId;
}

export interface ContinueCancelledTaskInput {
  readonly sourceTaskId: TaskId;
  readonly tabId: number;
  readonly goal: string;
  readonly userMessageId: MessageId;
}

export interface TaskCommandPort {
  create(input: CreateTaskCommandInput): Promise<TaskSnapshot>;
  continueCancelled(input: ContinueCancelledTaskInput): Promise<TaskSnapshot>;
  getSnapshot(taskId: TaskId): Promise<TaskSnapshot>;
  pause(taskId: TaskId): Promise<TaskSnapshot>;
  resume(taskId: TaskId): Promise<TaskSnapshot>;
  retry(taskId: TaskId): Promise<TaskSnapshot>;
  cancel(taskId: TaskId): Promise<TaskSnapshot>;
}

export class TaskCommandError extends Error {
  readonly code: TaskCommandErrorCode;

  /**
   * Creates a stable public command failure without including storage or credential details.
   */
  constructor(code: TaskCommandErrorCode, message: string) {
    super(message);
    this.name = 'TaskCommandError';
    this.code = code;
  }
}

/** Inserts later messages before an unresolved call so its output can remain structurally adjacent. */
function insertBeforePendingToolCall(
  items: readonly ContinuationItem[],
  pendingToolCall: PendingToolCall | null,
  additions: readonly ContinuationItem[],
): ContinuationItem[] {
  if (pendingToolCall === null) return [...items, ...additions];
  const pendingIndex = items.findIndex(
    (item) => item.type === 'function_call' && item.callId === pendingToolCall.callId,
  );
  if (pendingIndex < 0) {
    throw new TaskCommandError(
      'TASK_STATE_INVALID',
      'Pending tool call is missing from the task continuation.',
    );
  }
  const trailingItems = items.slice(pendingIndex + 1);
  if (trailingItems.some((item) => item.type !== 'message_ref')) {
    throw new TaskCommandError(
      'TASK_STATE_INVALID',
      'Pending tool continuation contains an invalid trailing item.',
    );
  }
  const pendingItem = items[pendingIndex];
  if (pendingItem === undefined) {
    throw new TaskCommandError('TASK_STATE_INVALID', 'Pending tool continuation is invalid.');
  }
  return [...items.slice(0, pendingIndex), ...trailingItems, ...additions, pendingItem];
}

export class TaskCommandService implements TaskCommandPort {
  readonly #repository: TaskRepository;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #conversations: Pick<ConversationRepository, 'listMessages' | 'appendMessage'>;

  /**
   * Creates a command service with durable task transitions and terminal reply retention.
   */
  constructor(
    repository: TaskRepository,
    clock: Clock,
    ids: IdGenerator,
    conversations: Pick<ConversationRepository, 'listMessages' | 'appendMessage'>,
  ) {
    this.#repository = repository;
    this.#clock = clock;
    this.#ids = ids;
    this.#conversations = conversations;
  }

  /** Rejects creation boundaries while any durable task still owns the global run slot. */
  async #assertNoUnfinishedTask(): Promise<void> {
    if ((await this.#repository.listUnfinished()).length > 0) {
      throw new TaskCommandError('TASK_ALREADY_RUNNING', '已有任务运行中');
    }
  }

  /**
   * Creates a queued task and its sequence-zero checkpoint before exposing the task to scheduling.
   */
  async create(input: CreateTaskCommandInput): Promise<TaskSnapshot> {
    await this.#assertNoUnfinishedTask();
    const initialTask = createTask(input, {
      clock: this.#clock,
      ids: this.#ids,
    });
    const checkpointId = this.#createId('checkpoint');
    const task: TaskRun = { ...initialTask, checkpointId };
    const checkpoint: Checkpoint = {
      id: checkpointId,
      taskId: task.id,
      sequence: 0,
      taskStatus: 'queued',
      completedToolResults: [],
      continuationItems:
        input.userMessageId === undefined
          ? []
          : [
              {
                type: 'message_ref',
                messageId: this.#readMessageId(input.userMessageId),
              },
            ],
      pendingToolCall: null,
      browserToolCallsInAttempt: 0,
      browserTargetTabId: task.tabId,
      createdAt: task.createdAt,
    };

    await this.#repository.createInitial(task, checkpoint);
    return { task, checkpoint, events: [] };
  }

  /** Creates a fresh TaskRun while preserving the cancelled run's ordered WorkSession state. */
  async continueCancelled(input: ContinueCancelledTaskInput): Promise<TaskSnapshot> {
    await this.#assertNoUnfinishedTask();
    const source = await this.getSnapshot(input.sourceTaskId);
    if (source.task.status !== 'cancelled') {
      throw new TaskCommandError(
        'TASK_STATE_INVALID',
        'Only a cancelled task can start a WorkSession continuation.',
      );
    }

    const userMessageId = this.#readMessageId(input.userMessageId);
    const [messages, conversationTasks] = await Promise.all([
      this.#conversations.listMessages(source.task.conversationId),
      this.#repository.listByConversation(source.task.conversationId),
    ]);
    let continuationItems = [...source.checkpoint.continuationItems];
    if (!continuationItems.some((item) => item.type === 'message_ref')) {
      const sourceUserMessage = messages.find(
        (message) =>
          message.kind === 'conversation' &&
          message.taskId === source.task.id &&
          message.role === 'user' &&
          message.status === 'complete',
      );
      if (sourceUserMessage !== undefined) {
        continuationItems = [
          { type: 'message_ref' as const, messageId: sourceUserMessage.id },
          ...continuationItems,
        ];
      }
    }
    const referencedMessageIds = new Set(
      continuationItems.flatMap((item) => (item.type === 'message_ref' ? [item.messageId] : [])),
    );
    const workSessionTaskIds = new Set(
      conversationTasks
        .filter((task) => task.workSessionId === source.task.workSessionId)
        .map((task) => task.id),
    );
    const pendingSupplementItems = messages
      .filter(
        (message) =>
          message.kind === 'supplement' &&
          message.taskId !== null &&
          workSessionTaskIds.has(message.taskId) &&
          !referencedMessageIds.has(message.id),
      )
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.updatedAt - right.updatedAt ||
          left.id.localeCompare(right.id),
      )
      .map((message): ContinuationItem => ({
        type: 'message_ref',
        messageId: message.id,
      }));
    continuationItems = insertBeforePendingToolCall(
      continuationItems,
      source.checkpoint.pendingToolCall,
      [...pendingSupplementItems, { type: 'message_ref', messageId: userMessageId }],
    );

    const initialTask = createTask(
      {
        conversationId: source.task.conversationId,
        tabId: input.tabId,
        goal: input.goal,
        workSessionId: source.task.workSessionId,
      },
      { clock: this.#clock, ids: this.#ids },
    );
    const checkpointId = this.#createId('checkpoint');
    const task: TaskRun = { ...initialTask, checkpointId };
    const checkpoint: Checkpoint = {
      id: checkpointId,
      taskId: task.id,
      sequence: 0,
      taskStatus: 'queued',
      completedToolResults: source.checkpoint.completedToolResults.map((result) => ({ ...result })),
      continuationItems,
      pendingToolCall:
        source.checkpoint.pendingToolCall === null
          ? null
          : { ...source.checkpoint.pendingToolCall },
      browserToolCallsInAttempt: 0,
      browserTargetTabId: task.tabId,
      createdAt: task.createdAt,
    };

    await this.#repository.createContinuation(source.task.id, task, checkpoint);
    return { task, checkpoint, events: [] };
  }

  /**
   * Loads the durable task, current checkpoint, and ordered event history as one public snapshot.
   */
  async getSnapshot(taskId: TaskId): Promise<TaskSnapshot> {
    const task = await this.#repository.get(taskId);
    if (task === undefined) {
      throw new TaskCommandError('TASK_NOT_FOUND', 'Task does not exist.');
    }
    if (task.checkpointId === null) {
      throw new TaskCommandError('TASK_STATE_INVALID', 'Task has no recovery checkpoint.');
    }

    const [checkpoint, events] = await Promise.all([
      this.#repository.getCheckpoint(task.checkpointId),
      this.#repository.listEvents(task.id),
    ]);
    if (checkpoint === undefined) {
      throw new TaskCommandError('CHECKPOINT_NOT_FOUND', 'Task recovery checkpoint is missing.');
    }

    return { task, checkpoint, events };
  }

  /**
   * Persists a user-requested pause and makes repeated pause messages idempotent.
   */
  async pause(taskId: TaskId): Promise<TaskSnapshot> {
    const snapshot = await this.getSnapshot(taskId);
    if (snapshot.task.status === 'paused') {
      return snapshot;
    }
    return this.#saveTransition(snapshot, 'task.paused', 'user_pause');
  }

  /**
   * Returns a paused or waiting task to the queued scheduler boundary.
   */
  async resume(taskId: TaskId): Promise<TaskSnapshot> {
    const snapshot = await this.getSnapshot(taskId);
    if (snapshot.task.status === 'queued') {
      return snapshot;
    }
    return this.#saveTransition(snapshot, 'task.resumed', 'user_resume');
  }

  /** Requeues the same failed task without creating another persisted user message. */
  async retry(taskId: TaskId): Promise<TaskSnapshot> {
    const snapshot = await this.getSnapshot(taskId);
    if (snapshot.task.status === 'queued') {
      return snapshot;
    }
    return this.#saveTransition(
      snapshot,
      'task.retried',
      'user_retry',
      snapshot.checkpoint.continuationItems,
      0,
    );
  }

  /**
   * Persists terminal cancellation while treating a repeated cancellation as a no-op.
   */
  async cancel(taskId: TaskId): Promise<TaskSnapshot> {
    const snapshot = await this.getSnapshot(taskId);
    if (['completed', 'failed'].includes(snapshot.task.status)) {
      return snapshot;
    }
    let cancelled = snapshot;
    if (snapshot.task.status !== 'cancelled') {
      const messages = await this.#conversations.listMessages(snapshot.task.conversationId);
      const reply = messages.findLast(
        (message) =>
          message.kind === 'conversation' &&
          message.taskId === snapshot.task.id &&
          message.role === 'assistant' &&
          (message.status === 'complete' || message.status === 'interrupted') &&
          message.text.length > 0,
      );
      const continuationItems =
        reply === undefined ||
        snapshot.checkpoint.continuationItems.some(
          (item) => item.type === 'message_ref' && item.messageId === reply.id,
        )
          ? snapshot.checkpoint.continuationItems
          : insertBeforePendingToolCall(
              snapshot.checkpoint.continuationItems,
              snapshot.checkpoint.pendingToolCall,
              [{ type: 'message_ref', messageId: reply.id }],
            );
      cancelled = await this.#saveTransition(
        snapshot,
        'task.cancelled',
        'user_cancel',
        continuationItems,
      );
    }
    await retainTaskReply(cancelled.task, 'interrupted', {
      conversations: this.#conversations,
      ids: this.#ids,
    });
    return cancelled;
  }

  /**
   * Writes one command transition, event, and cloned checkpoint as one durable transaction.
   */
  async #saveTransition(
    snapshot: TaskSnapshot,
    type: TaskEventType,
    reason: string,
    continuationItems = snapshot.checkpoint.continuationItems,
    browserToolCallsInAttempt = snapshot.checkpoint.browserToolCallsInAttempt ?? 0,
  ): Promise<TaskSnapshot> {
    const latestEventSequence = snapshot.events.at(-1)?.sequence ?? 0;
    if (latestEventSequence !== snapshot.checkpoint.sequence) {
      throw new TaskCommandError(
        'TASK_STATE_INVALID',
        'Task event history and checkpoint are inconsistent.',
      );
    }

    const at = this.#clock.now();
    const checkpointId = this.#createId('checkpoint');
    const transitioned = transitionTask(snapshot.task, {
      type,
      at,
      reason,
    });
    const task: TaskRun = { ...transitioned, checkpointId, lease: null };
    const sequence = latestEventSequence + 1;
    const event: TaskEvent = {
      id: this.#createId('event'),
      taskId: task.id,
      sequence,
      type,
      reason,
      at,
      error: null,
    };
    const checkpoint: Checkpoint = {
      ...snapshot.checkpoint,
      id: checkpointId,
      sequence,
      taskStatus: task.status,
      continuationItems,
      browserToolCallsInAttempt,
      createdAt: at,
    };

    await this.#repository.saveTransition({ task, event, checkpoint });
    return { task, checkpoint, events: [...snapshot.events, event] };
  }

  /**
   * Requests a nonblank stable identifier from the injected generator.
   */
  #createId(prefix: string): string {
    const id = this.#ids.create(prefix).trim();
    if (id.length === 0) {
      throw new TaskCommandError('TASK_STATE_INVALID', 'Identifier generation failed.');
    }
    return id;
  }

  /** Validates one externally supplied durable message reference. */
  #readMessageId(value: MessageId): MessageId {
    const id = value.trim();
    if (id.length === 0) {
      throw new TaskCommandError('TASK_STATE_INVALID', 'User message identifier is required.');
    }
    return id;
  }
}
