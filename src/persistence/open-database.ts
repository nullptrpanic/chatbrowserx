import { openDB, type IDBPDatabase, type OpenDBCallbacks } from 'idb';
import {
  DATABASE_VERSION,
  DEFAULT_DATABASE_NAME,
  type ChatBrowserDatabase,
} from './database-schema';

const CANONICAL_TASK_HISTORY_SCHEMA_VERSION = 3;

/**
 * Creates the baseline schema when opening a new ChatBrowserX database.
 */
const upgradeDatabase: NonNullable<OpenDBCallbacks<ChatBrowserDatabase>['upgrade']> = (
  database,
  oldVersion,
  _newVersion,
  transaction,
) => {
  if (oldVersion < CANONICAL_TASK_HISTORY_SCHEMA_VERSION) {
    if (oldVersion > 0) {
      for (const storeName of Array.from(database.objectStoreNames)) {
        database.deleteObjectStore(storeName);
      }
    }

    const conversations = database.createObjectStore('conversations', { keyPath: 'id' });
    conversations.createIndex('by-tab-updated-at', ['tabId', 'updatedAt']);

    const messages = database.createObjectStore('messages', { keyPath: 'id' });
    messages.createIndex('by-conversation-created-at', ['conversationId', 'createdAt']);
    messages.createIndex('by-task', 'taskId');

    const tasks = database.createObjectStore('tasks', { keyPath: 'id' });
    tasks.createIndex('by-status', 'status');
    tasks.createIndex('by-updated-at', 'updatedAt');
    tasks.createIndex('by-conversation', 'conversationId');
    tasks.createIndex('by-conversation-ordinal', ['conversationId', 'ordinal'], { unique: true });

    const taskRuns = database.createObjectStore('task-runs', { keyPath: 'id' });
    taskRuns.createIndex('by-task-attempt', ['taskId', 'attempt'], { unique: true });
    taskRuns.createIndex('by-status', 'status');

    const taskEvents = database.createObjectStore('task-events', { keyPath: 'id' });
    taskEvents.createIndex('by-task-sequence', ['taskId', 'sequence'], { unique: true });
    taskEvents.createIndex('by-task-type-sequence', ['taskId', 'type', 'sequence'], {
      unique: true,
    });

    const toolResults = database.createObjectStore('tool-results', { keyPath: 'id' });
    toolResults.createIndex('by-task', 'taskId');
    toolResults.createIndex('by-run', 'runId');
    toolResults.createIndex('by-task-call', ['taskId', 'callId'], { unique: true });

    const checkpoints = database.createObjectStore('checkpoints', { keyPath: 'id' });
    checkpoints.createIndex('by-task', 'taskId');
    checkpoints.createIndex('by-run', 'runId', { unique: true });

    const attachments = database.createObjectStore('attachments', { keyPath: 'id' });
    attachments.createIndex('by-created-at', 'createdAt');

    const attachmentReferences = database.createObjectStore('attachment-references', {
      keyPath: ['attachmentId', 'referenceId'],
    });
    attachmentReferences.createIndex('by-attachment', 'attachmentId');
    attachmentReferences.createIndex('by-reference', 'referenceId');
    return;
  }

  if (oldVersion < 4) {
    const taskEvents = transaction.objectStore('task-events');
    if (!taskEvents.indexNames.contains('by-task-type-sequence')) {
      taskEvents.createIndex('by-task-type-sequence', ['taskId', 'type', 'sequence'], {
        unique: true,
      });
    }
  }
};

/**
 * Opens the explicitly versioned IndexedDB database used for durable extension records.
 */
export function openChatBrowserDatabase(
  name = DEFAULT_DATABASE_NAME,
): Promise<IDBPDatabase<ChatBrowserDatabase>> {
  return openDB<ChatBrowserDatabase>(name, DATABASE_VERSION, { upgrade: upgradeDatabase });
}
