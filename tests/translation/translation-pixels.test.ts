import { expect, it } from 'vitest';
import { fingerprintTiles } from '../../src/translation/translation-pixels';
import { TranslationContent } from '../../src/page/translation/translation-content';

it('detects a one-pixel change without invalidating the adjacent tile', () => {
  const data = new Uint8ClampedArray(128 * 64 * 4).fill(255);
  const rect = { x: 0, y: 0, width: 128, height: 64 };
  const before = fingerprintTiles({ data, width: 128, height: 64 }, rect);
  data[(20 * 128 + 90) * 4] = 0;
  const after = fingerprintTiles({ data, width: 128, height: 64 }, rect);
  expect(after[0]).toEqual(before[0]);
  expect(after[1]?.fingerprint).not.toBe(before[1]?.fingerprint);
  expect(after[1]?.rect).toEqual({ x: 64, y: 0, width: 64, height: 64 });
});

it('keeps full-cell fingerprints identical when the capture origin moves by one grid cell', () => {
  const data = new Uint8ClampedArray(128 * 64 * 4).fill(73);
  const before = fingerprintTiles(
    { data, width: 128, height: 64 },
    { x: 0, y: 0, width: 128, height: 64 },
  );
  const after = fingerprintTiles(
    { data, width: 128, height: 64 },
    { x: 64, y: 0, width: 128, height: 64 },
  );
  expect(after[0]).toEqual(before[1]);
});

it('samples physical pixels at high DPI and clips edge cells to the viewport', () => {
  const data = new Uint8ClampedArray(132 * 128 * 4).fill(255);
  const before = fingerprintTiles(
    { data, width: 132, height: 128 },
    { x: 64, y: 0, width: 66, height: 64 },
  );
  expect(before.map((t) => t.rect)).toEqual([
    { x: 64, y: 0, width: 64, height: 64 },
    { x: 128, y: 0, width: 2, height: 64 },
  ]);
  data[(127 * 132 + 131) * 4] = 0;
  const after = fingerprintTiles(
    { data, width: 132, height: 128 },
    { x: 64, y: 0, width: 66, height: 64 },
  );
  expect(after[0]).toEqual(before[0]);
  expect(after[1]?.fingerprint).not.toBe(before[1]?.fingerprint);
});

it('blocks changes immediately and requires more settling after repeated changes', () => {
  const content = new TranslationContent();
  const rect = { x: 64, y: 0, width: 64, height: 64 };
  const sample = (fingerprint: string) => content.sample([{ rect, fingerprint }]);
  sample('a');
  expect(content.blocked).toEqual([]);
  expect(sample('b')).toEqual([rect]);
  expect(content.blocked).toEqual([rect]);
  sample('b');
  expect(content.blocked).toEqual([rect]);
  sample('b');
  expect(content.blocked).toEqual([]);
  sample('c');
  sample('d');
  sample('d');
  sample('d');
  expect(content.blocked).toEqual([rect]);
  sample('d');
  expect(content.blocked).toEqual([]);
});

it('bounds history and treats an evicted region as needing validation, not known unchanged', () => {
  const content = new TranslationContent();
  for (let i = 0; i < 1200; i++)
    content.sample([{ rect: { x: i * 64, y: 0, width: 64, height: 64 }, fingerprint: 'same' }]);
  expect(content.tiles.size).toBeLessThanOrEqual(1024);
  expect(
    content.sample([{ rect: { x: 0, y: 0, width: 64, height: 64 }, fingerprint: 'same' }]),
  ).toEqual([{ x: 0, y: 0, width: 64, height: 64 }]);
  content.reset();
  expect(content.tiles.size).toBe(0);
  expect(content.blocked).toEqual([]);
});
