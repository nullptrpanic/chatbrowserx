import { describe, expect, it } from 'vitest';
import { parseRecordedContextCommitToolCall } from '../../../src/agent/tools/context-commit-tool-schema';

function recorded(arguments_: object, overrides: Partial<{ callId: string; name: string }> = {}) {
  return {
    callId: overrides.callId ?? 'call_commit',
    name: overrides.name ?? 'commit_context',
    argumentsJson: JSON.stringify(arguments_),
  };
}

describe('parseRecordedContextCommitToolCall', () => {
  it('accepts current and cursorless legacy checkpoints for recovery only', () => {
    expect(
      parseRecordedContextCommitToolCall(
        recorded({ state: 'Search completed.', throughCallId: 'call_search' }),
      ),
    ).toEqual({ state: 'Search completed.', throughCallId: 'call_search' });
    expect(parseRecordedContextCommitToolCall(recorded({ state: 'Legacy state.' }))).toEqual({
      state: 'Legacy state.',
    });
  });

  it.each([
    recorded({ state: '' }),
    recorded({ state: 'valid', extra: true }),
    recorded({ state: 'valid' }, { name: 'browser_inspect' }),
    recorded({ state: 'valid' }, { callId: '' }),
    { ...recorded({ state: 'valid' }), argumentsJson: '{' },
  ])('rejects malformed durable records', (source) => {
    expect(() => parseRecordedContextCommitToolCall(source)).toThrow();
  });
});
