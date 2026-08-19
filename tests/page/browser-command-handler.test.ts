import { describe, expect, it, vi } from 'vitest';
import { handlePageCommand } from '../../src/page/browser-command-handler';
import { pageElementRefStore } from '../../src/page/browser/page-element-ref-store';

describe('handlePageCommand', () => {
  it('clicks an observed control once without a debugger command', async () => {
    document.body.innerHTML = '<button type="button">Continue</button>';
    const button = document.querySelector<HTMLButtonElement>('button');
    if (!button) throw new Error('Button fixture is missing.');
    button.getBoundingClientRect = () => ({
      x: 10,
      y: 20,
      width: 100,
      height: 30,
      top: 20,
      left: 10,
      right: 110,
      bottom: 50,
      toJSON: () => ({}),
    });
    const clicked = vi.fn();
    button.addEventListener('click', clicked);

    const [ref] = pageElementRefStore(document).replace([button]);
    if (!ref) throw new Error('Button ref is missing.');

    await expect(
      handlePageCommand(
        {
          version: 1,
          requestId: 'req_click',
          type: 'page.action.perform',
          payload: { action: 'click', ref, button: 'left', count: 1 },
        },
        { document, window },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: { action: 'click', applied: true, dispatched: true },
    });
    expect(clicked).toHaveBeenCalledOnce();
  });

  it('types into and selects observed controls with verified values', async () => {
    document.body.innerHTML = `
      <input aria-label="Search" value="old">
      <select aria-label="Plan"><option value="free">Free</option><option value="pro">Pro</option></select>
    `;
    for (const [index, element] of [
      ...document.querySelectorAll<HTMLElement>('input,select'),
    ].entries()) {
      element.getBoundingClientRect = () => ({
        x: 10,
        y: 20 + index * 40,
        width: 100,
        height: 30,
        top: 20 + index * 40,
        left: 10,
        right: 110,
        bottom: 50 + index * 40,
        toJSON: () => ({}),
      });
    }
    const input = document.querySelector<HTMLInputElement>('input');
    const select = document.querySelector<HTMLSelectElement>('select');
    if (!input || !select) throw new Error('Form fixtures are missing.');
    const inputEvent = vi.fn();
    const changeEvent = vi.fn();
    input.addEventListener('input', inputEvent);
    select.addEventListener('change', changeEvent);

    const [inputRef, selectRef] = pageElementRefStore(document).replace([input, select]);
    if (!inputRef || !selectRef) throw new Error('Form refs are missing.');

    const typed = await handlePageCommand(
      {
        version: 1,
        requestId: 'req_type',
        type: 'page.action.perform',
        payload: {
          action: 'type',
          ref: inputRef,
          text: 'new value',
          replace: true,
          submit: false,
        },
      },
      { document, window },
    );
    const selected = await handlePageCommand(
      {
        version: 1,
        requestId: 'req_select',
        type: 'page.action.perform',
        payload: { action: 'select', ref: selectRef, value: 'pro' },
      },
      { document, window },
    );

    expect(typed).toMatchObject({
      ok: true,
      data: { action: 'type', applied: true, value: 'new value' },
    });
    expect(selected).toMatchObject({
      ok: true,
      data: { action: 'select', applied: true, value: 'pro' },
    });
    expect(input.value).toBe('new value');
    expect(select.value).toBe('pro');
    expect(inputEvent).toHaveBeenCalledOnce();
    expect(changeEvent).toHaveBeenCalledOnce();
  });

  it('defers editor-like text surfaces to trusted browser input without mutating their proxy', async () => {
    document.body.innerHTML = `
      <div>
        <textarea aria-label="Code editor" aria-roledescription="editor">starter</textarea>
      </div>
    `;
    const editor = document.querySelector<HTMLTextAreaElement>('textarea');
    if (!editor) throw new Error('Editor fixture is missing.');
    editor.getBoundingClientRect = () => ({
      x: 10,
      y: 20,
      width: 100,
      height: 30,
      top: 20,
      left: 10,
      right: 110,
      bottom: 50,
      toJSON: () => ({}),
    });

    const [ref] = pageElementRefStore(document).replace([editor]);
    if (!ref) throw new Error('Editor ref is missing.');

    await expect(
      handlePageCommand(
        {
          version: 1,
          requestId: 'req_type_editor',
          type: 'page.action.perform',
          payload: {
            action: 'type',
            ref,
            text: 'replacement',
            replace: true,
            submit: false,
          },
        },
        { document, window },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        action: 'type',
        applied: false,
        dispatched: false,
        reason: 'trusted_input_required',
        target: { x: 60, y: 35 },
        value: 'starter',
      },
    });
    expect(editor.value).toBe('starter');
  });

  it('falls back to trusted input when a controlled field rejects a DOM value update', async () => {
    document.body.innerHTML = '<input aria-label="Controlled" value="old">';
    const input = document.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error('Controlled input fixture is missing.');
    input.getBoundingClientRect = () => ({
      x: 10,
      y: 20,
      width: 100,
      height: 30,
      top: 20,
      left: 10,
      right: 110,
      bottom: 50,
      toJSON: () => ({}),
    });
    input.addEventListener('input', () => {
      queueMicrotask(() => {
        input.value = 'old';
      });
    });

    const [ref] = pageElementRefStore(document).replace([input]);
    if (!ref) throw new Error('Controlled input ref is missing.');

    await expect(
      handlePageCommand(
        {
          version: 1,
          requestId: 'req_type_controlled',
          type: 'page.action.perform',
          payload: { action: 'type', ref, text: 'new', replace: true, submit: false },
        },
        { document, window },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        action: 'type',
        applied: false,
        reason: 'trusted_input_required',
        target: { x: 60, y: 35 },
        value: 'old',
      },
    });
  });

  it('scrolls a referenced nested container by exact pixels and reports actual movement', async () => {
    document.body.innerHTML = '<div id="log" style="overflow-y:auto"><button>Entry</button></div>';
    const scroller = document.querySelector<HTMLElement>('#log');
    if (!scroller) throw new Error('Scroller fixture is missing.');
    Object.defineProperties(scroller, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 500 },
      clientWidth: { value: 200 },
      scrollWidth: { value: 200 },
      scrollTop: { value: 20, writable: true },
    });
    scroller.getBoundingClientRect = () => ({
      x: 10,
      y: 20,
      width: 200,
      height: 100,
      top: 20,
      left: 10,
      right: 210,
      bottom: 120,
      toJSON: () => ({}),
    });
    scroller.scrollBy = vi.fn((first?: ScrollToOptions | number, second?: number) => {
      const top = typeof first === 'number' ? (second ?? 0) : (first?.top ?? 0);
      const left = typeof first === 'number' ? first : (first?.left ?? 0);
      scroller.scrollTop += top;
      scroller.scrollLeft += left;
    });

    const [scrollAreaRef] = pageElementRefStore(document).replace([scroller]);
    if (!scrollAreaRef) throw new Error('Scrollable container ref is missing.');

    await expect(
      handlePageCommand(
        {
          version: 1,
          requestId: 'req_scroll',
          type: 'page.action.perform',
          payload: {
            action: 'scroll',
            target: scrollAreaRef,
            deltaX: 0,
            deltaY: 100,
          },
        },
        { document, window },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        action: 'scroll',
        applied: true,
        moved: true,
        actualDeltaX: 0,
        actualDeltaY: 100,
      },
    });
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
