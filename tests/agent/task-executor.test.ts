// @vitest-environment node

import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { TaskExecutor } from '../../src/agent/task-executor';
import type { AgentEvent, AgentPlanInput } from '../../src/agent/execution-types';
import { openChatBrowserDatabase } from '../../src/persistence/open-database';
import { IndexedDbTaskRepository } from '../../src/persistence/task-repository';
import { providerErrorFromCode } from '../../src/providers/provider-errors';
import { TaskCommandService } from '../../src/tasks/task-command-service';
import { createTestDatabaseName } from '../persistence/test-helpers';

function sources() {
  let now = 1_000;
  let id = 0;
  return {
    clock: { now: () => ++now },
    ids: { create: (prefix: string) => `${prefix}_${String(++id)}` },
  };
}

describe('TaskExecutor', () => {
  it('runs a pure model turn without any browser or search dependency', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('text-executor'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(repository, dependencies.clock, dependencies.ids);
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Answer this message',
    });
    const plan = vi.fn<(input: AgentPlanInput) => AsyncGenerator<AgentEvent>>(() =>
      (async function* () {
        yield { type: 'task.completed', reason: 'model_response_completed' };
      })(),
    );
    const executor = new TaskExecutor({
      repository,
      planner: { plan },
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(result.task.status).toBe('completed');
    expect(result.events.map((event) => event.type)).toEqual([
      'planning.started',
      'task.completed',
    ]);
    expect(plan).toHaveBeenCalledOnce();
    database.close();
  });

  it('persists authentication failures as an explicit resumable boundary', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('auth-executor'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(repository, dependencies.clock, dependencies.ids);
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Answer this message',
    });
    const executor = new TaskExecutor({
      repository,
      planner: {
        plan: () =>
          (async function* () {
            yield* [];
            throw providerErrorFromCode('AUTH', { status: 401 });
          })(),
      },
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    await expect(
      executor.run(created.task.id, new AbortController().signal),
    ).resolves.toMatchObject({
      task: {
        status: 'waiting_for_auth',
        lastError: { code: 'AuthError', recoveryAction: 'update_credentials' },
      },
    });
    database.close();
  });

  it('fails durably when task input cannot be prepared instead of remaining stuck in planning', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('input-error-executor'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(repository, dependencies.clock, dependencies.ids);
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Answer this message',
    });
    const executor = new TaskExecutor({
      repository,
      planner: {
        plan: () =>
          (async function* () {
            yield* [];
            throw new Error('private attachment detail');
          })(),
      },
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    await expect(
      executor.run(created.task.id, new AbortController().signal),
    ).resolves.toMatchObject({
      task: {
        status: 'failed',
        lastError: {
          code: 'TaskInputError',
          userMessage: 'Task input could not be prepared.',
        },
      },
    });
    database.close();
  });
});
