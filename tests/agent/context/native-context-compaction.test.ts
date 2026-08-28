import { describe, expect, it } from 'vitest';
import {
  AUTO_COMPACT_INPUT_TOKEN_HARD_WATER,
  AUTO_COMPACT_INPUT_TOKEN_HIGH_WATER,
  createNativeCompactionContinuation,
  shouldUseNativeContextCompaction,
} from '../../../src/agent/context/native-context-compaction';
import { CODEX_EFFECTIVE_CONTEXT_WINDOW_TOKENS } from '../../../src/providers/codex/codex-constants';
import type { Checkpoint } from '../../../src/tasks/checkpoint-types';
import type { ContinuationItem } from '../../../src/tasks/continuation-types';
import type { MaterializedToolResult } from '../../../src/tasks/tool-result-types';

function pair(index: number): readonly ContinuationItem[] {
  return [
    {
      type: 'function_call',
      callId: `call_${index}`,
      name: 'browser_inspect',
      argumentsJson: '{}',
    },
    {
      type: 'function_call_output_ref',
      callId: `call_${index}`,
      resultId: `result_${index}`,
    },
  ];
}

function toolResults(items: readonly ContinuationItem[]): MaterializedToolResult[] {
  const calls = new Map(
    items.flatMap((item) => (item.type === 'function_call' ? [[item.callId, item] as const] : [])),
  );
  return items.flatMap((item): MaterializedToolResult[] => {
    if (item.type !== 'function_call_output_ref') return [];
    const call = calls.get(item.callId);
    if (call === undefined) throw new Error('Tool result fixture is missing its call.');
    return [
      {
        id: item.resultId,
        taskId: 'task_1',
        runId: 'run_1',
        callId: item.callId,
        toolName: call.name,
        argumentsJson: call.argumentsJson,
        output: item.resultId.includes('rejected') ? '{"ok":false}' : '{"ok":true}',
        attachmentIds: [],
        createdAt: 100,
      },
    ];
  });
}

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: 'checkpoint_1',
    taskId: 'task_1',
    runId: 'run_1',
    continuationItems: [{ type: 'message_ref', messageId: 'message_user' }, ...pair(1)],
    pendingToolCall: null,
    lastModelInputTokens: AUTO_COMPACT_INPUT_TOKEN_HIGH_WATER,
    browserToolCallsInAttempt: 0,
    browserTargetTabId: 7,
    createdAt: 100,
    ...overrides,
  };
}

function shouldCompact(value: Checkpoint, unmeasuredInputTokens = 0): boolean {
  return shouldUseNativeContextCompaction(
    value,
    toolResults(value.continuationItems),
    unmeasuredInputTokens,
  );
}

describe('native context compaction', () => {
  it('keeps both trigger levels below the fixed model effective context window', () => {
    expect(AUTO_COMPACT_INPUT_TOKEN_HIGH_WATER).toBeLessThan(CODEX_EFFECTIVE_CONTEXT_WINDOW_TOKENS);
    expect(AUTO_COMPACT_INPUT_TOKEN_HARD_WATER).toBeLessThan(CODEX_EFFECTIVE_CONTEXT_WINDOW_TOKENS);
  });

  it('uses actual provider input tokens and requires completed compactable work', () => {
    expect(
      shouldCompact(checkpoint({ lastModelInputTokens: AUTO_COMPACT_INPUT_TOKEN_HIGH_WATER - 1 })),
    ).toBe(false);
    expect(shouldCompact(checkpoint())).toBe(true);
    expect(
      shouldCompact(
        checkpoint({ lastModelInputTokens: AUTO_COMPACT_INPUT_TOKEN_HIGH_WATER - 4_000 }),
        4_000,
      ),
    ).toBe(true);
    expect(
      shouldCompact(
        checkpoint({ continuationItems: [{ type: 'message_ref', messageId: 'message_user' }] }),
      ),
    ).toBe(false);
    expect(
      shouldCompact(
        checkpoint({
          pendingToolCall: {
            callId: 'call_1',
            name: 'browser_inspect',
            argumentsJson: '{}',
            executionState: 'recorded',
          },
        }),
      ),
    ).toBe(false);
  });

  it('prevents immediate repeat compaction until enough new work accumulates', () => {
    const compacted: ContinuationItem[] = [
      { type: 'message_ref', messageId: 'message_user' },
      { type: 'compaction', itemId: 'cmp_previous', encryptedContent: 'opaque-previous' },
      ...pair(1),
    ];
    expect(shouldCompact(checkpoint({ continuationItems: compacted }))).toBe(false);
    expect(
      shouldCompact(
        checkpoint({
          continuationItems: [
            ...compacted.slice(0, 2),
            ...Array.from({ length: 8 }, (_, index) => pair(index + 1)).flat(),
          ],
        }),
      ),
    ).toBe(true);
    expect(
      shouldCompact(
        checkpoint({
          lastModelInputTokens: AUTO_COMPACT_INPUT_TOKEN_HARD_WATER,
          continuationItems: compacted,
        }),
      ),
    ).toBe(true);
  });

  it('treats only a successful context commit as an existing compaction boundary', () => {
    const rejectedContextCommit: ContinuationItem[] = [
      { type: 'message_ref', messageId: 'message_user' },
      {
        type: 'function_call',
        callId: 'call_context_commit',
        name: 'commit_context',
        argumentsJson: '{"state":"Current state.","throughCallId":"call_previous"}',
      },
      {
        type: 'function_call_output_ref',
        callId: 'call_context_commit',
        resultId: 'result_context_commit_rejected',
      },
      ...pair(1),
    ];

    expect(shouldCompact(checkpoint({ continuationItems: rejectedContextCommit }))).toBe(true);
  });

  it('retains ordered local message references and replaces opaque tool state once', () => {
    const continuationItems: ContinuationItem[] = [
      { type: 'message_ref', messageId: 'message_user' },
      ...pair(1),
      { type: 'message_ref', messageId: 'message_supplement' },
      ...pair(2),
    ];

    expect(
      createNativeCompactionContinuation(continuationItems, {
        itemId: 'cmp_new',
        encryptedContent: 'opaque-new-context',
      }),
    ).toEqual([
      { type: 'message_ref', messageId: 'message_user' },
      { type: 'message_ref', messageId: 'message_supplement' },
      { type: 'compaction', itemId: 'cmp_new', encryptedContent: 'opaque-new-context' },
    ]);
  });
});
