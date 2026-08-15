import type { TaskId } from '../shared/ids';
import type { TaskRepository } from '../persistence/task-repository';

export const LEASE_DURATION_MS = 30_000;

export class TaskLeaseManager {
  readonly #repository: TaskRepository;
  readonly #ownedGenerations = new Map<string, number>();

  /**
   * Creates a lease manager over the durable repository that arbitrates ownership.
   */
  constructor(repository: TaskRepository) {
    this.#repository = repository;
  }

  /**
   * Acquires an absent or expired lease and remembers the returned fencing generation.
   */
  async acquire(taskId: TaskId, ownerId: string, now: number): Promise<boolean> {
    const lease = await this.#repository.tryAcquireLease({
      taskId,
      ownerId,
      now,
      durationMs: LEASE_DURATION_MS,
    });
    if (lease === null) {
      return false;
    }

    this.#ownedGenerations.set(this.#ownershipKey(taskId, ownerId), lease.generation);
    return true;
  }

  /**
   * Renews a currently tracked ownership using the repository's atomic owner check.
   */
  async renew(taskId: TaskId, ownerId: string, now: number): Promise<boolean> {
    const ownershipKey = this.#ownershipKey(taskId, ownerId);
    if (!this.#ownedGenerations.has(ownershipKey)) {
      return false;
    }

    const lease = await this.#repository.tryAcquireLease({
      taskId,
      ownerId,
      now,
      durationMs: LEASE_DURATION_MS,
    });
    if (lease === null) {
      this.#ownedGenerations.delete(ownershipKey);
      return false;
    }

    this.#ownedGenerations.set(ownershipKey, lease.generation);
    return true;
  }

  /**
   * Releases only the exact fencing generation last acquired by this manager instance.
   */
  async release(taskId: TaskId, ownerId: string): Promise<void> {
    const ownershipKey = this.#ownershipKey(taskId, ownerId);
    const generation = this.#ownedGenerations.get(ownershipKey);
    if (generation === undefined) {
      return;
    }

    this.#ownedGenerations.delete(ownershipKey);
    await this.#repository.releaseLease(taskId, ownerId, generation);
  }

  /**
   * Produces a collision-resistant in-memory key for one task and runner ownership pair.
   */
  #ownershipKey(taskId: TaskId, ownerId: string): string {
    return `${taskId.length}:${taskId}${ownerId}`;
  }
}
