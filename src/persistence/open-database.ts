import { openDB, type IDBPDatabase } from 'idb';
import {
  DATABASE_VERSION,
  DEFAULT_DATABASE_NAME,
  type ChatBrowserDatabase,
} from './database-schema';

/**
 * Creates the complete version-one schema when opening a new ChatBrowserX database.
 */
function upgradeDatabase(database: IDBPDatabase<ChatBrowserDatabase>, oldVersion: number): void {
  if (oldVersion >= 1) {
    return;
  }

  const conversations = database.createObjectStore('conversations', { keyPath: 'id' });
  conversations.createIndex('by-tab-updated-at', ['tabId', 'updatedAt']);

  const messages = database.createObjectStore('messages', { keyPath: 'id' });
  messages.createIndex('by-conversation-created-at', ['conversationId', 'createdAt']);

  const tasks = database.createObjectStore('tasks', { keyPath: 'id' });
  tasks.createIndex('by-status', 'status');
  tasks.createIndex('by-updated-at', 'updatedAt');
  tasks.createIndex('by-conversation', 'conversationId');

  const taskEvents = database.createObjectStore('task-events', { keyPath: 'id' });
  taskEvents.createIndex('by-task-sequence', ['taskId', 'sequence'], { unique: true });

  const checkpoints = database.createObjectStore('checkpoints', { keyPath: 'id' });
  checkpoints.createIndex('by-task', 'taskId');

  const attachments = database.createObjectStore('attachments', { keyPath: 'id' });
  attachments.createIndex('by-created-at', 'createdAt');

  const attachmentReferences = database.createObjectStore('attachment-references', {
    keyPath: ['attachmentId', 'referenceId'],
  });
  attachmentReferences.createIndex('by-attachment', 'attachmentId');
  attachmentReferences.createIndex('by-reference', 'referenceId');
}

/**
 * Opens the explicitly versioned IndexedDB database used for durable extension records.
 */
export function openChatBrowserDatabase(
  name = DEFAULT_DATABASE_NAME,
): Promise<IDBPDatabase<ChatBrowserDatabase>> {
  return openDB<ChatBrowserDatabase>(name, DATABASE_VERSION, { upgrade: upgradeDatabase });
}
