import type { TaskRepository } from '../persistence/task-repository';
import type { TaskId } from '../shared/ids';
import type { Clock } from '../shared/time';
import type { TaskStatus } from './task-types';

export interface RecoveryScannerDependencies {
  readonly repository: Pick<TaskRepository, 'listRecoverable'>;
  readonly clock: Clock;
  readonly startTask: (taskId: TaskId) => Promise<void>;
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
    const taskIds = new Set(
      tasks.filter((task) => automaticTaskStatuses.has(task.status)).map((task) => task.id),
    );
    await Promise.all([...taskIds].map((taskId) => this.#dependencies.startTask(taskId)));
  }
}
