import type { TranslationRect } from './translation-regions';
import { intersectRegions } from './translation-regions';

/** undefined: no clip; null: unsupported shape; zero area: fully hidden. */
export function translationClipBox(
  el: Element,
  style: Pick<CSSStyleDeclaration, 'clipPath' | 'clip'>,
  measuredBox?: TranslationRect,
  measuredZoom?: number,
): TranslationRect | null | undefined {
  const path = style.clipPath && style.clipPath !== 'none' ? style.clipPath : '';
  const legacy = style.clip && style.clip !== 'auto' ? style.clip : '';
  if (!path && !legacy) return undefined;
  if (path && legacy) {
    const modern = translationClipBox(el, { clipPath: path, clip: '' }, measuredBox, measuredZoom);
    const old = translationClipBox(el, { clipPath: '', clip: legacy }, measuredBox, measuredZoom);
    // Visually hidden controls commonly carry both declarations. An empty clip
    // remains empty even if the other shape is not supported by the mirror.
    for (const clip of [modern, old]) if (clip && (!clip.width || !clip.height)) return clip;
    return modern && old
      ? (intersectRegions(modern, old) ?? { x: modern.x, y: modern.y, width: 0, height: 0 })
      : null;
  }
  const box = measuredBox ?? el.getBoundingClientRect();
  const zoom = measuredZoom ?? (el.currentCSSZoom || 1);
  const length = (value: string, dimension: number): number => {
    if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|%)?$/.test(value)) return NaN;
    return parseFloat(value) * (value.endsWith('%') ? dimension / 100 : zoom);
  };
  let top: number, right: number, bottom: number, left: number;
  if (path) {
    const inset = /^inset\(([^()]+)\)$/.exec(path);
    if (!inset) return null;
    const parts = inset[1]?.trim().split(/\s+/) ?? [];
    if (!parts.length || parts.length > 4) return null;
    const [a = '', b = a, c = a, d = b] = parts;
    top = length(a, box.height);
    right = box.width - length(b, box.width);
    bottom = box.height - length(c, box.height);
    left = length(d, box.width);
  } else {
    const rect = /^rect\(([^()]+)\)$/.exec(legacy);
    if (!rect) return null;
    const parts = rect[1]?.trim().split(/\s*,\s*|\s+/) ?? [];
    if (parts.length !== 4) return null;
    const [a = '', b = '', c = '', d = ''] = parts;
    top = a === 'auto' ? 0 : length(a, box.height);
    right = b === 'auto' ? box.width : length(b, box.width);
    bottom = c === 'auto' ? box.height : length(c, box.height);
    left = d === 'auto' ? 0 : length(d, box.width);
  }
  if (![top, right, bottom, left].every(Number.isFinite)) return null;
  return {
    x: box.x + left,
    y: box.y + top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}
