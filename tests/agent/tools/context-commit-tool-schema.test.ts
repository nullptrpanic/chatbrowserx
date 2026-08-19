import { describe, expect, it } from 'vitest';
import {
  CONTEXT_COMMIT_TOOL_DEFINITION,
  parseContextCommitToolCall,
} from '../../../src/agent/tools/context-commit-tool-schema';

function call(
  state: string,
  overrides: Partial<{ callId: string; name: string; throughCallId: string }> = {},
) {
  const throughCallId = overrides.throughCallId ?? 'call_previous';
  return {
    callId: overrides.callId ?? 'call_commit',
    name: overrides.name ?? 'commit_context',
    argumentsJson: JSON.stringify({ state, throughCallId }),
  };
}

describe('CONTEXT_COMMIT_TOOL_DEFINITION', () => {
  it('requires a stable inclusive tool-call cursor with the bounded working state', () => {
    expect(CONTEXT_COMMIT_TOOL_DEFINITION).toMatchObject({
      type: 'function',
      name: 'commit_context',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          state: { type: 'string', minLength: 1, maxLength: 8_192 },
          throughCallId: { type: 'string', minLength: 1, maxLength: 256 },
        },
        required: ['state', 'throughCallId'],
        additionalProperties: false,
      },
    });
  });

  it('keeps checkpoints factual instead of persisting speculative recovery plans', () => {
    const parameters = CONTEXT_COMMIT_TOOL_DEFINITION.parameters as {
      readonly properties: {
        readonly state: { readonly description?: string };
      };
    };

    expect(CONTEXT_COMMIT_TOOL_DEFINITION.description).toContain('verified facts');
    expect(CONTEXT_COMMIT_TOOL_DEFINITION.description).toContain('failed actions');
    expect(CONTEXT_COMMIT_TOOL_DEFINITION.description).not.toContain('exact next step');
    expect(parameters.properties.state.description).toContain('evidence-backed');
  });
});

describe('parseContextCommitToolCall', () => {
  it.each(['x', 'x'.repeat(8_192)])(
    'accepts a self-contained state at a valid boundary',
    (state) => {
      expect(parseContextCommitToolCall(call(state))).toEqual({
        callId: 'call_commit',
        name: 'commit_context',
        argumentsJson: JSON.stringify({ state, throughCallId: 'call_previous' }),
        arguments: { state, throughCallId: 'call_previous' },
      });
    },
  );

  it.each([
    call(''),
    call('   '),
    call('x'.repeat(8_193)),
    call('valid', { throughCallId: '' }),
    call('valid', { throughCallId: '   ' }),
    call('valid', { throughCallId: 'x'.repeat(257) }),
    { ...call('valid'), argumentsJson: JSON.stringify({ state: 'valid' }) },
    {
      ...call('valid'),
      argumentsJson: JSON.stringify({
        state: 'valid',
        throughCallId: 'call_previous',
        extra: true,
      }),
    },
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
