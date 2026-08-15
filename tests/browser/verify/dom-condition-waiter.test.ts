import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomConditionWaiter } from '../../../src/browser/verify/dom-condition-waiter';

afterEach(() => {
  vi.useRealTimers();
});

describe('DomConditionWaiter', () => {
  it('resolves from a relevant event without waiting for the fallback poll', async () => {
    vi.useFakeTimers();
    let wake: (() => void) | undefined;
    let ready = false;
    const unsubscribe = vi.fn();
    const waiter = new DomConditionWaiter({
      subscribe(listener) {
        wake = listener;
        return unsubscribe;
      },
    });
    const pending = waiter.waitFor(async () => ready, { timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(0);

    ready = true;
    wake?.();

    await expect(pending).resolves.toMatchObject({ satisfied: true, timedOut: false });
    expect(vi.getTimerCount()).toBe(0);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('falls back to 250ms polling and cleans timers after success', async () => {
    vi.useFakeTimers();
    let ready = false;
    const waiter = new DomConditionWaiter();
    const pending = waiter.waitFor(async () => ready, { timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(0);
    ready = true;

    await vi.advanceTimersByTimeAsync(250);

    await expect(pending).resolves.toMatchObject({ satisfied: true, timedOut: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns a bounded timeout and rejects an aborted wait', async () => {
    vi.useFakeTimers();
    const waiter = new DomConditionWaiter();
    const timeout = waiter.waitFor(async () => false, { timeoutMs: 50_000 });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(timeout).resolves.toMatchObject({ satisfied: false, timedOut: true });
    expect(vi.getTimerCount()).toBe(0);

    const controller = new AbortController();
    const aborted = waiter.waitFor(async () => false, {
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
