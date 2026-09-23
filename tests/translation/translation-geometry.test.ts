import { afterEach, expect, it, vi } from 'vitest';
import { createTranslationGeometry } from '../../src/page/translation/translation-geometry';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it('keeps fractional source facts within a batch and refreshes the next batch', () => {
  const el = document.createElement('div');
  document.body.append(el);
  let x = 10.25;
  vi.spyOn(el, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(x, 20.5, 99.75, 30.25),
  );
  const first = createTranslationGeometry(window);
  expect(first.facts(el).box.x).toBe(10.25);
  x = 40.75;
  expect(first.facts(el).box.x).toBe(10.25);
  expect(createTranslationGeometry(window).facts(el).box.x).toBe(40.75);
});

function surface(style = '', parent = document.body) {
  const el = document.createElement('div');
  el.style.cssText = style;
  el.getBoundingClientRect = () => new DOMRect(100, 200, 300, 120);
  Object.defineProperties(el, { clientWidth: { value: 300 }, clientHeight: { value: 120 } });
  parent.append(el);
  return el;
}

it.each([
  ['', 'visible', { x: 100, y: 200, width: 300, height: 120 }],
  [
    'clip-path:inset(-10.25px 2.5px 3.75px)',
    'visible',
    { x: 102.5, y: 200, width: 295, height: 116.25 },
  ],
  ['clip-path:circle(30%)', 'uncertain', { x: 100, y: 200, width: 300, height: 120 }],
  ['clip-path:inset(50%)', 'hidden', undefined],
  ['display:none', 'hidden', undefined],
] as const)('reports local clipping explicitly: %s', (style, kind, rect) => {
  const el = surface(style);
  const g = createTranslationGeometry(window);
  const result = g.clip(g.facts(el).box, el, { includeSelf: true });
  expect(result.kind).toBe(kind);
  if (result.kind !== 'hidden') expect(result.rect).toEqual(rect);
});

it('lets a proven empty ancestor dominate an unknown clip shape', () => {
  const parent = surface('clip-path:inset(50%)');
  const el = surface('clip-path:circle(30%)', parent);
  const g = createTranslationGeometry(window);
  expect(g.clip(g.facts(el).box, el, { includeSelf: true })).toEqual({
    kind: 'hidden',
    reason: 'empty-clip',
  });
});

it.each(['visible', 'hidden'])('handles zero-height overflow-%s wrappers', (overflow) => {
  const parent = document.createElement('div');
  parent.style.overflowX = overflow;
  parent.style.overflowY = overflow;
  document.body.append(parent);
  const el = surface('', parent);
  const g = createTranslationGeometry(window);
  expect(g.clip(g.facts(el).box, el).kind).toBe(overflow === 'visible' ? 'visible' : 'hidden');
});

it('copies primitive styles rather than retaining live CSSStyleDeclaration objects', () => {
  const el = surface('position:relative;overflow-x:hidden;overflow-y:hidden');
  const g = createTranslationGeometry(window);
  expect(g.facts(el).position).toBe('relative');
  el.style.position = 'absolute';
  el.style.overflow = 'visible';
  expect(g.facts(el).position).toBe('relative');
  expect(g.facts(el).overflowX).toBe('hidden');
  expect(createTranslationGeometry(window).facts(el).position).toBe('absolute');
});

it('clips overflow content at the padding box without clipping the native border itself', () => {
  const el = document.createElement('div');
  el.style.cssText = 'overflow-x:hidden;overflow-y:hidden;border:1px solid black';
  el.textContent = 'Content';
  el.getBoundingClientRect = () => new DOMRect(100, 200, 300, 40);
  Object.defineProperties(el, {
    clientLeft: { value: 1 },
    clientTop: { value: 1 },
    clientWidth: { value: 298 },
    clientHeight: { value: 38 },
  });
  document.body.append(el);
  const geometry = createTranslationGeometry(window);
  const box = geometry.facts(el).box;
  expect(geometry.clip(box, el, { includeSelf: true })).toEqual({ kind: 'visible', rect: box });
  const text = el.firstChild;
  if (!text) throw new Error('Expected content');
  expect(geometry.clip(box, text)).toEqual({
    kind: 'visible',
    rect: { x: 101, y: 201, width: 298, height: 38 },
  });
});
