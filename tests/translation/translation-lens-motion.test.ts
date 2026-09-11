import { afterEach, expect, it, vi } from 'vitest';
import {
  closeTranslationLens,
  toggleTranslationLens,
} from '../../src/page/translation/mount-translation-lens';
import type { RuntimePort } from '../../src/platform/chrome/runtime-port';
import type { ExtensionMessage, ExtensionResponse } from '../../src/shared/protocol/message-types';
import { translationSelectionSchema } from '../../src/translation/region-translation';
import { inspectionFixture } from './inspection-fixture';
import { extensionMessageSchema } from '../../src/shared/protocol/message-schema';

const translated = {
  blocks: [{ text: 'Original text', translation: '原始文字', box: [400, 400, 100, 40] }],
  colors: [{ background: 'rgb(255,255,255)', color: '#172642' }],
};

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Translation test fixture missing.');
  return value;
}

function setup() {
  vi.useFakeTimers();
  vi.stubGlobal('innerWidth', 1200);
  vi.stubGlobal('innerHeight', 800);
  document.body.innerHTML = '<main>Original text</main>';
  const attach = Element.prototype.attachShadow;
  let shadow!: ShadowRoot;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) {
    shadow = attach.call(this, init);
    return shadow;
  });
  const reads: { message: ExtensionMessage; finish: (value: ExtensionResponse) => void }[] = [];
  let notify: ((value: unknown) => void) | undefined;
  const unsubscribe = vi.fn(() => {
    notify = undefined;
  });
  const send = vi.fn<RuntimePort['send']>(async (m) =>
    m.type === 'translation.inspect'
      ? inspectionFixture(m, document.querySelector('main')?.innerHTML)
      : m.type === 'translation.read'
        ? new Promise((resolve) => reads.push({ message: m, finish: resolve }))
        : { version: 1, requestId: m.requestId, ok: true, data: { active: true } },
  );
  toggleTranslationLens(
    { sessionId: 'motion', loadingText: '翻译中…', errorText: '翻译失败' },
    document,
    window,
    {
      send,
      subscribe: (listener) => {
        notify = listener;
        return unsubscribe;
      },
    },
  );
  return {
    reads,
    unsubscribe,
    progress(index: number, result: unknown = translated, overrides = {}) {
      notify?.({
        version: 1,
        type: 'translation.progress',
        sessionId: 'motion',
        requestId: required(reads[index]).message.requestId,
        result,
        ...overrides,
      });
    },
    shadow,
    frame: required(shadow.querySelector<HTMLElement>('.frame')),
    notice: required(shadow.querySelector<HTMLElement>('[role=status]')),
    host: required(document.querySelector<HTMLElement>('[data-chatbrowserx-overlay=translation]')),
    cancellations: () => send.mock.calls.filter(([m]) => m.type === 'translation.cancel'),
    finish(index: number, data: unknown = translated) {
      const read = required(reads[index]);
      read.finish({ version: 1, requestId: read.message.requestId, ok: true, data });
    },
  };
}

function move(x: number, y = 400) {
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y }));
}

afterEach(() => {
  closeTranslationLens();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('shows streamed image blocks while loading and caches only the completed response', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(900);
  lens.progress(0);
  expect(lens.shadow.querySelector('.text')?.textContent).toBe('原始文字');
  expect(lens.host.dataset.status).toBe('loading');
  const frame = lens.frame;
  move(640);
  await vi.advanceTimersByTimeAsync(1200);
  expect(lens.host.dataset.status).toBe('loading');
  expect(lens.reads).toHaveLength(1);
  lens.finish(0);
  await vi.advanceTimersByTimeAsync(20);
  expect(lens.shadow.querySelectorAll('.text')).toHaveLength(1);
  expect(lens.frame).toBe(frame);
  expect(lens.host.dataset.status).toBe('ready');
  expect(lens.unsubscribe).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3000);
  expect(lens.reads).toHaveLength(1);
});

it('rejects unrelated, malformed and stale progress notifications', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(900);
  for (const overrides of [{ requestId: 'other' }, { sessionId: 'other' }, { version: 2 }])
    lens.progress(0, translated, overrides);
  lens.progress(0, {
    blocks: [{ text: 'invalid', translation: 'invalid', box: [900, 20, 300, 40] }],
    colors: [],
  });
  expect(lens.shadow.querySelectorAll('.text')).toHaveLength(0);
  lens.progress(0);
  expect(lens.shadow.querySelectorAll('.text')).toHaveLength(1);
  window.dispatchEvent(new Event('scroll'));
  lens.progress(0);
  expect(lens.shadow.querySelectorAll('.text')).toHaveLength(0);
  lens.finish(0);
  await vi.advanceTimersByTimeAsync(20);
  expect(lens.shadow.querySelectorAll('.text')).toHaveLength(0);
});

it('discards preview coverage on failure and does not retry until movement', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(900);
  lens.progress(0);
  expect(lens.shadow.querySelectorAll('.text')).toHaveLength(1);
  const read = required(lens.reads[0]);
  read.finish({
    version: 1,
    requestId: read.message.requestId,
    ok: false,
    error: { code: 'INVALID_RESPONSE', message: 'failed' },
  });
  await vi.advanceTimersByTimeAsync(3000);
  expect(lens.shadow.querySelectorAll('.text')).toHaveLength(0);
  expect(lens.host.dataset.status).toBe('error');
  expect(lens.reads).toHaveLength(1);
  move(620);
  await vi.advanceTimersByTimeAsync(2000);
  expect(lens.reads).toHaveLength(2);
});

it('removes the progress listener immediately when closing during a request', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(900);
  lens.progress(0);
  closeTranslationLens();
  expect(lens.unsubscribe).toHaveBeenCalledTimes(1);
  lens.progress(0);
  expect(lens.host.isConnected).toBe(false);
  lens.finish(0);
  await vi.advanceTimersByTimeAsync(20);
});

it('moves the observation window without clearing, repositioning or retranslating covered text', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(900);
  lens.finish(0);
  await vi.advanceTimersByTimeAsync(20);
  const text = required(lens.shadow.querySelector<HTMLElement>('.text'));
  const position = text.style.cssText;
  const frameLeft = lens.frame.style.left;
  for (let x = 601; x <= 660; x += 3) {
    move(x);
    await vi.advanceTimersByTimeAsync(20);
    expect(lens.host.dataset.status).toBe('ready');
    expect(text.isConnected).toBe(true);
    expect(text.style.cssText).toBe(position);
    expect(lens.notice.hidden).toBe(true);
  }
  expect(lens.frame.style.left).not.toBe(frameLeft);
  await vi.advanceTimersByTimeAsync(1000);
  expect(lens.reads).toHaveLength(1);
  expect(lens.cancellations()).toHaveLength(0);
});

it('keeps an in-flight capture useful when the lens moves within its buffered region', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(900);
  const selection = translationSelectionSchema.parse(required(lens.reads[0]).message.payload);
  expect(selection.rect.x).toBeLessThan(350);
  expect(selection.rect.y).toBeLessThan(270);
  expect(selection.rect.x + selection.rect.width).toBeGreaterThan(850);
  move(640);
  await vi.advanceTimersByTimeAsync(1000);
  expect(lens.reads).toHaveLength(1);
  expect(lens.cancellations()).toHaveLength(0);
  lens.finish(0);
  await vi.advanceTimersByTimeAsync(20);
  expect(lens.host.dataset.status).toBe('ready');
  expect(lens.shadow.querySelector('.text')?.textContent).toBe('原始文字');
});

it('retains existing translations while filling a new region and reuses their union on return', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(900);
  lens.finish(0);
  await vi.advanceTimersByTimeAsync(20);
  const first = required(lens.shadow.querySelector<HTMLElement>('.text'));
  const position = first.style.cssText;
  const originalClip = required(first.parentElement).style.clipPath;
  move(950);
  await vi.advanceTimersByTimeAsync(900);
  expect(lens.reads).toHaveLength(2);
  expect(first.isConnected).toBe(true);
  expect(first.style.cssText).toBe(position);
  expect(lens.notice.hidden).toBe(false);
  lens.finish(1);
  await vi.advanceTimersByTimeAsync(20);
  expect(required(first.parentElement).style.clipPath).toBe(originalClip);
  // This window straddles the two captures: neither capture alone covers it.
  move(800);
  await vi.advanceTimersByTimeAsync(1000);
  expect(lens.host.dataset.status).toBe('ready');
  move(600);
  await vi.advanceTimersByTimeAsync(1000);
  expect(lens.host.dataset.status).toBe('ready');
  expect(lens.reads).toHaveLength(2);
  expect(first.isConnected).toBe(true);
});

it('resizes only the lens, without resizing translated text or requesting covered pixels again', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(900);
  lens.finish(0);
  await vi.advanceTimersByTimeAsync(20);
  const text = required(lens.shadow.querySelector<HTMLElement>('.text'));
  const position = text.style.cssText;
  const width = lens.frame.style.width;
  window.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -10, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1000);
  expect(lens.frame.style.width).not.toBe(width);
  expect(text.isConnected).toBe(true);
  expect(text.style.cssText).toBe(position);
  expect(lens.reads).toHaveLength(1);
  expect(lens.host.dataset.status).toBe('ready');
});

it('remembers successfully examined regions even when they contain no translatable text', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(900);
  lens.finish(0, { blocks: [], colors: [] });
  await vi.advanceTimersByTimeAsync(20);
  move(640);
  await vi.advanceTimersByTimeAsync(1000);
  expect(lens.reads).toHaveLength(1);
  expect(lens.host.dataset.status).toBe('ready');
});

it('does not let blank pixels in an older capture hide newly translated text', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(900);
  lens.finish(0);
  await vi.advanceTimersByTimeAsync(20);
  move(950);
  await vi.advanceTimersByTimeAsync(900);
  lens.finish(1, {
    blocks: [{ text: 'New paragraph', translation: '新段落', box: [100, 400, 200, 40] }],
    colors: [{ background: 'rgb(255,255,255)', color: '#172642' }],
  });
  await vi.advanceTimersByTimeAsync(20);
  const layers = [...lens.shadow.querySelectorAll<HTMLElement>('.patch')];
  const clip = required(layers[1]).style.clipPath;
  // Independently read the renderer's rectangle paths. (700,365) is inside the new text,
  // within the old capture, but outside the old text (x=534..600).
  const rectangles = [...clip.matchAll(/M\s*([\d.]+)\s+([\d.]+)\s*h\s*([\d.]+)\s*v\s*([\d.]+)/g)];
  expect(
    rectangles.some((m) => {
      const x = Number(m[1]),
        y = Number(m[2]),
        w = Number(m[3]),
        h = Number(m[4]);
      return 700 >= x && 700 < x + w && 365 >= y && 365 < y + h;
    }),
  ).toBe(true);
});

it('does not reuse cached translations after scrolling changes the underlying pixels', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(900);
  lens.finish(0);
  await vi.advanceTimersByTimeAsync(20);
  window.dispatchEvent(new Event('scroll'));
  expect(lens.shadow.querySelectorAll('.text')).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(900);
  expect(lens.reads).toHaveLength(2);
});

it('invalidates cached pixels even when a layout change occurs outside the current lens', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(900);
  lens.finish(0);
  await vi.advanceTimersByTimeAsync(20);
  move(950);
  await vi.advanceTimersByTimeAsync(900);
  // Insertion above the captures can shift all following content, even if the inserted node
  // itself is outside the lens. No old response may restore the previous layout's pixels.
  const first = required(lens.shadow.querySelector<HTMLElement>('.text'));
  required(document.querySelector('main')).prepend(document.createElement('header'));
  await vi.advanceTimersByTimeAsync(1000);
  expect(first.isConnected).toBe(false);
  expect(lens.cancellations()).toHaveLength(1);
  lens.finish(1);
  await vi.advanceTimersByTimeAsync(20);
  expect([...lens.shadow.querySelectorAll('.text')]).toEqual([]);
  await vi.advanceTimersByTimeAsync(4000);
  expect(lens.reads).toHaveLength(3);
});

it('preserves good cached results when another region fails, without an automatic retry loop', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(900);
  lens.finish(0);
  await vi.advanceTimersByTimeAsync(20);
  const first = required(lens.shadow.querySelector('.text'));
  move(950);
  await vi.advanceTimersByTimeAsync(900);
  const second = required(lens.reads[1]);
  second.finish({
    version: 1,
    requestId: second.message.requestId,
    ok: false,
    error: { code: 'INVALID_RESPONSE', message: 'Translation failed.' },
  });
  await vi.advanceTimersByTimeAsync(5000);
  expect(lens.host.dataset.status).toBe('error');
  expect(first.isConnected).toBe(true);
  expect(lens.reads).toHaveLength(2);
  move(600);
  await vi.advanceTimersByTimeAsync(1000);
  expect(lens.host.dataset.status).toBe('ready');
  expect(lens.reads).toHaveLength(2);
});

it('cancels a completely unrelated capture and never paints its late response', async () => {
  const lens = setup();
  vi.stubGlobal('innerWidth', 2400);
  await vi.advanceTimersByTimeAsync(900);
  move(2000);
  await vi.advanceTimersByTimeAsync(20);
  expect(lens.cancellations()).toHaveLength(1);
  lens.finish(0);
  await vi.advanceTimersByTimeAsync(900);
  expect(lens.shadow.querySelectorAll('.text')).toHaveLength(0);
  expect(lens.reads).toHaveLength(2);
  expect(
    translationSelectionSchema.parse(required(lens.reads[1]).message.payload).rect.x,
  ).toBeGreaterThan(1500);
});

it('bounds retained layers after many regions and requests an evicted region again', async () => {
  const lens = setup();
  vi.stubGlobal('innerWidth', 5000);
  for (const [index, x] of [600, 1400, 2200, 3000, 3800, 4600].entries()) {
    move(x);
    await vi.advanceTimersByTimeAsync(2000);
    lens.finish(index);
    await vi.advanceTimersByTimeAsync(20);
    expect(lens.shadow.querySelectorAll('.text').length).toBeLessThanOrEqual(4);
  }
  move(600);
  await vi.advanceTimersByTimeAsync(2000);
  expect(lens.reads).toHaveLength(7);
  expect(lens.notice.hidden).toBe(false);
});

it('keeps buffered captures inside the viewport and protocol limits at the viewport edge', async () => {
  const lens = setup();
  vi.stubGlobal('innerWidth', 2000);
  vi.stubGlobal('innerHeight', 1200);
  window.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -138 }));
  move(1990, 1190);
  await vi.advanceTimersByTimeAsync(2000);
  const selection = translationSelectionSchema.parse(required(lens.reads[0]).message.payload);
  expect(selection.rect.width).toBeGreaterThan(1000);
  expect(selection.rect.height).toBeGreaterThan(520);
  expect(selection.rect.x + selection.rect.width).toBe(2000);
  expect(selection.rect.y + selection.rect.height).toBe(1200);
});

it('expands to the viewport and shrinks immediately even after repeated zoom-in at the limit', async () => {
  const lens = setup();
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

it('finishes every part of a full 4K viewport in bounded image requests without evicting visible results', async () => {
  const lens = setup();
  vi.stubGlobal('innerWidth', 3840);
  vi.stubGlobal('innerHeight', 2160);
  window.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -1000 }));
  for (let i = 0; i < 12; i++) {
    await vi.advanceTimersByTimeAsync(2000);
    expect(
      lens.reads.length,
      `crop ${i}, status ${lens.host.dataset.status}, ${lens.notice.textContent}`,
    ).toBeGreaterThan(i);
    const message = required(lens.reads[i]).message;
    expect(extensionMessageSchema.safeParse(message).success).toBe(true);
    const { rect } = translationSelectionSchema.parse(message.payload);
    expect(rect.width).toBeLessThanOrEqual(1200);
    expect(rect.height).toBeLessThanOrEqual(800);
    lens.finish(i);
  }
  await vi.advanceTimersByTimeAsync(3000);
  expect(lens.host.dataset.status).toBe('ready');
  expect(lens.reads).toHaveLength(12);
  expect(lens.shadow.querySelectorAll('.text')).toHaveLength(12);
});

it('does not invalidate cached content for extension-only overlay changes', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(900);
  lens.finish(0);
  await vi.advanceTimersByTimeAsync(20);
  const overlay = document.createElement('div');
  overlay.dataset.chatbrowserxOverlay = 'image-preview';
  document.body.append(overlay);
  lens.host.style.visibility = 'hidden';
  await vi.advanceTimersByTimeAsync(20);
  overlay.remove();
  lens.host.style.visibility = 'visible';
  await vi.advanceTimersByTimeAsync(1000);
  expect(lens.reads).toHaveLength(1);
  expect(lens.host.dataset.status).toBe('ready');
});

it('does not rewrite the loading notice on every frame while the same request is pending', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(900);
  const changes: MutationRecord[] = [];
  const observer = new MutationObserver((records) => changes.push(...records));
  observer.observe(lens.notice, { childList: true });
  try {
    for (const x of [620, 630, 610]) {
      move(x);
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(changes).toHaveLength(0);
    expect(lens.notice.textContent).toBe('翻译中…');
  } finally {
    observer.disconnect();
  }
});
