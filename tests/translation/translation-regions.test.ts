import { expect, it } from 'vitest';
import { subtractRegions } from '../../src/page/translation/translation-regions';

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
