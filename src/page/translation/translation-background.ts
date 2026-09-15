import type { TranslationRect } from './translation-regions';

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
export function gradientBackground(owner: Element, view: Window): TranslationBackgroundLayer[] {
  const layers: TranslationBackgroundLayer[] = [];
  let gradient = false;
  for (let el: Element | null = owner; el; el = el.parentElement) {
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
  return gradient ? layers : [];
}
