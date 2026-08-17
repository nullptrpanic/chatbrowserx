import { describe, expect, it, vi } from 'vitest';
import { handlePageCommand } from '../../src/page/browser-command-handler';

describe('handlePageCommand', () => {
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
