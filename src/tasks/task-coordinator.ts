import type { TaskId, TaskRunId } from '../shared/ids';
import { TaskCommandError, type TaskSnapshot } from './task-command-service';

export interface CoordinatedTaskExecutor {
  run(taskId: TaskId, signal: AbortSignal, expectedRunId?: TaskRunId): Promise<unknown>;
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
  readonly abortJoinTimeoutMs?: number;
}

interface ActiveTask {
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  readonly runId?: TaskRunId | undefined;
}

export class TaskCoordinator {
  readonly #dependencies: TaskCoordinatorDependencies;
  readonly #active = new Map<TaskId, ActiveTask>();
  readonly #scheduled = new Set<string>();
  #scheduleTail: Promise<void> = Promise.resolve();
  #disposed = false;

  /** Creates a per-task scheduler that owns abort signals but no durable task state. */
  constructor(dependencies: TaskCoordinatorDependencies) {
    this.#dependencies = dependencies;
  }

  /** Starts one task once and returns the same completion while it remains active. */
  start(taskId: TaskId, runId?: TaskRunId): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(new TaskCommandError('TASK_STATE_INVALID', '任务执行器已关闭'));
    }
    const existing = this.#active.get(taskId);
    if (existing !== undefined) return existing.completion;
    if (this.#active.size > 0) {
      return Promise.reject(new TaskCommandError('TASK_ALREADY_RUNNING', '已有任务运行中'));
    }

    const controller = new AbortController();
    const execution = this.#dependencies.executor.run(taskId, controller.signal, runId);
    const completion = execution
      .then(() => undefined)
      .finally(() => {
        if (this.#active.get(taskId)?.completion === completion) this.#active.delete(taskId);
      });
    this.#active.set(taskId, {
      controller,
      completion,
      ...(runId === undefined ? {} : { runId }),
    });
    return completion;
  }

  /** Stops active work before persisting a user pause boundary. */
  async pause(taskId: TaskId): Promise<TaskSnapshot> {
    await this.#stopBounded(taskId);
    return this.#dependencies.commands.pause(taskId);
  }

  /** Persists a resume boundary, schedules fresh work, and returns without awaiting the run. */
  async resume(taskId: TaskId): Promise<TaskSnapshot> {
    this.#assertOpen();
    this.#assertAvailable(taskId);
    await this.#stop(taskId);
    const snapshot = await this.#dependencies.commands.resume(taskId);
    this.schedule(taskId, snapshot.run.id);
    return snapshot;
  }

  /** Stops any stale runner, persists a retry boundary, and schedules the same task ID again. */
  async retry(taskId: TaskId): Promise<TaskSnapshot> {
    this.#assertOpen();
    this.#assertAvailable(taskId);
    await this.#stop(taskId);
    const snapshot = await this.#dependencies.commands.retry(taskId);
    this.schedule(taskId, snapshot.run.id);
    return snapshot;
  }

  /** Stops active work before persisting terminal cancellation. */
  async cancel(taskId: TaskId): Promise<TaskSnapshot> {
    await this.#stop(taskId);
    return this.#dependencies.commands.cancel(taskId);
  }

  /** Starts one detached run and reports terminal scheduler failure through a safe boundary. */
  schedule(taskId: TaskId, runId: TaskRunId): void {
    const scheduleKey = `${taskId}\u0000${runId}`;
    if (this.#scheduled.has(scheduleKey)) return;
    this.#scheduled.add(scheduleKey);
    const scheduled = this.#scheduleTail.then(() => this.#runScheduled(taskId, runId));
    this.#scheduleTail = scheduled.catch(() => undefined);
    void scheduled
      .catch((error: unknown) => {
        this.#dependencies.onExecutionError?.(taskId, error);
      })
      .finally(() => this.#scheduled.delete(scheduleKey));
  }

  /** Prevents new work, aborts every active runner, and waits for all executions to settle. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    const active = [...this.#active.values()];
    for (const task of active) task.controller.abort();
    await Promise.all(active.map(({ completion }) => completion.catch(() => undefined)));
  }

  /** Aborts and joins one active runner while treating its abort rejection as already handled. */
  async #stop(taskId: TaskId): Promise<void> {
    const active = this.#active.get(taskId);
    if (active === undefined) return;
    active.controller.abort();
    await active.completion.catch(() => undefined);
  }

  /** Gives an aborted runner a bounded chance to finish its current durable boundary. */
  async #stopBounded(taskId: TaskId): Promise<void> {
    const active = this.#active.get(taskId);
    if (active === undefined) return;
    active.controller.abort();
    const timeoutMs = this.#dependencies.abortJoinTimeoutMs ?? 250;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    try {
      await Promise.race([
        active.completion.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = globalThis.setTimeout(resolve, Math.max(0, timeoutMs));
        }),
      ]);
    } finally {
      if (timer !== undefined) globalThis.clearTimeout(timer);
    }
  }

  /** Serializes detached starts so a just-finished runner cannot strand a persisted task. */
  async #runScheduled(taskId: TaskId, runId: TaskRunId): Promise<void> {
    while (!this.#disposed) {
      const activeTask = this.#active.values().next().value as ActiveTask | undefined;
      if (activeTask !== undefined) {
        if (activeTask.runId === runId) {
          await activeTask.completion;
          return;
        }
        await activeTask.completion.catch(() => undefined);
        continue;
      }
      await this.start(taskId, runId);
      return;
    }
  }

  /** Preserves the single global executor slot while allowing same-task restarts. */
  #assertAvailable(taskId: TaskId): void {
    if ([...this.#active.keys()].some((activeTaskId) => activeTaskId !== taskId)) {
      throw new TaskCommandError('TASK_ALREADY_RUNNING', '已有任务运行中');
    }
  }

  /** Rejects state-changing restarts after the coordinator begins terminal disposal. */
  #assertOpen(): void {
    if (this.#disposed) {
      throw new TaskCommandError('TASK_STATE_INVALID', '任务执行器已关闭');
    }
  }
}
