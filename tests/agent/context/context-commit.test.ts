import { describe, expect, it } from 'vitest';
import { compactContextAtCommit } from '../../../src/agent/context/context-commit';
import type { ContinuationItem, PendingToolCall } from '../../../src/tasks/continuation-types';

const userMessage: ContinuationItem = {
  type: 'message_ref',
  messageId: 'message_user',
};
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

function currentCommit(
  throughCallId: string,
  state = 'Goal: continue from the saved state.',
): {
  readonly call: Extract<ContinuationItem, { readonly type: 'function_call' }>;
  readonly pending: PendingToolCall;
} {
  const argumentsJson = JSON.stringify({
    state,
    throughCallId,
  });
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

describe('compactContextAtCommit', () => {
  it('releases encrypted reasoning with its compacted tool pair', () => {
    const current = currentCommit('call_short');
    const callWithReasoning: ContinuationItem = {
      ...shortCall,
      modelOutputItems: [
        {
          type: 'reasoning',
          itemId: 'reasoning_short',
          encryptedContent: 'opaque',
          summary: [{ type: 'summary_text', text: 'summary' }],
        },
      ],
    };

    const compacted = compactContextAtCommit(
      [userMessage, callWithReasoning, shortOutput, current.call],
      current.pending,
      'result_commit',
    );

    expect(compacted.stats.releasedTextChars).toBe(2 + 2 + 6 + 7);
    expect(JSON.stringify(compacted.continuationItems)).not.toContain('opaque');
  });

  it('replaces prior tool pairs with the current commit while retaining every message ref', () => {
    const current = currentCommit('call_click');
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

  it('compacts through the cursor and keeps later tool pairs after the commit boundary', () => {
    const current = currentCommit('call_inspect');
    const laterCall: ContinuationItem = {
      type: 'function_call',
      callId: 'call_click',
      name: 'browser_click',
      argumentsJson: 'DEF',
    };
    const laterOutput: ContinuationItem = {
      type: 'function_call_output',
      callId: 'call_click',
      output: 'G',
      resultRef: 'result_click',
      attachmentIds: ['image_2'],
    };
    const afterCursorMessage: ContinuationItem = {
      type: 'message_ref',
      messageId: 'message_after_cursor',
    };
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
        attachmentIds: ['image_1'],
      },
      supplement,
      laterCall,
      laterOutput,
      afterCursorMessage,
      current.call,
    ];

    const compacted = compactContextAtCommit(items, current.pending, 'result_commit');

    expect(compacted.stats).toEqual({
      compactedCalls: 1,
      releasedTextChars: 3,
      releasedImages: 1,
    });
    expect(compacted.continuationItems).toEqual([
      userMessage,
      current.call,
      {
        type: 'function_call_output',
        callId: 'call_commit',
        output: '{"ok":true,"compactedCalls":1,"releasedTextChars":3,"releasedImages":1}',
        resultRef: 'result_commit',
        attachmentIds: [],
      },
      supplement,
      laterCall,
      laterOutput,
      afterCursorMessage,
    ]);
  });

  it('lets a later commit replace an older commit and the raw results after it', () => {
    const current = currentCommit('call_short');
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

  it('expires browser refs and snapshot ids in the active committed state', () => {
    const current = currentCommit(
      'call_short',
      'Continue with ref e1a2b3c4d5e6 and snapshot s0123456789abcdef0123 at screenshot x=420 y=315.',
    );
    const compacted = compactContextAtCommit(
      [userMessage, shortCall, shortOutput, current.call],
      current.pending,
      'result_commit',
    );
    const committedCall = compacted.continuationItems.find(
      (item) => item.type === 'function_call' && item.callId === 'call_commit',
    );
    if (!committedCall || committedCall.type !== 'function_call') {
      throw new Error('Expected committed function call.');
    }
    const committedArguments = JSON.parse(committedCall.argumentsJson) as {
      readonly state: string;
    };

    expect(committedArguments.state).not.toContain('e1a2b3c4d5e6');
    expect(committedArguments.state).not.toContain('s0123456789abcdef0123');
    expect(committedArguments.state).toContain('fresh interactive inspection');
  });

  it('rejects malformed or empty commit boundaries', () => {
    const current = currentCommit('call_short');
    const wrongPending: PendingToolCall = {
      ...current.pending,
      callId: 'call_wrong',
    };

    expect(() =>
      compactContextAtCommit(
        [userMessage, shortCall, { ...shortOutput, callId: 'call_wrong' }, current.call],
        current.pending,
        'result_commit',
      ),
    ).toThrow('Context continuation is invalid.');
    expect(() =>
      compactContextAtCommit([userMessage, current.call], current.pending, 'result_commit'),
    ).toThrow();
    expect(() =>
      compactContextAtCommit(
        [userMessage, shortCall, shortOutput, current.call],
        wrongPending,
        'result_commit',
      ),
    ).toThrow('Pending context commit is invalid.');
  });

  it('rejects a cursor that is unknown, points to a commit, or precedes the latest commit', () => {
    const unknown = currentCommit('call_unknown');
    const pointsToCommit = currentCommit('call_old_commit');
    const beforeLatestCommit = currentCommit('call_short');

    expect(() =>
      compactContextAtCommit(
        [userMessage, shortCall, shortOutput, unknown.call],
        unknown.pending,
        'result_commit',
      ),
    ).toThrow();
    expect(() =>
      compactContextAtCommit(
        [userMessage, commitCall, commitOutput, pointsToCommit.call],
        pointsToCommit.pending,
        'result_commit',
      ),
    ).toThrow();
    expect(() =>
      compactContextAtCommit(
        [userMessage, shortCall, shortOutput, commitCall, commitOutput, beforeLatestCommit.call],
        beforeLatestCommit.pending,
        'result_commit',
      ),
    ).toThrow();
  });
});
