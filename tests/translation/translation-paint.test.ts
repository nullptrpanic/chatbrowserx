import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  paintTranslation,
  type TranslationPaint,
} from '../../src/page/translation/translation-paint';
import { mockImageTextRanges } from './image-fixture';

beforeEach(() => mockImageTextRanges());

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const area = { x: 0, y: 0, width: 1000, height: 1000 };
function paint(blocks: TranslationPaint['blocks']) {
  return paintTranslation(
    document.body,
    {
      blocks,
      colors: blocks.map(() => ({ background: 'rgb(255,255,255)', color: '#172642' })),
    },
    area,
    [area],
  );
}

// One em per CJK glyph, preserving fractional geometry and the ancestor's image scale.
function mockLabelLayout(scaleX = 1) {
  mockImageTextRanges((range) => {
    const label = range.commonAncestorContainer as HTMLElement;
    return new DOMRect(
      0,
      0,
      range.toString().length * parseFloat(label.style.fontSize) * scaleX,
      20,
    );
  });
}

it('leaves a rotated axis label native instead of masking neighboring tick values', () => {
  const patch = paint([
    { text: 'Over refusal', translation: '过度拒绝率', box: [100, 100, 20, 240] },
  ]);
  expect(patch.painted).toEqual([]);
  expect(document.querySelector('.text')).toBeNull();
  // Deliberately retained native pixels are handled, not missing work to retry forever.
  expect(patch.regions).toEqual([area]);
});

it('bounds the background margin of a large horizontal label', () => {
  const patch = paint([{ text: 'Large title', translation: '大标题', box: [100, 100, 700, 120] }]);
  expect(patch.painted).toHaveLength(1);
  expect(patch.painted[0]?.rect.x).toBeGreaterThanOrEqual(98);
  expect(patch.painted[0]?.rect.width).toBeLessThanOrEqual(704);
});

it('does not mask unchanged text, numbers, metric keys or model-classified notation', () => {
  const blocks = [
    { text: 'Title', translation: 'Title', box: [100, 0, 200, 20] },
    { text: '0.92', translation: '零点九二', box: [100, 40, 100, 20] },
    { text: 'pol_pr_ood_refusal', translation: '拒绝率', box: [100, 80, 300, 20] },
    { kind: 'notation', text: 'Pol', translation: '多项式', box: [100, 120, 60, 20] },
    { kind: 'notation', text: 'Compl', translation: '复杂度', box: [100, 160, 80, 20] },
  ];
  expect(paint(blocks as TranslationPaint['blocks']).painted).toEqual([]);
});

it('retains the original when fitting a translation would make it unreadably small', () => {
  mockLabelLayout();
  const patch = paint([
    { text: 'Short label', translation: '这个译文无法在原位置清晰显示', box: [100, 100, 60, 20] },
  ]);
  expect(patch.painted).toEqual([]);
  expect(document.querySelector('.text')).toBeNull();
  expect(patch.regions).toEqual([area]);
});

it('keeps ordinary short UI text translatable', () => {
  const patch = paint([{ text: 'Save', translation: '保存', box: [100, 100, 80, 20] }]);
  expect(patch.painted).toHaveLength(1);
  expect(document.querySelector('.text')?.textContent).toBe('保存');
});

it('fits a readable translated axis caption instead of dropping it at the 80-percent threshold', () => {
  mockLabelLayout();
  const patch = paint([{ text: 'epoch', translation: '训练轮次', box: [100, 100, 60, 20] }]);
  expect(patch.painted).toHaveLength(1);
  const first = patch.painted[0];
  if (!first) throw new Error('Missing fitted caption');
  const label = first.element;
  expect(label.textContent).toBe('训练轮次');
  expect(parseFloat(label.style.fontSize)).toBeGreaterThanOrEqual(13);
  expect(parseFloat(label.style.fontSize)).toBeLessThan(16);
  expect(parseFloat(label.style.fontSize) * 4).toBeLessThanOrEqual(60);
  expect(label.style.lineHeight).toBe('20px');
  expect(first.rect.width).toBeLessThanOrEqual(62);
});

it('keeps a mixed legend label translatable while preserving its metric symbols inline', () => {
  mockLabelLayout();
  const patch = paint([
    {
      kind: 'text',
      text: 'Single-shot, no PB',
      translation: '单次，无 PB',
      box: [100, 100, 140, 20],
    },
    { kind: 'notation', text: 'PB', translation: 'PB', box: [100, 140, 40, 20] },
  ]);
  expect(patch.painted).toHaveLength(1);
  expect(patch.painted[0]?.element.textContent).toBe('单次，无 PB');
});

it('fits fractional glyph widths exactly without integer measurement or a half-pixel allowance', () => {
  mockLabelLayout();
  const patch = paint([{ text: 'epoch', translation: '训练轮次', box: [100, 100, 67.4, 20.1] }]);
  expect(patch.painted).toHaveLength(1);
  const label = patch.painted[0]?.element;
  if (!label) throw new Error('Missing fitted caption');
  expect(parseFloat(label.style.fontSize)).toBeCloseTo(16.85, 8);
  expect(parseFloat(label.style.fontSize) * 4).toBeCloseTo(67.4, 8);
});

it.each([0.5, 1.5])(
  'converts floating-point viewport glyph bounds back to image pixels at scale %s',
  (scaleX) => {
    mockLabelLayout(scaleX);
    const patch = paintTranslation(
      document.body,
      {
        blocks: [{ text: 'epoch', translation: '训练轮次', box: [100, 100, 67.4, 20.1] }],
        colors: [],
      },
      area,
      [area],
      { x: scaleX, y: 1 },
    );
    expect(patch.painted).toHaveLength(1);
    const label = patch.painted[0]?.element;
    if (!label) throw new Error('Missing scaled caption');
    expect(parseFloat(label.style.fontSize)).toBeCloseTo(16.85, 8);
  },
);

it('does not shrink image labels below ten displayed CSS pixels even when the ratio would allow it', () => {
  mockLabelLayout(0.6);
  const patch = paintTranslation(
    document.body,
    {
      blocks: [{ text: 'epoch', translation: '训练轮次', box: [100, 100, 60, 20] }],
      colors: [],
    },
    area,
    [area],
    { x: 0.6, y: 0.6 },
  );
  expect(patch.painted).toEqual([]);
});

it('counts deliberately retained notation as handled without claiming a partial image is complete', () => {
  const patch = paintTranslation(
    document.body,
    {
      incomplete: true,
      blocks: [{ kind: 'notation', text: 'Pol', translation: 'Pol', box: [100, 100, 80, 20] }],
      colors: [],
    },
    area,
    [area],
  );
  expect(patch.painted).toEqual([]);
  expect(patch.regions).toEqual([{ x: 100, y: 100, width: 80, height: 20 }]);
});

it.each([0.25, 2])('caps margins in displayed pixels at image scale %s', (scale) => {
  const patch = paintTranslation(
    document.body,
    {
      blocks: [{ text: 'Large title', translation: '大标题', box: [100, 100, 700, 120] }],
      colors: [],
    },
    area,
    [area],
    { x: scale, y: scale },
  );
  expect(patch.painted).toHaveLength(1);
  const first = patch.painted[0];
  if (!first) throw new Error('Missing image label');
  expect((100 - first.rect.x) * scale).toBeLessThanOrEqual(1);
  expect((100 - first.rect.y) * scale).toBeLessThanOrEqual(1);
});
