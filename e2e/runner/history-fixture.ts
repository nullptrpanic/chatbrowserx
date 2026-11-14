import type { Page } from '@playwright/test';
import { DEFAULT_DATABASE_NAME } from '../../src/persistence/database-schema';
import type { AgentSession } from '../../src/tasks/agent-session-types';
import type { MessageRecord } from '../../src/tasks/message-types';
import type { Task, TaskEvent, TaskRun } from '../../src/tasks/task-types';
import type { LiveInitialHistory } from './live-types';

/** Declared synthetic archive, with an optional summary-only model window. */
export function buildHistoryFixture(
  history: LiveInitialHistory,
  runId: string,
  tabId: number,
  now: number,
) {
  const conversationId = `${runId}_history`;
  const tasks: Task[] = [];
  const runs: TaskRun[] = [];
  const events: TaskEvent[] = [];
  const messages: MessageRecord[] = [];
  const startedAt = now - 100_000;
  for (const [index, entry] of history.tasks.entries()) {
    const id = `${conversationId}_${index}`;
    const runId = `${id}_run`;
    const at = startedAt + index * 1_000;
    for (const [position, message] of entry.messages.entries()) {
      const messageId = `${id}_message_${position}`;
      messages.push({
        ...message,
        id: messageId,
        kind: 'conversation',
        conversationId,
        taskId: id,
        attachmentIds: [],
        createdAt: at + position,
        updatedAt: at + position,
      });
      events.push({
        id: `${messageId}_event`,
        taskId: id,
        runId,
        sequence: position + 1,
        at: at + position,
        type: 'message.recorded',
        messageId,
      });
    }
    tasks.push({
      id,
      conversationId,
      tabId,
      ordinal: index + 1,
      goal: entry.messages[0]?.text ?? '',
      status: entry.status,
      latestRunId: runId,
      lastEventSequence: entry.messages.length,
      createdAt: at,
      updatedAt: at + entry.messages.length,
    });
    runs.push({
      id: runId,
      taskId: id,
      attempt: 1,
      status: entry.status,
      checkpointId: null,
      lease: null,
      error: null,
      startedAt: at,
      endedAt: at + entry.messages.length,
    });
  }
  const last = tasks.at(-1);
  if (!last || last.status !== 'completed')
    throw new Error('History fixture needs a completed last task.');
  const session: AgentSession | undefined =
    history.summary === undefined
      ? undefined
      : {
          conversationId,
          taskId: last.id,
          items: [
            {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: history.summary }],
            },
          ],
          admittedMessageIds: messages
            .filter((message) => message.taskId === last.id)
            .map(({ id }) => id),
          lastInputTokens: null,
        };
  return {
    conversation: {
      id: conversationId,
      tabId,
      title: 'Synthetic history evaluation',
      createdAt: startedAt,
      updatedAt: now,
    },
    tasks,
    runs,
    events,
    messages,
    session,
  };
}

/** Inserts only a fresh fixture owner; credentials and pre-existing conversations are untouched. */
export async function seedHistoryFixture(
  page: Page,
  history: LiveInitialHistory,
  runId: string,
  tabId: number,
): Promise<string> {
  const records = buildHistoryFixture(history, runId, tabId, Date.now());
  await page.evaluate(
    async ({ databaseName, records }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(
            ['conversations', 'tasks', 'task-runs', 'task-events', 'messages', 'agent-sessions'],
            'readwrite',
          );
          transaction.oncomplete = () => resolve();
          transaction.onabort = () =>
            reject(transaction.error ?? new Error('History fixture transaction aborted.'));
          transaction.objectStore('conversations').add(records.conversation);
          for (const task of records.tasks) transaction.objectStore('tasks').add(task);
          for (const run of records.runs) transaction.objectStore('task-runs').add(run);
          for (const event of records.events) transaction.objectStore('task-events').add(event);
          for (const message of records.messages) transaction.objectStore('messages').add(message);
          if (records.session) transaction.objectStore('agent-sessions').add(records.session);
        });
      } finally {
        database.close();
      }
    },
    { databaseName: DEFAULT_DATABASE_NAME, records },
  );
  return records.conversation.id;
}
