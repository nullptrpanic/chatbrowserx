import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { openChatBrowserDatabase } from '../../src/persistence/open-database';
import { createTestDatabaseName } from './test-helpers';

describe('openChatBrowserDatabase', () => {
  it('clears version-two task history and creates the canonical schema', async () => {
    const name = createTestDatabaseName('reset-task-history-schema');
    const upgraded = await openDB(name, 2, {
      upgrade(database) {
        const tasks = database.createObjectStore('tasks', { keyPath: 'id' });
        tasks.add({ id: 'legacy-task', status: 'completed' });
        database.createObjectStore('legacy-version-two-store');
      },
    });
    upgraded.close();

    const database = await openChatBrowserDatabase(name);

    expect(database.version).toBe(4);
    expect(Array.from(database.objectStoreNames, String)).toEqual(
      expect.arrayContaining(['tasks', 'task-runs', 'task-events', 'tool-results', 'checkpoints']),
    );
    expect(Array.from(database.objectStoreNames, String)).not.toContain('legacy-version-two-store');
    expect(await database.count('tasks')).toBe(0);
    database.close();
  });

  it('preserves version-three events while adding the message-event index', async () => {
    const name = createTestDatabaseName('upgrade-message-event-index');
    const versionThree = await openDB(name, 3, {
      upgrade(database) {
        const events = database.createObjectStore('task-events', { keyPath: 'id' });
        events.createIndex('by-task-sequence', ['taskId', 'sequence'], { unique: true });
        events.add({
          id: 'event_existing',
          taskId: 'task_existing',
          runId: 'run_existing',
          sequence: 1,
          at: 1,
          type: 'message.recorded',
          messageId: 'message_existing',
        });
      },
    });
    versionThree.close();

    const database = await openChatBrowserDatabase(name);
    expect(database.version).toBe(4);
    expect(await database.get('task-events', 'event_existing')).toBeDefined();
    expect(Array.from(database.transaction('task-events').store.indexNames, String)).toContain(
      'by-task-type-sequence',
    );
    database.close();
  });
});
