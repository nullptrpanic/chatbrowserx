import type { ConversationRepository } from '../persistence/conversation-repository';
import {
  TaskRepositoryBusyError,
  TaskRepositoryConflictError,
  type TaskRepository,
} from '../persistence/task-repository';
import type { IdGenerator, MessageId, TaskId } from '../shared/ids';
import type { Clock } from '../shared/time';
import type { Checkpoint } from './checkpoint-types';
import type { Conversation } from './conversation-types';
import type { ContinuationItem, PendingToolCall } from './continuation-types';
import type { MessageRecord, TaskMessageDraft } from './message-types';
import { createTaskRecords, createTaskRun, type CreateTaskInput } from './task-factory';
import { retainTaskReply } from './task-reply-retention';
import { orderTaskMessagesByEvent } from './task-message-order';
import { transitionTask, type TaskTransitionType } from './task-transition';
import type { Task, TaskEvent, TaskRun } from './task-types';
import type { MaterializedToolResult } from './tool-result-types';
import { selectPendingTaskSupplements } from './task-supplements';

export type TaskCommandErrorCode =
  'TASK_NOT_FOUND' | 'TASK_STATE_INVALID' | 'CHECKPOINT_NOT_FOUND' | 'TASK_ALREADY_RUNNING';

export interface TaskSnapshot {
  readonly task: Task;
  readonly run: TaskRun;
  readonly checkpoint: Checkpoint | null;
  readonly events: readonly TaskEvent[];
  readonly toolResults: readonly MaterializedToolResult[];
}

interface ContinuationSnapshotInput {
  readonly sourceTaskId: TaskId;
  readonly tabId: number;
  readonly userMessageId: MessageId;
}

export interface CreateTaskSubmissionInput extends CreateTaskInput {
  readonly conversation: Conversation;
  readonly createConversation: boolean;
  readonly message: TaskMessageDraft;
}

export interface ContinueTaskSubmissionInput {
  readonly sourceTaskId: TaskId;
  readonly tabId: number;
  readonly conversation: Conversation;
  readonly message: TaskMessageDraft;
}

export interface TaskCommandPort {
  getSnapshot(taskId: TaskId): Promise<TaskSnapshot>;
  pause(taskId: TaskId): Promise<TaskSnapshot>;
  resume(taskId: TaskId): Promise<TaskSnapshot>;
  retry(taskId: TaskId): Promise<TaskSnapshot>;
  cancel(taskId: TaskId): Promise<TaskSnapshot>;
  clearContext(taskId: TaskId): Promise<TaskSnapshot>;
}

export interface TaskSubmissionPort {
  createSubmission(input: CreateTaskSubmissionInput): Promise<TaskSnapshot>;
  continueSubmission(input: ContinueTaskSubmissionInput): Promise<TaskSnapshot>;
  appendSupplement(message: MessageRecord): Promise<void>;
}

export class TaskCommandError extends Error {
  readonly code: TaskCommandErrorCode;

  constructor(code: TaskCommandErrorCode, message: string) {
    super(message);
    this.name = 'TaskCommandError';
    this.code = code;
  }
}

/** Inserts user input before an unresolved call so the call/output pair remains adjacent. */
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

export class TaskCommandService implements TaskCommandPort, TaskSubmissionPort {
  readonly #repository: TaskRepository;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #conversations: Pick<ConversationRepository, 'listMessages'>;

  constructor(
    repository: TaskRepository,
    clock: Clock,
    ids: IdGenerator,
    conversations: Pick<ConversationRepository, 'listMessages'>,
  ) {
    this.#repository = repository;
    this.#clock = clock;
    this.#ids = ids;
    this.#conversations = conversations;
  }

  async createSubmission(input: CreateTaskSubmissionInput): Promise<TaskSnapshot> {
    if (
      input.message.conversationId !== input.conversation.id ||
      input.conversation.id !== input.conversationId
    ) {
      throw new TaskCommandError(
        'TASK_STATE_INVALID',
        'Submission conversation records do not match.',
      );
    }
    const snapshot = await this.#createSubmissionSnapshot(input, input.message.id);
    if (snapshot.events[0]?.type !== 'message.recorded') {
      throw new TaskCommandError('TASK_STATE_INVALID', 'Initial message event is missing.');
    }
    const storedTask = await this.#mapBusyError(() =>
      this.#repository.createSubmission({
        conversation: input.conversation,
        createConversation: input.createConversation,
        message: { ...input.message, taskId: snapshot.task.id },
        task: snapshot.task,
        run: snapshot.run,
        events: snapshot.events,
        checkpoint: this.#requiredCheckpoint(snapshot),
      }),
    );
    return { ...snapshot, task: storedTask };
  }

  async appendSupplement(message: MessageRecord): Promise<void> {
    if (message.kind !== 'supplement') {
      throw new TaskCommandError('TASK_STATE_INVALID', 'Supplement message is invalid.');
    }
    const now = this.#clock.now();
    await this.#repository.appendTaskMessage({
      message,
      eventId: this.#createId('event'),
      at: now,
    });
  }

  async #createSubmissionSnapshot(
    input: CreateTaskInput,
    userMessageId: MessageId,
  ): Promise<TaskSnapshot> {
    const records = createTaskRecords(input, { clock: this.#clock, ids: this.#ids });
    const checkpointId = this.#createId('checkpoint');
    const run: TaskRun = { ...records.run, checkpointId };
    const sequence = 2;
    const task: Task = {
      ...records.task,
      latestRunId: run.id,
      lastEventSequence: sequence,
    };
    const checkpoint: Checkpoint = {
      id: checkpointId,
      taskId: task.id,
      runId: run.id,
      continuationItems: [{ type: 'message_ref', messageId: this.#readMessageId(userMessageId) }],
      pendingToolCall: null,
      browserToolCallsInAttempt: 0,
      browserTargetTabId: task.tabId,
      createdAt: run.startedAt,
    };
    const events: TaskEvent[] = [
      {
        id: this.#createId('event'),
        taskId: task.id,
        runId: run.id,
        sequence: 1,
        type: 'message.recorded',
        messageId: this.#readMessageId(userMessageId),
        at: task.createdAt,
      },
    ];
    events.push({
      id: this.#createId('event'),
      taskId: task.id,
      runId: run.id,
      sequence,
      type: 'status.changed',
      taskStatus: 'queued',
      runStatus: 'queued',
      reason: 'task.queued',
      error: null,
      at: task.createdAt,
    });
    return { task, run, checkpoint, events, toolResults: [] };
  }

  /** Stores a new user message while keeping the same recoverable logical task. */
  async continueSubmission(input: ContinueTaskSubmissionInput): Promise<TaskSnapshot> {
    if (input.message.conversationId !== input.conversation.id) {
      throw new TaskCommandError(
        'TASK_STATE_INVALID',
        'Continuation conversation records do not match.',
      );
    }
    const snapshot = await this.#createContinuationSnapshot({
      sourceTaskId: input.sourceTaskId,
      tabId: input.tabId,
      userMessageId: input.message.id,
    });
    const newEvents = snapshot.events.filter((event) => event.runId === snapshot.run.id);
    if (newEvents.at(-2)?.type !== 'message.recorded') {
      throw new TaskCommandError('TASK_STATE_INVALID', 'Continuation message event is missing.');
    }
    const storedTask = await this.#mapBusyError(() =>
      this.#repository.createSubmission({
        conversation: input.conversation,
        createConversation: false,
        message: { ...input.message, taskId: snapshot.task.id },
        task: snapshot.task,
        run: snapshot.run,
        events: newEvents,
        checkpoint: this.#requiredCheckpoint(snapshot),
        continuationSourceTaskId: input.sourceTaskId,
      }),
    );
    return { ...snapshot, task: storedTask };
  }

  async #createContinuationSnapshot(input: ContinuationSnapshotInput): Promise<TaskSnapshot> {
    const source = await this.getSnapshot(input.sourceTaskId);
    const recoverableStatus =
      source.task.status === source.run.status &&
      (source.task.status === 'cancelled' || source.task.status === 'failed');
    if (!recoverableStatus) {
      throw new TaskCommandError(
        'TASK_STATE_INVALID',
        'Only a failed or cancelled task can start another execution attempt.',
      );
    }
    if (source.events.some((event) => event.type === 'context.cleared')) {
      throw new TaskCommandError(
        'TASK_STATE_INVALID',
        'Cleared task context cannot start another execution attempt.',
      );
    }
    const sourceCheckpoint = this.#requiredCheckpoint(source);
    const userMessageId = this.#readMessageId(input.userMessageId);
    const messages = await this.#conversations.listMessages(source.task.conversationId);
    let continuationItems = [...sourceCheckpoint.continuationItems];
    const pendingSupplements = selectPendingTaskSupplements(
      messages,
      source.events,
      source.task.id,
    );
    continuationItems = insertBeforePendingToolCall(
      continuationItems,
      sourceCheckpoint.pendingToolCall,
      [
        ...pendingSupplements.map((message): ContinuationItem => ({
          type: 'message_ref',
          messageId: message.id,
        })),
        { type: 'message_ref', messageId: userMessageId },
      ],
    );

    const run = createTaskRun(source.task, source.run.attempt + 1, {
      clock: this.#clock,
      ids: this.#ids,
    });
    const checkpointId = this.#createId('checkpoint');
    const currentRun: TaskRun = { ...run, checkpointId };
    let sequence = source.task.lastEventSequence;
    const appliedEvents: TaskEvent[] = pendingSupplements.map((message) => ({
      id: this.#createId('event'),
      taskId: source.task.id,
      runId: currentRun.id,
      sequence: (sequence += 1),
      type: 'supplement.applied',
      messageId: message.id,
      at: currentRun.startedAt,
    }));
    const messageSequence = (sequence += 1);
    const statusSequence = messageSequence + 1;
    const task: Task = {
      ...source.task,
      tabId: input.tabId,
      status: 'queued',
      latestRunId: currentRun.id,
      lastEventSequence: statusSequence,
      updatedAt: currentRun.startedAt,
    };
    const checkpoint: Checkpoint = {
      ...sourceCheckpoint,
      id: checkpointId,
      taskId: task.id,
      runId: currentRun.id,
      continuationItems,
      browserToolCallsInAttempt: 0,
      browserTargetTabId: input.tabId,
      createdAt: currentRun.startedAt,
    };
    const newEvents: TaskEvent[] = [
      ...appliedEvents,
      {
        id: this.#createId('event'),
        taskId: task.id,
        runId: currentRun.id,
        sequence: messageSequence,
        type: 'message.recorded',
        messageId: userMessageId,
        at: currentRun.startedAt,
      },
      {
        id: this.#createId('event'),
        taskId: task.id,
        runId: currentRun.id,
        sequence: statusSequence,
        type: 'status.changed',
        taskStatus: 'queued',
        runStatus: 'queued',
        reason: 'task.queued',
        error: null,
        at: currentRun.startedAt,
      },
    ];
    return {
      task,
      run: currentRun,
      checkpoint,
      events: [...source.events, ...newEvents],
      toolResults: source.toolResults,
    };
  }

  async #mapBusyError<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof TaskRepositoryBusyError) {
        throw new TaskCommandError('TASK_ALREADY_RUNNING', '已有任务运行中');
      }
      throw error;
    }
  }

  async getSnapshot(taskId: TaskId): Promise<TaskSnapshot> {
    const snapshot = await this.#repository.readActiveRuntimeSnapshot(taskId);
    if (snapshot === undefined) {
      throw new TaskCommandError('TASK_NOT_FOUND', 'Task does not exist.');
    }
    if (snapshot.run.checkpointId !== null && snapshot.checkpoint === undefined) {
      throw new TaskCommandError('CHECKPOINT_NOT_FOUND', 'Task recovery checkpoint is missing.');
    }
    return {
      task: snapshot.task,
      run: snapshot.run,
      checkpoint: snapshot.checkpoint ?? null,
      events: snapshot.events,
      toolResults: snapshot.toolResults,
    };
  }

  async pause(taskId: TaskId): Promise<TaskSnapshot> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = await this.getSnapshot(taskId);
      if (
        snapshot.task.status === 'paused' ||
        snapshot.task.status === 'completed' ||
        snapshot.task.status === 'failed' ||
        snapshot.task.status === 'cancelled'
      ) {
        return snapshot;
      }
      try {
        return await this.#saveStatusTransition(snapshot, 'task.paused', 'user_pause');
      } catch (error) {
        if (!(error instanceof TaskRepositoryConflictError) || error.code !== 'STALE_BOUNDARY') {
          throw error;
        }
      }
    }
    throw new TaskCommandError('TASK_STATE_INVALID', 'Task changed while pause was being applied.');
  }

  async resume(taskId: TaskId): Promise<TaskSnapshot> {
    const snapshot = await this.getSnapshot(taskId);
    if (snapshot.task.status === 'queued') return snapshot;
    if (!['paused', 'waiting_for_auth'].includes(snapshot.task.status)) {
      throw new TaskCommandError('TASK_STATE_INVALID', 'Only a paused task can resume.');
    }
    return this.#startRun(snapshot, 'user_resume');
  }

  async retry(taskId: TaskId): Promise<TaskSnapshot> {
    const snapshot = await this.getSnapshot(taskId);
    if (snapshot.task.status === 'queued') return snapshot;
    if (snapshot.task.status !== 'failed') {
      throw new TaskCommandError('TASK_STATE_INVALID', 'Only a failed task can retry.');
    }
    return this.#startRun(snapshot, 'user_retry');
  }

  async #startRun(snapshot: TaskSnapshot, reason: string): Promise<TaskSnapshot> {
    const previousCheckpoint = this.#requiredCheckpoint(snapshot);
    const run = createTaskRun(snapshot.task, snapshot.run.attempt + 1, {
      clock: this.#clock,
      ids: this.#ids,
    });
    const checkpointId = this.#createId('checkpoint');
    const currentRun: TaskRun = { ...run, checkpointId };
    const sequence = snapshot.task.lastEventSequence + 1;
    const task: Task = {
      ...snapshot.task,
      status: 'queued',
      latestRunId: currentRun.id,
      lastEventSequence: sequence,
      updatedAt: currentRun.startedAt,
    };
    const checkpoint: Checkpoint = {
      ...previousCheckpoint,
      id: checkpointId,
      runId: currentRun.id,
      pendingToolCall:
        previousCheckpoint.pendingToolCall === null
          ? null
          : { ...previousCheckpoint.pendingToolCall },
      browserToolCallsInAttempt: 0,
      createdAt: currentRun.startedAt,
    };
    const event: TaskEvent = {
      id: this.#createId('event'),
      taskId: task.id,
      runId: currentRun.id,
      sequence,
      type: 'status.changed',
      taskStatus: 'queued',
      runStatus: 'queued',
      reason,
      error: null,
      at: currentRun.startedAt,
    };
    await this.#mapBusyError(() => this.#repository.startRun(task, currentRun, event, checkpoint));
    return {
      task,
      run: currentRun,
      checkpoint,
      events: [...snapshot.events, event],
      toolResults: snapshot.toolResults,
    };
  }

  async cancel(taskId: TaskId): Promise<TaskSnapshot> {
    const snapshot = await this.getSnapshot(taskId);
    if (['completed', 'failed'].includes(snapshot.task.status)) return snapshot;
    let cancelled = snapshot;
    if (snapshot.task.status !== 'cancelled') {
      const checkpoint = this.#requiredCheckpoint(snapshot);
      const messages = await this.#conversations.listMessages(snapshot.task.conversationId);
      const reply = orderTaskMessagesByEvent(
        messages,
        snapshot.events,
        snapshot.task.id,
        'conversation',
      ).findLast(
        (message) =>
          message.kind === 'conversation' &&
          message.role === 'assistant' &&
          (message.status === 'complete' || message.status === 'interrupted') &&
          message.text.length > 0,
      );
      const continuationItems =
        reply === undefined ||
        checkpoint.continuationItems.some(
          (item) => item.type === 'message_ref' && item.messageId === reply.id,
        )
          ? checkpoint.continuationItems
          : insertBeforePendingToolCall(checkpoint.continuationItems, checkpoint.pendingToolCall, [
              { type: 'message_ref', messageId: reply.id },
            ]);
      cancelled = await this.#saveStatusTransition(
        snapshot,
        'task.cancelled',
        'user_cancel',
        continuationItems,
      );
    }
    await retainTaskReply(cancelled.task, 'interrupted', {
      conversations: this.#conversations,
      repository: this.#repository,
      ids: this.#ids,
    });
    return this.getSnapshot(cancelled.task.id);
  }

  async clearContext(taskId: TaskId): Promise<TaskSnapshot> {
    const snapshot = await this.getSnapshot(taskId);
    if (snapshot.task.status !== 'cancelled') {
      throw new TaskCommandError(
        'TASK_STATE_INVALID',
        'Only a cancelled task can clear its continuation context.',
      );
    }
    if (snapshot.events.some((event) => event.type === 'context.cleared')) return snapshot;
    return this.#saveStatusTransition(
      snapshot,
      'task.context-cleared',
      'user_clear_task_context',
      [],
      true,
    );
  }

  async #saveStatusTransition(
    snapshot: TaskSnapshot,
    type: TaskTransitionType,
    reason: string,
    continuationItems?: readonly ContinuationItem[],
    clearCheckpoint = false,
  ): Promise<TaskSnapshot> {
    const checkpoint = this.#requiredCheckpoint(snapshot);
    const at = this.#clock.now();
    const transitioned = transitionTask(snapshot.task, snapshot.run, { type, at, reason });
    const sequence = snapshot.task.lastEventSequence + 1;
    const task: Task = { ...transitioned.task, lastEventSequence: sequence };
    const event: TaskEvent =
      type === 'task.context-cleared'
        ? {
            id: this.#createId('event'),
            taskId: task.id,
            runId: transitioned.run.id,
            sequence,
            type: 'context.cleared',
            at,
          }
        : {
            id: this.#createId('event'),
            taskId: task.id,
            runId: transitioned.run.id,
            sequence,
            type: 'status.changed',
            taskStatus: transitioned.task.status,
            runStatus: transitioned.run.status,
            reason,
            error: transitioned.run.error,
            at,
          };
    const nextCheckpoint: Checkpoint | null = clearCheckpoint
      ? null
      : {
          ...checkpoint,
          continuationItems: continuationItems ?? checkpoint.continuationItems,
        };
    const run: TaskRun = {
      ...transitioned.run,
      checkpointId: nextCheckpoint?.id ?? null,
    };
    await this.#repository.saveTransition({
      task,
      run,
      events: [event],
      checkpoint: nextCheckpoint,
    });
    return {
      task,
      run,
      checkpoint: nextCheckpoint,
      events: [...snapshot.events, event],
      toolResults: snapshot.toolResults,
    };
  }

  #requiredCheckpoint(snapshot: TaskSnapshot): Checkpoint {
    if (snapshot.checkpoint === null) {
      throw new TaskCommandError('CHECKPOINT_NOT_FOUND', 'Task recovery checkpoint is missing.');
    }
    return snapshot.checkpoint;
  }

  #createId(prefix: string): string {
    const id = this.#ids.create(prefix).trim();
    if (id.length === 0) {
      throw new TaskCommandError('TASK_STATE_INVALID', 'Identifier generation failed.');
    }
    return id;
  }

  #readMessageId(value: MessageId): MessageId {
    const id = value.trim();
    if (id.length === 0) {
      throw new TaskCommandError('TASK_STATE_INVALID', 'User message identifier is required.');
    }
    return id;
  }
}
