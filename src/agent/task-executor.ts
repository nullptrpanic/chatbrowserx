import type { TaskRepository } from '../persistence/task-repository';
import { isProviderError, type ProviderError } from '../providers/provider-errors';
import type { IdGenerator, TaskId } from '../shared/ids';
import type { Clock } from '../shared/time';
import type { TaskSnapshot } from '../tasks/task-command-service';
import type { TaskError } from '../tasks/task-errors';
import { TaskLeaseManager } from '../tasks/task-lease';
import { transitionTask } from '../tasks/task-transition';
import type { TaskEvent, TaskEventType, TaskRun } from '../tasks/task-types';
import type { AgentEvent, AgentPlanner } from './execution-types';

export type TaskExecutorErrorCode =
  | 'TASK_NOT_FOUND'
  | 'CHECKPOINT_NOT_FOUND'
  | 'TASK_BUSY'
  | 'TASK_STATE_STALE'
  | 'PLANNER_RESULT_INVALID';

export class TaskExecutorError extends Error {
  readonly code: TaskExecutorErrorCode;

  constructor(code: TaskExecutorErrorCode, message: string) {
    super(message);
    this.name = 'TaskExecutorError';
    this.code = code;
  }
}

export interface TaskExecutorDependencies {
  readonly repository: TaskRepository;
  readonly planner: AgentPlanner;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

interface BoundaryInput {
  readonly type: TaskEventType;
  readonly reason: string;
  readonly error?: TaskError;
}

const runnableStatuses = new Set<TaskRun['status']>(['queued', 'planning']);

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Task execution was aborted.', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function invalidPlannerResultError(): TaskError {
  return {
    code: 'InvalidProviderResponse',
    retryable: false,
    recoveryAction: 'review_provider_status',
    userMessage: 'The provider returned an invalid response.',
    evidenceRef: null,
  };
}

function taskInputError(): TaskError {
  return {
    code: 'TaskInputError',
    retryable: false,
    recoveryAction: 'review_task_input',
    userMessage: 'Task input could not be prepared.',
    evidenceRef: null,
  };
}

function taskErrorFromProvider(error: ProviderError): TaskError {
  switch (error.code) {
    case 'AUTH':
      return {
        code: 'AuthError',
        retryable: false,
        recoveryAction: 'update_credentials',
        userMessage: 'Provider authentication is required.',
        evidenceRef: null,
      };
    case 'RATE_LIMIT':
      return {
        code: 'RateLimitError',
        retryable: true,
        recoveryAction: 'resume_later',
        userMessage: 'The provider rate limit was reached.',
        evidenceRef: null,
      };
    case 'TRANSIENT':
      return {
        code: 'TransientProviderError',
        retryable: true,
        recoveryAction: 'resume_task',
        userMessage: 'The provider is temporarily unavailable.',
        evidenceRef: null,
      };
    case 'INVALID_RESPONSE':
      return {
        code: 'InvalidProviderResponse',
        retryable: false,
        recoveryAction: 'review_provider_status',
        userMessage: 'The provider returned an invalid response.',
        evidenceRef: null,
      };
    case 'ABORTED':
      return {
        code: 'TaskInterrupted',
        retryable: true,
        recoveryAction: 'resume_task',
        userMessage: 'The task was interrupted.',
        evidenceRef: null,
      };
  }
}

/** Runs one durable text/image model turn without browser or search tool dependencies. */
export class TaskExecutor {
  readonly #dependencies: TaskExecutorDependencies;
  readonly #leases: TaskLeaseManager;

  constructor(dependencies: TaskExecutorDependencies) {
    this.#dependencies = dependencies;
    this.#leases = new TaskLeaseManager(dependencies.repository);
  }

  async run(taskId: TaskId, signal: AbortSignal): Promise<TaskSnapshot> {
    throwIfAborted(signal);
    const ownerId = this.#createId('runner');
    const acquired = await this.#leases.acquire(taskId, ownerId, this.#dependencies.clock.now());
    if (!acquired) throw new TaskExecutorError('TASK_BUSY', 'Task is already running.');

    try {
      let snapshot = await this.#loadSnapshot(taskId);
      if (!runnableStatuses.has(snapshot.task.status)) return snapshot;
      if (snapshot.task.status !== 'planning') {
        snapshot = await this.#saveBoundary(snapshot, ownerId, signal, {
          type: 'planning.started',
          reason: 'model_request_started',
        });
      }

      let result: AgentEvent | null = null;
      try {
        for await (const event of this.#dependencies.planner.plan(
          { task: snapshot.task, checkpoint: snapshot.checkpoint },
          signal,
        )) {
          throwIfAborted(signal);
          if (result !== null) {
            throw new TaskExecutorError(
              'PLANNER_RESULT_INVALID',
              'Planner returned more than one result.',
            );
          }
          result = event;
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error;
        if (error instanceof TaskExecutorError && error.code === 'PLANNER_RESULT_INVALID') {
          return this.#saveBoundary(snapshot, ownerId, signal, {
            type: 'task.failed',
            reason: 'invalid_planner_result',
            error: invalidPlannerResultError(),
          });
        }
        if (!isProviderError(error)) {
          return this.#saveBoundary(snapshot, ownerId, signal, {
            type: 'task.failed',
            reason: 'task_input_preparation_failed',
            error: taskInputError(),
          });
        }
        if (error.code === 'ABORTED') throw error;
        const taskError = taskErrorFromProvider(error);
        return this.#saveBoundary(snapshot, ownerId, signal, {
          type:
            error.code === 'AUTH'
              ? 'task.auth-required'
              : error.code === 'INVALID_RESPONSE'
                ? 'task.failed'
                : 'task.paused',
          reason:
            error.code === 'AUTH'
              ? 'provider_authentication_required'
              : error.code === 'INVALID_RESPONSE'
                ? 'invalid_provider_response'
                : 'provider_retry_exhausted',
          error: taskError,
        });
      }

      if (result === null) {
        return this.#saveBoundary(snapshot, ownerId, signal, {
          type: 'task.failed',
          reason: 'invalid_planner_result',
          error: invalidPlannerResultError(),
        });
      }
      return this.#saveBoundary(snapshot, ownerId, signal, {
        type: 'task.completed',
        reason: result.reason,
      });
    } finally {
      await this.#leases.release(taskId, ownerId);
    }
  }

  async #loadSnapshot(taskId: TaskId): Promise<TaskSnapshot> {
    const task = await this.#dependencies.repository.get(taskId);
    if (task === undefined) throw new TaskExecutorError('TASK_NOT_FOUND', 'Task does not exist.');
    if (task.checkpointId === null) {
      throw new TaskExecutorError('CHECKPOINT_NOT_FOUND', 'Task checkpoint is missing.');
    }
    const [checkpoint, events] = await Promise.all([
      this.#dependencies.repository.getCheckpoint(task.checkpointId),
      this.#dependencies.repository.listEvents(taskId),
    ]);
    if (checkpoint === undefined) {
      throw new TaskExecutorError('CHECKPOINT_NOT_FOUND', 'Task checkpoint is missing.');
    }
    return { task, checkpoint, events };
  }

  async #saveBoundary(
    snapshot: TaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    input: BoundaryInput,
  ): Promise<TaskSnapshot> {
    throwIfAborted(signal);
    const now = this.#dependencies.clock.now();
    const renewed = await this.#leases.renew(snapshot.task.id, ownerId, now);
    if (!renewed) throw new TaskExecutorError('TASK_BUSY', 'Task lease was lost.');
    const current = await this.#dependencies.repository.get(snapshot.task.id);
    if (current?.checkpointId !== snapshot.checkpoint.id) {
      throw new TaskExecutorError('TASK_STATE_STALE', 'Task changed during execution.');
    }

    const transitioned = transitionTask(
      { ...snapshot.task, lease: current.lease },
      {
        type: input.type,
        at: now,
        reason: input.reason,
        ...(input.error === undefined ? {} : { error: input.error }),
      },
    );
    const checkpointId = this.#createId('checkpoint');
    const task: TaskRun = { ...transitioned, checkpointId };
    const sequence = (snapshot.events.at(-1)?.sequence ?? 0) + 1;
    const event: TaskEvent = {
      id: this.#createId('event'),
      taskId: task.id,
      sequence,
      type: input.type,
      reason: input.reason,
      at: now,
      error: input.error ?? null,
    };
    const checkpoint = {
      ...snapshot.checkpoint,
      id: checkpointId,
      sequence,
      taskStatus: task.status,
      createdAt: now,
    };
    await this.#dependencies.repository.saveTransition({ task, event, checkpoint });
    return { task, checkpoint, events: [...snapshot.events, event] };
  }

  #createId(prefix: string): string {
    const id = this.#dependencies.ids.create(prefix).trim();
    if (id.length === 0) {
      throw new TaskExecutorError('TASK_STATE_STALE', 'Identifier generation failed.');
    }
    return id;
  }
}
