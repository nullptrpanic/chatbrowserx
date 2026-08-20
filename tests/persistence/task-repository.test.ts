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
    continuationItems: [],
    pendingToolCall: null,
    browserToolCallsInAttempt: 0,
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
      workSessionId: undefined,
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
        {
          callId: 'call_tavily',
          toolName: 'tavily_search',
          argumentsJson: '{}',
          output: '{"ok":true}',
          resultRef: 'result_tavily',
          attachmentIds: [],
        },
      ],
      pendingAction: { actionId: 'action_legacy' },
      observationRef: 'observation_legacy',
      createdAt: current.createdAt,
    } as never);

    const task = await repository.get(current.id);
    const checkpoint = await repository.getCheckpoint('checkpoint_legacy');

    expect(task).toMatchObject({
      status: 'paused',
      lease: null,
      workSessionId: current.id,
    });
    expect(task).not.toHaveProperty('budget');
    expect(checkpoint).toMatchObject({
      taskStatus: 'paused',
      completedToolResults: [
        {
          callId: 'call_tavily',
          toolName: 'tavily_search',
          argumentsJson: '{}',
          output: '{"ok":true}',
          resultRef: 'result_tavily',
          attachmentIds: [],
        },
      ],
      continuationItems: [
        {
          type: 'function_call',
          callId: 'call_tavily',
          name: 'tavily_search',
          argumentsJson: '{}',
        },
        {
          type: 'function_call_output',
          callId: 'call_tavily',
          output: '{"ok":true}',
          resultRef: 'result_tavily',
        },
      ],
      pendingToolCall: null,
    });
    expect(checkpoint).not.toHaveProperty('pendingAction');
    expect(checkpoint).not.toHaveProperty('observationRef');
    database.close();
  });

  it('repairs message references written after a legacy unresolved tool call', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('legacy-pending-call-order'),
    );
    const repository = new IndexedDbTaskRepository(database);
    await database.add('checkpoints', {
      id: 'checkpoint_legacy_pending',
      taskId: 'task_legacy_pending',
      sequence: 2,
      taskStatus: 'cancelled',
      completedToolResults: [],
      continuationItems: [
        { type: 'message_ref', messageId: 'message_initial' },
        {
          type: 'function_call',
          callId: 'call_pending',
          name: 'tavily_search',
          argumentsJson: '{"query":"recovery"}',
        },
        { type: 'message_ref', messageId: 'message_after_call' },
      ],
      pendingToolCall: {
        callId: 'call_pending',
        name: 'tavily_search',
        argumentsJson: '{"query":"recovery"}',
      } as unknown as NonNullable<Checkpoint['pendingToolCall']>,
      createdAt: 1_000,
    });

    await expect(repository.getCheckpoint('checkpoint_legacy_pending')).resolves.toMatchObject({
      continuationItems: [
        { type: 'message_ref', messageId: 'message_initial' },
        { type: 'message_ref', messageId: 'message_after_call' },
        {
          type: 'function_call',
          callId: 'call_pending',
          name: 'tavily_search',
          argumentsJson: '{"query":"recovery"}',
        },
      ],
      pendingToolCall: {
        callId: 'call_pending',
        name: 'tavily_search',
        argumentsJson: '{"query":"recovery"}',
        executionState: 'recorded',
      },
    });
    database.close();
  });

  it('preserves a compact continuation without reconstructing older audit results', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('compacted-context-continuation'),
    );
    const repository = new IndexedDbTaskRepository(database);
    const commitArguments = JSON.stringify({
      state: 'Goal: continue from the checkpoint.',
      throughCallId: 'call_inspect',
    });
    const commitOutput =
      '{"ok":true,"compactedCalls":1,"releasedTextChars":2048,"releasedImages":1}';
    await database.add('checkpoints', {
      id: 'checkpoint_compacted',
      taskId: 'task_compacted',
      sequence: 4,
      taskStatus: 'planning',
      completedToolResults: [
        {
          callId: 'call_inspect',
          toolName: 'browser_inspect',
          argumentsJson: '{"mode":"screenshot"}',
          output: '{"ok":true,"large":"old raw result"}',
          resultRef: 'result_inspect',
          attachmentIds: ['attachment_old'],
        },
        {
          callId: 'call_commit',
          toolName: 'commit_context',
          argumentsJson: commitArguments,
          output: commitOutput,
          resultRef: 'result_commit',
          attachmentIds: [],
        },
      ],
      continuationItems: [
        { type: 'message_ref', messageId: 'message_user' },
        {
          type: 'function_call',
          callId: 'call_commit',
          name: 'commit_context',
          argumentsJson: commitArguments,
        },
        {
          type: 'function_call_output',
          callId: 'call_commit',
          output: commitOutput,
          resultRef: 'result_commit',
          attachmentIds: [],
        },
      ],
      pendingToolCall: null,
      createdAt: 1_000,
    });

    const checkpoint = await repository.getCheckpoint('checkpoint_compacted');

    expect(checkpoint?.completedToolResults.map(({ toolName }) => toolName)).toEqual([
      'browser_inspect',
      'commit_context',
    ]);
    expect(checkpoint?.continuationItems).toEqual([
      { type: 'message_ref', messageId: 'message_user' },
      {
        type: 'function_call',
        callId: 'call_commit',
        name: 'commit_context',
        argumentsJson: commitArguments,
      },
      {
        type: 'function_call_output',
        callId: 'call_commit',
        output: commitOutput,
        resultRef: 'result_commit',
        attachmentIds: [],
      },
    ]);
    expect(checkpoint?.continuationItems).not.toContainEqual(
      expect.objectContaining({ callId: 'call_inspect' }),
    );
    database.close();
  });

  it('preserves validated model output continuation items on a function call', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('model-output-continuation'),
    );
    const repository = new IndexedDbTaskRepository(database);
    await database.add('checkpoints', {
      id: 'checkpoint_model_output',
      taskId: 'task_model_output',
      sequence: 2,
      taskStatus: 'planning',
      completedToolResults: [
        {
          callId: 'call_inspect',
          toolName: 'browser_inspect',
          argumentsJson: '{}',
          output: '{"ok":true}',
          resultRef: 'result_inspect',
        },
      ],
      continuationItems: [
        { type: 'message_ref', messageId: 'message_user' },
        {
          type: 'function_call',
          callId: 'call_inspect',
          name: 'browser_inspect',
          argumentsJson: '{}',
          modelOutputItems: [
            {
              type: 'reasoning',
              itemId: 'reasoning_1',
              encryptedContent: 'opaque-encrypted-content',
              summary: [{ type: 'summary_text', text: 'Inspect the page.' }],
            },
            {
              type: 'assistant_message_ref',
              messageId: 'message_assistant',
            },
          ],
        },
        {
          type: 'function_call_output',
          callId: 'call_inspect',
          output: '{"ok":true}',
          resultRef: 'result_inspect',
        },
      ],
      pendingToolCall: null,
      createdAt: 1_000,
    });

    await expect(repository.getCheckpoint('checkpoint_model_output')).resolves.toMatchObject({
      continuationItems: [
        { type: 'message_ref', messageId: 'message_user' },
        {
          type: 'function_call',
          callId: 'call_inspect',
          modelOutputItems: [
            {
              type: 'reasoning',
              itemId: 'reasoning_1',
              encryptedContent: 'opaque-encrypted-content',
              summary: [{ type: 'summary_text', text: 'Inspect the page.' }],
            },
            {
              type: 'assistant_message_ref',
              messageId: 'message_assistant',
            },
          ],
        },
        { type: 'function_call_output', callId: 'call_inspect' },
      ],
    });
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
      continuationItems: [],
      pendingToolCall: null,
      browserToolCallsInAttempt: 0,
      createdAt: queued.createdAt,
    };

    await repository.createInitial(queued, checkpoint);

    await expect(repository.get(queued.id)).resolves.toEqual(queued);
    await expect(repository.getCheckpoint(checkpoint.id)).resolves.toEqual(checkpoint);
    database.close();
  });

  it('allows only one continuation from the latest cancelled WorkSession run', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('task-continuation'));
    const repository = new IndexedDbTaskRepository(database);
    const source = {
      ...createTask(
        { conversationId: 'conv_1', tabId: 7, goal: 'Initial request' },
        { clock, ids: { create: (prefix) => `${prefix}_source` } },
      ),
      checkpointId: 'checkpoint_source_0',
    };
    await repository.createInitial(source, {
      id: 'checkpoint_source_0',
      taskId: source.id,
      sequence: 0,
      taskStatus: 'queued',
      completedToolResults: [],
      continuationItems: [{ type: 'message_ref', messageId: 'message_1' }],
      pendingToolCall: null,
      createdAt: source.createdAt,
    });
    const cancelled = {
      ...source,
      status: 'cancelled' as const,
      updatedAt: 1_100,
    };
    await repository.saveTransition({
      task: { ...cancelled, checkpointId: 'checkpoint_source_1' },
      event: {
        id: 'event_cancelled',
        taskId: source.id,
        sequence: 1,
        type: 'task.cancelled',
        reason: 'user_cancel',
        at: 1_100,
        error: null,
      },
      checkpoint: {
        id: 'checkpoint_source_1',
        taskId: source.id,
        sequence: 1,
        taskStatus: 'cancelled',
        completedToolResults: [],
        continuationItems: [{ type: 'message_ref', messageId: 'message_1' }],
        pendingToolCall: null,
        createdAt: 1_100,
      },
    });

    const continuationCheckpoint = (taskId: string, id: string): Checkpoint => ({
      id,
      taskId,
      sequence: 0,
      taskStatus: 'queued',
      completedToolResults: [],
      continuationItems: [
        { type: 'message_ref', messageId: 'message_1' },
        { type: 'message_ref', messageId: `message_${taskId}` },
      ],
      pendingToolCall: null,
      createdAt: 1_200,
    });
    const first = {
      ...createTask(
        {
          conversationId: source.conversationId,
          tabId: 8,
          goal: 'First continuation',
          workSessionId: source.workSessionId,
        },
        { clock: { now: () => 1_200 }, ids: { create: () => 'task_cont_1' } },
      ),
      checkpointId: 'checkpoint_cont_1',
    };
    const second = {
      ...createTask(
        {
          conversationId: source.conversationId,
          tabId: 9,
          goal: 'Racing continuation',
          workSessionId: source.workSessionId,
        },
        { clock: { now: () => 1_200 }, ids: { create: () => 'task_cont_2' } },
      ),
      checkpointId: 'checkpoint_cont_2',
    };

    await repository.createContinuation(
      source.id,
      first,
      continuationCheckpoint(first.id, 'checkpoint_cont_1'),
    );
    await expect(
      repository.createContinuation(
        source.id,
        second,
        continuationCheckpoint(second.id, 'checkpoint_cont_2'),
      ),
    ).rejects.toThrow(/latest cancelled/i);
    await expect(repository.get(second.id)).resolves.toBeUndefined();
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
    await expect(repository.get(queued.id)).resolves.toMatchObject({
      status: 'planning',
    });
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
    expect(firstLease).toMatchObject({
      ownerId: 'runner_a',
      generation: 1,
      expiresAt: 31_000,
    });
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
    ).resolves.toMatchObject({
      ownerId: 'runner_a',
      generation: 1,
      expiresAt: 40_000,
    });
    database.close();
  });
});
