import type { IDBPDatabase } from 'idb';
import type { ConversationId, TaskId } from '../shared/ids';
import type { Checkpoint } from '../tasks/checkpoint-types';
import type { TaskEvent, TaskLease, TaskRun, TaskStatus } from '../tasks/task-types';
import type { ChatBrowserDatabase } from './database-schema';

export interface SaveTransitionInput {
  readonly task: TaskRun;
  readonly event: TaskEvent;
  readonly checkpoint: Checkpoint;
}

export interface AcquireLeaseInput {
  readonly taskId: TaskId;
  readonly ownerId: string;
  readonly now: number;
  readonly durationMs: number;
}

export interface TaskRepository {
  create(task: TaskRun): Promise<void>;
  createInitial(task: TaskRun, checkpoint: Checkpoint): Promise<void>;
  get(taskId: TaskId): Promise<TaskRun | undefined>;
  listByConversation(conversationId: ConversationId): Promise<TaskRun[]>;
  listEvents(taskId: TaskId, afterSequence?: number): Promise<TaskEvent[]>;
  getCheckpoint(checkpointId: string): Promise<Checkpoint | undefined>;
  saveTransition(input: SaveTransitionInput): Promise<void>;
  listUnfinished(): Promise<TaskRun[]>;
  listRecoverable(now: number): Promise<TaskRun[]>;
  tryAcquireLease(input: AcquireLeaseInput): Promise<TaskLease | null>;
  releaseLease(taskId: TaskId, ownerId: string, generation: number): Promise<void>;
}

const terminalStatuses = new Set<TaskStatus>(['completed', 'failed', 'cancelled']);
const automaticallyRecoverableStatuses = new Set<TaskStatus>([
  'queued',
  'observing',
  'planning',
  'acting',
  'verifying',
  'checkpointed',
]);

/**
 * Builds the bounded compound-key range for all sequence values belonging to one task.
 */
function taskSequenceRange(taskId: TaskId, afterSequence = -1): IDBKeyRange {
  return IDBKeyRange.bound(
    [taskId, Math.max(0, afterSequence + 1)],
    [taskId, Number.MAX_SAFE_INTEGER],
  );
}

export class IndexedDbTaskRepository implements TaskRepository {
  readonly #database: IDBPDatabase<ChatBrowserDatabase>;

  /**
   * Creates a task repository over an already opened application database.
   */
  constructor(database: IDBPDatabase<ChatBrowserDatabase>) {
    this.#database = database;
  }

  /**
   * Inserts a new task and rejects identifier collisions instead of overwriting prior history.
   */
  async create(task: TaskRun): Promise<void> {
    await this.#database.add('tasks', task);
  }

  /**
   * Atomically inserts a queued task and its sequence-zero recovery checkpoint.
   */
  async createInitial(task: TaskRun, checkpoint: Checkpoint): Promise<void> {
    if (
      task.status !== 'queued' ||
      task.checkpointId !== checkpoint.id ||
      checkpoint.taskId !== task.id ||
      checkpoint.sequence !== 0 ||
      checkpoint.taskStatus !== 'queued' ||
      checkpoint.createdAt !== task.createdAt
    ) {
      throw new Error('Initial task records do not describe the same queued boundary.');
    }

    const transaction = this.#database.transaction(['tasks', 'checkpoints'], 'readwrite');
    await transaction.objectStore('tasks').add(task);
    await transaction.objectStore('checkpoints').add(checkpoint);
    await transaction.done;
  }

  /**
   * Retrieves one durable task by its stable identifier.
   */
  async get(taskId: TaskId): Promise<TaskRun | undefined> {
    return this.#database.get('tasks', taskId);
  }

  /**
   * Lists all tasks in one conversation ordered from oldest to newest update time.
   */
  async listByConversation(conversationId: ConversationId): Promise<TaskRun[]> {
    const tasks = await this.#database.getAllFromIndex('tasks', 'by-conversation', conversationId);
    return tasks.sort((left, right) => left.updatedAt - right.updatedAt);
  }

  /**
   * Lists append-only task events after an optional sequence boundary.
   */
  async listEvents(taskId: TaskId, afterSequence = -1): Promise<TaskEvent[]> {
    return this.#database.getAllFromIndex(
      'task-events',
      'by-task-sequence',
      taskSequenceRange(taskId, afterSequence),
    );
  }

  /**
   * Retrieves one durable checkpoint by its stable identifier.
   */
  async getCheckpoint(checkpointId: string): Promise<Checkpoint | undefined> {
    return this.#database.get('checkpoints', checkpointId);
  }

  /** Atomically saves a task transition, append-only event, and immutable checkpoint. */
  async saveTransition(input: SaveTransitionInput): Promise<void> {
    if (
      input.event.taskId !== input.task.id ||
      input.checkpoint.taskId !== input.task.id ||
      input.task.checkpointId !== input.checkpoint.id
    ) {
      throw new Error('Task transition records do not belong to the same task.');
    }
    if (
      input.event.at !== input.task.updatedAt ||
      input.checkpoint.taskStatus !== input.task.status ||
      input.checkpoint.sequence !== input.event.sequence
    ) {
      throw new Error('Task transition records do not describe the same durable boundary.');
    }
    const transaction = this.#database.transaction(
      ['tasks', 'task-events', 'checkpoints'],
      'readwrite',
    );
    const existingTask = await transaction.objectStore('tasks').get(input.task.id);
    if (existingTask === undefined) {
      throw new Error('Task does not exist.');
    }

    const latestEvent = await transaction
      .objectStore('task-events')
      .index('by-task-sequence')
      .openCursor(taskSequenceRange(input.task.id), 'prev');
    const expectedSequence = (latestEvent?.value.sequence ?? 0) + 1;
    if (input.event.sequence !== expectedSequence) {
      throw new Error(`Task event sequence must be ${expectedSequence}.`);
    }

    await transaction.objectStore('tasks').put(input.task);
    await transaction.objectStore('task-events').add(input.event);
    await transaction.objectStore('checkpoints').add(input.checkpoint);
    await transaction.done;
  }

  /**
   * Lists every non-terminal task for browser-startup recovery decisions.
   */
  async listUnfinished(): Promise<TaskRun[]> {
    const tasks = await this.#database.getAll('tasks');
    return tasks
      .filter((task) => !terminalStatuses.has(task.status))
      .sort((left, right) => left.updatedAt - right.updatedAt);
  }

  /**
   * Lists automatic-recovery tasks only when their lease is absent or expired at the supplied time.
   */
  async listRecoverable(now: number): Promise<TaskRun[]> {
    const tasks = await this.#database.getAll('tasks');
    return tasks
      .filter(
        (task) =>
          automaticallyRecoverableStatuses.has(task.status) &&
          (task.lease === null || task.lease.expiresAt <= now),
      )
      .sort((left, right) => left.updatedAt - right.updatedAt);
  }

  /**
   * Acquires or takes over an expired task lease and returns its monotonically increasing generation.
   */
  async tryAcquireLease(input: AcquireLeaseInput): Promise<TaskLease | null> {
    if (
      input.ownerId.trim().length === 0 ||
      !Number.isFinite(input.now) ||
      !Number.isFinite(input.durationMs) ||
      input.durationMs <= 0
    ) {
      throw new Error('Lease acquisition input is invalid.');
    }

    const transaction = this.#database.transaction('tasks', 'readwrite');
    const task = await transaction.store.get(input.taskId);
    if (task === undefined) {
      throw new Error('Task does not exist.');
    }
    if (task.lease !== null && task.lease.expiresAt > input.now) {
      if (task.lease.ownerId !== input.ownerId) {
        await transaction.done;
        return null;
      }

      const renewedLease: TaskLease = {
        ...task.lease,
        expiresAt: input.now + input.durationMs,
      };
      await transaction.store.put({ ...task, lease: renewedLease });
      await transaction.done;
      return renewedLease;
    }

    const lease: TaskLease = {
      ownerId: input.ownerId,
      acquiredAt: input.now,
      expiresAt: input.now + input.durationMs,
      generation: (task.lease?.generation ?? 0) + 1,
    };
    await transaction.store.put({ ...task, lease });
    await transaction.done;
    return lease;
  }

  /**
   * Releases a lease only when both owner and generation still match the durable task record.
   */
  async releaseLease(taskId: TaskId, ownerId: string, generation: number): Promise<void> {
    const transaction = this.#database.transaction('tasks', 'readwrite');
    const task = await transaction.store.get(taskId);
    if (
      task !== undefined &&
      task.lease?.ownerId === ownerId &&
      task.lease.generation === generation
    ) {
      await transaction.store.put({ ...task, lease: null });
    }
    await transaction.done;
  }
}
