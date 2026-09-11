import type { z } from 'zod';
import type { translationPaintSchema } from '../../translation/region-translation';
import { intersectRegions, subtractRegions, type TranslationRect } from './translation-regions';

export type TranslationPaint = z.infer<typeof translationPaintSchema>;
export interface TranslationPatch {
  regions: TranslationRect[];
  painted: { rect: TranslationRect; element: HTMLElement }[];
  element: HTMLElement;
}

/** Both source-image and screenshot layers use the same layout, in their own coordinates. */
export function paintTranslation(
  parent: HTMLElement,
  result: TranslationPaint,
  rect: TranslationRect,
  regions: TranslationRect[],
): TranslationPatch {
  const doc = parent.ownerDocument;
  const layer = doc.createElement('div');
  layer.className = 'patch';
  parent.append(layer);
  const painted: TranslationPatch['painted'] = [];
  result.blocks.forEach((block, index) => {
    const [x, y, w, h] = block.box;
    const width = (w * rect.width) / 1000,
      height = (h * rect.height) / 1000,
      padding = height / 6;
    const source = {
      x: rect.x + (x * rect.width) / 1000,
      y: rect.y + (y * rect.height) / 1000,
      width,
      height,
    };
    if (subtractRegions(source, regions).length) return;
    const span = doc.createElement('span');
    span.className = 'text';
    span.textContent = block.translation;
    const colors = result.colors[index];
    Object.assign(span.style, {
      left: `${source.x - padding}px`,
      top: `${source.y - padding}px`,
      width: `${width}px`,
      height: `${height}px`,
      padding: `${padding}px`,
      fontSize: `${height}px`,
      color: colors?.color ?? '#172642',
      background: colors?.background ?? '#ffffff',
    });
    layer.append(span);
    painted.push({
      element: span,
      rect: {
        x: source.x - padding,
        y: source.y - padding,
        width: width + padding * 2,
        height: height + padding * 2,
      },
    });
    if (span.scrollWidth > span.clientWidth)
      span.style.fontSize = `${(height * width) / (span.scrollWidth - padding * 2)}px`;
  });
  return {
    regions: result.incomplete ? painted.map((p) => p.rect) : regions,
    painted,
    element: layer,
  };
}

export function clipTranslationPatches(patches: TranslationPatch[]) {
  patches.forEach((patch, index) => {
    const older = patches.slice(0, index).flatMap((p) =>
      p.painted.flatMap((box) =>
        p.regions.flatMap((region) => {
          const overlap = intersectRegions(box.rect, region);
          return overlap ? [overlap] : [];
        }),
      ),
    );
    const visible = patch.regions.flatMap((r) => subtractRegions(r, older));
    const path = visible
      .map(({ x, y, width, height }) => `M${x} ${y}h${width}v${height}h${-width}Z`)
      .join(' ');
    const clip = path ? `path("${path}")` : 'inset(100%)';
    if (patch.element.style.clipPath !== clip) patch.element.style.clipPath = clip;
  });
}
