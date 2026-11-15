import { openDB, unwrap, type IDBPDatabase, type OpenDBCallbacks } from 'idb';
import type { TaskId, ToolCallKey } from '../shared/ids';
import type { ToolResult } from '../tasks/tool-result-types';
import {
  DATABASE_VERSION,
  DEFAULT_DATABASE_NAME,
  type ChatBrowserDatabase,
} from './database-schema';

const CANONICAL_TASK_HISTORY_SCHEMA_VERSION = 3;

type UpgradeDatabase = NonNullable<OpenDBCallbacks<ChatBrowserDatabase>['upgrade']>;

function createToolResults(database: IDBPDatabase<ChatBrowserDatabase>) {
  const results = database.createObjectStore('tool-results', { keyPath: ['taskId', 'callId'] });
  results.createIndex('by-task', 'taskId');
  results.createIndex('by-run', 'runId');
  return results;
}

async function migrateToolResultKeys(
  database: IDBPDatabase<ChatBrowserDatabase>,
  transaction: Parameters<UpgradeDatabase>[3],
): Promise<void> {
  // A version-change transaction can replace the primary key without buffering result bodies.
  const previous = transaction.objectStore('tool-results');
  previous.name = 'tool-results-v5';
  const results = createToolResults(database);
  const previousKeys = new Map<string, ToolCallKey>();
  for (let cursor = await previous.openCursor(); cursor; cursor = await cursor.continue()) {
    const { id, ...result } = cursor.value as ToolResult & { readonly id: string };
    await results.add(result);
    previousKeys.set(id, [result.taskId, result.callId]);
  }
  unwrap(database).deleteObjectStore(previous.name);

  const references = transaction.objectStore('attachment-references');
  for (let cursor = await references.openCursor(); cursor; cursor = await cursor.continue()) {
    const { attachmentId, referenceId } = cursor.value;
    const key = typeof referenceId === 'string' ? previousKeys.get(referenceId) : undefined;
    if (key === undefined) continue;
    await cursor.delete();
    await references.add({ attachmentId, referenceId: key });
  }

  // Translate only unresolved calls. Completed arguments and output bodies remain audit records.
  const migratedArguments = new Map<TaskId, Map<string, string>>();
  const migrateRead = async (
    taskId: TaskId,
    callId: string,
    name: string,
    argumentsJson: string,
  ): Promise<string | undefined> => {
    if (name !== 'result_read') return undefined;
    let args: { resultId?: unknown; offset?: unknown; limit?: unknown } | null;
    try {
      args = JSON.parse(argumentsJson) as typeof args;
    } catch {
      return undefined;
    }
    if (
      typeof args?.resultId !== 'string' ||
      args.resultId.length === 0 ||
      args.resultId.length > 512 ||
      Object.keys(args).length !== 3
    )
      return undefined;
    const ownKey: ToolCallKey = [taskId, callId];
    if ((await results.getKey(ownKey)) !== undefined) return undefined;
    // A missing legacy target still yields RESULT_NOT_FOUND since this call has no receipt yet.
    const [targetTaskId, targetCallId] = previousKeys.get(args.resultId) ?? ownKey;
    const replacement = JSON.stringify({
      taskId: targetTaskId,
      callId: targetCallId,
      offset: args.offset,
      limit: args.limit,
    });
    const byCall = migratedArguments.get(taskId) ?? new Map<string, string>();
    byCall.set(callId, replacement);
    migratedArguments.set(taskId, byCall);
    return replacement;
  };

  const checkpoints = transaction.objectStore('checkpoints');
  for (let cursor = await checkpoints.openCursor(); cursor; cursor = await cursor.continue()) {
    const checkpoint = cursor.value;
    const pending = checkpoint.pendingToolCall;
    const replacement = pending
      ? await migrateRead(checkpoint.taskId, pending.callId, pending.name, pending.argumentsJson)
      : undefined;
    let changed = replacement !== undefined;
    const continuationItems = checkpoint.continuationItems.map((item) => {
      if (item.type === 'function_call_output_ref' && 'resultId' in item) {
        const { resultId, ...reference } = item;
        const key = typeof resultId === 'string' ? previousKeys.get(resultId) : undefined;
        if (key?.[0] !== checkpoint.taskId || key[1] !== item.callId)
          throw new Error('Legacy checkpoint tool result does not match its call.');
        changed = true;
        return reference;
      }
      return item.type === 'function_call' &&
        item.callId === pending?.callId &&
        replacement !== undefined
        ? { ...item, argumentsJson: replacement }
        : item;
    });
    if (changed) {
      await cursor.update({
        ...checkpoint,
        continuationItems,
        pendingToolCall:
          pending && replacement !== undefined
            ? { ...pending, argumentsJson: replacement }
            : pending,
      });
    }
  }

  const sessions = transaction.objectStore('agent-sessions');
  for (let cursor = await sessions.openCursor(); cursor; cursor = await cursor.continue()) {
    const record = cursor.value;
    const session = 'session' in record ? record.session : record;
    const resolved = new Set(
      session.items.flatMap((item) => (item.type === 'function_call_result' ? [item.callId] : [])),
    );
    const items = [...session.items];
    let changed = false;
    for (const [index, item] of items.entries()) {
      if (item.type !== 'function_call' || resolved.has(item.callId)) continue;
      const replacement = await migrateRead(session.taskId, item.callId, item.name, item.arguments);
      if (replacement === undefined) continue;
      items[index] = { ...item, arguments: replacement };
      changed = true;
    }
    if (changed) {
      const updated = { ...session, items };
      await cursor.update('session' in record ? { ...record, session: updated } : updated);
    }
  }

  // Keep checkpoint, model session, and event arguments aligned for a resumed call.
  const events = transaction.objectStore('task-events');
  for (let cursor = await events.openCursor(); cursor; cursor = await cursor.continue()) {
    const event = cursor.value;
    if (event.type === 'tool.result' && 'resultId' in event) {
      const { resultId, ...updated } = event;
      const key = typeof resultId === 'string' ? previousKeys.get(resultId) : undefined;
      if (key?.[0] !== event.taskId || key[1] !== event.callId)
        throw new Error('Legacy tool result event does not match its call.');
      await cursor.update(updated);
    } else if (event.type === 'tool.call') {
      const replacement = migratedArguments.get(event.taskId)?.get(event.callId);
      if (replacement !== undefined) await cursor.update({ ...event, argumentsJson: replacement });
    }
  }
}

/**
 * Installs the current schema and migrates existing canonical history.
 */
async function upgradeDatabase(
  ...[database, oldVersion, , transaction]: Parameters<UpgradeDatabase>
): Promise<void> {
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

    createToolResults(database);

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
    database.createObjectStore('agent-sessions', { keyPath: 'conversationId' });
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
  if (oldVersion < 5) database.createObjectStore('agent-sessions', { keyPath: 'conversationId' });
  if (oldVersion < 6) await migrateToolResultKeys(database, transaction);
}

/**
 * Opens the explicitly versioned IndexedDB database used for durable extension records.
 */
export async function openChatBrowserDatabase(
  name = DEFAULT_DATABASE_NAME,
): Promise<IDBPDatabase<ChatBrowserDatabase>> {
  let upgradeFailure: unknown;
  try {
    return await openDB<ChatBrowserDatabase>(name, DATABASE_VERSION, {
      upgrade(...args) {
        const transaction = args[3];
        void transaction.done.catch(() => undefined);
        void upgradeDatabase(...args).catch((error: unknown) => {
          upgradeFailure = error;
          try {
            transaction.abort();
          } catch {
            // An IndexedDB request failure can already have aborted the upgrade.
          }
        });
      },
    });
  } catch (error) {
    throw upgradeFailure ?? error;
  }
}
