import type { TranslationTextResult, TranslationTexts } from '../../translation/region-translation';
import { intersectRegions, subtractRegions, type TranslationRect } from './translation-regions';
import { imageBackgrounds, supportsImageLayout } from './translation-background-source';
import { escapeTranslationText } from '../../translation/translation-markup';
import {
  TranslationTextLayout,
  translationTextSlot,
  translationTypography,
  type TranslationTextSource,
} from './translation-text-layout';
import { gradientBackground, isSimpleGradient, textBackground } from './translation-background';
import { translationEditable } from './translation-editability';
import {
  isTranslationDocumentPlaceholder,
  isTranslationDocumentText,
  translationDocumentWatermark,
  type TranslationWatermark,
} from './translation-document';

const ignored =
  'script,style,noscript,template,input,textarea,select,[hidden],[inert],[aria-hidden="true"],[data-chatbrowserx-overlay]';
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const inline = (style: CSSStyleDeclaration) => ['inline', 'contents'].includes(style.display);
const rect = (r: DOMRect): TranslationRect => ({
  x: r.x,
  y: r.y,
  width: r.width,
  height: r.height,
});

type SourceBlock = TranslationTextSource;
interface TextEntry extends SourceBlock {
  id: string;
  translation?: string;
  preview?: string;
  layer: HTMLElement;
  renderKey?: string;
  renderOrigin?: { x: number; y: number };
}

/** Complete nearby source blocks, not text clipped by the observation window. */
function collect(doc: Document, view: Window, area: TranslationRect) {
  const owners = new Set<Element>(),
    visual: TranslationRect[] = [],
    unsupported: TranslationRect[] = [],
    images: HTMLImageElement[] = [],
    watermarks: TranslationWatermark[] = [];
  const visible = (el: Element) => {
    const style = view.getComputedStyle(el);
    const disclosure = el.parentElement?.matches('details:not([open])');
    return (
      !el.matches(ignored) &&
      !isTranslationDocumentPlaceholder(el) &&
      (!disclosure || el === el.parentElement?.querySelector('summary')) &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.visibility !== 'collapse' &&
      style.opacity !== '0' &&
      style.contentVisibility !== 'hidden' &&
      (!style.clipPath || style.clipPath === 'none') &&
      (!style.clip || style.clip === 'auto')
    );
  };
  // An overlay cannot inherit source clipping. Preserve partially clipped text rather
  // than exposing it outside a hidden menu or a scroll container's painted area.
  type Clip = {
    box: TranslationRect;
    x: boolean;
    y: boolean;
    ellipsis: boolean;
    element: Element;
  };
  const clips = new Map<Element, Clip[]>();
  const clippingParents = (el: Element | null): Clip[] => {
    if (!el) return [];
    const cached = clips.get(el);
    if (cached) return cached;
    const parents = clippingParents(el.parentElement);
    const s = view.getComputedStyle(el);
    const x = /^(hidden|clip|auto|scroll)$/.test(s.overflowX || s.overflow);
    const y = /^(hidden|clip|auto|scroll)$/.test(s.overflowY || s.overflow);
    let result = parents;
    if (x || y) {
      const r = el.getBoundingClientRect();
      result = [
        ...parents,
        {
          x,
          y,
          element: el,
          ellipsis: s.textOverflow === 'ellipsis' && s.whiteSpace === 'nowrap',
          box: {
            x: r.x + el.clientLeft,
            y: r.y + el.clientTop,
            width: el.clientWidth,
            height: el.clientHeight,
          },
        },
      ];
    }
    clips.set(el, result);
    return result;
  };
  if (!doc.body || !visible(doc.body))
    return { blocks: [], visual, images, unsupported, watermarks };
  let visits = 0;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // FILTER_REJECT nodes never reach nextNode(). Count them here, then return once
      // over budget so the outer loop can stop without inspecting the remaining subtree.
      if (++visits > 10000) return NodeFilter.FILTER_ACCEPT;
      if (node.nodeType === Node.TEXT_NODE)
        return node.textContent?.trim() &&
          !translationEditable(node.parentElement) &&
          !node.parentElement?.matches('details:not([open])')
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      const el = node as Element;
      if (!visible(el)) return NodeFilter.FILTER_REJECT;
      // Editable containers may contain explicit read-only document islands.
      if (translationEditable(el)) return NodeFilter.FILTER_SKIP;
      const r = rect(el.getBoundingClientRect());
      if (r.width > 0 && r.height > 0 && !intersectRegions(r, area))
        return NodeFilter.FILTER_REJECT;
      const style = view.getComputedStyle(el);
      const watermark = translationDocumentWatermark(el, view);
      if (watermark) {
        watermarks.push(watermark);
        return NodeFilter.FILTER_REJECT;
      }
      const icon = el.matches('svg')
        ? el
        : el.childElementCount === 1 && el.firstElementChild?.matches('svg')
          ? el.firstElementChild
          : null;
      // Decorative icons are not translatable DOM text.
      if (
        icon &&
        r.width <= 48 &&
        r.height <= 48 &&
        !el.textContent?.trim() &&
        !icon.querySelector('text,foreignObject,image,use')
      )
        return NodeFilter.FILTER_REJECT;
      const painted =
        el.matches('img,canvas,video,iframe,object,embed') ||
        (el.matches('svg') && (r.width > 48 || el.querySelector('text,foreignObject') !== null)) ||
        (style.backgroundImage !== 'none' &&
          style.backgroundImage !== '' &&
          !isSimpleGradient(style)) ||
        !['none', '', 'matrix(1, 0, 0, 1, 0, 0)'].includes(style.transform) ||
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
            supportsImageLayout(style) &&
            !gradientBackground(el, view).length &&
            style.transform === 'none' &&
            style.filter === 'none' &&
            style.opacity === '1' &&
            style.clipPath === 'none' &&
            !el.getAnimations().length
          )
            images.push(el);
          // Media is intentionally left unchanged in text-only translation. Only DOM text
          // behind unsupported compositing warrants a text-translation warning.
          else if (
            !el.matches('img,canvas,video,iframe,object,embed,svg') &&
            el.textContent?.trim()
          )
            unsupported.push(r);
        }
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node: Node | null;
  while ((node = walker.nextNode()) && visits <= 10000) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    let owner = node.parentElement;
    while (
      owner?.parentElement &&
      inline(view.getComputedStyle(owner)) &&
      !translationEditable(owner.parentElement) &&
      !owner.parentElement.matches('details:not([open])')
    )
      owner = owner.parentElement;
    if (owner && owners.size < 128 && owner.getBoundingClientRect().width > 0) owners.add(owner);
  }
  const blocks: SourceBlock[] = [];
  for (const owner of owners) {
    let run: Text[] = [];
    const runs: Text[][] = [run];
    // Flex/grid text is a label slot beside other items, not the container's full content box.
    let tight = ['flex', 'inline-flex', 'grid', 'inline-grid'].includes(
      view.getComputedStyle(owner).display,
    );
    const texts = doc.createTreeWalker(owner, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === Node.TEXT_NODE)
          return translationEditable(n.parentElement)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        const el = n as Element;
        if (isTranslationDocumentPlaceholder(el)) return NodeFilter.FILTER_REJECT;
        if (el.tagName !== 'BR' && visible(el) && inline(view.getComputedStyle(el)))
          return NodeFilter.FILTER_SKIP;
        if (view.getComputedStyle(el).display === 'inline-block') tight = true;
        if (run.length) {
          run = [];
          runs.push(run);
        }
        return NodeFilter.FILTER_REJECT;
      },
    });
    while ((node = texts.nextNode())) if (node.nodeType === Node.TEXT_NODE) run.push(node as Text);
    for (const nodes of runs.filter((run) => normalize(run.map((n) => n.data).join('')))) {
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
        const plain = normalize(nodes.map((n) => n.data).join(''));
        if (!plain) continue;
        const markers: Element[] = [];
        const segments: { element: Element; text: string }[] = [];
        const documentStyle = isTranslationDocumentText(sourceOwner)
          ? view.getComputedStyle(sourceOwner)
          : null;
        for (const n of nodes) {
          let element = n.parentElement ?? sourceOwner;
          // Docx splits identical prose into editor runs (including after hydration).
          // Those boundaries are not styles the model should preserve. Keep real formatting
          // and every link identity, using exactly the properties the renderer copies.
          if (documentStyle && !element.closest('a[href]')) {
            const style = view.getComputedStyle(element);
            if (translationTypography.every((p) => style[p] === documentStyle[p]))
              element = sourceOwner;
          }
          const last = segments[segments.length - 1];
          if (last?.element === element) last.text += n.data;
          else segments.push({ element, text: n.data });
        }
        const marked = segments.some((s) => s.element !== sourceOwner);
        const text = normalize(
          segments
            .map((s) => {
              const escaped = escapeTranslationText(s.text);
              if (!marked) return escaped;
              if (s.element === sourceOwner || !s.text.trim()) return escaped;
              const id = markers.push(s.element) - 1;
              return `<m${id}>${escaped}</m${id}>`;
            })
            .join(''),
        );
        if (text.length > 8000) {
          visual.push(rect(sourceOwner.getBoundingClientRect()));
          unsupported.push(rect(sourceOwner.getBoundingClientRect()));
          continue;
        }
        const lines: TranslationRect[] = [];
        let clipped = false;
        for (const n of nodes) {
          const range = doc.createRange();
          range.selectNodeContents(n);
          for (const measured of range.getClientRects()) {
            let r = measured;
            if (r.width < 1 || r.height < 1) continue;
            for (const { box, x, y, ellipsis, element } of clippingParents(n.parentElement)) {
              if (x && (r.x < box.x - 0.5 || r.right > box.x + box.width + 0.5)) {
                // A visible ellipsized title is not a hidden menu. Translate the full title,
                // but mask only its painted horizontal slice (including the ellipsis).
                if (ellipsis && (element === sourceOwner || sourceOwner.contains(element))) {
                  const left = Math.max(r.x, box.x);
                  r = new DOMRect(
                    left,
                    r.y,
                    Math.max(0, Math.min(r.right, box.x + box.width) - left),
                    r.height,
                  );
                } else clipped = true;
              }
              if (y && (r.y < box.y - 0.5 || r.bottom > box.y + box.height + 0.5)) clipped = true;
            }
            if (r.width < 1) continue;
            const line = lines.find(
              (l) =>
                Math.abs(l.y - r.y) < 2 &&
                Math.abs(l.height - r.height) < 3 &&
                r.x <= l.x + l.width + 2 &&
                r.right >= l.x - 2,
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
        if (!clipped && lines.some((r) => intersectRegions(r, area)))
          blocks.push({
            key: runs.length > 1 && sourceOwner === owner ? (nodes[0] ?? sourceOwner) : sourceOwner,
            owner: sourceOwner,
            nodes,
            text,
            plain,
            markers,
            lines,
            tight: tight || sourceOwner !== owner || inline(view.getComputedStyle(sourceOwner)),
          });
        if (blocks.length === 128) return { blocks, visual, images, unsupported, watermarks };
      }
    }
  }
  return { blocks, visual, images, unsupported, watermarks };
}

/** A small source-anchored cache. No screenshot, source DOM replacement, or durable state. */
export class TranslationDom {
  readonly entries = new Map<Node, TextEntry>();
  readonly layoutErrors = new Set<string>();
  readonly layoutUnsupported = new Set<string>();
  private readonly layout: TranslationTextLayout;
  visible: TextEntry[] = [];
  visual: TranslationRect[] = [];
  unsupported: TranslationRect[] = [];
  images: HTMLImageElement[] = [];
  private watermarks: TranslationWatermark[] = [];
  area: TranslationRect | null = null;
  sequence = 0;

  constructor(
    readonly doc: Document,
    readonly view: Window,
    readonly layer: HTMLElement,
    readonly cache = new Map<Node, { text: string; translation: string }>(),
    private readonly imageReady: (image: HTMLImageElement) => boolean = () => false,
  ) {
    this.layout = new TranslationTextLayout(doc, view);
  }

  invalidate() {
    this.area = null;
  }

  retryLayout() {
    for (const entry of this.entries.values())
      if (this.layoutErrors.has(entry.id)) delete entry.renderKey;
    this.layoutErrors.clear();
    this.invalidate();
  }

  update(area: TranslationRect, observation: TranslationRect = area) {
    if (this.area && !subtractRegions(observation, [this.area]).length) return;
    this.area = area;
    const source = collect(this.doc, this.view, area);
    this.visual = source.visual;
    this.unsupported = source.unsupported;
    this.images = source.images;
    this.watermarks = source.watermarks;
    this.visible = source.blocks.map((block) => {
      let entry = this.entries.get(block.key);
      if (entry?.text !== block.text) {
        if (entry) {
          this.layoutErrors.delete(entry.id);
          this.layoutUnsupported.delete(entry.id);
        }
        entry?.layer.remove();
        entry = {
          ...block,
          id: `text-${++this.sequence}`,
          layer: this.doc.createElement('div'),
        };
        const saved = this.cache.get(block.key);
        if (saved?.text === block.text) {
          entry.translation = saved.translation;
          this.cache.delete(block.key);
          this.cache.set(block.key, saved);
        }
      } else Object.assign(entry, block);
      this.entries.delete(block.key);
      this.entries.set(block.key, entry);
      return entry;
    });
    while (this.entries.size > 128) {
      const first = this.entries.keys().next().value;
      if (!first) break;
      this.entries.get(first)?.layer.remove();
      const entry = this.entries.get(first);
      if (entry) {
        this.layoutErrors.delete(entry.id);
        this.layoutUnsupported.delete(entry.id);
      }
      this.entries.delete(first);
    }
    for (const [owner, saved] of this.cache) {
      if (
        !owner.isConnected ||
        (this.entries.has(owner) && this.entries.get(owner)?.text !== saved.text)
      )
        this.cache.delete(owner);
    }
    const visibleLayers = new Set(this.visible.map((e) => e.layer));
    for (const child of Array.from(this.layer.children))
      if (!visibleLayers.has(child as HTMLElement)) child.remove();
    for (const entry of this.visible)
      if (entry.layer.parentElement !== this.layer) this.layer.append(entry.layer);
    for (const entry of this.visible)
      if (entry.translation !== undefined || entry.preview !== undefined) this.paint(entry);
  }

  /** Only actual DOM text/photo overlaps need background verification, never ordinary images. */
  backgroundSources() {
    return this.images
      .filter((image) =>
        this.visible.some((entry) =>
          entry.lines.some((line) => intersectRegions(image.getBoundingClientRect(), line)),
        ),
      )
      .slice(0, 8);
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
    const failed: string[] = [];
    for (const block of result.blocks) {
      const entry = [...this.entries.values()].find((e) => e.id === block.id);
      if (
        !entry ||
        !entry.owner.isConnected ||
        entry.nodes.some((n) => !n.isConnected) ||
        normalize(entry.nodes.map((n) => n.data).join('')) !== entry.plain
      )
        continue;
      if (preview) {
        if (entry.translation !== undefined) continue;
        entry.preview = block.translation;
      } else {
        entry.translation = block.translation;
        delete entry.preview;
      }
      if (!this.paint(entry)) {
        if (preview) delete entry.preview;
        else delete entry.translation;
        failed.push(entry.id);
        continue;
      }
      if (!preview) {
        this.cache.delete(entry.key);
        this.cache.set(entry.key, {
          text: entry.text,
          translation: block.translation,
        });
        if (this.cache.size > 128) {
          const oldest = this.cache.keys().next().value;
          if (oldest) this.cache.delete(oldest);
        }
      }
    }
    return failed;
  }

  clearPreview(ids: ReadonlySet<string>) {
    for (const entry of this.entries.values()) {
      if (entry.preview === undefined || !ids.has(entry.id)) continue;
      delete entry.preview;
      this.paint(entry);
    }
  }

  private paint(entry: TextEntry) {
    const translation = entry.translation ?? entry.preview;
    if (!translation) {
      entry.layer.replaceChildren();
      delete entry.renderKey;
      this.layoutErrors.delete(entry.id);
      this.layoutUnsupported.delete(entry.id);
      return true;
    }
    const style = this.view.getComputedStyle(entry.owner);
    const box = entry.owner.getBoundingClientRect();
    const background = textBackground(
      entry.owner,
      entry.lines,
      this.view,
      this.visual,
      this.images,
      this.imageReady,
    );
    const slot = translationTextSlot(entry, this.view);
    const key = JSON.stringify([
      translation,
      entry.lines.map((r) => ({ ...r, x: r.x - box.x, y: r.y - box.y })),
      box.width,
      entry.tight,
      { ...slot, x: slot.x - box.x, y: slot.y - box.y },
      this.view.devicePixelRatio,
      [
        style.font,
        style.fontSize,
        style.lineHeight,
        style.color,
        style.textDecoration,
        style.textAlign,
        style.whiteSpace,
        style.direction,
        style.letterSpacing,
        style.wordSpacing,
        style.paddingLeft,
        style.paddingRight,
        style.borderLeftWidth,
        style.borderRightWidth,
      ],
      imageBackgrounds(entry.owner),
      background?.map((layer) => [
        layer.image,
        layer.box && {
          ...layer.box,
          x: layer.box.x - box.x,
          y: layer.box.y - box.y,
        },
      ]),
      this.watermarks.map((w) => [w.style, { ...w.box, x: w.box.x - box.x, y: w.box.y - box.y }]),
      entry.markers.map((el) => {
        const s = this.view.getComputedStyle(el);
        return [s.font, s.color, s.textDecoration, el.closest('a')?.getAttribute('href')];
      }),
    ]);
    if (entry.renderKey === key && entry.renderOrigin) {
      // Each source can scroll independently (nested scrollers, sticky/fixed blocks).
      // Reuse the native layout and masks; only their shared origin moves.
      entry.layer.style.transform = `translate(${box.x - entry.renderOrigin.x}px, ${box.y - entry.renderOrigin.y}px)`;
      return !this.layoutErrors.has(entry.id);
    }
    Object.assign(entry.layer.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      transform: 'translate(0px, 0px)',
    });
    entry.renderOrigin = { x: box.x, y: box.y };
    try {
      if (
        background !== null &&
        this.layout.paint(entry.layer, entry, translation, background, slot, this.watermarks)
      )
        this.layoutUnsupported.delete(entry.id);
      else {
        entry.layer.replaceChildren();
        this.layoutUnsupported.add(entry.id);
      }
    } catch {
      entry.layer.replaceChildren();
      this.layoutErrors.add(entry.id);
      entry.renderKey = key;
      return false;
    }
    this.layoutErrors.delete(entry.id);
    entry.renderKey = key;
    return true;
  }
}
