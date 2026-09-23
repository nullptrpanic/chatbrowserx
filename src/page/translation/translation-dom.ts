import {
  MAX_TRANSLATION_BATCH_CHARS,
  MAX_TRANSLATION_TEXT_BLOCKS,
  MAX_TRANSLATION_TEXT_CHARS,
  type TranslationTextResult,
  type TranslationTexts,
} from '../../translation/region-translation';
import { intersectRegions, subtractRegions, type TranslationRect } from './translation-regions';
import {
  escapeTranslationText,
  translationSegments,
  validateTranslationMarkup,
} from '../../translation/translation-markup';
import { translationTypography, type TranslationTextSource } from './translation-text-layout';
import {
  TranslationStructureLayout,
  translationImageUrl,
  type TranslationNativeSurface,
  type TranslationLayoutRejection,
} from './translation-structure-layout';
import { createTranslationGeometry } from './translation-geometry';
import { translationEditable } from './translation-editability';
import {
  classifyTranslationStyleChange,
  hasLiveTranslationAnimation,
  translationMotionRoot,
} from './translation-animation';
import {
  isTranslationDocumentPlaceholder,
  isTranslationDocumentText,
  translationDocumentWatermark,
  type TranslationWatermark,
} from './translation-document';

const ignored =
  'script,style,noscript,template,pre,input,textarea,select,[hidden],[inert],[aria-hidden="true"],[data-chatbrowserx-overlay]';
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const inline = (style: CSSStyleDeclaration) => ['inline', 'contents'].includes(style.display);
const MAX_DISCOVERY_NODES = 10000;
type DiscoveryBoundary =
  'node-budget' | 'text-budget' | 'excluded' | 'dynamic' | 'native' | 'geometry';
const rect = (r: DOMRect): TranslationRect => ({
  x: r.x,
  y: r.y,
  width: r.width,
  height: r.height,
});

type SourceBlock = TranslationTextSource;
interface TextEntry extends SourceBlock {
  id: string;
  ownerText: string;
  translation?: string;
  preview?: string;
  refreshing?: boolean;
}

/** Complete nearby source blocks, not text clipped by the observation window. */
function collect(
  doc: Document,
  view: Window,
  area: TranslationRect,
  revealed = new Map<Text, TranslationRect[]>(),
  deferred = new Set<Element>(),
) {
  const geometry = createTranslationGeometry(view);
  const revealedParents = new Set<Element>();
  for (const node of revealed.keys())
    for (
      let parent = node instanceof Element ? node : node.parentElement;
      parent && !revealedParents.has(parent);
      parent = parent.parentElement
    )
      revealedParents.add(parent);
  const visited = new Set<Node>();
  const boundaries = new Map<DiscoveryBoundary, Set<Node>>();
  const boundary = (reason: DiscoveryBoundary, node: Node) => {
    const nodes = boundaries.get(reason) ?? new Set<Node>();
    nodes.add(node);
    boundaries.set(reason, nodes);
  };
  const visit = (node: Node) => {
    // Exhaustion stops admitting new source nodes; it must not invalidate the
    // complete blocks already inspected earlier in this same bounded pass.
    if (visited.has(node)) return true;
    if (visited.size >= MAX_DISCOVERY_NODES) {
      boundary('node-budget', doc);
      return false;
    }
    visited.add(node);
    return true;
  };
  const owners = new Set<Element>(),
    unsupported: TranslationRect[] = [],
    native: TranslationNativeSurface[] = [],
    pinned: Element[] = [],
    watermarks: TranslationWatermark[] = [];
  const visible = (el: Element) => {
    const facts = geometry.facts(el);
    const disclosure = el.parentElement?.matches('details:not([open])');
    const result =
      !el.matches(ignored) &&
      !isTranslationDocumentPlaceholder(el) &&
      (!disclosure || el === el.parentElement?.querySelector('summary')) &&
      !facts.hidden &&
      facts.clip?.kind !== 'hidden';
    if (!result) boundary('excluded', el);
    return result;
  };
  const hasVisibleText = (root: Element) => {
    const scan = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!visit(node)) return NodeFilter.FILTER_ACCEPT;
        if (node instanceof Element)
          return visible(node) ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_REJECT;
        return !translationEditable(node.parentElement) &&
          /[\p{L}\p{N}]/u.test(node.textContent ?? '')
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    });
    const found = scan.nextNode();
    return found !== null && visit(found);
  };
  if (!doc.body) return { blocks: [], native, unsupported, watermarks, pinned, boundaries };
  // TreeWalker does not visit these ancestors; include them in the same discovery budget.
  for (const root of [doc.documentElement, doc.body]) {
    visit(root);
    if (!visible(root))
      return {
        blocks: [],
        native,
        unsupported,
        watermarks,
        pinned,
        boundaries,
      };
    if (geometry.facts(root).clip?.kind === 'uncertain') {
      boundary('geometry', root);
      return {
        blocks: [],
        native,
        unsupported: [area],
        watermarks,
        pinned,
        boundaries,
      };
    }
  }
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // FILTER_REJECT nodes never reach nextNode(). Count them here, then return once
      // over budget so the outer loop can stop without inspecting the remaining subtree.
      if (!visit(node)) return NodeFilter.FILTER_ACCEPT;
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
      // An offscreen ancestor does not imply offscreen descendants: fixed islands
      // and visible overflow can escape it before any cached identity exists.
      // Prune offscreen leaves, not unknown subtrees; keep the same single bounded
      // walk and range/clip visibility checks below, without a second discovery pass.
      if (
        el.childElementCount === 0 &&
        r.width > 0 &&
        r.height > 0 &&
        !intersectRegions(r, area) &&
        !revealedParents.has(el)
      )
        return NodeFilter.FILTER_REJECT;
      const style = view.getComputedStyle(el);
      const watermark = translationDocumentWatermark(el, view);
      if (watermark) {
        watermarks.push(watermark);
        return NodeFilter.FILTER_REJECT;
      }
      // An ordinary positioned stacking context can host a foreground menu too.
      // Its native paint must survive even when no text inside it needs translation.
      if (
        pinned.length < 64 &&
        (['fixed', 'sticky'].includes(style.position) ||
          (style.position !== 'static' && Number(style.zIndex) > 0))
      )
        pinned.push(el);
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
      const paused = hasLiveTranslationAnimation(el)
        ? translationMotionRoot(el, view)
        : deferred.has(el)
          ? el
          : null;
      if (paused) {
        boundary('dynamic', paused);
        deferred.add(paused);
        // The track may already have been visited before its animated child.
        // Record the complete native boundary now, not on a later observation.
        const box = rect(paused.getBoundingClientRect());
        if (box.width > 0 && box.height > 0) {
          native.push({ ...box, element: paused });
          if (hasVisibleText(paused)) unsupported.push(box);
        }
        return NodeFilter.FILTER_REJECT;
      }
      const painted =
        geometry.facts(el).clip?.kind === 'uncertain' ||
        el.matches('img,canvas,video,iframe,object,embed') ||
        (el.matches('svg') && (r.width > 48 || el.querySelector('text,foreignObject') !== null)) ||
        !/^(?:none|matrix\(1, 0, 0, 1, -?[\d.]+, -?[\d.]+\))?$/.test(style.transform) ||
        (style.filter && style.filter !== 'none') ||
        (style.mixBlendMode && style.mixBlendMode !== 'normal') ||
        el.shadowRoot !== null;
      if (painted) {
        boundary(geometry.facts(el).clip?.kind === 'uncertain' ? 'geometry' : 'native', el);
        if (r.width > 0 && r.height > 0) {
          // Unsupported composited DOM is native paint too, not spare backdrop.
          // Passive images remain copyable without an image-translation path.
          if (
            geometry.facts(el).clip?.kind === 'uncertain' ||
            (!el.matches('img,svg') && !translationImageUrl(el)) ||
            el.shadowRoot
          )
            native.push({ ...r, element: el });
          // Media is intentionally left unchanged in text-only translation. Only DOM text
          // behind unsupported compositing warrants a text-translation warning.
          if (!el.matches('img,canvas,video,iframe,object,embed,svg') && hasVisibleText(el))
            unsupported.push(r);
        }
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node: Node | null;
  while ((node = walker.nextNode()) && visit(node)) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    let owner = node.parentElement;
    while (
      owner?.parentElement &&
      inline(view.getComputedStyle(owner)) &&
      !translationEditable(owner.parentElement) &&
      !owner.parentElement.matches('details:not([open])')
    )
      owner = owner.parentElement;
    if (owner && owner.getBoundingClientRect().width > 0) owners.add(owner);
  }
  const blocks: SourceBlock[] = [];
  for (const owner of owners) {
    let run: Text[] = [];
    const runs: Text[][] = [run];
    const texts = doc.createTreeWalker(owner, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!visit(n)) return NodeFilter.FILTER_ACCEPT;
        if (n.nodeType === Node.TEXT_NODE)
          return translationEditable(n.parentElement)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        const el = n as Element;
        if (isTranslationDocumentPlaceholder(el)) return NodeFilter.FILTER_REJECT;
        if (
          el.tagName !== 'BR' &&
          !deferred.has(el) &&
          visible(el) &&
          inline(view.getComputedStyle(el))
        )
          return NodeFilter.FILTER_SKIP;
        if (run.length) {
          run = [];
          runs.push(run);
        }
        return NodeFilter.FILTER_REJECT;
      },
    });
    while ((node = texts.nextNode()) && visit(node))
      if (node.nodeType === Node.TEXT_NODE) run.push(node as Text);
    // A partially admitted paragraph is not a complete translation target.
    // Other owners fully visited before the limit still remain usable.
    if (node) continue;
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
        const raw = nodes.map((n) => n.data).join('');
        const plain = normalize(raw);
        // Symbol-only icon fonts are decoration, not translatable labels.
        if (!/[\p{L}\p{N}]/u.test(plain)) continue;
        const markers: Element[] = [];
        const segments: { element: Element; text: string }[] = [];
        const preserved = /^(pre|pre-wrap|break-spaces)$/.test(
          view.getComputedStyle(sourceOwner).whiteSpace,
        );
        const edges = {
          before: raw.match(/^\s*/)?.[0] ?? '',
          after: raw.match(/\s*$/)?.[0] ?? '',
        };
        // NBSP and Unicode spacing remain visible even under normal white-space.
        // Keep source-owned edge indentation, but do not turn collapsible HTML
        // formatting newlines into literal lines or ask the model to reproduce it.
        const preserveEdges = preserved || /[^\S \t\r\n\f]/u.test(edges.before + edges.after);
        const literalLines = preserved && raw.includes('\n');
        const slots: { marker: number; before: string; after: string }[] = [];
        const documentStyle = isTranslationDocumentText(sourceOwner)
          ? view.getComputedStyle(sourceOwner)
          : null;
        for (const n of nodes) {
          let element = n.parentElement ?? sourceOwner;
          // Docx splits identical prose into editor runs (including after hydration).
          // Only genuinely neutral span paths may disappear. Equal typography alone
          // does not make a highlighted/padded/code/link shell interchangeable.
          if (documentStyle && !element.closest('a[href]')) {
            let neutral = true;
            for (
              let shell: Element | null = element;
              shell && shell !== sourceOwner;
              shell = shell.parentElement
            ) {
              const style = view.getComputedStyle(shell);
              const currentShell = shell;
              if (
                shell.tagName !== 'SPAN' ||
                !translationTypography.every((p) => style[p] === documentStyle[p]) ||
                !['', 'transparent', 'rgba(0, 0, 0, 0)'].includes(style.backgroundColor) ||
                [style.backgroundImage, style.boxShadow, style.textShadow, style.transform].some(
                  (value) => value && value !== 'none',
                ) ||
                (style.opacity && style.opacity !== '1') ||
                (style.verticalAlign && style.verticalAlign !== 'baseline') ||
                (style.outlineStyle && style.outlineStyle !== 'none') ||
                [
                  'paddingTop',
                  'paddingRight',
                  'paddingBottom',
                  'paddingLeft',
                  'marginTop',
                  'marginRight',
                  'marginBottom',
                  'marginLeft',
                  'borderTopWidth',
                  'borderRightWidth',
                  'borderBottomWidth',
                  'borderLeftWidth',
                ].some((p) => parseFloat(style[p as keyof CSSStyleDeclaration] as string)) ||
                ['::before', '::after'].some(
                  (pseudo) =>
                    !['', 'none', 'normal', '""'].includes(
                      view.getComputedStyle(currentShell, pseudo).content,
                    ),
                )
              ) {
                neutral = false;
                break;
              }
            }
            if (neutral) element = sourceOwner;
          }
          const last = segments[segments.length - 1];
          if (last?.element === element) last.text += n.data;
          else segments.push({ element, text: n.data });
        }
        const marked = literalLines || segments.some((s) => s.element !== sourceOwner);
        let pendingWhitespace = '';
        const text = normalize(
          (literalLines
            ? segments.flatMap((s) => s.text.split(/(?<=\n)/).map((text) => ({ ...s, text })))
            : segments
          )
            .map((s) => {
              if (literalLines && !s.text.trim()) {
                pendingWhitespace += s.text;
                return '';
              }
              const escaped = escapeTranslationText(literalLines ? s.text.trim() : s.text);
              if (!marked) return escaped;
              if (!literalLines && (s.element === sourceOwner || !s.text.trim())) return escaped;
              const id = markers.push(s.element) - 1;
              if (literalLines) {
                slots.push({
                  marker: id,
                  before: pendingWhitespace + (s.text.match(/^\s*/)?.[0] ?? ''),
                  after: s.text.match(/\s*$/)?.[0] ?? '',
                });
                pendingWhitespace = '';
              }
              return `<m${id}>${escaped}</m${id}>`;
            })
            .join(literalLines ? ' ' : ''),
        );
        const lastSlot = slots.at(-1);
        if (lastSlot) lastSlot.after += pendingWhitespace;
        if (text.length > MAX_TRANSLATION_TEXT_CHARS) {
          boundary('text-budget', sourceOwner);
          unsupported.push(rect(sourceOwner.getBoundingClientRect()));
          continue;
        }
        const lines: TranslationRect[] = [];
        for (const n of nodes) {
          const range = doc.createRange();
          range.selectNodeContents(n);
          for (const measured of range.getClientRects()) {
            const clipped = geometry.clip(measured, n);
            if (clipped.kind !== 'visible') continue;
            const r = clipped.rect;
            if (r.width < 1 || r.height < 1) continue;
            const line = lines.find(
              (l) =>
                Math.abs(l.y - r.y) < 2 &&
                Math.abs(l.height - r.height) < 3 &&
                r.x <= l.x + l.width + 2 &&
                r.x + r.width >= l.x - 2,
            );
            if (line) {
              const right = Math.max(line.x + line.width, r.x + r.width);
              line.x = Math.min(line.x, r.x);
              line.width = right - line.x;
              line.height = Math.max(line.height, r.height);
            } else lines.push(r);
          }
        }
        lines.sort((a, b) => a.y - b.y || a.x - b.x);
        const revealedLines = nodes.flatMap((node) => revealed.get(node) ?? []);
        if (lines.some((r) => intersectRegions(r, area)) || revealedLines.length)
          blocks.push({
            key: runs.length > 1 && sourceOwner === owner ? (nodes[0] ?? sourceOwner) : sourceOwner,
            owner: sourceOwner,
            nodes,
            text,
            plain,
            markers,
            whitespace: preserveEdges
              ? literalLines
                ? { before: '', after: '', slots }
                : edges
              : undefined,
            lines: revealedLines.length ? revealedLines : lines,
          });
      }
    }
  }
  if (boundaries.has('node-budget')) unsupported.push(area);
  return { blocks, native, unsupported, watermarks, pinned, boundaries };
}

/** A small source-anchored cache. No screenshot, source DOM replacement, or durable state. */
export class TranslationDom {
  readonly entries = new Map<Node, TextEntry>();
  readonly layoutErrors = new Set<string>();
  readonly layoutUnsupported = new Map<string, TranslationLayoutRejection>();
  private readonly layout: TranslationStructureLayout;
  private readonly deferred = new Set<Element>();
  visible: TextEntry[] = [];
  unsupported: TranslationRect[] = [];
  private native: TranslationNativeSurface[] = [];
  private pinned: Element[] = [];
  private watermarks: TranslationWatermark[] = [];
  area: TranslationRect | null = null;
  sequence = 0;
  private scrolling = false;
  private painted = new Set<string>();
  private boundaries = new Map<DiscoveryBoundary, Set<Node>>();
  needsReconcile = false;

  constructor(
    readonly doc: Document,
    readonly view: Window,
    readonly layer: HTMLElement,
    readonly cache = new Map<Node, { text: string; translation: string }>(),
  ) {
    this.layout = new TranslationStructureLayout(doc, view, layer, this.deferred);
  }

  invalidate(structure: boolean | readonly Node[] = true) {
    this.area = null;
    if (structure) this.layout.invalidate(Array.isArray(structure) ? structure : undefined);
  }

  mutate(records: readonly MutationRecord[]) {
    let deferredChanged = false;
    const replacements = new Map<Node, Element[]>();
    for (const record of records) {
      if (record.type !== 'childList') continue;
      const added = replacements.get(record.target) ?? [];
      for (const node of record.addedNodes) if (node instanceof Element) added.push(node);
      replacements.set(record.target, added);
    }
    // Transfer a replaced branch's manual-refresh boundary to its replacements,
    // never to their shared parent. Removing a popup must not defer the whole app.
    for (const record of records)
      if (
        record.type === 'childList' &&
        record.target instanceof Element &&
        [...this.deferred].some((el) =>
          [...record.removedNodes].some((node) => node === el || node.contains(el)),
        )
      )
        deferredChanged =
          this.deferReplacements(replacements.get(record.target) ?? []) || deferredChanged;
    const changes = this.layout.mutate(records.filter((record) => !this.isDeferred(record.target)));
    if (!changes.length) return deferredChanged;
    for (const record of changes) {
      if (record.type === 'characterData' || record.type === 'childList') {
        for (const entry of [...this.entries.values()]) {
          if (
            entry.owner.contains(record.target) &&
            normalize(entry.owner.textContent ?? '') !== entry.ownerText
          )
            this.defer(entry.owner);
          else if (
            record.type === 'childList' &&
            record.target instanceof Element &&
            [...record.removedNodes].some(
              (node) => node === entry.owner || node.contains(entry.owner),
            )
          )
            this.deferReplacements(replacements.get(record.target) ?? []);
        }
      } else if (
        !this.scrolling &&
        record.attributeName === 'style' &&
        record.target instanceof HTMLElement
      ) {
        const node = record.target;
        const before = this.doc.createElement('div').style;
        before.cssText = record.oldValue ?? '';
        if (
          classifyTranslationStyleChange(before, node.style) === 'motion' &&
          [...this.entries.values()].some((entry) => node.contains(entry.owner))
        )
          this.defer(translationMotionRoot(node, this.view));
      }
    }
    this.area = null;
    return true;
  }

  private isDeferred(node: Node) {
    return [...this.deferred].some((el) => el === node || el.contains(node));
  }

  private deferReplacements(elements: readonly Element[]) {
    let changed = false;
    for (const element of elements) changed = this.defer(element) || changed;
    return changed;
  }

  private defer(element: Element) {
    if (
      element === this.doc.body ||
      element === this.doc.documentElement ||
      this.isDeferred(element)
    )
      return false;
    for (const el of this.deferred)
      if (!el.isConnected || element.contains(el)) this.deferred.delete(el);
    this.deferred.add(element);
    for (const [key, entry] of this.entries)
      if (element.contains(entry.owner)) this.entries.delete(key);
    for (const key of this.cache.keys()) if (element.contains(key)) this.cache.delete(key);
    this.invalidate([element]);
    return true;
  }

  motion(element: Element) {
    const root = translationMotionRoot(element, this.view);
    if (this.isDeferred(root)) {
      // Only remeasure native paint and cached static neighbors. The moving branch
      // stays deferred until explicit refresh, including after its animation ends.
      this.invalidate(false);
      return true;
    }
    return hasLiveTranslationAnimation(element) && this.defer(root);
  }

  scroll() {
    this.scrolling = true;
    this.invalidate(false);
    this.layout.reposition();
  }

  settle() {
    this.scrolling = false;
  }

  refresh(region: TranslationRect, retryIds?: ReadonlySet<string>) {
    if (!retryIds)
      for (const el of this.deferred) {
        // Portals/display:contents can have no box while their descendants are visible.
        const contents = this.doc.createRange();
        contents.selectNodeContents(el);
        if (
          !el.isConnected ||
          intersectRegions(el.getBoundingClientRect(), region) ||
          intersectRegions(contents.getBoundingClientRect(), region)
        )
          this.deferred.delete(el);
      }
    for (const entry of this.entries.values()) {
      if (retryIds && !retryIds.has(entry.id)) continue;
      if (!entry.lines.some((line) => intersectRegions(line, region))) continue;
      entry.id = `text-${++this.sequence}`;
      entry.refreshing = true;
      delete entry.preview;
      this.cache.delete(entry.key);
    }
    this.layoutErrors.clear();
    this.invalidate();
  }

  update(area: TranslationRect, observation: TranslationRect = area) {
    if (this.scrolling) return;
    if (this.area && !subtractRegions(observation, [this.area]).length) {
      if (this.needsReconcile) this.reconcile();
      return;
    }
    this.area = area;
    // Reflow can bring a source-offscreen block into the lens. Preserve that
    // visible translation across source hydration and other observation refreshes.
    for (const el of this.deferred) if (!el.isConnected) this.deferred.delete(el);
    const source = collect(
      this.doc,
      this.view,
      area,
      this.layout.revealed(area, new Set()),
      this.deferred,
    );
    this.unsupported = source.unsupported;
    this.native = source.native;
    this.pinned = source.pinned;
    this.watermarks = source.watermarks;
    this.boundaries = source.boundaries;
    this.visible = this.register(source.blocks.filter((block) => !this.isDeferred(block.owner)));
    for (const [owner, saved] of this.cache) {
      if (
        !owner.isConnected ||
        (this.entries.has(owner) && this.entries.get(owner)?.text !== saved.text)
      )
        this.cache.delete(owner);
    }
    this.reconcile();
  }

  private register(blocks: SourceBlock[]) {
    const result = blocks.map((block) => {
      let entry = this.entries.get(block.key);
      if (entry?.text !== block.text) {
        if (entry) {
          this.layoutErrors.delete(entry.id);
          this.layoutUnsupported.delete(entry.id);
        }
        entry = {
          ...block,
          id: `text-${++this.sequence}`,
          ownerText: normalize(block.owner.textContent ?? ''),
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
    return result;
  }

  private prune() {
    // The traversal/layout budgets bound active work. The LRU allowance is only for
    // offscreen history: evicting a visible ID loses its in-flight completion and can
    // silently leave dense link grids untranslated, or request those blocks repeatedly.
    const visible = new Set(this.visible.map((entry) => entry.key));
    for (const store of [this.entries, this.cache]) {
      const offscreen = [...store.keys()].filter((key) => !visible.has(key));
      for (const key of offscreen.slice(0, Math.max(0, offscreen.length - 128))) {
        if (store === this.entries) {
          const entry = this.entries.get(key);
          if (entry) {
            this.layoutErrors.delete(entry.id);
            this.layoutUnsupported.delete(entry.id);
          }
        }
        store.delete(key);
      }
    }
  }

  missing(pending?: ReadonlySet<string>): TranslationTexts['texts'] {
    let size = 0;
    return this.visible
      .filter((entry) => {
        if (
          (entry.translation !== undefined && !entry.refreshing) ||
          pending?.has(entry.id) ||
          size + entry.text.length > MAX_TRANSLATION_BATCH_CHARS
        )
          return false;
        size += entry.text.length;
        return true;
      })
      .slice(0, MAX_TRANSLATION_TEXT_BLOCKS)
      .map(({ id, text }) => ({ id, text }));
  }

  /** Local, text-free attribution. A model response is not proof of visible translation. */
  report(pending: ReadonlySet<string> = new Set(), failed: ReadonlySet<string> = new Set()) {
    return {
      boundaries: Object.fromEntries(
        [...this.boundaries].map(([reason, nodes]) => [reason, nodes.size]),
      ),
      targets: this.visible.map((entry) => {
        const value = entry.translation ?? entry.preview;
        const state = failed.has(entry.id)
          ? 'model-failed'
          : pending.has(entry.id)
            ? 'pending'
            : this.layoutErrors.has(entry.id)
              ? 'layout-error'
              : this.layoutUnsupported.has(entry.id)
                ? 'layout-rejected'
                : value === undefined
                  ? 'untranslated'
                  : normalize(
                        translationSegments(value)
                          .map((segment) => segment.text)
                          .join(''),
                      ) === entry.plain
                    ? 'unchanged-result'
                    : this.painted.has(entry.id)
                      ? entry.translation === undefined
                        ? 'preview'
                        : 'rendered'
                      : 'awaiting-layout';
        const reason = this.layoutUnsupported.get(entry.id);
        return reason ? { id: entry.id, state, reason } : { id: entry.id, state };
      }),
    };
  }

  accept(result: TranslationTextResult, preview = false) {
    const failed: string[] = [];
    for (const block of result.blocks) {
      const entry = [...this.entries.values()].find((e) => e.id === block.id);
      if (
        !entry ||
        this.isDeferred(entry.owner) ||
        !entry.owner.isConnected ||
        entry.nodes.some((n) => !n.isConnected) ||
        normalize(entry.nodes.map((n) => n.data).join('')) !== entry.plain
      )
        continue;
      try {
        validateTranslationMarkup(entry.text, block.translation);
      } catch {
        failed.push(entry.id);
        continue;
      }
      if (preview) {
        if (entry.translation !== undefined) continue;
        entry.preview = block.translation;
      } else {
        entry.translation = block.translation;
        delete entry.refreshing;
        delete entry.preview;
      }
      if (!preview) {
        this.cache.delete(entry.key);
        this.cache.set(entry.key, {
          text: entry.text,
          translation: block.translation,
        });
      }
    }
    this.reconcile();
    for (const block of result.blocks)
      if (this.layoutErrors.has(block.id) && !failed.includes(block.id)) failed.push(block.id);
    return failed;
  }

  clearPreview(ids: ReadonlySet<string>) {
    let changed = false;
    for (const entry of this.entries.values()) {
      if (entry.preview === undefined || !ids.has(entry.id)) continue;
      delete entry.preview;
      changed = true;
    }
    if (changed) this.reconcile();
  }

  private paint() {
    // Provider results may arrive during a gesture. Cache them immediately, but do not
    // reflow underneath the moving pointer; the settled observation paints them once.
    if (this.scrolling) {
      this.prune();
      return;
    }
    const { errors, rejections, painted } = this.layout.render(
      this.visible,
      this.watermarks,
      this.native,
      this.pinned,
    );
    this.layoutErrors.clear();
    this.layoutUnsupported.clear();
    this.painted = painted;
    for (const id of errors) this.layoutErrors.add(id);
    for (const [id, reason] of rejections) this.layoutUnsupported.set(id, reason);
  }

  private reconcile() {
    this.needsReconcile = false;
    this.paint();
    // Short translations can expose source blocks that were below the original viewport.
    // Discover only text actually revealed in the bounded mirror, through the same source
    // privacy/visibility checks. The existing scheduler requests these IDs on its next pass.
    if (this.area && !this.scrolling) {
      const known = new Set(this.visible.flatMap((entry) => entry.nodes));
      const revealed = this.layout.revealed(this.area, known);
      if (revealed.size) {
        const keys = new Set(this.visible.map((entry) => entry.key));
        const source = collect(this.doc, this.view, this.area, revealed, this.deferred);
        for (const [reason, nodes] of source.boundaries) {
          const saved = this.boundaries.get(reason) ?? new Set<Node>();
          for (const node of nodes) saved.add(node);
          this.boundaries.set(reason, saved);
        }
        const extra = source.blocks.filter(
          (block) => !keys.has(block.key) && block.nodes.some((node) => revealed.has(node)),
        );
        const remaining = Math.max(0, MAX_DISCOVERY_NODES - this.visible.length);
        if (extra.length > remaining || source.boundaries.has('node-budget')) {
          this.boundaries.set('node-budget', new Set([this.doc]));
          this.unsupported.push(this.area);
        }
        const added = this.register(extra.slice(0, remaining));
        this.visible.push(...added);
        // Cached newly exposed entries need a paint, not another provider request.
        // Yield through the existing scheduler; each pass must add new identities,
        // and both per-pass scanning and the observation's target set are bounded.
        this.needsReconcile = added.some((entry) => entry.translation !== undefined);
      }
    }
    this.prune();
  }
}
