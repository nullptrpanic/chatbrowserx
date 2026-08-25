import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseBrowserToolCall } from '../../../src/agent/tools/browser-tool-schema';
import {
  BrowserActionExecutor,
  inspectEditorTarget,
  pasteImageIntoEditor,
  type BrowserActionExecutorDependencies,
} from '../../../src/browser/actions/browser-action-executor';
import type {
  DebuggerSession,
  DebuggerTransport,
} from '../../../src/browser/debugger/debugger-transport';
import type { BrowserSessionSnapshot } from '../../../src/browser/debugger/target-session-registry';
import {
  ElementRefStore,
  type ObservedElementTarget,
} from '../../../src/browser/observation/element-ref-store';

const SNAPSHOT: BrowserSessionSnapshot = {
  tabId: 7,
  generation: 2,
  root: { tabId: 7 },
  children: new Map(),
};

function checkedTargetDomSnapshot(checked = true, backendNodeId = 42) {
  return {
    strings: ['', 'frame-main', '#document', 'INPUT', 'pointer', 'block', 'visible', 'auto'],
    documents: [
      {
        documentURL: 0,
        title: 0,
        baseURL: 0,
        contentLanguage: 0,
        encodingName: 0,
        publicId: 0,
        systemId: 0,
        frameId: 1,
        nodes: {
          parentIndex: [-1, 0],
          nodeType: [9, 1],
          nodeName: [2, 3],
          nodeValue: [0, 0],
          backendNodeId: [1, backendNodeId],
          attributes: [[], []],
          isClickable: { index: [1] },
          inputChecked: { index: checked ? [1] : [] },
        },
        layout: {
          nodeIndex: [1],
          styles: [[4, 5, 6, 7]],
          bounds: [[10, 20, 100, 30]],
          text: [0],
          stackingContexts: { index: [] },
        },
        textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
      },
    ],
  };
}

function customOptionDomSnapshot(selected: boolean, backendNodeId: number) {
  return {
    strings: [
      '',
      'frame-main',
      '#document',
      'DIV',
      'class',
      'choice-option__x',
      'choice-option__x checked__x',
      'pointer',
      'block',
      'visible',
      'auto',
    ],
    documents: [
      {
        documentURL: 0,
        title: 0,
        baseURL: 0,
        contentLanguage: 0,
        encodingName: 0,
        publicId: 0,
        systemId: 0,
        frameId: 1,
        nodes: {
          parentIndex: [-1, 0],
          nodeType: [9, 1],
          nodeName: [2, 3],
          nodeValue: [0, 0],
          backendNodeId: [1, backendNodeId],
          attributes: [[], [4, selected ? 6 : 5]],
          isClickable: { index: [1] },
        },
        layout: {
          nodeIndex: [1],
          styles: [[7, 8, 9, 10]],
          bounds: [[10, 20, 100, 30]],
          text: [0],
          stackingContexts: { index: [] },
        },
        textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
      },
    ],
  };
}

function choiceDomSnapshot(selectedBackendNodeId: number) {
  return {
    strings: ['', 'frame-main', '#document', 'INPUT', 'pointer', 'block', 'visible', 'auto'],
    documents: [
      {
        documentURL: 0,
        title: 0,
        baseURL: 0,
        contentLanguage: 0,
        encodingName: 0,
        publicId: 0,
        systemId: 0,
        frameId: 1,
        nodes: {
          parentIndex: [-1, 0, 0],
          nodeType: [9, 1, 1],
          nodeName: [2, 3, 3],
          nodeValue: [0, 0, 0],
          backendNodeId: [1, 42, 43],
          attributes: [[], [], []],
          isClickable: { index: [1, 2] },
          inputChecked: { index: selectedBackendNodeId === 42 ? [1] : [2] },
        },
        layout: {
          nodeIndex: [1, 2],
          styles: [
            [4, 5, 6, 7],
            [4, 5, 6, 7],
          ],
          bounds: [
            [10, 20, 100, 30],
            [10, 60, 100, 30],
          ],
          text: [0, 0],
          stackingContexts: { index: [] },
        },
        textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
      },
    ],
  };
}

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
    readonly pointerPending?: boolean;
    readonly pointerRejects?: boolean;
    readonly page?: BrowserActionExecutorDependencies['page'];
    readonly attachments?: BrowserActionExecutorDependencies['attachments'];
    readonly targets?: readonly ObservedElementTarget[];
    readonly onEvent?: DebuggerTransport['onEvent'];
    readonly responder?: (
      session: DebuggerSession,
      method: string,
      params?: Readonly<Record<string, unknown>>,
    ) => unknown;
  } = {},
) {
  const order: string[] = [];
  let insertedText = '';
  const send = vi.fn(async (session, method, params) => {
    order.push(`cdp:${method}`);
    if (method === 'Input.insertText' && typeof params?.text === 'string') {
      insertedText = params.text;
    }
    if (
      method === 'Input.dispatchKeyEvent' &&
      params?.type === 'keyDown' &&
      params.key === 'Enter'
    ) {
      insertedText = '';
    }
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
      if (
        typeof params?.functionDeclaration === 'string' &&
        params.functionDeclaration.includes('__chatbrowserxEditorTargetInfo')
      ) {
        return {
          result: {
            type: 'object',
            value: { editor: false, value: insertedText },
          },
        };
      }
      if (
        typeof params?.functionDeclaration === 'string' &&
        params.functionDeclaration.includes('HTMLSelectElement')
      ) {
        const argument = Array.isArray(params.arguments)
          ? (params.arguments[0] as { readonly value?: unknown } | undefined)
          : undefined;
        return {
          result: {
            type: 'object',
            value: { ok: true, value: argument?.value },
          },
        };
      }
      return { result: { type: 'object', value: { dispatched: true } } };
    }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'object_1' } };
    return {};
  }) as unknown as DebuggerTransport['send'];
  const transport: DebuggerTransport = {
    attach: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    send,
    onEvent: options.onEvent ?? (() => () => undefined),
    onDetach: () => () => undefined,
  };
  let refId = 0;
  const refs = new ElementRefStore({ create: () => `ref_${String(++refId)}` });
  refs.replaceSnapshot(
    7,
    options.targets ?? [
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
    ],
  );
  const pointer = {
    show: vi.fn(async () => {
      order.push('pointer');
      if (options.pointerPending) await new Promise<void>(() => undefined);
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
    ...(options.attachments ? { attachments: options.attachments } : {}),
  });
  return {
    executor,
    transport,
    send: vi.mocked(send),
    pointer,
    refs,
    sessions,
    order,
  };
}

afterEach(() => vi.useRealTimers());

describe('pasteImageIntoEditor', () => {
  it('verifies a newly inserted editor image even when the global media count is unchanged', async () => {
    const originalDataTransfer = window.DataTransfer;
    const originalClipboardEvent = window.ClipboardEvent;
    class TestDataTransfer {
      readonly files: File[] = [];
      readonly items = {
        add: (file: File) => {
          this.files.push(file);
        },
      };
    }
    class TestClipboardEvent extends Event {
      readonly clipboardData: TestDataTransfer;

      constructor(type: string, init: EventInit & { clipboardData: TestDataTransfer }) {
        super(type, init);
        this.clipboardData = init.clipboardData;
      }
    }
    Object.defineProperty(window, 'DataTransfer', {
      configurable: true,
      value: TestDataTransfer,
    });
    Object.defineProperty(window, 'ClipboardEvent', {
      configurable: true,
      value: TestClipboardEvent,
    });

    try {
      document.body.innerHTML = `
        <main>
          <img id="old-image" alt="old">
          <section id="composer"><div id="editor" contenteditable="true"></div></section>
        </main>
      `;
      const editor = document.querySelector<HTMLElement>('#editor');
      if (!editor) throw new Error('Test editor was not created.');
      editor.getBoundingClientRect = () =>
        ({
          x: 100,
          y: 500,
          width: 500,
          height: 40,
          top: 500,
          right: 600,
          bottom: 540,
          left: 100,
          toJSON: () => ({}),
        }) as DOMRect;
      editor.addEventListener('paste', (event) => {
        event.preventDefault();
        document.querySelector('#old-image')?.remove();
        const image = document.createElement('img');
        image.src = 'data:image/png;base64,aW1hZ2U=';
        image.getBoundingClientRect = () =>
          ({
            x: 100,
            y: 460,
            width: 80,
            height: 40,
            top: 460,
            right: 180,
            bottom: 500,
            left: 100,
            toJSON: () => ({}),
          }) as DOMRect;
        editor.append(image);
      });

      await expect(
        pasteImageIntoEditor.call(editor, 'aW1hZ2U=', 'image/png', 'capture.png', 0),
      ).resolves.toMatchObject({
        dispatched: true,
        handled: true,
        verified: true,
        previewCount: 1,
      });
      expect(document.querySelectorAll('img')).toHaveLength(1);
    } finally {
      Object.defineProperty(window, 'DataTransfer', {
        configurable: true,
        value: originalDataTransfer,
      });
      Object.defineProperty(window, 'ClipboardEvent', {
        configurable: true,
        value: originalClipboardEvent,
      });
      document.body.innerHTML = '';
    }
  });

  it('verifies a persistent non-media attachment preview created by the editor', async () => {
    const originalDataTransfer = window.DataTransfer;
    const originalClipboardEvent = window.ClipboardEvent;
    class TestDataTransfer {
      readonly files: File[] = [];
      readonly items = {
        add: (file: File) => {
          this.files.push(file);
        },
      };
    }
    class TestClipboardEvent extends Event {
      readonly clipboardData: TestDataTransfer;

      constructor(type: string, init: EventInit & { clipboardData: TestDataTransfer }) {
        super(type, init);
        this.clipboardData = init.clipboardData;
      }
    }
    Object.defineProperty(window, 'DataTransfer', {
      configurable: true,
      value: TestDataTransfer,
    });
    Object.defineProperty(window, 'ClipboardEvent', {
      configurable: true,
      value: TestClipboardEvent,
    });

    try {
      document.body.innerHTML = `
        <main>
          <section id="composer"><div id="editor" contenteditable="true">message</div></section>
        </main>
      `;
      const editor = document.querySelector<HTMLElement>('#editor');
      const composer = document.querySelector<HTMLElement>('#composer');
      if (!editor || !composer) throw new Error('Test composer was not created.');
      editor.addEventListener('paste', (event) => {
        event.preventDefault();
        const preview = document.createElement('div');
        preview.className = 'attachment-preview';
        preview.dataset.state = 'uploading';
        composer.append(preview);
      });

      await expect(
        pasteImageIntoEditor.call(editor, 'aW1hZ2U=', 'image/png', 'capture.png', 0),
      ).resolves.toMatchObject({
        dispatched: true,
        handled: true,
        verified: true,
        previewCount: 1,
      });
    } finally {
      Object.defineProperty(window, 'DataTransfer', {
        configurable: true,
        value: originalDataTransfer,
      });
      Object.defineProperty(window, 'ClipboardEvent', {
        configurable: true,
        value: originalClipboardEvent,
      });
      document.body.innerHTML = '';
    }
  });

  it('verifies a reused visual preview whose image state changes after paste', async () => {
    const originalDataTransfer = window.DataTransfer;
    const originalClipboardEvent = window.ClipboardEvent;
    class TestDataTransfer {
      readonly files: File[] = [];
      readonly items = {
        add: (file: File) => {
          this.files.push(file);
        },
      };
    }
    class TestClipboardEvent extends Event {
      readonly clipboardData: TestDataTransfer;

      constructor(type: string, init: EventInit & { clipboardData: TestDataTransfer }) {
        super(type, init);
        this.clipboardData = init.clipboardData;
      }
    }
    Object.defineProperty(window, 'DataTransfer', {
      configurable: true,
      value: TestDataTransfer,
    });
    Object.defineProperty(window, 'ClipboardEvent', {
      configurable: true,
      value: TestClipboardEvent,
    });

    try {
      document.body.innerHTML = `
        <main>
          <section id="composer">
            <div id="editor" contenteditable="true"></div>
            <div id="preview" role="img"></div>
          </section>
        </main>
      `;
      const editor = document.querySelector<HTMLElement>('#editor');
      const preview = document.querySelector<HTMLElement>('#preview');
      if (!editor || !preview) throw new Error('Test preview was not created.');
      editor.addEventListener('paste', (event) => {
        event.preventDefault();
        preview.style.backgroundImage = 'url("data:image/png;base64,aW1hZ2U=")';
      });

      await expect(
        pasteImageIntoEditor.call(editor, 'aW1hZ2U=', 'image/png', 'capture.png', 0),
      ).resolves.toMatchObject({
        dispatched: true,
        handled: true,
        verified: true,
        previewCount: 1,
      });
    } finally {
      Object.defineProperty(window, 'DataTransfer', {
        configurable: true,
        value: originalDataTransfer,
      });
      Object.defineProperty(window, 'ClipboardEvent', {
        configurable: true,
        value: originalClipboardEvent,
      });
      document.body.innerHTML = '';
    }
  });

  it('does not divert an editor paste through a nearby hidden file input', async () => {
    const originalDataTransfer = window.DataTransfer;
    const originalClipboardEvent = window.ClipboardEvent;
    class TestDataTransfer {
      readonly files: File[] = [];
      readonly items = {
        add: (file: File) => {
          this.files.push(file);
        },
      };
    }
    class TestClipboardEvent extends Event {
      readonly clipboardData: TestDataTransfer;

      constructor(type: string, init: EventInit & { clipboardData: TestDataTransfer }) {
        super(type, init);
        this.clipboardData = init.clipboardData;
      }
    }
    Object.defineProperty(window, 'DataTransfer', {
      configurable: true,
      value: TestDataTransfer,
    });
    Object.defineProperty(window, 'ClipboardEvent', {
      configurable: true,
      value: TestClipboardEvent,
    });

    try {
      document.body.innerHTML = `
        <main>
          <section id="composer">
            <div id="editor" contenteditable="true">message</div>
            <input id="image-input" type="file" accept="image/*">
          </section>
        </main>
      `;
      const editor = document.querySelector<HTMLElement>('#editor');
      const fileInput = document.querySelector<HTMLInputElement>('#image-input');
      const composer = document.querySelector<HTMLElement>('#composer');
      if (!editor || !fileInput || !composer) throw new Error('Test composer was not created.');
      Object.defineProperty(fileInput, 'files', {
        configurable: true,
        writable: true,
        value: [],
      });
      let fileInputChanges = 0;
      fileInput.addEventListener('change', () => {
        fileInputChanges += 1;
      });
      editor.addEventListener('paste', (event) => {
        event.preventDefault();
        const preview = document.createElement('img');
        preview.alt = 'pending image';
        composer.append(preview);
      });

      await expect(
        pasteImageIntoEditor.call(editor, 'aW1hZ2U=', 'image/png', 'capture.png', 0),
      ).resolves.toMatchObject({
        dispatched: true,
        strategy: 'clipboard_event',
        fileCount: 1,
        handled: true,
        verified: true,
        previewCount: 1,
      });
      expect(fileInputChanges).toBe(0);
    } finally {
      Object.defineProperty(window, 'DataTransfer', {
        configurable: true,
        value: originalDataTransfer,
      });
      Object.defineProperty(window, 'ClipboardEvent', {
        configurable: true,
        value: originalClipboardEvent,
      });
      document.body.innerHTML = '';
    }
  });

  it('does not treat a retained file-input selection as attachment preview evidence', async () => {
    const originalDataTransfer = window.DataTransfer;
    const originalClipboardEvent = window.ClipboardEvent;
    class TestDataTransfer {
      readonly files: File[] = [];
      readonly items = {
        add: (file: File) => {
          this.files.push(file);
        },
      };
    }
    class TestClipboardEvent extends Event {
      readonly clipboardData: TestDataTransfer;

      constructor(type: string, init: EventInit & { clipboardData: TestDataTransfer }) {
        super(type, init);
        this.clipboardData = init.clipboardData;
      }
    }
    Object.defineProperty(window, 'DataTransfer', {
      configurable: true,
      value: TestDataTransfer,
    });
    Object.defineProperty(window, 'ClipboardEvent', {
      configurable: true,
      value: TestClipboardEvent,
    });

    try {
      document.body.innerHTML = `
        <main>
          <section id="composer">
            <div id="editor" contenteditable="true">message</div>
            <input id="image-input" type="file" accept="image/*">
          </section>
        </main>
      `;
      const fileInput = document.querySelector<HTMLInputElement>('#image-input');
      if (!fileInput) throw new Error('Test file input was not created.');
      Object.defineProperty(fileInput, 'files', {
        configurable: true,
        writable: true,
        value: [],
      });

      await expect(
        pasteImageIntoEditor.call(fileInput, 'aW1hZ2U=', 'image/png', 'capture.png', 0),
      ).resolves.toMatchObject({
        dispatched: true,
        strategy: 'file_input',
        fileCount: 1,
        handled: true,
        verified: false,
        previewCount: 0,
      });
    } finally {
      Object.defineProperty(window, 'DataTransfer', {
        configurable: true,
        value: originalDataTransfer,
      });
      Object.defineProperty(window, 'ClipboardEvent', {
        configurable: true,
        value: originalClipboardEvent,
      });
      document.body.innerHTML = '';
    }
  });
});

describe('BrowserActionExecutor', () => {
  it('waits for a bounded DOM quiet period before post-action observation', async () => {
    vi.useFakeTimers();
    const { executor, sessions } = harness();

    const settled = executor.settle(7, new AbortController().signal, 1_000);
    await vi.advanceTimersByTimeAsync(500);

    await expect(settled).resolves.toBeUndefined();
    expect(sessions.ensure).toHaveBeenCalledWith(7, expect.any(AbortSignal));
  });

  it('pastes a task-owned image into a semantic editor ref without the system clipboard', async () => {
    const get = vi.fn(async () => ({
      id: 'attachment_capture',
      blob: new Blob(['image-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      byteSize: 11,
      width: 640,
      height: 480,
      source: 'viewport_capture' as const,
      createdAt: 1,
      fileName: 'capture.png',
    }));
    const { executor, send } = harness({
      attachments: { get },
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'textbox',
          name: 'Message',
          state: ['editable'],
          actions: ['type'],
          frame: 'main',
        },
      ],
      responder: (_session, method, params) => {
        if (
          method === 'Runtime.callFunctionOn' &&
          typeof params?.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxPasteImage')
        ) {
          return {
            result: {
              type: 'object',
              value: {
                dispatched: true,
                strategy: 'clipboard_event',
                fileCount: 1,
                handled: true,
                verified: true,
                mutations: 2,
              },
            },
          };
        }
        return undefined;
      },
    });

    await expect(
      executor.execute(
        call('browser_paste_image', {
          tabId: 7,
          ref: 'ref_1',
          assetId: 'attachment_capture',
        }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      data: {
        action: 'paste_image',
        dispatched: true,
        strategy: 'clipboard_event',
        fileCount: 1,
        handled: true,
        verified: true,
      },
      observation: { targetPresent: true },
    });

    expect(get).toHaveBeenCalledWith('attachment_capture');
    expect(send).toHaveBeenCalledWith(
      SNAPSHOT.root,
      'Runtime.callFunctionOn',
      expect.objectContaining({
        arguments: [
          { value: 'aW1hZ2UtYnl0ZXM=' },
          { value: 'image/png' },
          { value: 'capture.png' },
        ],
        userGesture: true,
      }),
    );
  });

  it('does not report a handled image paste as successful without preview evidence', async () => {
    const { executor } = harness({
      attachments: {
        get: vi.fn(async () => ({
          id: 'attachment_capture',
          blob: new Blob(['image-bytes'], { type: 'image/png' }),
          mimeType: 'image/png',
          byteSize: 11,
          width: 640,
          height: 480,
          source: 'viewport_capture' as const,
          createdAt: 1,
        })),
      },
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'textbox',
          name: 'Message',
          state: ['editable'],
          actions: ['type'],
          frame: 'main',
        },
      ],
      responder: (_session, method, params) =>
        method === 'Runtime.callFunctionOn' &&
        typeof params?.functionDeclaration === 'string' &&
        params.functionDeclaration.includes('__chatbrowserxPasteImage')
          ? {
              result: {
                type: 'object',
                value: {
                  dispatched: true,
                  strategy: 'clipboard_event',
                  fileCount: 1,
                  handled: true,
                  verified: false,
                  mutations: 0,
                },
              },
            }
          : undefined,
    });

    await expect(
      executor.execute(
        call('browser_paste_image', {
          tabId: 7,
          ref: 'ref_1',
          assetId: 'attachment_capture',
        }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_VERIFICATION_FAILED' });
  });

  it('falls back to a native system-clipboard paste and verifies a real editor change', async () => {
    let evidenceReads = 0;
    const { executor, send } = harness({
      os: 'mac',
      attachments: {
        get: vi.fn(async () => ({
          id: 'attachment_capture',
          blob: new Blob(['image-bytes'], { type: 'image/png' }),
          mimeType: 'image/png',
          byteSize: 11,
          width: 640,
          height: 480,
          source: 'viewport_capture' as const,
          createdAt: 1,
          fileName: 'capture.png',
        })),
      },
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'textbox',
          name: 'Message',
          state: ['editable'],
          actions: ['type'],
          frame: 'main',
        },
      ],
      responder: (_session, method, params) => {
        if (
          method !== 'Runtime.callFunctionOn' ||
          typeof params?.functionDeclaration !== 'string'
        ) {
          return undefined;
        }
        if (params.functionDeclaration.includes('__chatbrowserxPasteImage')) {
          return {
            result: {
              type: 'object',
              value: {
                dispatched: true,
                strategy: 'clipboard_event',
                fileCount: 1,
                handled: true,
                verified: false,
                previewCount: 0,
              },
            },
          };
        }
        if (params.functionDeclaration.includes('__chatbrowserxImagePasteState')) {
          evidenceReads += 1;
          return {
            result: {
              type: 'object',
              value:
                evidenceReads === 1
                  ? {
                      connected: true,
                      pendingUpload: false,
                      elementCount: 3,
                      mediaCount: 0,
                      previewCount: 0,
                      targetMarkupHash: 'before-markup',
                      targetTextHash: 'same-text',
                      previewHash: 'before-preview',
                    }
                  : {
                      connected: true,
                      pendingUpload: false,
                      elementCount: 4,
                      mediaCount: 1,
                      previewCount: 1,
                      targetMarkupHash: 'after-markup',
                      targetTextHash: 'same-text',
                      previewHash: 'after-preview',
                    },
            },
          };
        }
        if (params.functionDeclaration.includes('__chatbrowserxSystemClipboardImage')) {
          return { result: { type: 'object', value: { staged: true } } };
        }
        return undefined;
      },
    });

    await expect(
      executor.execute(
        call('browser_paste_image', {
          tabId: 7,
          ref: 'ref_1',
          assetId: 'attachment_capture',
        }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      data: {
        action: 'paste_image',
        strategy: 'system_clipboard',
        fileCount: 1,
        handled: true,
        verified: true,
        previewCount: 1,
      },
    });
    expect(send).toHaveBeenCalledWith(
      SNAPSHOT.root,
      'Input.dispatchKeyEvent',
      expect.objectContaining({
        type: 'rawKeyDown',
        key: 'v',
        code: 'KeyV',
        modifiers: 4,
        commands: ['Paste'],
      }),
    );
  });

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
        verification: {
          valueLength: 5,
          valueHash: '4f9f2cab',
          prefixMatch: true,
          suffixMatch: true,
        },
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
        verification: {
          valueLength: replacement.length,
          valueHash: expect.stringMatching(/^[0-9a-f]{8}$/),
          prefixMatch: true,
          suffixMatch: true,
        },
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
          const replace = arguments_[1] as { readonly value?: unknown } | undefined;
          const customEditor = arguments_[2] as { readonly value?: unknown } | undefined;
          const pageFunction = Function(`return (${declaration});`)() as (
            this: Window,
            text: string,
            replace: boolean,
            customEditor: boolean,
          ) => unknown;
          const value = pageFunction.call(
            window,
            typeof text?.value === 'string' ? text.value : '',
            replace?.value === true,
            customEditor?.value === true,
          );
          return {
            result: {
              type: 'object',
              value,
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
    ).rejects.toMatchObject({
      code: 'TYPE_VERIFICATION_FAILED',
      stage: 'readback',
    });
  });

  it('identifies a trusted input dispatch failure as an insert-stage failure', async () => {
    const page = {
      performAction: vi.fn(async () => ({
        action: 'type' as const,
        applied: false,
        dispatched: false,
        reason: 'trusted_input_required' as const,
        target: { x: 60, y: 35 },
        value: '',
        submitted: false,
        url: 'https://example.test/current',
      })),
    };
    const { executor } = harness({
      page,
      responder: (_session, method, params) =>
        method === 'Runtime.callFunctionOn' && params?.objectId === 'page_global'
          ? { result: { type: 'object', value: { dispatched: false } } }
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
    ).rejects.toMatchObject({
      code: 'TYPE_VERIFICATION_FAILED',
      stage: 'insert',
    });
  });

  it('accepts trailing editor placeholders before submitting a trusted replacement', async () => {
    const text = 'message to submit';
    let accessibilityReads = 0;
    const page = {
      performAction: vi.fn(async () => ({
        action: 'type' as const,
        applied: false,
        dispatched: false,
        reason: 'trusted_input_required' as const,
        target: { x: 60, y: 35 },
        value: '',
        submitted: false,
        url: 'https://example.test/current',
      })),
    };
    const { executor, send } = harness({
      page,
      responder: (_session, method, params) => {
        if (method === 'Runtime.evaluate') {
          return params?.returnByValue === true
            ? { result: { type: 'object', value: null } }
            : { result: { type: 'object', objectId: 'page_global' } };
        }
        if (method === 'Runtime.callFunctionOn') {
          return { result: { type: 'object', value: { dispatched: true } } };
        }
        if (method === 'Accessibility.getFullAXTree') {
          accessibilityReads += 1;
          return {
            nodes: [
              {
                nodeId: 'editor',
                ignored: false,
                role: { type: 'role', value: 'generic' },
                value: {
                  type: 'string',
                  value: accessibilityReads === 1 ? `${text} \u200b \u200b \u200b` : '',
                },
                properties: [
                  { name: 'focused', value: { type: 'boolean', value: true } },
                  {
                    name: 'editable',
                    value: { type: 'token', value: 'richtext' },
                  },
                ],
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
          text,
          replace: true,
          submit: true,
        }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      data: {
        action: 'type',
        replaced: true,
        submitted: true,
        submissionVerified: true,
        verified: true,
      },
    });

    expect(accessibilityReads).toBeGreaterThanOrEqual(2);
    expect(
      send.mock.calls.filter(
        ([, method, params]) =>
          method === 'Input.dispatchKeyEvent' &&
          params?.type === 'keyDown' &&
          params.key === 'Enter' &&
          params.windowsVirtualKeyCode === 13 &&
          params.text === '\r',
      ),
    ).toHaveLength(1);
  });

  it('accepts a complete rich-text replacement when the editor normalizes blank lines', async () => {
    const text = 'Summary title\n\n| Chat | Recent content |\n|---|---|\n| Alpha | Updated |';
    const normalizedEditorValue =
      'Summary title\u200b\n| Chat | Recent content |\u200b\n|---|---|\u200b\n| Alpha | Updated |\u200b\n\n';
    let editorInfoReads = 0;
    const { executor } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'textbox',
          name: 'Message',
          state: [],
          actions: ['type'],
          frame: 'main',
        },
      ],
      responder: (_session, method, params) => {
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: 'editor_node' } };
        }
        if (
          method === 'Runtime.callFunctionOn' &&
          params?.objectId === 'editor_node' &&
          typeof params.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxEditorTargetInfo')
        ) {
          editorInfoReads += 1;
          return {
            result: {
              type: 'object',
              value: {
                editor: true,
                custom: true,
                connected: true,
                value: editorInfoReads === 1 ? '' : normalizedEditorValue,
              },
            },
          };
        }
        if (
          method === 'Runtime.callFunctionOn' &&
          params?.objectId === 'editor_node' &&
          typeof params.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxInsertText')
        ) {
          return { result: { type: 'object', value: { dispatched: true } } };
        }
        if (method === 'Accessibility.getFullAXTree') {
          return { nodes: [] };
        }
        return undefined;
      },
    });

    await expect(
      executor.execute(
        call('browser_type', {
          tabId: 7,
          ref: 'ref_1',
          text,
          replace: true,
          submit: false,
        }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      data: {
        action: 'type',
        replaced: true,
        submitted: false,
        verified: true,
      },
    });
  });

  it('rejects a normalized rich-text replacement when a substantive line is missing', async () => {
    vi.useFakeTimers();
    const text = 'Summary title\n\n| Chat | Recent content |\n|---|---|\n| Alpha | Updated |';
    const incompleteEditorValue =
      'Summary title\u200b\n| Chat | Recent content |\u200b\n|---|---|\u200b\n\n';
    let editorInfoReads = 0;
    const { executor } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'textbox',
          name: 'Message',
          state: [],
          actions: ['type'],
          frame: 'main',
        },
      ],
      responder: (_session, method, params) => {
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: 'editor_node' } };
        }
        if (
          method === 'Runtime.callFunctionOn' &&
          params?.objectId === 'editor_node' &&
          typeof params.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxEditorTargetInfo')
        ) {
          editorInfoReads += 1;
          return {
            result: {
              type: 'object',
              value: {
                editor: true,
                custom: true,
                connected: true,
                value: editorInfoReads === 1 ? '' : incompleteEditorValue,
              },
            },
          };
        }
        if (
          method === 'Runtime.callFunctionOn' &&
          params?.objectId === 'editor_node' &&
          typeof params.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxInsertText')
        ) {
          return { result: { type: 'object', value: { dispatched: true } } };
        }
        if (method === 'Accessibility.getFullAXTree') {
          return { nodes: [] };
        }
        return undefined;
      },
    });

    const operation = executor.execute(
      call('browser_type', {
        tabId: 7,
        ref: 'ref_1',
        text,
        replace: true,
        submit: false,
      }),
      new AbortController().signal,
    );
    const rejection = expect(operation).rejects.toMatchObject({
      code: 'TYPE_VERIFICATION_FAILED',
      stage: 'readback',
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;
  });

  it('rejects a submitted editor action when the requested text remains in the editor', async () => {
    vi.useFakeTimers();
    const text = 'message that was not sent';
    const page = {
      performAction: vi.fn(async () => ({
        action: 'type' as const,
        applied: false,
        dispatched: false,
        reason: 'trusted_input_required' as const,
        target: { x: 60, y: 35 },
        value: '',
        submitted: false,
        url: 'https://example.test/current',
      })),
    };
    const { executor } = harness({
      page,
      responder: (_session, method, params) => {
        if (method === 'Runtime.evaluate') {
          return params?.returnByValue === true
            ? { result: { type: 'string', value: text } }
            : { result: { type: 'object', objectId: 'page_global' } };
        }
        if (method === 'Runtime.callFunctionOn') {
          return { result: { type: 'object', value: { dispatched: true } } };
        }
        return undefined;
      },
    });

    const operation = executor.execute(
      call('browser_type', {
        tabId: 7,
        ref: 'page_1_1',
        text,
        replace: true,
        submit: true,
      }),
      new AbortController().signal,
    );
    const rejection = expect(operation).rejects.toMatchObject({
      code: 'ACTION_STATE_MISMATCH',
      stage: 'submit',
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;
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

  it('dispatches a click when pointer feedback never settles', async () => {
    vi.useFakeTimers();
    const { executor, send } = harness({ pointerPending: true });

    const execution = executor.execute(
      call('browser_click', {
        tabId: 7,
        ref: 'ref_1',
        button: 'left',
        count: 1,
      }),
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(300);

    expect(send).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mousePressed', x: 60, y: 35 }),
    );
    await expect(execution).resolves.toMatchObject({
      data: { dispatched: true },
    });
  });

  it('executes an ordinary click on a selectable ref and returns the observed state', async () => {
    let checked = false;
    const { executor } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'checkbox',
          name: 'Continue',
          state: ['checked=false'],
          actions: ['click', 'set_checked'],
          frame: 'main',
        },
      ],
      responder: (_session, method, params) => {
        if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
          checked = true;
        }
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              {
                nodeId: 'checkbox',
                backendDOMNodeId: 42,
                ignored: false,
                role: { value: 'checkbox' },
                name: { value: 'Continue' },
                properties: [
                  {
                    name: 'checked',
                    value: { type: 'boolean', value: checked },
                  },
                ],
              },
            ],
          };
        }
        if (method === 'DOMSnapshot.captureSnapshot') return checkedTargetDomSnapshot(checked);
        return undefined;
      },
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
    ).resolves.toMatchObject({
      data: {
        action: 'click',
        dispatched: true,
        verified: 'target_remeasured',
      },
      observation: {
        targetPresent: true,
        target: { ref: 'ref_1', role: 'checkbox', state: ['checked'] },
        changes: [{ ref: 'ref_1', state: ['checked'] }],
      },
    });
  });

  it('accepts an ordinary click on an already-selected radio without expecting it to clear', async () => {
    const { executor, send } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'radio',
          name: 'Selected answer',
          state: ['checked'],
          actions: ['click', 'set_checked'],
          frame: 'main',
        },
      ],
      responder: (_session, method) => {
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              {
                nodeId: 'radio',
                backendDOMNodeId: 42,
                ignored: false,
                role: { value: 'radio' },
                name: { value: 'Selected answer' },
                properties: [{ name: 'checked', value: { type: 'boolean', value: true } }],
              },
            ],
          };
        }
        if (method === 'DOMSnapshot.captureSnapshot') return checkedTargetDomSnapshot(true);
        return undefined;
      },
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
    ).resolves.toMatchObject({
      data: {
        action: 'click',
        strategy: 'pointer',
        selectionVerified: true,
      },
      observation: {
        target: { ref: 'ref_1', role: 'radio', state: ['checked'] },
      },
    });
    expect(
      send.mock.calls.some(
        ([, method, params]) => method === 'Runtime.callFunctionOn' && params?.userGesture === true,
      ),
    ).toBe(false);
  });

  it('waits for a delayed selectable state after an ordinary click', async () => {
    vi.useFakeTimers();
    let clickedAt: number | null = null;
    const { executor, send } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'checkbox',
          name: 'Continue',
          state: ['checked=false'],
          actions: ['click', 'set_checked'],
          frame: 'main',
        },
      ],
      responder: (_session, method, params) => {
        if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
          clickedAt = Date.now();
        }
        const checked = clickedAt !== null && Date.now() - clickedAt >= 600;
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              {
                nodeId: 'checkbox',
                backendDOMNodeId: 42,
                ignored: false,
                role: { value: 'checkbox' },
                name: { value: 'Continue' },
                properties: [
                  {
                    name: 'checked',
                    value: { type: 'boolean', value: checked },
                  },
                ],
              },
            ],
          };
        }
        if (method === 'DOMSnapshot.captureSnapshot') return checkedTargetDomSnapshot(checked);
        return undefined;
      },
    });

    const execution = executor.execute(
      call('browser_click', {
        tabId: 7,
        ref: 'ref_1',
        button: 'left',
        count: 1,
      }),
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(execution).resolves.toMatchObject({
      data: { action: 'click', dispatched: true },
      observation: { target: { ref: 'ref_1', state: ['checked'] } },
    });
    expect(
      send.mock.calls.filter(
        ([, method, params]) =>
          method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed',
      ),
    ).toHaveLength(1);
  });

  it('uses one DOM click fallback for an unchanged ordinary selectable click', async () => {
    vi.useFakeTimers();
    let domClicked = false;
    const { executor, send } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'checkbox',
          name: 'Continue',
          state: ['checked=false'],
          actions: ['click', 'set_checked'],
          frame: 'main',
        },
      ],
      responder: (_session, method, params) => {
        if (method === 'Runtime.callFunctionOn' && params?.userGesture === true) {
          domClicked = true;
          return { result: { type: 'object', value: { dispatched: true } } };
        }
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              {
                nodeId: 'checkbox',
                backendDOMNodeId: 42,
                ignored: false,
                role: { value: 'checkbox' },
                name: { value: 'Continue' },
                properties: [
                  {
                    name: 'checked',
                    value: { type: 'boolean', value: domClicked },
                  },
                ],
              },
            ],
          };
        }
        if (method === 'DOMSnapshot.captureSnapshot') return checkedTargetDomSnapshot(domClicked);
        return undefined;
      },
    });

    const execution = executor.execute(
      call('browser_click', {
        tabId: 7,
        ref: 'ref_1',
        button: 'left',
        count: 1,
      }),
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(execution).resolves.toMatchObject({
      data: {
        action: 'click',
        dispatched: true,
        strategy: 'dom_fallback',
        selectionVerified: true,
      },
      observation: { target: { ref: 'ref_1', state: ['checked'] } },
    });
    expect(
      send.mock.calls.filter(
        ([, method, params]) =>
          method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed',
      ),
    ).toHaveLength(1);
  });

  it('fails an ordinary selectable click when neither click strategy changes state', async () => {
    vi.useFakeTimers();
    const { executor, send } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'checkbox',
          name: 'Continue',
          state: ['checked=false'],
          actions: ['click', 'set_checked'],
          frame: 'main',
        },
      ],
      responder: (_session, method) => {
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              {
                nodeId: 'checkbox',
                backendDOMNodeId: 42,
                ignored: false,
                role: { value: 'checkbox' },
                name: { value: 'Continue' },
                properties: [{ name: 'checked', value: { type: 'boolean', value: false } }],
              },
            ],
          };
        }
        if (method === 'DOMSnapshot.captureSnapshot') return checkedTargetDomSnapshot(false);
        return undefined;
      },
    });

    const execution = executor.execute(
      call('browser_click', {
        tabId: 7,
        ref: 'ref_1',
        button: 'left',
        count: 1,
      }),
      new AbortController().signal,
    );
    const assertion = expect(execution).rejects.toMatchObject({
      code: 'ACTION_STATE_MISMATCH',
    });
    await vi.advanceTimersByTimeAsync(4_000);
    await assertion;

    expect(
      send.mock.calls.filter(
        ([, method, params]) =>
          method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed',
      ),
    ).toHaveLength(1);
  });

  it('allows ordinary click when a selectable-looking role does not advertise set_checked', async () => {
    const { executor } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'option',
          name: 'Open details',
          state: [],
          actions: ['click'],
          frame: 'main',
        },
      ],
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
    ).resolves.toMatchObject({ data: { action: 'click', dispatched: true } });
  });

  it('does not dispatch when set_checked already matches the latest selectable state', async () => {
    const { executor, send } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'checkbox',
          name: 'Option A',
          state: ['checked'],
          actions: ['click', 'set_checked'],
          frame: 'main',
        },
      ],
      responder: (_session, method) => {
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              {
                nodeId: 'option-a',
                backendDOMNodeId: 42,
                ignored: false,
                role: { value: 'checkbox' },
                name: { value: 'Option A' },
                properties: [{ name: 'checked', value: { type: 'boolean', value: true } }],
              },
            ],
          };
        }
        if (method === 'DOMSnapshot.captureSnapshot') return checkedTargetDomSnapshot();
        return undefined;
      },
    });

    const result = await executor.execute(
      call('browser_set_checked', { tabId: 7, ref: 'ref_1', checked: true }),
      new AbortController().signal,
    );

    expect(send).not.toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchMouseEvent',
      expect.anything(),
    );
    expect(result).toMatchObject({
      data: { action: 'set_checked', dispatched: false, verified: true },
      observation: {
        targetPresent: true,
        target: { ref: 'ref_1', role: 'checkbox', state: ['checked'] },
        changes: [],
      },
    });
  });

  it('sets multiple distinct refs sequentially and verifies every item', async () => {
    const targets: readonly ObservedElementTarget[] = [42, 43].map((backendNodeId, index) => ({
      frameTargetId: null,
      documentFrameId: 'frame-main',
      loaderId: 'loader-1',
      backendNodeId,
      role: 'checkbox',
      name: `Option ${String(index + 1)}`,
      state: ['checked'],
      actions: ['click', 'set_checked'],
      frame: 'main',
    }));
    const { executor, send } = harness({
      targets,
      responder: (_session, method, params) => {
        if (method === 'Accessibility.getPartialAXTree') {
          const backendNodeId = Number(params?.backendNodeId);
          const target = targets.find((candidate) => candidate.backendNodeId === backendNodeId);
          if (!target) throw new Error('Expected batch target fixture.');
          return {
            nodes: [
              {
                nodeId: `node_${String(backendNodeId)}`,
                backendDOMNodeId: backendNodeId,
                ignored: false,
                role: { value: target.role },
                name: { value: target.name },
                properties: [{ name: 'checked', value: { type: 'boolean', value: true } }],
              },
            ],
          };
        }
        return undefined;
      },
    });

    const result = await executor.execute(
      call('browser_set_checked_many', {
        tabId: 7,
        items: [
          { ref: 'ref_1', checked: true },
          { ref: 'ref_2', checked: true },
        ],
      }),
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      data: {
        action: 'set_checked_many',
        complete: true,
        completedItems: [
          { ref: 'ref_1', requested: true, actual: true, dispatched: false },
          { ref: 'ref_2', requested: true, actual: true, dispatched: false },
        ],
      },
    });
    expect(
      send.mock.calls.filter(
        ([, method, params]) =>
          method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed',
      ),
    ).toHaveLength(0);
  });

  it('stops a selection batch at the first failure and preserves its verified prefix', async () => {
    const targets: readonly ObservedElementTarget[] = [
      {
        frameTargetId: null,
        documentFrameId: 'frame-main',
        loaderId: 'loader-1',
        backendNodeId: 42,
        role: 'checkbox',
        name: 'Ready',
        state: ['checked'],
        actions: ['click', 'set_checked'],
        frame: 'main',
      },
      {
        frameTargetId: null,
        documentFrameId: 'frame-main',
        loaderId: 'loader-1',
        backendNodeId: 43,
        role: 'radio',
        name: 'Cannot clear',
        state: ['checked'],
        actions: ['click', 'set_checked'],
        frame: 'main',
      },
      {
        frameTargetId: null,
        documentFrameId: 'frame-main',
        loaderId: 'loader-1',
        backendNodeId: 44,
        role: 'checkbox',
        name: 'Must not run',
        state: ['checked=false'],
        actions: ['click', 'set_checked'],
        frame: 'main',
      },
    ];
    const { executor, send } = harness({
      targets,
      responder: (_session, method, params) => {
        if (method === 'Accessibility.getPartialAXTree') {
          const backendNodeId = Number(params?.backendNodeId);
          const target = targets.find((candidate) => candidate.backendNodeId === backendNodeId);
          if (!target) throw new Error('Expected batch target fixture.');
          return {
            nodes: [
              {
                nodeId: `node_${String(backendNodeId)}`,
                backendDOMNodeId: backendNodeId,
                ignored: false,
                role: { value: target.role },
                name: { value: target.name },
                properties: [
                  {
                    name: 'checked',
                    value: {
                      type: 'boolean',
                      value: target.state.includes('checked'),
                    },
                  },
                ],
              },
            ],
          };
        }
        return undefined;
      },
    });

    const result = await executor.execute(
      call('browser_set_checked_many', {
        tabId: 7,
        items: [
          { ref: 'ref_1', checked: true },
          { ref: 'ref_2', checked: false },
          { ref: 'ref_3', checked: true },
        ],
      }),
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      data: {
        action: 'set_checked_many',
        complete: false,
        failedIndex: 1,
        completedItems: [{ ref: 'ref_1', requested: true, actual: true }],
      },
      failure: expect.objectContaining({ code: 'UNSUPPORTED_ACTION' }),
    });
    expect(send).not.toHaveBeenCalledWith(
      { tabId: 7 },
      'DOM.getBoxModel',
      expect.objectContaining({ backendNodeId: 44 }),
    );
  });

  it('sets one selectable target and returns every observed selection change', async () => {
    let selectedBackendNodeId = 42;
    const targets: readonly ObservedElementTarget[] = [
      {
        frameTargetId: null,
        documentFrameId: 'frame-main',
        loaderId: 'loader-1',
        backendNodeId: 42,
        role: 'radio',
        name: 'Option A',
        state: ['checked'],
        actions: ['click', 'set_checked'],
        frame: 'main',
      },
      {
        frameTargetId: null,
        documentFrameId: 'frame-main',
        loaderId: 'loader-1',
        backendNodeId: 43,
        role: 'radio',
        name: 'Option B',
        state: ['checked=false'],
        actions: ['click', 'set_checked'],
        frame: 'main',
      },
    ];
    const { executor } = harness({
      targets,
      responder: (_session, method, params) => {
        if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
          selectedBackendNodeId = 43;
        }
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: targets.map((target, index) => ({
              nodeId: `option-${String(index)}`,
              backendDOMNodeId: target.backendNodeId,
              ignored: false,
              role: { value: 'radio' },
              name: { value: target.name },
              properties: [
                {
                  name: 'checked',
                  value: {
                    type: 'boolean',
                    value: target.backendNodeId === selectedBackendNodeId,
                  },
                },
              ],
            })),
          };
        }
        if (method === 'DOMSnapshot.captureSnapshot') {
          return choiceDomSnapshot(selectedBackendNodeId);
        }
        return undefined;
      },
    });

    const result = await executor.execute(
      call('browser_set_checked', { tabId: 7, ref: 'ref_2', checked: true }),
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      data: { action: 'set_checked', dispatched: true, verified: true },
      observation: {
        targetPresent: true,
        target: { ref: 'ref_2', role: 'radio', state: ['checked'] },
        changes: [
          { ref: 'ref_1', state: ['checked=false'] },
          { ref: 'ref_2', state: ['checked'] },
        ],
      },
    });
  });

  it('verifies a stable selection through targeted state reads without full-page snapshots', async () => {
    let checked = false;
    const { executor, send } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'checkbox',
          name: 'Option A',
          semanticLocator: 'question:1/checkbox:A:0',
          state: ['checked=false'],
          actions: ['click', 'set_checked'],
          frame: 'main',
        },
      ],
      responder: (_session, method, params) => {
        if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased')
          checked = true;
        if (method === 'Accessibility.getPartialAXTree') {
          return {
            nodes: [
              {
                nodeId: 'option-a',
                backendDOMNodeId: 42,
                ignored: false,
                role: { value: 'checkbox' },
                name: { value: 'Option A' },
                properties: [
                  {
                    name: 'checked',
                    value: { type: 'boolean', value: checked },
                  },
                ],
              },
            ],
          };
        }
        if (
          method === 'Runtime.callFunctionOn' &&
          typeof params?.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxSelectionState')
        ) {
          return {
            result: {
              type: 'object',
              value: { observable: true, selected: checked },
            },
          };
        }
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              {
                nodeId: 'option-a',
                backendDOMNodeId: 42,
                ignored: false,
                role: { value: 'checkbox' },
                name: { value: 'Option A' },
                properties: [
                  {
                    name: 'checked',
                    value: { type: 'boolean', value: checked },
                  },
                ],
              },
            ],
          };
        }
        if (method === 'DOMSnapshot.captureSnapshot') return checkedTargetDomSnapshot(checked);
        return undefined;
      },
    });

    await expect(
      executor.execute(
        call('browser_set_checked', { tabId: 7, ref: 'ref_1', checked: true }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      data: { action: 'set_checked', verified: true },
      observation: { target: { ref: 'ref_1', state: ['checked'] } },
    });
    expect(send.mock.calls.some(([, method]) => method === 'Accessibility.getPartialAXTree')).toBe(
      true,
    );
    expect(send.mock.calls.some(([, method]) => method === 'DOMSnapshot.captureSnapshot')).toBe(
      false,
    );
  });

  it('reads selection state from the control associated with a separate click target', async () => {
    let checked = false;
    const { executor, send } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 41,
          stateBackendNodeId: 42,
          role: 'checkbox',
          name: 'Option A',
          state: ['checked=false'],
          actions: ['click', 'set_checked'],
          frame: 'main',
        },
      ],
      responder: (_session, method, params) => {
        if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
          checked = true;
        }
        if (method === 'Accessibility.getPartialAXTree') {
          const backendNodeId = params?.backendNodeId;
          return backendNodeId === 42
            ? {
                nodes: [
                  {
                    nodeId: 'option-a-control',
                    backendDOMNodeId: 42,
                    ignored: false,
                    role: { value: 'checkbox' },
                    name: { value: 'Option A' },
                    properties: [
                      {
                        name: 'checked',
                        value: { type: 'boolean', value: checked },
                      },
                    ],
                  },
                ],
              }
            : {
                nodes: [
                  {
                    nodeId: 'option-a-label',
                    backendDOMNodeId: 41,
                    ignored: true,
                  },
                ],
              };
        }
        if (
          method === 'Runtime.callFunctionOn' &&
          typeof params?.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxActionablePoint')
        ) {
          return { result: { type: 'number', value: 0 } };
        }
        if (method === 'Accessibility.getFullAXTree') {
          throw new Error('A targeted state read should be sufficient.');
        }
        if (method === 'DOMSnapshot.captureSnapshot') {
          throw new Error('A targeted state read should be sufficient.');
        }
        return undefined;
      },
    });

    await expect(
      executor.execute(
        call('browser_set_checked', { tabId: 7, ref: 'ref_1', checked: true }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      data: { action: 'set_checked', verified: true },
      observation: { target: { ref: 'ref_1', state: ['checked'] } },
    });
    expect(
      send.mock.calls
        .filter(([, method]) => method === 'Accessibility.getPartialAXTree')
        .map(([, , params]) => params?.backendNodeId),
    ).toEqual([42, 42]);
  });

  it('rebinds a custom selection ref when the old DOM node is detached after the click', async () => {
    vi.useFakeTimers();
    const oldElement = document.createElement('div');
    oldElement.className = 'choice-option__x';
    document.body.append(oldElement);
    let selected = false;
    const semanticLocator = JSON.stringify([
      [],
      [['DIV', [['class', 'choice-option__x']], 0]],
      'option',
      'A. First answer',
    ]);
    const { executor, refs } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'option',
          name: 'A. First answer',
          semanticLocator,
          state: ['selected=false'],
          actions: ['click', 'set_checked'],
          frame: 'main',
        },
      ],
      responder: (_session, method, params) => {
        if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
          selected = true;
          oldElement.remove();
        }
        if (method === 'Accessibility.getPartialAXTree') {
          return selected
            ? {
                nodes: [
                  {
                    nodeId: 'detached-option-a',
                    backendDOMNodeId: 42,
                    ignored: true,
                  },
                ],
              }
            : {
                nodes: [
                  {
                    nodeId: 'option-a',
                    backendDOMNodeId: 42,
                    ignored: false,
                    role: { value: 'option' },
                    name: { value: 'A. First answer' },
                    properties: [
                      {
                        name: 'selected',
                        value: { type: 'boolean', value: false },
                      },
                    ],
                  },
                ],
              };
        }
        if (method === 'DOM.resolveNode') return { object: { objectId: 'old-option-a' } };
        if (
          method === 'Runtime.callFunctionOn' &&
          typeof params?.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxSelectionState')
        ) {
          const read = Function(`return (${params.functionDeclaration})`)() as (
            this: Element,
            role: string,
          ) => unknown;
          return {
            result: {
              type: 'object',
              value: read.call(oldElement, 'option'),
            },
          };
        }
        if (
          method === 'Runtime.callFunctionOn' &&
          typeof params?.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxActionablePoint')
        ) {
          return { result: { type: 'number', value: 0 } };
        }
        if (method === 'Runtime.callFunctionOn') {
          return { result: { type: 'object', value: { dispatched: false } } };
        }
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              {
                nodeId: 'option-a-recreated',
                backendDOMNodeId: 77,
                ignored: false,
                role: { value: 'option' },
                name: { value: 'A. First answer' },
                properties: [
                  {
                    name: 'selected',
                    value: { type: 'boolean', value: selected },
                  },
                ],
              },
            ],
          };
        }
        if (method === 'DOMSnapshot.captureSnapshot') {
          return customOptionDomSnapshot(selected, 77);
        }
        return undefined;
      },
    });

    const execution = executor.execute(
      call('browser_set_checked', { tabId: 7, ref: 'ref_1', checked: true }),
      new AbortController().signal,
    );
    const assertion = expect(execution).resolves.toMatchObject({
      data: { action: 'set_checked', verified: true },
      observation: { target: { ref: 'ref_1', state: ['selected'] } },
    });
    await vi.advanceTimersByTimeAsync(4_000);
    await assertion;

    expect(refs.resolve('ref_1', 7)).toMatchObject({
      backendNodeId: 77,
      state: ['selected'],
    });
  });

  it('uses one final semantic refresh when a targeted selection read stays stale', async () => {
    vi.useFakeTimers();
    let checked = false;
    const { executor, send } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'checkbox',
          name: 'Option A',
          semanticLocator: JSON.stringify([[], [['INPUT', [], 0]], 'checkbox', 'Option A']),
          state: ['checked=false'],
          actions: ['click', 'set_checked'],
          frame: 'main',
        },
      ],
      responder: (_session, method, params) => {
        if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
          checked = true;
        }
        if (method === 'Accessibility.getPartialAXTree') {
          return {
            nodes: [
              {
                nodeId: 'stale-option-a',
                backendDOMNodeId: 42,
                ignored: false,
                role: { value: 'checkbox' },
                name: { value: 'Option A' },
                properties: [{ name: 'checked', value: { type: 'boolean', value: false } }],
              },
            ],
          };
        }
        if (
          method === 'Runtime.callFunctionOn' &&
          typeof params?.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxActionablePoint')
        ) {
          return { result: { type: 'number', value: 0 } };
        }
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              {
                nodeId: 'fresh-option-a',
                backendDOMNodeId: 42,
                ignored: false,
                role: { value: 'checkbox' },
                name: { value: 'Option A' },
                properties: [
                  {
                    name: 'checked',
                    value: { type: 'boolean', value: checked },
                  },
                ],
              },
            ],
          };
        }
        if (method === 'DOMSnapshot.captureSnapshot') return checkedTargetDomSnapshot(checked);
        return undefined;
      },
    });

    const execution = executor.execute(
      call('browser_set_checked', { tabId: 7, ref: 'ref_1', checked: true }),
      new AbortController().signal,
    );
    const assertion = expect(execution).resolves.toMatchObject({
      data: { action: 'set_checked', strategy: 'pointer', verified: true },
      observation: { target: { ref: 'ref_1', state: ['checked'] } },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(send.mock.calls.some(([, method]) => method === 'Accessibility.getFullAXTree')).toBe(
      true,
    );
  });

  it('reports state observation failures instead of misclassifying them as a mismatch', async () => {
    vi.useFakeTimers();
    const { executor } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'checkbox',
          name: 'Option A',
          state: ['checked=false'],
          actions: ['click', 'set_checked'],
          frame: 'main',
        },
      ],
      responder: (_session, method) => {
        if (method === 'Accessibility.getFullAXTree') throw new Error('CDP session disappeared');
        if (method === 'DOMSnapshot.captureSnapshot') throw new Error('CDP session disappeared');
        return undefined;
      },
    });

    const execution = executor.execute(
      call('browser_set_checked', { tabId: 7, ref: 'ref_1', checked: true }),
      new AbortController().signal,
    );
    const assertion = expect(execution).rejects.toMatchObject({
      code: 'ACTION_STATE_UNAVAILABLE',
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
  });

  it('waits for a delayed selection state without dispatching a second click', async () => {
    vi.useFakeTimers();
    let observationReads = 0;
    const { executor, send } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'checkbox',
          name: 'Option A',
          state: ['checked=false'],
          actions: ['click', 'set_checked'],
          frame: 'main',
        },
      ],
      responder: (_session, method) => {
        if (method === 'Accessibility.getFullAXTree') {
          observationReads += 1;
          const checked = observationReads >= 3;
          return {
            nodes: [
              {
                nodeId: 'option-a',
                backendDOMNodeId: 42,
                ignored: false,
                role: { value: 'checkbox' },
                name: { value: 'Option A' },
                properties: [
                  {
                    name: 'checked',
                    value: { type: 'boolean', value: checked },
                  },
                ],
              },
            ],
          };
        }
        if (method === 'DOMSnapshot.captureSnapshot') {
          return checkedTargetDomSnapshot(observationReads >= 3);
        }
        return undefined;
      },
    });

    const execution = executor.execute(
      call('browser_set_checked', { tabId: 7, ref: 'ref_1', checked: true }),
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(500);

    await expect(execution).resolves.toMatchObject({
      data: { action: 'set_checked', dispatched: true, verified: true },
      observation: {
        target: { ref: 'ref_1', state: ['checked'] },
      },
    });
    expect(
      send.mock.calls.filter(
        ([, method, params]) =>
          method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed',
      ),
    ).toHaveLength(1);
  });

  it('keeps the same ref when a selected control is recreated after the click', async () => {
    let selected = false;
    const { executor, refs } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'checkbox',
          name: 'A. TCE service upgrade',
          state: ['checked=false'],
          actions: ['click', 'set_checked'],
          frame: 'main',
        },
      ],
      responder: (_session, method, params) => {
        if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
          selected = true;
        }
        const backendNodeId = selected ? 77 : 42;
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              {
                nodeId: selected ? 'option-a-recreated' : 'option-a',
                backendDOMNodeId: backendNodeId,
                ignored: false,
                role: { value: 'checkbox' },
                name: { value: 'A. TCE service upgrade' },
                properties: [
                  {
                    name: 'checked',
                    value: { type: 'boolean', value: selected },
                  },
                ],
              },
            ],
          };
        }
        if (method === 'DOMSnapshot.captureSnapshot') {
          return checkedTargetDomSnapshot(selected, backendNodeId);
        }
        return undefined;
      },
    });

    await expect(
      executor.execute(
        call('browser_set_checked', { tabId: 7, ref: 'ref_1', checked: true }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      data: { action: 'set_checked', verified: true },
      observation: { target: { ref: 'ref_1', state: ['checked'] } },
    });
    expect(refs.resolve('ref_1', 7)).toMatchObject({
      backendNodeId: 77,
      state: ['checked'],
    });
  });

  it('waits for a selection state that settles after six hundred milliseconds', async () => {
    vi.useFakeTimers();
    let clickedAt: number | null = null;
    const { executor, send } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'checkbox',
          name: 'Option A',
          state: ['checked=false'],
          actions: ['click', 'set_checked'],
          frame: 'main',
        },
      ],
      responder: (_session, method, params) => {
        if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
          clickedAt = Date.now();
        }
        const checked = clickedAt !== null && Date.now() - clickedAt >= 600;
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              {
                nodeId: 'option-a',
                backendDOMNodeId: 42,
                ignored: false,
                role: { value: 'checkbox' },
                name: { value: 'Option A' },
                properties: [
                  {
                    name: 'checked',
                    value: { type: 'boolean', value: checked },
                  },
                ],
              },
            ],
          };
        }
        if (method === 'DOMSnapshot.captureSnapshot') return checkedTargetDomSnapshot(checked);
        return undefined;
      },
    });

    const execution = executor.execute(
      call('browser_set_checked', { tabId: 7, ref: 'ref_1', checked: true }),
      new AbortController().signal,
    );
    const assertion = expect(execution).resolves.toMatchObject({
      data: { action: 'set_checked', dispatched: true, verified: true },
      observation: { target: { ref: 'ref_1', state: ['checked'] } },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;

    expect(
      send.mock.calls.filter(
        ([, method, params]) =>
          method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed',
      ),
    ).toHaveLength(1);
  });

  it('uses one DOM click fallback when a selectable target ignores the pointer click', async () => {
    vi.useFakeTimers();
    let domClicked = false;
    const { executor, send } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'checkbox',
          name: 'Option A',
          state: ['checked=false'],
          actions: ['click', 'set_checked'],
          frame: 'main',
        },
      ],
      responder: (_session, method, params) => {
        if (method === 'Runtime.callFunctionOn' && params?.userGesture === true) {
          domClicked = true;
          return { result: { type: 'object', value: { dispatched: true } } };
        }
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              {
                nodeId: 'option-a',
                backendDOMNodeId: 42,
                ignored: false,
                role: { value: 'checkbox' },
                name: { value: 'Option A' },
                properties: [
                  {
                    name: 'checked',
                    value: { type: 'boolean', value: domClicked },
                  },
                ],
              },
            ],
          };
        }
        if (method === 'DOMSnapshot.captureSnapshot') return checkedTargetDomSnapshot(domClicked);
        return undefined;
      },
    });

    const execution = executor.execute(
      call('browser_set_checked', { tabId: 7, ref: 'ref_1', checked: true }),
      new AbortController().signal,
    );
    const assertion = expect(execution).resolves.toMatchObject({
      data: {
        action: 'set_checked',
        dispatched: true,
        requested: true,
        verified: true,
        strategy: 'dom_fallback',
      },
      observation: { target: { ref: 'ref_1', state: ['checked'] } },
    });
    await vi.advanceTimersByTimeAsync(4_000);
    await assertion;

    expect(
      send.mock.calls.filter(
        ([, method, params]) =>
          method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed',
      ),
    ).toHaveLength(1);
    expect(send).toHaveBeenCalledWith(
      { tabId: 7 },
      'Runtime.callFunctionOn',
      expect.objectContaining({ userGesture: true }),
    );
  });

  it('fails without invalidating a still-live ref when a requested selection never settles', async () => {
    const { executor, refs } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'checkbox',
          name: 'Option A',
          state: ['checked=false'],
          actions: ['click', 'set_checked'],
          frame: 'main',
        },
      ],
      responder: (_session, method) => {
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              {
                nodeId: 'option-a',
                backendDOMNodeId: 42,
                ignored: false,
                role: { value: 'checkbox' },
                name: { value: 'Option A' },
                properties: [{ name: 'checked', value: { type: 'boolean', value: false } }],
              },
            ],
          };
        }
        if (method === 'DOMSnapshot.captureSnapshot') return checkedTargetDomSnapshot(false);
        return undefined;
      },
    });

    await expect(
      executor.execute(
        call('browser_set_checked', { tabId: 7, ref: 'ref_1', checked: true }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'ACTION_STATE_MISMATCH' });
    expect(refs.resolve('ref_1', 7)).toMatchObject({ backendNodeId: 42 });
  });

  it('uses the viewport-relative box model after scrolling a stable ref into view', async () => {
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
          return {
            model: { border: [410, 120, 510, 120, 510, 150, 410, 150] },
          };
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

  it('uses an uncovered point inside the target when its center is occluded', async () => {
    const { executor, send, pointer } = harness({
      responder: (_session, method, params) => {
        if (
          method === 'Runtime.callFunctionOn' &&
          typeof params?.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxActionablePoint')
        ) {
          return { result: { type: 'number', value: 1 } };
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

    expect(pointer.show).toHaveBeenCalledWith(7, {
      x: 35,
      y: 35,
      fromX: 35,
      fromY: 35,
      effect: 'click',
    });
    expect(send).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mousePressed', x: 35, y: 35 }),
    );
  });

  it('uses an uncovered inset corner when the center cross is occluded', async () => {
    const { executor, send, pointer } = harness({
      responder: (_session, method, params) => {
        if (
          method === 'Runtime.callFunctionOn' &&
          typeof params?.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxActionablePoint')
        ) {
          const points = (
            params.arguments as readonly {
              readonly value?: readonly unknown[];
            }[]
          )?.at(0)?.value;
          expect(points).toHaveLength(9);
          return { result: { type: 'number', value: 5 } };
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

    expect(pointer.show).toHaveBeenCalledWith(7, {
      x: 25,
      y: 24.5,
      fromX: 25,
      fromY: 24.5,
      effect: 'click',
    });
    expect(send).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mousePressed', x: 25, y: 24.5 }),
    );
  });

  it('does not dispatch a click when every point inside the target is occluded', async () => {
    const { executor, send, pointer } = harness({
      responder: (_session, method, params) => {
        if (
          method === 'Runtime.callFunctionOn' &&
          typeof params?.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxActionablePoint')
        ) {
          return { result: { type: 'number', value: -1 } };
        }
        return undefined;
      },
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
    ).rejects.toMatchObject({ code: 'ACTION_TARGET_OBSCURED' });
    expect(pointer.show).not.toHaveBeenCalled();
    expect(
      send.mock.calls.some(
        ([, method, params]) =>
          method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed',
      ),
    ).toBe(false);
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

  it('rebinds a unique semantic ref once when a framework replaces the node before the action', async () => {
    const replacementBackendNodeId = 84;
    const semanticLocator = JSON.stringify([[], [['INPUT', [], 0]], 'button', 'Continue']);
    const { executor, refs, send } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'button',
          name: 'Continue',
          semanticLocator,
          state: [],
          actions: ['click'],
          frame: 'main',
        },
      ],
      responder: (_session, method, params) => {
        if (method === 'DOM.scrollIntoViewIfNeeded' && params?.backendNodeId === 42) {
          throw new Error('No node with given id');
        }
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              {
                nodeId: 'continue-replacement',
                backendDOMNodeId: replacementBackendNodeId,
                ignored: false,
                role: { value: 'button' },
                name: { value: 'Continue' },
              },
            ],
          };
        }
        if (method === 'DOMSnapshot.captureSnapshot') {
          return checkedTargetDomSnapshot(false, replacementBackendNodeId);
        }
        return undefined;
      },
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
    ).resolves.toMatchObject({ data: { action: 'click', dispatched: true } });

    expect(refs.resolve('ref_1', 7).backendNodeId).toBe(replacementBackendNodeId);
    expect(send).toHaveBeenCalledWith({ tabId: 7 }, 'DOM.scrollIntoViewIfNeeded', {
      backendNodeId: replacementBackendNodeId,
    });
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

  it('resolves an inner text node to its contenteditable host without misclassifying ace-line', () => {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const line = document.createElement('div');
    line.className = 'ace-line';
    const text = document.createTextNode('\u200bcaoyang.001\u200b');
    line.append(text);
    editor.append(line);
    document.body.append(editor);

    expect(inspectEditorTarget.call(text)).toEqual({
      editor: true,
      custom: false,
      connected: true,
      value: '\u200bcaoyang.001\u200b',
    });

    editor.className = 'ace_editor';
    expect(inspectEditorTarget.call(text)).toMatchObject({
      editor: true,
      custom: true,
    });
  });

  it('reads the full Monaco model matched to the target instead of its partial textarea buffer', () => {
    const otherRoot = document.createElement('div');
    otherRoot.className = 'monaco-editor';
    const otherInput = document.createElement('textarea');
    otherInput.value = 'other partial buffer';
    otherRoot.append(otherInput);
    const targetRoot = document.createElement('div');
    targetRoot.className = 'monaco-editor';
    const targetInput = document.createElement('textarea');
    targetInput.value = 'target partial buffer';
    targetRoot.append(targetInput);
    document.body.append(otherRoot, targetRoot);
    const expected = 'class Solution {\n    return complete_model_value;\n};';
    const windowWithMonaco = window as typeof window & {
      monaco?: {
        editor: {
          getEditors(): readonly {
            getDomNode(): HTMLElement;
            getModel(): { getValue(): string };
          }[];
        };
      };
    };
    const previousMonaco = windowWithMonaco.monaco;
    windowWithMonaco.monaco = {
      editor: {
        getEditors: () => [
          {
            getDomNode: () => otherRoot,
            getModel: () => ({ getValue: () => 'other complete model' }),
          },
          {
            getDomNode: () => targetRoot,
            getModel: () => ({ getValue: () => expected }),
          },
        ],
      },
    };

    try {
      expect(inspectEditorTarget.call(targetInput)).toEqual({
        editor: true,
        custom: true,
        connected: true,
        value: expected,
      });
    } finally {
      if (previousMonaco === undefined) delete windowWithMonaco.monaco;
      else windowWithMonaco.monaco = previousMonaco;
      otherRoot.remove();
      targetRoot.remove();
    }
  });

  it('rejects ordinary input when the target value does not retain inserted text', async () => {
    let editorInfoReads = 0;
    const { executor } = harness({
      responder: (_session, method, params) => {
        if (
          method === 'Runtime.callFunctionOn' &&
          typeof params?.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxEditorTargetInfo')
        ) {
          editorInfoReads += 1;
          return {
            result: {
              type: 'object',
              value: { editor: false, value: 'starter' },
            },
          };
        }
        return undefined;
      },
    });

    await expect(
      executor.execute(
        call('browser_type', {
          tabId: 7,
          ref: 'ref_1',
          text: 'hello',
          replace: true,
          submit: false,
        }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'TYPE_VERIFICATION_FAILED',
      stage: 'readback',
    });
    expect(editorInfoReads).toBeGreaterThanOrEqual(2);
  });

  it('commits a controlled input before verifying its retained value', async () => {
    vi.useFakeTimers();
    const before = '13:00';
    const expected = '16:30';
    let committed = false;
    const currentValue = () => (committed ? expected : before);
    const { executor } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'textbox',
          name: 'Editable field',
          state: [],
          actions: ['type'],
          frame: 'main',
        },
      ],
      responder: (_session, method, params) => {
        if (
          method === 'Input.dispatchKeyEvent' &&
          params?.type === 'keyDown' &&
          params.key === 'ArrowRight'
        ) {
          committed = true;
        }
        if (
          method === 'Runtime.callFunctionOn' &&
          typeof params?.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxEditorTargetInfo')
        ) {
          return {
            result: {
              type: 'object',
              value: {
                editor: true,
                custom: false,
                connected: true,
                value: currentValue(),
              },
            },
          };
        }
        if (method === 'Runtime.evaluate' && params?.returnByValue === true) {
          return { result: { type: 'string', value: currentValue() } };
        }
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              {
                nodeId: 'controlled-input',
                ignored: false,
                role: { type: 'role', value: 'textbox' },
                value: { type: 'string', value: currentValue() },
                properties: [{ name: 'focused', value: { type: 'boolean', value: true } }],
              },
            ],
          };
        }
        return undefined;
      },
    });

    const operation = executor.execute(
      call('browser_type', {
        tabId: 7,
        ref: 'ref_1',
        text: expected,
        replace: true,
        submit: false,
      }),
      new AbortController().signal,
    );
    const completion = expect(operation).resolves.toMatchObject({
      data: { action: 'type', verified: true },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await completion;
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
        if (
          method === 'Runtime.callFunctionOn' &&
          params?.objectId === 'editor_node' &&
          typeof params.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxEditorTargetInfo')
        ) {
          return {
            result: {
              type: 'object',
              value: { editor: true, custom: true, value: editorValue },
            },
          };
        }
        if (
          method === 'Runtime.callFunctionOn' &&
          params?.objectId === 'editor_node' &&
          typeof params.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxInsertText')
        ) {
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

  it('verifies a trusted semantic editor from its bound node when global focus is stale', async () => {
    const replacement = 'ChatBrowserX target-bound input';
    let editorValue = 'starter';
    const { executor } = harness({
      responder: (_session, method, params) => {
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: 'editor_node' } };
        }
        if (
          method === 'Runtime.callFunctionOn' &&
          params?.objectId === 'editor_node' &&
          typeof params.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxEditorTargetInfo')
        ) {
          return {
            result: {
              type: 'object',
              value: { editor: true, custom: true, value: editorValue },
            },
          };
        }
        if (
          method === 'Runtime.callFunctionOn' &&
          params?.objectId === 'editor_node' &&
          typeof params.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxInsertText')
        ) {
          editorValue = replacement;
          return { result: { type: 'object', value: { dispatched: true } } };
        }
        if (method === 'Runtime.callFunctionOn' && params?.objectId === 'page_global') {
          return { result: { type: 'object', value: { dispatched: true } } };
        }
        if (method === 'Runtime.evaluate' && params?.returnByValue === true) {
          return { result: { type: 'string', value: 'starter' } };
        }
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              {
                nodeId: 'stale-editor',
                ignored: false,
                role: { type: 'role', value: 'textbox' },
                value: { type: 'string', value: 'starter' },
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
          ref: 'ref_1',
          text: replacement,
          replace: true,
          submit: false,
        }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      data: { action: 'type', strategy: 'trusted_input', verified: true },
    });
    expect(editorValue).toBe(replacement);
  });

  it('uses native CDP text insertion for a non-code contenteditable semantic editor', async () => {
    const replacement = 'caoyang.001';
    let editorValue = '\u200b';
    const { executor, send } = harness({
      responder: (_session, method, params) => {
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: 'rich_text_editor' } };
        }
        if (
          method === 'Runtime.callFunctionOn' &&
          params?.objectId === 'rich_text_editor' &&
          typeof params.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxEditorTargetInfo')
        ) {
          return {
            result: {
              type: 'object',
              value: { editor: true, custom: false, value: editorValue },
            },
          };
        }
        if (method === 'Input.insertText') {
          editorValue = `\u200b\n${replacement}\u200b`;
          return {};
        }
        if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
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
      data: { action: 'type', strategy: 'trusted_input', verified: true },
    });
    expect(send).toHaveBeenCalledWith({ tabId: 7 }, 'Input.insertText', {
      text: replacement,
    });
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

  it('reports the actual viewport movement after a CDP scroll', async () => {
    let pageY = 0;
    const { executor } = harness({
      responder: (_session, method, params) => {
        if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseWheel') {
          pageY = 120;
          return {};
        }
        if (method === 'Page.getLayoutMetrics') {
          return {
            visualViewport: {
              pageX: 0,
              pageY,
              clientWidth: 800,
              clientHeight: 600,
            },
          };
        }
        return undefined;
      },
    });

    const result = await executor.execute(
      call('browser_scroll', {
        tabId: 7,
        target: 'viewport',
        deltaX: 0,
        deltaY: 200,
      }),
      new AbortController().signal,
    );

    expect(result.data).toMatchObject({
      action: 'scroll',
      dispatched: true,
      moved: true,
      actualDeltaX: 0,
      actualDeltaY: 120,
    });
  });

  it('measures the viewport scroll target in CSS pixels', async () => {
    const { executor } = harness({
      responder: (_session, method) =>
        method === 'Page.getLayoutMetrics'
          ? {
              cssVisualViewport: {
                pageX: 0,
                pageY: 0,
                clientWidth: 1_024,
                clientHeight: 750,
              },
            }
          : undefined,
    });

    await expect(
      executor.measureScrollTarget(7, 'viewport', new AbortController().signal),
    ).resolves.toEqual({ width: 1_024, height: 750 });
  });

  it('measures the nearest nested scroll container in CSS pixels', async () => {
    const { executor } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'region',
          name: 'Message history',
          state: [],
          actions: ['scroll'],
          frame: 'main',
        },
      ],
      responder: (_session, method, params) => {
        if (
          method === 'Runtime.callFunctionOn' &&
          typeof params?.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxScrollState')
        ) {
          return {
            result: {
              type: 'object',
              value: {
                found: true,
                x: 0,
                y: 120,
                maxX: 0,
                maxY: 800,
                clientWidth: 320,
                clientHeight: 400,
                contentKey: 'visible-history',
              },
            },
          };
        }
        return undefined;
      },
    });

    await expect(
      executor.measureScrollTarget(7, 'ref_1', new AbortController().signal),
    ).resolves.toEqual({ width: 320, height: 400 });
  });

  it('requires one same-direction viewport probe before verifying a finite boundary', async () => {
    let pageY = 0;
    const { executor } = harness({
      responder: (_session, method, params) => {
        if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseWheel') {
          pageY = 400;
          return {};
        }
        if (method === 'Page.getLayoutMetrics') {
          return {
            visualViewport: {
              pageX: 0,
              pageY,
              clientWidth: 800,
              clientHeight: 600,
            },
            contentSize: { x: 0, y: 0, width: 800, height: 1_000 },
          };
        }
        return undefined;
      },
    });

    const first = await executor.execute(
      call('browser_scroll', {
        tabId: 7,
        target: 'viewport',
        deltaX: 0,
        deltaY: 600,
      }),
      new AbortController().signal,
    );
    const second = await executor.execute(
      call('browser_scroll', {
        tabId: 7,
        target: 'viewport',
        deltaX: 0,
        deltaY: 600,
      }),
      new AbortController().signal,
    );

    expect(first.data).toMatchObject({
      moved: true,
      actualDeltaY: 400,
      requestedDeltaApplied: false,
      remainingDeltaY: 200,
      boundaryVerified: false,
      needsBoundaryProbe: true,
      position: { y: 400, maxY: 400 },
    });
    expect(second.data).toMatchObject({
      moved: false,
      actualDeltaY: 0,
      boundaryVerified: true,
      needsBoundaryProbe: false,
      position: { y: 400, maxY: 400 },
    });
  });

  it('waits for delayed viewport growth before declaring the current edge a boundary', async () => {
    let metricReads = 0;
    const { executor } = harness({
      responder: (_session, method) => {
        if (method === 'Page.getLayoutMetrics') {
          metricReads += 1;
          const height = metricReads >= 7 ? 1_600 : 1_000;
          return {
            visualViewport: {
              pageX: 0,
              pageY: 400,
              clientWidth: 800,
              clientHeight: 600,
            },
            contentSize: { x: 0, y: 0, width: 800, height },
          };
        }
        return undefined;
      },
    });

    const result = await executor.execute(
      call('browser_scroll', {
        tabId: 7,
        target: 'viewport',
        deltaX: 0,
        deltaY: 600,
      }),
      new AbortController().signal,
    );

    expect(metricReads).toBeGreaterThanOrEqual(7);
    expect(result.data).toMatchObject({
      moved: true,
      actualDeltaY: 0,
      extentChanged: true,
      loadedMore: true,
      boundaryVerified: false,
      needsBoundaryProbe: false,
      position: { y: 400, maxY: 1_000 },
    });
  });

  it('scrolls the nearest nested container directly and reports its real position', async () => {
    const { executor, send } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'region',
          name: 'Message history',
          state: [],
          actions: ['scroll'],
          frame: 'main',
        },
      ],
      responder: (_session, method) => {
        if (method === 'Runtime.callFunctionOn') {
          return {
            result: {
              type: 'object',
              value: {
                found: true,
                beforeX: 0,
                beforeY: 120,
                afterX: 0,
                afterY: 320,
                maxX: 0,
                maxY: 800,
              },
            },
          };
        }
        return undefined;
      },
    });

    const result = await executor.execute(
      call('browser_scroll', {
        tabId: 7,
        target: 'ref_1',
        deltaX: 0,
        deltaY: 200,
      }),
      new AbortController().signal,
    );

    expect(result.data).toMatchObject({
      action: 'scroll',
      dispatched: true,
      strategy: 'element',
      moved: true,
      actualDeltaX: 0,
      actualDeltaY: 200,
      position: { x: 0, y: 320, maxX: 0, maxY: 800 },
    });
    expect(
      send.mock.calls.some(
        ([, method, params]) =>
          method === 'Input.dispatchMouseEvent' && params?.type === 'mouseWheel',
      ),
    ).toBe(false);
  });

  it('uses a trusted wheel fallback when a virtualized list loads content at its boundary', async () => {
    let wheelDispatched = false;
    const { executor, send } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'region',
          name: 'Message history',
          state: [],
          actions: ['scroll'],
          frame: 'main',
        },
      ],
      responder: (_session, method, params) => {
        if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseWheel') {
          wheelDispatched = true;
          return {};
        }
        if (
          method === 'Runtime.callFunctionOn' &&
          typeof params?.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxScrollTarget')
        ) {
          return {
            result: {
              type: 'object',
              value: {
                found: true,
                beforeX: 0,
                beforeY: 0,
                afterX: 0,
                afterY: 0,
                maxX: 0,
                maxY: 800,
                beforeContentKey: 'older-boundary',
                afterContentKey: 'older-boundary',
              },
            },
          };
        }
        if (
          method === 'Runtime.callFunctionOn' &&
          typeof params?.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxScrollState')
        ) {
          return {
            result: {
              type: 'object',
              value: {
                found: true,
                x: 0,
                y: 0,
                maxX: 0,
                maxY: 800,
                contentKey: wheelDispatched ? 'newly-loaded-history' : 'older-boundary',
              },
            },
          };
        }
        return undefined;
      },
    });

    const result = await executor.execute(
      call('browser_scroll', {
        tabId: 7,
        target: 'ref_1',
        deltaX: 0,
        deltaY: -600,
      }),
      new AbortController().signal,
    );

    expect(result.data).toMatchObject({
      action: 'scroll',
      strategy: 'element_wheel_fallback',
      moved: true,
      contentChanged: true,
      actualDeltaX: 0,
      actualDeltaY: 0,
    });
    expect(send).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mouseWheel', deltaY: -600 }),
    );
  });

  it('waits for one virtualized content batch after a direct scroll reaches the boundary', async () => {
    let wheelDispatched = false;
    let scrollSegment = 0;
    const { executor, send } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'region',
          name: 'Message history',
          state: [],
          actions: ['scroll'],
          frame: 'main',
        },
      ],
      responder: (_session, method, params) => {
        if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseWheel') {
          wheelDispatched = true;
          return {};
        }
        if (
          method === 'Runtime.callFunctionOn' &&
          typeof params?.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxScrollTarget')
        ) {
          scrollSegment += 1;
          return {
            result: {
              type: 'object',
              value:
                scrollSegment === 1
                  ? {
                      found: true,
                      beforeX: 0,
                      beforeY: 600,
                      afterX: 0,
                      afterY: 0,
                      beforeMaxX: 0,
                      beforeMaxY: 1_000,
                      maxX: 0,
                      maxY: 1_000,
                      beforeContentKey: 'visible-history',
                      afterContentKey: 'visible-history',
                    }
                  : {
                      found: true,
                      beforeX: 0,
                      beforeY: 500,
                      afterX: 0,
                      afterY: 100,
                      beforeMaxX: 0,
                      beforeMaxY: 1_500,
                      maxX: 0,
                      maxY: 1_500,
                      beforeContentKey: 'older-history-loaded',
                      afterContentKey: 'older-history-loaded',
                    },
            },
          };
        }
        if (
          method === 'Runtime.callFunctionOn' &&
          typeof params?.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxScrollState')
        ) {
          return {
            result: {
              type: 'object',
              value: {
                found: true,
                x: 0,
                y: wheelDispatched ? 500 : 0,
                maxX: 0,
                maxY: wheelDispatched ? 1_500 : 1_000,
                contentKey: wheelDispatched ? 'older-history-loaded' : 'visible-history',
              },
            },
          };
        }
        return undefined;
      },
    });

    const result = await executor.execute(
      call('browser_scroll', {
        tabId: 7,
        target: 'ref_1',
        deltaX: 0,
        deltaY: -1_000,
      }),
      new AbortController().signal,
    );

    expect(result.data).toMatchObject({
      action: 'scroll',
      strategy: 'element_boundary_wheel',
      moved: true,
      loadedMore: true,
      boundaryVerified: false,
      contentChanged: true,
      extentChanged: true,
      actualDeltaX: 0,
      actualDeltaY: -600,
      remainingDeltaX: 0,
      remainingDeltaY: -400,
      requestedDeltaApplied: false,
      segments: 1,
      position: { x: 0, y: 500, maxX: 0, maxY: 1_500 },
    });
    expect(send).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mouseWheel', deltaY: -400 }),
    );
  });

  it('reports the unconsumed delta after loading one virtualized content batch', async () => {
    let scrollSegment = 0;
    const { executor, send } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'region',
          name: 'Message history',
          state: [],
          actions: ['scroll'],
          frame: 'main',
        },
      ],
      responder: (_session, method, params) => {
        if (
          method === 'Runtime.callFunctionOn' &&
          typeof params?.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxScrollTarget')
        ) {
          scrollSegment += 1;
          return {
            result: {
              type: 'object',
              value:
                scrollSegment === 1
                  ? {
                      found: true,
                      beforeX: 0,
                      beforeY: 1_000,
                      afterX: 0,
                      afterY: 0,
                      beforeMaxX: 0,
                      beforeMaxY: 1_000,
                      maxX: 0,
                      maxY: 1_000,
                      beforeContentKey: 'recent-history',
                      afterContentKey: 'recent-history',
                    }
                  : {
                      found: true,
                      beforeX: 0,
                      beforeY: 9_000,
                      afterX: 0,
                      afterY: 1_000,
                      beforeMaxX: 0,
                      beforeMaxY: 10_000,
                      maxX: 0,
                      maxY: 10_000,
                      beforeContentKey: 'middle-history',
                      afterContentKey: 'middle-history',
                    },
            },
          };
        }
        if (
          method === 'Runtime.callFunctionOn' &&
          typeof params?.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxScrollState')
        ) {
          return {
            result: {
              type: 'object',
              value:
                scrollSegment === 1
                  ? {
                      found: true,
                      x: 0,
                      y: 9_000,
                      maxX: 0,
                      maxY: 10_000,
                      contentKey: 'middle-history',
                    }
                  : {
                      found: true,
                      x: 0,
                      y: 1_000,
                      maxX: 0,
                      maxY: 10_000,
                      contentKey: 'middle-history',
                    },
            },
          };
        }
        return undefined;
      },
    });

    const result = await executor.execute(
      call('browser_scroll', {
        tabId: 7,
        target: 'ref_1',
        deltaX: 0,
        deltaY: -9_000,
      }),
      new AbortController().signal,
    );

    expect(result.data).toMatchObject({
      action: 'scroll',
      strategy: 'element_boundary_wheel',
      moved: true,
      loadedMore: true,
      actualDeltaX: 0,
      actualDeltaY: -1_000,
      remainingDeltaX: 0,
      remainingDeltaY: -8_000,
      requestedDeltaApplied: false,
      segments: 1,
      position: { x: 0, y: 9_000, maxX: 0, maxY: 10_000 },
    });
    expect(
      send.mock.calls.filter(
        ([, method, params]) =>
          method === 'Input.dispatchMouseEvent' && params?.type === 'mouseWheel',
      ),
    ).toHaveLength(1);
  });

  it('requires a second stationary boundary probe before declaring history exhausted', async () => {
    vi.useFakeTimers();
    const { executor } = harness({
      targets: [
        {
          frameTargetId: null,
          documentFrameId: 'frame-main',
          loaderId: 'loader-1',
          backendNodeId: 42,
          role: 'region',
          name: 'Message history',
          state: [],
          actions: ['scroll'],
          frame: 'main',
        },
      ],
      responder: (_session, method, params) => {
        if (
          method === 'Runtime.callFunctionOn' &&
          typeof params?.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxScrollTarget')
        ) {
          return {
            result: {
              type: 'object',
              value: {
                found: true,
                beforeX: 0,
                beforeY: 600,
                afterX: 0,
                afterY: 0,
                beforeMaxX: 0,
                beforeMaxY: 1_000,
                maxX: 0,
                maxY: 1_000,
                beforeContentKey: 'visible-history',
                afterContentKey: 'visible-history',
              },
            },
          };
        }
        if (
          method === 'Runtime.callFunctionOn' &&
          typeof params?.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__chatbrowserxScrollState')
        ) {
          return {
            result: {
              type: 'object',
              value: {
                found: true,
                x: 0,
                y: 0,
                maxX: 0,
                maxY: 1_000,
                contentKey: 'visible-history',
              },
            },
          };
        }
        return undefined;
      },
    });

    const execution = executor.execute(
      call('browser_scroll', {
        tabId: 7,
        target: 'ref_1',
        deltaX: 0,
        deltaY: -1_000,
      }),
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await execution;

    expect(result.data).toMatchObject({
      strategy: 'element_boundary_wheel',
      moved: true,
      loadedMore: false,
      boundaryVerified: false,
      needsBoundaryProbe: true,
      position: { y: 0, maxY: 1_000 },
    });
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

  it('rejects a select action when the page retains a different value', async () => {
    const { executor } = harness({
      responder: (_session, method, params) =>
        method === 'Runtime.callFunctionOn' &&
        typeof params?.functionDeclaration === 'string' &&
        params.functionDeclaration.includes('HTMLSelectElement')
          ? { result: { type: 'object', value: { ok: true, value: 'free' } } }
          : undefined,
    });

    await expect(
      executor.execute(
        call('browser_select', { tabId: 7, ref: 'ref_1', value: 'pro' }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'ACTION_STATE_MISMATCH' });
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

  it('waits for in-flight requests to finish before declaring network idle', async () => {
    vi.useFakeTimers();
    let listener: Parameters<DebuggerTransport['onEvent']>[0] | undefined;
    const { executor, send } = harness({
      onEvent: (received) => {
        listener = received;
        return () => undefined;
      },
    });
    let settled = false;
    const waiting = executor
      .execute(
        call('browser_wait', {
          tabId: 7,
          condition: 'network_idle',
          timeoutMs: 2_000,
        }),
        new AbortController().signal,
      )
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ tabId: 7 }, 'Network.enable'));
    listener?.({ tabId: 7 }, 'Network.requestWillBeSent', {
      requestId: 'request_1',
    });

    await vi.advanceTimersByTimeAsync(600);
    expect(settled).toBe(false);

    listener?.({ tabId: 7 }, 'Network.loadingFinished', {
      requestId: 'request_1',
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(waiting).resolves.toMatchObject({
      data: { action: 'wait', condition: 'network_idle', completed: true },
    });
  });
});
