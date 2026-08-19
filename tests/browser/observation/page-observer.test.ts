import { afterEach, describe, expect, it, vi } from 'vitest';
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
  setOverlaysHidden: vi.fn(async () => undefined),
};

function buttonDomSnapshot(frameId = 'frame-main', backendNodeId = 11, checked = false) {
  const strings = [
    'https://top.test/',
    'Top page',
    '',
    frameId,
    '#document',
    'BUTTON',
    'auto',
    'block',
    'visible',
    'pointer',
  ];
  return {
    strings,
    documents: [
      {
        documentURL: 0,
        title: 1,
        baseURL: 0,
        contentLanguage: 2,
        encodingName: 2,
        publicId: 2,
        systemId: 2,
        frameId: 3,
        nodes: {
          parentIndex: [-1, 0],
          nodeType: [9, 1],
          nodeName: [4, 5],
          nodeValue: [2, 2],
          backendNodeId: [1, backendNodeId],
          attributes: [[], []],
          isClickable: { index: [1] },
          inputChecked: { index: checked ? [1] : [] },
        },
        layout: {
          nodeIndex: [1],
          styles: [[9, 7, 8, 6]],
          bounds: [[10, 20, 100, 30]],
          text: [2],
          stackingContexts: { index: [] },
        },
        textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
      },
    ],
  };
}

function mainFrameTree(
  loaderId = 'loader-main',
  frameId = 'frame-main',
  url = 'https://top.test/',
) {
  return {
    frameTree: {
      frame: {
        id: frameId,
        loaderId,
        url,
        domainAndRegistry: new URL(url).hostname,
        securityOrigin: new URL(url).origin,
        mimeType: 'text/html',
      },
    },
  };
}

describe('PageObserver', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses compact native AX semantics on ordinary pages and keeps debugger details internal', async () => {
    const snapshot: BrowserSessionSnapshot = {
      tabId: 7,
      generation: 1,
      root: { tabId: 7 },
      children: new Map(),
    };
    const sessionPort = sessions(snapshot);
    const transport = debuggerTransport((_session, method) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: 'root',
              backendDOMNodeId: 1,
              ignored: false,
              role: { value: 'RootWebArea' },
              name: { value: 'Top page' },
              childIds: ['button'],
            },
            {
              nodeId: 'button',
              parentId: 'root',
              backendDOMNodeId: 11,
              ignored: false,
              role: { value: 'button' },
              name: { value: 'Submit' },
              properties: [{ name: 'focusable', value: { value: true } }],
            },
          ],
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') return buttonDomSnapshot();
      if (method === 'Page.getFrameTree') return mainFrameTree();
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
    const refs = new ElementRefStore({ create: () => 'ref_1' });
    const observer = new PageObserver({
      sessions: sessionPort,
      transport,
      content: CONTENT,
      refs,
    });

    const result = await observer.inspect(7, 'interactive', new AbortController().signal);

    expect(sessionPort.ensure).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      url: 'https://top.test/',
      debuggerSession: 'ephemeral',
      visualFallbackAllowed: false,
      data: {
        mode: 'interactive',
        keys: 'd=depth,r=role(default generic),n=name,s=state,a=extra actions(ref defaults click),f=frame',
        elements: [
          {
            d: 1,
            r: 'button',
            n: 'Submit',
            ref: 'ref_1',
          },
        ],
      },
    });
    const [element] = result.data.elements as Readonly<Record<string, unknown>>[];
    expect(element).not.toHaveProperty('a');
    expect(result.data).not.toHaveProperty('truncated');
    expect(result.data).not.toHaveProperty('generation');
    expect(JSON.stringify(result.data)).not.toContain('bounds');
    expect(refs.resolve('ref_1', 7)).toMatchObject({
      documentFrameId: 'frame-main',
      loaderId: 'loader-main',
      backendNodeId: 11,
    });
  });

  it('keeps interactive_deep as a compatibility alias for native interactive inspection', async () => {
    const snapshot: BrowserSessionSnapshot = {
      tabId: 7,
      generation: 1,
      root: { tabId: 7 },
      children: new Map(),
    };
    const sessionPort = sessions(snapshot);
    const transport = debuggerTransport((_session, method) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: 'button',
              backendDOMNodeId: 11,
              ignored: false,
              role: { value: 'button' },
              name: { value: 'Submit' },
            },
          ],
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') return buttonDomSnapshot();
      if (method === 'Page.getFrameTree') return mainFrameTree();
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
    const observer = new PageObserver({
      sessions: sessionPort,
      transport,
      content: CONTENT,
      refs: new ElementRefStore({ create: () => 'ref_1' }),
    });

    const result = await observer.inspect(7, 'interactive_deep', new AbortController().signal);

    expect(sessionPort.ensure).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      debuggerSession: 'ephemeral',
      data: {
        mode: 'interactive',
        elements: [expect.objectContaining({ ref: 'ref_1', n: 'Submit' })],
      },
    });
  });

  it('omits the default generic role and does not expose long semantic field names', async () => {
    const snapshot: BrowserSessionSnapshot = {
      tabId: 7,
      generation: 1,
      root: { tabId: 7 },
      children: new Map(),
    };
    const transport = debuggerTransport((_session, method) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: 'custom',
              backendDOMNodeId: 11,
              ignored: false,
              role: { value: 'generic' },
              name: { value: 'Custom option' },
            },
          ],
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') return buttonDomSnapshot();
      if (method === 'Page.getFrameTree') return mainFrameTree();
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
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: CONTENT,
      refs: new ElementRefStore({ create: () => 'ref_generic' }),
    });

    const result = await observer.inspect(7, 'interactive', new AbortController().signal);

    expect(result.data).toMatchObject({
      keys: 'd=depth,r=role(default generic),n=name,s=state,a=extra actions(ref defaults click),f=frame',
      elements: [{ d: 0, n: 'Custom option', ref: 'ref_generic' }],
    });
    const [element] = result.data.elements as Readonly<Record<string, unknown>>[];
    expect(element).not.toHaveProperty('r');
    expect(element).not.toHaveProperty('a');
    expect(element).not.toHaveProperty('depth');
    expect(element).not.toHaveProperty('role');
    expect(element).not.toHaveProperty('name');
    expect(element).not.toHaveProperty('state');
    expect(element).not.toHaveProperty('actions');
    expect(element).not.toHaveProperty('frame');
  });

  it('keeps non-default actions while treating click as implicit for refs', async () => {
    const snapshot: BrowserSessionSnapshot = {
      tabId: 7,
      generation: 1,
      root: { tabId: 7 },
      children: new Map(),
    };
    const transport = debuggerTransport((_session, method) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: 'query',
              backendDOMNodeId: 11,
              ignored: false,
              role: { value: 'textbox' },
              name: { value: 'Query' },
            },
          ],
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') return buttonDomSnapshot();
      if (method === 'Page.getFrameTree') return mainFrameTree();
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
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: CONTENT,
      refs: new ElementRefStore({ create: () => 'ref_query' }),
    });

    const result = await observer.inspect(7, 'interactive', new AbortController().signal);

    expect(result.data).toMatchObject({
      mode: 'interactive',
      snapshot: expect.any(String),
      keys: 'd=depth,r=role(default generic),n=name,s=state,a=extra actions(ref defaults click),f=frame',
      elements: [{ d: 0, r: 'textbox', n: 'Query', a: ['type'], ref: 'ref_query' }],
    });
  });

  it('returns only state changes when inspecting from the latest interactive snapshot', async () => {
    const snapshot: BrowserSessionSnapshot = {
      tabId: 7,
      generation: 1,
      root: { tabId: 7 },
      children: new Map(),
    };
    let checked = false;
    let name = 'Choice A';
    const transport = debuggerTransport((_session, method) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: 'choice',
              backendDOMNodeId: 11,
              ignored: false,
              role: { value: 'checkbox' },
              name: { value: name },
            },
          ],
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') {
        return buttonDomSnapshot('frame-main', 11, checked);
      }
      if (method === 'Page.getFrameTree') return mainFrameTree();
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
    let refId = 0;
    const refs = new ElementRefStore({ create: () => `ref_${String(++refId)}` });
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: CONTENT,
      refs,
    });

    const first = await observer.inspect(7, 'interactive', new AbortController().signal);
    const firstSnapshot = first.data.snapshot;
    expect(firstSnapshot).toEqual(expect.any(String));
    expect(first.data).toMatchObject({
      elements: [
        {
          r: 'checkbox',
          n: 'Choice A',
          s: ['checked=false'],
          a: ['set_checked'],
          ref: 'ref_1',
        },
      ],
    });

    checked = true;
    const second = await observer.inspect(7, 'interactive', new AbortController().signal, {
      since: firstSnapshot as string,
    });

    expect(second.data).toEqual({
      mode: 'interactive',
      snapshot: expect.any(String),
      base: firstSnapshot,
      changes: [{ i: 0, s: ['checked'] }],
    });
    expect(second.data.snapshot).not.toBe(firstSnapshot);
    expect(refs.resolve('ref_1', 7)).toMatchObject({ state: ['checked'] });

    const third = await observer.inspect(7, 'interactive', new AbortController().signal, {
      since: second.data.snapshot as string,
    });
    expect(third.data).toEqual({
      mode: 'interactive',
      snapshot: expect.any(String),
      base: second.data.snapshot,
      unchanged: true,
    });

    checked = false;
    const fourth = await observer.inspect(7, 'interactive', new AbortController().signal, {
      since: third.data.snapshot as string,
    });
    expect(fourth.data).toMatchObject({
      base: third.data.snapshot,
      changes: [{ i: 0, s: ['checked=false'] }],
    });

    name = 'Choice B';
    const fifth = await observer.inspect(7, 'interactive', new AbortController().signal, {
      since: fourth.data.snapshot as string,
    });
    expect(fifth.data).toMatchObject({
      snapshot: expect.any(String),
      elements: [
        {
          r: 'checkbox',
          n: 'Choice B',
          s: ['checked=false'],
          a: ['set_checked'],
          ref: 'ref_1',
        },
      ],
    });
    expect(fifth.data).not.toHaveProperty('base');
    expect(fifth.data).not.toHaveProperty('changes');
  });

  it('returns a full interactive tree after interactive snapshot baselines are invalidated', async () => {
    const snapshot: BrowserSessionSnapshot = {
      tabId: 7,
      generation: 1,
      root: { tabId: 7 },
      children: new Map(),
    };
    const transport = debuggerTransport((_session, method) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: 'button',
              backendDOMNodeId: 11,
              ignored: false,
              role: { value: 'button' },
              name: { value: 'Submit' },
            },
          ],
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') return buttonDomSnapshot();
      if (method === 'Page.getFrameTree') return mainFrameTree();
      if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [] };
      return {};
    });
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: CONTENT,
      refs: new ElementRefStore({ create: () => 'ref_full' }),
    });

    const first = await observer.inspect(7, 'interactive', new AbortController().signal);
    observer.invalidateInteractiveSnapshots();
    const result = await observer.inspect(7, 'interactive', new AbortController().signal, {
      since: first.data.snapshot as string,
    });

    expect(result.data).toMatchObject({
      mode: 'interactive',
      snapshot: expect.any(String),
      elements: [{ r: 'button', n: 'Submit', ref: 'ref_full' }],
    });
    expect(result.data).not.toHaveProperty('base');
    expect(result.data).not.toHaveProperty('changes');
  });

  it('retains the truncation marker when interactive elements were omitted', async () => {
    const snapshot: BrowserSessionSnapshot = {
      tabId: 7,
      generation: 1,
      root: { tabId: 7 },
      children: new Map(),
    };
    const transport = debuggerTransport((_session, method) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: Array.from({ length: 501 }, (_, index) => ({
            nodeId: `text-${String(index)}`,
            ignored: false,
            role: { value: 'StaticText' },
            name: { value: `Text ${String(index)}` },
          })),
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') return buttonDomSnapshot();
      if (method === 'Page.getFrameTree') return mainFrameTree();
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
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: CONTENT,
      refs: new ElementRefStore({ create: () => 'unused' }),
    });

    const result = await observer.inspect(7, 'interactive', new AbortController().signal);

    expect(result.data).toMatchObject({ truncated: true });
    expect(result.data.elements).toHaveLength(500);
  });

  it('prepares a bounded model image while preserving CSS viewport dimensions', async () => {
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
            clientWidth: 1255,
            clientHeight: 800,
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
    const preparedBlob = new Blob(['prepared'], { type: 'image/png' });
    const close = vi.fn();
    const drawImage = vi.fn();
    const canvases: { width: number; height: number }[] = [];
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 2510, height: 1600, close })),
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(width: number, height: number) {
          canvases.push({ width, height });
        }

        getContext() {
          return { drawImage };
        }

        async convertToBlob() {
          return preparedBlob;
        }
      },
    );
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
        width: 1440,
        height: 918,
        viewportWidth: 1255,
        viewportHeight: 800,
        attachmentId: 'attachment_screenshot',
      },
      observation: null,
      attachmentIds: ['attachment_screenshot'],
      debuggerSession: 'ephemeral',
    });
    expect(calls.indexOf('overlay:7:true')).toBeLessThan(calls.indexOf('Page.captureScreenshot'));
    expect(calls.indexOf('Page.captureScreenshot')).toBeLessThan(
      calls.findIndex((call) => call.startsWith('persist:image/png:')),
    );
    expect(calls.at(-1)).toBe('overlay:7:false');
    expect(persistScreenshot).toHaveBeenCalledWith(preparedBlob);
    expect(persistScreenshot).toHaveBeenCalledOnce();
    expect(canvases).toEqual([{ width: 1440, height: 918 }]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('captures through CDP when hiding extension overlays is unavailable', async () => {
    const snapshot: BrowserSessionSnapshot = {
      tabId: 7,
      generation: 1,
      root: { tabId: 7 },
      children: new Map(),
    };
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const transport = debuggerTransport((_session, method) => {
      if (method === 'Page.getLayoutMetrics') {
        return {
          visualViewport: {
            pageX: 0,
            pageY: 0,
            clientWidth: 1,
            clientHeight: 1,
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
    const setOverlaysHidden = vi.fn(async () => {
      throw Object.assign(new Error('page bridge unavailable'), { code: 'PAGE_UNAVAILABLE' });
    });
    const close = vi.fn();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 1, height: 1, close })),
    );
    const persistScreenshot = vi.fn(async () => ({ id: 'attachment_screenshot' }));
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: { ...CONTENT, setOverlaysHidden },
      refs: new ElementRefStore({ create: () => 'unused' }),
      persistScreenshot,
    });

    const result = await observer.inspect(7, 'screenshot', new AbortController().signal);

    expect(result).toMatchObject({
      data: { mode: 'screenshot', attachmentId: 'attachment_screenshot' },
      attachmentIds: ['attachment_screenshot'],
    });
    expect(transport.send).toHaveBeenCalledWith(
      { tabId: 7 },
      'Page.captureScreenshot',
      expect.anything(),
    );
    expect(persistScreenshot).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('includes OOPIF semantics while keeping a stable frame target and loader in the ref', async () => {
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
    const transport = debuggerTransport((session, method) => {
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
      if (method === 'DOMSnapshot.captureSnapshot') {
        return session.sessionId
          ? buttonDomSnapshot('frame-child-document', 21)
          : buttonDomSnapshot();
      }
      if (method === 'Page.getFrameTree') {
        return session.sessionId
          ? mainFrameTree('loader-child', 'frame-child-document', 'https://child.test/')
          : mainFrameTree();
      }
      if (method === 'Page.getNavigationHistory')
        return {
          currentIndex: 0,
          entries: [{ id: 1, url: 'https://top.test/', title: 'Top', transitionType: 'typed' }],
        };
      return {};
    });
    const refs = new ElementRefStore({ create: () => 'ref_child' });
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: CONTENT,
      refs,
    });

    const result = await observer.inspect(7, 'interactive_deep', new AbortController().signal);

    expect(result.data).toMatchObject({
      elements: [
        expect.objectContaining({
          n: 'Child link',
          f: 'frame_child',
          ref: 'ref_child',
        }),
      ],
    });
    expect(refs.resolve('ref_child', 7)).toMatchObject({
      frameTargetId: 'frame_child',
      documentFrameId: 'frame-child-document',
      loaderId: 'loader-child',
      backendNodeId: 21,
    });
  });

  it('reads ordinary page content without attaching the debugger', async () => {
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
    const sessionPort = sessions(snapshot);
    const observer = new PageObserver({
      sessions: sessionPort,
      transport,
      content: CONTENT,
      refs: new ElementRefStore({ create: () => 'unused' }),
    });

    const result = await observer.inspect(7, 'content', new AbortController().signal);

    expect(result.data).toMatchObject({
      mode: 'content',
      title: 'Top page',
      text: 'Top text',
      frames: [],
    });
    expect(result.debuggerSession).toBe('none');
    expect(sessionPort.ensure).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
  });
});
