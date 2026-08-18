// @vitest-environment node

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IndexedDbConversationRepository } from '../../src/persistence/conversation-repository';
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
    const commands = new TaskCommandService(
      repository,
      sources.clock,
      sources.ids,
      new IndexedDbConversationRepository(database),
    );

    const snapshot = await commands.create({
      conversationId: 'conv_1',
      tabId: 7,
      goal: 'Complete the page',
      userMessageId: 'message_1',
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
    const conversations = new IndexedDbConversationRepository(database);
    const sources = createCommandSources();
    await conversations.create({
      id: 'conv_1',
      tabId: 7,
      title: 'Complete the page',
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    const commands = new TaskCommandService(repository, sources.clock, sources.ids, conversations);
    const created = await commands.create({
      conversationId: 'conv_1',
      tabId: 7,
      goal: 'Complete the page',
      userMessageId: 'message_1',
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
    await expect(conversations.listMessages('conv_1')).resolves.toEqual([
      expect.objectContaining({
        taskId: created.task.id,
        role: 'assistant',
        status: 'interrupted',
        text: '',
      }),
    ]);
    database.close();
  });

  it('continues repeated cancellations in one WorkSession with ordered user references', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('command-continuation'));
    const repository = new IndexedDbTaskRepository(database);
    const conversations = new IndexedDbConversationRepository(database);
    const sources = createCommandSources();
    await conversations.create({
      id: 'conv_1',
      tabId: 7,
      title: 'Continue the task',
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    const commands = new TaskCommandService(repository, sources.clock, sources.ids, conversations);
    const created = await commands.create({
      conversationId: 'conv_1',
      tabId: 7,
      goal: 'Initial request',
      userMessageId: 'message_1',
    });

    sources.advance(1_100);
    const firstCancelled = await commands.cancel(created.task.id);
    sources.advance(1_200);
    const firstContinuation = await commands.continueCancelled({
      sourceTaskId: firstCancelled.task.id,
      tabId: 8,
      goal: 'Continue with more detail',
      userMessageId: 'message_2',
    });

    expect(firstContinuation.task.id).not.toBe(firstCancelled.task.id);
    expect(firstContinuation.task.workSessionId).toBe(firstCancelled.task.workSessionId);
    expect(firstContinuation.checkpoint.continuationItems).toEqual([
      { type: 'message_ref', messageId: 'message_1' },
      { type: 'message_ref', messageId: 'message_2' },
    ]);

    sources.advance(1_300);
    const secondCancelled = await commands.cancel(firstContinuation.task.id);
    sources.advance(1_400);
    const secondContinuation = await commands.continueCancelled({
      sourceTaskId: secondCancelled.task.id,
      tabId: 9,
      goal: 'Continue again',
      userMessageId: 'message_3',
    });

    expect(secondContinuation.task.workSessionId).toBe(created.task.workSessionId);
    expect(secondContinuation.checkpoint.continuationItems).toEqual([
      { type: 'message_ref', messageId: 'message_1' },
      { type: 'message_ref', messageId: 'message_2' },
      { type: 'message_ref', messageId: 'message_3' },
    ]);
    database.close();
  });

  it('places an unapplied cancelled-run supplement before the continuation user message', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('command-continuation-supplement-order'),
    );
    const repository = new IndexedDbTaskRepository(database);
    const conversations = new IndexedDbConversationRepository(database);
    const sources = createCommandSources();
    await conversations.create({
      id: 'conv_1',
      tabId: 7,
      title: 'Continue with supplement',
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    const commands = new TaskCommandService(repository, sources.clock, sources.ids, conversations);
    const created = await commands.create({
      conversationId: 'conv_1',
      tabId: 7,
      goal: 'Initial request',
      userMessageId: 'message_1',
    });
    await conversations.appendSupplement({
      id: 'supplement_before_cancel',
      kind: 'supplement',
      conversationId: 'conv_1',
      taskId: created.task.id,
      role: 'user',
      status: 'complete',
      text: 'Use the corrected requirement.',
      attachmentIds: [],
      createdAt: 1_050,
      updatedAt: 1_050,
    });

    sources.advance(1_100);
    const cancelled = await commands.cancel(created.task.id);
    sources.advance(1_200);
    const continued = await commands.continueCancelled({
      sourceTaskId: cancelled.task.id,
      tabId: 7,
      goal: 'Continue after cancellation',
      userMessageId: 'message_2',
    });

    expect(continued.checkpoint.continuationItems).toEqual([
      { type: 'message_ref', messageId: 'message_1' },
      { type: 'message_ref', messageId: 'supplement_before_cancel' },
      { type: 'message_ref', messageId: 'message_2' },
    ]);
    database.close();
  });

  it('keeps resumed messages before an unresolved tool call when cancellation interrupts it', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('command-continuation-pending-tool'),
    );
    const repository = new IndexedDbTaskRepository(database);
    const conversations = new IndexedDbConversationRepository(database);
    const sources = createCommandSources();
    await conversations.create({
      id: 'conv_1',
      tabId: 7,
      title: 'Continue pending tool',
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    const commands = new TaskCommandService(repository, sources.clock, sources.ids, conversations);
    const created = await commands.create({
      conversationId: 'conv_1',
      tabId: 7,
      goal: 'Initial request',
      userMessageId: 'message_1',
    });
    const planningCheckpoint = {
      ...created.checkpoint,
      id: 'checkpoint_planning',
      sequence: 1,
      taskStatus: 'planning' as const,
      createdAt: 1_100,
    };
    await repository.saveTransition({
      task: {
        ...created.task,
        status: 'planning',
        updatedAt: 1_100,
        checkpointId: planningCheckpoint.id,
      },
      event: {
        id: 'event_planning',
        taskId: created.task.id,
        sequence: 1,
        type: 'planning.started',
        reason: 'model_request_started',
        at: 1_100,
        error: null,
      },
      checkpoint: planningCheckpoint,
    });
    const pendingCheckpoint = {
      ...planningCheckpoint,
      id: 'checkpoint_pending',
      sequence: 2,
      continuationItems: [
        ...planningCheckpoint.continuationItems,
        {
          type: 'function_call' as const,
          callId: 'call_search',
          name: 'tavily_search',
          argumentsJson: '{"query":"browser recovery"}',
        },
      ],
      pendingToolCall: {
        callId: 'call_search',
        name: 'tavily_search',
        argumentsJson: '{"query":"browser recovery"}',
        executionState: 'recorded' as const,
      },
      createdAt: 1_200,
    };
    await repository.saveTransition({
      task: {
        ...created.task,
        status: 'planning',
        updatedAt: 1_200,
        checkpointId: pendingCheckpoint.id,
      },
      event: {
        id: 'event_pending',
        taskId: created.task.id,
        sequence: 2,
        type: 'tool.call-recorded',
        reason: 'tavily_search_call_recorded',
        at: 1_200,
        error: null,
      },
      checkpoint: pendingCheckpoint,
    });
    await conversations.appendMessage({
      id: 'message_partial',
      kind: 'conversation',
      conversationId: 'conv_1',
      taskId: created.task.id,
      role: 'assistant',
      status: 'interrupted',
      text: 'Partial answer before the tool call.',
      attachmentIds: [],
      createdAt: 1_150,
      updatedAt: 1_150,
    });
    await conversations.appendSupplement({
      id: 'supplement_pending',
      kind: 'supplement',
      conversationId: 'conv_1',
      taskId: created.task.id,
      role: 'user',
      status: 'complete',
      text: 'Use the corrected domain.',
      attachmentIds: [],
      createdAt: 1_250,
      updatedAt: 1_250,
    });

    sources.advance(1_300);
    const cancelled = await commands.cancel(created.task.id);
    sources.advance(1_400);
    const continued = await commands.continueCancelled({
      sourceTaskId: cancelled.task.id,
      tabId: 7,
      goal: 'Continue after the pending call',
      userMessageId: 'message_2',
    });

    expect(continued.checkpoint.continuationItems).toEqual([
      { type: 'message_ref', messageId: 'message_1' },
      { type: 'message_ref', messageId: 'message_partial' },
      { type: 'message_ref', messageId: 'supplement_pending' },
      { type: 'message_ref', messageId: 'message_2' },
      {
        type: 'function_call',
        callId: 'call_search',
        name: 'tavily_search',
        argumentsJson: '{"query":"browser recovery"}',
      },
    ]);
    expect(continued.checkpoint.pendingToolCall).toEqual(pendingCheckpoint.pendingToolCall);
    database.close();
  });

  it('keeps partial assistant output without appending a cancellation placeholder', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('command-cancel-partial'),
    );
    const repository = new IndexedDbTaskRepository(database);
    const conversations = new IndexedDbConversationRepository(database);
    const sources = createCommandSources();
    await conversations.create({
      id: 'conv_1',
      tabId: 7,
      title: 'Partial reply',
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    const commands = new TaskCommandService(repository, sources.clock, sources.ids, conversations);
    const created = await commands.create({
      conversationId: 'conv_1',
      tabId: 7,
      goal: 'Keep partial output',
      userMessageId: 'message_1',
    });
    await conversations.appendMessage({
      id: 'message_partial',
      kind: 'conversation',
      conversationId: 'conv_1',
      taskId: created.task.id,
      role: 'assistant',
      status: 'interrupted',
      text: 'Partial output',
      attachmentIds: [],
      createdAt: 1_010,
      updatedAt: 1_010,
    });

    sources.advance(1_100);
    const cancelled = await commands.cancel(created.task.id);
    await commands.cancel(created.task.id);

    sources.advance(1_200);
    const continued = await commands.continueCancelled({
      sourceTaskId: cancelled.task.id,
      tabId: 7,
      goal: 'Continue after partial output',
      userMessageId: 'message_2',
    });

    await expect(conversations.listMessages('conv_1')).resolves.toEqual([
      expect.objectContaining({
        id: 'message_partial',
        status: 'interrupted',
        text: 'Partial output',
      }),
    ]);
    expect(continued.checkpoint.continuationItems).toEqual([
      { type: 'message_ref', messageId: 'message_1' },
      { type: 'message_ref', messageId: 'message_partial' },
      { type: 'message_ref', messageId: 'message_2' },
    ]);
    database.close();
  });

  it('retries the same failed task with a fresh queued checkpoint and no stale error or lease', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('command-retry'));
    const repository = new IndexedDbTaskRepository(database);
    const sources = createCommandSources();
    const commands = new TaskCommandService(
      repository,
      sources.clock,
      sources.ids,
      new IndexedDbConversationRepository(database),
    );
    const created = await commands.create({
      conversationId: 'conv_1',
      tabId: 7,
      goal: 'Complete the page',
      userMessageId: 'message_1',
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
    const commands = new TaskCommandService(
      repository,
      sources.clock,
      sources.ids,
      new IndexedDbConversationRepository(database),
    );

    await expect(commands.getSnapshot('missing')).rejects.toEqual(
      expect.objectContaining({ code: 'TASK_NOT_FOUND' }),
    );
    database.close();
  });
});
