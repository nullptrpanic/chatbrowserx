import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openChatBrowserDatabase } from '../../src/persistence/open-database';
import { IndexedDbTaskRepository } from '../../src/persistence/task-repository';
import { createTask } from '../../src/tasks/task-factory';
import { transitionTask } from '../../src/tasks/task-transition';
import type { Checkpoint } from '../../src/tasks/checkpoint-types';
import type { TaskEvent, TaskRun } from '../../src/tasks/task-types';
import { createTestDatabaseName } from './test-helpers';

const clock = { now: () => 1_000 };
const ids = { create: (prefix: string) => `${prefix}_1` };

/**
 * Builds the first durable checkpoint for a task-repository test.
 */
function createCheckpoint(task: TaskRun, id = 'checkpoint_1'): Checkpoint {
  return {
    id,
    taskId: task.id,
    sequence: 1,
    taskStatus: task.status,
    completedToolResults: [],
    observationRef: 'observation_1',
    pendingAction: null,
    createdAt: task.updatedAt,
  };
}

/**
 * Builds a persisted event whose sequence can be varied independently from its identifier.
 */
function createEvent(task: TaskRun, sequence = 1): TaskEvent {
  return {
    id: `event_${sequence}`,
    taskId: task.id,
    sequence,
    type: 'observation.started',
    reason: 'Observation started.',
    at: task.updatedAt,
    error: null,
  };
}

describe('IndexedDbTaskRepository', () => {
  it('creates only the durable stores used by the current task and conversation model', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('schema-stores'));

    expect([...database.objectStoreNames]).toEqual([
      'attachment-references',
      'attachments',
      'checkpoints',
      'conversations',
      'messages',
      'task-events',
      'tasks',
    ]);
    database.close();
  });

  it('creates a queued task and sequence-zero checkpoint atomically', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('task-initial'));
    const repository = new IndexedDbTaskRepository(database);
    const queued = {
      ...createTask({ conversationId: 'conv_1', tabId: 7, goal: 'Fill the form' }, { clock, ids }),
      checkpointId: 'checkpoint_initial',
    };
    const checkpoint: Checkpoint = {
      id: 'checkpoint_initial',
      taskId: queued.id,
      sequence: 0,
      taskStatus: 'queued',
      completedToolResults: [],
      observationRef: null,
      pendingAction: null,
      createdAt: queued.createdAt,
    };

    await repository.createInitial(queued, checkpoint);

    await expect(repository.get(queued.id)).resolves.toEqual(queued);
    await expect(repository.getCheckpoint(checkpoint.id)).resolves.toEqual(checkpoint);
    database.close();
  });

  it('recovers a transactional transition after reopening IndexedDB', async () => {
    const name = createTestDatabaseName('task-recovery');
    const database = await openChatBrowserDatabase(name);
    const repository = new IndexedDbTaskRepository(database);
    const queued = createTask(
      { conversationId: 'conv_1', tabId: 7, goal: 'Fill the form' },
      { clock, ids },
    );
    await repository.create(queued);

    const observing = transitionTask(queued, {
      type: 'observation.started',
      at: 1_001,
      reason: 'Observation started.',
    });
    const checkpoint = createCheckpoint(observing);
    await repository.saveTransition({
      task: { ...observing, checkpointId: checkpoint.id },
      event: createEvent(observing),
      checkpoint,
    });
    database.close();

    const reopened = await openChatBrowserDatabase(name);
    const reopenedRepository = new IndexedDbTaskRepository(reopened);

    await expect(reopenedRepository.get(queued.id)).resolves.toMatchObject({
      status: 'observing',
      checkpointId: checkpoint.id,
    });
    await expect(reopenedRepository.listEvents(queued.id)).resolves.toHaveLength(1);
    await expect(reopenedRepository.getCheckpoint(checkpoint.id)).resolves.toEqual(checkpoint);
    reopened.close();
  });

  it('leaves the previous transaction intact when an event sequence is duplicated', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('task-atomicity'));
    const repository = new IndexedDbTaskRepository(database);
    const queued = createTask(
      { conversationId: 'conv_1', tabId: 7, goal: 'Fill the form' },
      { clock, ids },
    );
    await repository.create(queued);
    const observing = transitionTask(queued, {
      type: 'observation.started',
      at: 1_001,
      reason: 'Observation started.',
    });
    const firstCheckpoint = createCheckpoint(observing);
    await repository.saveTransition({
      task: { ...observing, checkpointId: firstCheckpoint.id },
      event: createEvent(observing),
      checkpoint: firstCheckpoint,
    });

    const planning = transitionTask(observing, {
      type: 'planning.started',
      at: 1_002,
      reason: 'Planning started.',
    });
    const duplicateCheckpoint = createCheckpoint(planning, 'checkpoint_2');

    await expect(
      repository.saveTransition({
        task: { ...planning, checkpointId: duplicateCheckpoint.id },
        event: { ...createEvent(planning), type: 'planning.started' },
        checkpoint: duplicateCheckpoint,
      }),
    ).rejects.toThrow(/event sequence/i);
    await expect(repository.get(queued.id)).resolves.toMatchObject({ status: 'observing' });
    await expect(repository.getCheckpoint(duplicateCheckpoint.id)).resolves.toBeUndefined();
    database.close();
  });

  it('uses lease generations to prevent stale release and filters recoverable tasks', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('task-lease'));
    const repository = new IndexedDbTaskRepository(database);
    const firstTask = createTask(
      { conversationId: 'conv_1', tabId: 7, goal: 'First' },
      { clock, ids: { create: () => 'task_1' } },
    );
    const pausedTask = {
      ...createTask(
        { conversationId: 'conv_1', tabId: 7, goal: 'Paused' },
        { clock, ids: { create: () => 'task_2' } },
      ),
      status: 'paused' as const,
    };
    await repository.create(firstTask);
    await repository.create(pausedTask);

    const firstLease = await repository.tryAcquireLease({
      taskId: firstTask.id,
      ownerId: 'runner_a',
      now: 1_000,
      durationMs: 30_000,
    });
    expect(firstLease).toMatchObject({ ownerId: 'runner_a', generation: 1, expiresAt: 31_000 });
    await expect(
      repository.tryAcquireLease({
        taskId: firstTask.id,
        ownerId: 'runner_b',
        now: 1_001,
        durationMs: 30_000,
      }),
    ).resolves.toBeNull();

    const secondLease = await repository.tryAcquireLease({
      taskId: firstTask.id,
      ownerId: 'runner_b',
      now: 31_000,
      durationMs: 30_000,
    });
    expect(secondLease).toMatchObject({ ownerId: 'runner_b', generation: 2 });

    await repository.releaseLease(firstTask.id, 'runner_a', 1);
    await expect(repository.get(firstTask.id)).resolves.toMatchObject({
      lease: { ownerId: 'runner_b', generation: 2 },
    });
    await expect(repository.listRecoverable(31_001)).resolves.toEqual([]);
    await expect(repository.listUnfinished()).resolves.toHaveLength(2);

    await repository.releaseLease(firstTask.id, 'runner_b', 2);
    await expect(repository.listRecoverable(31_001)).resolves.toEqual([
      expect.objectContaining({ id: 'task_1' }),
    ]);
    database.close();
  });

  it('renews a same-owner lease without changing its generation', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('task-renew'));
    const repository = new IndexedDbTaskRepository(database);
    const task = createTask(
      { conversationId: 'conv_1', tabId: 7, goal: 'Renew me' },
      { clock, ids },
    );
    await repository.create(task);
    await repository.tryAcquireLease({
      taskId: task.id,
      ownerId: 'runner_a',
      now: 1_000,
      durationMs: 30_000,
    });

    await expect(
      repository.tryAcquireLease({
        taskId: task.id,
        ownerId: 'runner_a',
        now: 10_000,
        durationMs: 30_000,
      }),
    ).resolves.toMatchObject({ ownerId: 'runner_a', generation: 1, expiresAt: 40_000 });
    database.close();
  });
});
