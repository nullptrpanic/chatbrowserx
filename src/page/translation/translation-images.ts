import {
  intersectRegions,
  subtractRegions,
  nextTranslationCapture,
  translationPatchLimit,
  type TranslationRect,
} from './translation-regions';
import {
  clipTranslationPatches,
  paintTranslation,
  type TranslationPaint,
  type TranslationPatch,
} from './translation-paint';

export function imageBackgrounds(image: Element): string[] {
  const colors: string[] = [];
  for (let element: Element | null = image; element; element = element.parentElement)
    colors.unshift(getComputedStyle(element).backgroundColor);
  return colors;
}

interface ImageEntry {
  key: string;
  fingerprint: string | null;
  blob: Blob | null;
  ready: Promise<void>;
  layer: HTMLElement;
  patches: TranslationPatch[];
}
type RetainedImage = Pick<ImageEntry, 'key' | 'fingerprint' | 'layer' | 'patches'>;

export interface TranslationImageCapture {
  rect: TranslationRect;
  imageUrl: string;
  patchLimit?: number;
  sources: {
    image: HTMLImageElement;
    entry: ImageEntry;
    box: TranslationRect;
    regions: TranslationRect[];
    preview?: TranslationPatch;
  }[];
}

function imageKey(image: HTMLImageElement) {
  return JSON.stringify([
    image.currentSrc || image.src,
    image.naturalWidth,
    image.naturalHeight,
    imageBackgrounds(image),
  ]);
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

/** Raster placement and content-box clipping are separate; cached patches stay intrinsic. */
function imageGeometry(image: HTMLImageElement) {
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
  const radius = (value: string, dx: number, dy: number) => {
    const [x = '0', y = x] = value.split(' ');
    const length = (v: string, extent: number) =>
      v.endsWith('%') ? (px(v) * extent) / 100 : px(v);
    return `${(Math.max(0, length(x, r.width) - dx) * image.naturalWidth) / Math.max(1, box.width)}px ${(Math.max(0, length(y, r.height) - dy) * image.naturalHeight) / Math.max(1, box.height)}px`;
  };
  return {
    box,
    clip,
    corners: {
      borderTopLeftRadius: radius(s.borderTopLeftRadius, left, top),
      borderTopRightRadius: radius(s.borderTopRightRadius, right, top),
      borderBottomRightRadius: radius(s.borderBottomRightRadius, right, bottom),
      borderBottomLeftRadius: radius(s.borderBottomLeftRadius, left, bottom),
    },
  };
}

function localRect(
  rect: TranslationRect,
  box: TranslationRect,
  image: HTMLImageElement,
): TranslationRect {
  return {
    x: ((rect.x - box.x) / box.width) * image.naturalWidth,
    y: ((rect.y - box.y) / box.height) * image.naturalHeight,
    width: (rect.width / box.width) * image.naturalWidth,
    height: (rect.height / box.height) * image.naturalHeight,
  };
}

function pageRect(
  rect: TranslationRect,
  box: TranslationRect,
  width = 1000,
  height = 1000,
): TranslationRect {
  return {
    x: box.x + (rect.x / width) * box.width,
    y: box.y + (rect.y / height) * box.height,
    width: (rect.width / width) * box.width,
    height: (rect.height / height) * box.height,
  };
}

/** Decoded metadata proves a static raster; extensions or a temporarily still frame do not. */
export class TranslationImages {
  readonly cache = new Map<HTMLImageElement, ImageEntry>();
  readonly abort = new AbortController();
  private fingerprinting: Promise<string | null> = Promise.resolve(null);
  constructor(
    readonly retained = new Map<HTMLImageElement, RetainedImage>(),
    private readonly readResource?: (url: string, signal: AbortSignal) => Promise<Response | null>,
  ) {}

  invalidate(image: HTMLImageElement) {
    this.cache.get(image)?.layer.remove();
    this.cache.delete(image);
    this.retained.delete(image);
  }

  ready(images: HTMLImageElement[]) {
    return (
      images.length > 0 &&
      images.every((image) => {
        const entry = this.cache.get(image);
        return entry?.blob && image.complete && entry.key === imageKey(image);
      })
    );
  }

  update(images: HTMLImageElement[], parent: HTMLElement) {
    for (const [image, entry] of this.cache) {
      if (!image.isConnected || !image.complete || entry.key !== imageKey(image)) {
        this.invalidate(image);
        continue;
      }
      entry.layer.hidden = !images.includes(image);
      if (entry.layer.hidden) continue;
      if (!entry.layer.isConnected) parent.append(entry.layer);
      const { box, clip, corners } = imageGeometry(image);
      if (!box.width || !box.height) {
        entry.layer.hidden = true;
        continue;
      }
      const clipped = localRect(clip, box, image);
      const radii = Object.values(corners).map((r) => r.split(' '));
      // inset() also permits negative margins for contain's letterboxing. The intrinsic
      // layer still clips to the raster; the content-box radius must not round the raster itself.
      entry.layer.style.clipPath = `inset(${clipped.y}px ${image.naturalWidth - clipped.x - clipped.width}px ${image.naturalHeight - clipped.y - clipped.height}px ${clipped.x}px round ${radii.map((r) => r[0]).join(' ')} / ${radii.map((r) => r[1]).join(' ')})`;
      for (const property of Object.keys(corners) as (keyof typeof corners)[])
        entry.layer.style[property] =
          getComputedStyle(image).objectFit === 'contain' ? '' : corners[property];
      entry.layer.style.transform = `translate(${box.x}px, ${box.y}px) scale(${box.width / image.naturalWidth}, ${box.height / image.naturalHeight})`;
    }
  }

  missing(image: HTMLImageElement, area: TranslationRect) {
    const { box, clip } = imageGeometry(image);
    const raster = intersectRegions(box, clip);
    const visible = raster && intersectRegions(raster, area);
    if (!visible) return [];
    return subtractRegions(
      localRect(visible, box, image),
      this.cache.get(image)?.patches.flatMap((p) => p.regions) ?? [],
    );
  }

  covered(images: HTMLImageElement[], area: TranslationRect) {
    return this.ready(images) && images.every((image) => !this.missing(image, area).length);
  }

  valid(capture: TranslationImageCapture) {
    return capture.sources.some(
      ({ image, entry }) =>
        image.isConnected &&
        image.complete &&
        this.cache.get(image) === entry &&
        entry.key === imageKey(image),
    );
  }

  async prepare(images: HTMLImageElement[]): Promise<boolean> {
    if (
      this.abort.signal.aborted ||
      !images.length ||
      images.length > 8 ||
      typeof ImageDecoder === 'undefined'
    )
      return false;
    await Promise.all(
      images.map(async (image) => {
        const src = image.currentSrc || image.src;
        const url = new URL(src, image.baseURI);
        if (
          !image.complete ||
          image.naturalWidth < 1 ||
          image.naturalWidth * image.naturalHeight > 16_000_000 ||
          (!['data:', 'blob:'].includes(url.protocol) &&
            url.origin !== new URL(image.baseURI).origin &&
            image.crossOrigin === null &&
            !this.readResource)
        ) {
          this.invalidate(image);
          return;
        }
        let entry = this.cache.get(image);
        const key = imageKey(image);
        if (entry?.key !== key) {
          const saved = this.retained.get(image);
          this.cache.get(image)?.layer.remove();
          this.cache.delete(image);
          const layer = image.ownerDocument.createElement('div');
          Object.assign(layer.style, {
            position: 'absolute',
            width: `${image.naturalWidth}px`,
            height: `${image.naturalHeight}px`,
            transformOrigin: '0 0',
            overflow: 'hidden',
          });
          entry = {
            key,
            fingerprint: null,
            blob: null,
            ready: Promise.resolve(),
            layer,
            patches: [],
          };
          const current = entry;
          current.ready = this.load(
            src,
            url.origin !== new URL(image.baseURI).origin && /^https?:$/.test(url.protocol),
          ).then(async (blob) => {
            const fingerprint = blob
              ? await this.fingerprint(
                  image,
                  this.readResource &&
                    url.origin !== new URL(image.baseURI).origin &&
                    /^https?:$/.test(url.protocol)
                    ? blob
                    : undefined,
                )
              : null;
            if (
              this.abort.signal.aborted ||
              this.cache.get(image) !== current ||
              imageKey(image) !== key
            )
              return;
            current.blob = blob;
            current.fingerprint = fingerprint;
            if (
              blob &&
              saved?.key === key &&
              current.fingerprint &&
              saved.fingerprint === current.fingerprint
            ) {
              current.layer = saved.layer;
              current.patches = saved.patches.slice();
              current.layer.replaceChildren(...current.patches.map((p) => p.element));
            } else this.retained.delete(image);
          });
          this.cache.set(image, current);
        }
        // Keep recently used source translations when they leave the viewport, with a hard bound.
        this.cache.delete(image);
        this.cache.set(image, entry);
        while (this.cache.size > 8) {
          const oldest = this.cache.keys().next().value;
          if (oldest) this.invalidate(oldest);
        }
        await entry.ready;
      }),
    );
    return !this.abort.signal.aborted && this.ready(images);
  }

  async render(
    images: HTMLImageElement[],
    area: TranslationRect,
    doc: Document,
  ): Promise<TranslationImageCapture | null> {
    if (!this.ready(images)) return null;
    const sources = images.flatMap((image) => {
      const entry = this.cache.get(image);
      const box = imageGeometry(image).box;
      const regions = this.missing(image, area);
      return regions.length && entry?.blob
        ? [{ image, box, entry, regions, blob: entry.blob }]
        : [];
    });
    if (!sources.length) return null;
    const missing = sources.flatMap((s) =>
      s.regions.map((r) => pageRect(r, s.box, s.image.naturalWidth, s.image.naturalHeight)),
    );
    const x = Math.floor(Math.min(...missing.map((r) => r.x))),
      y = Math.floor(Math.min(...missing.map((r) => r.y)));
    const rect = nextTranslationCapture(
      {
        x,
        y,
        width: Math.ceil(Math.max(...missing.map((r) => r.x + r.width))) - x,
        height: Math.ceil(Math.max(...missing.map((r) => r.y + r.height))) - y,
      },
      missing,
    );
    const croppedSources = sources
      .map((source) => ({
        ...source,
        regions: this.missing(source.image, rect),
      }))
      .filter((source) => source.regions.length);
    const canvas = doc.createElement('canvas');
    canvas.width = rect.width * 2;
    canvas.height = rect.height * 2;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.scale(2, 2);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, rect.width, rect.height);
    for (const source of croppedSources) {
      context.save();
      context.beginPath();
      for (const region of source.regions) {
        const r = pageRect(
          region,
          source.box,
          source.image.naturalWidth,
          source.image.naturalHeight,
        );
        context.rect(r.x - rect.x, r.y - rect.y, r.width, r.height);
      }
      context.clip();
      for (const color of imageBackgrounds(source.image)) {
        context.fillStyle = color;
        context.fillRect(
          source.box.x - rect.x,
          source.box.y - rect.y,
          source.box.width,
          source.box.height,
        );
      }
      const bitmap = await createImageBitmap(source.blob);
      try {
        this.abort.signal.throwIfAborted();
        context.drawImage(
          bitmap,
          source.box.x - rect.x,
          source.box.y - rect.y,
          source.box.width,
          source.box.height,
        );
      } finally {
        bitmap.close();
        context.restore();
      }
    }
    return {
      rect,
      imageUrl: canvas.toDataURL('image/png'),
      sources: croppedSources,
      patchLimit: translationPatchLimit(area),
    };
  }

  clearPreview(capture: TranslationImageCapture) {
    for (const source of capture.sources) {
      source.preview?.element.remove();
      delete source.preview;
    }
  }

  accept(capture: TranslationImageCapture, result: TranslationPaint, preview = false) {
    let accepted = false;
    for (const source of capture.sources) {
      const { image, entry, box, regions } = source;
      if (
        !image.isConnected ||
        !image.complete ||
        this.cache.get(image) !== entry ||
        entry.key !== imageKey(image)
      )
        continue;
      const blocks: TranslationPaint['blocks'] = [],
        colors: TranslationPaint['colors'] = [];
      result.blocks.forEach((block, index) => {
        const r = localRect(
          pageRect(
            {
              x: block.box[0],
              y: block.box[1],
              width: block.box[2],
              height: block.box[3],
            },
            capture.rect,
          ),
          box,
          image,
        );
        if (subtractRegions(r, regions).length) return;
        blocks.push({
          ...block,
          box: [
            (r.x / image.naturalWidth) * 1000,
            (r.y / image.naturalHeight) * 1000,
            (r.width / image.naturalWidth) * 1000,
            (r.height / image.naturalHeight) * 1000,
          ],
        });
        colors.push(
          result.colors[index] ?? {
            background: 'rgb(255,255,255)',
            color: '#172642',
          },
        );
      });
      const hidden = entry.layer.hidden;
      entry.layer.hidden = false;
      const patch = paintTranslation(
        entry.layer,
        { ...result, blocks, colors },
        { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight },
        regions,
        { x: box.width / image.naturalWidth, y: box.height / image.naturalHeight },
      );
      source.preview?.element.remove();
      delete source.preview;
      if (preview) source.preview = patch;
      else entry.patches.push(patch);
      while (entry.patches.length > (capture.patchLimit ?? 4))
        entry.patches.shift()?.element.remove();
      if (!preview && !result.incomplete && entry.fingerprint && !this.abort.signal.aborted) {
        this.retained.delete(image);
        this.retained.set(image, {
          key: entry.key,
          fingerprint: entry.fingerprint,
          layer: entry.layer,
          patches: entry.patches.slice(),
        });
        if (this.retained.size > 8) {
          const oldest = this.retained.keys().next().value;
          if (oldest) this.retained.delete(oldest);
        }
      }
      clipTranslationPatches(preview ? [...entry.patches, patch] : entry.patches);
      entry.layer.hidden = hidden;
      accepted = true;
    }
    return accepted;
  }

  close() {
    this.abort.abort();
    for (const [image, entry] of this.cache) {
      entry.layer.remove();
      const saved = this.retained.get(image);
      if (saved?.layer === entry.layer)
        entry.layer.replaceChildren(...saved.patches.map((p) => p.element));
    }
    this.cache.clear();
  }

  private fingerprint(image: HTMLImageElement, loadedResource?: Blob): Promise<string | null> {
    // CDN bytes came from the browser's loaded resource. Same-origin fetches may differ from
    // the already displayed image, so retain the decoded-pixel check for those sources.
    const pending = this.fingerprinting.then(async () => {
      if (this.abort.signal.aborted) return null;
      const canvas = image.ownerDocument.createElement('canvas');
      try {
        let bytes: ArrayBuffer | Uint8ClampedArray<ArrayBuffer>;
        if (loadedResource) bytes = await loadedResource.arrayBuffer();
        else {
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext('2d');
          if (!context) return null;
          context.drawImage(image, 0, 0);
          bytes = context.getImageData(0, 0, canvas.width, canvas.height).data;
        }
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      } catch {
        return null;
      } finally {
        canvas.width = canvas.height = 0;
      }
    });
    this.fingerprinting = pending;
    return pending;
  }

  private async load(src: string, crossOrigin: boolean): Promise<Blob | null> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(10000)]);
    try {
      const response =
        crossOrigin && this.readResource
          ? await this.readResource(src, signal)
          : await fetch(src, { signal, credentials: 'same-origin' });
      if (!response) return null;
      const type = response.headers.get('Content-Type')?.split(';')[0] ?? '';
      if (
        !response.ok ||
        !response.body ||
        Number(response.headers.get('Content-Length')) > 4 * 1024 * 1024 ||
        !(await ImageDecoder.isTypeSupported(type))
      ) {
        await response.body?.cancel();
        return null;
      }
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 4 * 1024 * 1024) return null;
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
      const decoder = new ImageDecoder({
        data: bytes,
        type,
        preferAnimation: true,
      });
      try {
        await decoder.tracks.ready;
        signal.throwIfAborted();
        const track = decoder.tracks.selectedTrack;
        return track?.animated === false && track.frameCount === 1
          ? new Blob([bytes], { type })
          : null;
      } finally {
        decoder.close();
      }
    } catch {
      return null;
    }
  }
}
