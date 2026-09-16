export function imageBackgrounds(image: Element): string[] {
  const colors: string[] = [];
  for (let element: Element | null = image; element; element = element.parentElement)
    colors.unshift(getComputedStyle(element).backgroundColor);
  return colors;
}

export function supportsImageLayout(style: CSSStyleDeclaration) {
  return (
    !style.objectFit ||
    style.objectFit === 'fill' ||
    (['cover', 'contain'].includes(style.objectFit) &&
      /^(?:-?\d+(?:\.\d+)?(?:%|px)) (?:-?\d+(?:\.\d+)?(?:%|px))$/.test(
        style.objectPosition || '50% 50%',
      ))
  );
}

/** Locate the unchanged photo behind a DOM caption, respecting its native crop. */
export function imageGeometry(image: HTMLImageElement) {
  const r = image.getBoundingClientRect(),
    s = getComputedStyle(image);
  const px = (v: string) => Number.parseFloat(v) || 0;
  const border = (style: string, width: string) => (!style || style === 'none' ? 0 : px(width));
  const left = border(s.borderLeftStyle, s.borderLeftWidth) + px(s.paddingLeft),
    right = border(s.borderRightStyle, s.borderRightWidth) + px(s.paddingRight);
  const top = border(s.borderTopStyle, s.borderTopWidth) + px(s.paddingTop),
    bottom = border(s.borderBottomStyle, s.borderBottomWidth) + px(s.paddingBottom);
  const clip = {
    x: r.x + left,
    y: r.y + top,
    width: Math.max(0, r.width - left - right),
    height: Math.max(0, r.height - top - bottom),
  };
  const box = { ...clip };
  if (s.objectFit === 'cover' || s.objectFit === 'contain') {
    const scale = (s.objectFit === 'cover' ? Math.max : Math.min)(
      clip.width / image.naturalWidth,
      clip.height / image.naturalHeight,
    );
    box.width = image.naturalWidth * scale;
    box.height = image.naturalHeight * scale;
    const [x = '50%', y = '50%'] = (s.objectPosition || '50% 50%').split(' ');
    const offset = (v: string, free: number) => (v.endsWith('%') ? (px(v) * free) / 100 : px(v));
    box.x += offset(x, clip.width - box.width);
    box.y += offset(y, clip.height - box.height);
  }
  return { box, clip };
}

type BackgroundEntry = { key: string; usable: boolean };
const sourceKey = (image: HTMLImageElement) =>
  JSON.stringify([image.currentSrc || image.src, image.naturalWidth, image.naturalHeight]);

/** Validate only photos behind DOM captions. Never recognizes, captures or translates pixels. */
export class TranslationBackgroundSources {
  private readonly cache = new Map<HTMLImageElement, BackgroundEntry>();
  private readonly abort = new AbortController();
  constructor(
    private readonly readResource?: (url: string, signal: AbortSignal) => Promise<Response | null>,
  ) {}

  invalidate(image: HTMLImageElement) {
    this.cache.delete(image);
  }

  ready(image: HTMLImageElement) {
    const entry = this.cache.get(image);
    return image.complete && entry?.key === sourceKey(image) && entry.usable === true;
  }

  needsPreparation(image: HTMLImageElement) {
    return (
      image.complete && image.naturalWidth > 0 && this.cache.get(image)?.key !== sourceKey(image)
    );
  }

  async prepare(images: HTMLImageElement[]) {
    await Promise.all(
      images.slice(0, 8).map(async (image) => {
        if (this.abort.signal.aborted || !this.needsPreparation(image)) return;
        const key = sourceKey(image);
        const entry: BackgroundEntry = { key, usable: false };
        this.cache.set(image, entry);
        while (this.cache.size > 8) {
          const oldest = this.cache.keys().next().value;
          if (oldest) this.cache.delete(oldest);
        }
        const usable = await this.verify(image);
        if (
          !this.abort.signal.aborted &&
          this.cache.get(image) === entry &&
          sourceKey(image) === key
        )
          entry.usable = usable;
      }),
    );
  }

  close() {
    this.abort.abort();
    this.cache.clear();
  }

  private async verify(image: HTMLImageElement): Promise<boolean> {
    if (
      typeof ImageDecoder === 'undefined' ||
      image.naturalWidth * image.naturalHeight > 16_000_000
    )
      return false;
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(10000)]);
    try {
      const url = new URL(image.currentSrc || image.src, image.baseURI);
      if (!['http:', 'https:', 'data:', 'blob:'].includes(url.protocol)) return false;
      const crossOrigin =
        /^https?:$/.test(url.protocol) && url.origin !== new URL(image.baseURI).origin;
      const response =
        crossOrigin && this.readResource
          ? await this.readResource(url.href, signal)
          : await fetch(url.href, { signal, credentials: 'same-origin' });
      if (!response) return false;
      const type = response.headers.get('Content-Type')?.split(';')[0] ?? '';
      if (
        !response.ok ||
        !response.body ||
        Number(response.headers.get('Content-Length')) > 4 * 1024 * 1024 ||
        !(await ImageDecoder.isTypeSupported(type))
      ) {
        await response.body?.cancel();
        return false;
      }
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 4 * 1024 * 1024) return false;
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const decoder = new ImageDecoder({ data: bytes, type, preferAnimation: true });
      try {
        await decoder.tracks.ready;
        signal.throwIfAborted();
        const track = decoder.tracks.selectedTrack;
        return track?.animated === false && track.frameCount === 1;
      } finally {
        decoder.close();
      }
    } catch {
      return false;
    }
  }
}
