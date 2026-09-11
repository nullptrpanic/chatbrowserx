import { afterEach, expect, it, vi } from 'vitest';
import { TranslationImages } from '../../src/page/translation/translation-images';
import { translationSelectionSchema } from '../../src/translation/region-translation';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(animated = false) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage() {},
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
  } as unknown as CanvasRenderingContext2D);
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
  const fetcher = vi.fn(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } }),
  );
  vi.stubGlobal('fetch', fetcher);
  const image = document.createElement('img');
  image.src = new URL('/image.png', document.baseURI).href;
  Object.defineProperties(image, {
    complete: { value: true, configurable: true },
    naturalWidth: { value: 800, configurable: true },
    naturalHeight: { value: 400, configurable: true },
  });
  return { images: new TranslationImages(), image, fetcher, close };
}

it('reuses verified single-frame bytes until the image source changes', async () => {
  const { images, image, fetcher, close } = fixture();
  expect(await images.prepare([image])).toBe(true);
  expect(await images.prepare([image])).toBe(true);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  image.src = new URL('/new.png', document.baseURI).href;
  expect(await images.prepare([image])).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
  images.close();
});

it('fills a viewport-sized static image in bounded crops and retains all visible coverage', async () => {
  const { images, image } = fixture();
  const area = { x: 0, y: 0, width: 3840, height: 2160 };
  Object.defineProperties(image, { naturalWidth: { value: 3840 }, naturalHeight: { value: 2160 } });
  image.getBoundingClientRect = () => new DOMRect(0, 0, 3840, 2160);
  document.body.append(image);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage() {},
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
    scale() {},
    fillRect() {},
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    expect(this.width).toBeLessThanOrEqual(2400);
    expect(this.height).toBeLessThanOrEqual(1600);
    return 'data:image/png;base64,YQ==';
  });
  vi.stubGlobal('createImageBitmap', async () => ({ width: 3840, height: 2160, close() {} }));
  expect(await images.prepare([image])).toBe(true);
  for (let i = 0; i < 12; i++) {
    const capture = await images.render([image], area, document);
    if (!capture) throw new Error('Missing untranslated crop');
    expect(
      translationSelectionSchema.safeParse({
        sessionId: 's',
        devicePixelRatio: 2,
        viewportWidth: 3840,
        viewportHeight: 2160,
        rect: capture.rect,
        imageUrl: capture.imageUrl,
      }).success,
    ).toBe(true);
    expect(capture.rect.width).toBeLessThanOrEqual(1200);
    expect(capture.rect.height).toBeLessThanOrEqual(800);
    expect(images.accept(capture, { blocks: [], colors: [] })).toBe(true);
    expect(images.covered([image], area)).toBe(i === 11);
  }
  expect(await images.render([image], area, document)).toBeNull();
  images.close();
});

async function translatedFixture() {
  const f = fixture();
  const parent = document.createElement('div');
  document.body.append(f.image, parent);
  let box = new DOMRect(100, 200, 400, 200);
  f.image.getBoundingClientRect = () => box;
  await f.images.prepare([f.image]);
  f.images.update([f.image], parent);
  const entry = f.images.cache.get(f.image);
  if (!entry) throw new Error('Source was not prepared');
  const capture = {
    imageUrl: '',
    rect: { x: 100, y: 200, width: 400, height: 100 },
    sources: [
      {
        image: f.image,
        entry,
        box: { x: 100, y: 200, width: 400, height: 200 },
        regions: [{ x: 0, y: 0, width: 800, height: 200 }],
      },
    ],
  };
  const result = {
    blocks: [
      {
        text: 'image',
        translation: '图片',
        box: [100, 100, 200, 100] as [number, number, number, number],
      },
    ],
    colors: [],
  };
  return {
    ...f,
    parent,
    capture,
    result,
    move: (next: DOMRect) => {
      box = next;
    },
  };
}

it('keeps image-local coverage and repositions existing text through scrolling and resizing', async () => {
  const { images, image, parent, capture, result, move, fetcher } = await translatedFixture();
  expect(images.accept(capture, result)).toBe(true);
  const text = parent.querySelector('.text');
  expect(text?.textContent).toBe('图片');
  expect(images.covered([image], { x: 100, y: 200, width: 400, height: 100 })).toBe(true);
  expect(images.missing(image, { x: 100, y: 200, width: 400, height: 200 })).toEqual([
    { x: 0, y: 200, width: 800, height: 200 },
  ]);
  move(new DOMRect(50, 80, 200, 100));
  images.update([image], parent);
  expect(parent.querySelector('.text')).toBe(text);
  expect((parent.firstChild as HTMLElement).style.transform).toBe(
    'translate(50px, 80px) scale(0.25, 0.25)',
  );
  expect(images.covered([image], { x: 50, y: 80, width: 200, height: 50 })).toBe(true);
  images.update([], parent);
  await images.prepare([image]);
  images.update([image], parent);
  expect(parent.querySelector('.text')).toBe(text);
  expect(fetcher).toHaveBeenCalledOnce();
  images.close();
  expect(parent.textContent).toBe('');
});

it('reprojects previews without caching coverage and removes them on failure or finalization', async () => {
  const { images, image, parent, capture, result, move } = await translatedFixture();
  const area = { x: 100, y: 200, width: 400, height: 100 };
  expect(images.accept(capture, { ...result, incomplete: true }, true)).toBe(true);
  expect(parent.textContent).toBe('图片');
  expect(images.covered([image], area)).toBe(false);
  move(new DOMRect(100, 160, 400, 200));
  images.update([image], parent);
  expect((parent.firstChild as HTMLElement).style.transform).toBe(
    'translate(100px, 160px) scale(0.5, 0.5)',
  );
  images.clearPreview(capture);
  expect(parent.textContent).toBe('');
  expect(images.covered([image], { ...area, y: 160 })).toBe(false);
  images.accept(capture, { ...result, incomplete: true }, true);
  images.accept(capture, result);
  images.clearPreview(capture);
  expect(parent.querySelectorAll('.text')).toHaveLength(1);
  expect(images.covered([image], { ...area, y: 160 })).toBe(true);
  images.close();
});

it('does not mutate cached layer styles when only the lens moves', async () => {
  const { images, image, parent } = await translatedFixture();
  const observer = new MutationObserver(() => undefined);
  observer.observe(parent, { attributes: true, subtree: true });
  images.update([image], parent);
  expect(observer.takeRecords()).toHaveLength(0);
  observer.disconnect();
  images.close();
});

it('accepts in-flight translations after movement but rejects a replaced source', async () => {
  const { images, image, parent, capture, result, move } = await translatedFixture();
  move(new DOMRect(100, 160, 400, 200));
  images.update([image], parent);
  expect(images.accept(capture, result)).toBe(true);
  expect(images.covered([image], { x: 100, y: 160, width: 400, height: 100 })).toBe(true);
  image.src = new URL('/replacement.png', document.baseURI).href;
  images.update([image], parent);
  expect(parent.textContent).toBe('');
  expect(images.accept(capture, result)).toBe(false);
  expect(images.covered([image], { x: 100, y: 160, width: 400, height: 100 })).toBe(false);
  images.close();
});

it('invalidates same-URL reloads locally without forgetting another image', async () => {
  const { images, image, parent, capture, result } = await translatedFixture();
  images.accept(capture, result);
  const other = image.cloneNode() as HTMLImageElement;
  document.body.append(other);
  images.invalidate(other);
  images.update([image], parent);
  expect(parent.textContent).toBe('图片');
  images.invalidate(image);
  expect(parent.textContent).toBe('');
  expect(images.accept(capture, result)).toBe(false);
  images.close();
});

it('does not leave a subpixel gap after two crops of a fractionally sized image', async () => {
  const { images, image, parent } = await translatedFixture();
  Object.defineProperties(image, { naturalWidth: { value: 1024 }, naturalHeight: { value: 971 } });
  const box = { x: 440, y: 248.609375, width: 560, height: 531.015625 };
  image.getBoundingClientRect = () => new DOMRect(box.x, box.y, box.width, box.height);
  await images.prepare([image]);
  images.update([image], parent);
  const entry = images.cache.get(image);
  if (!entry) throw new Error('Source was not prepared');
  // The first viewport ends at y=661; a second viewport exposes the remaining lower part.
  const firstHeight = ((661 - 248.609375) / 531.015625) * 971;
  for (const region of [
    { x: 0, y: 0, width: 1024, height: firstHeight },
    { x: 0, y: firstHeight, width: 1024, height: 971 - firstHeight },
  ])
    images.accept(
      { rect: box, imageUrl: '', sources: [{ image, entry, box, regions: [region] }] },
      { blocks: [], colors: [] },
    );
  expect(images.covered([image], { x: 440, y: 380, width: 1000, height: 520 })).toBe(true);
  images.close();
});

it('does not mistake a PNG-named animation for a static image', async () => {
  const { images, image, close } = fixture(true);
  expect(await images.prepare([image])).toBe(false);
  expect(close).toHaveBeenCalledOnce();
  images.close();
});

it('does not reuse bytes after a source becomes too large or cross-origin', async () => {
  const { images, image } = fixture();
  expect(await images.prepare([image])).toBe(true);
  Object.defineProperty(image, 'naturalWidth', { value: 100000, configurable: true });
  expect(await images.prepare([image])).toBe(false);
  Object.defineProperty(image, 'naturalWidth', { value: 800, configurable: true });
  image.src = 'https://other-origin.test/private.png';
  expect(await images.prepare([image])).toBe(false);
  images.close();
});

it('falls back when the native decoder is unavailable or decoding fails', async () => {
  const { images, image, fetcher } = fixture();
  vi.stubGlobal('ImageDecoder', undefined);
  expect(await images.prepare([image])).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
  images.close();
});

it('bounds the source count and cancels oversized responses', async () => {
  const { images, image, fetcher } = fixture();
  expect(await images.prepare(Array.from({ length: 9 }, () => image))).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
  const cancel = vi.fn();
  fetcher.mockImplementation(
    async () =>
      new Response(new ReadableStream({ cancel }), {
        headers: { 'Content-Type': 'image/png', 'Content-Length': String(5 * 1024 * 1024) },
      }),
  );
  expect(await images.prepare([image])).toBe(false);
  expect(cancel).toHaveBeenCalledOnce();
  images.close();
});

it('bounds retained sources while a newly visited image is still loading', async () => {
  const { images, image, fetcher } = fixture();
  const sources = Array.from({ length: 9 }, (_, i) => {
    const clone = image.cloneNode() as HTMLImageElement;
    clone.src = new URL(`/image-${i}.png`, document.baseURI).href;
    Object.defineProperties(clone, {
      complete: { value: true },
      naturalWidth: { value: 800 },
      naturalHeight: { value: 400 },
    });
    return clone;
  });
  expect(await images.prepare(sources.slice(0, 8))).toBe(true);
  let finish!: (response: Response) => void;
  fetcher.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = images.prepare(sources.slice(8));
  try {
    expect(images.cache.size).toBe(8);
  } finally {
    finish(new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png' } }));
    await pending;
    images.close();
  }
});

it('aborts in-flight fetches on close without producing a usable cache entry', async () => {
  const { images, image, fetcher } = fixture();
  let started!: () => void;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  fetcher.mockImplementation(
    (...args: unknown[]) =>
      new Promise((_resolve, reject) => {
        const signal = (args[1] as RequestInit).signal;
        if (!signal) throw new Error('Source fetch must be cancellable');
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        started();
      }),
  );
  const pending = images.prepare([image]);
  await ready;
  images.close();
  expect(await pending).toBe(false);
  expect(images.cache.size).toBe(0);
});

it.each([false, true])(
  'revalidates actual image pixels after reopening (changed=%s)',
  async (changed) => {
    const { images, image, parent, capture, result, fetcher } = await translatedFixture();
    const pixels = new Uint8ClampedArray([0, 0, 0, 255]);
    const context = { drawImage() {}, getImageData: () => ({ data: pixels }) };
    const spy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(context as unknown as CanvasRenderingContext2D);
    // Prepare again with a fresh instance so the source fingerprint is collected before translation.
    images.close();
    const first = new TranslationImages();
    await first.prepare([image]);
    const entry = first.cache.get(image);
    if (!entry) throw new Error('Missing source');
    const source = capture.sources[0];
    if (!source) throw new Error('Missing source');
    expect(first.accept({ ...capture, sources: [{ ...source, entry }] }, result)).toBe(true);
    first.close();
    if (changed) pixels[0] = 1;
    const reopened = new TranslationImages(first.retained);
    await reopened.prepare([image]);
    reopened.update([image], parent);
    expect(reopened.covered([image], capture.rect)).toBe(!changed);
    expect(parent.textContent?.includes('图片')).toBe(!changed);
    expect(fetcher).toHaveBeenCalledTimes(3);
    reopened.close();
    spy.mockRestore();
  },
);

it('does not restore a source whose unchanged first frame can no longer be proven static', async () => {
  const { images, image, parent, capture, result } = await translatedFixture();
  expect(images.accept(capture, result)).toBe(true);
  images.close();
  vi.stubGlobal(
    'ImageDecoder',
    class {
      static isTypeSupported = async () => true;
      tracks = { ready: Promise.resolve(), selectedTrack: { animated: true, frameCount: 2 } };
      close() {}
    },
  );
  const reopened = new TranslationImages(images.retained);
  expect(await reopened.prepare([image])).toBe(false);
  reopened.update([image], parent);
  expect(parent.textContent).not.toContain('图片');
  reopened.close();
});

it('retains completed patches but not subsequent incomplete results or previews', async () => {
  const { images, image, parent, capture, result } = await translatedFixture();
  expect(images.accept(capture, result)).toBe(true);
  const block = result.blocks[0];
  if (!block) throw new Error('Missing block');
  const additional = {
    ...result,
    incomplete: true,
    blocks: [{ ...block, translation: '不完整' }],
  };
  images.accept(capture, additional);
  images.accept(capture, { ...additional, blocks: [{ ...block, translation: '预览' }] }, true);
  images.close();
  const reopened = new TranslationImages(images.retained);
  await reopened.prepare([image]);
  reopened.update([image], parent);
  expect(parent.textContent).toContain('图片');
  expect(parent.textContent).not.toContain('不完整');
  expect(parent.textContent).not.toContain('预览');
  reopened.close();
});

it('keeps previously completed image translations when reopening is cancelled during verification', async () => {
  const { images, image, parent, capture, result, fetcher } = await translatedFixture();
  images.accept(capture, result);
  images.close();
  fetcher.mockImplementation(
    (...args: unknown[]) =>
      new Promise((_resolve, reject) => {
        const signal = (args[1] as RequestInit).signal;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  const cancelled = new TranslationImages(images.retained);
  const pending = cancelled.prepare([image]);
  cancelled.close();
  expect(await pending).toBe(false);
  fetcher.mockImplementation(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } }),
  );
  const reopened = new TranslationImages(images.retained);
  await reopened.prepare([image]);
  reopened.update([image], parent);
  expect(parent.textContent).toContain('图片');
  expect(reopened.covered([image], capture.rect)).toBe(true);
  reopened.close();
});

it('serializes full-resolution fingerprints and skips queued buffers after closing', async () => {
  const { images, image } = fixture();
  const pending: ((value: ArrayBuffer) => void)[] = [];
  const digest = vi
    .spyOn(crypto.subtle, 'digest')
    .mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  const sources = Array.from({ length: 3 }, () => {
    const clone = image.cloneNode() as HTMLImageElement;
    Object.defineProperties(clone, {
      complete: { value: true },
      naturalWidth: { value: 800 },
      naturalHeight: { value: 400 },
    });
    return clone;
  });
  const prepared = images.prepare(sources);
  try {
    await vi.waitFor(() => expect(digest).toHaveBeenCalled());
    expect(digest).toHaveBeenCalledTimes(1);
  } finally {
    images.close();
    pending.forEach((resolve) => resolve(new ArrayBuffer(32)));
    await prepared;
  }
  expect(digest).toHaveBeenCalledTimes(1);
});
