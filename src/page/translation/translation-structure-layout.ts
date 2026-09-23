import {
  translationSegments,
  validateTranslationMarkup,
} from '../../translation/translation-markup';
import { translationEditable } from './translation-editability';
import { hasLiveTranslationAnimation, isTranslationTextTrack } from './translation-animation';
import {
  createTranslationGeometry,
  visibleTranslationRect,
  type TranslationGeometry,
} from './translation-geometry';
import {
  readTranslationTextConstraints,
  applyTranslationTextConstraints,
} from './translation-text-constraints';
import type { TranslationWatermark } from './translation-document';
import type { TranslationRect } from './translation-regions';
import { intersectRegions, subtractRegions } from './translation-regions';
import { translationTypography, type TranslationTextSource } from './translation-text-layout';

export interface TranslationLayoutEntry extends TranslationTextSource {
  id: string;
  translation?: string;
  preview?: string;
}

export interface TranslationNativeSurface extends TranslationRect {
  element?: Element;
}

const MAX_LAYOUT_NODES = 6000;
// A complete table may use the available layout budget. A smaller per-island cap
// used to split ordinary tables into independently sized rows/cells.
const MAX_GROUP_NODES = MAX_LAYOUT_NODES;
const excluded = 'script,style,link,meta,noscript,template,[data-chatbrowserx-overlay]';
const controls = 'input,textarea,select,[role="textbox"]';
const visualProperties =
  `display box-sizing float clear vertical-align color font-family font-size font-weight font-style font-variant font-stretch line-height letter-spacing word-spacing text-align text-indent text-transform text-decoration text-shadow white-space overflow-wrap word-break hyphens direction writing-mode tab-size visibility opacity zoom background-color background-image background-size background-position background-repeat background-origin background-clip background-attachment background-blend-mode border-top border-right border-bottom border-left border-radius border-collapse border-spacing table-layout box-shadow outline list-style-type list-style-position list-style-image object-fit object-position fill fill-opacity fill-rule stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-opacity paint-order clip-rule overflow-x overflow-y text-overflow -webkit-line-clamp -webkit-box-orient align-items align-content align-self justify-content justify-items justify-self flex-direction flex-wrap flex-grow flex-shrink order grid-template-areas grid-auto-flow grid-auto-columns grid-auto-rows grid-column grid-row position z-index transform transform-origin filter isolation mix-blend-mode contain content-visibility aspect-ratio`.split(
    ' ',
  );
// Unlike getComputedStyle's used pixel dimensions, Typed OM preserves auto/%/unitless values.
const layoutProperties =
  `width height min-width min-height max-width max-height margin-top margin-right margin-bottom margin-left padding-top padding-right padding-bottom padding-left top right bottom left flex-basis row-gap column-gap grid-template-columns grid-template-rows line-height`.split(
    ' ',
  );
const maskProperties =
  'mask-image mask-mode mask-position mask-size mask-repeat mask-origin mask-clip mask-composite'.split(
    ' ',
  );
const svgTags = new Set(
  'svg g path circle ellipse rect line polyline polygon defs linearGradient radialGradient stop clipPath mask text tspan use'.split(
    ' ',
  ),
);
const svgAttributes = new Set(
  'viewBox width height x y x1 y1 x2 y2 cx cy r rx ry d points transform fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-opacity opacity offset stop-color stop-opacity gradientUnits gradientTransform clipPathUnits preserveAspectRatio id'.split(
    ' ',
  ),
);
const transparent = (color: string) =>
  !color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)';

/** Image objects are passive illustrations, not interactive embedded documents. */
export function translationImageUrl(source: Element): string | null {
  const url =
    source instanceof HTMLImageElement
      ? source.currentSrc || source.src
      : source instanceof HTMLObjectElement &&
          /^image\/(svg\+xml|png|jpeg|gif|webp|avif|bmp)$/i.test(source.type)
        ? source.data
        : null;
  return url && /^(https?:|data:image\/|blob:)/i.test(url) ? url : null;
}

const liveSurface = (source: Element) =>
  source.matches(`${controls},canvas,video,iframe,object,embed`) && !translationImageUrl(source);
const textOf = (entry: TranslationLayoutEntry) => entry.translation ?? entry.preview;
const changed = (entry: TranslationLayoutEntry) => {
  const text = textOf(entry);
  return (
    text !== undefined &&
    translationSegments(text)
      .map((segment) => segment.text)
      .join('') !== entry.plain
  );
};

interface LayoutSource {
  root: Element;
  /** A consecutive, safe slice of a larger normal-flow parent. */
  flow?: { parent: Element; children: Element[] };
}

interface Group extends LayoutSource {
  layer: HTMLElement;
  mirror: Element;
  copies: Map<Node, Node>;
  scrolls: [Element, Element][];
  sticky: [Element, HTMLElement, Element][];
  applied: Map<string, { value: string; element: HTMLElement }>;
  /** Valid model values whose tiny labels remain in the original safe copy. */
  original: Map<string, string>;
  overflow: HTMLElement;
  watermarks: HTMLElement;
  dirty: boolean;
  width: number;
  backdrops: Element[];
  occluders: Element[];
  peerCutouts: { anchor: Element; offset: TranslationRect }[];
  opaqueCover?: { source: Element; inset: number }[] | undefined;
  placement?: {
    origin: DOMRect;
    width: number;
    height: number;
    clip: TranslationRect | undefined;
    painted: { region: TranslationRect; source: TranslationRect }[];
  };
}

export type TranslationLayoutRejection =
  | 'geometry-uncertain'
  | 'native-overlap'
  | 'peer-overlap'
  | 'layout-budget'
  | 'unsafe-copy'
  | 'label-overflow';

/** Bounded, inert layout islands. Source nodes are read, never patched or hidden. */
export class TranslationStructureLayout {
  private readonly groups = new Map<Element, Group>();
  private rejections = new Map<string, TranslationLayoutRejection>();
  private positionRejection: TranslationLayoutRejection = 'layout-budget';
  private errors = new Set<string>();
  private geometry: TranslationGeometry;

  constructor(
    private readonly doc: Document,
    private readonly view: Window,
    private readonly layer: HTMLElement,
    private readonly deferred: ReadonlySet<Element> = new Set(),
  ) {
    this.geometry = createTranslationGeometry(view);
  }

  invalidate(targets?: readonly Node[]) {
    for (const group of this.groups.values())
      if (
        !targets ||
        targets.some((node) => {
          const root = group.flow?.parent ?? group.root;
          return (
            node.contains(root) ||
            (group.flow?.children ?? [root]).some((child) => child.contains(node))
          );
        })
      )
        group.dirty = true;
  }

  /** Hidden widgets and positional animation must not recreate otherwise unchanged prose. */
  mutate(records: readonly MutationRecord[]) {
    this.geometry = createTranslationGeometry(this.view);
    const changes: MutationRecord[] = [];
    for (const record of records) {
      const node = record.target;
      let hidden = false;
      for (let el = node instanceof Element ? node : node.parentElement; el; el = el.parentElement)
        if (this.hidden(el)) {
          hidden = true;
          break;
        }
      // A previously copied branch still needs one update when it becomes hidden.
      if (hidden && ![...this.groups.values()].some((group) => group.copies.has(node))) continue;
      changes.push(record);
    }
    if (changes.length) this.invalidate(changes.map((r) => r.target));
    this.reposition();
    return changes;
  }

  /** Scroll only moves existing islands; it never walks, copies or measures their text. */
  reposition() {
    this.geometry = createTranslationGeometry(this.view);
    for (const group of this.groups.values()) {
      if (!group.root.isConnected) {
        group.layer.remove();
        this.groups.delete(group.root);
      } else this.position(group, [], true);
    }
  }

  /** Text exposed by reflow, including already translated copies on a later observation. */
  revealed(area: TranslationRect, known: ReadonlySet<Text>) {
    const geometry = createTranslationGeometry(this.view);
    const result = new Map<Text, TranslationRect[]>();
    for (const group of this.groups.values())
      for (const [source, copy] of group.copies) {
        if (
          !(source instanceof Text) ||
          known.has(source) ||
          !copy.isConnected ||
          !/\S/.test(source.data)
        )
          continue;
        const range = this.doc.createRange();
        range.selectNodeContents(copy);
        const lines = [...range.getClientRects()].flatMap((r) => {
          // The caller supplies the observation window. Our own rounded lens is UI,
          // not an unknown source clip; only the copied island participates here.
          const supported = visibleTranslationRect(
            geometry.clip(r, copy, { boundary: this.layer }),
          );
          const visible = supported && intersectRegions(supported, area);
          return visible ? [visible] : [];
        });
        if (lines.length) result.set(source, lines);
      }
    return result;
  }

  render(
    entries: readonly TranslationLayoutEntry[],
    watermarks: readonly TranslationWatermark[],
    nativeSources: readonly TranslationNativeSurface[] = [],
    pinned: readonly Element[] = [],
  ) {
    this.geometry = createTranslationGeometry(this.view);
    this.rejections = new Map();
    this.errors = new Set();
    // Model responses arrive after collection. A native toolbar may have finished
    // entering or moved in that interval. Compare against its current bounds, just
    // as the foreground cutout does, rather than rejecting prose at its old location.
    const native = nativeSources.flatMap((surface) => {
      const el = surface.element;
      if (!el) return [surface];
      if (!el.isConnected) return [];
      const clipped = this.geometry.clip(this.geometry.facts(el).box, el, {
        includeSelf: true,
      });
      return clipped.kind === 'hidden' ? [] : [{ ...clipped.rect, element: el }];
    });
    const fixedContexts = new Map<Element, Element | null>();
    const fixedContext = (el: Element | null): Element | null => {
      if (!el) return null;
      if (fixedContexts.has(el)) return fixedContexts.get(el) ?? null;
      const context =
        this.view.getComputedStyle(el).position === 'fixed' ? el : fixedContext(el.parentElement);
      fixedContexts.set(el, context);
      return context;
    };
    // Fixed descendants are independent paint islands, not part of their ancestor's
    // normal flow. A pinned header must not split the tables/paragraphs underneath it.
    const owns = (root: Element, node: Node) =>
      root.contains(node) &&
      fixedContext(root) === fixedContext(node instanceof Element ? node : node.parentElement);
    const levels = new Map<Element, number[]>();
    const stacking = (root: Element) => {
      const cached = levels.get(root);
      if (cached) return cached;
      const result: number[] = [];
      for (let el: Element | null = root; el; el = el.parentElement) {
        const s = this.view.getComputedStyle(el);
        if (s.position !== 'static' && s.zIndex !== 'auto' && s.zIndex)
          result.unshift(Number(s.zIndex) || 0);
      }
      levels.set(root, result);
      return result;
    };
    const paintOrder = (a: Element, b: Element) => {
      const x = stacking(a),
        y = stacking(b);
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const delta = (x[i] ?? 0) - (y[i] ?? 0);
        if (delta) return delta;
      }
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    };
    // Native overlays and deferred descendants of pinned owners are foregrounds,
    // not rectangular obstacles across their transparent, empty container space.
    // Keep the existing source paint order and cutouts; adjacent media that only
    // a longer translation reaches still triggers the ordinary collision guard.
    const foregroundNative = native.flatMap(({ element }) =>
      element &&
      (this.geometry.facts(element).position === 'absolute' ||
        pinned.some((owner) => owner.contains(element)))
        ? [element]
        : [],
    );
    const foreground = this.foregroundPaint([...pinned, ...foregroundNative]);
    const foregroundPaint = foreground.surfaces;
    // Collision validation and foreground cutouts must protect the same actual
    // paint. A transparent sticky/fixed shell is not an opaque obstacle across
    // the empty space beside its children. Incomplete/uncertain scans stay native.
    const nativeObstacles = native.flatMap((surface) => {
      const root = surface.element;
      if (!root || !foreground.complete.has(root)) return [surface];
      const surfaces = foregroundPaint.filter((el) => el === root || root.contains(el));
      const boxes = surfaces.map((el) => ({
        element: el,
        clipped: this.geometry.clip(el.getBoundingClientRect(), el, {
          includeSelf: true,
        }),
      }));
      if (boxes.some(({ clipped }) => clipped.kind === 'uncertain')) return [surface];
      return boxes.flatMap(({ element, clipped }) =>
        clipped.kind === 'visible' ? [{ ...clipped.rect, element }] : [],
      );
    });
    const observedPinned = new Set(pinned);
    const sizes = new Map<Element, { count: number; reason?: TranslationLayoutRejection }>();
    const size = (el: Element): number => {
      const cached = sizes.get(el);
      if (cached !== undefined) return cached.count;
      // A flow may grow around static visuals, but it must not cover a live control or
      // media surface with an inert/empty copy. Stop grouping before that boundary.
      if (
        liveSurface(el) ||
        this.deferred.has(el) ||
        el.shadowRoot ||
        hasLiveTranslationAnimation(el) ||
        this.geometry.facts(el).clip?.kind === 'uncertain'
      ) {
        sizes.set(el, {
          count: MAX_GROUP_NODES + 1,
          reason:
            this.geometry.facts(el).clip?.kind === 'uncertain'
              ? 'geometry-uncertain'
              : 'unsafe-copy',
        });
        return MAX_GROUP_NODES + 1;
      }
      let reason: TranslationLayoutRejection | undefined;
      let count = 1;
      for (const child of el.childNodes) {
        if (child instanceof Element) {
          if (child.matches(excluded) || this.hidden(child, true)) continue;
          if (this.view.getComputedStyle(child).position === 'fixed') {
            if (observedPinned.has(child)) continue;
            // Unobserved/excluded fixed controls have no guaranteed occlusion surface.
            // Keep the existing boundary instead of covering them with a parent copy.
            count = MAX_GROUP_NODES + 1;
            reason = 'unsafe-copy';
            break;
          }
          // A clipped, independently positioned track owns its own paint budget.
          // Keep that island boundary even between carousel animations; otherwise one
          // moving label repeatedly splits/rejoins the surrounding static navigation.
          if (isTranslationTextTrack(child, this.view)) {
            count = MAX_GROUP_NODES + 1;
            reason = 'unsafe-copy';
            break;
          }
          count += size(child);
          reason ??= sizes.get(child)?.reason;
        } else {
          // Zero-width caret sentinels are not draft content. They are never copied,
          // but must not split read-only islands out of a shared table/document flow.
          if (/[^\s\u200b\ufeff]/.test(child.textContent ?? '') && translationEditable(el)) {
            count = MAX_GROUP_NODES + 1;
            reason = 'unsafe-copy';
            break;
          }
          count++;
        }
        if (count > MAX_GROUP_NODES) break;
      }
      sizes.set(el, { count, ...(reason ? { reason } : {}) });
      return count;
    };
    const roots = new Set<Element>();
    for (const entry of entries) {
      let root = entry.owner;
      // Loose body text (for example a date between article blocks) must not swallow
      // all independently safe islands, including off-screen controls and live media.
      if (root === this.doc.body || root === this.doc.documentElement) {
        if (changed(entry)) this.rejections.set(entry.id, 'unsafe-copy');
        continue;
      }
      // Keep adjacent sections in the same bounded, safe flow. A flex/section boundary
      // alone does not make it independent: a growing heading still moves the next section.
      for (
        let current = root, parent = current.parentElement;
        parent && parent !== this.doc.body && parent !== this.doc.documentElement;
        current = parent, parent = current.parentElement
      ) {
        if (size(parent) > MAX_GROUP_NODES || this.hidden(parent)) break;
        const currentStyle = this.view.getComputedStyle(current);
        // Sticky boxes still participate in normal flow. Keep a table's sticky heading
        // with its rows and preceding prose; only fixed boxes are independent islands.
        if (currentStyle.position === 'fixed') break;
        // Do not take over an external scrollport; scroll position is read from the source.
        if (/^(auto|scroll)$/.test(this.view.getComputedStyle(parent).overflowY)) break;
        // display:contents participates in its ancestor's flow but has no paint box.
        // If promotion stops there, keep the last actual box as the island root.
        const parentBox = parent.getBoundingClientRect();
        if (parentBox.width > 0 && parentBox.height > 0) root = parent;
      }
      if (size(root) > MAX_GROUP_NODES) {
        if (changed(entry))
          this.rejections.set(entry.id, sizes.get(root)?.reason ?? 'layout-budget');
        continue;
      }
      if (![...roots].some((other) => owns(other, root))) {
        for (const other of roots) if (owns(root, other)) roots.delete(other);
        roots.add(root);
      }
    }
    const candidates = this.flows(roots, size);
    const sourceBoxes = new Map(candidates.map((source) => [source, this.sourceBox(source)]));
    const retained = new Set<Element>();
    const backingCuts: {
      group: Group;
      peers: Element[];
      painted: { region: TranslationRect; source: TranslationRect }[];
      ids: string[];
    }[] = [];
    let budget = MAX_LAYOUT_NODES;
    for (const source of candidates) {
      const { root, flow } = source;
      const contains = (node: Node) =>
        (flow?.children ?? [root]).some((child) => owns(child, node));
      const members = entries.filter((entry) => contains(entry.owner));
      const translated = members.filter((entry) => textOf(entry) !== undefined);
      if (!members.some(changed)) continue;
      const cost = flow
        ? 1 + flow.children.reduce((sum, child) => sum + size(child), 0)
        : size(root);
      if (cost > budget) {
        this.groups.get(root)?.layer.remove();
        this.groups.delete(root);
        translated.forEach((entry) => this.rejections.set(entry.id, 'layout-budget'));
        continue;
      }
      let group = this.groups.get(root);
      const box = this.sourceBox(source);
      const peers = [...sourceBoxes].filter(
        ([peer]) =>
          peer.root !== root &&
          !contains(peer.root) &&
          !(peer.flow?.children ?? [peer.root]).some((child) => owns(child, root)),
      );
      try {
        if (
          group &&
          (group.flow?.parent !== flow?.parent ||
            group.flow?.children.length !== flow?.children.length ||
            group.flow?.children.some((child, i) => child !== flow?.children[i]) ||
            [...group.applied.keys(), ...group.original.keys()].some(
              (id) => !translated.some((entry) => entry.id === id),
            ) ||
            (group.original.size > 0 &&
              translated.some((entry) => {
                const value = group?.original.get(entry.id) ?? group?.applied.get(entry.id)?.value;
                return (value !== undefined || changed(entry)) && value !== textOf(entry);
              })))
        )
          group.dirty = true;
        if (!group || group.dirty || Math.abs(group.width - box.width) > 0.01) {
          const next = this.create(source);
          if (!next) {
            group?.layer.remove();
            this.groups.delete(root);
            translated.forEach((entry) => this.rejections.set(entry.id, 'unsafe-copy'));
            continue;
          }
          for (const entry of translated) this.apply(next, entry);
          // Build fully off-DOM, then swap synchronously. No empty frame while awaiting a model.
          if (group) group.layer.replaceWith(next.layer);
          else this.layer.append(next.layer);
          this.groups.set(root, next);
          group = next;
        } else
          for (const entry of translated)
            if (!group.original.has(entry.id)) this.apply(group, entry);
        const constraints = readTranslationTextConstraints(
          flow?.parent ?? root,
          flow?.children,
          [...nativeObstacles, ...peers.map(([, box]) => box)],
          this.geometry,
          box,
          group.copies,
        );
        let incomplete = applyTranslationTextConstraints(
          constraints,
          group.copies,
          [...group.applied.values()].map(({ element }) => element),
        );
        while (incomplete.size) {
          const originals = new Set(group.original.keys());
          for (const entry of translated) {
            const applied = group.applied.get(entry.id);
            if (applied && incomplete.has(applied.element)) originals.add(entry.id);
          }
          // Reserving an original cell can expose an adjacent tiny label that no
          // longer fits. Resolve before painting; each pass removes at least one
          // translated entry, so the transaction is bounded by this group's entries.
          if (originals.size === group.original.size)
            throw new Error('Unable to resolve original label layout');
          // Restore source layout, not only source text inside already-shrunken
          // translated boxes. Reuse the same safe copier/binder in one synchronous
          // replacement; cached original decisions avoid recreating settled groups.
          const next = this.create(source);
          if (!next) throw new Error('Unable to restore original label layout');
          for (const entry of translated) {
            const value = textOf(entry);
            if (originals.has(entry.id) && value !== undefined) next.original.set(entry.id, value);
            else this.apply(next, entry);
          }
          group.layer.replaceWith(next.layer);
          this.groups.set(root, next);
          group = next;
          incomplete = applyTranslationTextConstraints(
            constraints,
            group.copies,
            [...group.applied.values()].map(({ element }) => element),
          );
        }
        for (const id of group.original.keys()) this.rejections.set(id, 'label-overflow');
        // Native sticky/fixed controls need not be mirrored to retain their source
        // stacking order. Cache their identity; scroll only remeasures these boxes.
        const anchor = flow?.parent ?? root;
        group.occluders = foregroundPaint.filter(
          (el) =>
            !contains(el) &&
            !el.contains(anchor) &&
            paintOrder(anchor, el) < 0 &&
            (!foregroundNative.some(
              (surface) =>
                this.geometry.facts(surface).position === 'absolute' &&
                (surface === el || surface.contains(el)),
            ) ||
              intersectRegions(el.getBoundingClientRect(), box)),
        );
        group.peerCutouts = [];
        group.opaqueCover = undefined;
        const peerCollisions = (painted: ReturnType<TranslationStructureLayout['position']>) =>
          peers.filter(([, peerBox]) =>
            painted?.some(
              ({ region, source }) =>
                !intersectRegions(source, peerBox) && intersectRegions(region, peerBox),
            ),
          );
        // Safe static decorations already represented in this readonly copy are
        // part of its flow, not external obstacles. Live media, unsupported shapes
        // and independent fixed surfaces cannot enter create()'s safe copy map.
        const copies = group.copies;
        const protectedNative = nativeObstacles.filter(
          (surface) => !surface.element || !copies.has(surface.element),
        );
        const behind = new Set(
          protectedNative.filter((surface) => {
            const overlap = intersectRegions(surface, box);
            if (!surface.element || !overlap) return false;
            // Use browser paint order rather than reconstructing stacking contexts
            // created by transforms, isolation or opacity from z-index alone.
            const stack = this.doc.elementsFromPoint(
              overlap.x + overlap.width / 2,
              overlap.y + overlap.height / 2,
            );
            const original = stack.findIndex((el) => contains(el));
            return original >= 0 && stack.indexOf(surface.element) > original;
          }),
        );
        const collides = (painted: ReturnType<TranslationStructureLayout['position']>) =>
          !painted ||
          painted.some(({ region }) =>
            protectedNative.some(
              (surface) =>
                intersectRegions(surface, region) && !(group?.opaqueCover && behind.has(surface)),
            ),
          ) ||
          peerCollisions(painted).length > 0;
        let painted = this.position(group, watermarks);
        if (
          painted?.some(({ region }) =>
            [...behind].some((surface) => intersectRegions(surface, region)),
          )
        ) {
          // Native media below an already opaque foreground is not a new collision.
          // Preserve only original, opaque coverage containing all source/translated ink;
          // never turn transparent padding or expanded text into a cover over live media.
          group.opaqueCover = this.sourceOpaqueCover(group, behind);
          if (group.opaqueCover) painted = this.position(group, watermarks);
        }
        const emptyPeers = this.emptyOverlapPeers(group, peerCollisions(painted));
        const emptyNative = this.emptyOverlapPeers(
          group,
          protectedNative.flatMap((surface): [LayoutSource, DOMRect][] =>
            surface.element && painted?.some(({ region }) => intersectRegions(surface, region))
              ? [
                  [
                    { root: surface.element },
                    new DOMRect(surface.x, surface.y, surface.width, surface.height),
                  ],
                ]
              : [],
          ),
        );
        if (emptyPeers.length || emptyNative.length) {
          // An opaque rectangular backing is not foreground content. Keep translated
          // text when only empty expansion overlaps a sibling or native surface.
          // The shared ink scan still rejects real text/graphic collisions.
          group.occluders.push(...emptyPeers, ...emptyNative);
          painted = this.position(group, watermarks);
        }
        if (collides(painted)) {
          group.layer.remove();
          this.groups.delete(root);
          const children = flow ? [] : this.split(root, members);
          if (children.length) {
            for (const child of children) {
              const next = { root: child };
              sourceBoxes.set(next, this.sourceBox(next));
              candidates.push(next);
            }
          } else {
            const reason: TranslationLayoutRejection = !painted
              ? this.positionRejection
              : painted.some(({ region }) =>
                    protectedNative.some(
                      (surface) =>
                        intersectRegions(surface, region) &&
                        !(group?.opaqueCover && behind.has(surface)),
                    ),
                  )
                ? 'native-overlap'
                : 'peer-overlap';
            translated.forEach((entry) => this.rejections.set(entry.id, reason));
          }
        } else {
          budget -= cost;
          retained.add(root);
          for (const entry of translated)
            if (group.applied.has(entry.id)) this.rejections.delete(entry.id);
          if (emptyPeers.length && painted)
            backingCuts.push({
              group,
              peers: emptyPeers,
              painted,
              ids: translated.map((e) => e.id),
            });
        }
      } catch {
        group?.layer.remove();
        this.groups.delete(root);
        translated.forEach((entry) => this.errors.add(entry.id));
      }
    }
    // A later peer can itself grow during this render. Source-only cutouts must not
    // let its translated footprint overlap the retained island outside the original hole.
    for (const { group, peers, painted, ids } of backingCuts) {
      let unsafe = peers.some((peer) => {
        const placement = retained.has(peer) && this.groups.get(peer)?.placement;
        if (!placement) return false;
        const regions = placement.painted.map((part) => part.region);
        const left = Math.min(...regions.map((r) => r.x));
        const top = Math.min(...regions.map((r) => r.y));
        const box = new DOMRect(
          left,
          top,
          Math.max(...regions.map((r) => r.x + r.width)) - left,
          Math.max(...regions.map((r) => r.y + r.height)) - top,
        );
        if (!painted.some((part) => intersectRegions(part.region, box))) return false;
        if (!this.emptyOverlapPeers(group, [[{ root: peer }, box]]).length) return true;
        const source = peer.getBoundingClientRect();
        group.peerCutouts.push({
          anchor: peer,
          offset: {
            x: box.x - source.x,
            y: box.y - source.y,
            width: box.width,
            height: box.height,
          },
        });
        return false;
      });
      if (!unsafe && group.peerCutouts.length) unsafe = !this.position(group, watermarks);
      if (unsafe) {
        group.layer.remove();
        this.groups.delete(group.root);
        retained.delete(group.root);
        ids.forEach((id) => this.rejections.set(id, 'peer-overlap'));
      }
    }
    for (const [root, group] of this.groups) {
      if (
        !retained.has(root) ||
        !entries.some(
          (entry) =>
            (group.flow?.children ?? [root]).some((child) => owns(child, entry.owner)) &&
            changed(entry),
        )
      ) {
        group.layer.remove();
        this.groups.delete(root);
      }
    }
    // Streaming batches may finish out of order. Paint/read order follows the source tree,
    // including on a cache-only reopen, without remounting already ordered islands.
    const ordered = [...this.groups.values()].sort((a, b) =>
      a.root.compareDocumentPosition(b.root) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
    [...ordered]
      .sort((a, b) => paintOrder(a.flow?.parent ?? a.root, b.flow?.parent ?? b.root))
      .forEach((group, index) => {
        group.layer.style.zIndex = String(index);
      });
    ordered.forEach((group, index) => {
      if (this.layer.children[index] !== group.layer)
        this.layer.insertBefore(group.layer, this.layer.children[index] ?? null);
    });
    const attribution = JSON.stringify([...this.rejections]);
    if (this.layer.dataset.translationRejections !== attribution)
      this.layer.dataset.translationRejections = attribution;
    return {
      rejections: this.rejections,
      errors: this.errors,
      painted: new Set(ordered.flatMap((group) => [...group.applied.keys()])),
    };
  }

  private sourceBox({ root, flow }: LayoutSource) {
    const r = (flow?.parent ?? root).getBoundingClientRect();
    if (!flow) return r;
    const first = (flow.children[0] ?? root).getBoundingClientRect();
    const last = (flow.children.at(-1) ?? root).getBoundingClientRect();
    return new DOMRect(r.x, first.top, r.width, last.bottom - first.top);
  }

  private flows(roots: ReadonlySet<Element>, size: (el: Element) => number): LayoutSource[] {
    const result = new Map<Element, LayoutSource>([...roots].map((root) => [root, { root }]));
    let inspected = 0;
    for (const parent of new Set([...roots].map((root) => root.parentElement))) {
      if (!parent || parent === this.doc.body || parent === this.doc.documentElement) continue;
      const s = this.view.getComputedStyle(parent);
      // Only normal block flow can be sliced without changing sibling layout constraints.
      // Flex/grid/table internals remain indivisible; live surfaces split, not poison, a flow.
      if (
        !/^(block|flow-root)$/.test(s.display) ||
        !/^(static|relative)$/.test(s.position) ||
        s.overflowY !== 'visible' ||
        s.transform !== 'none' ||
        parent.matches(`${controls},${excluded}`) ||
        parent.shadowRoot ||
        hasLiveTranslationAnimation(parent) ||
        this.geometry.facts(parent).clip !== undefined ||
        [...parent.childNodes].some(
          (node) => node.nodeType === Node.TEXT_NODE && /\S/.test(node.textContent ?? ''),
        )
      )
        continue;
      let children: Element[] = [],
        cost = 1;
      const flush = () => {
        const first = children[0];
        if (first && children.length > 1 && children.some((child) => roots.has(child))) {
          for (const child of children) result.delete(child);
          result.set(first, { root: first, flow: { parent, children } });
        }
        children = [];
        cost = 1;
      };
      for (const child of parent.children) {
        if (++inspected > MAX_LAYOUT_NODES) break;
        if (child.matches(excluded) || this.hidden(child)) continue;
        const style = this.view.getComputedStyle(child),
          box = child.getBoundingClientRect(),
          count = size(child);
        if (
          !/^(block|flow-root|table|list-item)$/.test(style.display) ||
          !/^(static|relative)$/.test(style.position) ||
          style.float !== 'none' ||
          style.transform !== 'none' ||
          !box.width ||
          !box.height ||
          count >= MAX_GROUP_NODES ||
          [...roots].some((other) => other !== child && child.contains(other))
        ) {
          flush();
          continue;
        }
        const previous = children.at(-1);
        if (
          cost + count > MAX_GROUP_NODES ||
          (previous && box.top < previous.getBoundingClientRect().bottom - 0.5)
        )
          flush();
        children.push(child);
        cost += count;
      }
      flush();
    }
    return [...result.values()];
  }

  private motionRoot(source: Element) {
    for (let el: Element | null = source; el; el = el.parentElement) {
      const s = this.view.getComputedStyle(el);
      if (
        /^(fixed|sticky)$/.test(s.position) ||
        (/^(auto|scroll|hidden)$/.test(s.overflowY) && el.scrollHeight > el.clientHeight) ||
        (/^(auto|scroll|hidden)$/.test(s.overflowX) && el.scrollWidth > el.clientWidth)
      )
        return el;
    }
    return this.doc.documentElement;
  }

  private emptyOverlapPeers(group: Group, collisions: [LayoutSource, DOMRect][]) {
    if (!collisions.length) return [];
    const origin = this.sourceBox(group);
    const motion = this.motionRoot(group.flow?.parent ?? group.root);
    const peers = new Map(
      collisions.flatMap(([peer, box]) =>
        // Never reveal original text inside this island or cut through a differently
        // scrolling/sticky surface. Sliced peer flows keep their existing safe fallback.
        !peer.flow && !intersectRegions(origin, box) && this.motionRoot(peer.root) === motion
          ? [[peer.root, box] as const]
          : [],
      ),
    );
    const scan = this.doc.createTreeWalker(
      group.mirror,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    );
    // The mirror is already bounded by MAX_GROUP_NODES. Every original/translated glyph
    // and graphic is protected; solid backing alone can be cut out at the peer footprint.
    for (let node: Node | null = group.mirror; node && peers.size; node = scan.nextNode()) {
      let ink: readonly DOMRect[] = [];
      if (node instanceof Text && node.data.trim()) {
        const range = this.doc.createRange();
        range.selectNodeContents(node);
        ink = [...range.getClientRects()];
      } else if (node instanceof Element) {
        const r = node.getBoundingClientRect();
        if (![...peers.values()].some((box) => intersectRegions(r, box))) continue;
        const s = this.view.getComputedStyle(node);
        if (
          node.matches('img,svg') ||
          s.backgroundImage !== 'none' ||
          s.boxShadow !== 'none' ||
          s.outlineStyle !== 'none' ||
          ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'].some(
            (key) => parseFloat(s[key as keyof CSSStyleDeclaration] as string) > 0,
          )
        )
          ink = [r];
      }
      for (const [peer, box] of peers)
        if (ink.some((r) => intersectRegions(r, box))) peers.delete(peer);
    }
    return [...peers.keys()];
  }

  private split(root: Element, members: readonly TranslationLayoutEntry[]): Element[] {
    const children = [...root.children].filter((child) => {
      if (child.matches(excluded) || this.hidden(child)) return false;
      const r = child.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    // Keep overlapping photo/caption layers and mixed inline prose together. Split only
    // independent structural boxes; never isolate individual glyphs or formatting runs.
    if (
      members.some((entry) => !children.some((child) => child.contains(entry.owner))) ||
      children.some((child, i) =>
        children
          .slice(i + 1)
          .some((other) =>
            intersectRegions(child.getBoundingClientRect(), other.getBoundingClientRect()),
          ),
      )
    )
      return [];
    const selected = children.filter((child) =>
      members.some((entry) => child.contains(entry.owner)),
    );
    // Retrying the same content through one wrapper cannot resolve a peer collision.
    return selected.length > 1 ? selected : [];
  }

  private hidden(el: Element, preserveTextSpacing = false) {
    // Invisible text-only separators still reserve inline space. Keep their inert
    // layout in a copy, without collecting them for translation or exposing hidden UI.
    const spacing =
      preserveTextSpacing &&
      el instanceof HTMLElement &&
      el.childElementCount === 0 &&
      !el.matches(controls) &&
      !translationEditable(el) &&
      /\S/.test(el.textContent ?? '');
    const f = this.geometry.facts(el);
    return (
      el.hasAttribute('hidden') ||
      f.display === 'none' ||
      (!spacing && f.visibility === 'hidden') ||
      f.visibility === 'collapse' ||
      (!spacing && f.opacity === '0') ||
      f.contentVisibility === 'hidden' ||
      f.emptyOverflow ||
      f.clip?.kind === 'hidden'
    );
  }

  private paintsBox(el: Element) {
    const s = this.view.getComputedStyle(el);
    return (
      el.matches('table,td,th,img,svg') ||
      !transparent(s.backgroundColor) ||
      s.backgroundImage !== 'none' ||
      s.boxShadow !== 'none' ||
      (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) ||
      ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'].some(
        (key) => parseFloat(s[key as keyof CSSStyleDeclaration] as string) > 0,
      ) ||
      [...el.childNodes].some(
        (node) =>
          node.nodeType === Node.TEXT_NODE && /[^\s\u200b\ufeff]/.test(node.textContent ?? ''),
      ) ||
      ['::before', '::after'].some(
        (pseudo) =>
          !['', 'none', 'normal', '""'].includes(this.view.getComputedStyle(el, pseudo).content),
      )
    );
  }

  private opaqueCoverRegions(group: Group, cover: NonNullable<Group['opaqueCover']>) {
    const geometry = createTranslationGeometry(this.view);
    const origin = this.sourceBox(group);
    return cover.flatMap(({ source, inset }) => {
      const r = source.getBoundingClientRect(),
        pad = inset * (source.currentCSSZoom || 1);
      const original = visibleTranslationRect(
        geometry.clip(
          {
            x: r.x + pad,
            y: r.y + pad,
            width: Math.max(0, r.width - 2 * pad),
            height: Math.max(0, r.height - 2 * pad),
          },
          source,
          { boundary: group.root.parentElement },
        ),
      );
      const bounded = original && intersectRegions(original, origin);
      return bounded ? [bounded] : [];
    });
  }

  private sourceOpaqueCover(
    group: Group,
    behind: ReadonlySet<TranslationNativeSurface>,
  ): Group['opaqueCover'] {
    const geometry = createTranslationGeometry(this.view);
    const cover: NonNullable<Group['opaqueCover']> = [];
    const candidates = [...group.copies.keys()].filter(
      (node): node is Element => node instanceof Element,
    );
    for (let el = group.root.parentElement; el && el !== this.doc.body; el = el.parentElement)
      if (!candidates.includes(el)) candidates.push(el);
    for (const source of candidates) {
      const s = this.view.getComputedStyle(source);
      // Computed RGB-only linear gradients are opaque just like a solid color.
      // Other images, alpha stops, partial tiles and unknown shapes are not proof.
      const gradient = s.backgroundImage.match(/^linear-gradient\(((?:[^()]|\([^()]*\))*)\)/)?.[1];
      const rgb = /rgb\([\d.,\s]+\)/g;
      const gradientOpaque =
        gradient &&
        (gradient.match(rgb)?.length ?? 0) >= 2 &&
        /^[-+.\d%,\s]*$/.test(
          gradient
            .replace(
              /^(?:[-+.\d]+(?:deg|grad|rad|turn)|to(?:\s+(?:left|right|top|bottom)){1,2}),\s*/,
              '',
            )
            .replace(rgb, ''),
        ) &&
        /^(auto(?: auto)?|100% 100%)$/.test(s.backgroundSize.split(',')[0]?.trim() ?? '') &&
        /^(border|padding)-box$/.test(s.backgroundOrigin.split(',')[0]?.trim() ?? '') &&
        /^(border|padding)-box$/.test(s.backgroundClip.split(',')[0]?.trim() ?? '') &&
        s.backgroundBlendMode.split(',')[0]?.trim() === 'normal';
      const colorOpaque =
        /^rgb\(/.test(s.backgroundColor) &&
        /^(border|padding)-box$/.test(s.backgroundClip.split(',').at(-1)?.trim() ?? '');
      const radii = [
        'borderTopLeftRadius',
        'borderTopRightRadius',
        'borderBottomLeftRadius',
        'borderBottomRightRadius',
      ].flatMap((key) => String(s[key as keyof CSSStyleDeclaration]).split(' '));
      if ((!colorOpaque && !gradientOpaque) || radii.some((r) => !/^\d+(?:\.\d+)?px$/.test(r)))
        continue;
      // Use the safe rectangular interior, not rounded corners or transparent borders.
      const inset = Math.max(
        ...radii.map(parseFloat),
        ...['Top', 'Right', 'Bottom', 'Left'].map(
          (side) => parseFloat(s.getPropertyValue(`border-${side.toLowerCase()}-width`)) || 0,
        ),
      );
      let opaque = true;
      for (let el: Element | null = source; el; el = el.parentElement) {
        const style = this.view.getComputedStyle(el);
        if (
          style.opacity !== '1' ||
          style.filter !== 'none' ||
          style.mixBlendMode !== 'normal' ||
          style.maskImage !== 'none' ||
          this.geometry.facts(el).clip !== undefined
        ) {
          opaque = false;
          break;
        }
      }
      // An ancestor backdrop is usable only if it paints above the native surface.
      // A white page behind a transparent popup must never count as popup coverage.
      if (opaque)
        opaque = ![...behind].some((surface) => {
          const overlap = intersectRegions(source.getBoundingClientRect(), surface);
          if (!overlap || !surface.element) return false;
          const stack = this.doc.elementsFromPoint(
            overlap.x + overlap.width / 2,
            overlap.y + overlap.height / 2,
          );
          const index = stack.indexOf(source);
          return index < 0 || stack.indexOf(surface.element) <= index;
        });
      if (opaque) cover.push({ source, inset });
      if (cover.length > 64) return undefined;
    }
    const regions = this.opaqueCoverRegions(group, cover);
    if (!regions.length) return undefined;
    const nodes = new Set(group.copies.keys());
    const walker = this.doc.createTreeWalker(
      group.mirror,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    );
    for (let node: Node | null = group.mirror; node; node = walker.nextNode()) nodes.add(node);
    for (const node of nodes) {
      let ink: readonly DOMRect[] = [];
      if (node instanceof Text && node.data.trim()) {
        const range = this.doc.createRange();
        range.selectNodeContents(node);
        ink = [...range.getClientRects()];
      } else if (
        node instanceof Element &&
        this.paintsBox(node) &&
        (node.matches('img,svg') ||
          !cover.some((c) => c.source === node || group.copies.get(c.source) === node))
      ) {
        // Text-only inline line boxes may extend beyond their actual glyphs. Their
        // text nodes are checked separately, so an empty baseline strip isn't ink.
        const s = this.view.getComputedStyle(node);
        if (
          node.matches('img,svg') ||
          !transparent(s.backgroundColor) ||
          s.backgroundImage !== 'none' ||
          s.boxShadow !== 'none' ||
          s.outlineStyle !== 'none' ||
          ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'].some(
            (key) => parseFloat(s[key as keyof CSSStyleDeclaration] as string) > 0,
          )
        )
          ink = [node.getBoundingClientRect()];
      }
      if (
        ink.some((r) => {
          const visible = visibleTranslationRect(
            geometry.clip(r, node, {
              boundary: group.copies.has(node) ? group.root.parentElement : group.layer,
            }),
          );
          return (
            visible &&
            visible.width > 0 &&
            visible.height > 0 &&
            subtractRegions(visible, regions).length
          );
        })
      )
        return undefined;
    }
    return cover;
  }

  private foregroundPaint(roots: readonly Element[]) {
    const surfaces: Element[] = [];
    const visited = new Set<Element>();
    const complete = new Set<Element>();
    const independent = new Set(roots);
    let bounded = false;
    const visit = (el: Element, covers: readonly TranslationRect[] = []) => {
      if (visited.has(el)) return;
      if (visited.size >= MAX_LAYOUT_NODES || surfaces.length >= 64) {
        bounded = true;
        return;
      }
      visited.add(el);
      if (el.matches(excluded) || this.hidden(el)) return;
      // Each native boundary needs its own paint footprint even when an opaque
      // ancestor already covers it; otherwise its children disappear from collision
      // validation while the ancestor is copied by a different translation group.
      if (independent.has(el)) covers = [];
      const box = el.getBoundingClientRect();
      if (
        box.width > 0 &&
        box.height > 0 &&
        (this.paintsBox(el) ||
          el.matches(`${controls},canvas,video,iframe,object,embed`) ||
          el.shadowRoot)
      ) {
        const clipped = this.geometry.clip(box, el, { includeSelf: true });
        if (clipped.kind !== 'hidden') {
          const r = clipped.rect;
          if (
            independent.has(el) ||
            !covers.some(
              (cover) =>
                r.x >= cover.x &&
                r.y >= cover.y &&
                r.x + r.width <= cover.x + cover.width &&
                r.y + r.height <= cover.y + cover.height,
            )
          )
            surfaces.push(el);
          covers = [...covers, r];
        }
      }
      // Empty toast/portal shells are not occluders. If populated, only the
      // actually painted descendants cut holes in the translated flow. An opaque
      // header does not cover a dropdown that escapes its box; keep scanning under
      // the same budget, recording only independently stacked or uncovered paint.
      for (const child of el.children) visit(child, covers);
    };
    for (const el of roots) {
      visit(el);
      if (!bounded) complete.add(el);
    }
    return { surfaces, complete };
  }

  private style(source: Element, target: Element) {
    const style = this.view.getComputedStyle(source);
    const dest = (target as HTMLElement | SVGElement).style;
    const typed =
      'computedStyleMap' in source
        ? (
            source as Element & {
              computedStyleMap(): {
                get(name: string): { toString(): string } | undefined;
              };
            }
          ).computedStyleMap()
        : undefined;
    for (const key of visualProperties) dest.setProperty(key, style.getPropertyValue(key));
    for (const key of maskProperties) dest.setProperty(key, style.getPropertyValue(key));
    // Intrinsic graphics are not spare space for a longer translated label.
    if (
      source.matches('img,svg') ||
      (style.maskImage && style.maskImage !== 'none') ||
      (style.backgroundImage !== 'none' && !/[\p{L}\p{N}]/u.test(source.textContent ?? ''))
    )
      dest.flexShrink = '0';
    dest.clipPath = style.clipPath;
    dest.clip = style.clip;
    // Individual translate is independent of transform; omitting it stacks otherwise
    // clipped slides at the same origin and incorrectly exposes offscreen text.
    dest.translate = style.translate;
    for (const key of layoutProperties)
      dest.setProperty(key, typed?.get(key)?.toString() ?? style.getPropertyValue(key));
    // A virtual list's percentage/flex height needs the original scrollport constraint,
    // not the content height of a detached absolute island. Otherwise scrollTop clamps
    // to zero and the mirrored sidebar shows a different, mostly empty part of the list.
    if (
      /^(auto|scroll)$/.test(style.overflowY) &&
      source.clientHeight > 0 &&
      source.scrollHeight > source.clientHeight + 1
    ) {
      dest.height = style.height;
      dest.maxHeight = style.height;
      dest.minHeight = '0';
      dest.flexShrink = '0';
    }
    // Chromium serializes legacy -webkit-box as flow-root. Copying that computed
    // display literally disables the original multi-line ellipsis contract.
    if (parseInt(style.webkitLineClamp) > 0 && style.webkitBoxOrient === 'vertical')
      dest.display = style.display.includes('inline') ? '-webkit-inline-box' : '-webkit-box';
    dest.pointerEvents = 'none';
    // A mirror is a static reading surface; it cannot run source transitions or animations.
    dest.animation = 'none';
    dest.transition = 'none';
  }

  private anchor(source: Element) {
    const link = this.doc.createElement('a');
    const href = source.getAttribute('href') ?? '';
    // Never turn an executable URL into a new active link inside the reading surface.
    try {
      // Match the browser's URL parser, including whitespace/control normalization.
      if (
        !['http:', 'https:', 'mailto:', 'tel:'].includes(new URL(href, this.doc.baseURI).protocol)
      )
        return link;
    } catch {
      return link;
    }
    link.setAttribute('href', href);
    for (const name of ['target', 'rel', 'download']) {
      const value = source.getAttribute(name);
      if (value !== null) link.setAttribute(name, value);
    }
    link.style.pointerEvents = 'auto';
    link.addEventListener('click', (event) => {
      if (
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !event.altKey &&
        source.isConnected
      ) {
        event.preventDefault();
        (source as HTMLElement).click();
      }
    });
    // A link in the shadow tree has no source scrollport in its event path. Preserve
    // wheel scrolling through that original chain, instead of trapping it in the lens.
    link.addEventListener(
      'wheel',
      (event) => {
        if (event.ctrlKey) return;
        event.preventDefault();
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.view.innerHeight : 1;
        let dx = event.deltaX * unit,
          dy = event.deltaY * unit;
        for (let el: Element | null = source; el; el = el.parentElement) {
          const s = this.view.getComputedStyle(el),
            beforeX = el.scrollLeft,
            beforeY = el.scrollTop,
            documentPort = el === this.doc.scrollingElement,
            scrollX = documentPort
              ? !/^(hidden|clip)$/.test(s.overflowX)
              : /^(auto|scroll)$/.test(s.overflowX),
            scrollY = documentPort
              ? !/^(hidden|clip)$/.test(s.overflowY)
              : /^(auto|scroll)$/.test(s.overflowY);
          if (dx && scrollX) el.scrollLeft += dx;
          if (dy && scrollY) el.scrollTop += dy;
          dx -= el.scrollLeft - beforeX;
          dy -= el.scrollTop - beforeY;
          // Overscroll containment only applies at an actual scroll container. Many
          // sites set it on every element; a plain link must not swallow the gesture.
          if (scrollX && /^(contain|none)$/.test(s.overscrollBehaviorX)) dx = 0;
          if (scrollY && /^(contain|none)$/.test(s.overscrollBehaviorY)) dy = 0;
          if (!dx && !dy) return;
        }
      },
      { passive: false },
    );
    return link;
  }

  private create(source: LayoutSource): Group | null {
    const { flow } = source;
    const root = flow?.parent ?? source.root;
    const copies = new Map<Node, Node>();
    const scrolls: [Element, Element][] = [];
    const sticky: [Element, HTMLElement, Element][] = [];
    let nodes = 0,
      unsupported = false;
    const copy = (source: Node): Node | null => {
      if (++nodes > MAX_GROUP_NODES) {
        unsupported = true;
        return null;
      }
      if (source.nodeType === Node.TEXT_NODE) {
        if (translationEditable(source.parentElement)) return null;
        const text = this.doc.createTextNode(source.textContent ?? '');
        copies.set(source, text);
        return text;
      }
      if (!(source instanceof Element) || source.matches(excluded) || this.hidden(source, true))
        return null;
      // Independent fixed content is rendered by its own island (or kept native),
      // with an occlusion cutout in this normal-flow copy. Never duplicate it here.
      if (source !== root && this.view.getComputedStyle(source).position === 'fixed') return null;
      // An editable ancestor may contain explicit read-only islands. Its text is filtered
      // above, and no contenteditable attributes or form state are copied.
      if (
        liveSurface(source) ||
        this.deferred.has(source) ||
        source.shadowRoot ||
        hasLiveTranslationAnimation(source) ||
        this.geometry.facts(source).clip?.kind === 'uncertain'
      ) {
        unsupported = true;
        return null;
      }
      const svg = source.namespaceURI === 'http://www.w3.org/2000/svg';
      if (svg && !svgTags.has(source.localName)) return null;
      const imageUrl = translationImageUrl(source);
      const safeTag = imageUrl
        ? 'img'
        : source.localName.includes('-') || source.matches('form')
          ? 'div'
          : source.localName;
      const target = svg
        ? this.doc.createElementNS(source.namespaceURI, source.localName)
        : source.matches('a[href]')
          ? this.anchor(source)
          : this.doc.createElement(safeTag);
      if (target instanceof HTMLButtonElement) {
        // Retain the browser's anonymous button formatting context and centering,
        // without copying submission, focus or source event behavior.
        target.type = 'button';
        target.inert = true;
        target.tabIndex = -1;
      }
      copies.set(source, target);
      if (svg)
        for (const name of source.getAttributeNames()) {
          const value = source.getAttribute(name);
          if (
            value !== null &&
            (svgAttributes.has(name) ||
              ((name === 'href' || name === 'xlink:href') && value.startsWith('#')))
          )
            target.setAttribute(name, value);
        }
      for (const name of [
        'colspan',
        'rowspan',
        'span',
        'dir',
        'lang',
        'open',
        'start',
        'reversed',
      ]) {
        const value = source.getAttribute(name);
        if (value !== null) target.setAttribute(name, value);
      }
      this.style(source, target);
      if (this.hidden(source)) {
        target.setAttribute('inert', '');
        target.setAttribute('aria-hidden', 'true');
      }
      if (target instanceof HTMLAnchorElement && target.hasAttribute('href'))
        target.style.pointerEvents = 'auto';
      if (imageUrl && target instanceof HTMLImageElement) {
        target.src = imageUrl;
        target.alt = source instanceof HTMLImageElement ? source.alt : '';
        target.loading = 'eager';
        target.decoding = 'sync';
        if (source instanceof HTMLObjectElement) {
          const s = this.view.getComputedStyle(source);
          target.style.width = s.width;
          target.style.height = s.height;
        }
      }
      // Generated decoration is local data, never HTML. Editable carets/handles are not copied.
      const pseudo = (kind: '::before' | '::after') => {
        const s = this.view.getComputedStyle(source, kind);
        if (!s.content || ['none', 'normal'].includes(s.content) || s.display === 'none') return;
        if (!/^"(?:[^"\\]|\\.)*"$/.test(s.content)) return;
        const el = this.doc.createElement('span');
        el.dataset.translationDecoration = kind;
        for (const key of [...visualProperties, ...layoutProperties, ...maskProperties])
          el.style.setProperty(key, s.getPropertyValue(key));
        el.style.pointerEvents = 'none';
        try {
          el.textContent = JSON.parse(s.content);
        } catch {
          return;
        }
        target.append(el);
      };
      if (!svg) pseudo('::before');
      const closed = source.matches('details:not([open])');
      for (const child of source === root && flow ? flow.children : source.childNodes) {
        if (closed && (!(child instanceof Element) || child !== source.querySelector('summary')))
          continue;
        const childCopy = copy(child);
        if (childCopy) target.append(childCopy);
      }
      if (!svg) pseudo('::after');
      const s = this.view.getComputedStyle(source);
      if (/^(auto|scroll|hidden)$/.test(s.overflowX) || /^(auto|scroll|hidden)$/.test(s.overflowY))
        scrolls.push([source, target]);
      if (source !== root && s.position === 'sticky') {
        let port = source.parentElement;
        while (port && !/^(auto|scroll|hidden)$/.test(this.view.getComputedStyle(port).overflowY))
          port = port.parentElement;
        if (port && !root.contains(port)) sticky.push([source, target as HTMLElement, port]);
      }
      return target;
    };
    const mirror = copy(root);
    if (!(mirror instanceof Element) || unsupported) return null;
    const box = this.sourceBox(source);
    const zoom = root.currentCSSZoom || 1;
    const rootStyle = this.view.getComputedStyle(root);
    const horizontalInsets =
      rootStyle.boxSizing === 'border-box'
        ? 0
        : ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce(
            (sum, key) =>
              sum + (parseFloat(rootStyle[key as keyof CSSStyleDeclaration] as string) || 0),
            0,
          );
    const layer = this.doc.createElement('div');
    layer.className = 'translation-group';
    Object.assign(layer.style, {
      position: 'absolute',
      boxSizing: 'border-box',
      display: 'flow-root',
      width: `${box.width}px`,
      minHeight: `${box.height}px`,
      pointerEvents: 'none',
      isolation: 'isolate',
    });
    Object.assign((mirror as HTMLElement).style, {
      position: 'relative',
      inset: 'auto',
      margin: '0',
      width: `${Math.max(0, box.width / zoom - horizontalInsets)}px`,
      // This is the page's effective CSS zoom, not a fitted/rasterized translation scale.
      // Ancestors outside the mirror no longer supply it, so apply it once at its root.
      zoom: String(zoom),
      minWidth: '0',
      maxWidth: 'none',
      transform: 'none',
      translate: 'none',
      float: 'none',
    });
    // Out-of-flow islands cannot contract the original page beneath them. Keep
    // their background/border envelope at least as tall as the original footprint,
    // just like the backing layer; normal document flow may still reflow naturally.
    if (!flow && /^(absolute|fixed)$/.test(rootStyle.position)) {
      const insets =
        rootStyle.boxSizing === 'border-box'
          ? 0
          : ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce(
              (sum, key) =>
                sum + (parseFloat(rootStyle[key as keyof CSSStyleDeclaration] as string) || 0),
              0,
            );
      (mirror as HTMLElement).style.minHeight = `${Math.max(0, box.height / zoom - insets)}px`;
    }
    // The island has its own measured origin, not an outside inline baseline. Keeping
    // an inline-block root here introduces a line-box strut/descent below an adjacent
    // control even when the original label fits exactly. Retain its internal BFC only.
    if (rootStyle.display === 'inline-block') (mirror as HTMLElement).style.display = 'flow-root';
    // A detached row/row-group otherwise gets an anonymous shrink-to-content table.
    // Its width declaration is ignored there, collapsing full-width table navigation.
    // Supply the table formatting context at the island boundary, keeping its cells intact.
    if (/^table-(row|row-group|header-group|footer-group)$/.test(rootStyle.display))
      (mirror as HTMLElement).style.display = 'table';
    // A cell isolated beside live content still needs its table formatting context.
    // An anonymous auto-layout table ignores the cell's measured width and expands
    // to clipped text's intrinsic width. A fixed single-cell table preserves both
    // the column boundary and the source row's vertical alignment.
    if (rootStyle.display === 'table-cell')
      Object.assign(layer.style, {
        display: 'table',
        tableLayout: 'fixed',
        borderSpacing: '0',
        height: `${box.height}px`,
      });
    if (flow)
      Object.assign((mirror as HTMLElement).style, {
        height: 'auto',
        minHeight: '0',
        maxHeight: 'none',
      });
    const overflow = this.doc.createElement('div');
    Object.assign(overflow.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '-1',
    });
    const watermarks = this.doc.createElement('div');
    Object.assign(watermarks.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '2147483647',
    });
    layer.append(overflow, mirror, watermarks);
    return {
      ...source,
      layer,
      mirror,
      copies,
      scrolls,
      sticky,
      applied: new Map(),
      original: new Map(),
      overflow,
      watermarks,
      dirty: false,
      width: box.width,
      backdrops: [],
      occluders: [],
      peerCutouts: [],
    };
  }

  private apply(group: Group, entry: TranslationLayoutEntry) {
    const value = textOf(entry);
    if (value === undefined) return;
    validateTranslationMarkup(entry.text, value);
    const previous = group.applied.get(entry.id);
    if (previous?.value === value) return;
    let segments = translationSegments(entry.whitespace ? value.trim() : value);
    const plain = segments.map((segment) => segment.text).join('');
    if (plain === entry.plain && !previous) return;
    const slots = entry.whitespace?.slots;
    if (slots) {
      // Literal lines belong to the source structure, not to model word order.
      // Preserve model order inside each line, then bind indentation/separators
      // by position so moving an emphasized word cannot move its line's prefix.
      const lines = new Map<number, number>();
      let line = 0;
      for (const slot of slots) {
        line += slot.before.split('\n').length - 1;
        lines.set(slot.marker, line);
        line += slot.after.split('\n').length - 1;
      }
      const ordered = segments
        .flatMap((segment, i) => {
          if (segment.id === undefined) {
            if (segment.text.trim()) throw new Error('Text outside preserved whitespace slots');
            return [];
          }
          const line = lines.get(Number(segment.id));
          if (line === undefined) throw new Error('Missing source whitespace slot');
          const previous = segments[i - 1];
          return [
            {
              segment,
              line,
              gap: previous?.id === undefined ? (previous?.text ?? '') : '',
            },
          ];
        })
        .sort((a, b) => a.line - b.line);
      segments = ordered.flatMap(({ segment, line, gap }, i) => {
        const slot = slots[i];
        if (!slot) throw new Error('Missing source whitespace slot');
        return [
          ...(ordered[i - 1]?.line === line && !slots[i - 1]?.after && !slot.before && gap
            ? [{ text: gap }]
            : []),
          { ...segment, text: slot.before + segment.text.trim() + slot.after },
        ];
      });
    }
    // Explicit structure splits a source owner into several runs. Bind such a
    // run inside its common inline ancestor, not before that ancestor: otherwise
    // both sides of a BR are moved ahead of the break.
    let bindingOwner = entry.owner;
    if (entry.key !== entry.owner) {
      let ancestor = entry.nodes[0]?.parentElement;
      while (
        ancestor &&
        ancestor !== entry.owner &&
        !entry.nodes.every((n) => ancestor?.contains(n))
      )
        ancestor = ancestor.parentElement;
      bindingOwner = ancestor ?? entry.owner;
    }
    const owner = group.copies.get(bindingOwner);
    if (!(owner instanceof Element)) {
      this.rejections.set(entry.id, 'unsafe-copy');
      return;
    }
    const flow = this.doc.createElement('span');
    flow.className = plain === entry.plain ? '' : 'text';
    flow.dataset.translationId = entry.id;
    flow.title = plain;
    const typography = this.view.getComputedStyle(bindingOwner);
    for (const key of translationTypography) flow.style[key] = typography[key];
    const paths = segments.map((segment) => {
      const path: Element[] = [];
      let source = 'id' in segment ? entry.markers[Number(segment.id)] : undefined;
      while (source && source !== bindingOwner && bindingOwner.contains(source)) {
        path.unshift(source);
        source = source.parentElement ?? undefined;
      }
      return path;
    });
    const common = (a: Element[], b: Element[]) => {
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      return i;
    };
    // A space between two nested markers belongs to their shared wrapper. It
    // must not close and reopen the link/background/padding around every marker.
    paths.forEach((path, i) => {
      if (path.length || segments[i]?.text.trim() || i === 0) return;
      const before = paths[i - 1] ?? [],
        after = paths[i + 1] ?? [];
      paths[i] = before.slice(0, common(before, after));
    });
    const bindings = new Map<Element, Element>();
    let active: Element[] = [],
      shells: Element[] = [],
      insertionPoints: Comment[] = [];
    if (entry.whitespace) flow.append(this.doc.createTextNode(entry.whitespace.before));
    segments.forEach((segment, i) => {
      const path = paths[i] ?? [];
      const keep = common(active, path);
      shells = shells.slice(0, keep);
      insertionPoints = insertionPoints.slice(0, keep);
      for (const source of path.slice(keep)) {
        const template = group.copies.get(source);
        if (!(template instanceof Element)) throw new Error('Missing safe inline binding');
        const shell = source.matches('a[href]')
          ? this.anchor(source)
          : (template.cloneNode(false) as Element);
        this.style(source, shell);
        if (shell instanceof HTMLAnchorElement && shell.hasAttribute('href'))
          shell.style.pointerEvents = 'auto';
        // Graphics and generated decoration are source-owned, not model text.
        // Move their already-sanitized copies with the inline shell exactly once.
        const insertion = this.doc.createComment('translation text');
        const decoration = [...template.children].filter(
          (el) => el instanceof HTMLElement && el.dataset.translationDecoration,
        );
        for (const el of decoration)
          if ((el as HTMLElement).dataset.translationDecoration === '::before') shell.append(el);
        let afterText = false;
        for (const child of source.childNodes) {
          if (entry.nodes.some((node) => child === node || child.contains(node))) {
            if (!afterText) shell.append(insertion);
            afterText = true;
          } else {
            const copy = group.copies.get(child);
            if (copy?.parentNode === template) shell.append(copy);
          }
        }
        if (!afterText) shell.append(insertion);
        for (const el of decoration)
          if ((el as HTMLElement).dataset.translationDecoration === '::after') shell.append(el);
        (shells.at(-1) ?? flow).insertBefore(shell, insertionPoints.at(-1) ?? null);
        shells.push(shell);
        insertionPoints.push(insertion);
        bindings.set(source, shell);
      }
      (shells.at(-1) ?? flow).insertBefore(
        this.doc.createTextNode(segment.text),
        insertionPoints.at(-1) ?? null,
      );
      active = path;
    });
    if (entry.whitespace) flow.append(this.doc.createTextNode(entry.whitespace.after));
    if (previous) previous.element.replaceWith(flow);
    else {
      const first = entry.nodes
        .map((node) => group.copies.get(node))
        .find((node) => node?.parentNode);
      if (!first) {
        this.rejections.set(entry.id, 'unsafe-copy');
        return;
      }
      let insertion = first;
      while (insertion.parentNode && insertion.parentNode !== owner)
        insertion = insertion.parentNode;
      owner.insertBefore(flow, insertion.parentNode === owner ? insertion : null);
      for (const node of entry.nodes) {
        const cloned = group.copies.get(node);
        let parent = cloned?.parentElement;
        cloned?.parentNode?.removeChild(cloned);
        while (parent && parent !== owner && !parent.childNodes.length) {
          const next = parent.parentElement;
          parent.remove();
          parent = next;
        }
      }
    }
    for (const node of entry.nodes) group.copies.set(node, flow);
    for (const [source, shell] of bindings) group.copies.set(source, shell);
    group.applied.set(entry.id, { value, element: flow });
  }

  private position(group: Group, watermarks: readonly TranslationWatermark[], moving = false) {
    this.positionRejection = 'layout-budget';
    const box = this.sourceBox(group);
    const placement = moving ? group.placement : undefined;
    if (moving && !placement) return null;
    const dx = box.x - (placement?.origin.x ?? box.x),
      dy = box.y - (placement?.origin.y ?? box.y);
    const shift = (r: TranslationRect): TranslationRect => ({
      ...r,
      x: r.x + dx,
      y: r.y + dy,
    });
    Object.assign(group.layer.style, { left: `${box.x}px`, top: `${box.y}px` });
    // The source's border box already excludes collapsed outer margins. The absolute
    // wrapper must not add the first child's collapsed margin a second time.
    const mirror = group.mirror as HTMLElement;
    if (!moving) {
      const firstSource = group.flow?.children[0];
      const first = firstSource && group.copies.get(firstSource);
      const offset =
        (first instanceof Element ? first : mirror).getBoundingClientRect().top -
        group.layer.getBoundingClientRect().top;
      if (Math.abs(offset) > 0.01)
        mirror.style.marginTop = `${(parseFloat(mirror.style.marginTop) || 0) - offset / (mirror.currentCSSZoom || 1)}px`;
      const lastSource = group.flow?.children.at(-1);
      const last = lastSource && group.copies.get(lastSource);
      const height =
        last instanceof Element
          ? last.getBoundingClientRect().bottom - group.layer.getBoundingClientRect().top
          : mirror.getBoundingClientRect().height;
      group.layer.style.height = `${Math.max(box.height, height)}px`;
      // scrollWidth includes isolated out-of-flow decorations. Expanding the entire
      // opaque backdrop to that width covers unrelated gutter controls at other rows.
      // Structural overflow gets its own clipped rectangles below.
      group.layer.style.width = `${box.width}px`;
    }
    // Composite the ancestor backdrop at its original viewport coordinates; the cloned island
    // supplies its own photos, gradients and borders, rather than per-glyph white rectangles.
    const backgrounds: { image: string; box?: DOMRect; repeat?: string }[] = [];
    const ancestors: Element[] = [];
    let clip: TranslationRect = {
      x: 0,
      y: 0,
      width: this.view.innerWidth,
      height: this.view.innerHeight,
    };
    const geometry = createTranslationGeometry(this.view);
    const localClip = geometry.facts(mirror).clip;
    const rootClip = placement
      ? placement.clip && shift(placement.clip)
      : localClip?.kind === 'visible'
        ? localClip.rect
        : undefined;
    if (rootClip)
      clip = intersectRegions(clip, rootClip) ?? {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      };
    const unboundedY = new Set<Element>();
    for (let el = (group.flow?.parent ?? group.root).parentElement; el; el = el.parentElement) {
      const s = this.view.getComputedStyle(el);
      ancestors.push(el);
      // An auto-height float clearfix grows with its content; its old source height
      // is not a viewport for the independently reflowed column. Preserve horizontal
      // clipping and all explicit height/scroll/paint constraints. Collision checks
      // still reject growth over another column, following text or native media.
      if (
        s.overflowY === 'hidden' &&
        /^(static|relative)$/.test(s.position) &&
        !/size|paint|strict|content/.test(s.contain) &&
        !(parseInt(s.webkitLineClamp) > 0) &&
        el.scrollHeight <= el.clientHeight + 1 &&
        'computedStyleMap' in el
      ) {
        const typed = (
          el as Element & {
            computedStyleMap(): {
              get(name: string): { toString(): string } | undefined;
            };
          }
        ).computedStyleMap();
        if (
          typed.get('height')?.toString() === 'auto' &&
          typed.get('max-height')?.toString() === 'none' &&
          typed.get('aspect-ratio')?.toString() === 'auto' &&
          [...el.children].some(
            (child) =>
              child.contains(group.flow?.parent ?? group.root) &&
              /^(left|right)$/.test(this.view.getComputedStyle(child).cssFloat),
          )
        )
          unboundedY.add(el);
      }
    }
    const external = geometry.clip(clip, group.flow?.parent ?? group.root, {
      unboundedY,
    });
    if (external.kind === 'uncertain') {
      this.positionRejection = 'geometry-uncertain';
      return null;
    }
    clip = external.kind === 'hidden' ? { x: 0, y: 0, width: 0, height: 0 } : external.rect;
    if (!moving) {
      const visible = intersectRegions(box, clip);
      const root = group.flow?.parent ?? group.root;
      // Decorations can be siblings (e.g. a header background extending behind a nav).
      // Use the browser's paint order, accepting only backgrounds covering the full
      // visible source footprint. Never copy an unrelated widget's text or controls.
      const stack = visible
        ? (this.doc.elementsFromPoint?.(
            visible.x + visible.width / 2,
            visible.y + visible.height / 2,
          ) ?? [])
        : [];
      group.backdrops = [
        ...new Set([
          ...stack.filter((el) => {
            if (root.contains(el) || el.closest('[data-chatbrowserx-overlay]')) return false;
            if (ancestors.includes(el)) return true;
            const r = el.getBoundingClientRect();
            return (
              visible &&
              r.left <= visible.x &&
              r.top <= visible.y &&
              r.right >= visible.x + visible.width &&
              r.bottom >= visible.y + visible.height
            );
          }),
          ...ancestors,
        ]),
      ];
    }
    for (const el of group.backdrops) {
      const s = this.view.getComputedStyle(el),
        r = el.getBoundingClientRect();
      if (s.backgroundImage && s.backgroundImage !== 'none')
        backgrounds.push({
          image: s.backgroundImage,
          box: r,
          repeat: s.backgroundRepeat,
        });
      if (!transparent(s.backgroundColor))
        backgrounds.push({
          image: `linear-gradient(${s.backgroundColor},${s.backgroundColor})`,
        });
    }
    const backgroundAt = (origin: TranslationRect) =>
      [
        ...backgrounds.map(({ image, box: r, repeat }) =>
          r
            ? `${image} ${r.x - origin.x}px ${r.y - origin.y}px / ${r.width}px ${r.height}px ${repeat}`
            : image,
        ),
        'linear-gradient(white,white)',
      ].join(',');
    group.layer.style.background = backgroundAt(box);
    for (const [source, target] of group.scrolls) {
      target.scrollLeft = source.scrollLeft;
      target.scrollTop = source.scrollTop;
    }
    for (const [source, target, port] of group.sticky) {
      const s = this.view.getComputedStyle(source),
        r = port.getBoundingClientRect();
      const zoom = source.currentCSSZoom || 1,
        portZoom = port.currentCSSZoom || 1;
      if (s.top !== 'auto')
        target.style.top = `${parseFloat(s.top) + (r.top + port.clientTop * portZoom) / zoom}px`;
      if (s.bottom !== 'auto')
        target.style.bottom = `${parseFloat(s.bottom) + (this.view.innerHeight - r.top - (port.clientTop + port.clientHeight) * portZoom) / zoom}px`;
    }
    const rendered = placement
      ? new DOMRect(box.x, box.y, placement.width, placement.height)
      : group.layer.getBoundingClientRect();
    const painted: { region: TranslationRect; source: TranslationRect }[] = placement
      ? placement.painted.map(({ region, source }) => ({
          region: shift(region),
          source: shift(source),
        }))
      : [
          {
            region: rendered,
            source: {
              x: box.x,
              y: box.y,
              width: box.width,
              height: box.height,
            },
          },
        ];
    // Transparent descendants may paint to the left/above their root (for example a
    // panned table). Back only those structural overflow rectangles, not the whole
    // neighboring column and not individual glyphs. Include the original footprint too:
    // preceding translated prose can move a table away from its still-visible source.
    const overflowRegions: typeof painted = [];
    for (const [source, copy] of moving ? [] : group.copies) {
      if (!(source instanceof Element) || !(copy instanceof Element)) continue;
      if (source === group.flow?.parent) continue;
      // A transparent editor wrapper can include a wide, empty interaction gutter.
      // Its descendants own the actual ink; backing the whole wrapper erases adjacent UI.
      if (!this.paintsBox(source)) continue;
      const sourceBox = source.getBoundingClientRect();
      for (const element of [source, copy]) {
        const measured = element === source ? sourceBox : copy.getBoundingClientRect();
        // Cache the whole structural overflow, not just today's viewport slice. The
        // external scrollport clip is applied to the group below and moves independently;
        // otherwise newly exposed rows would lose their backing during a gesture.
        let region: TranslationRect | null =
          measured.width > 0 && measured.height > 0 ? measured : null;
        if (
          !region ||
          !subtractRegions(
            region,
            painted.map((p) => p.region),
          ).length
        )
          continue;
        const boundary =
          element === source ? (group.flow?.parent ?? group.root).parentElement : group.layer;
        region = visibleTranslationRect(
          geometry.clip(region, element, { boundary, includeSelf: true }),
        );
        if (region) overflowRegions.push({ region, source: sourceBox });
      }
    }
    // Cover large containers first. Otherwise small overlapping editor decorations can
    // fragment a later container into dozens of strips and exhaust the safety budget.
    overflowRegions.sort(
      (a, b) => b.region.width * b.region.height - a.region.width * a.region.height,
    );
    for (const { region, source } of overflowRegions)
      for (const part of subtractRegions(
        region,
        painted.map((p) => p.region),
      )) {
        if (painted.length >= 64) return null;
        painted.push({ region: part, source });
      }
    while (group.overflow.children.length >= painted.length)
      group.overflow.lastElementChild?.remove();
    painted.slice(1).forEach(({ region }, index) => {
      const el =
        (group.overflow.children[index] as HTMLElement | undefined) ??
        this.doc.createElement('div');
      el.className = 'translation-overflow-background';
      Object.assign(el.style, {
        position: 'absolute',
        left: `${region.x - box.x}px`,
        top: `${region.y - box.y}px`,
        width: `${region.width}px`,
        height: `${region.height}px`,
        background: backgroundAt(region),
      });
      if (!el.parentNode) group.overflow.append(el);
    });
    // Negative insets preserve native visible overflow (for example a horizontally panned
    // table). Clamping at the island origin would cut off its first columns arbitrarily.
    if (group.flow)
      clip = intersectRegions(clip, {
        x: clip.x,
        y: box.y,
        width: clip.width,
        height: rendered.height,
      }) ?? { x: 0, y: 0, width: 0, height: 0 };
    const covers = group.occluders.flatMap((el) => {
      if (!el.isConnected) return [];
      const clipped = geometry.clip(geometry.facts(el).box, el, {
        includeSelf: true,
      });
      const visible = clipped.kind !== 'hidden' && intersectRegions(clipped.rect, clip);
      return visible ? [visible] : [];
    });
    for (const { anchor, offset } of group.peerCutouts) {
      if (!anchor.isConnected) continue;
      const source = anchor.getBoundingClientRect();
      const visible = intersectRegions(
        { ...offset, x: source.x + offset.x, y: source.y + offset.y },
        clip,
      );
      if (visible) covers.push(visible);
    }
    let clips = covers.length ? subtractRegions(clip, covers) : [clip];
    if (group.opaqueCover) {
      const opaque = this.opaqueCoverRegions(group, group.opaqueCover);
      clips = clips.flatMap((part) =>
        opaque.flatMap((r) => {
          const overlap = intersectRegions(part, r);
          return overlap ? [overlap] : [];
        }),
      );
    }
    if (clips.length > 128) return null;
    group.layer.style.clipPath =
      covers.length || group.opaqueCover
        ? `path("${
            clips
              .map((r) => {
                const x = r.x - box.x,
                  y = r.y - box.y;
                return `M${x} ${y}h${r.width}v${r.height}h${-r.width}Z`;
              })
              .join('') || 'M0 0Z'
          }")`
        : `inset(${clip.y - box.y}px ${rendered.right - clip.x - clip.width}px ${rendered.bottom - clip.y - clip.height}px ${clip.x - box.x}px)`;
    if (placement) {
      // Document watermarks are viewport-fixed, not part of the scrolling document.
      for (const el of group.watermarks.querySelectorAll<HTMLElement>('.translation-watermark'))
        el.style.translate = `${-dx}px ${-dy}px`;
      return painted;
    }
    group.watermarks.replaceChildren(
      ...(watermarks.length ? painted : []).map(({ region }) => {
        const pane = this.doc.createElement('div');
        Object.assign(pane.style, {
          position: 'absolute',
          left: `${region.x - box.x}px`,
          top: `${region.y - box.y}px`,
          width: `${region.width}px`,
          height: `${region.height}px`,
          overflow: 'hidden',
        });
        for (const watermark of watermarks) {
          const el = this.doc.createElement('div');
          el.className = 'translation-watermark';
          Object.assign(el.style, watermark.style, {
            position: 'absolute',
            left: `${watermark.box.x - region.x}px`,
            top: `${watermark.box.y - region.y}px`,
            width: `${watermark.box.width}px`,
            height: `${watermark.box.height}px`,
          });
          pane.append(el);
        }
        return pane;
      }),
    );
    group.placement = {
      origin: box,
      width: rendered.width,
      height: rendered.height,
      clip: rootClip ?? undefined,
      painted: painted.map(({ region, source }) => ({
        region: {
          x: region.x,
          y: region.y,
          width: region.width,
          height: region.height,
        },
        source: {
          x: source.x,
          y: source.y,
          width: source.width,
          height: source.height,
        },
      })),
    };
    return painted.flatMap(({ region, source }) =>
      clips.flatMap((part) => {
        const visible = intersectRegions(region, part);
        return visible ? [{ region: visible, source }] : [];
      }),
    );
  }
}
