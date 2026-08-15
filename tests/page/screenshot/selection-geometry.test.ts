import { describe, expect, it } from 'vitest';
import {
  isUsableSelection,
  normalizeSelection,
} from '../../../src/page/screenshot/selection-geometry';

const viewport = { width: 500, height: 400 };

describe('screenshot selection geometry', () => {
  it('normalizes drags in every direction', () => {
    expect(normalizeSelection({ startX: 400, startY: 300, endX: 100, endY: 80 }, viewport)).toEqual(
      { x: 100, y: 80, width: 300, height: 220 },
    );
    expect(normalizeSelection({ startX: 100, startY: 80, endX: 400, endY: 300 }, viewport)).toEqual(
      { x: 100, y: 80, width: 300, height: 220 },
    );
  });

  it('clamps pointers outside the current viewport and requires an 8px square', () => {
    expect(
      normalizeSelection({ startX: -20, startY: -10, endX: 900, endY: 800 }, viewport),
    ).toEqual({ x: 0, y: 0, width: 500, height: 400 });
    expect(isUsableSelection({ x: 0, y: 0, width: 7, height: 20 })).toBe(false);
    expect(isUsableSelection({ x: 0, y: 0, width: 8, height: 8 })).toBe(true);
  });
});
