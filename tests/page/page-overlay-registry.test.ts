import { afterEach, expect, it, vi } from 'vitest';
import {
  registerPageOverlayHost,
  setPageOverlaysHidden,
} from '../../src/page/page-overlay-registry';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('acknowledges hiding only after a rendering opportunity, and restores without waiting', async () => {
  vi.useFakeTimers();
  const host = document.createElement('div');
  const unregister = registerPageOverlayHost(host);
  try {
    const finished = vi.fn();
    const hidden = Promise.resolve(setPageOverlaysHidden(true)).then(finished);
    expect(host.style.visibility).toBe('hidden');
    await vi.advanceTimersByTimeAsync(1);
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15);
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(32);
    await hidden;
    expect(finished).toHaveBeenCalledOnce();
    await setPageOverlaysHidden(false);
    expect(host.style.visibility).toBe('visible');
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    unregister();
  }
});

it('fails a capture instead of acknowledging a hidden overlay when painting is suspended', async () => {
  vi.useFakeTimers();
  vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(42);
  const cancel = vi.spyOn(window, 'cancelAnimationFrame');
  const unregister = registerPageOverlayHost(document.createElement('div'));
  try {
    const result = Promise.resolve(setPageOverlaysHidden(true)).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBeInstanceOf(Error);
    expect(cancel).toHaveBeenCalledWith(42);
  } finally {
    unregister();
  }
});
