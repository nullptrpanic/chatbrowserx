// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IndexedDbAttachmentRepository } from '../../src/persistence/attachment-repository';
import { IndexedDbConversationRepository } from '../../src/persistence/conversation-repository';
import { openChatBrowserDatabase } from '../../src/persistence/open-database';
import { IndexedDbTaskRepository } from '../../src/persistence/task-repository';
import { createTask } from '../../src/tasks/task-factory';
import type { Conversation } from '../../src/tasks/conversation-types';
import type { MessageRecord } from '../../src/tasks/message-types';
import { createTestDatabaseName } from './test-helpers';

const conversation: Conversation = {
  id: 'conv_1',
  tabId: 7,
  title: 'Fixture task',
  createdAt: 1,
  updatedAt: 1,
};

const message: MessageRecord = {
  id: 'message_1',
  conversationId: conversation.id,
  taskId: null,
  role: 'user',
  status: 'streaming',
  text: 'Hello',
  attachmentIds: ['attachment_1'],
  createdAt: 2,
  updatedAt: 2,
};

describe('IndexedDbConversationRepository', () => {
  it('orders messages, updates streaming text, and clears attachment references transactionally', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('conversation'));
    const conversations = new IndexedDbConversationRepository(database);
    const attachments = new IndexedDbAttachmentRepository(database);
    await conversations.create(conversation);
    await attachments.put({
      id: 'attachment_1',
      blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      mimeType: 'image/png',
      byteSize: 1,
      width: 1,
      height: 1,
      source: 'file',
      createdAt: 1,
    });
    await attachments.put({
      id: 'attachment_2',
      blob: new Blob([new Uint8Array([2])], { type: 'image/png' }),
      mimeType: 'image/png',
      byteSize: 1,
      width: 1,
      height: 1,
      source: 'file',
      createdAt: 1,
    });

    await conversations.appendMessage(message);
    await conversations.updateMessage({
      ...message,
      status: 'complete',
      text: 'Hello world',
      attachmentIds: ['attachment_2'],
      updatedAt: 3,
    });

    await expect(conversations.listByTab(7)).resolves.toEqual([
      expect.objectContaining({ id: conversation.id, updatedAt: 3 }),
    ]);
    await expect(conversations.listMessages(conversation.id)).resolves.toEqual([
      expect.objectContaining({
        status: 'complete',
        text: 'Hello world',
        attachmentIds: ['attachment_2'],
      }),
    ]);
    await expect(attachments.deleteUnreferenced(10)).resolves.toBe(1);
    await expect(attachments.get('attachment_1')).resolves.toBeUndefined();
    await expect(attachments.get('attachment_2')).resolves.toBeDefined();

    await conversations.clearConversation(conversation.id);
    await expect(conversations.get(conversation.id)).resolves.toBeUndefined();
    await expect(conversations.listMessages(conversation.id)).resolves.toEqual([]);
    await expect(attachments.deleteUnreferenced(10)).resolves.toBe(1);
    database.close();
  });

  it('rejects clearing a conversation with a non-terminal task', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('conversation-active'));
    const conversations = new IndexedDbConversationRepository(database);
    const tasks = new IndexedDbTaskRepository(database);
    await conversations.create(conversation);
    await tasks.create(
      createTask(
        { conversationId: conversation.id, tabId: 7, goal: 'Still running' },
        { clock: { now: () => 2 }, ids: { create: () => 'task_1' } },
      ),
    );

    await expect(conversations.clearConversation(conversation.id)).rejects.toThrow(
      /non-terminal task/i,
    );
    await expect(conversations.get(conversation.id)).resolves.toEqual(conversation);
    database.close();
  });

  it('rejects a message that references a missing attachment', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('conversation-missing'));
    const conversations = new IndexedDbConversationRepository(database);
    await conversations.create(conversation);

    await expect(conversations.appendMessage(message)).rejects.toThrow(
      /attachment does not exist/i,
    );
    await expect(conversations.listMessages(conversation.id)).resolves.toEqual([]);
    database.close();
  });

  it('cascades terminal task events and checkpoints when clearing history', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('conversation-cascade'));
    const conversations = new IndexedDbConversationRepository(database);
    const tasks = new IndexedDbTaskRepository(database);
    await conversations.create(conversation);
    const queued = createTask(
      { conversationId: conversation.id, tabId: 7, goal: 'Completed work' },
      { clock: { now: () => 2 }, ids: { create: () => 'task_terminal' } },
    );
    await tasks.create(queued);
    const completed = {
      ...queued,
      status: 'completed' as const,
      updatedAt: 3,
      checkpointId: 'checkpoint_terminal',
    };
    await tasks.saveTransition({
      task: completed,
      event: {
        id: 'event_terminal',
        taskId: completed.id,
        sequence: 1,
        type: 'task.completed',
        reason: 'Goal verified.',
        at: 3,
        error: null,
      },
      checkpoint: {
        id: 'checkpoint_terminal',
        taskId: completed.id,
        sequence: 1,
        taskStatus: 'completed',
        completedToolResults: [],
        observationRef: null,
        pendingAction: null,
        createdAt: 3,
      },
    });

    await conversations.clearConversation(conversation.id);

    await expect(tasks.get(completed.id)).resolves.toBeUndefined();
    await expect(tasks.listEvents(completed.id)).resolves.toEqual([]);
    await expect(tasks.getCheckpoint('checkpoint_terminal')).resolves.toBeUndefined();
    database.close();
  });
});
