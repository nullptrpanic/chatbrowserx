import { translationClipBox } from './translation-clipping';
import { intersectRegions, type TranslationRect } from './translation-regions';

export type TranslationClipResult =
  | { kind: 'visible'; rect: TranslationRect }
  | { kind: 'hidden'; reason: 'style' | 'empty-clip' }
  | { kind: 'uncertain'; rect: TranslationRect; reason: 'clip-shape' | 'clip-relationship' };

export interface TranslationElementFacts {
  box: TranslationRect;
  /** Overflow scrollport, in viewport CSS pixels (not a text content budget). */
  contentBox: TranslationRect;
  zoom: number;
  display: string;
  position: string;
  visibility: string;
  opacity: string;
  contentVisibility: string;
  overflowX: string;
  overflowY: string;
  contain: string;
  transform: string;
  filter: string;
  perspective: string;
  willChange: string;
  clip: TranslationClipResult | undefined;
  hidden: boolean;
  /** This box has an empty scrollport; descendants may still escape its containing block. */
  emptyOverflow: boolean;
}

interface ClipOptions {
  boundary?: Element | null;
  includeSelf?: boolean;
  /** Renderer-owned auto-height float shells may grow in the readonly copy. */
  unboundedY?: ReadonlySet<Element>;
}

export interface TranslationGeometry {
  facts(element: Element): Readonly<TranslationElementFacts>;
  clip(rect: TranslationRect, node: Node, options?: ClipOptions): TranslationClipResult;
}

const copyRect = ({ x, y, width, height }: TranslationRect): TranslationRect => ({
  x,
  y,
  width,
  height,
});
const clipsOverflow = (value: string) => /^(hidden|clip|auto|scroll)$/.test(value);
const hasEffect = (value: string) => !!value && value !== 'none';

/** Target paint must be supported; native protection instead retains uncertain bounds. */
export const visibleTranslationRect = (result: TranslationClipResult): TranslationRect | null =>
  result.kind === 'visible' ? result.rect : null;

/** One synchronous read/paint batch. Never retain this cache across a request or DOM writes. */
export function createTranslationGeometry(view: Window): TranslationGeometry {
  const cache = new Map<Element, Readonly<TranslationElementFacts>>();
  const facts = (el: Element): Readonly<TranslationElementFacts> => {
    const cached = cache.get(el);
    if (cached) return cached;
    const s = view.getComputedStyle(el);
    const box = copyRect(el.getBoundingClientRect());
    const zoom = el.currentCSSZoom || 1;
    const localClip = translationClipBox(el, s, box, zoom);
    const result: TranslationElementFacts = {
      box,
      contentBox: {
        x: box.x + el.clientLeft * zoom,
        y: box.y + el.clientTop * zoom,
        width: el.clientWidth * zoom,
        height: el.clientHeight * zoom,
      },
      zoom,
      display: s.display,
      position: s.position || 'static',
      visibility: s.visibility,
      opacity: s.opacity,
      contentVisibility: s.contentVisibility,
      overflowX: s.overflowX || s.overflow,
      overflowY: s.overflowY || s.overflow,
      contain: s.contain,
      transform: s.transform,
      filter: s.filter,
      perspective: s.perspective,
      willChange: s.willChange,
      clip:
        localClip === undefined
          ? undefined
          : localClip === null
            ? { kind: 'uncertain', rect: box, reason: 'clip-shape' }
            : localClip.width <= 0 || localClip.height <= 0
              ? { kind: 'hidden', reason: 'empty-clip' }
              : { kind: 'visible', rect: localClip },
      hidden:
        s.display === 'none' ||
        /^(hidden|collapse)$/.test(s.visibility) ||
        s.opacity === '0' ||
        s.contentVisibility === 'hidden',
      emptyOverflow:
        !['inline', 'contents'].includes(s.display) &&
        ((clipsOverflow(s.overflowX || s.overflow) && box.width === 0) ||
          (clipsOverflow(s.overflowY || s.overflow) && box.height === 0)),
    };
    cache.set(el, result);
    return result;
  };
  const containingBlock = (f: Readonly<TranslationElementFacts>, position: string) =>
    (position === 'absolute' && f.position !== 'static') ||
    hasEffect(f.transform) ||
    hasEffect(f.filter) ||
    hasEffect(f.perspective) ||
    /\b(layout|paint|strict|content)\b/.test(f.contain) ||
    /\b(transform|filter|perspective)\b/.test(f.willChange) ||
    f.contentVisibility === 'auto';

  return {
    facts,
    clip(box, node, options = {}) {
      let visible: TranslationRect | null = copyRect(box);
      let uncertainty: 'clip-shape' | 'clip-relationship' | undefined;
      let escaped: string | undefined;
      const origin = node instanceof Element ? node : node.parentElement;
      // Overflow on an intermediate ancestor does not clip an abs/fixed descendant
      // whose containing block is outside it. Transforms/containment can establish
      // that block even for fixed descendants; offsetParent alone cannot prove it.
      if (node instanceof Element && /^(absolute|fixed)$/.test(facts(node).position))
        escaped = facts(node).position;
      for (
        let el = options.includeSelf && node instanceof Element ? node : node.parentElement;
        el && el !== options.boundary && visible;
        el = el.parentElement
      ) {
        const f = facts(el);
        if (f.hidden) return { kind: 'hidden', reason: 'style' };
        if (f.clip?.kind === 'hidden') return f.clip;
        if (f.clip?.kind === 'uncertain') uncertainty = f.clip.reason;
        if (f.clip?.kind === 'visible') visible = intersectRegions(visible, f.clip.rect);
        if (!visible) break;
        if (el !== origin && escaped && containingBlock(f, escaped)) escaped = undefined;
        const ownBox = el === origin && node instanceof Element;
        const paintContainment = /\b(paint|strict|content)\b/.test(f.contain);
        // Overflow/paint containment clips descendants at the padding edge, not
        // this element's own painted border. Local clip-path and ancestor clips
        // still apply to both. Native bounds and foreground cutouts must agree.
        if (!ownBox && (!escaped || paintContainment)) {
          const x = paintContainment || clipsOverflow(f.overflowX);
          const y =
            paintContainment || (clipsOverflow(f.overflowY) && !options.unboundedY?.has(el));
          // Inline boxes do not establish overflow scrollports.
          if ((x || y) && !['inline', 'contents'].includes(f.display))
            visible = intersectRegions(visible, {
              x: x ? f.contentBox.x : visible.x,
              y: y ? f.contentBox.y : visible.y,
              width: x ? f.contentBox.width : visible.width,
              height: y ? f.contentBox.height : visible.height,
            });
        }
        if (!escaped && /^(absolute|fixed)$/.test(f.position)) escaped = f.position;
      }
      if (!visible || visible.width <= 0 || visible.height <= 0)
        return { kind: 'hidden', reason: 'empty-clip' };
      return uncertainty
        ? { kind: 'uncertain', rect: visible, reason: uncertainty }
        : { kind: 'visible', rect: visible };
    },
  };
}
