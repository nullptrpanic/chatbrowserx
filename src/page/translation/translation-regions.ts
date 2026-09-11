import {
  MAX_TRANSLATION_CAPTURE_WIDTH,
  MAX_TRANSLATION_CAPTURE_HEIGHT,
  type TranslationSelection,
} from '../../translation/region-translation';

export type TranslationRect = TranslationSelection['rect'];

/** Preserve small buffered captures; fill larger areas in bounded, still-missing crops. */
export function nextTranslationCapture(area: TranslationRect, missing: TranslationRect[]) {
  if (area.width <= MAX_TRANSLATION_CAPTURE_WIDTH && area.height <= MAX_TRANSLATION_CAPTURE_HEIGHT)
    return area;
  const first = missing.reduce(
    (a, b) => (b.y < a.y || (b.y === a.y && b.x < a.x) ? b : a),
    missing[0] ?? area,
  );
  const x = Math.floor(first.x),
    y = Math.floor(first.y);
  return {
    x,
    y,
    width: Math.min(MAX_TRANSLATION_CAPTURE_WIDTH, Math.ceil(area.x + area.width) - x),
    height: Math.min(MAX_TRANSLATION_CAPTURE_HEIGHT, Math.ceil(area.y + area.height) - y),
  };
}

/** One complete visible batch plus the existing three spare layers for overlapping movement. */
export function translationPatchLimit(area: Pick<TranslationRect, 'width' | 'height'>) {
  return (
    Math.ceil(area.width / MAX_TRANSLATION_CAPTURE_WIDTH) *
      Math.ceil(area.height / MAX_TRANSLATION_CAPTURE_HEIGHT) +
    3
  );
}

export function intersectRegions(a: TranslationRect, b: TranslationRect): TranslationRect | null {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** Pixels in a rectangle that are not covered by the supplied captures. */
export function subtractRegions(
  rect: TranslationRect,
  covered: readonly TranslationRect[],
): TranslationRect[] {
  return covered.reduce<TranslationRect[]>(
    (regions, cover) =>
      regions.flatMap((region) => {
        const left = Math.max(region.x, cover.x);
        const top = Math.max(region.y, cover.y);
        const right = Math.min(region.x + region.width, cover.x + cover.width);
        const bottom = Math.min(region.y + region.height, cover.y + cover.height);
        if (left >= right || top >= bottom) return [region];
        return [
          { x: region.x, y: region.y, width: region.width, height: top - region.y },
          {
            x: region.x,
            y: bottom,
            width: region.width,
            height: region.y + region.height - bottom,
          },
          { x: region.x, y: top, width: left - region.x, height: bottom - top },
          {
            x: right,
            y: top,
            width: region.x + region.width - right,
            height: bottom - top,
          },
        ].filter(({ width, height }) => width > 0 && height > 0);
      }),
    [rect],
  );
}
