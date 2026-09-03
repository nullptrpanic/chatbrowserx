import type { TaskRepository } from '../persistence/task-repository';
import type { TaskId, TaskRunId } from '../shared/ids';
import type { Clock } from '../shared/time';
import type { TaskStatus } from './task-types';

export interface RecoveryScannerDependencies {
  readonly repository: Pick<TaskRepository, 'listRecoverable'>;
  readonly clock: Clock;
  readonly startTask: (taskId: TaskId, runId: TaskRunId) => Promise<void>;
}

const automaticTaskStatuses = new Set<TaskStatus>(['queued', 'planning']);

export class RecoveryScanner {
  readonly #dependencies: RecoveryScannerDependencies;
  #activeRecoveryScan: Promise<void> | null = null;

  /**
   * Creates a scanner that discovers durable work but delegates actual execution to a scheduler.
   */
  constructor(dependencies: RecoveryScannerDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Coalesces concurrent ordinary wake-ups and schedules every unique safe task at most once.
   */
  requestRecoveryScan(): Promise<void> {
    if (this.#activeRecoveryScan !== null) {
      return this.#activeRecoveryScan;
    }

    const scan = this.#scanRecoverable().finally(() => {
      if (this.#activeRecoveryScan === scan) {
        this.#activeRecoveryScan = null;
      }
    });
    this.#activeRecoveryScan = scan;
    return scan;
  }

  /** Schedules expired-lease work after browser startup through the ordinary recovery path. */
  handleBrowserStartup(): Promise<void> {
    return this.requestRecoveryScan();
  }

  /**
   * Reads recoverable records at the injected time and schedules a deduplicated safe subset.
   */
  async #scanRecoverable(): Promise<void> {
    const tasks = await this.#dependencies.repository.listRecoverable(
      this.#dependencies.clock.now(),
    );
    const runsByTaskId = new Map<TaskId, TaskRunId>();
    for (const task of tasks) {
      if (automaticTaskStatuses.has(task.status) && task.latestRunId !== null) {
        runsByTaskId.set(task.id, task.latestRunId);
      }
    }
    await Promise.all(
      [...runsByTaskId].map(([taskId, runId]) => this.#dependencies.startTask(taskId, runId)),
    );
  }
}
