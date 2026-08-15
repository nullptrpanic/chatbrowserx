import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  isProviderError,
  providerErrorFromCode,
} from '../../src/providers/provider-errors';

describe('ProviderError', () => {
  it.each([
    ['AUTH', false, 'Provider authentication failed.'],
    ['RATE_LIMIT', true, 'The model provider rate limit was reached.'],
    ['TRANSIENT', true, 'The model provider is temporarily unavailable.'],
    ['INVALID_RESPONSE', false, 'The model provider returned an invalid response.'],
    ['ABORTED', false, 'The model request was aborted.'],
  ] as const)('normalizes %s without accepting an upstream message', (code, retryable, message) => {
    const error = providerErrorFromCode(code, {
      status: code === 'AUTH' ? 401 : null,
      retryAfterMs: code === 'RATE_LIMIT' ? 2_000 : null,
    });

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code, retryable, message });
    expect(error.status).toBe(code === 'AUTH' ? 401 : null);
    expect(error.retryAfterMs).toBe(code === 'RATE_LIMIT' ? 2_000 : null);
    expect(error).not.toHaveProperty('cause');
    expect(isProviderError(error)).toBe(true);
  });

  it('does not classify arbitrary errors as provider errors', () => {
    expect(isProviderError(new Error('network failed'))).toBe(false);
    expect(isProviderError({ code: 'TRANSIENT' })).toBe(false);
  });
});
