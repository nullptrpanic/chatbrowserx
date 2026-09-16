import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  toggleTranslationLens,
  getTranslationSession,
  closeTranslationLens,
} from '../../src/page/translation/mount-translation-lens';
import type { RuntimePort } from '../../src/platform/chrome/runtime-port';
import type { ExtensionMessage, ExtensionResponse } from '../../src/shared/protocol/message-types';
beforeEach(() => {
  document.body.replaceChildren();
  vi.stubGlobal('innerWidth', 1200);
  vi.stubGlobal('innerHeight', 800);
  document.body.innerHTML = '<p style="font:20px/24px Arial">Original text</p>';
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.matches('p') ? new DOMRect(400, 350, 300, 24) : new DOMRect(0, 0, 1200, 800);
  });
  const create = document.createRange.bind(document);
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = create();
    range.getClientRects = () =>
      range.startContainer.nodeType === Node.TEXT_NODE
        ? ([new DOMRect(400, 350, 150, 24)] as unknown as DOMRectList)
        : ([] as unknown as DOMRectList);
    return range;
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillRect() {},
    getImageData: () => ({ data: new Uint8ClampedArray([255, 255, 255, 255]) }),
    measureText: (text: string) => ({ width: text.length * 8 }),
  } as unknown as CanvasRenderingContext2D);
});

const options = (sessionId: string) => ({
  sessionId,
  loadingText: '翻译中…',
  errorText: '翻译失败，移动镜框可重试',
  unsupportedText: 'Unsupported content',
  retryText: 'Retry',
});

it('acknowledges opening before scanning a potentially expensive page layout', () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<p>A large page</p>';
  const layout = vi.mocked(Element.prototype.getBoundingClientRect);
  layout.mockClear();
  const send = vi.fn<RuntimePort['send']>(async (m) => ({
    version: 1,
    requestId: m.requestId,
    ok: true,
    data: {},
  }));
  try {
    expect(toggleTranslationLens(options('deferred'), document, window, { send })).toBe(true);
    expect(getTranslationSession()).toBe('deferred');
    expect(layout).not.toHaveBeenCalled();
  } finally {
    closeTranslationLens();
    document.body.innerHTML = '';
  }
});

it('closes against native tab state even when focus emulation hides the visibility change', async () => {
  vi.useFakeTimers();
  const send: RuntimePort['send'] = async (m) => ({
    version: 1,
    requestId: m.requestId,
    ok: true,
    data:
      m.type === 'translation.getState'
        ? { active: false }
        : { blocks: [{ id: 'text-1', translation: '原始文字' }] },
  });
  toggleTranslationLens(options('native'), document, window, { send });
  await vi.advanceTimersByTimeAsync(900);
  expect(document.hidden).toBe(false);
  expect(getTranslationSession()).toBe('native');
  await vi.advanceTimersByTimeAsync(1100);
  expect(getTranslationSession()).toBeNull();
});

afterEach(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it.each(['pagehide', 'hidden', 'dispose'])(
  'fully closes on %s, with no later translation requests',
  async (reason) => {
    vi.useFakeTimers();
    const send = vi.fn<RuntimePort['send']>(async (m) => ({
      version: 1,
      requestId: m.requestId,
      ok: true,
      data: {},
    }));
    toggleTranslationLens(options('closing'), document, window, { send });
    expect(getTranslationSession()).toBe('closing');
    if (reason === 'pagehide') window.dispatchEvent(new Event('pagehide'));
    else if (reason === 'dispose') closeTranslationLens();
    else {
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
    }
    expect(getTranslationSession()).toBeNull();
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 150, clientY: 160 }));
    window.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(send.mock.calls.map(([m]) => m.type)).toEqual(['translation.cancel']);
  },
);

it('works on HTTP pages where randomUUID is unavailable', async () => {
  vi.useFakeTimers();
  const uuid = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
    throw new Error('Secure context required');
  });
  try {
    const send = vi.fn<RuntimePort['send']>(async (m) => ({
      version: 1,
      requestId: m.requestId,
      ok: true,
      data: { blocks: [{ id: 'text-1', translation: '原始文字' }] },
    }));
    toggleTranslationLens(options('session'), document, window, { send });
    await vi.advanceTimersByTimeAsync(900);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'translation.read' }));
  } finally {
    uuid.mockRestore();
  }
});

it('closes on a second toggle without changing original page content', () => {
  document.body.innerHTML = '<main>Original text</main>';
  const sent: ExtensionMessage[] = [];
  const runtime: RuntimePort = {
    send: async (m) => {
      sent.push(m);
      return { version: 1, requestId: m.requestId, ok: true, data: {} };
    },
  };
  expect(toggleTranslationLens(options('one'), document, window, runtime)).toBe(true);
  expect(document.querySelector('[data-chatbrowserx-overlay="translation"]')).not.toBeNull();
  expect(toggleTranslationLens(options('two'), document, window, runtime)).toBe(false);
  expect(document.querySelector('[data-chatbrowserx-overlay="translation"]')).toBeNull();
  expect(document.querySelector('main')?.textContent).toBe('Original text');
  expect(sent).toEqual([
    expect.objectContaining({
      type: 'translation.cancel',
      payload: { sessionId: 'one' },
    }),
  ]);
});

it('ignores a response completing after Escape instead of reopening the overlay', async () => {
  vi.useFakeTimers();
  let resolveRead!: (value: ExtensionResponse) => void;
  let read: ExtensionMessage | undefined;
  const runtime: RuntimePort = {
    send: async (m) => {
      if (m.type === 'translation.read') {
        read = m;
        return new Promise((resolve) => {
          resolveRead = resolve;
        });
      }
      return { version: 1, requestId: m.requestId, ok: true, data: {} };
    },
  };
  toggleTranslationLens(options('s'), document, window, runtime);
  await vi.advanceTimersByTimeAsync(900);
  expect(read?.type).toBe('translation.read');
  if (!read) throw new Error('Translation request was not sent.');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  resolveRead({
    version: 1,
    requestId: read.requestId,
    ok: true,
    data: { blocks: [{ id: 'text-1', translation: '原始文字' }] },
  });
  await vi.advanceTimersByTimeAsync(900);
  expect(document.querySelector('[data-chatbrowserx-overlay="translation"]')).toBeNull();
});

it('shows a localized pending label outside the frame until the current translation finishes', async () => {
  vi.useFakeTimers();
  const attach = Element.prototype.attachShadow;
  let shadow!: ShadowRoot;
  const spy = vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (
    this: Element,
    init,
  ) {
    shadow = attach.call(this, init);
    return shadow;
  });
  let finish!: (value: ExtensionResponse) => void;
  const runtime: RuntimePort = {
    send: async (m) =>
      m.type === 'translation.read'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : { version: 1, requestId: m.requestId, ok: true, data: {} },
  };
  try {
    toggleTranslationLens(options('loading'), document, window, runtime);
    await vi.advanceTimersByTimeAsync(900);
    const status = shadow.querySelector<HTMLElement>('[role="status"]');
    const frame = shadow.querySelector<HTMLElement>('.frame');
    expect(status).not.toBeNull();
    if (!status || !frame) throw new Error('Translation UI missing.');
    expect(status?.textContent).toBe('翻译中…');
    expect(status?.hidden).toBe(false);
    expect(Number.parseFloat(status.style.top)).toBeLessThan(Number.parseFloat(frame.style.top));
    finish({
      version: 1,
      requestId: 'loading:1',
      ok: true,
      data: { blocks: [{ id: 'text-1', translation: '原始文字' }] },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(status?.hidden).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

it('leaves unsupported backgrounds native when their text changes without pointer movement', async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<main style="background-image:url(image.png)">Old text</main>';
  const main = document.querySelector('main');
  if (!main?.firstChild) throw new Error('Text fixture missing.');
  vi.spyOn(main, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, 350, 50, 20));
  const send = vi.fn<RuntimePort['send']>(async (m) => ({
    version: 1,
    requestId: m.requestId,
    ok: true,
    data:
      m.type === 'translation.getState'
        ? { active: true }
        : { blocks: [{ id: 'text-1', translation: '原始文字' }] },
  }));
  toggleTranslationLens(options('dynamic'), document, window, { send });
  await vi.advanceTimersByTimeAsync(900);
  expect(send.mock.calls.filter(([m]) => m.type === 'translation.read')).toHaveLength(0);
  main.firstChild.textContent = 'New text';
  await vi.advanceTimersByTimeAsync(4000);
  expect(send.mock.calls.filter(([m]) => m.type === 'translation.read')).toHaveLength(0);
});

it('expands to the viewport and shrinks immediately even after repeated zoom-in at the limit', async () => {
  vi.useFakeTimers();
  const attach = Element.prototype.attachShadow;
  let shadow!: ShadowRoot;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) {
    shadow = attach.call(this, init);
    return shadow;
  });
  toggleTranslationLens(options('resize'), document, window, {
    send: async (m) => ({
      version: 1,
      requestId: m.requestId,
      ok: true,
      data: { active: true },
    }),
  });
  const frame = shadow.querySelector<HTMLElement>('.frame');
  const notice = shadow.querySelector<HTMLElement>('[role=status]');
  if (!frame || !notice) throw new Error('Missing lens UI');
  const lens = { frame, notice };
  vi.stubGlobal('innerWidth', 2000);
  vi.stubGlobal('innerHeight', 1200);
  for (let i = 0; i < 5; i++)
    window.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -1000 }));
  await vi.advanceTimersByTimeAsync(20);
  expect(lens.frame.style.width).toBe('2000px');
  expect(lens.frame.style.height).toBe('1200px');
  expect(lens.frame.style.left).toBe('0px');
  expect(lens.frame.style.top).toBe('0px');
  expect(Number.parseFloat(lens.notice.style.top)).toBeGreaterThanOrEqual(0);
  expect(Number.parseFloat(lens.notice.style.top) + 24).toBeLessThanOrEqual(1200);
  window.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: 10 }));
  await vi.advanceTimersByTimeAsync(20);
  expect(Number.parseFloat(lens.frame.style.height)).toBeLessThan(1200);
  vi.stubGlobal('innerWidth', 900);
  vi.stubGlobal('innerHeight', 600);
  window.dispatchEvent(new Event('resize'));
  await vi.advanceTimersByTimeAsync(20);
  expect(lens.frame.style.width).toBe('900px');
  expect(lens.frame.style.height).toBe('600px');
  window.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: 10 }));
  await vi.advanceTimersByTimeAsync(20);
  expect(Number.parseFloat(lens.frame.style.height)).toBeLessThan(600);
});
