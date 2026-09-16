export interface TranslationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function intersectRegions(a: TranslationRect, b: TranslationRect): TranslationRect | null {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** Parts of a rectangle outside the supplied regions. */
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
