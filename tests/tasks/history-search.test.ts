// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { openChatBrowserDatabase } from '../../src/persistence/open-database';
import { IndexedDbConversationRepository } from '../../src/persistence/conversation-repository';
import { IndexedDbTaskRepository } from '../../src/persistence/task-repository';
import { TaskHistoryReader } from '../../src/tasks/task-history-reader';
import type { MessageRecord } from '../../src/tasks/message-types';
import type { Task, TaskEvent } from '../../src/tasks/task-types';
import { discoverTools } from '../../src/tools/discover';
import { historyService } from '../../src/tools/history/service';
import { historyRuntime } from '../../src/tools/history/tool';
import { bindToolRuntime } from '../../src/tools/registry';
import { ToolServiceResolver } from '../../src/tools/service-resolver';

const databases: Awaited<ReturnType<typeof openChatBrowserDatabase>>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

async function fixture() {
  const db = await openChatBrowserDatabase(`history-search-${crypto.randomUUID()}`);
  databases.push(db);
  const tasks = new IndexedDbTaskRepository(db);
  const conversations = new IndexedDbConversationRepository(db);
  const reader = new TaskHistoryReader({
    tasks,
    conversations,
    attachments: { get: async () => undefined },
  });
  const context = {
    conversationId: 'conversation',
    currentTaskId: 'current',
    currentTaskLastEventSequence: 4,
  };
  async function seed(id: string, ordinal: number, texts: string[], overrides: Partial<Task> = {}) {
    const task: Task = {
      id,
      conversationId: context.conversationId,
      ordinal,
      tabId: 7,
      goal: texts[0] ?? '',
      status: 'completed',
      latestRunId: `run_${id}`,
      lastEventSequence: texts.length,
      createdAt: ordinal * 100,
      updatedAt: ordinal * 100 + texts.length,
      ...overrides,
    };
    await db.put('tasks', task);
    for (const [index, text] of texts.entries()) {
      const message: MessageRecord = {
        id: `${id}_${index}`,
        taskId: id,
        conversationId: task.conversationId,
        kind: 'conversation',
        role: index % 2 === 0 ? 'user' : 'assistant',
        status: 'complete',
        text,
        attachmentIds: [],
        createdAt: ordinal * 100 + index,
        updatedAt: ordinal * 100 + index,
      };
      const event: TaskEvent = {
        id: `event_${message.id}`,
        taskId: id,
        runId: `run_${id}`,
        sequence: index + 1,
        at: message.createdAt,
        type: 'message.recorded',
        messageId: message.id,
      };
      await db.put('messages', message);
      await db.put('task-events', event);
    }
    return task;
  }
  return { db, reader, context, seed };
}

describe('history discovery and anchored reads', () => {
  it('finds old Chinese/English messages beyond the latest fifty and returns original context', async () => {
    const f = await fixture();
    await f.seed('old', 1, ['截图后 Token 为什么变多？', '历史附件使用 ID 引用；需要时读取原图。']);
    await f.seed(
      'recent',
      2,
      Array.from({ length: 60 }, (_, i) => `Unrelated message ${i}`),
    );
    await f.seed('foreign', 3, ['截图 Token secret', 'Foreign answer'], {
      conversationId: 'other',
    });
    const result = await f.reader.searchHistory(f.context, {
      query: '截图 TOKEN',
      cursor: '',
      limit: 5,
    });
    expect(result).toEqual({
      ok: true,

      nextCursor: null,
      items: [
        {
          taskId: 'old',
          taskStatus: 'completed',
          messageId: 'old_0',
          context: [
            {
              messageId: 'old_0',
              role: 'user',
              status: 'complete',
              createdAt: 100,
              text: '截图后 Token 为什么变多？',
              textLength: '截图后 Token 为什么变多？'.length,
            },
            {
              messageId: 'old_1',
              role: 'assistant',
              status: 'complete',
              createdAt: 101,
              text: '历史附件使用 ID 引用；需要时读取原图。',
              textLength: '历史附件使用 ID 引用；需要时读取原图。'.length,
            },
          ],
        },
      ],
    });
  });

  it('browses newest first, keeps pagination stable after an append, and binds cursors to the query', async () => {
    const f = await fixture();
    await f.seed('old', 1, ['Earlier question', 'Earlier answer']);
    await f.seed('new', 2, ['Later question', 'Later answer'], { status: 'cancelled' });
    const page = await f.reader.searchHistory(f.context, { query: '', cursor: '', limit: 2 });
    expect(page).toMatchObject({
      ok: true,

      items: [
        {
          messageId: 'new_1',
          taskStatus: 'cancelled',
          context: [{ messageId: 'new_1', text: 'Later answer' }],
        },
        { messageId: 'new_0', context: [{ messageId: 'new_0', text: 'Later question' }] },
      ],
    });
    if (!page.ok || page.nextCursor === null) throw new Error('Expected a continuation cursor.');
    await f.seed('appended', 3, ['Newest question', 'Newest answer']);
    const next = await f.reader.searchHistory(f.context, {
      query: '',
      cursor: page.nextCursor,
      limit: 2,
    });
    expect(next).toMatchObject({
      ok: true,

      items: [{ messageId: 'old_1' }, { messageId: 'old_0' }],
    });
    expect(
      await f.reader.searchHistory(f.context, {
        query: 'different',
        cursor: page.nextCursor,
        limit: 2,
      }),
    ).toMatchObject({ ok: false, code: 'INVALID_CURSOR' });
    expect(
      await f.reader.searchHistory(
        { ...f.context, conversationId: 'other' },
        { query: '', cursor: page.nextCursor, limit: 2 },
      ),
    ).toMatchObject({ ok: false, code: 'INVALID_CURSOR' });
  });

  it('returns an empty search and browses history explicitly', async () => {
    const f = await fixture();
    await f.seed('old', 1, ['Old question', 'Old answer']);
    await f.seed('recent', 2, ['Recent question', 'Recent answer']);
    expect(
      await f.reader.searchHistory(f.context, { query: 'unmatched terms', cursor: '', limit: 4 }),
    ).toEqual({ ok: true, items: [], nextCursor: null });
    expect(
      await f.reader.searchHistory(f.context, { query: '', cursor: '', limit: 4 }),
    ).toMatchObject({
      ok: true,
      nextCursor: null,
      items: [
        { messageId: 'recent_1' },
        { messageId: 'recent_0' },
        { messageId: 'old_1' },
        { messageId: 'old_0' },
      ],
    });
  });

  it('returns a bounded excerpt around a late match and reads the original answer by message', async () => {
    const f = await fixture();
    const answer = `${'prefix '.repeat(900)}Receipt: ZK-914. ${'suffix '.repeat(900)}`;
    await f.seed('long', 1, ['What was the receipt?', answer, 'Next question', 'Next answer']);
    const result = await f.reader.searchHistory(f.context, {
      query: 'zk-914',
      cursor: '',
      limit: 5,
    });
    if (!result.ok) throw new Error('Expected search results.');
    expect(result.items).toHaveLength(1);
    const match = result.items[0];
    if (!match) throw new Error('Expected a matching message.');
    expect(match.context.find(({ messageId }) => messageId === match.messageId)?.text).toContain(
      'ZK-914',
    );
    expect(JSON.stringify(result).length).toBeLessThan(5_000);
    const page = await f.reader.readHistory(f.context, {
      taskId: match.taskId,
      offset: null,
      messageId: match.messageId,
      cursor: '',
      limit: 2,
    });
    if (!page.ok) throw new Error('Expected an anchored page.');
    expect(page.items.map((item) => ('messageId' in item ? item.messageId : null))).toEqual([
      'long_0',
      'long_1',
    ]);
    const item = page.items[1];
    if (!item || item.type !== 'message') throw new Error('Expected original text reference.');
    const detail = await f.reader.readMessage(f.context, {
      taskId: match.taskId,
      messageId: item.messageId,
      offset: 6_300,
      limit: 40,
    });
    expect(detail).toMatchObject({ ok: true, content: answer.slice(6_300, 6_340) });
  });

  it('includes the original question when several assistant updates precede the matching answer', async () => {
    const f = await fixture();
    await f.seed('updates', 1, [
      'What caused the slowdown?',
      'Checking requests.',
      'Checking rendering.',
      'The cause was repeated attachment replay.',
    ]);
    const update = await f.db.get('messages', 'updates_2');
    if (!update) throw new Error('Missing update.');
    await f.db.put('messages', { ...update, role: 'assistant' });
    const result = await f.reader.searchHistory(f.context, {
      query: 'attachment replay',
      cursor: '',
      limit: 5,
    });
    if (!result.ok) throw new Error('Expected a match.');
    expect(result.items[0]?.context).toContainEqual(
      expect.objectContaining({ messageId: 'updates_0', text: 'What caused the slowdown?' }),
    );
  });

  it('reads only persisted current-task history within the execution boundary and excludes streaming text', async () => {
    const f = await fixture();
    const current = await f.seed(
      'current',
      1,
      ['Old question', 'Old answer', 'Follow-up', 'unfinished', 'Future input'],
      { status: 'planning' },
    );
    const streaming = await f.db.get('messages', 'current_3');
    if (!streaming) throw new Error('Missing message.');
    await f.db.put('messages', { ...streaming, status: 'streaming' });
    const found = await f.reader.searchHistory(f.context, {
      query: 'old answer',
      cursor: '',
      limit: 5,
    });
    expect(found).toMatchObject({
      ok: true,
      items: [
        {
          messageId: 'current_1',
          context: [{ messageId: 'current_0' }, { messageId: 'current_1' }],
        },
      ],
    });
    for (const query of ['follow-up', 'unfinished', 'future']) {
      expect(
        await f.reader.searchHistory(f.context, { query, cursor: '', limit: 5 }),
      ).toMatchObject({
        ok: true,
        items: [],
      });
    }
    const page = await f.reader.readHistory(f.context, {
      taskId: 'current',
      offset: null,
      cursor: '',
      limit: 2,
    });
    if (!page.ok || !page.nextCursor) throw new Error('Expected current-task pagination.');
    await f.db.put('messages', {
      ...streaming,
      text: 'Completed after the first page',
      status: 'complete',
      updatedAt: 200,
    });
    const next = await f.reader.readHistory(
      { ...f.context, currentTaskLastEventSequence: 5 },
      { taskId: 'current', offset: null, cursor: page.nextCursor, limit: 20 },
    );
    expect(next).toMatchObject({ ok: true, nextCursor: null, items: [{ messageId: 'current_2' }] });
    const services = new ToolServiceResolver();
    services.bind(historyService, f.reader);
    const runtime = bindToolRuntime(
      discoverTools().filter(({ runtime }) => runtime === historyRuntime),
      services,
    );
    const contract = await runtime.contract({
      task: { ...current, lastEventSequence: 4 },
      events: await f.db.getAll('task-events'),
      conversationTasks: [current],
    });
    expect(contract.definitions.map(({ name }) => name)).toContain('history.search');
    expect(contract.definitions.map(({ name }) => name)).toContain('history.read');
    expect(contract.systemPrompt).toBe('');
  });

  it('excludes the latest applied supplement from search while keeping the earlier question', async () => {
    const f = await fixture();
    const task = await f.seed('current', 1, ['Earlier question', 'Earlier answer'], {
      status: 'planning',
      lastEventSequence: 4,
    });
    const supplementId = 'latest-supplement';
    await f.db.put('messages', {
      id: supplementId,
      kind: 'supplement',
      taskId: task.id,
      conversationId: task.conversationId,
      role: 'user',
      status: 'complete',
      text: 'Question about the earlier answer',
      attachmentIds: [],
      createdAt: 103,
      updatedAt: 103,
    });
    await f.db.put('task-events', {
      id: 'supplement-queued',
      type: 'supplement.queued',
      taskId: task.id,
      runId: 'run_current',
      sequence: 3,
      messageId: supplementId,
      at: 103,
    });
    await f.db.put('task-events', {
      id: 'supplement-applied',
      type: 'supplement.applied',
      taskId: task.id,
      runId: 'run_current',
      sequence: 4,
      messageId: supplementId,
      at: 104,
    });

    const page = await f.reader.searchHistory(f.context, { query: '', cursor: '', limit: 5 });
    if (!page.ok) throw new Error('Expected a search page.');
    expect(page.items.map(({ messageId }) => messageId)).toEqual(['current_1', 'current_0']);
    expect(page.items.flatMap(({ context }) => context.map(({ messageId }) => messageId))).toEqual([
      'current_1',
      'current_0',
    ]);
  });

  it('rejects a message anchor from another task instead of reading unrelated history', async () => {
    const f = await fixture();
    await f.seed('one', 1, ['First question', 'First answer']);
    await f.seed('two', 2, ['Second question', 'Second answer']);
    expect(
      await f.reader.readHistory(f.context, {
        taskId: 'one',
        offset: null,
        messageId: 'two_1',
        cursor: '',
        limit: 5,
      }),
    ).toMatchObject({ ok: false, code: 'HISTORY_NOT_FOUND' });
  });

  it('reads current-task tool results only after their result event is inside the boundary', async () => {
    const f = await fixture();
    const current = await f.seed('current', 1, ['Earlier request'], {
      status: 'planning',
      lastEventSequence: 3,
    });
    await f.db.put('task-events', {
      id: 'call',
      taskId: current.id,
      runId: 'run_current',
      sequence: 2,
      at: 102,
      type: 'tool.call',
      callId: 'read',
      name: 'browser_inspect',
      argumentsJson: '{}',
    });
    await f.db.put('task-events', {
      id: 'result',
      taskId: current.id,
      runId: 'run_current',
      sequence: 3,
      at: 103,
      type: 'tool.result',
      callId: 'read',
    });
    await f.db.put('tool-results', {
      taskId: current.id,
      runId: 'run_current',
      callId: 'read',
      toolName: 'browser_inspect',
      output: 'Exact saved evidence',
      attachmentIds: [],
      createdAt: 103,
    });
    const read = { taskId: current.id, callId: 'read', offset: 0, limit: 100 };
    expect(
      await f.reader.readResult({ ...f.context, currentTaskLastEventSequence: 2 }, read),
    ).toMatchObject({ ok: false, code: 'RESULT_NOT_FOUND' });
    expect(
      await f.reader.readResult({ ...f.context, currentTaskLastEventSequence: 3 }, read),
    ).toMatchObject({ ok: true, content: 'Exact saved evidence' });
    expect(
      await f.reader.readResult({ ...f.context, conversationId: 'foreign' }, read),
    ).toMatchObject({ ok: false, code: 'RESULT_NOT_FOUND' });
  });
});
