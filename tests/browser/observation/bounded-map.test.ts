import { describe, expect, it } from 'vitest';
import { mapConcurrentOrdered } from '../../../src/browser/observation/bounded-map';

describe('mapConcurrentOrdered', () => {
  it('preserves input order while bounding active workers', async () => {
    let active = 0;
    let maximumActive = 0;

    const result = await mapConcurrentOrdered([5, 4, 3, 2, 1], 2, async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, value));
      active -= 1;
      return value * 2;
    });

    expect(result).toEqual([10, 8, 6, 4, 2]);
    expect(maximumActive).toBe(2);
  });
});
