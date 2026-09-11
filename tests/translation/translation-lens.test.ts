import { afterEach, expect, it, vi } from 'vitest';
import {
  toggleTranslationLens,
  getTranslationSession,
  closeTranslationLens,
} from '../../src/page/translation/mount-translation-lens';
import type { RuntimePort } from '../../src/platform/chrome/runtime-port';
import type { ExtensionMessage, ExtensionResponse } from '../../src/shared/protocol/message-types';
import { inspectionFixture } from './inspection-fixture';

const options = (sessionId: string) => ({
  sessionId,
  loadingText: '翻译中…',
  errorText: '翻译失败，移动镜框可重试',
});

it('acknowledges opening before scanning a potentially expensive page layout', () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<p>A large page</p>';
  const layout = vi.spyOn(Element.prototype, 'getBoundingClientRect');
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

it('keeps valid image lines and reports incomplete output without an automatic request loop', async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  const attach = Element.prototype.attachShadow;
  let shadow!: ShadowRoot;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) {
    shadow = attach.call(this, init);
    return shadow;
  });
  const send = vi.fn<RuntimePort['send']>(async (m) =>
    m.type === 'translation.inspect'
      ? inspectionFixture(m)
      : {
          version: 1,
          requestId: m.requestId,
          ok: true,
          data:
            m.type === 'translation.getState'
              ? { active: true }
              : {
                  incomplete: true,
                  blocks: [
                    { text: 'A valid line', translation: '有效译文', box: [100, 100, 200, 40] },
                  ],
                  colors: [],
                },
        },
  );
  toggleTranslationLens(options('partial'), document, window, { send });
  await vi.advanceTimersByTimeAsync(6000);
  expect(shadow.querySelector('.text')?.textContent).toBe('有效译文');
  expect(
    document.querySelector<HTMLElement>('[data-chatbrowserx-overlay="translation"]')?.dataset
      .status,
  ).toBe('error');
  expect(send.mock.calls.filter(([m]) => m.type === 'translation.read')).toHaveLength(1);
});

it('closes against native tab state even when focus emulation hides the visibility change', async () => {
  vi.useFakeTimers();
  const send: RuntimePort['send'] = async (m) => ({
    version: 1,
    requestId: m.requestId,
    ok: true,
    data: m.type === 'translation.getState' ? { active: false } : { blocks: [], colors: [] },
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
});

it.each(['pagehide', 'hidden', 'dispose'])(
  'fully closes on %s, with no later captures',
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

it('does not render a stale result after the page scrolls during a model request', async () => {
  vi.useFakeTimers();
  const reads: { message: ExtensionMessage; finish: (r: ExtensionResponse) => void }[] = [];
  const runtime: RuntimePort = {
    send: async (m) =>
      m.type === 'translation.inspect'
        ? inspectionFixture(m)
        : m.type === 'translation.read'
          ? new Promise((resolve) => reads.push({ message: m, finish: resolve }))
          : { version: 1, requestId: m.requestId, ok: true, data: { active: true } },
  };
  toggleTranslationLens(options('moving'), document, window, runtime);
  await vi.advanceTimersByTimeAsync(900);
  window.dispatchEvent(new Event('scroll'));
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: 130, clientY: 140 }));
  const first = reads[0];
  if (!first) throw new Error('Translation request missing.');
  first.finish({
    version: 1,
    requestId: first.message.requestId,
    ok: true,
    data: { blocks: [{ text: 'old', translation: '过期译文', box: [0, 0, 100, 100] }], colors: [] },
  });
  await vi.advanceTimersByTimeAsync(16);
  expect(
    document.querySelector<HTMLElement>('[data-chatbrowserx-overlay="translation"]')?.dataset
      .status,
  ).toBe('waiting');
  await vi.advanceTimersByTimeAsync(900);
  expect(reads).toHaveLength(2);
  expect(reads[1]?.message.payload).toMatchObject({ rect: { x: 0, y: 0 } });
});

it('refreshes pixels after an image finishes loading inside the frame', async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<img alt="Translated image" />';
  const img = document.querySelector('img');
  if (!img) throw new Error('Image fixture missing.');
  vi.spyOn(img, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, 350, 80, 40));
  const send = vi.fn<RuntimePort['send']>(async (m) => ({
    version: 1,
    requestId: m.requestId,
    ok: true,
    ...(m.type === 'translation.inspect'
      ? inspectionFixture(m, img?.getAttribute('src') ?? 'empty')
      : {
          data: m.type === 'translation.getState' ? { active: true } : { blocks: [], colors: [] },
        }),
  }));
  toggleTranslationLens(options('image'), document, window, { send });
  await vi.advanceTimersByTimeAsync(900);
  img.dispatchEvent(new Event('load'));
  img.setAttribute('src', 'loaded.png');
  await vi.advanceTimersByTimeAsync(4000);
  expect(send.mock.calls.filter(([m]) => m.type === 'translation.read')).toHaveLength(2);
});

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
      ...(m.type === 'translation.inspect'
        ? inspectionFixture(m)
        : { data: { blocks: [], colors: [] } }),
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
      payload: { sessionId: 'one', close: true },
    }),
  ]);
});

it('ignores a response completing after Escape instead of reopening the overlay', async () => {
  vi.useFakeTimers();
  let resolveRead!: (value: ExtensionResponse) => void;
  let read: ExtensionMessage | undefined;
  const runtime: RuntimePort = {
    send: async (m) => {
      if (m.type === 'translation.inspect') return inspectionFixture(m);
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
    data: { blocks: [], colors: [] },
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
      m.type === 'translation.inspect'
        ? Promise.resolve(inspectionFixture(m))
        : m.type === 'translation.read'
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
    finish({ version: 1, requestId: 'loading:1', ok: true, data: { blocks: [], colors: [] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(status?.hidden).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

it('invalidates translated pixels when visible page text changes without pointer movement', async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<main style="background-image:url(image.png)">Old text</main>';
  const main = document.querySelector('main');
  if (!main?.firstChild) throw new Error('Text fixture missing.');
  vi.spyOn(main, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, 350, 50, 20));
  const send = vi.fn<RuntimePort['send']>(async (m) => ({
    version: 1,
    requestId: m.requestId,
    ok: true,
    ...(m.type === 'translation.inspect'
      ? inspectionFixture(m, main.textContent ?? '')
      : {
          data: m.type === 'translation.getState' ? { active: true } : { blocks: [], colors: [] },
        }),
  }));
  toggleTranslationLens(options('dynamic'), document, window, { send });
  await vi.advanceTimersByTimeAsync(900);
  expect(send.mock.calls.filter(([m]) => m.type === 'translation.read')).toHaveLength(1);
  main.firstChild.textContent = 'New text';
  await vi.advanceTimersByTimeAsync(4000);
  expect(send.mock.calls.filter(([m]) => m.type === 'translation.read')).toHaveLength(2);
});
