import { describe, expect, it, vi } from 'vitest';
import { captureVisibleTab } from '../../../src/platform/chrome/capture-visible-tab';

describe('captureVisibleTab', () => {
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
