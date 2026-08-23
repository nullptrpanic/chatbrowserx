// @vitest-environment node

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openChatBrowserDatabase } from '../../src/persistence/open-database';
import { IndexedDbTaskRepository } from '../../src/persistence/task-repository';
import { TaskLeaseManager } from '../../src/tasks/task-lease';
import { createTask } from '../../src/tasks/task-factory';
import { createTestDatabaseName, seedTask } from '../persistence/test-helpers';

describe('TaskLeaseManager', () => {
  it('allows takeover only after a 30-second lease expires', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('lease-manager'));
    const repository = new IndexedDbTaskRepository(database);
    const manager = new TaskLeaseManager(repository);
    const task = createTask(
      { conversationId: 'conv_1', tabId: 7, goal: 'Complete the page' },
      { clock: { now: () => 1_000 }, ids: { create: () => 'task_1' } },
    );
    await seedTask(database, task);

    await expect(manager.acquire(task.id, 'runner_a', 1_000)).resolves.toBe(true);
    await expect(manager.acquire(task.id, 'runner_b', 1_001)).resolves.toBe(false);
    await expect(manager.acquire(task.id, 'runner_b', 31_000)).resolves.toBe(true);

    await manager.release(task.id, 'runner_a');
    await expect(repository.get(task.id)).resolves.toMatchObject({
      lease: { ownerId: 'runner_b', generation: 2 },
    });
    await manager.release(task.id, 'runner_b');
    await expect(repository.get(task.id)).resolves.toMatchObject({ lease: null });
    database.close();
  });

  it('renews an owned lease without changing its generation', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('lease-renewal'));
    const repository = new IndexedDbTaskRepository(database);
    const manager = new TaskLeaseManager(repository);
    const task = createTask(
      { conversationId: 'conv_1', tabId: 7, goal: 'Complete the page' },
      { clock: { now: () => 1_000 }, ids: { create: () => 'task_1' } },
    );
    await seedTask(database, task);

    await manager.acquire(task.id, 'runner_a', 1_000);
    await expect(manager.renew(task.id, 'runner_a', 10_000)).resolves.toBe(true);
    await expect(repository.get(task.id)).resolves.toMatchObject({
      lease: { ownerId: 'runner_a', generation: 1, acquiredAt: 1_000, expiresAt: 40_000 },
    });
    database.close();
  });
});
