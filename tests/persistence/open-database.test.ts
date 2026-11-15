// @vitest-environment node
import 'fake-indexeddb/auto';
import { openDB, type IDBPDatabase } from 'idb';
import { describe, expect, it } from 'vitest';
import { IndexedDbAttachmentRepository } from '../../src/persistence/attachment-repository';
import { IndexedDbConversationRepository } from '../../src/persistence/conversation-repository';
import { openChatBrowserDatabase } from '../../src/persistence/open-database';
import { IndexedDbTaskRepository } from '../../src/persistence/task-repository';
import { materializeContinuationItems } from '../../src/tasks/continuation-materialization';
import { TaskHistoryReader } from '../../src/tasks/task-history-reader';
import { createTestDatabaseName } from './test-helpers';

function createLegacyToolStores(database: IDBPDatabase) {
  const results = database.createObjectStore('tool-results', { keyPath: 'id' });
  results.createIndex('by-task', 'taskId');
  results.createIndex('by-run', 'runId');
  results.createIndex('by-task-call', ['taskId', 'callId'], { unique: true });
  database.createObjectStore('checkpoints', { keyPath: 'id' });
  const references = database.createObjectStore('attachment-references', {
    keyPath: ['attachmentId', 'referenceId'],
  });
  references.createIndex('by-attachment', 'attachmentId');
  references.createIndex('by-reference', 'referenceId');
  return results.transaction;
}

describe('openChatBrowserDatabase', () => {
  it('preserves tool output, a pending history read, and attachment ownership across the upgrade', async () => {
    const name = createTestDatabaseName('upgrade-tool-call-keys');
    const previous = await openDB(name, 5, {
      upgrade(database) {
        createLegacyToolStores(database);
        database.createObjectStore('messages', { keyPath: 'id' });
        const tasks = database.createObjectStore('tasks', { keyPath: 'id' });
        const runs = database.createObjectStore('task-runs', { keyPath: 'id' });
        const events = database.createObjectStore('task-events', { keyPath: 'id' });
        events.createIndex('by-task-sequence', ['taskId', 'sequence'], { unique: true });
        const attachments = database.createObjectStore('attachments', { keyPath: 'id' });
        const sessions = database.createObjectStore('agent-sessions', {
          keyPath: 'conversationId',
        });
        const { transaction } = tasks;
        const callId = 'call_capture';
        const screenshot = {
          callId,
          name: 'browser_capture_screenshot',
          argumentsJson: '{}',
        };
        const pendingRead = {
          callId: 'call_read',
          name: 'result_read',
          argumentsJson: '{"resultId":"legacy_result","offset":2,"limit":3}',
        };
        void tasks.add({
          id: 'task_kept',
          conversationId: 'conversation_kept',
          status: 'paused',
          latestRunId: 'run_kept',
          lastEventSequence: 3,
        });
        void runs.add({
          id: 'run_kept',
          taskId: 'task_kept',
          status: 'paused',
          checkpointId: 'cp',
        });
        const eventBase = { taskId: 'task_kept', runId: 'run_kept', at: 1 };
        void events.add({
          ...eventBase,
          id: 'event_1',
          sequence: 1,
          type: 'tool.call',
          ...screenshot,
        });
        void events.add({
          ...eventBase,
          id: 'event_2',
          sequence: 2,
          type: 'tool.result',
          callId,
          resultId: 'legacy_result',
        });
        void events.add({
          ...eventBase,
          id: 'event_3',
          sequence: 3,
          type: 'tool.call',
          ...pendingRead,
        });
        const original = {
          id: 'legacy_result',
          taskId: 'task_kept',
          runId: 'run_kept',
          callId,
          toolName: screenshot.name,
          output: '0123456789',
          modelOutput: '0123',
          attachmentIds: ['capture'],
          createdAt: 1,
        };
        void transaction.objectStore('tool-results').add(original);
        void transaction.objectStore('tool-results').add({
          ...original,
          id: 'legacy_other',
          taskId: 'other_task',
          output: 'different',
          attachmentIds: [],
        });
        void transaction.objectStore('checkpoints').add({
          ...eventBase,
          id: 'cp',
          continuationItems: [
            { type: 'function_call', ...screenshot },
            {
              type: 'function_call_output_ref',
              callId,
              resultId: 'legacy_result',
              attachmentIds: ['capture'],
            },
            { type: 'function_call', ...pendingRead },
          ],
          pendingToolCall: { ...pendingRead, executionState: 'recorded' },
          browserToolCallsInAttempt: 1,
          browserTargetTabId: 7,
          createdAt: 1,
        });
        void sessions.add({
          conversationId: 'conversation_kept',
          taskId: 'task_kept',
          items: [
            {
              type: 'function_call',
              callId: pendingRead.callId,
              name: pendingRead.name,
              arguments: pendingRead.argumentsJson,
              status: 'completed',
            },
          ],
          admittedMessageIds: [],
          lastInputTokens: null,
        });
        void attachments.add({
          id: 'capture',
          blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
          mimeType: 'image/png',
          byteSize: 3,
          width: 1,
          height: 1,
          source: 'viewport_capture',
          createdAt: 1,
        });
        void transaction.objectStore('attachment-references').add({
          attachmentId: 'capture',
          referenceId: 'legacy_result',
        });
      },
    });
    previous.close();

    const database = await openChatBrowserDatabase(name);
    const tasks = new IndexedDbTaskRepository(database);
    const attachments = new IndexedDbAttachmentRepository(database);
    const history = new TaskHistoryReader({
      tasks,
      attachments,
      conversations: new IndexedDbConversationRepository(database),
    });
    const input = { taskId: 'task_kept', callId: 'call_capture', offset: 2, limit: 3 };
    await expect(
      history.readResult(
        {
          conversationId: 'conversation_kept',
          currentTaskId: 'task_kept',
          currentTaskLastEventSequence: 3,
        },
        input,
      ),
    ).resolves.toMatchObject({ content: '234', nextOffset: 5 });
    await expect(tasks.getToolResult('other_task', 'call_capture')).resolves.toMatchObject({
      output: 'different',
    });
    const capture = await attachments.get('capture', 'conversation_kept');
    if (!capture) throw new Error('Expected the saved screenshot.');
    expect([...new Uint8Array(await capture.blob.arrayBuffer())]).toEqual([1, 2, 3]);
    await expect(attachments.get('capture', 'other_conversation')).resolves.toBeUndefined();
    const snapshot = await tasks.readActiveRuntimeSnapshot('task_kept');
    if (!snapshot?.checkpoint) throw new Error('Expected the recovery checkpoint.');
    expect(
      materializeContinuationItems({
        continuationItems: snapshot.checkpoint.continuationItems,
        toolResults: snapshot.toolResults,
      })[1],
    ).toEqual({
      type: 'function_call_output',
      callId: 'call_capture',
      output: '0123',
      attachmentIds: ['capture'],
    });
    const newArguments = JSON.stringify(input);
    expect(snapshot.checkpoint.pendingToolCall?.argumentsJson).toBe(newArguments);
    expect(snapshot.events[2]).toMatchObject({ argumentsJson: newArguments });
    await expect(tasks.getAgentSession('conversation_kept')).resolves.toMatchObject({
      items: [{ callId: 'call_read', arguments: newArguments }],
    });
    database.close();
  });

  it('keeps the legacy database intact when a tool result has a broken reference', async () => {
    const name = createTestDatabaseName('abort-tool-call-migration');
    const previous = await openDB(name, 5, {
      upgrade(database) {
        const transaction = createLegacyToolStores(database);
        const events = database.createObjectStore('task-events', { keyPath: 'id' });
        database.createObjectStore('agent-sessions', { keyPath: 'conversationId' });
        void transaction.objectStore('tool-results').add({
          id: 'legacy_result',
          taskId: 'original_task',
          callId: 'original_call',
          output: 'kept evidence',
        });
        void events.add({
          id: 'bad_event',
          type: 'tool.result',
          taskId: 'another_task',
          callId: 'original_call',
          resultId: 'legacy_result',
        });
      },
    });
    previous.close();

    await expect(openChatBrowserDatabase(name)).rejects.toThrow(
      'Legacy tool result event does not match its call.',
    );
    const unchanged = await openDB(name, 5);
    expect(await unchanged.get('tool-results', 'legacy_result')).toMatchObject({
      output: 'kept evidence',
    });
    expect([...unchanged.objectStoreNames]).not.toContain('tool-results-v5');
    unchanged.close();
  });

  it('adds the session store without deleting version-four conversations or tool evidence', async () => {
    const name = createTestDatabaseName('upgrade-agent-sessions');
    const previous = await openDB(name, 4, {
      upgrade(database) {
        const transaction = createLegacyToolStores(database);
        database.createObjectStore('task-events', { keyPath: 'id' });
        database
          .createObjectStore('conversations', { keyPath: 'id' })
          .add({ id: 'kept-conversation' });
        transaction.objectStore('tool-results').add({
          id: 'kept-result',
          taskId: 'kept-task',
          callId: 'kept-call',
          output: 'confirmed effect',
        });
      },
    });
    previous.close();
    const database = await openChatBrowserDatabase(name);
    expect(await database.get('conversations', 'kept-conversation')).toBeDefined();
    expect(await database.get('tool-results', ['kept-task', 'kept-call'])).toMatchObject({
      output: 'confirmed effect',
    });
    expect(database.objectStoreNames.contains('agent-sessions')).toBe(true);
    database.close();
  });

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

    expect(database.version).toBe(6);
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
        createLegacyToolStores(database);
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
    expect(database.version).toBe(6);
    expect(await database.get('task-events', 'event_existing')).toBeDefined();
    expect(Array.from(database.transaction('task-events').store.indexNames, String)).toContain(
      'by-task-type-sequence',
    );
    database.close();
  });
});
