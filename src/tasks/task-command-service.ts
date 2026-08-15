import type { TaskRepository } from '../persistence/task-repository';
import type { IdGenerator, TaskId } from '../shared/ids';
import type { Clock } from '../shared/time';
import type { Checkpoint } from './checkpoint-types';
import { createTask, type CreateTaskInput } from './task-factory';
import { transitionTask } from './task-transition';
import type { TaskEvent, TaskEventType, TaskRun } from './task-types';

export type TaskCommandErrorCode = 'TASK_NOT_FOUND' | 'TASK_STATE_INVALID' | 'CHECKPOINT_NOT_FOUND';

export interface TaskSnapshot {
  readonly task: TaskRun;
  readonly checkpoint: Checkpoint;
  readonly events: readonly TaskEvent[];
}

export interface TaskCommandPort {
  create(input: CreateTaskInput): Promise<TaskSnapshot>;
  getSnapshot(taskId: TaskId): Promise<TaskSnapshot>;
  pause(taskId: TaskId): Promise<TaskSnapshot>;
  resume(taskId: TaskId, boundTabId?: number): Promise<TaskSnapshot>;
  confirm(taskId: TaskId, actionDigest: string): Promise<TaskSnapshot>;
  cancel(taskId: TaskId): Promise<TaskSnapshot>;
}

interface CommandTransitionOptions {
  readonly boundTabId?: number;
  readonly actionId?: string;
  readonly actionDigest?: string;
  readonly updateCheckpoint?: (checkpoint: Checkpoint, at: number) => Partial<Checkpoint>;
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

export class TaskCommandService implements TaskCommandPort {
  readonly #repository: TaskRepository;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;

  /**
   * Creates a command service whose state changes are persisted only through the task repository.
   */
  constructor(repository: TaskRepository, clock: Clock, ids: IdGenerator) {
    this.#repository = repository;
    this.#clock = clock;
    this.#ids = ids;
  }

  /**
   * Creates a queued task and its sequence-zero checkpoint before exposing the task to scheduling.
   */
  async create(input: CreateTaskInput): Promise<TaskSnapshot> {
    const initialTask = createTask(input, { clock: this.#clock, ids: this.#ids });
    const checkpointId = this.#createId('checkpoint');
    const task: TaskRun = { ...initialTask, checkpointId };
    const checkpoint: Checkpoint = {
      id: checkpointId,
      taskId: task.id,
      sequence: 0,
      taskStatus: 'queued',
      completedToolResults: [],
      observationRef: null,
      pendingAction: null,
      createdAt: task.createdAt,
    };

    await this.#repository.createInitial(task, checkpoint);
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
  async resume(taskId: TaskId, boundTabId?: number): Promise<TaskSnapshot> {
    const snapshot = await this.getSnapshot(taskId);
    if (snapshot.task.status === 'waiting_for_confirmation') {
      throw new TaskCommandError(
        'TASK_STATE_INVALID',
        'High-risk actions require an explicit digest-bound confirmation.',
      );
    }
    if (snapshot.task.status === 'waiting_for_tab' && boundTabId === undefined) {
      throw new TaskCommandError('TASK_STATE_INVALID', 'A replacement tab is required.');
    }
    if (snapshot.task.status !== 'waiting_for_tab' && boundTabId !== undefined) {
      throw new TaskCommandError(
        'TASK_STATE_INVALID',
        'A replacement tab can only be bound to a task waiting for its tab.',
      );
    }
    if (snapshot.task.status === 'queued') {
      return snapshot;
    }
    return this.#saveTransition(
      snapshot,
      'task.resumed',
      'user_resume',
      boundTabId === undefined ? undefined : { boundTabId },
    );
  }

  /** Persists consent for exactly the next attempt of one matching high-risk action digest. */
  async confirm(taskId: TaskId, actionDigest: string): Promise<TaskSnapshot> {
    const snapshot = await this.getSnapshot(taskId);
    const pending = snapshot.checkpoint.pendingAction;
    if (
      snapshot.task.status !== 'waiting_for_confirmation' ||
      pending === null ||
      pending.risk !== 'high' ||
      pending.outcome !== 'pending' ||
      actionDigest.trim() !== pending.digest
    ) {
      throw new TaskCommandError(
        'TASK_STATE_INVALID',
        'Action confirmation does not match the pending high-risk action.',
      );
    }
    return this.#saveTransition(snapshot, 'task.resumed', 'high_risk_action_confirmed', {
      actionId: pending.actionId,
      actionDigest: pending.digest,
      updateCheckpoint: (_checkpoint, at) => ({
        pendingAction: {
          ...pending,
          confirmation: {
            digest: pending.digest,
            forAttempt: pending.attemptCount + 1,
            confirmedAt: at,
          },
        },
      }),
    });
  }

  /**
   * Persists terminal cancellation while treating a repeated cancellation as a no-op.
   */
  async cancel(taskId: TaskId): Promise<TaskSnapshot> {
    const snapshot = await this.getSnapshot(taskId);
    if (snapshot.task.status === 'cancelled') {
      return snapshot;
    }
    return this.#saveTransition(snapshot, 'task.cancelled', 'user_cancel');
  }

  /**
   * Writes one command transition, event, and cloned checkpoint as one durable transaction.
   */
  async #saveTransition(
    snapshot: TaskSnapshot,
    type: TaskEventType,
    reason: string,
    options?: CommandTransitionOptions,
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
      ...(options?.boundTabId === undefined ? {} : { boundTabId: options.boundTabId }),
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
      ...(options?.actionId === undefined ? {} : { actionId: options.actionId }),
      ...(options?.actionDigest === undefined ? {} : { actionDigest: options.actionDigest }),
      ...(options?.boundTabId === undefined ? {} : { boundTabId: options.boundTabId }),
    };
    const checkpointUpdate = options?.updateCheckpoint?.(snapshot.checkpoint, at) ?? {};
    const checkpoint: Checkpoint = {
      ...snapshot.checkpoint,
      ...checkpointUpdate,
      id: checkpointId,
      sequence,
      taskStatus: task.status,
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
}
