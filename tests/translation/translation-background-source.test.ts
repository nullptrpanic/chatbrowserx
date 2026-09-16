import { afterEach, expect, it, vi } from 'vitest';
import {
  imageGeometry,
  TranslationBackgroundSources,
} from '../../src/page/translation/translation-background-source';
import { staticImageFixture } from './image-fixture';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(animated = false) {
  const source = staticImageFixture();
  const close = vi.fn();
  vi.stubGlobal(
    'ImageDecoder',
    class {
      static isTypeSupported = async () => true;
      tracks = {
        ready: Promise.resolve(),
        selectedTrack: { animated, frameCount: animated ? 2 : 1 },
      };
      close = close;
    },
  );
  return { ...source, close, backgrounds: new TranslationBackgroundSources() };
}

it('verifies a DOM backdrop once, without captures or pixel fingerprints', async () => {
  const { image, backgrounds, fetcher, close } = fixture();
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
  const digest = vi.spyOn(crypto.subtle, 'digest');
  expect(backgrounds.ready(image)).toBe(false);
  await backgrounds.prepare([image]);
  expect(backgrounds.ready(image)).toBe(true);
  await backgrounds.prepare([image]);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(canvas).not.toHaveBeenCalled();
  expect(digest).not.toHaveBeenCalled();
  backgrounds.close();
  expect(backgrounds.ready(image)).toBe(false);
});

it('uses already-loaded CDN bytes only for a requested DOM text backdrop', async () => {
  const { image, fetcher } = fixture();
  image.src = 'https://cdn.test/photo.png';
  const read = vi.fn(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Type': 'image/png' },
      }),
  );
  const backgrounds = new TranslationBackgroundSources(read);
  await backgrounds.prepare([image]);
  expect(read).toHaveBeenCalledExactlyOnceWith(image.src, expect.any(AbortSignal));
  expect(fetcher).not.toHaveBeenCalled();
  expect(backgrounds.ready(image)).toBe(true);
  backgrounds.close();
});

it('invalidates changed and same-URL reloaded sources without a model retry', async () => {
  const { image, backgrounds, fetcher } = fixture();
  await backgrounds.prepare([image]);
  image.src = '/replacement.png';
  expect(backgrounds.ready(image)).toBe(false);
  await backgrounds.prepare([image]);
  backgrounds.invalidate(image);
  expect(backgrounds.needsPreparation(image)).toBe(true);
  await backgrounds.prepare([image]);
  expect(fetcher).toHaveBeenCalledTimes(3);
  backgrounds.close();
});

it('keeps an animation native and remembers a failed verification without retry loops', async () => {
  const { image, backgrounds, fetcher, close } = fixture(true);
  await backgrounds.prepare([image]);
  expect(backgrounds.ready(image)).toBe(false);
  expect(backgrounds.needsPreparation(image)).toBe(false);
  await backgrounds.prepare([image]);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  backgrounds.close();
});

it.each(['decoder', 'dimensions', 'bytes'])(
  'rejects unsupported %s with bounded work',
  async (limit) => {
    const { image, backgrounds, fetcher } = fixture();
    if (limit === 'decoder') vi.stubGlobal('ImageDecoder', undefined);
    if (limit === 'dimensions') Object.defineProperty(image, 'naturalWidth', { value: 100000 });
    if (limit === 'bytes')
      fetcher.mockResolvedValue(
        new Response(new Uint8Array(4 * 1024 * 1024 + 1), {
          headers: { 'Content-Type': 'image/png' },
        }),
      );
    await backgrounds.prepare([image]);
    expect(backgrounds.ready(image)).toBe(false);
    await backgrounds.prepare([image]);
    expect(fetcher).toHaveBeenCalledTimes(limit === 'bytes' ? 1 : 0);
    backgrounds.close();
  },
);

it('bounds preparation to eight backdrops and aborts outstanding work on close', async () => {
  const { image, backgrounds, fetcher } = fixture();
  const signals: AbortSignal[] = [];
  fetcher.mockImplementation(
    (_url?: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error('Missing cancellation');
        signals.push(signal);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  const images = [image, ...Array.from({ length: 9 }, () => staticImageFixture().image)];
  vi.stubGlobal('fetch', fetcher);
  const pending = backgrounds.prepare(images);
  await vi.waitFor(() => expect(signals).toHaveLength(8));
  backgrounds.close();
  await pending;
  expect(signals.every((s) => s.aborted)).toBe(true);
  expect(images.some((i) => backgrounds.ready(i))).toBe(false);
});

it.each(['cover', 'contain'])(
  'retains fractional %s geometry for DOM caption backgrounds',
  (fit) => {
    const { image } = staticImageFixture(new DOMRect(100.25, 150.5, 220, 120));
    image.style.cssText = 'border:10px solid black;object-fit:' + fit + ';object-position:50% 50%';
    Object.defineProperties(image, {
      naturalWidth: { value: 400 },
      naturalHeight: { value: 400 },
    });
    expect(imageGeometry(image)).toEqual({
      clip: { x: 110.25, y: 160.5, width: 200, height: 100 },
      box:
        fit === 'cover'
          ? { x: 110.25, y: 110.5, width: 200, height: 200 }
          : { x: 160.25, y: 160.5, width: 100, height: 100 },
    });
  },
);
