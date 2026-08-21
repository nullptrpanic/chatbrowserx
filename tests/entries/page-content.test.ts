import { afterEach, describe, expect, it, vi } from 'vitest';

const handlePageCommand = vi.fn(async () => ({ ok: true }));

vi.mock('../../src/page/browser-command-handler', () => ({ handlePageCommand }));

const PAGE_CONTENT_STATE_KEY = '__chatBrowserXPageCommandsV1__';

afterEach(() => {
  Reflect.deleteProperty(globalThis, PAGE_CONTENT_STATE_KEY);
  document.querySelectorAll('[data-chatbrowserx-overlay="selection"]').forEach((node) => {
    node.remove();
  });
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

describe('page content entry lifecycle', () => {
  it('replaces a stale listener without mounting selected-text actions after reload', async () => {
    const addListener = vi.fn();
    const removeListener = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: { onMessage: { addListener, removeListener } },
    });

    await import('../../src/entries/page-content.iife');
    const firstListener = addListener.mock.calls[0]?.[0] as unknown;
    expect(firstListener).toBeTypeOf('function');
    expect(document.querySelector('[data-chatbrowserx-overlay="selection"]')).toBeNull();

    vi.resetModules();
    await import('../../src/entries/page-content.iife');

    expect(removeListener).toHaveBeenCalledWith(firstListener);
    expect(addListener).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-chatbrowserx-overlay="selection"]')).toBeNull();
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
    expect(legacyOverlay.isConnected).toBe(false);
  });

  it('disposes selected-text listeners and hosts left by an older injected build', async () => {
    const oldListener = vi.fn();
    const disposeSelection = vi.fn();
    const addListener = vi.fn();
    const removeListener = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: { onMessage: { addListener, removeListener } },
    });
    (globalThis as unknown as Record<string, unknown>)[PAGE_CONTENT_STATE_KEY] = {
      listener: oldListener,
      disposeSelection,
    };
    const legacyOverlay = document.createElement('div');
    legacyOverlay.dataset.chatbrowserxOverlay = 'selection';
    document.documentElement.append(legacyOverlay);

    await import('../../src/entries/page-content.iife');

    expect(removeListener).toHaveBeenCalledWith(oldListener);
    expect(disposeSelection).toHaveBeenCalledOnce();
    expect(legacyOverlay.isConnected).toBe(false);
    expect(addListener).toHaveBeenCalledOnce();
  });
});
