import { vi } from 'vitest';

/** An unchanged native image fixture. DOM text-only tests must never read or decode it. */
export function staticImageFixture(rect = new DOMRect(350, 270, 500, 260)) {
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
