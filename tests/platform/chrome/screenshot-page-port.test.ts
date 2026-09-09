import { describe, expect, it, vi } from 'vitest';
import { ChromeScreenshotPagePort } from '../../../src/platform/chrome/screenshot-page-port';

describe('ChromeScreenshotPagePort image preview', () => {
  it('reports missing page permission without sending a selection request', async () => {
    const tabs = {
      get: vi.fn(async () => ({ url: 'https://example.com/page' })),
      sendMessage: vi.fn(),
    };
    const port = new ChromeScreenshotPagePort({
      tabs,
      installer: {
        ensureInstalled: vi.fn(async () => ({
          status: 'permission_required' as const,
          originPattern: 'https://example.com/*',
        })),
      },
      ids: { create: () => 'page_request_1' },
    });
    await expect(port.selectRegion(9)).rejects.toMatchObject({ code: 'PAGE_ACCESS_UNAVAILABLE' });
    expect(tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('selects and hides overlays only in the top frame, never broadcasting to child frames', async () => {
    const tabs = {
      get: vi.fn(async () => ({ url: 'https://example.com/page' })),
      sendMessage: vi.fn(async (_tabId: number, message: { readonly requestId: string }) => ({
        requestId: message.requestId,
        ok: true,
        data: null,
      })),
    };
    const port = new ChromeScreenshotPagePort({
      tabs,
      installer: {
        ensureInstalled: vi.fn(async () => ({
          status: 'already_installed' as const,
          originPattern: 'https://example.com/*',
        })),
      },
      ids: { create: () => 'page_request_1' },
    });
    await expect(port.selectRegion(9)).resolves.toBeNull();
    await port.setOverlaysHidden(9, true);
    await port.setOverlaysHidden(9, false);
    expect(tabs.sendMessage.mock.calls).toEqual([
      [9, expect.objectContaining({ type: 'page.screenshot.select' }), { frameId: 0 }],
      [
        9,
        expect.objectContaining({ type: 'page.overlays.setHidden', payload: { hidden: true } }),
        { frameId: 0 },
      ],
      [
        9,
        expect.objectContaining({ type: 'page.overlays.setHidden', payload: { hidden: false } }),
        { frameId: 0 },
      ],
    ]);
  });

  it('ensures the page bundle and forwards a bounded full-page preview command', async () => {
    const installer = {
      ensureInstalled: vi.fn(async () => ({
        status: 'already_installed' as const,
        originPattern: 'https://example.com/*',
      })),
    };
    const tabs = {
      get: vi.fn(async () => ({ url: 'https://example.com/page' })),
      sendMessage: vi.fn(async (_tabId: number, message: { readonly requestId: string }) => ({
        version: 1,
        requestId: message.requestId,
        ok: true,
        data: { opened: true },
      })),
    };
    const port = new ChromeScreenshotPagePort({
      installer,
      tabs,
      ids: { create: () => 'page_request_1' },
    });

    await port.openImagePreview(7, {
      src: 'data:image/png;base64,cG5n',
      alt: 'photo.png',
    });

    expect(installer.ensureInstalled).toHaveBeenCalledWith(7, 'https://example.com/page');
    expect(tabs.sendMessage).toHaveBeenCalledWith(
      7,
      {
        version: 1,
        requestId: 'page_request_1',
        type: 'page.imagePreview.open',
        payload: { src: 'data:image/png;base64,cG5n', alt: 'photo.png' },
      },
      { frameId: 0 },
    );
  });
});
