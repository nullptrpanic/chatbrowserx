import { intersectRegions, type TranslationRect } from './translation-regions';
import { imageGeometry } from './translation-background-source';

/** Only a single, box-sized static linear gradient; no textures or special compositing. */
export function isSimpleGradient(style: CSSStyleDeclaration) {
  return (
    /^linear-gradient\((?:[^()]|\([^()]*\))*\)$/.test(style.backgroundImage) &&
    ['', 'auto', 'auto auto'].includes(style.backgroundSize) &&
    ['', '0% 0%'].includes(style.backgroundPosition) &&
    ['', 'scroll'].includes(style.backgroundAttachment) &&
    ['', 'padding-box'].includes(style.backgroundOrigin) &&
    ['', 'border-box'].includes(style.backgroundClip) &&
    ['', 'normal'].includes(style.backgroundBlendMode)
  );
}

export interface TranslationBackgroundLayer {
  image: string;
  box?: TranslationRect;
}

/** Topmost-first CSS layers. Solid descendant colors still cover/alpha-composite the gradient. */
function backgroundLayers(owner: Element, view: Window, stop?: Element) {
  const layers: TranslationBackgroundLayer[] = [];
  let gradient = false;
  for (let el: Element | null = owner; el && el !== stop; el = el.parentElement) {
    const style = view.getComputedStyle(el);
    if (isSimpleGradient(style)) {
      gradient = true;
      const box = el.getBoundingClientRect();
      const px = (value: string) => Number.parseFloat(value) || 0;
      const border = (side: 'Left' | 'Top' | 'Right' | 'Bottom') =>
        !style[`border${side}Style`] || style[`border${side}Style`] === 'none'
          ? 0
          : px(style[`border${side}Width`]);
      const left = border('Left'),
        top = border('Top');
      layers.push({
        image: style.backgroundImage,
        box: {
          x: box.x + left,
          y: box.y + top,
          width: Math.max(0, box.width - left - border('Right')),
          height: Math.max(0, box.height - top - border('Bottom')),
        },
      });
    }
    const color = style.backgroundColor;
    if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)')
      layers.push({ image: `linear-gradient(${color}, ${color})` });
  }
  return { layers, gradient };
}

export function gradientBackground(owner: Element, view: Window): TranslationBackgroundLayer[] {
  const { layers, gradient } = backgroundLayers(owner, view);
  return gradient ? layers : [];
}

/** Restore one verified static photo behind DOM text, using its native crop and caption gradient.
 * Ambiguous stacking/compositing stays native instead of inventing a flat mask.
 */
export function textBackground(
  owner: Element,
  lines: TranslationRect[],
  view: Window,
  visuals: TranslationRect[],
  images: HTMLImageElement[],
  ready: (image: HTMLImageElement) => boolean,
): TranslationBackgroundLayer[] | null {
  if (!visuals.some((v) => lines.some((line) => intersectRegions(v, line))))
    return gradientBackground(owner, view);
  const candidates = images.filter((image) =>
    lines.some((line) => intersectRegions(image.getBoundingClientRect(), line)),
  );
  if (candidates.length !== 1) return null;
  const image = candidates[0];
  if (!image || !ready(image)) return null;
  let common: Element | null = owner;
  while (common && !common.contains(image)) common = common.parentElement;
  if (!common || common === owner || common === owner.ownerDocument.body) return null;
  const { box, clip } = imageGeometry(image);
  const raster = intersectRegions(box, clip);
  if (
    !raster ||
    lines.some(
      (r) =>
        r.x < raster.x ||
        r.y - 1 < raster.y ||
        r.x + r.width > raster.x + raster.width ||
        r.y + r.height + 1 > raster.y + raster.height,
    )
  )
    return null;
  // Verify native paint order rather than assuming any geometrically overlapping img is a backdrop.
  if (!owner.ownerDocument.elementsFromPoint) return null;
  for (const r of lines) {
    const stack = owner.ownerDocument
      .elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      .filter((el) => !el.closest('[data-chatbrowserx-overlay]'));
    const source = stack.indexOf(owner),
      photo = stack.indexOf(image);
    if (
      source < 0 ||
      photo <= source ||
      stack.slice(source + 1, photo).some((el) => !el.contains(owner))
    )
      return null;
  }
  for (let el: Element | null = owner; el && el !== common; el = el.parentElement) {
    for (const pseudo of ['::before', '::after']) {
      const s = view.getComputedStyle(el, pseudo);
      if (s.content && !['none', 'normal'].includes(s.content)) return null;
    }
  }
  return [
    ...backgroundLayers(owner, view, common).layers,
    { image: `url(${JSON.stringify(image.currentSrc || image.src)})`, box },
    ...backgroundLayers(image, view).layers,
  ];
}
