// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IndexedDbAttachmentRepository } from '../../src/persistence/attachment-repository';
import { IndexedDbConversationRepository } from '../../src/persistence/conversation-repository';
import { openChatBrowserDatabase } from '../../src/persistence/open-database';
import { IndexedDbTaskRepository } from '../../src/persistence/task-repository';
import type { Checkpoint } from '../../src/tasks/checkpoint-types';
import type { Conversation } from '../../src/tasks/conversation-types';
import type { MessageRecord } from '../../src/tasks/message-types';
import type { Task, TaskEvent, TaskRun } from '../../src/tasks/task-types';
import type { ToolResult } from '../../src/tasks/tool-result-types';
import { createTestDatabaseName, seedConversation, seedTask } from './test-helpers';

const conversation: Conversation = {
  id: 'conversation_1',
  tabId: 7,
  title: 'Fixture task',
  createdAt: 1,
  updatedAt: 1,
};

function durableRecords(status: Task['status'] = 'queued') {
  const task: Task = {
    id: 'task_1',
    conversationId: conversation.id,
    ordinal: 1,
    tabId: 7,
    goal: 'Inspect the page',
    status,
    latestRunId: 'run_1',
    lastEventSequence: 2,
    createdAt: 2,
    updatedAt: 3,
  };
  const run: TaskRun = {
    id: 'run_1',
    taskId: task.id,
    attempt: 1,
    status,
    checkpointId: status === 'completed' ? null : 'checkpoint_1',
    lease: null,
    error: null,
    startedAt: 2,
    endedAt: status === 'completed' ? 3 : null,
  };
  const message: MessageRecord = {
    id: 'message_1',
    kind: 'conversation',
    conversationId: conversation.id,
    taskId: task.id,
    role: 'user',
    status: 'complete',
    text: 'Inspect the page',
    attachmentIds: ['attachment_1'],
    createdAt: 2,
    updatedAt: 2,
  };
  const events: TaskEvent[] = [
    {
      id: 'event_1',
      taskId: task.id,
      runId: run.id,
      sequence: 1,
      at: 2,
      type: 'message.recorded',
      messageId: message.id,
    },
    {
      id: 'event_2',
      taskId: task.id,
      runId: run.id,
      sequence: 2,
      at: 3,
      type: 'status.changed',
      taskStatus: status,
      runStatus: status,
      reason: `task.${status}`,
      error: null,
    },
  ];
  const checkpoint: Checkpoint = {
    id: 'checkpoint_1',
    taskId: task.id,
    runId: run.id,
    continuationItems: [{ type: 'message_ref', messageId: message.id }],
    pendingToolCall: null,
    browserToolCallsInAttempt: 0,
    browserTargetTabId: 7,
    createdAt: 2,
  };
  return { task, run, message, events, checkpoint };
}

describe('IndexedDbConversationRepository', () => {
  it('lists global conversations by most recent activity', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('conversation-global'));
    const conversations = new IndexedDbConversationRepository(database);
    await seedConversation(database, { ...conversation, id: 'older', updatedAt: 20 });
    await seedConversation(database, { ...conversation, id: 'newer', tabId: 9, updatedAt: 40 });

    expect((await conversations.listAll()).map(({ id }) => id)).toEqual(['newer', 'older']);
    database.close();
  });

  it('lists only messages owned by one task', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('messages-by-task'));
    const conversations = new IndexedDbConversationRepository(database);
    const records = durableRecords();
    await seedConversation(database, conversation);
    await database.add('messages', records.message);
    await database.add('messages', {
      ...records.message,
      id: 'message_other_task',
      taskId: 'task_other',
      createdAt: 4,
      updatedAt: 4,
    });

    await expect(conversations.listTaskMessages(records.task.id)).resolves.toEqual([
      records.message,
    ]);
    database.close();
  });

  it('lists only the newest bounded conversation messages in stable order', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('recent-messages'));
    const conversations = new IndexedDbConversationRepository(database);
    await seedConversation(database, conversation);
    for (let index = 1; index <= 5; index += 1) {
      await database.add('messages', {
        id: `message_${index}`,
        kind: 'conversation',
        conversationId: conversation.id,
        taskId: `task_${index}`,
        role: 'user',
        status: 'complete',
        text: `message ${index}`,
        attachmentIds: [],
        createdAt: index,
        updatedAt: index,
      });
    }

    await expect(conversations.listRecentMessages(conversation.id, 2)).resolves.toMatchObject([
      { id: 'message_4', createdAt: 4 },
      { id: 'message_5', createdAt: 5 },
    ]);
    database.close();
  });

  it('updates one canonical message and reconciles attachment references', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('message-update'));
    const conversations = new IndexedDbConversationRepository(database);
    const attachments = new IndexedDbAttachmentRepository(database);
    const records = durableRecords();
    await seedConversation(database, conversation);
    for (const id of ['attachment_1', 'attachment_2']) {
      await attachments.put({
        id,
        blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
        mimeType: 'image/png',
        byteSize: 1,
        width: 1,
        height: 1,
        source: 'file',
        createdAt: 1,
      });
    }
    await database.add('messages', records.message);
    await attachments.addReference('attachment_1', `message:${records.message.id}`);

    await conversations.updateMessage({
      ...records.message,
      status: 'interrupted',
      text: 'Partial assistant response',
      attachmentIds: ['attachment_2'],
      updatedAt: 5,
    });

    await expect(conversations.listMessages(conversation.id)).resolves.toEqual([
      expect.objectContaining({
        status: 'interrupted',
        text: 'Partial assistant response',
        attachmentIds: ['attachment_2'],
      }),
    ]);
    expect(
      await database.get('attachment-references', [
        'attachment_1',
        `message:${records.message.id}`,
      ]),
    ).toBeUndefined();
    expect(
      await database.get('attachment-references', [
        'attachment_2',
        `message:${records.message.id}`,
      ]),
    ).toBeDefined();
    await expect(attachments.deleteUnreferenced(10)).resolves.toBe(1);
    database.close();
  });

  it('rejects clearing a conversation with an unfinished logical task', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('conversation-active'));
    const conversations = new IndexedDbConversationRepository(database);
    const { task } = durableRecords('planning');
    await seedConversation(database, conversation);
    await seedTask(database, task);

    await expect(conversations.clearConversation(conversation.id)).rejects.toThrow(
      /non-terminal task/i,
    );
    await expect(conversations.get(conversation.id)).resolves.toEqual(conversation);
    database.close();
  });

  it('cascades permanent task facts, runtime state, and all attachment references', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('conversation-cascade'));
    const conversations = new IndexedDbConversationRepository(database);
    const tasks = new IndexedDbTaskRepository(database);
    const attachments = new IndexedDbAttachmentRepository(database);
    const records = durableRecords('completed');
    const result: ToolResult = {
      id: 'result_1',
      taskId: records.task.id,
      runId: records.run.id,
      callId: 'call_1',
      toolName: 'browser_capture_screenshot',
      output: '{"ok":true}',
      attachmentIds: ['attachment_2'],
      createdAt: 3,
    };
    await seedConversation(database, conversation);
    for (const id of ['attachment_1', 'attachment_2']) {
      await attachments.put({
        id,
        blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
        mimeType: 'image/png',
        byteSize: 1,
        width: 1,
        height: 1,
        source: 'file',
        createdAt: 1,
      });
    }
    await database.add('messages', records.message);
    await database.add('tasks', records.task);
    await database.add('task-runs', records.run);
    for (const event of records.events) await database.add('task-events', event);
    await database.add('tool-results', result);
    await database.add('checkpoints', records.checkpoint);
    await attachments.addReference('attachment_1', `message:${records.message.id}`);
    await attachments.addReference('attachment_2', result.id);

    await conversations.clearConversation(conversation.id);

    await expect(conversations.get(conversation.id)).resolves.toBeUndefined();
    await expect(tasks.get(records.task.id)).resolves.toBeUndefined();
    await expect(tasks.listRuns(records.task.id)).resolves.toEqual([]);
    await expect(tasks.listEvents(records.task.id)).resolves.toEqual([]);
    await expect(tasks.listToolResults(records.task.id)).resolves.toEqual([]);
    await expect(tasks.getCheckpoint(records.checkpoint.id)).resolves.toBeUndefined();
    await expect(attachments.deleteUnreferenced(10)).resolves.toBe(2);
    database.close();
  });
});
