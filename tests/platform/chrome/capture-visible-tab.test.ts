import { describe, expect, it, vi } from 'vitest';
import { captureVisibleTab } from '../../../src/platform/chrome/capture-visible-tab';

describe('captureVisibleTab', () => {
  it('restores overlays and releases the shared slot after a failed capture', async () => {
    vi.useFakeTimers();
    const api = {
      get: async () => ({ id: 7, windowId: 3, active: true }),
      query: async () => [{ id: 7 }],
      captureVisibleTab: vi
        .fn()
        .mockRejectedValueOnce(new Error('Capture failed.'))
        .mockResolvedValue('data:image/png;base64,cG5n'),
    };
    const restore = vi.fn(async () => undefined);
    const options = { api, afterCapture: restore, decodeDataUrl: async () => new Blob(['png']) };
    try {
      await expect(captureVisibleTab(7, options)).rejects.toThrow('Capture failed.');
      expect(restore).toHaveBeenCalledOnce();
      const next = captureVisibleTab(7, options);
      await vi.advanceTimersByTimeAsync(600);
      expect(await next).toBeInstanceOf(Blob);
      expect(restore).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes shared captures and leaves overlays visible while waiting for a slot', async () => {
    vi.useFakeTimers();
    const events: { kind: string; at: number }[] = [];
    const api = {
      get: async () => ({ id: 7, windowId: 3, active: true }),
      query: async () => [{ id: 7 }],
      captureVisibleTab: async () => {
        events.push({ kind: 'capture', at: Date.now() });
        return 'data:image/png;base64,cG5n';
      },
    };
    const options = {
      api,
      beforeCapture: async () => {
        events.push({ kind: 'hide', at: Date.now() });
      },
      afterCapture: async () => {
        events.push({ kind: 'show', at: Date.now() });
      },
      decodeDataUrl: async () => new Blob(['png']),
    };
    try {
      const captures = Promise.all([
        captureVisibleTab(7, options),
        captureVisibleTab(7, options),
        captureVisibleTab(7, options),
      ]);
      await vi.advanceTimersByTimeAsync(2000);
      await captures;
      expect(events.map((e) => e.kind)).toEqual([
        'hide',
        'capture',
        'show',
        'hide',
        'capture',
        'show',
        'hide',
        'capture',
        'show',
      ]);
      const times = events.filter((e) => e.kind === 'capture').map((e) => e.at);
      expect((times[2] ?? 0) - (times[0] ?? 0)).toBeGreaterThan(1000);
    } finally {
      vi.useRealTimers();
    }
  });
  it('discards the image if the user switches tabs during capture', async () => {
    const api = {
      get: vi.fn(async () => ({ id: 7, windowId: 3, active: true })),
      query: vi
        .fn()
        .mockResolvedValueOnce([{ id: 7 }])
        .mockResolvedValueOnce([{ id: 9 }]),
      captureVisibleTab: vi.fn(async () => 'data:image/png;base64,cG5n'),
    };
    const decodeDataUrl = vi.fn(async () => new Blob(['wrong tab']));
    await expect(captureVisibleTab(7, { api, decodeDataUrl })).rejects.toMatchObject({
      code: 'TAB_NOT_VISIBLE',
    });
    expect(decodeDataUrl).not.toHaveBeenCalled();
  });

  it('captures only when the requested tab is active in its own window', async () => {
    const blob = new Blob(['png'], { type: 'image/png' });
    const api = {
      get: vi.fn(async () => ({ id: 7, windowId: 3, active: true })),
      query: vi.fn(async () => [{ id: 7 }]),
      captureVisibleTab: vi.fn(async () => 'data:image/png;base64,cG5n'),
    };

    await expect(
      captureVisibleTab(7, { api, decodeDataUrl: vi.fn(async () => blob) }),
    ).resolves.toBe(blob);
    expect(api.query).toHaveBeenCalledWith({ active: true, windowId: 3 });
    expect(api.captureVisibleTab).toHaveBeenCalledWith(3, { format: 'png' });
  });

  it('refuses to capture a background tab even if it still exists', async () => {
    const api = {
      get: vi.fn(async () => ({ id: 7, windowId: 3, active: false })),
      query: vi.fn(async () => [{ id: 9 }]),
      captureVisibleTab: vi.fn(async () => 'data:image/png;base64,cG5n'),
    };

    await expect(captureVisibleTab(7, { api })).rejects.toMatchObject({
      code: 'TAB_NOT_VISIBLE',
    });
    expect(api.captureVisibleTab).not.toHaveBeenCalled();
  });
});
