import { describe, expect, it } from 'vitest';
import {
  compactContextAtCommit,
  hasContextCommitCandidate,
} from '../../../src/agent/context/context-commit';
import type { ContinuationItem, PendingToolCall } from '../../../src/tasks/continuation-types';

const userMessage: ContinuationItem = { type: 'message_ref', messageId: 'message_user' };
const supplement: ContinuationItem = {
  type: 'message_ref',
  messageId: 'message_supplement',
};
const commitCall: ContinuationItem = {
  type: 'function_call',
  callId: 'call_old_commit',
  name: 'commit_context',
  argumentsJson: 'old-state',
};
const commitOutput: ContinuationItem = {
  type: 'function_call_output',
  callId: 'call_old_commit',
  output: 'old-ack',
  resultRef: 'result_old_commit',
  attachmentIds: [],
};
const shortCall: ContinuationItem = {
  type: 'function_call',
  callId: 'call_short',
  name: 'browser_get_current_tab',
  argumentsJson: '{}',
};
const shortOutput: ContinuationItem = {
  type: 'function_call_output',
  callId: 'call_short',
  output: '{}',
  resultRef: 'result_short',
  attachmentIds: [],
};

function currentCommit(): {
  readonly call: Extract<ContinuationItem, { readonly type: 'function_call' }>;
  readonly pending: PendingToolCall;
} {
  const argumentsJson = JSON.stringify({ state: 'Goal: continue from the saved state.' });
  return {
    call: {
      type: 'function_call',
      callId: 'call_commit',
      name: 'commit_context',
      argumentsJson,
    },
    pending: {
      callId: 'call_commit',
      name: 'commit_context',
      argumentsJson,
      executionState: 'recorded',
    },
  };
}

describe('hasContextCommitCandidate', () => {
  it('does not expose commit without a completed non-commit result', () => {
    expect(hasContextCommitCandidate([userMessage])).toBe(false);
    expect(hasContextCommitCandidate([userMessage, commitCall, commitOutput])).toBe(false);
    expect(
      hasContextCommitCandidate([userMessage, shortCall, shortOutput, commitCall, commitOutput]),
    ).toBe(false);
  });

  it('exposes commit after one short completed result regardless of context length', () => {
    expect(hasContextCommitCandidate([userMessage, shortCall, shortOutput])).toBe(true);
    expect(
      hasContextCommitCandidate([userMessage, commitCall, commitOutput, shortCall, shortOutput]),
    ).toBe(true);
  });
});

describe('compactContextAtCommit', () => {
  it('replaces prior tool pairs with the current commit while retaining every message ref', () => {
    const current = currentCommit();
    const items: ContinuationItem[] = [
      userMessage,
      {
        type: 'function_call',
        callId: 'call_inspect',
        name: 'browser_inspect',
        argumentsJson: 'A',
      },
      {
        type: 'function_call_output',
        callId: 'call_inspect',
        output: 'BC',
        resultRef: 'result_inspect',
        attachmentIds: ['image_1', 'image_2'],
      },
      supplement,
      {
        type: 'function_call',
        callId: 'call_click',
        name: 'browser_click',
        argumentsJson: 'DEF',
      },
      {
        type: 'function_call_output',
        callId: 'call_click',
        output: 'G',
        resultRef: 'result_click',
        attachmentIds: ['image_2'],
      },
      current.call,
    ];

    const compacted = compactContextAtCommit(items, current.pending, 'result_commit');

    expect(compacted.stats).toEqual({
      compactedCalls: 2,
      releasedTextChars: 7,
      releasedImages: 2,
    });
    expect(compacted.output).toBe(
      '{"ok":true,"compactedCalls":2,"releasedTextChars":7,"releasedImages":2}',
    );
    expect(compacted.continuationItems).toEqual([
      userMessage,
      supplement,
      current.call,
      {
        type: 'function_call_output',
        callId: 'call_commit',
        output: '{"ok":true,"compactedCalls":2,"releasedTextChars":7,"releasedImages":2}',
        resultRef: 'result_commit',
        attachmentIds: [],
      },
    ]);
  });

  it('lets a later commit replace an older commit and the raw results after it', () => {
    const current = currentCommit();
    const compacted = compactContextAtCommit(
      [userMessage, commitCall, commitOutput, shortCall, shortOutput, current.call],
      current.pending,
      'result_commit',
    );

    expect(compacted.stats).toEqual({
      compactedCalls: 2,
      releasedTextChars: 20,
      releasedImages: 0,
    });
    expect(compacted.continuationItems.map((item) => item.type)).toEqual([
      'message_ref',
      'function_call',
      'function_call_output',
    ]);
  });

  it('rejects malformed or empty commit boundaries', () => {
    const current = currentCommit();
    const wrongPending: PendingToolCall = { ...current.pending, callId: 'call_wrong' };

    expect(() =>
      compactContextAtCommit(
        [userMessage, shortCall, { ...shortOutput, callId: 'call_wrong' }, current.call],
        current.pending,
        'result_commit',
      ),
    ).toThrow('Context continuation is invalid.');
    expect(() =>
      compactContextAtCommit([userMessage, current.call], current.pending, 'result_commit'),
    ).toThrow('There are no new tool results to commit.');
    expect(() =>
      compactContextAtCommit(
        [userMessage, shortCall, shortOutput, current.call],
        wrongPending,
        'result_commit',
      ),
    ).toThrow('Pending context commit is invalid.');
  });
});
