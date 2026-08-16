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
    type: 'planning.started',
    reason: 'Model request started.',
    at: task.updatedAt,
    error: null,
  };
}

describe('IndexedDbTaskRepository', () => {
  it('normalizes legacy concrete-tool records without reviving their actions', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('legacy-tool-state'));
    const repository = new IndexedDbTaskRepository(database);
    const current = createTask(
      { conversationId: 'conv_1', tabId: 7, goal: 'Legacy task' },
      { clock, ids },
    );
    await database.add('tasks', {
      ...current,
      status: 'acting',
      checkpointId: 'checkpoint_legacy',
      budget: { browserActionsUsed: 12, browserActionsLimit: 50 },
    } as never);
    await database.add('checkpoints', {
      id: 'checkpoint_legacy',
      taskId: current.id,
      sequence: 4,
      taskStatus: 'acting',
      completedToolResults: [
        {
          callId: 'call_legacy',
          toolName: 'browser.act',
          argumentsJson: '{}',
          output: '{}',
          resultRef: 'result_legacy',
        },
      ],
      pendingAction: { actionId: 'action_legacy' },
      observationRef: 'observation_legacy',
      createdAt: current.createdAt,
    } as never);

    const task = await repository.get(current.id);
    const checkpoint = await repository.getCheckpoint('checkpoint_legacy');

    expect(task).toMatchObject({ status: 'paused', lease: null });
    expect(task).not.toHaveProperty('budget');
    expect(checkpoint).toMatchObject({ taskStatus: 'paused', completedToolResults: [] });
    expect(checkpoint).not.toHaveProperty('pendingAction');
    expect(checkpoint).not.toHaveProperty('observationRef');
    database.close();
  });

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

    const planning = transitionTask(queued, {
      type: 'planning.started',
      at: 1_001,
      reason: 'Model request started.',
    });
    const checkpoint = createCheckpoint(planning);
    await repository.saveTransition({
      task: { ...planning, checkpointId: checkpoint.id },
      event: createEvent(planning),
      checkpoint,
    });
    database.close();

    const reopened = await openChatBrowserDatabase(name);
    const reopenedRepository = new IndexedDbTaskRepository(reopened);

    await expect(reopenedRepository.get(queued.id)).resolves.toMatchObject({
      status: 'planning',
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
    const planning = transitionTask(queued, {
      type: 'planning.started',
      at: 1_001,
      reason: 'Model request started.',
    });
    const firstCheckpoint = createCheckpoint(planning);
    await repository.saveTransition({
      task: { ...planning, checkpointId: firstCheckpoint.id },
      event: createEvent(planning),
      checkpoint: firstCheckpoint,
    });

    const completed = transitionTask(planning, {
      type: 'task.completed',
      at: 1_002,
      reason: 'Response completed.',
    });
    const duplicateCheckpoint = createCheckpoint(completed, 'checkpoint_2');

    await expect(
      repository.saveTransition({
        task: { ...completed, checkpointId: duplicateCheckpoint.id },
        event: { ...createEvent(completed), type: 'task.completed' },
        checkpoint: duplicateCheckpoint,
      }),
    ).rejects.toThrow(/event sequence/i);
    await expect(repository.get(queued.id)).resolves.toMatchObject({ status: 'planning' });
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
