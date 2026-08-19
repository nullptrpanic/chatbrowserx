import { describe, expect, it } from 'vitest';
import {
  CONTEXT_COMMIT_TOOL_DEFINITION,
  parseContextCommitToolCall,
} from '../../../src/agent/tools/context-commit-tool-schema';

function call(state: string, overrides: Partial<{ callId: string; name: string }> = {}) {
  return {
    callId: overrides.callId ?? 'call_commit',
    name: overrides.name ?? 'commit_context',
    argumentsJson: JSON.stringify({ state }),
  };
}

describe('CONTEXT_COMMIT_TOOL_DEFINITION', () => {
  it('exposes one strict bounded working-state argument', () => {
    expect(CONTEXT_COMMIT_TOOL_DEFINITION).toMatchObject({
      type: 'function',
      name: 'commit_context',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          state: { type: 'string', minLength: 1, maxLength: 8_192 },
        },
        required: ['state'],
        additionalProperties: false,
      },
    });
  });
});

describe('parseContextCommitToolCall', () => {
  it.each(['x', 'x'.repeat(8_192)])(
    'accepts a self-contained state at a valid boundary',
    (state) => {
      expect(parseContextCommitToolCall(call(state))).toEqual({
        callId: 'call_commit',
        name: 'commit_context',
        argumentsJson: JSON.stringify({ state }),
        arguments: { state },
      });
    },
  );

  it.each([
    call(''),
    call('   '),
    call('x'.repeat(8_193)),
    { ...call('valid'), argumentsJson: JSON.stringify({ state: 'valid', extra: true }) },
    { ...call('valid'), argumentsJson: '{' },
    call('valid', { name: 'browser_inspect' }),
    call('valid', { callId: '' }),
    call('valid', { callId: 'x'.repeat(257) }),
    { ...call('valid'), argumentsJson: 'x'.repeat(32 * 1_024 + 1) },
  ])('rejects an invalid commit envelope without exposing parser details', (source) => {
    expect(() => parseContextCommitToolCall(source)).toThrow(
      expect.objectContaining({ code: 'INVALID_RESPONSE' }),
    );
  });
});
