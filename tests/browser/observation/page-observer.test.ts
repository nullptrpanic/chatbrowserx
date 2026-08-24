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

function buttonDomSnapshot(
  frameId = 'frame-main',
  backendNodeId = 11,
  checked = false,
  bounds: readonly [number, number, number, number] = [10, 20, 100, 30],
) {
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
          bounds: [[...bounds]],
          text: [2],
          stackingContexts: { index: [] },
        },
        textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
      },
    ],
  };
}

function virtualDocumentDomSnapshot() {
  const strings = [
    'https://top.test/',
    'Virtual document',
    '',
    'frame-main',
    '#document',
    'DIV',
    'aria-label',
    'Document pages',
    'auto',
    'block',
    'visible',
    'hidden',
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
          backendNodeId: [1, 11],
          attributes: [[], [6, 7]],
          isClickable: { index: [] },
        },
        layout: {
          nodeIndex: [1],
          styles: [[8, 9, 10, 8, 10, 11]],
          bounds: [[100, 80, 800, 600]],
          text: [2],
          stackingContexts: { index: [] },
          scrollRects: [[100, 80, 800, 6_000]],
          clientRects: [[100, 80, 800, 600]],
        },
        textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
      },
    ],
  };
}

function multipleScrollContainersDomSnapshot(
  containers: readonly {
    readonly label: string;
    readonly bounds: readonly [number, number, number, number];
    readonly scrollHeight: number;
  }[],
) {
  const strings = [
    'https://top.test/',
    'Scrollable workspace',
    '',
    'frame-main',
    '#document',
    'DIV',
    'aria-label',
    'auto',
    'block',
    'visible',
    'hidden',
    ...containers.map(({ label }) => label),
  ];
  const labelOffset = 11;
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
          parentIndex: [-1, ...containers.map(() => 0)],
          nodeType: [9, ...containers.map(() => 1)],
          nodeName: [4, ...containers.map(() => 5)],
          nodeValue: [2, ...containers.map(() => 2)],
          backendNodeId: [1, ...containers.map((_container, index) => index + 10)],
          attributes: [[], ...containers.map((_container, index) => [6, labelOffset + index])],
          isClickable: { index: [] },
        },
        layout: {
          nodeIndex: containers.map((_container, index) => index + 1),
          styles: containers.map(() => [7, 8, 9, 7, 9, 10]),
          bounds: containers.map(({ bounds }) => [...bounds]),
          text: containers.map(() => 2),
          stackingContexts: { index: [] },
          scrollRects: containers.map(({ bounds, scrollHeight }) => [
            bounds[0],
            bounds[1],
            bounds[2],
            scrollHeight,
          ]),
          clientRects: containers.map(({ bounds }) => [...bounds]),
        },
        textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
      },
    ],
  };
}

function nestedScrollContainersDomSnapshot() {
  const strings = [
    'https://top.test/',
    'Nested workspace',
    '',
    'frame-main',
    '#document',
    'DIV',
    'aria-label',
    'auto',
    'block',
    'visible',
    'hidden',
    'Conversation history and messages',
    'Conversation history',
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
          parentIndex: [-1, 0, 1],
          nodeType: [9, 1, 1],
          nodeName: [4, 5, 5],
          nodeValue: [2, 2, 2],
          backendNodeId: [1, 10, 11],
          attributes: [[], [6, 11], [6, 12]],
          isClickable: { index: [] },
        },
        layout: {
          nodeIndex: [1, 2],
          styles: [
            [7, 8, 9, 7, 9, 10],
            [7, 8, 9, 7, 9, 10],
          ],
          bounds: [
            [100, 80, 900, 650],
            [104, 84, 892, 642],
          ],
          text: [2, 2],
          stackingContexts: { index: [] },
          scrollRects: [
            [100, 80, 900, 10_000],
            [104, 84, 892, 9_900],
          ],
          clientRects: [
            [100, 80, 900, 650],
            [104, 84, 892, 642],
          ],
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
      if (method === 'Page.getFrameTree') {
        return mainFrameTree('loader-main', 'frame-main', 'https://frame.test/current');
      }
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
    const refs = new ElementRefStore({ create: () => 'ref_1' });
    const observer = new PageObserver({
      sessions: sessionPort,
      transport,
      content: CONTENT,
      refs,
    });

    const result = await observer.inspect(7, 'interactive', new AbortController().signal);

    expect(sessionPort.ensure).toHaveBeenCalledOnce();
    expect(transport.send).toHaveBeenCalledWith({ tabId: 7 }, 'DOMSnapshot.captureSnapshot', {
      computedStyles: [
        'cursor',
        'display',
        'visibility',
        'pointer-events',
        'overflow-x',
        'overflow-y',
      ],
      includeDOMRects: true,
      includePaintOrder: true,
    });
    expect(transport.send).not.toHaveBeenCalledWith({ tabId: 7 }, 'Page.getNavigationHistory');
    expect(result).toMatchObject({
      url: 'https://frame.test/current',
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

  it('reports incomplete document coverage and recommends viewport traversal', async () => {
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
              nodeId: 'visible-text',
              ignored: false,
              role: { value: 'StaticText' },
              name: { value: 'Visible document text' },
            },
          ],
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') return buttonDomSnapshot();
      if (method === 'Page.getFrameTree') {
        const tree = mainFrameTree();
        return {
          frameTree: {
            ...tree.frameTree,
            frame: { ...tree.frameTree.frame, url: '' },
          },
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
          contentSize: { x: 0, y: 0, width: 800, height: 2_400 },
        };
      }
      if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [] };
      return {};
    });
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: CONTENT,
      refs: new ElementRefStore({ create: () => 'unused' }),
    });

    const result = await observer.inspect(7, 'interactive', new AbortController().signal);

    expect(transport.send).toHaveBeenCalledWith({ tabId: 7 }, 'Page.getNavigationHistory');
    expect(result.url).toBeNull();
    expect(result.data).toMatchObject({
      mode: 'interactive',
      coverage: {
        scope: 'viewport',
        complete: false,
        moreBefore: false,
        moreAfter: true,
        targets: ['viewport'],
        primaryTarget: 'viewport',
        recommendedAction: 'browser_scroll_until',
        contentKey: expect.stringMatching(/^[0-9a-f]{8}$/),
      },
    });
  });

  it('reports a virtualized element ref as an incomplete traversal target', async () => {
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
              nodeId: 'root',
              backendDOMNodeId: 1,
              ignored: false,
              role: { value: 'RootWebArea' },
              name: { value: 'Virtual document' },
            },
          ],
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') return virtualDocumentDomSnapshot();
      if (method === 'Page.getFrameTree') return mainFrameTree();
      if (method === 'Page.getLayoutMetrics') {
        return {
          visualViewport: {
            pageX: 0,
            pageY: 0,
            clientWidth: 1_000,
            clientHeight: 800,
          },
          contentSize: { x: 0, y: 0, width: 1_000, height: 800 },
        };
      }
      if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [] };
      return {};
    });
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: CONTENT,
      refs: new ElementRefStore({ create: () => 'ref_pages' }),
    });

    const result = await observer.inspect(7, 'interactive', new AbortController().signal);

    expect(result.data).toMatchObject({
      elements: [
        expect.objectContaining({
          n: 'Document pages',
          a: ['scroll'],
          ref: 'ref_pages',
        }),
      ],
      coverage: {
        complete: false,
        moreBefore: 'unknown',
        moreAfter: 'unknown',
        targets: ['ref_pages'],
        primaryTarget: 'ref_pages',
        recommendedAction: 'browser_scroll_until',
      },
    });
  });

  it('ranks one strongly dominant scroll surface first and marks it as primary', async () => {
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
              nodeId: 'root',
              backendDOMNodeId: 1,
              ignored: false,
              role: { value: 'RootWebArea' },
              name: { value: 'Scrollable workspace' },
            },
          ],
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') {
        return multipleScrollContainersDomSnapshot([
          { label: 'Short sidebar', bounds: [0, 0, 240, 600], scrollHeight: 680 },
          { label: 'Main document', bounds: [250, 0, 900, 650], scrollHeight: 21_000 },
          { label: 'Short auxiliary panel', bounds: [250, 660, 900, 100], scrollHeight: 220 },
        ]);
      }
      if (method === 'Page.getFrameTree') return mainFrameTree();
      if (method === 'Page.getLayoutMetrics') {
        return {
          visualViewport: { pageX: 0, pageY: 0, clientWidth: 1_200, clientHeight: 800 },
          contentSize: { x: 0, y: 0, width: 1_200, height: 800 },
        };
      }
      if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [] };
      return {};
    });
    const refs = ['ref_sidebar', 'ref_document', 'ref_auxiliary'];
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: CONTENT,
      refs: new ElementRefStore({ create: () => refs.shift() ?? 'unexpected_ref' }),
    });

    const result = await observer.inspect(7, 'interactive', new AbortController().signal);
    const coverage = result.data.coverage as Readonly<Record<string, unknown>>;

    expect(coverage.targets).toEqual(['ref_document', 'ref_auxiliary', 'ref_sidebar']);
    expect(coverage.primaryTarget).toBe('ref_document');
  });

  it('does not guess a primary scroll target for similarly sized split panes', async () => {
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
              nodeId: 'root',
              backendDOMNodeId: 1,
              ignored: false,
              role: { value: 'RootWebArea' },
              name: { value: 'Split workspace' },
            },
          ],
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') {
        return multipleScrollContainersDomSnapshot([
          { label: 'Left pane', bounds: [0, 0, 580, 700], scrollHeight: 6_000 },
          { label: 'Right pane', bounds: [600, 0, 580, 700], scrollHeight: 5_500 },
        ]);
      }
      if (method === 'Page.getFrameTree') return mainFrameTree();
      if (method === 'Page.getLayoutMetrics') {
        return {
          visualViewport: { pageX: 0, pageY: 0, clientWidth: 1_200, clientHeight: 800 },
          contentSize: { x: 0, y: 0, width: 1_200, height: 800 },
        };
      }
      if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [] };
      return {};
    });
    const refs = ['ref_left', 'ref_right'];
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: CONTENT,
      refs: new ElementRefStore({ create: () => refs.shift() ?? 'unexpected_ref' }),
    });

    const result = await observer.inspect(7, 'interactive', new AbortController().signal);
    const coverage = result.data.coverage as Readonly<Record<string, unknown>>;

    expect(coverage.targets).toEqual(['ref_left', 'ref_right']);
    expect(coverage).not.toHaveProperty('primaryTarget');
  });

  it('canonicalizes near-identical nested scroll surfaces to the deeper semantic target', async () => {
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
              nodeId: 'root',
              backendDOMNodeId: 1,
              ignored: false,
              role: { value: 'RootWebArea' },
              name: { value: 'Nested workspace' },
            },
          ],
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') return nestedScrollContainersDomSnapshot();
      if (method === 'Page.getFrameTree') return mainFrameTree();
      if (method === 'Page.getLayoutMetrics') {
        return {
          visualViewport: { pageX: 0, pageY: 0, clientWidth: 1_200, clientHeight: 800 },
          contentSize: { x: 0, y: 0, width: 1_200, height: 800 },
        };
      }
      if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [] };
      return {};
    });
    const refs = ['ref_outer', 'ref_history'];
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: CONTENT,
      refs: new ElementRefStore({ create: () => refs.shift() ?? 'unexpected_ref' }),
    });

    const result = await observer.inspect(7, 'interactive', new AbortController().signal);
    const coverage = result.data.coverage as Readonly<Record<string, unknown>>;

    expect(coverage.targets).toEqual(['ref_history']);
    expect(coverage.primaryTarget).toBe('ref_history');
  });

  it('allows visual fallback after deep native inspection exhausts semantic discovery', async () => {
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
      visualFallbackAllowed: true,
      data: {
        mode: 'interactive',
        elements: [expect.objectContaining({ ref: 'ref_1', n: 'Submit' })],
      },
    });
  });

  it('keeps actionable targets beyond the ordinary prefix in interactive_deep mode', async () => {
    const snapshot: BrowserSessionSnapshot = {
      tabId: 7,
      generation: 1,
      root: { tabId: 7 },
      children: new Map(),
    };
    const passiveNodes = Array.from({ length: 510 }, (_, index) => ({
      nodeId: `text_${String(index)}`,
      parentId: 'root',
      ignored: false,
      role: { value: 'StaticText' },
      name: { value: `Question context ${String(index)}` },
    }));
    const transport = debuggerTransport((_session, method) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: 'root',
              backendDOMNodeId: 1,
              ignored: false,
              role: { value: 'RootWebArea' },
              name: { value: 'Long form' },
              childIds: [...passiveNodes.map(({ nodeId }) => nodeId), 'late_button'],
            },
            ...passiveNodes,
            {
              nodeId: 'late_button',
              parentId: 'root',
              backendDOMNodeId: 11,
              ignored: false,
              role: { value: 'button' },
              name: { value: 'Submit late form' },
            },
          ],
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') {
        return buttonDomSnapshot('frame-main', 11, false, [10, 2_000, 100, 30]);
      }
      if (method === 'Page.getFrameTree') return mainFrameTree();
      if (method === 'Page.getLayoutMetrics') {
        return {
          visualViewport: {
            pageX: 0,
            pageY: 0,
            clientWidth: 1_000,
            clientHeight: 800,
          },
        };
      }
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
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: CONTENT,
      refs: new ElementRefStore({ create: () => 'ref_late' }),
    });

    const ordinary = await observer.inspect(7, 'interactive', new AbortController().signal);
    const deep = await observer.inspect(7, 'interactive_deep', new AbortController().signal);

    expect(ordinary.data.elements).toEqual(
      expect.arrayContaining([expect.objectContaining({ n: 'Submit late form', ref: 'ref_late' })]),
    );
    expect(JSON.stringify(ordinary.data)).not.toContain('Question context 509');
    expect(deep.data.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ n: 'Question context 509' }),
        expect.objectContaining({ n: 'Submit late form', ref: 'ref_late' }),
      ]),
    );
  });

  it('prioritizes an in-viewport actionable target beyond a long passive prefix', async () => {
    const snapshot: BrowserSessionSnapshot = {
      tabId: 7,
      generation: 1,
      root: { tabId: 7 },
      children: new Map(),
    };
    const passiveNodes = Array.from({ length: 260 }, (_, index) => ({
      nodeId: `text_${String(index)}`,
      parentId: 'root',
      ignored: false,
      role: { value: 'StaticText' },
      name: { value: `Archived context ${String(index)}` },
    }));
    const transport = debuggerTransport((_session, method) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: 'root',
              backendDOMNodeId: 1,
              ignored: false,
              role: { value: 'RootWebArea' },
              name: { value: 'Long form' },
              childIds: [...passiveNodes.map(({ nodeId }) => nodeId), 'visible_button'],
            },
            ...passiveNodes,
            {
              nodeId: 'visible_button',
              parentId: 'root',
              backendDOMNodeId: 11,
              ignored: false,
              role: { value: 'button' },
              name: { value: 'Continue visible form' },
            },
          ],
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') return buttonDomSnapshot();
      if (method === 'Page.getFrameTree') return mainFrameTree();
      if (method === 'Page.getLayoutMetrics') {
        return {
          visualViewport: {
            pageX: 0,
            pageY: 0,
            clientWidth: 1_000,
            clientHeight: 800,
          },
        };
      }
      if (method === 'Page.getNavigationHistory') {
        return { currentIndex: 0, entries: [] };
      }
      return {};
    });
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: CONTENT,
      refs: new ElementRefStore({ create: () => 'ref_visible' }),
    });

    const ordinary = await observer.inspect(7, 'interactive', new AbortController().signal);

    expect(ordinary.data.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          n: 'Continue visible form',
          ref: 'ref_visible',
        }),
      ]),
    );
    expect(JSON.stringify(ordinary.data)).not.toContain('bounds');
    expect(JSON.stringify(ordinary.data)).not.toContain('inViewport');
  });

  it('retains a scrollable traversal target when many in-viewport controls exhaust the target budget', async () => {
    const snapshot: BrowserSessionSnapshot = {
      tabId: 7,
      generation: 1,
      root: { tabId: 7 },
      children: new Map(),
    };
    const buttonCount = 241;
    const buttonBackendIds = Array.from({ length: buttonCount }, (_, index) => 1_000 + index);
    const scrollBackendId = 9_999;
    const strings = [
      'https://top.test/',
      'Crowded controls',
      '',
      'frame-main',
      '#document',
      'BUTTON',
      'DIV',
      'pointer',
      'block',
      'visible',
      'auto',
      'scroll',
    ];
    const transport = debuggerTransport((_session, method) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: 'root',
              backendDOMNodeId: 1,
              ignored: false,
              role: { value: 'RootWebArea' },
              name: { value: 'Crowded controls' },
              childIds: buttonBackendIds.map((id) => `button_${String(id)}`),
            },
            ...buttonBackendIds.map((backendDOMNodeId, index) => ({
              nodeId: `button_${String(backendDOMNodeId)}`,
              parentId: 'root',
              backendDOMNodeId,
              ignored: false,
              role: { value: 'button' },
              name: { value: `Action ${String(index)}` },
            })),
          ],
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') {
        const elementCount = buttonCount + 1;
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
                parentIndex: [-1, ...Array.from({ length: elementCount }, () => 0)],
                nodeType: [9, ...Array.from({ length: elementCount }, () => 1)],
                nodeName: [4, ...Array.from({ length: buttonCount }, () => 5), 6],
                nodeValue: Array.from({ length: elementCount + 1 }, () => 2),
                backendNodeId: [1, ...buttonBackendIds, scrollBackendId],
                attributes: Array.from({ length: elementCount + 1 }, () => []),
                isClickable: {
                  index: Array.from({ length: buttonCount }, (_, index) => index + 1),
                },
                inputChecked: { index: [] },
              },
              layout: {
                nodeIndex: Array.from({ length: elementCount }, (_, index) => index + 1),
                styles: [
                  ...Array.from({ length: buttonCount }, () => [7, 8, 9, 7, 10, 10]),
                  [7, 8, 9, 7, 10, 11],
                ],
                bounds: Array.from({ length: elementCount }, () => [10, 20, 100, 30]),
                clientRects: [
                  ...Array.from({ length: buttonCount }, () => [10, 20, 100, 30]),
                  [10, 20, 100, 300],
                ],
                scrollRects: [
                  ...Array.from({ length: buttonCount }, () => [10, 20, 100, 30]),
                  [10, 20, 100, 1_000],
                ],
                text: Array.from({ length: elementCount }, () => 2),
                stackingContexts: { index: [] },
              },
              textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
            },
          ],
        };
      }
      if (method === 'Page.getFrameTree') return mainFrameTree();
      if (method === 'Page.getLayoutMetrics') {
        return {
          visualViewport: {
            pageX: 0,
            pageY: 0,
            clientWidth: 1_000,
            clientHeight: 800,
          },
        };
      }
      if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [] };
      return {};
    });
    let refSequence = 0;
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: CONTENT,
      refs: new ElementRefStore({
        create: () => `ref_${String(++refSequence)}`,
      }),
    });

    const result = await observer.inspect(7, 'interactive', new AbortController().signal);

    expect(result.data.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          r: 'region',
          a: ['scroll'],
          ref: expect.any(String),
        }),
      ]),
    );
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
    let backendNodeId = 11;
    let loaderId = 'loader-main';
    const transport = debuggerTransport((_session, method) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: 'root',
              backendDOMNodeId: 1,
              ignored: false,
              role: { value: 'RootWebArea' },
              name: { value: 'Question' },
              childIds: ['context_1', 'context_2', 'context_3', 'choice'],
            },
            ...Array.from({ length: 3 }, (_, index) => ({
              nodeId: `context_${String(index + 1)}`,
              parentId: 'root',
              ignored: false,
              role: { value: 'StaticText' },
              name: { value: `Question context ${String(index + 1)}` },
            })),
            {
              nodeId: 'choice',
              parentId: 'root',
              backendDOMNodeId: backendNodeId,
              ignored: false,
              role: { value: 'checkbox' },
              name: { value: name },
            },
          ],
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') {
        return buttonDomSnapshot('frame-main', backendNodeId, checked);
      }
      if (method === 'Page.getFrameTree') return mainFrameTree(loaderId);
      if (method === 'Page.getLayoutMetrics') {
        return {
          visualViewport: {
            pageX: 0,
            pageY: 0,
            clientWidth: 1_000,
            clientHeight: 800,
          },
        };
      }
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
    let refId = 0;
    const refs = new ElementRefStore({
      create: () => `ref_${String(++refId)}`,
    });
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: CONTENT,
      refs,
    });

    const first = await observer.inspect(7, 'interactive', new AbortController().signal);
    const firstSnapshot = first.data.snapshot;
    expect(firstSnapshot).toEqual(expect.any(String));
    expect(first.data.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          r: 'checkbox',
          n: 'Choice A',
          s: ['checked=false'],
          a: ['set_checked'],
          ref: 'ref_1',
        }),
      ]),
    );

    checked = true;
    const second = await observer.inspect(7, 'interactive', new AbortController().signal, {
      since: firstSnapshot as string,
    });

    expect(second.data).toEqual({
      mode: 'interactive',
      snapshot: expect.any(String),
      base: firstSnapshot,
      upsert: [
        {
          k: 'ref:ref_1',
          e: {
            d: 1,
            r: 'checkbox',
            n: 'Choice A',
            s: ['checked'],
            a: ['set_checked'],
            ref: 'ref_1',
          },
        },
      ],
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
      upsert: [
        expect.objectContaining({
          k: 'ref:ref_1',
          e: expect.objectContaining({ s: ['checked=false'] }),
        }),
      ],
    });

    name = 'Choice B';
    const fifth = await observer.inspect(7, 'interactive', new AbortController().signal, {
      since: fourth.data.snapshot as string,
    });
    expect(fifth.data).toMatchObject({
      base: fourth.data.snapshot,
      upsert: [
        expect.objectContaining({
          k: 'ref:ref_1',
          e: expect.objectContaining({ n: 'Choice B', ref: 'ref_1' }),
        }),
      ],
    });

    backendNodeId = 12;
    const replaced = await observer.inspect(7, 'interactive', new AbortController().signal, {
      since: fifth.data.snapshot as string,
    });
    expect(replaced.data).toMatchObject({
      base: fifth.data.snapshot,
      unchanged: true,
    });
    expect(refs.resolve('ref_1', 7)).toMatchObject({ backendNodeId: 12 });

    loaderId = 'loader-next';
    const navigated = await observer.inspect(7, 'interactive', new AbortController().signal, {
      since: replaced.data.snapshot as string,
    });
    expect(navigated.data).toMatchObject({
      snapshot: expect.any(String),
      elements: expect.any(Array),
    });
    expect(navigated.data).not.toHaveProperty('base');
    expect(navigated.data).not.toHaveProperty('upsert');
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

  it('returns an unchanged delta for duplicate passive labels with stable native identities', async () => {
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
              nodeId: 'root',
              ignored: false,
              role: { value: 'RootWebArea' },
              name: { value: 'Duplicates' },
              childIds: ['parent_a', 'parent_b'],
            },
            {
              nodeId: 'parent_a',
              parentId: 'root',
              ignored: false,
              role: { value: 'none' },
              name: { value: '' },
              childIds: ['text_a'],
            },
            {
              nodeId: 'parent_b',
              parentId: 'root',
              ignored: false,
              role: { value: 'none' },
              name: { value: '' },
              childIds: ['text_b'],
            },
            {
              nodeId: 'text_a',
              parentId: 'parent_a',
              ignored: false,
              role: { value: 'StaticText' },
              name: { value: 'Repeated label' },
            },
            {
              nodeId: 'text_b',
              parentId: 'parent_b',
              ignored: false,
              role: { value: 'StaticText' },
              name: { value: 'Repeated label' },
            },
          ],
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') return buttonDomSnapshot();
      if (method === 'Page.getFrameTree') return mainFrameTree();
      if (method === 'Page.getLayoutMetrics') return {};
      if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [] };
      return {};
    });
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: CONTENT,
      refs: new ElementRefStore({ create: () => 'unused' }),
    });

    const first = await observer.inspect(7, 'interactive', new AbortController().signal);
    const second = await observer.inspect(7, 'interactive', new AbortController().signal, {
      since: first.data.snapshot as string,
    });

    expect(second.data).toEqual({
      mode: 'interactive',
      snapshot: expect.any(String),
      base: first.data.snapshot,
      unchanged: true,
    });
    expect(JSON.stringify(second.data)).not.toContain('text_a');
    expect(JSON.stringify(second.data)).not.toContain('text_b');
  });

  it('returns a keyed delta above the old change ratio when it is smaller than a full tree', async () => {
    const snapshot: BrowserSessionSnapshot = {
      tabId: 7,
      generation: 1,
      root: { tabId: 7 },
      children: new Map(),
    };
    let changed = false;
    const transport = debuggerTransport((_session, method) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: Array.from({ length: 20 }, (_, index) => ({
            nodeId: `text_${String(index)}`,
            ignored: false,
            role: { value: 'StaticText' },
            name: {
              value: changed && index < 8 ? `Changed ${String(index)}` : `Stable ${String(index)}`,
            },
          })),
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') return buttonDomSnapshot();
      if (method === 'Page.getFrameTree') return mainFrameTree();
      if (method === 'Page.getLayoutMetrics') return {};
      if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [] };
      return {};
    });
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: CONTENT,
      refs: new ElementRefStore({ create: () => 'unused' }),
    });

    const first = await observer.inspect(7, 'interactive', new AbortController().signal);
    changed = true;
    const second = await observer.inspect(7, 'interactive', new AbortController().signal, {
      since: first.data.snapshot as string,
    });

    expect(second.data).toMatchObject({
      base: first.data.snapshot,
      upsert: expect.arrayContaining([
        expect.objectContaining({
          e: expect.objectContaining({ n: 'Changed 0' }),
        }),
        expect.objectContaining({
          e: expect.objectContaining({ n: 'Changed 7' }),
        }),
      ]),
    });
    expect(second.data).not.toHaveProperty('elements');
    expect(JSON.stringify(second.data)).not.toContain('"identity"');
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
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: CONTENT,
      refs: new ElementRefStore({ create: () => 'unused' }),
    });

    const result = await observer.inspect(7, 'interactive', new AbortController().signal);

    expect(result.data).toMatchObject({ truncated: true });
    expect(result.data.elements).toHaveLength(240);
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
    const persistScreenshot = vi.fn(async (blob: Blob, source: string) => {
      calls.push(`persist:${blob.type}:${String(blob.size)}`);
      expect(source).toBe('visual_fallback');
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
    expect(persistScreenshot).toHaveBeenCalledWith(preparedBlob, 'visual_fallback');
    expect(persistScreenshot).toHaveBeenCalledOnce();
    expect(canvases).toEqual([{ width: 1440, height: 918 }]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('captures a task-owned viewport asset without changing the model screenshot policy', async () => {
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
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })),
    );
    const persistScreenshot = vi.fn(async () => ({ id: 'attachment_capture' }));
    const observer = new PageObserver({
      sessions: sessions(snapshot),
      transport,
      content: CONTENT,
      refs: new ElementRefStore({ create: () => 'unused' }),
      persistScreenshot,
    });

    const result = await observer.capture(7, new AbortController().signal);

    expect(result).toMatchObject({
      data: { mode: 'screenshot', attachmentId: 'attachment_capture' },
      attachmentIds: ['attachment_capture'],
    });
    expect(persistScreenshot).toHaveBeenCalledWith(expect.any(Blob), 'viewport_capture');
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
      throw Object.assign(new Error('page bridge unavailable'), {
        code: 'PAGE_UNAVAILABLE',
      });
    });
    const close = vi.fn();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 1, height: 1, close })),
    );
    const persistScreenshot = vi.fn(async () => ({
      id: 'attachment_screenshot',
    }));
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
          entries: [
            {
              id: 1,
              url: 'https://top.test/',
              title: 'Top',
              transitionType: 'typed',
            },
          ],
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
