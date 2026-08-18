import { describe, expect, it, vi } from 'vitest';
import { ChromePointerPagePort } from '../../../src/platform/chrome/pointer-page-port';

describe('ChromePointerPagePort', () => {
  it('sends one validated pointer command to the top frame', async () => {
    const dependencies = {
      installer: {
        ensureInstalled: vi.fn(async () => ({
          status: 'already_installed' as const,
          originPattern: 'https://example.test/*',
        })),
      },
      tabs: {
        get: vi.fn(async () => ({ url: 'https://example.test' })),
        sendMessage: vi.fn(async (_tabId: number, message: { readonly requestId: string }) => ({
          version: 1,
          requestId: message.requestId,
          ok: true,
          data: { shown: true },
        })),
      },
      ids: { create: () => 'pointer_1' },
    };
    const port = new ChromePointerPagePort(dependencies);
    const effect = { x: 100, y: 80, fromX: 10, fromY: 20, effect: 'click' as const };

    await port.show(7, effect);

    expect(dependencies.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      { version: 1, requestId: 'pointer_1', type: 'page.pointer.show', payload: effect },
      { frameId: 0 },
    );
  });

  it('redacts unavailable page and invalid response failures', async () => {
    const dependencies = {
      installer: {
        ensureInstalled: vi.fn(async () => ({
          status: 'installed' as const,
          originPattern: 'https://example.test/*',
        })),
      },
      tabs: {
        get: vi.fn(async () => ({ url: 'https://example.test' })),
        sendMessage: vi.fn(async () => ({ private: 'page data' })),
      },
      ids: { create: () => 'pointer_1' },
    };
    const port = new ChromePointerPagePort(dependencies);

    let thrown: unknown;
    try {
      await port.show(7, { x: 1, y: 2, fromX: 1, fromY: 2, effect: 'move' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'POINTER_UNAVAILABLE' });
    expect(String(thrown)).not.toContain('page data');
  });
});
