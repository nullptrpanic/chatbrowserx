import { describe, expect, it, vi } from 'vitest';
import { providerErrorFromCode } from '../../src/providers/provider-errors';
import { retryProviderOperation } from '../../src/providers/provider-retry';

describe('retryProviderOperation', () => {
  it('uses bounded 1s, 2s, and 4s backoff before the fourth total attempt', async () => {
    const delays: number[] = [];
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(providerErrorFromCode('TRANSIENT', { status: 503 }))
      .mockRejectedValueOnce(providerErrorFromCode('TRANSIENT'))
      .mockRejectedValueOnce(providerErrorFromCode('TRANSIENT'))
      .mockResolvedValue('ok');

    await expect(
      retryProviderOperation(operation, new AbortController().signal, {
        random: () => 0.5,
        sleep: async (delay) => {
          delays.push(delay);
        },
      }),
    ).resolves.toBe('ok');

    expect(operation).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([1_000, 2_000, 4_000]);
  });

  it('caps Retry-After at 30 seconds and stops after three retries', async () => {
    const delays: number[] = [];
    const operation = vi.fn(async () => {
      throw providerErrorFromCode('RATE_LIMIT', { status: 429, retryAfterMs: 90_000 });
    });

    await expect(
      retryProviderOperation(operation, new AbortController().signal, {
        random: () => 0.5,
        sleep: async (delay) => {
          delays.push(delay);
        },
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMIT', status: 429 });

    expect(operation).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([30_000, 30_000, 30_000]);
  });

  it.each(['AUTH', 'INVALID_RESPONSE', 'ABORTED'] as const)(
    'does not retry %s errors',
    async (code) => {
      const operation = vi.fn(async () => {
        throw providerErrorFromCode(code);
      });
      const sleep = vi.fn(async () => undefined);

      await expect(
        retryProviderOperation(operation, new AbortController().signal, {
          random: () => 0.5,
          sleep,
        }),
      ).rejects.toMatchObject({ code });
      expect(operation).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it('turns an abort during backoff into a normalized aborted error', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const operation = vi.fn(async () => {
      throw providerErrorFromCode('TRANSIENT');
    });

    const pending = retryProviderOperation(operation, controller.signal, { random: () => 0.5 });
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    expect(operation).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
