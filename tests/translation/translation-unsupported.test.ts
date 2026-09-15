import { afterEach, expect, it, vi } from 'vitest';
import {
  closeTranslationLens,
  toggleTranslationLens,
} from '../../src/page/translation/mount-translation-lens';
import type { RuntimePort } from '../../src/platform/chrome/runtime-port';
import { staticImageFixture } from './image-fixture';

afterEach(() => {
  closeTranslationLens();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  vi.useFakeTimers();
  vi.stubGlobal('innerWidth', 1200);
  vi.stubGlobal('innerHeight', 800);
  const getDisplayMedia = vi.fn();
  vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getDisplayMedia } });
  const attach = Element.prototype.attachShadow;
  let shadow!: ShadowRoot;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) {
    shadow = attach.call(this, init);
    return shadow;
  });
  const send = vi.fn<RuntimePort['send']>(async (m) => ({
    version: 1,
    requestId: m.requestId,
    ok: true,
    data:
      m.type === 'translation.getState'
        ? { active: true }
        : {
            blocks: [{ text: 'Image', translation: '图片', box: [100, 100, 200, 100] }],
            colors: [],
          },
  }));
  const open = () =>
    toggleTranslationLens(
      {
        sessionId: 'unsupported',
        loadingText: 'Loading',
        errorText: 'Failed',
        unsupportedText: 'Unsupported content',
        retryText: 'Retry',
      },
      document,
      window,
      { send },
    );
  return { open, send, getDisplayMedia, shadow: () => shadow };
}

it('leaves unsupported pixels native without a sharing action, capture or perpetual loading', async () => {
  const lens = setup();
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => new DOMRect(350, 270, 500, 260);
  document.body.append(canvas);
  lens.open();
  await vi.advanceTimersByTimeAsync(6000);
  const host = document.querySelector<HTMLElement>('[data-chatbrowserx-overlay=translation]');
  expect(host?.dataset.status).toBe('unsupported');
  expect(lens.shadow().querySelector<HTMLButtonElement>('button')?.hidden).toBe(true);
  expect(lens.shadow().querySelectorAll('.text')).toHaveLength(0);
  expect(lens.send.mock.calls.filter(([m]) => m.type === 'translation.read')).toHaveLength(0);
  expect(lens.getDisplayMedia).not.toHaveBeenCalled();
  expect(canvas.isConnected).toBe(true);
});

it('translates a readable image even beside unsupported pixels and an unreadable image', async () => {
  const lens = setup();
  const { image } = staticImageFixture();
  const broken = image.cloneNode() as HTMLImageElement;
  broken.getBoundingClientRect = () => new DOMRect(370, 280, 40, 40);
  broken.getAnimations = () => [];
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => new DOMRect(800, 280, 40, 40);
  document.body.append(broken, canvas);
  lens.open();
  await vi.advanceTimersByTimeAsync(6000);
  expect(lens.shadow().querySelector('.text')?.textContent).toBe('图片');
  expect(lens.send.mock.calls.filter(([m]) => m.type === 'translation.read')).toHaveLength(1);
  expect(lens.getDisplayMedia).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(6000);
  expect(lens.send.mock.calls.filter(([m]) => m.type === 'translation.read')).toHaveLength(1);
});

it('treats an empty area as complete instead of asking for screen sharing', async () => {
  const lens = setup();
  document.body.replaceChildren();
  lens.open();
  await vi.advanceTimersByTimeAsync(2000);
  expect(
    document.querySelector<HTMLElement>('[data-chatbrowserx-overlay=translation]')?.dataset.status,
  ).toBe('ready');
  expect(lens.shadow().querySelector<HTMLElement>('[role=status]')?.hidden).toBe(true);
  expect(lens.getDisplayMedia).not.toHaveBeenCalled();
});
