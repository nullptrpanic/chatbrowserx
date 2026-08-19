import { afterEach, describe, expect, it, vi } from 'vitest';

const handlePageCommand = vi.fn(async () => ({ ok: true }));
const disposeSelection = vi.fn();
const mountSelectionFeature = vi.fn(() => disposeSelection);

vi.mock('../../src/page/browser-command-handler', () => ({ handlePageCommand }));
vi.mock('../../src/page/selection/mount-selection-feature', () => ({ mountSelectionFeature }));

const PAGE_CONTENT_STATE_KEY = '__chatBrowserXPageCommandsV1__';

afterEach(() => {
  Reflect.deleteProperty(globalThis, PAGE_CONTENT_STATE_KEY);
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

describe('page content entry lifecycle', () => {
  it('replaces a stale listener and selection feature after the extension reloads', async () => {
    const addListener = vi.fn();
    const removeListener = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: { onMessage: { addListener, removeListener } },
    });

    await import('../../src/entries/page-content.iife');
    const firstListener = addListener.mock.calls[0]?.[0] as unknown;
    expect(firstListener).toBeTypeOf('function');
    expect(mountSelectionFeature).toHaveBeenCalledOnce();

    vi.resetModules();
    await import('../../src/entries/page-content.iife');

    expect(removeListener).toHaveBeenCalledWith(firstListener);
    expect(disposeSelection).toHaveBeenCalledOnce();
    expect(addListener).toHaveBeenCalledTimes(2);
    expect(mountSelectionFeature).toHaveBeenCalledTimes(2);
  });

  it('recovers from the legacy boolean guard left by an older extension context', async () => {
    const addListener = vi.fn();
    const removeListener = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: { onMessage: { addListener, removeListener } },
    });
    (globalThis as unknown as Record<string, unknown>)[PAGE_CONTENT_STATE_KEY] = true;
    const legacyOverlay = document.createElement('div');
    legacyOverlay.dataset.chatbrowserxOverlay = 'selection';
    document.documentElement.append(legacyOverlay);

    await import('../../src/entries/page-content.iife');

    expect(addListener).toHaveBeenCalledOnce();
    expect(mountSelectionFeature).toHaveBeenCalledOnce();
    expect(legacyOverlay.isConnected).toBe(false);
  });
});
