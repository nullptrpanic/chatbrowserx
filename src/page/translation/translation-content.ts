import type { TranslationTile } from '../../translation/region-translation';
import type { TranslationRect } from './translation-regions';

const key = ({ x, y, width, height }: TranslationRect) => `${x}:${y}:${width}:${height}`;

/** Bounded pixel history. A change blocks immediately; repeated changes require longer settling. */
export class TranslationContent {
  readonly tiles = new Map<string, { fingerprint: string; changes: number; steady: number }>();
  blocked: TranslationRect[] = [];

  sample(tiles: readonly TranslationTile[]): TranslationRect[] {
    const changed: TranslationRect[] = [];
    this.blocked = [];
    for (const tile of tiles) {
      const id = key(tile.rect),
        before = this.tiles.get(id);
      const different = before && before.fingerprint !== tile.fingerprint;
      const changes = different ? Math.min(2, before.changes + 1) : (before?.changes ?? 0);
      const steady = different ? 0 : Math.min(3, (before?.steady ?? 3) + 1);
      if (!before || different) changed.push(tile.rect);
      const unsettled = changes > 0 && steady < (changes > 1 ? 3 : 2);
      if (unsettled) this.blocked.push(tile.rect);
      this.tiles.delete(id);
      this.tiles.set(id, {
        fingerprint: tile.fingerprint,
        changes: unsettled ? changes : 0,
        steady,
      });
    }
    while (this.tiles.size > Math.max(1024, tiles.length * 2)) {
      const oldest = this.tiles.keys().next().value;
      if (oldest === undefined) break;
      this.tiles.delete(oldest);
    }
    return changed;
  }

  reset() {
    this.tiles.clear();
    this.blocked = [];
  }
}
