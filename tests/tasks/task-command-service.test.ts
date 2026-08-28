// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IndexedDbConversationRepository } from '../../src/persistence/conversation-repository';
import { openChatBrowserDatabase } from '../../src/persistence/open-database';
import { IndexedDbTaskRepository } from '../../src/persistence/task-repository';
import type { Conversation } from '../../src/tasks/conversation-types';
import type { MessageRecord, TaskMessageDraft } from '../../src/tasks/message-types';
import {
  TaskCommandError,
  TaskCommandService,
  type TaskSnapshot,
} from '../../src/tasks/task-command-service';
import type { TaskEvent } from '../../src/tasks/task-types';
import { createTestDatabaseName } from '../persistence/test-helpers';

function dependencies(label: string) {
  let now = 100;
  let identifier = 0;
  return {
    databaseName: createTestDatabaseName(label),
    clock: { now: () => ++now },
    ids: { create: (prefix: string) => `${prefix}_${String(++identifier)}` },
  };
}

function conversation(id = 'conversation_1'): Conversation {
  return { id, tabId: 7, title: 'Fixture conversation', createdAt: 100, updatedAt: 100 };
}

function userMessage(conversationId: string, id = 'message_user'): TaskMessageDraft {
  return {
    id,
    kind: 'conversation',
    conversationId,
    role: 'user',
    status: 'complete',
    text: 'Inspect this page',
    attachmentIds: [],
    createdAt: 101,
    updatedAt: 101,
  };
}

async function setup(label: string) {
  const source = dependencies(label);
  const database = await openChatBrowserDatabase(source.databaseName);
  const repository = new IndexedDbTaskRepository(database);
  const conversations = new IndexedDbConversationRepository(database);
  const commands = new TaskCommandService(repository, source.clock, source.ids, conversations);
  return { ...source, database, repository, conversations, commands };
}

async function createSubmission(
  setupResult: Awaited<ReturnType<typeof setup>>,
  conversationRecord = conversation(),
): Promise<TaskSnapshot> {
  return setupResult.commands.createSubmission({
    conversation: conversationRecord,
    createConversation: true,
    conversationId: conversationRecord.id,
    tabId: conversationRecord.tabId ?? 0,
    goal: 'Inspect this page',
    message: userMessage(conversationRecord.id),
  });
}

async function markFailed(
  setupResult: Awaited<ReturnType<typeof setup>>,
  snapshot: TaskSnapshot,
): Promise<void> {
  if (snapshot.checkpoint === null) throw new Error('Expected a checkpoint.');
  const at = setupResult.clock.now();
  const event: TaskEvent = {
    id: setupResult.ids.create('event'),
    taskId: snapshot.task.id,
    runId: snapshot.run.id,
    sequence: snapshot.task.lastEventSequence + 1,
    at,
    type: 'status.changed',
    taskStatus: 'failed',
    runStatus: 'failed',
    reason: 'provider_failed',
    error: {
      code: 'TransientProviderError',
      retryable: true,
      recoveryAction: 'resume_task',
      userMessage: 'Provider unavailable.',
      evidenceRef: null,
    },
  };
  await setupResult.repository.saveTransition({
    task: {
      ...snapshot.task,
      status: 'failed',
      lastEventSequence: event.sequence,
      updatedAt: at,
    },
    run: {
      ...snapshot.run,
      status: 'failed',
      lease: null,
      error: event.error,
      endedAt: at,
    },
    events: [event],
    checkpoint: snapshot.checkpoint,
  });
}

describe('TaskCommandService', () => {
  it('creates one stable task, first run, message event, and runtime checkpoint', async () => {
    const fixture = await setup('command-create');
    const created = await createSubmission(fixture);

    expect(created).toMatchObject({
      task: { ordinal: 1, status: 'queued', lastEventSequence: 2 },
      run: { attempt: 1, status: 'queued' },
      checkpoint: { browserTargetTabId: 7 },
      events: [
        { sequence: 1, type: 'message.recorded', messageId: 'message_user' },
        { sequence: 2, type: 'status.changed', taskStatus: 'queued' },
      ],
    });
    expect(
      (await fixture.conversations.listMessages(created.task.conversationId))[0],
    ).toMatchObject({
      id: 'message_user',
      taskId: created.task.id,
    });
    fixture.database.close();
  });

  it('pauses the current run and resumes with another run under the same task', async () => {
    const fixture = await setup('command-resume');
    const created = await createSubmission(fixture);
    const paused = await fixture.commands.pause(created.task.id);
    const resumed = await fixture.commands.resume(created.task.id);

    expect(paused).toMatchObject({
      task: { id: created.task.id, status: 'paused', lastEventSequence: 3 },
      run: { id: created.run.id, attempt: 1, status: 'paused' },
    });
    expect(resumed).toMatchObject({
      task: { id: created.task.id, status: 'queued', lastEventSequence: 4 },
      run: { attempt: 2, status: 'queued' },
      events: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }, { sequence: 4 }],
    });
    expect(resumed.run.id).not.toBe(created.run.id);
    expect(await fixture.repository.getRun(created.run.id)).toMatchObject({ checkpointId: null });
    expect(await fixture.repository.getCheckpoint(created.checkpoint?.id ?? '')).toBeUndefined();
    fixture.database.close();
  });

  it('cancels a paused task and releases the global submission slot', async () => {
    const fixture = await setup('command-cancel-paused');
    const created = await createSubmission(fixture);
    await fixture.commands.pause(created.task.id);

    const cancelled = await fixture.commands.cancel(created.task.id);
    const nextConversation = conversation('conversation_after_cancel');
    const next = await fixture.commands.createSubmission({
      conversation: nextConversation,
      createConversation: true,
      conversationId: nextConversation.id,
      tabId: nextConversation.tabId ?? 0,
      goal: 'Run the next task',
      message: userMessage(nextConversation.id, 'message_after_cancel'),
    });

    expect(cancelled.task.status).toBe('cancelled');
    expect(next.task.status).toBe('queued');
    fixture.database.close();
  });

  it('retries a failed run without changing the logical task identity', async () => {
    const fixture = await setup('command-retry');
    const created = await createSubmission(fixture);
    await markFailed(fixture, created);
    const retried = await fixture.commands.retry(created.task.id);

    expect(retried.task.id).toBe(created.task.id);
    expect(retried).toMatchObject({
      task: { status: 'queued', lastEventSequence: 4 },
      run: { attempt: 2, status: 'queued', error: null },
      events: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }, { sequence: 4 }],
    });
    fixture.database.close();
  });

  it('reports the global running-task conflict when retrying an older task', async () => {
    const fixture = await setup('command-retry-busy');
    const created = await createSubmission(fixture);
    await markFailed(fixture, created);
    const otherConversation = conversation('conversation_other');
    await fixture.commands.createSubmission({
      conversation: otherConversation,
      createConversation: true,
      conversationId: otherConversation.id,
      tabId: 8,
      goal: 'Run another task',
      message: userMessage(otherConversation.id, 'message_other'),
    });

    await expect(fixture.commands.retry(created.task.id)).rejects.toMatchObject({
      code: 'TASK_ALREADY_RUNNING',
      message: '已有任务运行中',
    });
    fixture.database.close();
  });

  it('retains a durable assistant bubble and returns its latest event after cancellation', async () => {
    const fixture = await setup('command-cancel-retention');
    const created = await createSubmission(fixture);
    const cancelled = await fixture.commands.cancel(created.task.id);

    expect(cancelled).toMatchObject({
      task: { status: 'cancelled', lastEventSequence: 4 },
      run: { status: 'cancelled' },
      events: [
        { sequence: 1, type: 'message.recorded' },
        { sequence: 2, type: 'status.changed' },
        { sequence: 3, type: 'status.changed', taskStatus: 'cancelled' },
        { sequence: 4, type: 'message.recorded' },
      ],
    });
    expect(await fixture.conversations.listMessages(created.task.conversationId)).toContainEqual(
      expect.objectContaining({
        taskId: created.task.id,
        role: 'assistant',
        status: 'interrupted',
        text: '',
      }),
    );
    fixture.database.close();
  });

  it('continues a cancelled task with a new run and a chronologically placed user message', async () => {
    const fixture = await setup('command-cancel-continuation');
    const created = await createSubmission(fixture);
    const cancelled = await fixture.commands.cancel(created.task.id);
    const nextMessage = userMessage(created.task.conversationId, 'message_continue');
    const continued = await fixture.commands.continueCancelledSubmission({
      sourceTaskId: created.task.id,
      tabId: 9,
      conversation: conversation(created.task.conversationId),
      message: { ...nextMessage, text: 'Continue with more detail' },
    });

    expect(continued).toMatchObject({
      task: {
        id: created.task.id,
        ordinal: created.task.ordinal,
        tabId: 9,
        status: 'queued',
        lastEventSequence: cancelled.task.lastEventSequence + 2,
      },
      run: { attempt: 2, status: 'queued' },
    });
    expect(continued.events.slice(-2)).toMatchObject([
      { type: 'message.recorded', messageId: nextMessage.id },
      { type: 'status.changed', taskStatus: 'queued' },
    ]);
    expect(continued.checkpoint?.continuationItems.at(-1)).toEqual({
      type: 'message_ref',
      messageId: nextMessage.id,
    });
    fixture.database.close();
  });

  it('records pending supplements as applied when a cancelled task starts its next run', async () => {
    const fixture = await setup('command-cancel-supplement-continuation');
    const created = await createSubmission(fixture);
    const supplement: MessageRecord = {
      id: 'supplement_before_cancel',
      kind: 'supplement',
      conversationId: created.task.conversationId,
      taskId: created.task.id,
      role: 'user',
      status: 'complete',
      text: 'Use the newer requirement.',
      attachmentIds: [],
      createdAt: 102,
      updatedAt: 102,
    };
    await fixture.commands.appendSupplement(supplement);
    const cancelled = await fixture.commands.cancel(created.task.id);
    const nextMessage = userMessage(created.task.conversationId, 'message_after_supplement');

    const continued = await fixture.commands.continueCancelledSubmission({
      sourceTaskId: created.task.id,
      tabId: 9,
      conversation: conversation(created.task.conversationId),
      message: nextMessage,
    });

    expect(continued.events.slice(-3)).toMatchObject([
      {
        sequence: cancelled.task.lastEventSequence + 1,
        type: 'supplement.applied',
        messageId: supplement.id,
      },
      {
        sequence: cancelled.task.lastEventSequence + 2,
        type: 'message.recorded',
        messageId: nextMessage.id,
      },
      {
        sequence: cancelled.task.lastEventSequence + 3,
        type: 'status.changed',
        taskStatus: 'queued',
      },
    ]);
    expect(continued.checkpoint?.continuationItems).toEqual(
      expect.arrayContaining([
        { type: 'message_ref', messageId: supplement.id },
        { type: 'message_ref', messageId: nextMessage.id },
      ]),
    );
    fixture.database.close();
  });

  it('queues a supplement as one canonical message and one exact task event', async () => {
    const fixture = await setup('command-supplement');
    const created = await createSubmission(fixture);
    const supplement: MessageRecord = {
      id: 'supplement_1',
      kind: 'supplement',
      conversationId: created.task.conversationId,
      taskId: created.task.id,
      role: 'user',
      status: 'complete',
      text: 'Use only official sources.',
      attachmentIds: [],
      createdAt: 110,
      updatedAt: 110,
    };
    await fixture.commands.appendSupplement(supplement);

    expect(await fixture.repository.listEvents(created.task.id)).toMatchObject([
      { sequence: 1 },
      { sequence: 2 },
      { sequence: 3, type: 'supplement.queued', messageId: supplement.id },
    ]);
    expect(await fixture.conversations.listMessages(created.task.conversationId)).toContainEqual(
      supplement,
    );
    fixture.database.close();
  });

  it('clears only resumable context while retaining permanent task facts', async () => {
    const fixture = await setup('command-clear-context');
    const created = await createSubmission(fixture);
    const cancelled = await fixture.commands.cancel(created.task.id);
    const cleared = await fixture.commands.clearContext(created.task.id);

    expect(cleared).toMatchObject({
      task: { id: created.task.id, status: 'cancelled' },
      run: { id: cancelled.run.id, checkpointId: null },
      checkpoint: null,
    });
    expect(cleared.events.at(-1)).toMatchObject({ type: 'context.cleared' });
    expect(await fixture.repository.readTaskArchive(created.task.id)).toMatchObject({
      task: { id: created.task.id },
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'message.recorded' }),
        expect.objectContaining({ type: 'context.cleared' }),
      ]),
    });
    await expect(
      fixture.commands.continueCancelledSubmission({
        sourceTaskId: created.task.id,
        tabId: 7,
        conversation: conversation(created.task.conversationId),
        message: userMessage(created.task.conversationId, 'message_after_clear'),
      }),
    ).rejects.toMatchObject({ code: 'TASK_STATE_INVALID' });
    fixture.database.close();
  });

  it('rejects invalid lifecycle commands without mutating durable state', async () => {
    const fixture = await setup('command-invalid');
    const created = await createSubmission(fixture);
    await expect(fixture.commands.clearContext(created.task.id)).rejects.toBeInstanceOf(
      TaskCommandError,
    );
    await expect(fixture.commands.getSnapshot('missing_task')).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
    expect(
      (await fixture.repository.listEvents(created.task.id)).map(({ sequence }) => sequence),
    ).toEqual([1, 2]);
    fixture.database.close();
  });
});
