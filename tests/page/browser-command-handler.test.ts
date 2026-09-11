import { afterEach, describe, expect, it, vi } from 'vitest';
import { handlePageCommand } from '../../src/page/browser-command-handler';
import { registerPageOverlayHost } from '../../src/page/page-overlay-registry';

afterEach(() => vi.useRealTimers());

describe('handlePageCommand', () => {
  it('reports suspended rendering through the protocol instead of starting a stale capture', async () => {
    vi.useFakeTimers();
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(42);
    const unregister = registerPageOverlayHost(document.createElement('div'));
    try {
      const response = handlePageCommand({
        version: 1,
        requestId: 'req_hide',
        type: 'page.overlays.setHidden',
        payload: { hidden: true },
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await response).toMatchObject({
        requestId: 'req_hide',
        ok: false,
        error: { code: 'PAGE_RENDER_UNAVAILABLE' },
      });
    } finally {
      unregister();
      raf.mockRestore();
    }
  });

  it('scrolls the document for a viewport target even when the center covers a nested scroller', async () => {
    document.body.innerHTML = '<div id="nested"></div>';
    const nested = document.querySelector<HTMLElement>('#nested');
    if (!nested) throw new Error('Nested fixture is missing.');
    const root = document.createElement('main');
    Object.defineProperties(root, {
      clientHeight: { value: 600 },
      scrollHeight: { value: 1_600 },
      clientWidth: { value: 800 },
      scrollWidth: { value: 800 },
      scrollTop: { value: 40, writable: true },
    });
    root.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      toJSON: () => ({}),
    });
    root.scrollBy = vi.fn((first?: ScrollToOptions | number, second?: number) => {
      root.scrollTop += typeof first === 'number' ? (second ?? 0) : (first?.top ?? 0);
    });
    Object.defineProperties(nested, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 500 },
      scrollTop: { value: 10, writable: true },
    });
    const previousScrollingElement = Object.getOwnPropertyDescriptor(document, 'scrollingElement');
    const previousElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'scrollingElement', { configurable: true, value: root });
    document.elementFromPoint = vi.fn(() => nested);

    try {
      await expect(
        handlePageCommand(
          {
            version: 1,
            requestId: 'req_viewport_scroll',
            type: 'page.action.perform',
            payload: { action: 'scroll', target: 'viewport', deltaX: 0, deltaY: 100 },
          },
          { document, window },
        ),
      ).resolves.toMatchObject({
        ok: true,
        data: { applied: true, moved: true, actualDeltaY: 100 },
      });
      expect(root.scrollTop).toBe(140);
      expect(nested.scrollTop).toBe(10);
    } finally {
      if (previousScrollingElement) {
        Object.defineProperty(document, 'scrollingElement', previousScrollingElement);
      } else {
        Reflect.deleteProperty(document, 'scrollingElement');
      }
      document.elementFromPoint = previousElementFromPoint;
    }
  });

  it('returns bounded readable content without building a DOM semantic tree', async () => {
    document.head.innerHTML = '<title>Observed page</title>';
    document.body.innerHTML = '<h1>Heading</h1><p>Page text</p>';

    await expect(
      handlePageCommand(
        { version: 1, requestId: 'req_content', type: 'page.content.read', payload: {} },
        { document, window },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        title: 'Observed page',
        headings: [{ level: 1, text: 'Heading' }],
        text: 'Heading Page text',
      },
    });
  });

  it('answers page ping without exposing other extension capabilities', async () => {
    await expect(
      handlePageCommand(
        { version: 1, requestId: 'req_ping', type: 'page.ping', payload: {} },
        { document, window },
      ),
    ).resolves.toEqual({
      version: 1,
      requestId: 'req_ping',
      ok: true,
      data: { installed: true },
    });
  });

  it('opens an image preview across the complete page viewport and closes on Escape', async () => {
    await expect(
      handlePageCommand(
        {
          version: 1,
          requestId: 'req_preview',
          type: 'page.imagePreview.open',
          payload: { src: 'data:image/png;base64,cG5n', alt: 'photo.png' },
        },
        { document, window },
      ),
    ).resolves.toEqual({
      version: 1,
      requestId: 'req_preview',
      ok: true,
      data: { opened: true },
    });

    const host = document.querySelector<HTMLElement>('[data-chatbrowserx-overlay="image-preview"]');
    expect(host).not.toBeNull();
    expect(host).toHaveStyle({ position: 'fixed', inset: '0px' });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-chatbrowserx-overlay="image-preview"]'),
      ).not.toBeInTheDocument(),
    );
  });

  it('rejects removed page observation commands', async () => {
    await expect(
      handlePageCommand(
        { version: 1, requestId: 'req_elements', type: 'page.elements.observe', payload: {} },
        { document, window },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_PAGE_COMMAND' } });
    await expect(
      handlePageCommand(
        {
          version: 1,
          requestId: 'req_observe',
          type: 'page.observe',
          payload: { observationId: 'observation_1', tabId: 7, capturedAt: 1_000 },
        },
        { document, window },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_PAGE_COMMAND' } });
  });

  it('rejects task commands at the page boundary', async () => {
    await expect(
      handlePageCommand(
        {
          version: 1,
          requestId: 'req_task',
          type: 'task.getSnapshot',
          payload: { taskId: 'task_1' },
        },
        { document, window },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_PAGE_COMMAND' } });
  });

  it('rejects arbitrary script fields in the structured page action boundary', async () => {
    await expect(
      handlePageCommand(
        {
          version: 1,
          requestId: 'req_action',
          type: 'page.domAction',
          payload: { action: { type: 'click', javascript: 'document.body.remove()' } },
        },
        { document, window },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_PAGE_COMMAND' } });
  });

  it('rejects previously valid structured page actions', async () => {
    await expect(
      handlePageCommand(
        {
          version: 1,
          requestId: 'req_missing_target',
          type: 'page.domAction',
          payload: {
            action: {
              actionId: 'action_1',
              tabId: 7,
              type: 'click',
              target: {
                framePath: [],
                shadowPath: [],
                role: 'button',
                name: 'Missing',
                label: null,
                text: 'Missing',
                stableAttributes: {},
                ancestorHint: null,
                lastKnownRect: null,
              },
              risk: 'low',
              expected: { type: 'page.stable', quietMs: 300 },
            },
          },
        },
        { document, window },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_PAGE_COMMAND' } });
  });
});
