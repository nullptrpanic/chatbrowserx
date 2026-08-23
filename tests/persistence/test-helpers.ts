import type { IDBPDatabase } from 'idb';
import type { ChatBrowserDatabase } from '../../src/persistence/database-schema';
import type { Conversation } from '../../src/tasks/conversation-types';
import type { TaskRun } from '../../src/tasks/task-types';

let databaseSequence = 0;

/**
 * Returns a unique in-memory IndexedDB name so persistence tests cannot share state.
 */
export function createTestDatabaseName(label: string): string {
  databaseSequence += 1;
  return `chatbrowserx-test-${label}-${databaseSequence}`;
}

/** Seeds a conversation without expanding the production repository API for test setup. */
export async function seedConversation(
  database: IDBPDatabase<ChatBrowserDatabase>,
  conversation: Conversation,
): Promise<void> {
  await database.add('conversations', conversation);
}

/** Seeds a task without expanding the production repository API for test setup. */
export async function seedTask(
  database: IDBPDatabase<ChatBrowserDatabase>,
  task: TaskRun,
): Promise<void> {
  await database.add('tasks', task);
}

export class MemoryStorageArea {
  readonly values: Record<string, unknown> = {};
  accessLevel: string | null = null;
  failWrites = false;

  /**
   * Reads one key or a list of keys using the Promise form of the Chrome storage contract.
   */
  async get(keys?: string | readonly string[]): Promise<Record<string, unknown>> {
    if (keys === undefined) {
      return { ...this.values };
    }

    const requestedKeys = typeof keys === 'string' ? [keys] : keys;
    return Object.fromEntries(
      requestedKeys.filter((key) => key in this.values).map((key) => [key, this.values[key]]),
    );
  }

  /**
   * Stores values or simulates an unsafe lower-level error for redaction tests.
   */
  async set(items: Record<string, unknown>): Promise<void> {
    if (this.failWrites) {
      throw new Error(`Storage rejected ${JSON.stringify(items)}.`);
    }

    Object.assign(this.values, items);
  }

  /** Removes one or more keys like the trusted Chrome local storage adapter. */
  async remove(keys: string | readonly string[]): Promise<void> {
    for (const key of typeof keys === 'string' ? [keys] : keys) {
      Reflect.deleteProperty(this.values, key);
    }
  }

  /**
   * Records the access level requested by the trusted credential repository.
   */
  async setAccessLevel(options: { accessLevel: string }): Promise<void> {
    this.accessLevel = options.accessLevel;
  }
}
