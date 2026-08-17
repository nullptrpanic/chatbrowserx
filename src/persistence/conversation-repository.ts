import type { IDBPDatabase } from 'idb';
import type { ConversationId } from '../shared/ids';
import type { Conversation } from '../tasks/conversation-types';
import type { MessageRecord } from '../tasks/message-types';
import type { TaskStatus } from '../tasks/task-types';
import type { ChatBrowserDatabase } from './database-schema';

export interface ConversationRepository {
  create(conversation: Conversation): Promise<void>;
  get(conversationId: ConversationId): Promise<Conversation | undefined>;
  listAll(): Promise<Conversation[]>;
  listByTab(tabId: number): Promise<Conversation[]>;
  listMessages(conversationId: ConversationId): Promise<MessageRecord[]>;
  appendMessage(message: MessageRecord): Promise<void>;
  updateMessage(message: MessageRecord): Promise<void>;
  clearConversation(conversationId: ConversationId): Promise<void>;
}

const terminalStatuses = new Set<TaskStatus>(['completed', 'failed', 'cancelled']);

/**
 * Builds a compound-key range that contains all time-ordered records for one owner ID.
 */
function ownerTimeRange(ownerId: string): IDBKeyRange {
  return IDBKeyRange.bound([ownerId, 0], [ownerId, Number.MAX_SAFE_INTEGER]);
}

/**
 * Deletes every string key returned by an IndexedDB index from its owning object store.
 */
async function deleteStringKeys(
  keys: readonly IDBValidKey[],
  deleteKey: (key: string) => Promise<unknown>,
): Promise<void> {
  for (const key of keys) {
    if (typeof key !== 'string') {
      throw new Error('Unexpected non-string durable record key.');
    }
    await deleteKey(key);
  }
}

export class IndexedDbConversationRepository implements ConversationRepository {
  readonly #database: IDBPDatabase<ChatBrowserDatabase>;

  /**
   * Creates a conversation repository over an already opened application database.
   */
  constructor(database: IDBPDatabase<ChatBrowserDatabase>) {
    this.#database = database;
  }

  /**
   * Inserts one new conversation and rejects identifier collisions.
   */
  async create(conversation: Conversation): Promise<void> {
    await this.#database.add('conversations', conversation);
  }

  /**
   * Retrieves one conversation by its stable identifier.
   */
  async get(conversationId: ConversationId): Promise<Conversation | undefined> {
    return this.#database.get('conversations', conversationId);
  }

  /**
   * Lists conversations from every browser tab by most recent activity.
   */
  async listAll(): Promise<Conversation[]> {
    const conversations = await this.#database.getAll('conversations');
    return conversations.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  /**
   * Lists conversations for one tab from most recently to least recently updated.
   */
  async listByTab(tabId: number): Promise<Conversation[]> {
    const conversations = await this.#database.getAllFromIndex(
      'conversations',
      'by-tab-updated-at',
      IDBKeyRange.bound([tabId, 0], [tabId, Number.MAX_SAFE_INTEGER]),
    );
    return conversations.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  /**
   * Lists messages for one conversation in stable creation order.
   */
  async listMessages(conversationId: ConversationId): Promise<MessageRecord[]> {
    return this.#database.getAllFromIndex(
      'messages',
      'by-conversation-created-at',
      ownerTimeRange(conversationId),
    );
  }

  /**
   * Appends one message and attachment references atomically with conversation activity.
   */
  async appendMessage(message: MessageRecord): Promise<void> {
    const transaction = this.#database.transaction(
      ['conversations', 'messages', 'attachments', 'attachment-references'],
      'readwrite',
    );
    const conversation = await transaction.objectStore('conversations').get(message.conversationId);
    if (conversation === undefined) {
      throw new Error('Conversation does not exist.');
    }

    for (const attachmentId of message.attachmentIds) {
      const attachment = await transaction.objectStore('attachments').get(attachmentId);
      if (attachment === undefined) {
        throw new Error('Attachment does not exist.');
      }
    }

    await transaction.objectStore('messages').add(message);
    for (const attachmentId of message.attachmentIds) {
      await transaction.objectStore('attachment-references').put({
        attachmentId,
        referenceId: `message:${message.id}`,
      });
    }
    await transaction.objectStore('conversations').put({
      ...conversation,
      updatedAt: Math.max(conversation.updatedAt, message.updatedAt),
    });
    await transaction.done;
  }

  /**
   * Replaces one message while atomically reconciling any changed attachment references.
   */
  async updateMessage(message: MessageRecord): Promise<void> {
    const transaction = this.#database.transaction(
      ['conversations', 'messages', 'attachments', 'attachment-references'],
      'readwrite',
    );
    const existing = await transaction.objectStore('messages').get(message.id);
    if (existing === undefined || existing.conversationId !== message.conversationId) {
      throw new Error('Message does not exist in the supplied conversation.');
    }
    const conversation = await transaction.objectStore('conversations').get(message.conversationId);
    if (conversation === undefined) {
      throw new Error('Conversation does not exist.');
    }

    const previousIds = new Set(existing.attachmentIds);
    const nextIds = new Set(message.attachmentIds);
    for (const attachmentId of nextIds) {
      if (!previousIds.has(attachmentId)) {
        const attachment = await transaction.objectStore('attachments').get(attachmentId);
        if (attachment === undefined) {
          throw new Error('Attachment does not exist.');
        }
        await transaction.objectStore('attachment-references').put({
          attachmentId,
          referenceId: `message:${message.id}`,
        });
      }
    }
    for (const attachmentId of previousIds) {
      if (!nextIds.has(attachmentId)) {
        await transaction
          .objectStore('attachment-references')
          .delete([attachmentId, `message:${message.id}`]);
      }
    }

    await transaction.objectStore('messages').put(message);
    await transaction.objectStore('conversations').put({
      ...conversation,
      updatedAt: Math.max(conversation.updatedAt, message.updatedAt),
    });
    await transaction.done;
  }

  /**
   * Clears one terminal conversation aggregate and its attachment references in a transaction.
   */
  async clearConversation(conversationId: ConversationId): Promise<void> {
    const transaction = this.#database.transaction(
      ['conversations', 'messages', 'tasks', 'task-events', 'checkpoints', 'attachment-references'],
      'readwrite',
    );
    const tasks = await transaction
      .objectStore('tasks')
      .index('by-conversation')
      .getAll(conversationId);
    if (tasks.some((task) => !terminalStatuses.has(task.status))) {
      throw new Error('Cannot clear a conversation with a non-terminal task.');
    }

    const messages = await transaction
      .objectStore('messages')
      .index('by-conversation-created-at')
      .getAll(ownerTimeRange(conversationId));
    for (const message of messages) {
      await transaction.objectStore('messages').delete(message.id);
      for (const attachmentId of message.attachmentIds) {
        await transaction
          .objectStore('attachment-references')
          .delete([attachmentId, `message:${message.id}`]);
      }
    }

    for (const task of tasks) {
      const eventKeys = await transaction
        .objectStore('task-events')
        .index('by-task-sequence')
        .getAllKeys(ownerTimeRange(task.id));
      await deleteStringKeys(eventKeys, (key) =>
        transaction.objectStore('task-events').delete(key),
      );

      const checkpointKeys = await transaction
        .objectStore('checkpoints')
        .index('by-task')
        .getAllKeys(task.id);
      await deleteStringKeys(checkpointKeys, (key) =>
        transaction.objectStore('checkpoints').delete(key),
      );

      await transaction.objectStore('tasks').delete(task.id);
    }

    await transaction.objectStore('conversations').delete(conversationId);
    await transaction.done;
  }
}
