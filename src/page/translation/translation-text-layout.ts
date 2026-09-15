import {
  translationSegments,
  validateTranslationMarkup,
} from '../../translation/translation-markup';
import type { TranslationRect } from './translation-regions';
import { imageBackgrounds } from './translation-images';
import type { TranslationBackgroundLayer } from './translation-background';

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

const typography = [
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
  ) {
    validateTranslationMarkup(source.text, translation);
    const segments = translationSegments(translation);
    if (segments.map((s) => s.text).join('') === source.plain) {
      layer.replaceChildren();
      return;
    }
    const first = source.lines[0];
    if (!first) return;
    const style = this.view.getComputedStyle(source.owner),
      box = source.owner.getBoundingClientRect();
    const px = (value: string) => Number.parseFloat(value) || 0;
    const left = source.tight
      ? Math.min(...source.lines.map((r) => r.x))
      : box.left + px(style.paddingLeft) + px(style.borderLeftWidth);
    const right = source.tight
      ? Math.max(...source.lines.map((r) => r.x + r.width))
      : box.right - px(style.paddingRight) - px(style.borderRightWidth);
    const bottom = Math.max(...source.lines.map((r) => r.y + r.height));
    const flow = this.doc.createElement('div');
    flow.className = 'text';
    Object.assign(flow.style, {
      position: 'absolute',
      left: `${left}px`,
      top: `${first.y}px`,
      width: `${Math.max(1, right - left)}px`,
      whiteSpace: ['pre', 'pre-wrap', 'break-spaces'].includes(style.whiteSpace)
        ? 'pre-wrap'
        : 'normal',
      overflowWrap: 'anywhere',
      textAlign: style.textAlign,
      boxSizing: 'content-box',
    });
    for (const property of typography) flow.style[property] = style[property];
    for (const segment of segments) {
      const original = 'id' in segment ? source.markers[Number(segment.id)] : undefined;
      if (!original) {
        flow.append(this.doc.createTextNode(segment.text));
        continue;
      }
      const link = original.closest('a[href]');
      const span = this.doc.createElement(link ? 'a' : 'span');
      const inlineStyle = this.view.getComputedStyle(original);
      for (const property of typography) span.style[property] = inlineStyle[property];
      // Relative sizing keeps every inline run proportional if the whole paragraph must fit.
      span.style.fontSize = `${(px(inlineStyle.fontSize) || 16) / (px(style.fontSize) || 16)}em`;
      span.textContent = segment.text;
      if (link) {
        span.setAttribute('href', link.getAttribute('href') ?? '');
        for (const attr of ['target', 'rel', 'download']) {
          const value = link.getAttribute(attr);
          if (value !== null) span.setAttribute(attr, value);
        }
        span.style.pointerEvents = 'auto';
        // Normal clicks retain source handlers (including SPA navigation). Modified clicks retain native href semantics.
        span.addEventListener('click', (event) => {
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
      }
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
    if (!flow.isConnected) return;
    const range = this.doc.createRange();
    range.selectNodeContents(flow);
    const glyphs = () =>
      Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    let size = px(style.fontSize) || 16;
    const leading = px(style.lineHeight) || size * 1.2;
    for (;;) {
      const rects = glyphs();
      if (!rects.length) break; // Detached/unit-test documents have no layout.
      const top = Math.min(...rects.map((r) => r.y));
      flow.style.top = `${px(flow.style.top) + first.y - top}px`;
      const height = Math.max(...rects.map((r) => r.bottom)) - top;
      const width = Math.max(...rects.map((r) => r.right)) - Math.min(...rects.map((r) => r.left));
      if (height <= bottom - first.y + 1 && width <= right - left + 1) break;
      if (size <= 4) {
        layer.replaceChildren();
        throw new Error('Translation does not fit its source block.');
      }
      size = Math.max(4, size * 0.9);
      flow.style.fontSize = `${size}px`;
      flow.style.lineHeight = `${(leading * size) / (px(style.fontSize) || 16)}px`;
      for (const el of flow.children) (el as HTMLElement).style.lineHeight = 'inherit';
    }
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
