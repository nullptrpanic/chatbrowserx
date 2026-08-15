// @vitest-environment node

import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import type { TaskRepository } from '../../src/persistence/task-repository';
import type { Checkpoint } from '../../src/tasks/checkpoint-types';
import type { TaskEvent, TaskRun } from '../../src/tasks/task-types';
import { openChatBrowserDatabase } from '../../src/persistence/open-database';
import { IndexedDbTaskRepository } from '../../src/persistence/task-repository';
import { TaskCommandService } from '../../src/tasks/task-command-service';
import { createTask } from '../../src/tasks/task-factory';
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

  it('stores confirmation for exactly the next attempt and rejects generic resume', async () => {
    const sources = createCommandSources();
    const base = createTask(
      { conversationId: 'conv_1', tabId: 7, goal: 'Delete the record' },
      { clock: { now: () => 1_000 }, ids: { create: () => 'task_1' } },
    );
    const task: TaskRun = {
      ...base,
      status: 'waiting_for_confirmation',
      checkpointId: 'checkpoint_1',
    };
    const checkpoint: Checkpoint = {
      id: 'checkpoint_1',
      taskId: task.id,
      sequence: 1,
      taskStatus: task.status,
      completedToolResults: [],
      observationRef: 'observation_1',
      pendingAction: {
        actionId: 'action_1',
        digest: 'sha256:action',
        kind: 'waitFor',
        risk: 'high',
        action: {
          actionId: 'action_1',
          tabId: 7,
          type: 'waitFor',
          timeoutMs: 300,
          risk: 'high',
          expected: { type: 'page.stable', quietMs: 300 },
        },
        expected: { type: 'page.stable', quietMs: 300 },
        intentAt: null,
        attemptCount: 0,
        effectState: 'not_attempted',
        outcome: 'pending',
        confirmation: null,
        evidence: null,
        evidenceRef: null,
        verified: false,
        modelCall: null,
      },
      createdAt: 1_000,
    };
    const events: TaskEvent[] = [
      {
        id: 'event_1',
        taskId: task.id,
        sequence: 1,
        type: 'task.confirmation-required',
        reason: 'Confirm.',
        at: 1_000,
        error: null,
      },
    ];
    const saveTransition = vi.fn(async () => undefined);
    const repository = {
      get: vi.fn(async () => task),
      getCheckpoint: vi.fn(async () => checkpoint),
      listEvents: vi.fn(async () => events),
      saveTransition,
    } as unknown as TaskRepository;
    const commands = new TaskCommandService(repository, sources.clock, sources.ids);

    await expect(commands.resume(task.id)).rejects.toMatchObject({ code: 'TASK_STATE_INVALID' });
    await commands.confirm(task.id, 'sha256:action');

    expect(saveTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({ status: 'queued' }),
        checkpoint: expect.objectContaining({
          pendingAction: expect.objectContaining({
            confirmation: expect.objectContaining({
              digest: 'sha256:action',
              forAttempt: 1,
            }),
          }),
        }),
      }),
    );
  });
});
