import type { TranslationSelection, TranslationTile } from './region-translation';

/** Fixed viewport grid, full-resolution pixels. Fingerprints are not security checksums. */
export function fingerprintTiles(
  image: Pick<ImageData, 'data' | 'width' | 'height'>,
  rect: TranslationSelection['rect'],
): TranslationTile[] {
  const tiles: TranslationTile[] = [];
  const sx = image.width / rect.width,
    sy = image.height / rect.height;
  for (let gy = Math.floor(rect.y / 64) * 64; gy < rect.y + rect.height; gy += 64) {
    for (let gx = Math.floor(rect.x / 64) * 64; gx < rect.x + rect.width; gx += 64) {
      const x = Math.max(gx, rect.x),
        y = Math.max(gy, rect.y);
      const width = Math.min(gx + 64, rect.x + rect.width) - x;
      const height = Math.min(gy + 64, rect.y + rect.height) - y;
      const left = Math.round((x - rect.x) * sx),
        top = Math.round((y - rect.y) * sy);
      const right = Math.round((x + width - rect.x) * sx),
        bottom = Math.round((y + height - rect.y) * sy);
      let a = 2166136261,
        b = 5381;
      for (let row = top; row < bottom; row++) {
        for (let i = (row * image.width + left) * 4; i < (row * image.width + right) * 4; i++) {
          const value = image.data[i] ?? 0;
          a = Math.imul(a ^ value, 16777619);
          b = Math.imul(b, 33) ^ value;
        }
      }
      tiles.push({
        rect: { x, y, width, height },
        fingerprint: `${right - left}:${bottom - top}:${a >>> 0}:${b >>> 0}`,
      });
    }
  }
  return tiles;
}
