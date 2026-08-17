// @vitest-environment node

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openChatBrowserDatabase } from '../../src/persistence/open-database';
import { IndexedDbTaskRepository } from '../../src/persistence/task-repository';
import { TaskCommandService } from '../../src/tasks/task-command-service';
import type { TaskError } from '../../src/tasks/task-errors';
import { createTestDatabaseName } from '../persistence/test-helpers';

/**
 * Creates deterministic clock and ID sources whose values can advance between commands.
 */
function createCommandSources() {
  let now = 1_000;
  let sequence = 0;

  return {
    clock: { now: () => now },
    ids: { create: (prefix: string) => `${prefix}_${String(++sequence)}` },
    advance(next: number) {
      now = next;
    },
  };
}

describe('TaskCommandService', () => {
  it('atomically creates a queued task with a sequence-zero checkpoint', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('command-create'));
    const repository = new IndexedDbTaskRepository(database);
    const sources = createCommandSources();
    const commands = new TaskCommandService(repository, sources.clock, sources.ids);

    const snapshot = await commands.create({
      conversationId: 'conv_1',
      tabId: 7,
      goal: 'Complete the page',
    });

    expect(snapshot.task).toMatchObject({ status: 'queued', checkpointId: snapshot.checkpoint.id });
    expect(snapshot.checkpoint).toMatchObject({ sequence: 0, taskStatus: 'queued' });
    expect(snapshot.events).toEqual([]);
    await expect(repository.get(snapshot.task.id)).resolves.toEqual(snapshot.task);
    database.close();
  });

  it('persists pause, resume, and cancel as ordered checkpoints and events', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('command-transition'));
    const repository = new IndexedDbTaskRepository(database);
    const sources = createCommandSources();
    const commands = new TaskCommandService(repository, sources.clock, sources.ids);
    const created = await commands.create({
      conversationId: 'conv_1',
      tabId: 7,
      goal: 'Complete the page',
    });

    sources.advance(1_100);
    await expect(commands.pause(created.task.id)).resolves.toMatchObject({
      task: { status: 'paused' },
      checkpoint: { sequence: 1, taskStatus: 'paused' },
    });
    sources.advance(1_200);
    await expect(commands.resume(created.task.id)).resolves.toMatchObject({
      task: { status: 'queued' },
      checkpoint: { sequence: 2, taskStatus: 'queued' },
    });
    sources.advance(1_300);
    const cancelled = await commands.cancel(created.task.id);

    expect(cancelled.task.status).toBe('cancelled');
    expect(cancelled.events.map((event) => [event.sequence, event.type])).toEqual([
      [1, 'task.paused'],
      [2, 'task.resumed'],
      [3, 'task.cancelled'],
    ]);
    database.close();
  });

  it('retries the same failed task with a fresh queued checkpoint and no stale error or lease', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('command-retry'));
    const repository = new IndexedDbTaskRepository(database);
    const sources = createCommandSources();
    const commands = new TaskCommandService(repository, sources.clock, sources.ids);
    const created = await commands.create({
      conversationId: 'conv_1',
      tabId: 7,
      goal: 'Complete the page',
    });
    const error: TaskError = {
      code: 'TransientProviderError',
      retryable: true,
      recoveryAction: 'resume_task' as const,
      userMessage: 'The provider is temporarily unavailable.',
      evidenceRef: null,
    };
    await repository.saveTransition({
      task: {
        ...created.task,
        status: 'failed',
        updatedAt: 1_100,
        checkpointId: 'checkpoint_failed',
        lease: { ownerId: 'stale', acquiredAt: 1_050, expiresAt: 9_999, generation: 1 },
        lastError: error,
      },
      event: {
        id: 'event_failed',
        taskId: created.task.id,
        sequence: 1,
        type: 'task.failed',
        reason: 'Provider failed.',
        at: 1_100,
        error,
      },
      checkpoint: {
        ...created.checkpoint,
        id: 'checkpoint_failed',
        sequence: 1,
        taskStatus: 'failed',
        createdAt: 1_100,
      },
    });

    sources.advance(1_200);
    const retried = await commands.retry(created.task.id);

    expect(retried.task).toMatchObject({
      id: created.task.id,
      status: 'queued',
      lastError: null,
      lease: null,
    });
    expect(retried.checkpoint).toMatchObject({ sequence: 2, taskStatus: 'queued' });
    expect(retried.events.at(-1)).toMatchObject({
      sequence: 2,
      type: 'task.retried',
      reason: 'user_retry',
    });
    database.close();
  });

  it('returns a stable command error when the task does not exist', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('command-missing'));
    const repository = new IndexedDbTaskRepository(database);
    const sources = createCommandSources();
    const commands = new TaskCommandService(repository, sources.clock, sources.ids);

    await expect(commands.getSnapshot('missing')).rejects.toEqual(
      expect.objectContaining({ code: 'TASK_NOT_FOUND' }),
    );
    database.close();
  });
});
