import { describe, expect, it } from 'vitest';
import { translationClipBox } from '../../src/page/translation/translation-clipping';

function clip(path: string, legacy = '', zoom = 1) {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => new DOMRect(100, 200, 300, 120);
  Object.defineProperty(el, 'currentCSSZoom', { value: zoom });
  el.style.clipPath = path;
  el.style.clip = legacy;
  return translationClipBox(el, el.style);
}

describe('rectangular translation clipping', () => {
  it('distinguishes no clip from a fully hidden clip', () => {
    expect(clip('none')).toBeUndefined();
    expect(clip('inset(50%)')).toEqual({ x: 250, y: 260, width: 0, height: 0 });
    expect(clip('', 'rect(0px, 0px, 0px, 0px)')).toEqual({
      x: 100,
      y: 200,
      width: 0,
      height: 0,
    });
  });

  it('retains a negative-inset table viewport instead of hiding its subtree', () => {
    expect(clip('inset(-500px 0px -500px -500px)')).toEqual({
      x: -400,
      y: -300,
      width: 800,
      height: 1120,
    });
  });

  it('keeps fractional pixels, percentages and source CSS zoom', () => {
    expect(clip('inset(2.25px 10% 4px)', '', 2)).toEqual({
      x: 130,
      y: 204.5,
      width: 240,
      height: 107.5,
    });
  });

  it('supports a legacy rectangle with automatic edges', () => {
    expect(clip('', 'rect(5px, auto, auto, 2px)')).toEqual({
      x: 102,
      y: 205,
      width: 298,
      height: 115,
    });
  });

  it('intersects simultaneous legacy and modern clips, including hidden accessibility shells', () => {
    expect(clip('inset(50%)', 'rect(0px, 0px, 0px, 0px)')).toEqual({
      x: 250,
      y: 260,
      width: 0,
      height: 0,
    });
    expect(clip('inset(10px)', 'rect(0px, 100px, 100px, 0px)')).toEqual({
      x: 110,
      y: 210,
      width: 90,
      height: 90,
    });
    expect(clip('circle(30%)', 'rect(0px, 0px, 0px, 0px)')).toEqual({
      x: 100,
      y: 200,
      width: 0,
      height: 0,
    });
    expect(clip('circle(30%)', 'rect(0px, 100px, 100px, 0px)')).toBeNull();
  });

  it.each(['circle(30%)', 'inset(calc(10px + 5%) 0px)', 'inset(0px round 20px)'])(
    'keeps unsupported clipping native: %s',
    (value) => expect(clip(value)).toBeNull(),
  );
});
