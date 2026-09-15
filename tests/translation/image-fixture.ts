import { vi } from 'vitest';

/** jsdom has no range geometry. Non-layout tests keep zero-size ranges, like its element boxes. */
export function mockImageTextRanges(measure: (range: Range) => DOMRect = () => new DOMRect()) {
  const create = Document.prototype.createRange.bind(document);
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = create();
    range.getBoundingClientRect = () => measure(range);
    return range;
  });
}

/** jsdom has no image decoder/canvas. Keep source selection, caching and rendering orchestration real. */
export function staticImageFixture(rect = new DOMRect(350, 270, 500, 260)) {
  mockImageTextRanges();
  // Native WebCrypto completion is outside fake timers. These fixtures always contain the same
  // bytes; real digest/reopen validation is covered by image-cache and browser tests.
  vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(new Uint8Array(32).buffer);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage() {},
    scale() {},
    fillRect() {},
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    getImageData: () => ({ data: new Uint8ClampedArray([255, 255, 255, 255]) }),
    measureText: (text: string) => ({ width: text.length * 8 }),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,cG5n');
  vi.stubGlobal(
    'ImageDecoder',
    class {
      static isTypeSupported = async () => true;
      tracks = { ready: Promise.resolve(), selectedTrack: { animated: false, frameCount: 1 } };
      close() {}
    },
  );
  vi.stubGlobal('createImageBitmap', async () => ({ close() {} }));
  const fetcher = vi.fn(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Type': 'image/png' },
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const image = document.createElement('img');
  image.src = new URL('/static.png', document.baseURI).href;
  image.style.cssText = 'object-fit:fill;transform:none;filter:none;opacity:1;clip-path:none';
  image.getAnimations = () => [];
  image.getBoundingClientRect = () => rect;
  Object.defineProperties(image, {
    complete: { value: true, configurable: true },
    naturalWidth: { value: rect.width, configurable: true },
    naturalHeight: { value: rect.height, configurable: true },
  });
  document.body.append(image);
  return { image, fetcher };
}
