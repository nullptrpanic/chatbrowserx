import { describe, expect, it, vi } from 'vitest';
import {
  ChromePageObservationPort,
  PageObservationPortError,
  type ChromePageObservationDependencies,
} from '../../../src/platform/chrome/page-observation-port';

function dependencies(): ChromePageObservationDependencies {
  return {
    installer: {
      ensureInstalled: vi.fn(async () => ({
        status: 'installed' as const,
        originPattern: 'https://example.test/*',
      })),
    },
    tabs: {
      get: vi.fn(async () => ({ url: 'https://example.test/page' })),
      sendMessage: vi.fn(async (_tabId, message) => ({
        version: 1,
        requestId: message.requestId,
        ok: true,
        data:
          message.type === 'page.content.read'
            ? {
                title: 'Page',
                url: 'https://example.test/page',
                text: 'Text',
                headings: [],
                links: [],
                truncated: false,
              }
            : message.type === 'page.action.perform'
              ? {
                  action: 'scroll',
                  applied: true,
                  moved: true,
                  actualDeltaX: 0,
                  actualDeltaY: 100,
                  url: 'https://example.test/page',
                }
              : {},
      })),
    },
    ids: { create: (prefix: string) => `${prefix}_1` },
  };
}

describe('ChromePageObservationPort', () => {
  it('performs a validated page action through the same isolated bridge', async () => {
    const ports = dependencies();
    const port = new ChromePageObservationPort(ports);

    await expect(
      port.performAction(7, {
        action: 'scroll',
        target: 'viewport',
        deltaX: 0,
        deltaY: 100,
      }),
    ).resolves.toMatchObject({ moved: true, actualDeltaY: 100 });
    expect(ports.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: 'page.action.perform',
        payload: { action: 'scroll', target: 'viewport', deltaX: 0, deltaY: 100 },
      }),
      { frameId: 0 },
    );
  });

  it('installs the page bundle and reads validated content from the top frame only', async () => {
    const ports = dependencies();
    const port = new ChromePageObservationPort(ports);

    await expect(port.readContent(7)).resolves.toMatchObject({ title: 'Page', text: 'Text' });
    expect(ports.installer.ensureInstalled).toHaveBeenCalledWith(7, 'https://example.test/page');
    expect(ports.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: 'page.content.read', payload: {} }),
      { frameId: 0 },
    );
  });

  it('hides and restores extension overlays through the validated page boundary', async () => {
    const ports = dependencies();
    vi.mocked(ports.tabs.sendMessage).mockImplementation(async (_tabId, message) => ({
      version: 1,
      requestId: message.requestId,
      ok: true,
      data: { hidden: message.type === 'page.overlays.setHidden' && message.payload.hidden },
    }));
    const port = new ChromePageObservationPort(ports);

    await expect(port.setOverlaysHidden(7, true)).resolves.toBeUndefined();
    expect(ports.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: 'page.overlays.setHidden', payload: { hidden: true } }),
      { frameId: 0 },
    );
  });

  it('redacts malformed page responses', async () => {
    const ports = dependencies();
    const port = new ChromePageObservationPort(ports);

    vi.mocked(ports.tabs.sendMessage).mockResolvedValueOnce({
      version: 1,
      requestId: 'wrong',
      ok: true,
      data: 'private page response',
    });
    let thrown: unknown;
    try {
      await port.readContent(7);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PageObservationPortError);
    expect(thrown).toMatchObject({ code: 'INVALID_PAGE_RESPONSE' });
    expect(String(thrown)).not.toContain('private page response');

    vi.mocked(ports.tabs.sendMessage).mockImplementationOnce(async (_tabId, message) => ({
      version: 1,
      requestId: message.requestId,
      ok: true,
      data: 'private page response',
    }));
    await expect(port.readContent(7)).rejects.toMatchObject({
      code: 'INVALID_PAGE_RESPONSE',
    });
  });

  it('rejects protected tabs before sending a page command', async () => {
    const ports = dependencies();
    vi.mocked(ports.tabs.get).mockResolvedValueOnce({ url: 'chrome://settings' });
    vi.mocked(ports.installer.ensureInstalled).mockResolvedValueOnce({
      status: 'unsupported_origin',
      originPattern: null,
    });
    const port = new ChromePageObservationPort(ports);

    await expect(port.readContent(7)).rejects.toMatchObject({ code: 'PAGE_UNAVAILABLE' });
    expect(ports.tabs.sendMessage).not.toHaveBeenCalled();
  });
});
