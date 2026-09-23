import { expect, it } from 'vitest';
import { intersectRegions, subtractRegions } from '../../src/page/translation/translation-regions';

it('does not rediscover floating-point edge residue as overlap after a native cutout', () => {
  for (let i = 1; i <= 100; i++) {
    const region = { x: -i / 3, y: i / 7, width: 783.5, height: 5471.7 };
    const cover = { x: i / 11 + 200, y: i / 13 + 250, width: 121.19, height: 40.706 };
    for (const part of subtractRegions(region, [cover]))
      expect(intersectRegions(part, cover), `fractional cutout ${i}`).toBeNull();
  }
});

it('retains real subpixel overlaps without rounding dimensions to pixels', () => {
  const result = intersectRegions(
    { x: 10, y: 20, width: 50, height: 20 },
    { x: 59.999999, y: 20, width: 20, height: 20 },
  );
  expect(result?.width).toBeCloseTo(0.000001, 10);
});

it('subtracts only actual overlaps, leaving the surrounding pixels uncovered', () => {
  expect(
    subtractRegions({ x: 0, y: 0, width: 100, height: 100 }, [
      { x: 20, y: 30, width: 60, height: 40 },
    ]),
  ).toEqual([
    { x: 0, y: 0, width: 100, height: 30 },
    { x: 0, y: 70, width: 100, height: 30 },
    { x: 0, y: 30, width: 20, height: 40 },
    { x: 80, y: 30, width: 20, height: 40 },
  ]);
});

it('recognizes the union of adjacent captures without claiming gaps between captures', () => {
  const rect = { x: 0, y: 0, width: 100, height: 100 };
  expect(
    subtractRegions(rect, [
      { x: 0, y: 0, width: 50, height: 100 },
      { x: 50, y: 0, width: 50, height: 100 },
    ]),
  ).toEqual([]);
  expect(
    subtractRegions(rect, [
      { x: 0, y: 0, width: 40, height: 100 },
      { x: 60, y: 0, width: 40, height: 100 },
    ]),
  ).toEqual([{ x: 40, y: 0, width: 20, height: 100 }]);
});

it('does not remove non-overlapping or edge-touching regions', () => {
  expect(
    subtractRegions({ x: 10, y: 10, width: 20, height: 20 }, [
      { x: 30, y: 0, width: 100, height: 100 },
      { x: 0, y: 40, width: 100, height: 100 },
    ]),
  ).toEqual([{ x: 10, y: 10, width: 20, height: 20 }]);
});
