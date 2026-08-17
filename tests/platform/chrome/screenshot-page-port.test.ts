import { describe, expect, it, vi } from 'vitest';
import { ChromeScreenshotPagePort } from '../../../src/platform/chrome/screenshot-page-port';

describe('ChromeScreenshotPagePort image preview', () => {
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
    expect(tabs.sendMessage).toHaveBeenCalledWith(7, {
      version: 1,
      requestId: 'page_request_1',
      type: 'page.imagePreview.open',
      payload: { src: 'data:image/png;base64,cG5n', alt: 'photo.png' },
    });
  });
});
