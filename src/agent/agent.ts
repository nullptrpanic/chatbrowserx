import type { TaskId } from '../shared/ids';
import type { MessageRecord } from '../tasks/message-types';
import type { RecoveryScanner } from '../tasks/recovery-scanner';
import type {
  ContinueCancelledTaskSubmissionInput,
  CreateTaskSubmissionInput,
  TaskCommandPort,
  TaskSnapshot,
  TaskSubmissionPort,
} from '../tasks/task-command-service';
import type { TaskCoordinator } from '../tasks/task-coordinator';

export type AgentStartInput =
  | { readonly kind: 'create'; readonly submission: CreateTaskSubmissionInput }
  | { readonly kind: 'continue'; readonly submission: ContinueCancelledTaskSubmissionInput };

/** Public task lifecycle boundary used by every production adapter outside Agent composition. */
export interface Agent {
  start(input: AgentStartInput): Promise<TaskSnapshot>;
  supplement(message: MessageRecord): Promise<void>;
  getSnapshot(taskId: TaskId): Promise<TaskSnapshot>;
  pause(taskId: TaskId): Promise<TaskSnapshot>;
  resume(taskId: TaskId): Promise<TaskSnapshot>;
  retry(taskId: TaskId): Promise<TaskSnapshot>;
  cancel(taskId: TaskId): Promise<TaskSnapshot>;
  clearContext(taskId: TaskId): Promise<TaskSnapshot>;
  recover(): Promise<void>;
  handleBrowserStartup(): Promise<void>;
  dispose(): Promise<void>;
}

export interface AgentFacadeDependencies {
  readonly submissions: TaskSubmissionPort;
  readonly commands: Pick<TaskCommandPort, 'getSnapshot' | 'clearContext'>;
  readonly coordinator: Pick<
    TaskCoordinator,
    'schedule' | 'pause' | 'resume' | 'retry' | 'cancel' | 'dispose'
  >;
  readonly recovery: Pick<RecoveryScanner, 'requestRecoveryScan' | 'handleBrowserStartup'>;
}

/** Keeps persistence, scheduling, recovery, and cancellation behind one stable task API. */
export class AgentFacade implements Agent {
  readonly #dependencies: AgentFacadeDependencies;

  constructor(dependencies: AgentFacadeDependencies) {
    this.#dependencies = dependencies;
  }

  /** Persists the complete submission before starting detached execution. */
  async start(input: AgentStartInput): Promise<TaskSnapshot> {
    const snapshot =
      input.kind === 'create'
        ? await this.#dependencies.submissions.createSubmission(input.submission)
        : await this.#dependencies.submissions.continueCancelledSubmission(input.submission);
    this.#dependencies.coordinator.schedule(snapshot.task.id);
    return snapshot;
  }

  supplement(message: MessageRecord): Promise<void> {
    return this.#dependencies.submissions.appendSupplement(message);
  }

  getSnapshot(taskId: TaskId): Promise<TaskSnapshot> {
    return this.#dependencies.commands.getSnapshot(taskId);
  }

  pause(taskId: TaskId): Promise<TaskSnapshot> {
    return this.#dependencies.coordinator.pause(taskId);
  }

  resume(taskId: TaskId): Promise<TaskSnapshot> {
    return this.#dependencies.coordinator.resume(taskId);
  }

  retry(taskId: TaskId): Promise<TaskSnapshot> {
    return this.#dependencies.coordinator.retry(taskId);
  }

  cancel(taskId: TaskId): Promise<TaskSnapshot> {
    return this.#dependencies.coordinator.cancel(taskId);
  }

  clearContext(taskId: TaskId): Promise<TaskSnapshot> {
    return this.#dependencies.commands.clearContext(taskId);
  }

  recover(): Promise<void> {
    return this.#dependencies.recovery.requestRecoveryScan();
  }

  handleBrowserStartup(): Promise<void> {
    return this.#dependencies.recovery.handleBrowserStartup();
  }

  dispose(): Promise<void> {
    return this.#dependencies.coordinator.dispose();
  }
}
