import {
  translationSegments,
  validateTranslationMarkup,
} from '../../translation/translation-markup';
import { intersectRegions, subtractRegions, type TranslationRect } from './translation-regions';
import { imageBackgrounds } from './translation-background-source';
import type { TranslationBackgroundLayer } from './translation-background';
import type { TranslationWatermark } from './translation-document';

export interface TranslationTextSource {
  key: Node;
  owner: Element;
  nodes: Text[];
  text: string;
  plain: string;
  markers: Element[];
  lines: TranslationRect[];
  tight: boolean;
}

export const translationTypography = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontVariant',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'textDecoration',
  'color',
  'direction',
] as const;

const px = (value: string) => Number.parseFloat(value) || 0;

/** The mask follows glyphs; layout can use the owned slot and empty inline spacing. */
export function translationTextSlot(source: TranslationTextSource, view: Window) {
  const owner = source.owner;
  const style = view.getComputedStyle(owner);
  const box = owner.getBoundingClientRect();
  const contentRight = (el: Element) => {
    const s = view.getComputedStyle(el);
    return el.getBoundingClientRect().right - px(s.paddingRight) - px(s.borderRightWidth);
  };
  const glyphRight = Math.max(...source.lines.map((r) => r.x + r.width));
  const left = source.tight
    ? Math.min(...source.lines.map((r) => r.x))
    : box.left + px(style.paddingLeft) + px(style.borderLeftWidth);
  const top = source.lines[0]?.y ?? box.top;
  const bottom = Math.max(...source.lines.map((r) => r.y + r.height));
  const parentStyle = owner.parentElement && view.getComputedStyle(owner.parentElement);
  const flexItem =
    parentStyle &&
    ['flex', 'inline-flex'].includes(parentStyle.display) &&
    ['row', 'row-reverse'].includes(parentStyle.flexDirection);
  let boundary = owner;
  if (
    owner.parentElement &&
    (['inline', 'inline-block'].includes(style.display) || flexItem) &&
    style.direction !== 'rtl' &&
    !owner.matches('button,input,select') &&
    ['transparent', 'rgba(0, 0, 0, 0)', ''].includes(style.backgroundColor) &&
    ['', 'none'].includes(style.backgroundImage) &&
    !px(style.borderLeftWidth) &&
    !px(style.borderRightWidth)
  )
    boundary = owner.parentElement;
  let right = Math.max(glyphRight, contentRight(boundary));
  const boundaryStyle = view.getComputedStyle(boundary);
  const boundaryBox = boundary.getBoundingClientRect();
  let upper = Math.min(
    top,
    boundaryBox.top + px(boundaryStyle.borderTopWidth) + px(boundaryStyle.paddingTop),
  );
  let lower = Math.max(
    bottom,
    boundaryBox.bottom - px(boundaryStyle.borderBottomWidth) - px(boundaryStyle.paddingBottom),
  );
  // Neighbouring icons, badges and separators are obstacles even when aria-hidden.
  // Never infer empty space by looking only at the text selected for translation.
  let visits = 0;
  const walker = owner.ownerDocument.createTreeWalker(
    boundary,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (++visits >= 256) return NodeFilter.FILTER_ACCEPT;
        if (source.nodes.some((n) => node === n || node.contains(n))) return NodeFilter.FILTER_SKIP;
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as Element,
            s = view.getComputedStyle(el);
          if (
            el.matches('[data-chatbrowserx-overlay],script,style') ||
            s.display === 'none' ||
            s.visibility === 'hidden' ||
            s.opacity === '0'
          )
            return NodeFilter.FILTER_REJECT;
          if (s.display === 'contents') return NodeFilter.FILTER_SKIP;
        } else if (!node.textContent?.trim()) return NodeFilter.FILTER_SKIP;
        const ranges =
          node.nodeType === Node.ELEMENT_NODE
            ? [(node as Element).getBoundingClientRect()]
            : (() => {
                const r = owner.ownerDocument.createRange();
                r.selectNodeContents(node);
                return [...r.getClientRects()];
              })();
        for (const r of ranges) {
          if (r.width > 0 && r.bottom > top && r.top < bottom && r.left >= glyphRight - 0.5)
            right = Math.min(right, Math.max(glyphRight, r.left - 2));
          if (r.width > 0 && r.height > 0 && r.right > left && r.left < right) {
            if (r.bottom <= top + 0.5) upper = Math.max(upper, r.bottom + 2);
            if (r.top >= bottom - 0.5) lower = Math.min(lower, r.top - 2);
          }
        }
        return NodeFilter.FILTER_REJECT;
      },
    },
  );
  while (walker.nextNode() && visits < 256) {
    /* bounded layout inspection */
  }
  if (visits >= 256) {
    right = Math.min(right, contentRight(owner));
    upper = top;
    lower = bottom;
  }
  for (let el: Element | null = owner; el; el = el.parentElement) {
    const s = view.getComputedStyle(el);
    if (/^(hidden|clip|auto|scroll)$/.test(s.overflowX || s.overflow))
      right = Math.min(right, el.getBoundingClientRect().left + el.clientLeft + el.clientWidth);
    if (/^(hidden|clip|auto|scroll)$/.test(s.overflowY || s.overflow)) {
      const y = el.getBoundingClientRect().top + el.clientTop;
      upper = Math.max(upper, y);
      lower = Math.min(lower, y + el.clientHeight);
    }
  }
  return {
    x: left,
    y: upper,
    width: Math.max(1, right - left),
    height: Math.max(1, lower - upper),
  };
}

/** Native inline layout. Source glyph bounds mask text, but never dictate translated line breaks. */
export class TranslationTextLayout {
  private context: CanvasRenderingContext2D | null = null;
  constructor(
    private readonly doc: Document,
    private readonly view: Window,
  ) {}

  paint(
    layer: HTMLElement,
    source: TranslationTextSource,
    translation: string,
    backgrounds: TranslationBackgroundLayer[] = [],
    slot = translationTextSlot(source, this.view),
    watermarks: TranslationWatermark[] = [],
  ) {
    validateTranslationMarkup(source.text, translation);
    const segments = translationSegments(translation);
    if (segments.map((s) => s.text).join('') === source.plain) {
      layer.replaceChildren();
      return true;
    }
    const first = source.lines[0];
    if (!first) return true;
    const style = this.view.getComputedStyle(source.owner);
    const left = slot.x;
    const flow = this.doc.createElement('div');
    flow.className = 'text';
    Object.assign(flow.style, {
      position: 'absolute',
      left: `${left}px`,
      top: `${first.y}px`,
      width: `${slot.width}px`,
      whiteSpace: style.whiteSpace,
      overflowWrap: 'normal',
      wordBreak: 'normal',
      textAlign: style.textAlign,
      boxSizing: 'content-box',
    });
    for (const property of translationTypography) flow.style[property] = style[property];
    for (const segment of segments) {
      const original = 'id' in segment ? source.markers[Number(segment.id)] : undefined;
      if (!original) {
        flow.append(this.doc.createTextNode(segment.text));
        continue;
      }
      const link = original.closest('a[href]');
      const span = link ? this.anchor(link) : this.doc.createElement('span');
      const inlineStyle = this.view.getComputedStyle(original);
      for (const property of translationTypography) span.style[property] = inlineStyle[property];
      // Relative sizing keeps every inline run proportional if the whole paragraph must fit.
      span.style.fontSize = `${(px(inlineStyle.fontSize) || 16) / (px(style.fontSize) || 16)}em`;
      span.textContent = segment.text;
      flow.append(span);
    }
    const background = this.background(source.owner);
    const dpr = this.view.devicePixelRatio || 1;
    const masks = source.lines.map((r) => {
      // Snap fractional edges outwards. Font rasterization can spill one device pixel above
      // or below the line box (e.g. the tail of "p"); leave horizontal icon spacing intact.
      const left = Math.floor(r.x * dpr) / dpr,
        top = (Math.floor(r.y * dpr) - 1) / dpr;
      const mask = this.doc.createElement('div');
      mask.className = 'source-mask';
      Object.assign(mask.style, {
        position: 'absolute',
        left: `${left}px`,
        top: `${top}px`,
        width: `${Math.ceil((r.x + r.width) * dpr) / dpr - left}px`,
        height: `${(Math.ceil((r.y + r.height) * dpr) + 1) / dpr - top}px`,
        background: backgrounds.length
          ? backgrounds
              .map(({ image, box }) =>
                box
                  ? `${image} ${box.x - left}px ${box.y - top}px / ${box.width}px ${box.height}px no-repeat`
                  : image,
              )
              .join(', ') + ', white'
          : background,
      });
      return mask;
    });
    // Replace synchronously in one task. Never clear a visible layer while waiting for a model/frame.
    layer.replaceChildren(...masks, flow);
    if (!flow.isConnected) return true;
    const range = this.doc.createRange();
    range.selectNodeContents(flow);
    const glyphs = () =>
      Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    let size = px(style.fontSize) || 16;
    const minimum = Math.min(size, Math.max(12, size * 0.85));
    const leading = px(style.lineHeight) || size * 1.2;
    let wrapped = false;
    for (;;) {
      const rects = glyphs();
      if (!rects.length) break; // Detached/unit-test documents have no layout.
      const top = Math.min(...rects.map((r) => r.y));
      const height = Math.max(...rects.map((r) => r.bottom)) - top;
      const width = Math.max(...rects.map((r) => r.right)) - Math.min(...rects.map((r) => r.left));
      const targetTop = Math.max(slot.y, Math.min(first.y, slot.y + slot.height - height));
      flow.style.top = `${px(flow.style.top) + targetTop - top}px`;
      if (height <= slot.height + 1 && width <= slot.width + 1) break;
      if (!wrapped && style.whiteSpace !== 'pre' && slot.height >= first.height * 1.7) {
        // Use existing vertical room before shrinking glyphs. This also avoids copying a
        // one-line label's large centering line-height onto every wrapped English line.
        wrapped = true;
        if (style.whiteSpace === 'nowrap') flow.style.whiteSpace = 'normal';
        flow.style.lineHeight = '1.15';
        for (const el of flow.children) (el as HTMLElement).style.lineHeight = 'inherit';
        continue;
      }
      if (size <= minimum) {
        if (style.textOverflow === 'ellipsis') {
          // Keep the source's explicit truncation contract, not an unreadable tiny font or
          // a silent return to Chinese. The full validated translation remains on hover.
          flow.style.fontSize = style.fontSize;
          const link = source.owner.closest('a[href]');
          if (link && !flow.querySelector('a')) {
            const anchor = this.anchor(link);
            anchor.style.cssText += ';font:inherit;color:inherit;text-decoration:inherit';
            anchor.append(...flow.childNodes);
            flow.append(anchor);
          }
          flow.title = segments.map((s) => s.text).join('');
          const font = Math.max(
            px(style.fontSize),
            ...[...flow.querySelectorAll('*')].map((el) =>
              px(this.view.getComputedStyle(el).fontSize),
            ),
          );
          const lines = Math.max(1, Math.floor(slot.height / (font * 1.1)));
          Object.assign(flow.style, {
            top: `${slot.y}px`,
            height: `${slot.height}px`,
            overflow: 'hidden',
            whiteSpace: lines > 1 ? 'normal' : 'nowrap',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            webkitBoxOrient: 'vertical',
            webkitLineClamp: String(lines),
            lineHeight: '1.1',
          });
          for (const el of flow.children) (el as HTMLElement).style.lineHeight = 'inherit';
          break;
        }
        layer.replaceChildren();
        return false;
      }
      size = Math.max(minimum, size * 0.9);
      flow.style.fontSize = `${size}px`;
      if (!wrapped) flow.style.lineHeight = `${(leading * size) / (px(style.fontSize) || 16)}px`;
      for (const el of flow.children) (el as HTMLElement).style.lineHeight = 'inherit';
    }
    const sourceLink = source.owner.closest('a[href]');
    if (sourceLink && !source.markers.length) {
      // Keep native/trusted clicks inside the original anchor. Only the newly exposed glyph
      // area needs a hit target; it uses the same source handler/href as other translated links.
      for (const glyph of glyphs()) {
        const visible =
          flow.style.overflow === 'hidden'
            ? intersectRegions(glyph, flow.getBoundingClientRect())
            : glyph;
        if (!visible) continue;
        for (const r of subtractRegions(visible, [...sourceLink.getClientRects()])) {
          const hit = this.anchor(sourceLink);
          hit.tabIndex = -1;
          hit.setAttribute('aria-hidden', 'true');
          Object.assign(hit.style, {
            position: 'absolute',
            left: `${r.x}px`,
            top: `${r.y}px`,
            width: `${r.width}px`,
            height: `${r.height}px`,
          });
          layer.append(hit);
        }
      }
    }
    // The page's watermark stays untouched. Reproduce it only where an opaque source mask
    // would hide it, preserving its viewport-aligned pattern without doubling it elsewhere.
    for (const mask of masks)
      for (const watermark of watermarks) {
        const box = {
          x: px(mask.style.left),
          y: px(mask.style.top),
          width: px(mask.style.width),
          height: px(mask.style.height),
        };
        if (!intersectRegions(box, watermark.box)) continue;
        const clip = this.doc.createElement('div');
        clip.setAttribute('aria-hidden', 'true');
        Object.assign(clip.style, {
          position: 'absolute',
          left: mask.style.left,
          top: mask.style.top,
          width: mask.style.width,
          height: mask.style.height,
          overflow: 'hidden',
          pointerEvents: 'none',
        });
        const pattern = this.doc.createElement('div');
        pattern.className = 'translation-watermark';
        Object.assign(pattern.style, watermark.style, {
          position: 'absolute',
          left: `${watermark.box.x - box.x}px`,
          top: `${watermark.box.y - box.y}px`,
          width: `${watermark.box.width}px`,
          height: `${watermark.box.height}px`,
        });
        clip.append(pattern);
        layer.append(clip);
      }
    return true;
  }

  private anchor(link: Element) {
    const anchor = this.doc.createElement('a');
    anchor.setAttribute('href', link.getAttribute('href') ?? '');
    for (const attr of ['target', 'rel', 'download']) {
      const value = link.getAttribute(attr);
      if (value !== null) anchor.setAttribute(attr, value);
    }
    anchor.style.pointerEvents = 'auto';
    // Modified clicks retain native href semantics; normal clicks retain source/SPA handlers.
    anchor.addEventListener('click', (event) => {
      if (
        event instanceof MouseEvent &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        link.isConnected
      ) {
        event.preventDefault();
        (link as HTMLElement).click();
      }
    });
    return anchor;
  }

  private background(owner: Element) {
    const context = (this.context ??= this.doc.createElement('canvas').getContext('2d'));
    if (!context) return 'white';
    context.fillStyle = 'white';
    context.fillRect(0, 0, 1, 1);
    for (const color of imageBackgrounds(owner)) {
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
    }
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  }
}
