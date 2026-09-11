import type { TranslationTextResult, TranslationTexts } from '../../translation/region-translation';
import { intersectRegions, subtractRegions, type TranslationRect } from './translation-regions';
import { imageBackgrounds } from './translation-images';

const ignored =
  'script,style,noscript,template,input,textarea,select,[contenteditable],[data-chatbrowserx-overlay]';
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const inline = (style: CSSStyleDeclaration) => ['inline', 'contents'].includes(style.display);
const rect = (r: DOMRect): TranslationRect => ({
  x: r.x,
  y: r.y,
  width: r.width,
  height: r.height,
});

interface SourceBlock {
  owner: Element;
  nodes: Text[];
  text: string;
  lines: TranslationRect[];
}
interface TextEntry extends SourceBlock {
  id: string;
  translation?: string;
  preview?: string;
  layer: HTMLElement;
  renderKey?: string;
}

/** Complete nearby source blocks, not text clipped by the observation window. */
function collect(doc: Document, view: Window, area: TranslationRect) {
  const owners = new Set<Element>(),
    visual: TranslationRect[] = [],
    images: HTMLImageElement[] = [];
  const visible = (el: Element) => {
    const style = view.getComputedStyle(el);
    return (
      !el.matches(ignored) &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0'
    );
  };
  if (!doc.body || !visible(doc.body)) return { blocks: [], visual: [], images: [] };
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE)
        return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      const el = node as Element;
      if (!visible(el)) return NodeFilter.FILTER_REJECT;
      const r = rect(el.getBoundingClientRect());
      if (r.width > 0 && r.height > 0 && !intersectRegions(r, area))
        return NodeFilter.FILTER_REJECT;
      const style = view.getComputedStyle(el);
      const painted =
        el.matches('img,canvas,video,iframe,object,embed') ||
        (el.matches('svg') && (r.width > 48 || el.querySelector('text,foreignObject') !== null)) ||
        (style.backgroundImage !== 'none' && style.backgroundImage !== '') ||
        (style.transform !== 'none' && style.transform !== '') ||
        (style.filter && style.filter !== 'none') ||
        (style.opacity && style.opacity !== '1') ||
        (style.mixBlendMode && style.mixBlendMode !== 'normal') ||
        (el.getAnimations?.().length ?? 0) > 0 ||
        el.shadowRoot !== null;
      if (painted) {
        if (r.width > 0 && r.height > 0) {
          visual.push(r);
          if (
            el instanceof HTMLImageElement &&
            style.objectFit === 'fill' &&
            style.transform === 'none' &&
            style.filter === 'none' &&
            style.opacity === '1' &&
            style.clipPath === 'none' &&
            style.borderRadius === '0px' &&
            !el.getAnimations().length &&
            [
              style.paddingLeft,
              style.paddingRight,
              style.paddingTop,
              style.paddingBottom,
              style.borderLeftWidth,
              style.borderRightWidth,
              style.borderTopWidth,
              style.borderBottomWidth,
            ].every((v) => v === '0px')
          )
            images.push(el);
        }
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node: Node | null,
    visits = 0;
  while ((node = walker.nextNode()) && visits++ < 10000) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    let owner = node.parentElement;
    while (owner?.parentElement && inline(view.getComputedStyle(owner)))
      owner = owner.parentElement;
    if (owner && owners.size < 128 && owner.getBoundingClientRect().width > 0) owners.add(owner);
  }
  const blocks: SourceBlock[] = [];
  for (const owner of owners) {
    const nodes: Text[] = [];
    const texts = doc.createTreeWalker(owner, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        return visible(n as Element) && inline(view.getComputedStyle(n as Element))
          ? NodeFilter.FILTER_SKIP
          : NodeFilter.FILTER_REJECT;
      },
    });
    while ((node = texts.nextNode()))
      if (node.nodeType === Node.TEXT_NODE) nodes.push(node as Text);
    // Independent labels keep their native link bounds. Mixed prose stays a complete paragraph.
    const links = new Map<Element, Text[]>();
    let prose = false;
    for (const n of nodes) {
      const link = n.parentElement?.closest('a[href]');
      if (link && owner.contains(link)) {
        const label = links.get(link) ?? [];
        label.push(n);
        links.set(link, label);
      } else if (/[\p{L}\p{N}]/u.test(n.data)) prose = true;
    }
    const groups = !prose && links.size ? links : [[owner, nodes] as const];
    for (const [sourceOwner, nodes] of groups) {
      const text = normalize(nodes.map((n) => n.data).join(''));
      if (!text) continue;
      if (text.length > 8000) {
        visual.push(rect(sourceOwner.getBoundingClientRect()));
        continue;
      }
      const lines: TranslationRect[] = [];
      for (const n of nodes) {
        const range = doc.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) {
          if (r.width < 1 || r.height < 1) continue;
          const line = lines.find(
            (l) => Math.abs(l.y - r.y) < 2 && Math.abs(l.height - r.height) < 3,
          );
          if (line) {
            const right = Math.max(line.x + line.width, r.right);
            line.x = Math.min(line.x, r.x);
            line.width = right - line.x;
            line.height = Math.max(line.height, r.height);
          } else lines.push(rect(r));
        }
      }
      lines.sort((a, b) => a.y - b.y || a.x - b.x);
      if (lines.some((r) => intersectRegions(r, area)))
        blocks.push({ owner: sourceOwner, nodes, text, lines });
      if (blocks.length === 128) return { blocks, visual, images };
    }
  }
  return { blocks, visual, images };
}

/** A small source-anchored cache. No screenshot, source DOM replacement, or durable state. */
export class TranslationDom {
  readonly entries = new Map<Element, TextEntry>();
  context: CanvasRenderingContext2D | null = null;
  visible: TextEntry[] = [];
  visual: TranslationRect[] = [];
  images: HTMLImageElement[] = [];
  visualKey = '';
  area: TranslationRect | null = null;
  sequence = 0;

  constructor(
    readonly doc: Document,
    readonly view: Window,
    readonly layer: HTMLElement,
    readonly cache = new Map<Element, { text: string; translation: string }>(),
  ) {}

  invalidate() {
    this.area = null;
  }

  update(area: TranslationRect, observation: TranslationRect = area) {
    if (this.area && !subtractRegions(observation, [this.area]).length) return;
    this.area = area;
    const source = collect(this.doc, this.view, area);
    this.visual = source.visual;
    this.images = source.images;
    this.visualKey = JSON.stringify([
      source.visual,
      source.images.map((i) => [
        i.currentSrc || i.src,
        i.complete,
        i.naturalWidth,
        i.naturalHeight,
        imageBackgrounds(i),
      ]),
    ]);
    this.visible = source.blocks.map((block) => {
      let entry = this.entries.get(block.owner);
      if (entry?.text !== block.text) {
        entry?.layer.remove();
        entry = { ...block, id: `text-${++this.sequence}`, layer: this.doc.createElement('div') };
        const saved = this.cache.get(block.owner);
        if (saved?.text === block.text) {
          entry.translation = saved.translation;
          this.cache.delete(block.owner);
          this.cache.set(block.owner, saved);
        }
      } else Object.assign(entry, block);
      this.entries.delete(block.owner);
      this.entries.set(block.owner, entry);
      return entry;
    });
    while (this.entries.size > 128) {
      const first = this.entries.keys().next().value;
      if (!first) break;
      this.entries.get(first)?.layer.remove();
      this.entries.delete(first);
    }
    for (const [owner, saved] of this.cache) {
      if (
        !owner.isConnected ||
        (this.entries.has(owner) && this.entries.get(owner)?.text !== saved.text)
      )
        this.cache.delete(owner);
    }
    this.layer.replaceChildren(...this.visible.map((e) => e.layer));
    for (const entry of this.visible)
      if (entry.translation !== undefined || entry.preview !== undefined) this.paint(entry);
  }

  missing(pending?: ReadonlySet<string>): TranslationTexts['texts'] {
    let size = 0;
    return this.visible
      .filter((entry) => {
        if (
          entry.translation !== undefined ||
          pending?.has(entry.id) ||
          size + entry.text.length > 16000
        )
          return false;
        size += entry.text.length;
        return true;
      })
      .slice(0, 32)
      .map(({ id, text }) => ({ id, text }));
  }

  accept(result: TranslationTextResult, preview = false) {
    for (const block of result.blocks) {
      const entry = [...this.entries.values()].find((e) => e.id === block.id);
      if (
        !entry ||
        !entry.owner.isConnected ||
        entry.nodes.some((n) => !n.isConnected) ||
        normalize(entry.nodes.map((n) => n.data).join('')) !== entry.text
      )
        continue;
      if (preview) {
        if (entry.translation !== undefined) continue;
        entry.preview = block.translation;
      } else {
        entry.translation = block.translation;
        delete entry.preview;
        this.cache.delete(entry.owner);
        this.cache.set(entry.owner, { text: entry.text, translation: block.translation });
        if (this.cache.size > 128) {
          const oldest = this.cache.keys().next().value;
          if (oldest) this.cache.delete(oldest);
        }
      }
      this.paint(entry);
    }
  }

  clearPreview(ids: ReadonlySet<string>) {
    for (const entry of this.entries.values()) {
      if (entry.preview === undefined || !ids.has(entry.id)) continue;
      delete entry.preview;
      this.paint(entry);
    }
  }

  /** Mask DOM-owned text in mixed visual captures; neither model nor cache paints it twice. */
  textRects() {
    return this.visible.flatMap((e) => e.lines);
  }

  private paint(entry: TextEntry) {
    const translation = entry.translation ?? entry.preview;
    if (!translation || normalize(translation) === entry.text) {
      entry.layer.replaceChildren();
      delete entry.renderKey;
      return;
    }
    const style = this.view.getComputedStyle(entry.owner);
    const ownerBox = entry.owner.getBoundingClientRect();
    let background = 'rgb(255, 255, 255)',
      ancestor: Element | null = entry.owner;
    while (ancestor) {
      const color = this.view.getComputedStyle(ancestor).backgroundColor;
      if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') {
        background = color;
        break;
      }
      ancestor = ancestor.parentElement;
    }
    const key = JSON.stringify([
      translation,
      entry.lines,
      style.font,
      style.color,
      style.textDecoration,
      background,
      ownerBox.width,
    ]);
    if (entry.renderKey === key) return;
    entry.renderKey = key;
    entry.layer.replaceChildren();
    const context = (this.context ??= this.doc.createElement('canvas').getContext('2d'));
    if (!context) return;
    const characters = Array.from(
      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(translation),
      (s) => s.segment,
    );
    const font = (size: number) =>
      `${style.fontStyle} ${style.fontWeight} ${size}px ${style.fontFamily}`;
    const lines = entry.lines.map((line) => ({ ...line }));
    const line = lines[0];
    // A plain, left-aligned block can use its own empty inline space. A glyph rectangle is the
    // source mask, not the layout width. Keep tight controls and mixed inline content bounded.
    if (
      lines.length === 1 &&
      line &&
      entry.owner.childElementCount === 0 &&
      style.display === 'block' &&
      style.direction !== 'rtl' &&
      ['left', 'start', ''].includes(style.textAlign)
    ) {
      const box = ownerBox;
      const left =
        box.x +
        (Number.parseFloat(style.paddingLeft) || 0) +
        (Number.parseFloat(style.borderLeftWidth) || 0);
      const right =
        box.right -
        (Number.parseFloat(style.paddingRight) || 0) -
        (Number.parseFloat(style.borderRightWidth) || 0);
      if (Math.abs(line.x - left) < 2) line.width = Math.max(line.width, right - line.x);
    }
    const layout = (size: number) => {
      context.font = font(size);
      let offset = 0;
      let available = lines.reduce((width, line) => width + line.width, 0);
      const rendered = lines.map((line, index) => {
        // Spread shorter translations over the original lines instead of leaving the tail blank.
        const target =
          index === lines.length - 1
            ? line.width
            : Math.min(
                line.width,
                (context.measureText(characters.slice(offset).join('')).width * line.width) /
                  available,
              );
        available -= line.width;
        let end = offset,
          high = characters.length;
        while (end < high) {
          const middle = Math.ceil((end + high) / 2);
          if (context.measureText(characters.slice(offset, middle).join('')).width <= target)
            end = middle;
          else high = middle - 1;
        }
        if (end < characters.length && /[a-zA-Z]/.test(characters[end] ?? '')) {
          const lastSpace = characters.slice(offset, end).lastIndexOf(' ');
          if (lastSpace > 0) end = offset + lastSpace + 1;
        }
        const text = characters.slice(offset, end).join('');
        offset = end;
        return text;
      });
      return {
        lines: rendered,
        complete: offset === characters.length,
        remaining: characters.slice(offset).join(''),
      };
    };
    let size = Number.parseFloat(style.fontSize) || 16,
      fitted = layout(size);
    while (!fitted.complete && size > 4) {
      size *= 0.9;
      fitted = layout(size);
    }
    // Never silently drop the tail, even for unusually expansive translations in tiny sources.
    if (!fitted.complete && fitted.lines.length)
      fitted.lines[fitted.lines.length - 1] += fitted.remaining;
    lines.forEach((r, index) => {
      const padding = entry.owner.matches('a[href]') ? 0 : 1;
      const span = this.doc.createElement('span');
      span.className = 'text';
      span.textContent = fitted.lines[index] ?? '';
      Object.assign(span.style, {
        position: 'absolute',
        left: `${r.x - padding}px`,
        top: `${r.y - padding}px`,
        width: `${Math.min(r.width, Math.max(entry.lines[index]?.width ?? 0, context.measureText(span.textContent).width))}px`,
        height: `${r.height}px`,
        padding: `${padding}px`,
        whiteSpace: 'pre',
        font: font(size),
        lineHeight: `${r.height}px`,
        color: style.color,
        textDecoration: style.textDecoration,
        background,
      });
      const width = context.measureText(span.textContent).width;
      if (width > r.width) span.style.fontSize = `${(size * r.width) / width}px`;
      entry.layer.append(span);
    });
  }
}
