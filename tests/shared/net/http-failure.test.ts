import { describe, expect, it, vi } from 'vitest';
import { inspectHttpFailure } from '../../../src/shared/net/http-failure';

describe('inspectHttpFailure', () => {
  it('classifies a non-2xx response without waiting for an unending body', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
        cancel,
      }),
      {
        status: 503,
        headers: { 'Retry-After': '2' },
      },
    );

    const inspected = Promise.race([
      inspectHttpFailure(response),
      new Promise<'timed_out'>((resolve) => {
        globalThis.setTimeout(() => resolve('timed_out'), 25);
      }),
    ]);
    await expect(inspected).resolves.toEqual({
      status: 503,
      retryAfterMs: 2_000,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
