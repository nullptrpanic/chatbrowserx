import { describe, expect, it } from 'vitest';
import { parseToolCallArguments } from '../../../src/tools/contracts/tool-call-envelope';

describe('parseToolCallArguments', () => {
  it('returns parsed JSON for a bounded call envelope', () => {
    expect(
      parseToolCallArguments({
        callId: 'call_1',
        name: 'lookup',
        argumentsJson: '{"key":"value"}',
      }),
    ).toEqual({ key: 'value' });
  });

  it.each([
    { callId: '', name: 'lookup', argumentsJson: '{}' },
    { callId: 'x'.repeat(257), name: 'lookup', argumentsJson: '{}' },
    { callId: 'call_1', name: 'lookup', argumentsJson: '{' },
    { callId: 'call_1', name: 'lookup', argumentsJson: 'x'.repeat(32 * 1_024 + 1) },
  ])('rejects invalid envelopes', (input) => {
    expect(() => parseToolCallArguments(input)).toThrow('Tool call envelope is invalid.');
  });
});
