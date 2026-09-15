import type { z } from 'zod';
import type { translationPaintSchema } from '../../translation/region-translation';
import { intersectRegions, subtractRegions, type TranslationRect } from './translation-regions';

export type TranslationPaint = z.infer<typeof translationPaintSchema>;
export interface TranslationPatch {
  regions: TranslationRect[];
  painted: { rect: TranslationRect; element: HTMLElement }[];
  element: HTMLElement;
}

/** Image-local patches. Unsafe labels stay native; a handled region need not be overpainted. */
export function paintTranslation(
  parent: HTMLElement,
  result: TranslationPaint,
  rect: TranslationRect,
  regions: TranslationRect[],
  scale = { x: 1, y: 1 },
): TranslationPatch {
  const doc = parent.ownerDocument;
  const layer = doc.createElement('div');
  layer.className = 'patch';
  parent.append(layer);
  const painted: TranslationPatch['painted'] = [];
  const handled: TranslationRect[] = [];
  result.blocks.forEach((block, index) => {
    const [x, y, w, h] = block.box;
    const width = (w * rect.width) / 1000,
      height = (h * rect.height) / 1000;
    const source = {
      x: rect.x + (x * rect.width) / 1000,
      y: rect.y + (y * rect.height) / 1000,
      width,
      height,
    };
    if (subtractRegions(source, regions).length) return;
    // Recognized but deliberately retained labels are handled even in a partial response.
    handled.push(source);
    if (
      block.kind === 'notation' ||
      !block.translation.trim() ||
      block.translation.trim() === block.text.trim() ||
      !/\p{L}/u.test(block.text) ||
      /^[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)+$/u.test(block.text.trim())
    )
      return;
    if (height * scale.y > width * scale.x * 1.2 || height * scale.y < 10) return;
    // At most one CSS pixel around the OCR box, independent of intrinsic image size.
    const paddingX = Math.min(width / 20, 1 / scale.x),
      paddingY = Math.min(height / 20, 1 / scale.y);
    const span = doc.createElement('span');
    span.className = 'text';
    span.textContent = block.translation;
    const colors = result.colors[index];
    Object.assign(span.style, {
      position: 'absolute',
      whiteSpace: 'nowrap',
      fontFamily: 'Arial, sans-serif',
      lineHeight: `${height}px`,
      boxSizing: 'content-box',
      left: `${source.x - paddingX}px`,
      top: `${source.y - paddingY}px`,
      width: `${width}px`,
      height: `${height}px`,
      padding: `${paddingY}px ${paddingX}px`,
      fontSize: `${height}px`,
      color: colors?.color ?? '#172642',
      background: colors?.background ?? '#ffffff',
    });
    layer.append(span);
    const range = doc.createRange();
    range.selectNodeContents(span);
    // Range geometry retains fractions and excludes padding. Convert viewport width back
    // to intrinsic image pixels before fitting; scrollWidth/clientWidth would round it.
    const textWidth = () => range.getBoundingClientRect().width / scale.x;
    const measured = textWidth();
    if (measured > width) {
      const size = (height * width) / measured;
      if (size < Math.max(height * 0.65, 10 / scale.y)) {
        span.remove();
        return;
      }
      span.style.fontSize = `${size}px`;
      if (textWidth() > width) {
        span.remove();
        return;
      }
    }
    painted.push({
      element: span,
      rect: {
        x: source.x - paddingX,
        y: source.y - paddingY,
        width: width + paddingX * 2,
        height: height + paddingY * 2,
      },
    });
  });
  return {
    regions: result.incomplete ? handled : regions,
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
