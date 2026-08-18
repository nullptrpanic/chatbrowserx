import { describe, expect, it, vi } from 'vitest';
import type {
  DebuggerSession,
  DebuggerTransport,
} from '../../../src/browser/debugger/debugger-transport';
import type { BrowserSessionSnapshot } from '../../../src/browser/debugger/target-session-registry';
import { ElementRefStore } from '../../../src/browser/observation/element-ref-store';
import {
  PageObserver,
  type PageObservationContentPort,
} from '../../../src/browser/observation/page-observer';

function sessions(snapshot: BrowserSessionSnapshot) {
  return { ensure: vi.fn(async () => snapshot) };
}

function debuggerTransport(
  responder: (
    session: DebuggerSession,
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ) => unknown,
): DebuggerTransport {
  return {
    attach: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    send: vi.fn(async (session, method, params) =>
      responder(session, method, params),
    ) as unknown as DebuggerTransport['send'],
    onEvent: () => () => undefined,
    onDetach: () => () => undefined,
  };
}

const CONTENT: PageObservationContentPort = {
  readContent: vi.fn(async () => ({
    title: 'Top page',
    url: 'https://top.test/',
    text: 'Top text',
    headings: [{ level: 1, text: 'Top heading' }],
    links: [],
    truncated: false,
  })),
  observeElements: vi.fn(async () => [
    {
      role: 'button',
      name: 'Fallback name',
      state: [],
      bounds: { x: 10, y: 20, width: 100, height: 30 },
    },
  ]),
  setOverlaysHidden: vi.fn(async () => undefined),
};

describe('PageObserver', () => {
  it('hides overlays, captures one bounded PNG, persists it once, and restores overlays', async () => {
    const snapshot: BrowserSessionSnapshot = {
      tabId: 7,
      generation: 1,
      root: { tabId: 7 },
      children: new Map(),
    };
    const calls: string[] = [];
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const transport = debuggerTransport((_session, method) => {
      calls.push(method);
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
      if (method === 'Page.captureScreenshot') return { data: pngBase64 };
      if (method === 'Page.getNavigationHistory') {
        return {
          currentIndex: 0,
          entries: [
            {
              id: 1,
              url: 'https://top.test/',
              title: 'Top page',
              transitionType: 'typed',
            },
          ],
        };
      }
      return {};
    });
    const setOverlaysHidden = vi.fn(async (tabId: number, hidden: boolean) => {
      calls.push(`overlay:${String(tabId)}:${String(hidden)}`);
    });
    const persistScreenshot = vi.fn(async (blob: Blob) => {
      calls.push(`persist:${blob.type}:${String(blob.size)}`);
      return { id: 'attachment_screenshot' };
    });
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: { ...CONTENT, setOverlaysHidden },
      refs: new ElementRefStore({ create: () => 'unused' }),
      persistScreenshot,
    });

    const result = await observer.inspect(7, 'screenshot', new AbortController().signal);

    expect(result).toEqual({
      tabId: 7,
      url: 'https://top.test/',
      data: {
        mode: 'screenshot',
        mimeType: 'image/png',
        width: 800,
        height: 600,
        attachmentId: 'attachment_screenshot',
      },
      observation: null,
      attachmentIds: ['attachment_screenshot'],
    });
    expect(calls.indexOf('overlay:7:true')).toBeLessThan(calls.indexOf('Page.captureScreenshot'));
    expect(calls.indexOf('Page.captureScreenshot')).toBeLessThan(
      calls.findIndex((call) => call.startsWith('persist:image/png:')),
    );
    expect(calls.at(-1)).toBe('overlay:7:false');
    expect(persistScreenshot).toHaveBeenCalledOnce();
  });

  it('uses AX backend nodes, ignores unusable nodes, and fills a missing name from DOM', async () => {
    const snapshot: BrowserSessionSnapshot = {
      tabId: 7,
      generation: 4,
      root: { tabId: 7 },
      children: new Map(),
    };
    const transport = debuggerTransport((_session, method, params) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: '1',
              backendDOMNodeId: 11,
              ignored: false,
              role: { value: 'button' },
              name: { value: 'Submit' },
              properties: [{ name: 'focusable', value: { value: true } }],
            },
            {
              nodeId: '2',
              backendDOMNodeId: 12,
              ignored: true,
              role: { value: 'button' },
              name: { value: 'Ignored' },
            },
            {
              nodeId: '3',
              backendDOMNodeId: 13,
              ignored: false,
              role: { value: 'button' },
              name: { value: 'Zero' },
            },
            {
              nodeId: '4',
              backendDOMNodeId: 14,
              ignored: false,
              role: { value: 'button' },
              name: { value: '' },
            },
          ],
        };
      }
      if (method === 'DOM.getBoxModel') {
        const backendNodeId = (params as { backendNodeId: number }).backendNodeId;
        if (backendNodeId === 13) return { model: { border: [0, 0, 0, 0, 0, 0, 0, 0] } };
        return { model: { border: [10, 20, 110, 20, 110, 50, 10, 50] } };
      }
      if (method === 'Page.getLayoutMetrics') {
        return { visualViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 } };
      }
      if (method === 'Page.getNavigationHistory') {
        return {
          currentIndex: 0,
          entries: [
            { id: 1, url: 'https://top.test/', title: 'Top page', transitionType: 'typed' },
          ],
        };
      }
      return {};
    });
    let id = 0;
    const refs = new ElementRefStore({ create: () => `ref_${++id}` });
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: CONTENT,
      refs,
    });

    const result = await observer.inspect(7, 'interactive', new AbortController().signal);

    expect(result.data).toMatchObject({
      mode: 'interactive',
      truncated: false,
      elements: [
        expect.objectContaining({
          ref: 'ref_1',
          role: 'button',
          name: 'Submit',
          state: ['focusable'],
        }),
        expect.objectContaining({ ref: 'ref_2', role: 'button', name: 'Fallback name' }),
      ],
    });
    expect(refs.resolve('ref_2', 7, 4)).toMatchObject({ backendNodeId: 14 });
  });

  it('accumulates parent frame-owner offsets for nested OOPIF bounds', async () => {
    const child = {
      targetId: 'frame_child',
      type: 'iframe',
      url: 'https://child.test/',
      parentSessionId: null,
      session: { tabId: 7, sessionId: 'session_child' },
    } as const;
    const snapshot: BrowserSessionSnapshot = {
      tabId: 7,
      generation: 2,
      root: { tabId: 7 },
      children: new Map([[child.targetId, child]]),
    };
    const transport = debuggerTransport((session, method, params) => {
      if (method === 'Accessibility.getFullAXTree') {
        return session.sessionId
          ? {
              nodes: [
                {
                  nodeId: 'child',
                  backendDOMNodeId: 21,
                  ignored: false,
                  role: { value: 'link' },
                  name: { value: 'Child link' },
                },
              ],
            }
          : { nodes: [] };
      }
      if (method === 'DOM.getFrameOwner') return { backendNodeId: 99 };
      if (method === 'DOM.getBoxModel') {
        const id = (params as { backendNodeId: number }).backendNodeId;
        return id === 99
          ? { model: { border: [100, 200, 500, 200, 500, 500, 100, 500] } }
          : { model: { border: [10, 20, 60, 20, 60, 40, 10, 40] } };
      }
      if (method === 'Page.getLayoutMetrics')
        return { visualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
      if (method === 'Page.getNavigationHistory')
        return {
          currentIndex: 0,
          entries: [{ id: 1, url: 'https://top.test/', title: 'Top', transitionType: 'typed' }],
        };
      return {};
    });
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: { ...CONTENT, observeElements: vi.fn(async () => []) },
      refs: new ElementRefStore({ create: () => 'ref_child' }),
    });

    const result = await observer.inspect(7, 'interactive', new AbortController().signal);

    expect(result.data).toMatchObject({
      elements: [
        expect.objectContaining({
          name: 'Child link',
          frame: 'frame_child',
          bounds: { x: 110, y: 220, width: 50, height: 20 },
        }),
      ],
    });
  });

  it('combines top-page content with bounded OOPIF accessibility text', async () => {
    const child = {
      targetId: 'frame_child',
      type: 'iframe',
      url: 'https://child.test/',
      parentSessionId: null,
      session: { tabId: 7, sessionId: 'session_child' },
    } as const;
    const snapshot: BrowserSessionSnapshot = {
      tabId: 7,
      generation: 2,
      root: { tabId: 7 },
      children: new Map([[child.targetId, child]]),
    };
    const transport = debuggerTransport((session, method) =>
      method === 'Accessibility.getFullAXTree' && session.sessionId
        ? {
            nodes: [
              {
                nodeId: 'text',
                ignored: false,
                role: { value: 'StaticText' },
                name: { value: 'Cross-origin frame text' },
              },
            ],
          }
        : {},
    );
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: CONTENT,
      refs: new ElementRefStore({ create: () => 'unused' }),
    });

    const result = await observer.inspect(7, 'content', new AbortController().signal);

    expect(result.data).toMatchObject({ mode: 'content', title: 'Top page' });
    expect(JSON.stringify(result.data)).toContain('Cross-origin frame text');
  });
});
