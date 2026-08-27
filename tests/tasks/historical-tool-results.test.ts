// @vitest-environment node

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openChatBrowserDatabase } from '../../src/persistence/open-database';
import { IndexedDbTaskRepository } from '../../src/persistence/task-repository';
import {
  HistoricalToolResultService,
  type HistoricalToolResultSearchInput,
} from '../../src/tasks/historical-tool-results';
import type { CompletedToolResult, Checkpoint } from '../../src/tasks/checkpoint-types';
import type { TaskRun, TaskStatus } from '../../src/tasks/task-types';
import { createTestDatabaseName } from '../persistence/test-helpers';

const CONTEXT = { conversationId: 'conversation_1', currentTaskId: 'task_active' } as const;

function result(
  resultRef: string,
  toolName: string,
  output: string,
  argumentsJson = '{}',
): CompletedToolResult {
  return {
    callId: `call_${resultRef}`,
    toolName,
    argumentsJson,
    output,
    resultRef,
    attachmentIds: [],
  };
}

function task(
  id: string,
  workSessionId: string,
  status: TaskStatus,
  updatedAt: number,
  conversationId: string = CONTEXT.conversationId,
): TaskRun {
  return {
    id,
    workSessionId,
    conversationId,
    tabId: 7,
    goal: id,
    status,
    createdAt: updatedAt - 10,
    updatedAt,
    checkpointId: `checkpoint_${id}`,
    lease: null,
    lastError: null,
  };
}

function checkpoint(owner: TaskRun, results: readonly CompletedToolResult[]): Checkpoint {
  return {
    id: owner.checkpointId ?? `checkpoint_${owner.id}`,
    taskId: owner.id,
    sequence: results.length + 1,
    taskStatus: owner.status,
    completedToolResults: results,
    continuationItems: [],
    pendingToolCall: null,
    createdAt: owner.updatedAt,
  };
}

async function seed(
  label: string,
  records: readonly {
    readonly task: TaskRun;
    readonly results: readonly CompletedToolResult[];
  }[],
) {
  const database = await openChatBrowserDatabase(createTestDatabaseName(label));
  for (const record of records) {
    await database.add('tasks', record.task);
    await database.add('checkpoints', checkpoint(record.task, record.results));
  }
  return {
    database,
    service: new HistoricalToolResultService(new IndexedDbTaskRepository(database)),
  };
}

function searchInput(
  overrides: Partial<HistoricalToolResultSearchInput> = {},
): HistoricalToolResultSearchInput {
  return {
    scope: 'current_conversation',
    taskId: null,
    query: '',
    toolName: null,
    limit: 20,
    ...overrides,
  };
}

describe('HistoricalToolResultService', () => {
  it('searches terminal tasks only and deduplicates continued WorkSession results', async () => {
    const cancelled = task('task_cancelled', 'work_1', 'cancelled', 100);
    const continued = task('task_continued', 'work_1', 'completed', 200);
    const previous = task('task_previous', 'work_2', 'completed', 300);
    const active = task('task_active', 'work_3', 'planning', 400);
    const otherConversation = task('task_other', 'work_other', 'completed', 500, 'conversation_2');
    const shared = result(
      'result_shared',
      'browser_network_get',
      '{"ok":true,"url":"https://api.example.test/orders"}',
    );
    const fixture = await seed('historical-terminal-deduplication', [
      { task: cancelled, results: [shared] },
      {
        task: continued,
        results: [shared, result('result_continued', 'browser_inspect', '{"ok":true}')],
      },
      {
        task: previous,
        results: [result('result_previous', 'sandbox_exec', '{"code":0,"stdout":"done"}')],
      },
      {
        task: active,
        results: [result('result_active', 'browser_inspect', '{"ok":true,"private":true}')],
      },
      {
        task: otherConversation,
        results: [result('result_other', 'sandbox_exec', '{"code":0,"stdout":"secret"}')],
      },
    ]);

    const all = await fixture.service.search(CONTEXT, searchInput());
    const previousTask = await fixture.service.search(
      CONTEXT,
      searchInput({ scope: 'previous_task' }),
    );

    expect(all.ok).toBe(true);
    if (!all.ok) throw new Error('Expected search to succeed.');
    expect(all.results.map(({ evidenceId }) => evidenceId)).toEqual([
      'result_previous',
      'result_continued',
      'result_shared',
    ]);
    expect(all.results.find(({ evidenceId }) => evidenceId === 'result_shared')).toMatchObject({
      taskId: 'task_cancelled',
      taskStatus: 'cancelled',
    });
    expect(previousTask).toMatchObject({
      ok: true,
      results: [{ evidenceId: 'result_previous', taskId: 'task_previous' }],
    });
    await expect(fixture.service.hasEvidence(CONTEXT)).resolves.toBe(true);
    fixture.database.close();
  });

  it('resolves task_id inside the current conversation and rejects cross-conversation reads', async () => {
    const selected = task('task_selected', 'work_selected', 'failed', 100);
    const other = task('task_other', 'work_other', 'completed', 200, 'conversation_2');
    const fixture = await seed('historical-ownership', [
      {
        task: selected,
        results: [result('result_selected', 'tavily_search', '{"ok":true,"results":[]}')],
      },
      {
        task: other,
        results: [result('result_other', 'sandbox_exec', '{"code":0,"stdout":"private"}')],
      },
      { task: task('task_active', 'work_active', 'planning', 300), results: [] },
    ]);

    await expect(
      fixture.service.search(CONTEXT, searchInput({ scope: 'task_id', taskId: 'task_selected' })),
    ).resolves.toMatchObject({
      ok: true,
      results: [{ evidenceId: 'result_selected', taskStatus: 'failed' }],
    });
    await expect(
      fixture.service.search(CONTEXT, searchInput({ scope: 'task_id', taskId: 'task_other' })),
    ).resolves.toEqual({
      ok: false,
      code: 'TASK_NOT_FOUND',
      message: 'The requested historical task is unavailable in this conversation.',
      retryable: false,
    });
    await expect(
      fixture.service.read(CONTEXT, { evidenceId: 'result_other', offset: 0, limit: 100 }),
    ).resolves.toEqual({
      ok: false,
      code: 'EVIDENCE_NOT_FOUND',
      message: 'The requested historical tool evidence is unavailable in this conversation.',
      retryable: false,
    });
    fixture.database.close();
  });

  it('reads exact persisted output in bounded chunks with explicit completeness metadata', async () => {
    const previous = task('task_previous', 'work_previous', 'completed', 100);
    const fixture = await seed('historical-read-chunks', [
      {
        task: previous,
        results: [
          result(
            'result_exact',
            'browser_network_get',
            '{"ok":true,"body":"abcdef","truncated":true}',
          ),
          result('result_metadata', 'browser_network_list', '{"ok":true,"requests":[1]}'),
          result('result_complete', 'sandbox_exec', '{"code":0,"stdout":"complete"}'),
        ],
      },
      { task: task('task_active', 'work_active', 'planning', 200), results: [] },
    ]);
    const exact = '{"ok":true,"body":"abcdef","truncated":true}';

    const first = await fixture.service.read(CONTEXT, {
      evidenceId: 'result_exact',
      offset: 5,
      limit: 12,
    });
    const tail = await fixture.service.read(CONTEXT, {
      evidenceId: 'result_exact',
      offset: exact.length,
      limit: 12,
    });
    const search = await fixture.service.search(CONTEXT, searchInput());

    expect(first).toEqual({
      ok: true,
      evidenceId: 'result_exact',
      taskId: 'task_previous',
      taskStatus: 'completed',
      toolName: 'browser_network_get',
      content: exact.slice(5, 17),
      offset: 5,
      returnedLength: 12,
      totalLength: exact.length,
      hasMore: true,
      contentState: 'truncated',
      contentSource: 'stored_tool_output',
    });
    expect(tail).toMatchObject({ content: '', returnedLength: 0, hasMore: false });
    expect(search).toMatchObject({
      ok: true,
      results: expect.arrayContaining([
        expect.objectContaining({ evidenceId: 'result_exact', contentState: 'truncated' }),
        expect.objectContaining({ evidenceId: 'result_metadata', contentState: 'metadata_only' }),
        expect.objectContaining({ evidenceId: 'result_complete', contentState: 'complete' }),
      ]),
    });
    fixture.database.close();
  });

  it('filters by query and tool name without indexing internal maintenance results', async () => {
    const previous = task('task_previous', 'work_previous', 'completed', 100);
    const fixture = await seed('historical-filtering', [
      {
        task: previous,
        results: [
          result(
            'result_match',
            'browser_network_get',
            '{"ok":true,"url":"https://api.example.test/orders","status":200}',
            '{"requestId":"order-request"}',
          ),
          result('result_other', 'sandbox_exec', '{"code":0,"stdout":"orders cached"}'),
          result('result_commit', 'commit_context', '{"ok":true}'),
          result('result_search', 'task_result_search', '{"ok":true}'),
          result('result_read', 'task_result_read', '{"ok":true}'),
        ],
      },
      { task: task('task_active', 'work_active', 'planning', 200), results: [] },
    ]);

    const response = await fixture.service.search(
      CONTEXT,
      searchInput({ query: 'orders status', toolName: 'browser_network_get' }),
    );

    expect(response).toMatchObject({
      ok: true,
      results: [{ evidenceId: 'result_match', toolName: 'browser_network_get' }],
    });
    const all = await fixture.service.search(CONTEXT, searchInput());
    expect(all.ok && all.results.map(({ evidenceId }) => evidenceId)).toEqual([
      'result_other',
      'result_match',
    ]);
    fixture.database.close();
  });
});
