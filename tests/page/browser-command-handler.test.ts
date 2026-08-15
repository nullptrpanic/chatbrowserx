import { describe, expect, it } from 'vitest';
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

  it('returns a bounded semantic observation for a valid page command', async () => {
    document.title = 'Observed page';
    document.body.innerHTML = '<button aria-label="Continue">Ignored without a box</button>';

    const response = await handlePageCommand(
      {
        version: 1,
        requestId: 'req_observe',
        type: 'page.observe',
        payload: { observationId: 'observation_1', tabId: 7, capturedAt: 1_000 },
      },
      { document, window },
    );

    expect(response).toMatchObject({
      version: 1,
      requestId: 'req_observe',
      ok: true,
      data: {
        id: 'observation_1',
        tabId: 7,
        capturedAt: 1_000,
        title: 'Observed page',
      },
    });
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

  it('correlates a valid action failure without replacing its stable error code', async () => {
    document.body.innerHTML = '';

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
    ).resolves.toMatchObject({
      requestId: 'req_missing_target',
      ok: false,
      error: { code: 'TARGET_NOT_FOUND' },
    });
  });
});
