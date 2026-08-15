import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DebuggerEventListener } from '../../../src/platform/chrome/debugger-events';
import { NavigationWaiter } from '../../../src/browser/verify/navigation-waiter';

afterEach(() => {
  vi.useRealTimers();
});

describe('NavigationWaiter', () => {
  it('resets the quiet window after relevant lifecycle activity', async () => {
    vi.useFakeTimers();
    let listener: DebuggerEventListener | undefined;
    let now = 1_000;
    const waiter = new NavigationWaiter(
      {
        subscribe(next) {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      },
      { now: () => now },
    );
    const pending = waiter.waitForStable(7, 500, 2_000);
    await vi.advanceTimersByTimeAsync(250);
    now = 1_250;
    listener?.({
      kind: 'protocol_event',
      tabId: 7,
      sessionId: null,
      method: 'Page.frameNavigated',
      params: {},
    });
    now = 1_500;
    await vi.advanceTimersByTimeAsync(250);
    now = 1_750;
    await vi.advanceTimersByTimeAsync(250);

    await expect(pending).resolves.toEqual({ satisfied: true, quietMs: 500 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
