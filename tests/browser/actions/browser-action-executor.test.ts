import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseBrowserToolCall } from '../../../src/agent/tools/browser-tool-schema';
import {
  BrowserActionExecutor,
  type BrowserActionExecutorDependencies,
} from '../../../src/browser/actions/browser-action-executor';
import type {
  DebuggerSession,
  DebuggerTransport,
} from '../../../src/browser/debugger/debugger-transport';
import type { BrowserSessionSnapshot } from '../../../src/browser/debugger/target-session-registry';
import { ElementRefStore } from '../../../src/browser/observation/element-ref-store';

const SNAPSHOT: BrowserSessionSnapshot = {
  tabId: 7,
  generation: 2,
  root: { tabId: 7 },
  children: new Map(),
};

function call(name: string, arguments_: unknown) {
  return parseBrowserToolCall({
    callId: 'call_1',
    name,
    argumentsJson: JSON.stringify(arguments_),
  });
}

function harness(
  options: {
    readonly os?: string;
    readonly pointerRejects?: boolean;
    readonly page?: BrowserActionExecutorDependencies['page'];
    readonly responder?: (
      session: DebuggerSession,
      method: string,
      params?: Readonly<Record<string, unknown>>,
    ) => unknown;
  } = {},
) {
  const order: string[] = [];
  const send = vi.fn(async (session, method, params) => {
    order.push(`cdp:${method}`);
    if (method === 'Runtime.evaluate' && params?.returnByValue !== true) {
      return { result: { type: 'object', objectId: 'page_global' } };
    }
    if (options.responder) {
      const response = options.responder(session, method, params);
      if (response !== undefined) return response;
    }
    if (method === 'Page.getNavigationHistory') {
      return {
        currentIndex: 1,
        entries: [
          {
            id: 1,
            url: 'https://example.test/previous',
            title: 'Previous',
            transitionType: 'link',
          },
          {
            id: 2,
            url: 'https://example.test/current',
            title: 'Current',
            transitionType: 'link',
          },
          {
            id: 3,
            url: 'https://example.test/next',
            title: 'Next',
            transitionType: 'link',
          },
        ],
      };
    }
    if (method === 'Page.getLayoutMetrics') {
      return {
        visualViewport: {
          pageX: 0,
          pageY: 0,
          clientWidth: 800,
          clientHeight: 600,
        },
      };
    }
    if (method === 'Page.getFrameTree') {
      return {
        frameTree: {
          frame: {
            id: 'frame-main',
            loaderId: 'loader-1',
            url: 'https://example.test/current',
            domainAndRegistry: 'example.test',
            securityOrigin: 'https://example.test',
            mimeType: 'text/html',
          },
        },
      };
    }
    if (method === 'DOM.getBoxModel') {
      return { model: { border: [10, 20, 110, 20, 110, 50, 10, 50] } };
    }
    if (method === 'Runtime.callFunctionOn') {
      return { result: { type: 'object', value: { dispatched: true } } };
    }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'object_1' } };
    return {};
  }) as unknown as DebuggerTransport['send'];
  const transport: DebuggerTransport = {
    attach: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    send,
    onEvent: () => () => undefined,
    onDetach: () => () => undefined,
  };
  const refs = new ElementRefStore({ create: () => 'ref_1' });
  refs.replaceSnapshot(7, [
    {
      frameTargetId: null,
      documentFrameId: 'frame-main',
      loaderId: 'loader-1',
      backendNodeId: 42,
      role: 'button',
      name: 'Continue',
      state: [],
      actions: ['click'],
      frame: 'main',
    },
  ]);
  const pointer = {
    show: vi.fn(async () => {
      order.push('pointer');
      if (options.pointerRejects) throw new Error('Overlay unavailable');
    }),
  };
  const sessions = { ensure: vi.fn(async () => SNAPSHOT) };
  const executor = new BrowserActionExecutor({
    sessions,
    transport,
    refs,
    pointer,
    platform: { getOs: vi.fn(async () => options.os ?? 'linux') },
    ...(options.page ? { page: options.page } : {}),
  });
  return {
    executor,
    transport,
    send: vi.mocked(send),
    pointer,
    sessions,
    order,
  };
}

afterEach(() => vi.useRealTimers());

describe('BrowserActionExecutor', () => {
  it('uses the page bridge for a DOM ref without attaching a debugger session', async () => {
    const page = {
      performAction: vi.fn(async () => ({
        action: 'click' as const,
        applied: true,
        dispatched: true,
        url: 'https://example.test/current',
      })),
    };
    const { executor, sessions, send } = harness({ page });

    const result = await executor.execute(
      call('browser_click', {
        tabId: 7,
        ref: 'page_1_1',
        button: 'left',
        count: 1,
      }),
      new AbortController().signal,
    );

    expect(page.performAction).toHaveBeenCalledWith(7, {
      action: 'click',
      ref: 'page_1_1',
      button: 'left',
      count: 1,
    });
    expect(sessions.ensure).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      tabId: 7,
      data: { action: 'click', applied: true, dispatched: true },
    });
  });

  it('types through the page bridge without attaching a debugger when the value is verified', async () => {
    const page = {
      performAction: vi.fn(async () => ({
        action: 'type' as const,
        applied: true,
        dispatched: true,
        value: 'hello',
        submitted: false,
        url: 'https://example.test/current',
      })),
    };
    const { executor, sessions, send } = harness({ page });

    const result = await executor.execute(
      call('browser_type', {
        tabId: 7,
        ref: 'page_1_1',
        text: 'hello',
        replace: true,
        submit: false,
      }),
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      data: {
        action: 'type',
        applied: true,
        strategy: 'dom',
        verified: true,
        replaced: true,
        submitted: false,
        valueLength: 5,
      },
    });
    expect(JSON.stringify(result)).not.toContain('"value":"hello"');
    expect(sessions.ensure).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('replaces multiline editor text atomically at its measured point', async () => {
    const replacement = 'hello\n    world';
    const page = {
      performAction: vi.fn(async () => ({
        action: 'type' as const,
        applied: false,
        dispatched: false,
        reason: 'trusted_input_required' as const,
        target: { x: 60, y: 35 },
        value: 'starter',
        submitted: false,
        url: 'https://example.test/current',
      })),
    };
    const { executor, sessions, send } = harness({
      page,
      os: 'mac',
      responder: (_session, method) =>
        method === 'Accessibility.getFullAXTree'
          ? {
              nodes: [
                {
                  nodeId: 'editor',
                  ignored: false,
                  role: { type: 'role', value: 'textbox' },
                  value: { type: 'string', value: replacement },
                  properties: [
                    {
                      name: 'focused',
                      value: { type: 'boolean', value: true },
                    },
                  ],
                },
              ],
            }
          : undefined,
    });

    await expect(
      executor.execute(
        call('browser_type', {
          tabId: 7,
          ref: 'page_1_1',
          text: replacement,
          replace: true,
          submit: false,
        }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      data: {
        action: 'type',
        dispatched: true,
        replaced: true,
        verified: true,
      },
    });
    expect(sessions.ensure).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mousePressed', x: 60, y: 35 }),
    );
    expect(send).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchKeyEvent',
      expect.objectContaining({
        type: 'rawKeyDown',
        key: 'a',
        modifiers: 4,
        windowsVirtualKeyCode: 65,
        commands: ['selectAll'],
      }),
    );
    expect(send).not.toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchKeyEvent',
      expect.objectContaining({ type: 'keyDown', key: 'Backspace' }),
    );
    expect(
      send.mock.calls.filter(
        ([, method, params]) =>
          method === 'Input.dispatchKeyEvent' &&
          params?.type === 'rawKeyDown' &&
          params.key === 'a',
      ),
    ).toHaveLength(2);
    expect(send).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchKeyEvent',
      expect.objectContaining({
        type: 'keyDown',
        key: 'ArrowRight',
        modifiers: 0,
      }),
    );
    expect(send).not.toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.insertText',
      expect.objectContaining({ text: replacement }),
    );
  });

  it('preserves multiline editor indentation instead of replaying it through editor auto-indent', async () => {
    const replacement =
      'class Solution {\npublic:\n    int answer() {\n        return 42;\n    }\n};';
    const editor = document.createElement('textarea');
    editor.className = 'monaco-editor';
    editor.value = 'starter';
    document.body.append(editor);
    editor.focus();
    let editorModel = editor.value;
    let insertedFromPaste = false;
    editor.addEventListener('paste', (event) => {
      // Monaco cancels synthetic paste events without applying their clipboard payload.
      event.preventDefault();
    });
    editor.addEventListener('input', (event) => {
      const inputEvent = event as InputEvent;
      if (inputEvent.inputType !== 'insertFromPaste' || inputEvent.data !== replacement) return;
      insertedFromPaste = true;
      editorModel = inputEvent.data;
    });
    const page = {
      performAction: vi.fn(async () => ({
        action: 'type' as const,
        applied: false,
        dispatched: false,
        reason: 'trusted_input_required' as const,
        target: { x: 60, y: 35 },
        value: editor.value,
        submitted: false,
        url: 'https://leetcode.com/problems/median-of-two-sorted-arrays/',
      })),
    };
    const { executor } = harness({
      page,
      os: 'mac',
      responder: (_session, method, params) => {
        if (method === 'Input.insertText') {
          const text = typeof params?.text === 'string' ? params.text : '';
          editor.value = text.replace(/\n( +)/g, (_line, indentation: string) => {
            return `\n${indentation}${indentation}`;
          });
          return {};
        }
        if (method === 'Runtime.evaluate') {
          return params?.returnByValue === true
            ? { result: { type: 'string', value: editorModel } }
            : { result: { type: 'object', objectId: 'page_global' } };
        }
        if (method === 'Runtime.callFunctionOn') {
          const declaration =
            typeof params?.functionDeclaration === 'string' ? params.functionDeclaration : '';
          const arguments_ = Array.isArray(params?.arguments) ? params.arguments : [];
          const text = arguments_[0] as { readonly value?: unknown } | undefined;
          const pageFunction = Function(`return (${declaration});`)() as (
            this: Window,
            text: string,
          ) => unknown;
          return {
            result: {
              type: 'object',
              value: pageFunction.call(window, typeof text?.value === 'string' ? text.value : ''),
            },
          };
        }
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              {
                nodeId: 'editor',
                ignored: false,
                role: { type: 'role', value: 'textbox' },
                value: { type: 'string', value: editorModel },
                properties: [{ name: 'focused', value: { type: 'boolean', value: true } }],
              },
            ],
          };
        }
        return undefined;
      },
    });

    try {
      await expect(
        executor.execute(
          call('browser_type', {
            tabId: 7,
            ref: 'page_1_1',
            text: replacement,
            replace: true,
            submit: false,
          }),
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ data: { replaced: true, verified: true } });
      expect(insertedFromPaste).toBe(true);
      expect(editorModel).toBe(replacement);
    } finally {
      editor.remove();
    }
  });

  it('verifies a full editor replacement from the selected DOM value when AX is stale', async () => {
    const replacement = `class Solution {\n${'    return 0;\n'.repeat(60)}};`;
    const page = {
      performAction: vi.fn(async () => ({
        action: 'type' as const,
        applied: false,
        dispatched: false,
        reason: 'trusted_input_required' as const,
        target: { x: 60, y: 35 },
        value: 'previous malformed code',
        submitted: false,
        url: 'https://leetcode.com/problems/median-of-two-sorted-arrays/',
      })),
    };
    const { executor } = harness({
      page,
      responder: (_session, method) => {
        if (method === 'Runtime.evaluate') {
          return { result: { type: 'string', value: replacement } };
        }
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              {
                nodeId: 'editor',
                ignored: false,
                role: { type: 'role', value: 'textbox' },
                value: { type: 'string', value: 'previous malformed code' },
                properties: [{ name: 'focused', value: { type: 'boolean', value: true } }],
              },
            ],
          };
        }
        return undefined;
      },
    });

    await expect(
      executor.execute(
        call('browser_type', {
          tabId: 7,
          ref: 'page_1_1',
          text: replacement,
          replace: true,
          submit: false,
        }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      data: {
        action: 'type',
        dispatched: true,
        replaced: true,
        verified: true,
      },
    });
  });

  it('uses an explicit CDP select-all command for a Monaco replacement', async () => {
    const replacement = 'class Solution {\n    return 0;\n};';
    let recognizedSelectAllCount = 0;
    const page = {
      performAction: vi.fn(async () => ({
        action: 'type' as const,
        applied: false,
        dispatched: false,
        reason: 'trusted_input_required' as const,
        target: { x: 60, y: 35 },
        value: 'previous malformed code',
        submitted: false,
        url: 'https://leetcode.com/problems/median-of-two-sorted-arrays/',
      })),
    };
    const { executor } = harness({
      page,
      os: 'mac',
      responder: (_session, method, params) => {
        if (
          method === 'Input.dispatchKeyEvent' &&
          params?.type === 'rawKeyDown' &&
          params.windowsVirtualKeyCode === 65 &&
          Array.isArray(params.commands) &&
          params.commands.length === 1 &&
          params.commands[0] === 'selectAll'
        ) {
          recognizedSelectAllCount += 1;
        }
        if (method === 'Runtime.evaluate') {
          return {
            result: {
              type: 'string',
              value: recognizedSelectAllCount >= 2 ? replacement : 'previous malformed code',
            },
          };
        }
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              {
                nodeId: 'editor',
                ignored: false,
                role: { type: 'role', value: 'textbox' },
                value: { type: 'string', value: 'previous malformed code' },
                properties: [{ name: 'focused', value: { type: 'boolean', value: true } }],
              },
            ],
          };
        }
        return undefined;
      },
    });

    await expect(
      executor.execute(
        call('browser_type', {
          tabId: 7,
          ref: 'page_1_1',
          text: replacement,
          replace: true,
          submit: false,
        }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      data: { action: 'type', replaced: true, verified: true },
    });
    expect(recognizedSelectAllCount).toBe(2);
  });

  it('rejects a trusted replacement when the focused editable value does not match', async () => {
    const page = {
      performAction: vi.fn(async () => ({
        action: 'type' as const,
        applied: false,
        dispatched: false,
        reason: 'trusted_input_required' as const,
        target: { x: 60, y: 35 },
        value: 'starter',
        submitted: false,
        url: 'https://example.test/current',
      })),
    };
    const { executor } = harness({
      page,
      responder: (_session, method) =>
        method === 'Accessibility.getFullAXTree'
          ? {
              nodes: [
                {
                  nodeId: 'editor',
                  ignored: false,
                  role: { type: 'role', value: 'textbox' },
                  value: { type: 'string', value: 'starter' },
                  properties: [
                    {
                      name: 'focused',
                      value: { type: 'boolean', value: true },
                    },
                  ],
                },
              ],
            }
          : undefined,
    });

    await expect(
      executor.execute(
        call('browser_type', {
          tabId: 7,
          ref: 'page_1_1',
          text: 'hello',
          replace: true,
          submit: false,
        }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'TYPE_VERIFICATION_FAILED' });
  });

  it('falls back to CDP only when the page bridge proves it did not dispatch', async () => {
    const page = {
      performAction: vi.fn(async () => ({
        action: 'click' as const,
        applied: false,
        dispatched: false,
        url: 'https://example.test/current',
        reason: 'ref_not_found' as const,
      })),
    };
    const { executor, sessions, send } = harness({ page });

    await executor.execute(
      call('browser_click', {
        tabId: 7,
        ref: 'ref_1',
        button: 'left',
        count: 1,
      }),
      new AbortController().signal,
    );

    expect(sessions.ensure).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mousePressed' }),
    );
  });

  it('animates first, dispatches one click sequence, and returns mechanical verification', async () => {
    const { executor, send, pointer, order } = harness();

    const result = await executor.execute(
      call('browser_click', {
        tabId: 7,
        ref: 'ref_1',
        button: 'left',
        count: 1,
      }),
      new AbortController().signal,
    );

    expect(pointer.show).toHaveBeenCalledWith(7, {
      x: 60,
      y: 35,
      fromX: 60,
      fromY: 35,
      effect: 'click',
    });
    expect(order.indexOf('pointer')).toBeLessThan(order.indexOf('cdp:Input.dispatchMouseEvent'));
    expect(send).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchMouseEvent',
      expect.objectContaining({
        type: 'mousePressed',
        x: 60,
        y: 35,
        button: 'left',
        clickCount: 1,
      }),
    );
    expect(
      send.mock.calls.filter(
        ([, method, params]) =>
          method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed',
      ),
    ).toHaveLength(1);
    expect(result).toMatchObject({
      tabId: 7,
      url: 'https://example.test/current',
      data: { action: 'click', dispatched: true },
      observation: { targetPresent: true },
    });
  });

  it('automatically scrolls a stable ref into view and measures it again before clicking', async () => {
    const { executor, send, pointer, order } = harness({
      responder: (_session, method) => {
        if (method === 'Page.getLayoutMetrics') {
          return {
            visualViewport: {
              pageX: 0,
              pageY: 700,
              clientWidth: 800,
              clientHeight: 600,
            },
          };
        }
        if (method === 'DOM.getBoxModel') {
          return { model: { border: [410, 820, 510, 820, 510, 850, 410, 850] } };
        }
        return undefined;
      },
    });

    await executor.execute(
      call('browser_click', {
        tabId: 7,
        ref: 'ref_1',
        button: 'left',
        count: 1,
      }),
      new AbortController().signal,
    );

    expect(send).toHaveBeenCalledWith({ tabId: 7 }, 'DOM.scrollIntoViewIfNeeded', {
      backendNodeId: 42,
    });
    expect(order.indexOf('cdp:DOM.scrollIntoViewIfNeeded')).toBeLessThan(
      order.indexOf('cdp:DOM.getBoxModel'),
    );
    expect(order.indexOf('cdp:DOM.getBoxModel')).toBeLessThan(order.indexOf('pointer'));
    expect(pointer.show).toHaveBeenCalledWith(7, {
      x: 460,
      y: 135,
      fromX: 460,
      fromY: 135,
      effect: 'click',
    });
    expect(send).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mousePressed', x: 460, y: 135 }),
    );
  });

  it('rejects a ref when its document loader changed before scrolling or input', async () => {
    const { executor, send } = harness({
      responder: (_session, method) =>
        method === 'Page.getFrameTree'
          ? {
              frameTree: {
                frame: {
                  id: 'frame-main',
                  loaderId: 'loader-2',
                  url: 'https://example.test/other',
                  domainAndRegistry: 'example.test',
                  securityOrigin: 'https://example.test',
                  mimeType: 'text/html',
                },
              },
            }
          : undefined,
    });

    await expect(
      executor.execute(
        call('browser_click', {
          tabId: 7,
          ref: 'ref_1',
          button: 'left',
          count: 1,
        }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'STALE_REF' });
    expect(send).not.toHaveBeenCalledWith(
      { tabId: 7 },
      'DOM.scrollIntoViewIfNeeded',
      expect.anything(),
    );
    expect(send.mock.calls.some(([, method]) => method === 'Input.dispatchMouseEvent')).toBe(false);
  });

  it('does not repeat a click when the optional pointer overlay fails', async () => {
    const { executor, send } = harness({ pointerRejects: true });

    await executor.execute(
      call('browser_click', {
        tabId: 7,
        ref: 'ref_1',
        button: 'left',
        count: 1,
      }),
      new AbortController().signal,
    );

    expect(
      send.mock.calls.filter(
        ([, method, params]) =>
          method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed',
      ),
    ).toHaveLength(1);
  });

  it('focuses, replaces, inserts bounded text, and optionally submits', async () => {
    const { executor, send } = harness();

    await executor.execute(
      call('browser_type', {
        tabId: 7,
        ref: 'ref_1',
        text: 'hello',
        replace: true,
        submit: true,
      }),
      new AbortController().signal,
    );

    expect(send).toHaveBeenCalledWith({ tabId: 7 }, 'DOM.focus', {
      backendNodeId: 42,
    });
    expect(send).toHaveBeenCalledWith({ tabId: 7 }, 'Input.insertText', {
      text: 'hello',
    });
    expect(send).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchKeyEvent',
      expect.objectContaining({ type: 'keyDown', key: 'Enter' }),
    );
  });

  it('keeps editor-aware atomic replacement for new CDP semantic refs', async () => {
    const replacement = 'fn main() {\n    println!("hello");\n}';
    let editorValue = 'starter';
    const { executor, send } = harness({
      os: 'mac',
      responder: (_session, method, params) => {
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: 'editor_node' } };
        }
        if (method === 'Runtime.callFunctionOn' && params?.objectId === 'editor_node') {
          return {
            result: {
              type: 'object',
              value: { editor: true, value: editorValue },
            },
          };
        }
        if (method === 'Runtime.callFunctionOn' && params?.objectId === 'page_global') {
          editorValue = replacement;
          return { result: { type: 'object', value: { dispatched: true } } };
        }
        if (method === 'Runtime.evaluate' && params?.returnByValue === true) {
          return { result: { type: 'string', value: editorValue } };
        }
        return undefined;
      },
    });

    await expect(
      executor.execute(
        call('browser_type', {
          tabId: 7,
          ref: 'ref_1',
          text: replacement,
          replace: true,
          submit: false,
        }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      data: {
        action: 'type',
        strategy: 'trusted_input',
        verified: true,
        replaced: true,
      },
    });
    expect(send).not.toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.insertText',
      expect.objectContaining({ text: replacement }),
    );
  });

  it('validates screenshot coordinates against the current viewport', async () => {
    const { executor, send } = harness();

    await expect(
      executor.execute(
        call('browser_click_point', {
          tabId: 7,
          x: 801,
          y: 20,
          button: 'left',
          count: 1,
        }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'POINT_OUT_OF_VIEWPORT' });
    expect(send.mock.calls.some(([, method]) => method === 'Input.dispatchMouseEvent')).toBe(false);
  });

  it('navigates logical browser history without synthesizing shortcuts', async () => {
    const { executor, send } = harness();

    await executor.execute(
      call('browser_keypress', { tabId: 7, keys: 'BROWSER_BACK' }),
      new AbortController().signal,
    );

    expect(send).toHaveBeenCalledWith({ tabId: 7 }, 'Page.navigateToHistoryEntry', { entryId: 1 });
    expect(send.mock.calls.some(([, method]) => method === 'Input.dispatchKeyEvent')).toBe(false);
  });

  it('selects through one fixed internal function and page-owned value argument', async () => {
    const { executor, send } = harness();

    await executor.execute(
      call('browser_select', { tabId: 7, ref: 'ref_1', value: 'pro' }),
      new AbortController().signal,
    );

    expect(send).toHaveBeenCalledWith(
      { tabId: 7 },
      'Runtime.callFunctionOn',
      expect.objectContaining({
        objectId: 'object_1',
        arguments: [{ value: 'pro' }],
        functionDeclaration: expect.stringContaining('HTMLSelectElement'),
      }),
    );
  });

  it('waits for an explicit bounded delay without dispatching input', async () => {
    vi.useFakeTimers();
    const { executor, send, sessions } = harness();
    const waiting = executor.execute(
      call('browser_wait', { tabId: 7, condition: 'delay', timeoutMs: 250 }),
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(250);

    await expect(waiting).resolves.toMatchObject({
      data: { action: 'wait', condition: 'delay' },
    });
    expect(sessions.ensure).not.toHaveBeenCalled();
    expect(send.mock.calls.some(([, method]) => method.startsWith('Input.'))).toBe(false);
  });
});
