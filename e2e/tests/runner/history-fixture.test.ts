// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { buildHistoryFixture } from '../../runner/history-fixture';
import type { LiveInitialHistory } from '../../runner/live-types';
import { openChatBrowserDatabase } from '../../../src/persistence/open-database';
import { IndexedDbTaskRepository } from '../../../src/persistence/task-repository';
import { IndexedDbConversationRepository } from '../../../src/persistence/conversation-repository';
import { restoreAgentSession } from '../../../src/agent/context/agent-session';
import { TaskHistoryReader } from '../../../src/tasks/task-history-reader';

describe('declared history fixtures', () => {
  it('keeps original and interrupted messages searchable without replaying them in the model window', async () => {
    const history: LiveInitialHistory = {
      summary: 'Earlier conversation details are archived.',
      tasks: [
        {
          status: 'completed',
          messages: [
            { role: 'user', text: 'What was the receipt?', status: 'complete' },
            { role: 'assistant', text: 'The receipt was XK-418.', status: 'complete' },
          ],
        },
        {
          status: 'cancelled',
          messages: [
            { role: 'user', text: 'Send the update.', status: 'complete' },
            { role: 'assistant', text: 'Drafting the update.', status: 'interrupted' },
          ],
        },
        {
          status: 'failed',
          messages: [
            { role: 'user', text: 'Create an appointment.', status: 'complete' },
            { role: 'assistant', text: 'The request failed.', status: 'error' },
          ],
        },
        {
          status: 'completed',
          messages: [
            { role: 'user', text: 'We will continue later.', status: 'complete' },
            { role: 'assistant', text: 'Okay.', status: 'complete' },
          ],
        },
      ],
    };
    const records = buildHistoryFixture(history, 'attempt-one', 7, 200_000);
    if (!records.session) throw new Error('Expected a summary-only model window.');
    const db = await openChatBrowserDatabase(`history-fixture-${crypto.randomUUID()}`);
    try {
      await db.add('conversations', records.conversation);
      for (const task of records.tasks) await db.add('tasks', task);
      for (const run of records.runs) await db.add('task-runs', run);
      for (const event of records.events) await db.add('task-events', event);
      for (const message of records.messages) await db.add('messages', message);
      await db.add('agent-sessions', records.session);
      const tasks = new IndexedDbTaskRepository(db);
      const conversations = new IndexedDbConversationRepository(db);
      const previous = records.tasks.at(-1);
      if (!previous) throw new Error('Missing last task.');
      const current = { ...previous, id: 'current', ordinal: 5, status: 'planning' as const };
      const restored = await restoreAgentSession(
        current,
        [...records.tasks, current],
        records.messages,
        tasks,
        records.session,
      );
      expect(restored.items).toEqual(records.session.items);
      expect(JSON.stringify(restored.items)).not.toContain('XK-418');
      expect(restored.items).not.toContainEqual(expect.objectContaining({ type: 'compaction' }));
      const reader = new TaskHistoryReader({
        tasks,
        conversations,
        attachments: { get: async () => undefined },
      });
      const found = await reader.searchHistory(
        { conversationId: records.conversation.id, currentTaskId: current.id },
        { query: 'XK-418', cursor: '', limit: 5 },
      );
      expect(found).toMatchObject({
        ok: true,
        items: [
          {
            context: expect.arrayContaining([
              expect.objectContaining({ text: 'The receipt was XK-418.' }),
            ]),
          },
        ],
      });
      const statuses = await reader.searchHistory(
        { conversationId: records.conversation.id, currentTaskId: current.id },
        { query: '', cursor: '', limit: 10 },
      );
      expect(statuses).toMatchObject({
        ok: true,
        items: expect.arrayContaining([
          expect.objectContaining({
            taskStatus: 'cancelled',
            context: expect.arrayContaining([expect.objectContaining({ status: 'interrupted' })]),
          }),
          expect.objectContaining({
            taskStatus: 'failed',
            context: expect.arrayContaining([expect.objectContaining({ status: 'error' })]),
          }),
        ]),
      });
      const second = buildHistoryFixture(history, 'attempt-two', 7, 200_000);
      expect(second.conversation.id).not.toBe(records.conversation.id);
      const raw = buildHistoryFixture({ tasks: history.tasks }, 'uncompressed', 7, 200_000);
      expect(raw.session).toBeUndefined();
      expect(raw.messages.some(({ text }) => text === 'The receipt was XK-418.')).toBe(true);
    } finally {
      db.close();
    }
  });
});
