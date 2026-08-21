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

function pair(index: number): readonly ContinuationItem[] {
  return [
    {
      type: 'function_call',
      callId: `call_${index}`,
      name: 'browser_inspect',
      argumentsJson: '{}',
    },
    {
      type: 'function_call_output',
      callId: `call_${index}`,
      output: '{"ok":true}',
      resultRef: `result_${index}`,
    },
  ];
}

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: 'checkpoint_1',
    taskId: 'task_1',
    sequence: 1,
    taskStatus: 'planning',
    completedToolResults: [],
    continuationItems: [{ type: 'message_ref', messageId: 'message_user' }, ...pair(1)],
    pendingToolCall: null,
    lastModelInputTokens: AUTO_COMPACT_INPUT_TOKEN_HIGH_WATER,
    createdAt: 100,
    ...overrides,
  };
}

describe('native context compaction', () => {
  it('keeps both trigger levels below the fixed model effective context window', () => {
    expect(AUTO_COMPACT_INPUT_TOKEN_HIGH_WATER).toBeLessThan(CODEX_EFFECTIVE_CONTEXT_WINDOW_TOKENS);
    expect(AUTO_COMPACT_INPUT_TOKEN_HARD_WATER).toBeLessThan(CODEX_EFFECTIVE_CONTEXT_WINDOW_TOKENS);
  });

  it('uses actual provider input tokens and requires completed compactable work', () => {
    expect(
      shouldUseNativeContextCompaction(
        checkpoint({ lastModelInputTokens: AUTO_COMPACT_INPUT_TOKEN_HIGH_WATER - 1 }),
      ),
    ).toBe(false);
    expect(shouldUseNativeContextCompaction(checkpoint())).toBe(true);
    expect(
      shouldUseNativeContextCompaction(
        checkpoint({ continuationItems: [{ type: 'message_ref', messageId: 'message_user' }] }),
      ),
    ).toBe(false);
    expect(
      shouldUseNativeContextCompaction(
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
    expect(shouldUseNativeContextCompaction(checkpoint({ continuationItems: compacted }))).toBe(
      false,
    );
    expect(
      shouldUseNativeContextCompaction(
        checkpoint({
          continuationItems: [
            ...compacted.slice(0, 2),
            ...Array.from({ length: 8 }, (_, index) => pair(index + 1)).flat(),
          ],
        }),
      ),
    ).toBe(true);
    expect(
      shouldUseNativeContextCompaction(
        checkpoint({
          lastModelInputTokens: AUTO_COMPACT_INPUT_TOKEN_HARD_WATER,
          continuationItems: compacted,
        }),
      ),
    ).toBe(true);
  });

  it('treats only a successful legacy commit as an existing compaction boundary', () => {
    const rejectedLegacyCommit: ContinuationItem[] = [
      { type: 'message_ref', messageId: 'message_user' },
      {
        type: 'function_call',
        callId: 'call_legacy_commit',
        name: 'commit_context',
        argumentsJson: '{"state":"legacy"}',
      },
      {
        type: 'function_call_output',
        callId: 'call_legacy_commit',
        output: '{"ok":false}',
        resultRef: 'result_legacy_commit',
      },
      ...pair(1),
    ];

    expect(
      shouldUseNativeContextCompaction(checkpoint({ continuationItems: rejectedLegacyCommit })),
    ).toBe(true);
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
