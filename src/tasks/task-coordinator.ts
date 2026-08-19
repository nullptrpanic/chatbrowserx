import type { TaskId } from '../shared/ids';
import { TaskCommandError, type TaskSnapshot } from './task-command-service';

export interface CoordinatedTaskExecutor {
  run(taskId: TaskId, signal: AbortSignal): Promise<unknown>;
}

export interface CoordinatedTaskCommands {
  pause(taskId: TaskId): Promise<TaskSnapshot>;
  resume(taskId: TaskId): Promise<TaskSnapshot>;
  retry(taskId: TaskId): Promise<TaskSnapshot>;
  cancel(taskId: TaskId): Promise<TaskSnapshot>;
}

export interface TaskCoordinatorDependencies {
  readonly executor: CoordinatedTaskExecutor;
  readonly commands: CoordinatedTaskCommands;
  readonly onExecutionError?: (taskId: TaskId, error: unknown) => void;
}

interface ActiveTask {
  readonly controller: AbortController;
  readonly completion: Promise<void>;
}

export class TaskCoordinator {
  readonly #dependencies: TaskCoordinatorDependencies;
  readonly #active = new Map<TaskId, ActiveTask>();

  /** Creates a per-task scheduler that owns abort signals but no durable task state. */
  constructor(dependencies: TaskCoordinatorDependencies) {
    this.#dependencies = dependencies;
  }

  /** Starts one task once and returns the same completion while it remains active. */
  start(taskId: TaskId): Promise<void> {
    const existing = this.#active.get(taskId);
    if (existing !== undefined) return existing.completion;
    if (this.#active.size > 0) {
      return Promise.reject(new TaskCommandError('TASK_ALREADY_RUNNING', '已有任务运行中'));
    }

    const controller = new AbortController();
    const execution = this.#dependencies.executor.run(taskId, controller.signal);
    const completion = execution
      .then(() => undefined)
      .finally(() => {
        if (this.#active.get(taskId)?.completion === completion) this.#active.delete(taskId);
      });
    this.#active.set(taskId, { controller, completion });
    return completion;
  }

  /** Stops active work before persisting a user pause boundary. */
  async pause(taskId: TaskId): Promise<TaskSnapshot> {
    this.#abort(taskId);
    return this.#dependencies.commands.pause(taskId);
  }

  /** Persists a resume boundary, schedules fresh work, and returns without awaiting the run. */
  async resume(taskId: TaskId): Promise<TaskSnapshot> {
    this.#assertAvailable(taskId);
    await this.#stop(taskId);
    const snapshot = await this.#dependencies.commands.resume(taskId);
    this.#schedule(taskId);
    return snapshot;
  }

  /** Stops any stale runner, persists a retry boundary, and schedules the same task ID again. */
  async retry(taskId: TaskId): Promise<TaskSnapshot> {
    this.#assertAvailable(taskId);
    await this.#stop(taskId);
    const snapshot = await this.#dependencies.commands.retry(taskId);
    this.#schedule(taskId);
    return snapshot;
  }

  /** Stops active work before persisting terminal cancellation. */
  async cancel(taskId: TaskId): Promise<TaskSnapshot> {
    await this.#stop(taskId);
    return this.#dependencies.commands.cancel(taskId);
  }

  /** Aborts and joins one active runner while treating its abort rejection as already handled. */
  async #stop(taskId: TaskId): Promise<void> {
    const active = this.#active.get(taskId);
    if (active === undefined) return;
    active.controller.abort();
    await active.completion.catch(() => undefined);
  }

  /** Signals one runner without delaying the durable pause or cancellation command. */
  #abort(taskId: TaskId): void {
    this.#active.get(taskId)?.controller.abort();
  }

  /** Preserves the single global executor slot while allowing same-task restarts. */
  #assertAvailable(taskId: TaskId): void {
    if ([...this.#active.keys()].some((activeTaskId) => activeTaskId !== taskId)) {
      throw new TaskCommandError('TASK_ALREADY_RUNNING', '已有任务运行中');
    }
  }

  /** Starts one detached run and reports any terminal scheduler failure through a safe boundary. */
  #schedule(taskId: TaskId): void {
    void this.start(taskId).catch((error: unknown) => {
      this.#dependencies.onExecutionError?.(taskId, error);
    });
  }
}
