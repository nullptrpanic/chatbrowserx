import type { TranslationGeometry } from './translation-geometry';
import type { TranslationRect } from './translation-regions';

export interface TranslationLabelBudget {
  source: Element;
  inlineSize: number;
  lineLimit: number;
  reason: 'source-ellipsis' | 'fixed-cell' | 'independent-neighbor';
  blockSize: number;
  insets: number;
  borderBox: boolean;
  formatting: 'inline' | 'atomic' | 'flex' | 'clamp';
  /** A utility action/readout must retain a complete label, not a one-letter ellipsis. */
  complete: boolean;
}

interface RowCell {
  source: Element;
  width: number;
  minimum: number;
  decoration: boolean;
}

export interface TranslationRowBudget {
  source: Element;
  cells: readonly RowCell[];
  direction: 'row' | 'row-reverse';
  gap: number;
  convert: boolean;
  inline: boolean;
  hidden: readonly Element[];
}

export interface TranslationTextConstraints {
  labels: readonly TranslationLabelBudget[];
  intrinsicLabels: readonly { source: Element; minimum: number }[];
  rows: readonly TranslationRowBudget[];
  columns: readonly { source: Element; inlineSize: number }[];
}

const number = (value: string) => parseFloat(value) || 0;
const lineHeight = (s: CSSStyleDeclaration) => number(s.lineHeight) || number(s.fontSize) * 1.2;
const horizontalInsets = (s: CSSStyleDeclaration) =>
  number(s.paddingLeft) +
  number(s.paddingRight) +
  number(s.borderLeftWidth) +
  number(s.borderRightWidth);
const verticalInsets = (s: CSSStyleDeclaration) =>
  number(s.paddingTop) +
  number(s.paddingBottom) +
  number(s.borderTopWidth) +
  number(s.borderBottomWidth);
const declared = (el: Element, property: string) =>
  typeof el.computedStyleMap === 'function'
    ? (
        el as Element & {
          computedStyleMap(): {
            get(name: string): { toString(): string } | undefined;
          };
        }
      )
        .computedStyleMap()
        .get(property)
        ?.toString()
    : el instanceof HTMLElement
      ? el.style.getPropertyValue(property)
      : undefined;

/** Read source layout contracts only for nodes admitted by the bounded safe copier. */
export function readTranslationTextConstraints(
  root: Element,
  children: readonly Element[] | undefined,
  protectedRegions: readonly TranslationRect[],
  geometry: TranslationGeometry,
  region: TranslationRect,
  copies: ReadonlyMap<Node, Node>,
): TranslationTextConstraints {
  const view = root.ownerDocument.defaultView;
  if (!view) throw new Error('Translation layout requires an attached document.');
  const labels: TranslationLabelBudget[] = [],
    rows: TranslationRowBudget[] = [];
  const columns: { source: Element; inlineSize: number }[] = [];
  const intrinsicLabels: { source: Element; minimum: number }[] = [];
  const nodes: Element[] = [];
  const childNodes = new Map<Node, Node[]>();
  for (const node of copies.keys()) {
    if (node instanceof Element) nodes.push(node);
    const parent = node.parentNode;
    if (!parent || !copies.has(parent)) continue;
    const siblings = childNodes.get(parent) ?? [];
    siblings.push(node);
    childNodes.set(parent, siblings);
  }
  // The map is bounded and excludes hidden/live branches. Every nested query must
  // use it too: a raw TreeWalker/querySelectorAll would escape through a flow root.
  function* descendants(parent: Node): Generator<Node> {
    const pending = [...(childNodes.get(parent) ?? [])].reverse();
    while (pending.length) {
      const node = pending.pop();
      if (!node) break;
      yield node;
      for (const child of [...(childNodes.get(node) ?? [])].reverse()) pending.push(child);
    }
  }
  const elements = (parent: Node) =>
    (childNodes.get(parent) ?? []).filter((node): node is Element => node instanceof Element);
  // An island can still need its external sibling's position (for example a
  // detached label beside an absolute icon); those are not descendant targets.
  const peers = (parent: Element) => (copies.has(parent) ? elements(parent) : [...parent.children]);
  const sourceTexts = new Map<Element, string>();
  const sourceText = (el: Element) => {
    let value = sourceTexts.get(el);
    if (value === undefined) {
      value = [...descendants(el)]
        .filter((node): node is Text => node instanceof Text)
        .map((node) => node.data)
        .join('');
      sourceTexts.set(el, value);
    }
    return value;
  };
  const text = (el: Element) => /[\p{L}\p{N}]/u.test(sourceText(el));
  const visible = (el: Element) => {
    const f = geometry.facts(el);
    return !f.hidden && f.clip?.kind !== 'hidden';
  };
  const lineCache = new Map<
    Element,
    { single: boolean; leading: number; preserved: boolean; top: number; bottom: number }
  >();
  const textLines = (el: Element) => {
    const known = lineCache.get(el);
    if (known !== undefined) return known;
    const rects: DOMRect[] = [];
    const zoom = geometry.facts(el).zoom;
    let leading = lineHeight(view.getComputedStyle(el));
    let preserved = false;
    for (const node of descendants(el)) {
      if (!(node instanceof Text) || !/\S/.test(node.data)) continue;
      let parent = node.parentElement;
      while (parent && parent !== el) {
        if (!visible(parent) || /^(absolute|fixed)$/.test(geometry.facts(parent).position)) break;
        parent = parent.parentElement;
      }
      if (parent !== el) continue;
      const owner = node.parentElement;
      if (owner) {
        const style = view.getComputedStyle(owner);
        preserved ||= /^(pre|pre-wrap|break-spaces)$/.test(style.whiteSpace);
        leading = Math.max(leading, (lineHeight(style) * geometry.facts(owner).zoom) / zoom);
      }
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(node);
      rects.push(...[...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0));
    }
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    const result = {
      leading,
      preserved,
      top,
      bottom,
      single:
        rects.length > 0 &&
        bottom - top <=
          // Font ink may exceed CSS line-height (including CJK fallback fonts).
          // A single glyph band is still one line; do not exclude an entire nav
          // from its shared width budget just because the line box is tight.
          Math.max(leading * zoom * 1.2, ...rects.map((r) => r.height)),
    };
    lineCache.set(el, result);
    return result;
  };
  const oneLine = (el: Element) => textLines(el).single;
  const growingLabels: {
    budget: TranslationLabelBudget;
    original: number;
    leading: number;
  }[] = [];

  for (const source of nodes) {
    if (!visible(source)) continue;
    const f = geometry.facts(source),
      s = view.getComputedStyle(source),
      r = f.box;
    const parent = source.parentElement;
    const ps = parent && view.getComputedStyle(parent);
    const contentHeight = Math.max(0, r.height / f.zoom - verticalInsets(s));
    const fixedHeight =
      !!declared(source, 'height') && declared(source, 'height') !== 'auto' && r.height > 0;
    const detached = source === root && !children;
    const intrinsicFloat =
      !detached && /^(left|right)$/.test(s.cssFloat) && declared(source, 'width') === 'auto';
    const adjacent =
      s.display === 'inline-block' &&
      parent &&
      peers(parent).some((peer) => {
        const p = geometry.facts(peer),
          b = p.box;
        return (
          peer !== source &&
          p.position === 'absolute' &&
          visible(peer) &&
          b.y < r.y + r.height &&
          b.y + b.height > r.y &&
          (b.x + b.width <= r.x || b.x >= r.x + r.width)
        );
      });
    const detachedRowLabel =
      detached &&
      ps?.display.includes('flex') &&
      /^(row|row-reverse)$/.test(ps.flexDirection) &&
      s.whiteSpace === 'nowrap' &&
      r.height / f.zoom <= lineHeight(s) * 3;
    // A one-line linked list adjacent to an independent native surface cannot grow
    // that surface. Ordinary linked paragraphs have no such compact contract.
    const linked = source.matches('li')
      ? [...descendants(source)].filter(
          (node): node is Element => node instanceof Element && node.matches('a[href]'),
        )
      : [];
    const independentRow =
      linked.length > 0 &&
      oneLine(source) &&
      !/[\p{L}\p{N}]/u.test(
        linked.reduce((value, link) => value.replace(sourceText(link), ''), sourceText(source)),
      ) &&
      protectedRegions.some((p) => p.y >= r.y && p.x < r.x + r.width && p.x + p.width > r.x);
    const fixedLabel =
      !intrinsicFloat &&
      (['block', 'list-item'].includes(s.display) ||
        (s.display === 'inline-block' &&
          (detached || s.textOverflow === 'ellipsis' || adjacent))) &&
      (fixedHeight || independentRow || adjacent || (s.display === 'inline-block' && detached)) &&
      contentHeight <= lineHeight(s) * 1.2 &&
      r.height > 0;
    const utility =
      parent &&
      source.childElementCount === 0 &&
      r.width / f.zoom <= 128 &&
      contentHeight <= lineHeight(s) * 1.2 &&
      (source.matches('button,[role="button"]') ||
        parent.matches('button,[role="button"]') ||
        (ps?.display.includes('flex') && ps.flexDirection === 'column'));
    const ellipsis =
      parseInt(s.webkitLineClamp) > 0 ||
      (s.textOverflow === 'ellipsis' && s.overflowX === 'hidden');
    // An atomic inline label can use its containing line's spare space. Its
    // fixed source width is a minimum, not a reason to wrap one word vertically.
    // Detached slots, native neighbors and explicit truncation still own bounds.
    if (
      !detached &&
      !adjacent &&
      !fixedLabel &&
      !ellipsis &&
      (s.display === 'inline-block' || intrinsicFloat) &&
      (/px$/.test(declared(source, 'width') ?? '') || intrinsicFloat) &&
      (s.whiteSpace === 'nowrap' || fixedHeight) &&
      contentHeight <= lineHeight(s) * 1.2 &&
      oneLine(source)
    )
      intrinsicLabels.push({ source, minimum: number(s.width) });
    const trackCell =
      s.display === 'list-item' &&
      fixedHeight &&
      ps?.position === 'absolute' &&
      parent?.parentElement &&
      /^(hidden|clip)$/.test(geometry.facts(parent.parentElement).overflowY);
    if (fixedLabel || utility || ellipsis || detachedRowLabel || trackCell) {
      const clamp = parseInt(s.webkitLineClamp) || 0;
      // A wrapper's font can be smaller than its caption. Budget complete text
      // lines, not the inherited wrapper line-height (which clips half a line).
      const leading = clamp > 0 ? textLines(source).leading : lineHeight(s);
      const boundary = protectedRegions.filter(
        (p) => p.y >= r.y + r.height && p.x < region.x + region.width && p.x + p.width > region.x,
      );
      const linesBeforeNative = Math.max(
        1,
        Math.floor(Math.min(...boundary.map((p) => (p.y - r.y) / f.zoom)) / leading),
      );
      const maximumHeight = /px$/.test(s.maxHeight)
        ? Math.max(0, number(s.maxHeight) - (s.boxSizing === 'border-box' ? verticalInsets(s) : 0))
        : Infinity;
      const fixedLines = Math.max(
        1,
        Math.floor(Math.min(fixedHeight ? contentHeight : Infinity, maximumHeight) / leading),
      );
      const lineLimit =
        clamp > 0
          ? Math.min(clamp, linesBeforeNative, fixedLines)
          : fixedLabel || utility || detachedRowLabel
            ? 1
            : Math.max(1, Math.round(contentHeight / lineHeight(s)));
      const budget: TranslationLabelBudget = {
        source,
        complete: !!utility,
        inlineSize: Math.max(0, r.width / f.zoom - horizontalInsets(s)),
        lineLimit,
        blockSize: clamp > 0 ? lineLimit * leading : contentHeight,
        insets: horizontalInsets(s),
        borderBox: s.boxSizing === 'border-box',
        formatting:
          parseInt(s.webkitLineClamp) > 0 || (trackCell && contentHeight > lineHeight(s) * 1.2)
            ? 'clamp'
            : s.display.includes('flex')
              ? 'flex'
              : s.display === 'inline-block' && s.textOverflow === 'ellipsis'
                ? 'atomic'
                : 'inline',
        reason: ellipsis
          ? 'source-ellipsis'
          : detachedRowLabel || adjacent || independentRow
            ? 'independent-neighbor'
            : 'fixed-cell',
      };
      labels.push(budget);
      let inFlow = true;
      for (let el: Element | null = source; el; el = el.parentElement) {
        if (/^(absolute|fixed)$/.test(geometry.facts(el).position)) inFlow = false;
        if (el === root) break;
      }
      if (clamp > 0 && inFlow)
        growingLabels.push({
          budget,
          original: Math.max(1, Math.round(contentHeight / leading)),
          leading,
        });
    }

    if (
      !source.matches('a,li') &&
      source.childElementCount >= 2 &&
      parent &&
      /^(left|right)$/.test(s.cssFloat) &&
      peers(parent).some(
        (peer) =>
          peer !== source &&
          /^(left|right)$/.test(view.getComputedStyle(peer).cssFloat) &&
          Math.abs(geometry.facts(peer).box.y - r.y) < 0.5,
      )
    ) {
      let inlineSize: number | undefined =
        declared(source, 'width') === 'auto' ? undefined : number(s.width);
      // An auto-sized float may use the vacant space before a fixed neighbor.
      // Freezing its Chinese used width needlessly truncates translated labels;
      // two intrinsic columns must not both claim the same vacant space.
      if (declared(source, 'width') === 'auto') {
        const left = s.cssFloat === 'left';
        const neighbor = peers(parent)
          .filter((peer) => {
            const b = geometry.facts(peer).box;
            return (
              peer !== source &&
              visible(peer) &&
              b.width > 0 &&
              b.y < r.y + r.height &&
              b.y + b.height > r.y &&
              (left ? b.x >= r.x + r.width : b.x + b.width <= r.x)
            );
          })
          .sort((a, b) => {
            const ar = geometry.facts(a).box,
              br = geometry.facts(b).box;
            return left ? ar.x - br.x : br.x + br.width - ar.x - ar.width;
          })[0];
        if (neighbor && /px$/.test(declared(neighbor, 'width') ?? '')) {
          const b = geometry.facts(neighbor).box;
          const ns = view.getComputedStyle(neighbor);
          const gap = Math.max(
            number(s.fontSize) / 2,
            number(left ? s.marginRight : s.marginLeft),
            number(left ? ns.marginLeft : ns.marginRight),
          );
          const space = (left ? b.x - r.x : r.x + r.width - b.x - b.width) / f.zoom;
          const original = number(s.width);
          inlineSize = Math.max(original, space - gap - (r.width / f.zoom - original));
        }
      }
      // With two intrinsic floats, CSS already shares the remaining space. Freezing
      // either to its Chinese used width wraps a short English label unnecessarily.
      if (inlineSize !== undefined) columns.push({ source, inlineSize });
    }

    if (source.scrollWidth > source.clientWidth + 1) continue;
    const all = elements(source).filter(visible);
    const clipped = /^(hidden|clip)$/.test(f.overflowY) && contentHeight <= lineHeight(s) * 1.2;
    const boundedWrap =
      clipped &&
      (fixedHeight ||
        (/px$/.test(s.maxHeight) &&
          number(s.maxHeight) - (s.boxSizing === 'border-box' ? verticalInsets(s) : 0) <=
            lineHeight(s) * 1.2));
    const items = all.filter((el) => {
      const b = geometry.facts(el).box;
      return !clipped || (b.y >= r.y - 0.5 && b.y + b.height <= r.y + r.height + 0.5);
    });
    const firstItem = items[0];
    if (!firstItem || items.length < 2) continue;
    // A photo plus its caption is not a compact label, even when its only text
    // occupies one line. Retain the card's native dimensions/margins rather than
    // redistributing its image as navigation text. Small inline icons may share a row.
    if (
      items.some((item) =>
        [item, ...descendants(item)].some((graphic) => {
          if (
            !(graphic instanceof Element) ||
            !graphic.matches('img,svg,object') ||
            !visible(graphic)
          )
            return false;
          const facts = geometry.facts(graphic);
          return facts.box.width / facts.zoom > 48 || facts.box.height / facts.zoom > 48;
        }),
      )
    )
      continue;
    const noLooseText = !(childNodes.get(source) ?? []).some(
      (n) => n instanceof Text && /\S/.test(n.data),
    );
    const compactFlex =
      s.display.includes('flex') &&
      /^(row|row-reverse)$/.test(s.flexDirection) &&
      // An auto-growing tag group owns several lines. A clipped, explicitly
      // one-line container does not: wrapping would hide later translated links.
      (s.flexWrap === 'nowrap' || boundedWrap) &&
      r.height / f.zoom <= lineHeight(s) * 3 &&
      // A numbered paragraph can happen to occupy one source line. Its
      // preserved whitespace is a prose contract, not compact navigation.
      items.every((el) => !text(el) || (oneLine(el) && !textLines(el).preserved));
    const inline =
      /^(block|inline-block)$/.test(s.display) &&
      noLooseText &&
      items.every((el) => {
        const cs = view.getComputedStyle(el),
          b = geometry.facts(el).box;
        const band = textLines(el);
        // Borders or inline alignment can extend outside a tight source line.
        // Its contained one-line text still shares the navigation's inline space.
        const contained =
          (b.y >= r.y - 1 && b.y + b.height <= r.y + r.height + 1) ||
          (band.single && band.top >= r.y - 1 && band.bottom <= r.y + r.height + 1);
        return (
          cs.display === 'inline-block' &&
          /^(static|relative)$/.test(cs.position) &&
          contained &&
          (s.whiteSpace === 'nowrap' ||
            (Math.abs(b.y - geometry.facts(firstItem).box.y) < 0.5 && oneLine(el)))
        );
      });
    const float = view.getComputedStyle(firstItem).cssFloat;
    const floated =
      s.direction === 'ltr' &&
      /^(left|right)$/.test(float) &&
      noLooseText &&
      items.every((el, index) => {
        const cs = view.getComputedStyle(el),
          b = geometry.facts(el).box;
        const previous = items[index - 1];
        const prev = previous && geometry.facts(previous).box;
        return (
          cs.cssFloat === float &&
          /^(static|relative)$/.test(cs.position) &&
          oneLine(el) &&
          b.y >= r.y - 0.5 &&
          b.y + b.height <= r.y + r.height + 0.5 &&
          (!prev ||
            (Math.abs(b.y - prev.y) < 0.5 &&
              (float === 'right' ? b.x + b.width <= prev.x : b.x >= prev.x + prev.width)))
        );
      });
    if (!compactFlex && !inline && !floated) continue;
    if (floated && !compactFlex && !inline) {
      // Floats alone do not promise a single line. Preserve natural wrapping
      // unless this row or an in-island ancestor actually bounds its height.
      let bounded = false;
      for (let el: Element | null = source; el; el = el.parentElement) {
        const style = view.getComputedStyle(el);
        bounded ||=
          style.whiteSpace === 'nowrap' ||
          (/px$/.test(declared(el, 'height') ?? '') && number(style.height) > 0) ||
          /px$/.test(style.maxHeight) ||
          /^(hidden|clip)$/.test(style.overflowY);
        if (el === root) break;
      }
      if (!bounded) continue;
    }
    rows.push({
      source,
      cells: items.map((el) => ({
        source: el,
        width: geometry.facts(el).box.width / f.zoom,
        minimum: /px$/.test(declared(el, 'width') ?? '')
          ? number(view.getComputedStyle(el).width)
          : 0,
        decoration: !text(el),
      })),
      direction:
        (floated && float === 'right') || s.flexDirection === 'row-reverse' ? 'row-reverse' : 'row',
      gap: number(s.fontSize) / 2,
      convert: inline || floated,
      inline: s.display === 'inline-block',
      hidden: clipped ? all.filter((el) => !items.includes(el)) : [],
    });
  }
  // Clamps in a detached compact section share the space before the next
  // independent flow. Their individual allowances must not collectively push
  // the whole section over that flow. Keep its source line counts when bounded;
  // unbounded prose and absolutely positioned photo captions still reflow.
  const gap = Math.min(
    ...protectedRegions
      .filter(
        (p) =>
          p.y >= region.y + region.height &&
          p.x < region.x + region.width &&
          p.x + p.width > region.x,
      )
      .map((p) => p.y - region.y - region.height),
  );
  const growth = growingLabels.reduce(
    (sum, { budget, original, leading }) =>
      sum + Math.max(0, budget.lineLimit - original) * leading * geometry.facts(budget.source).zoom,
    0,
  );
  if (growth > gap)
    for (const { budget, original, leading } of growingLabels) {
      budget.lineLimit = Math.min(budget.lineLimit, original);
      budget.blockSize = budget.lineLimit * leading;
    }
  return { labels, intrinsicLabels, rows, columns };
}

/** Only translated label paths are ellipsized; icons and badges keep their own paint. */
function constrainLabel(
  cell: HTMLElement,
  translated: readonly HTMLElement[],
  flex: boolean,
  allocated?: Set<HTMLElement>,
  sharedRow = false,
) {
  if (!flex)
    Object.assign(cell.style, {
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    });
  for (const span of translated) {
    if (!cell.contains(span)) continue;
    // Marker copies retain their own computed styles. Their explicit `normal`
    // must not override the enclosing single-line contract and create hidden
    // extra lines (or make the entire island fail collision validation).
    for (const inline of span.querySelectorAll<HTMLElement>('*'))
      inline.style.whiteSpace = 'nowrap';
    for (let el: HTMLElement | null = span; el && el !== cell; el = el.parentElement) {
      allocated?.add(el);
      // A sole label wrapper may carry the item's outer spacing. The shared
      // row already owns that gap; do not charge it again inside each label.
      // Sibling icons/text and negative positioning margins remain source-owned.
      if (
        sharedRow &&
        el.parentElement?.childElementCount === 1 &&
        el.parentElement.textContent?.trim() === el.textContent?.trim()
      ) {
        const parentStyle = el.parentElement.style;
        if (
          ![parentStyle.backgroundImage, parentStyle.maskImage].some(
            (value) => value && value !== 'none',
          )
        ) {
          if (number(el.style.marginLeft) > 0) el.style.marginLeft = '0';
          if (number(el.style.marginRight) > 0) el.style.marginRight = '0';
        }
        // Ellipsis gives an inline-block a bottom-edge baseline. With a sole
        // label, align its box directly instead of adding an anonymous descent.
        if (el.style.display === 'inline-block') el.style.verticalAlign = 'top';
      }
      Object.assign(el.style, { minWidth: '0', flexShrink: '1' });
      if (!el.style.maxWidth || el.style.maxWidth === 'none') el.style.maxWidth = '100%';
      if (flex && (el === span || el.style.display === 'inline'))
        Object.assign(el.style, {
          display: 'block',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        });
      else if (!flex) {
        el.style.whiteSpace = 'nowrap';
        if (/^(block|flow-root)$/.test(el.style.display))
          Object.assign(el.style, {
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          });
        if (el !== span && el.style.display === 'inline-block') {
          if (/px$/.test(el.style.maxWidth)) el.style.maxWidth = `min(${el.style.maxWidth}, 100%)`;
          Object.assign(el.style, {
            boxSizing: 'border-box',
            width: 'max-content',
            minWidth: '0',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          });
        }
      }
    }
  }
}

export function applyTranslationTextConstraints(
  plan: TranslationTextConstraints,
  copies: ReadonlyMap<Node, Node>,
  translated: readonly HTMLElement[],
): ReadonlySet<HTMLElement> {
  const allocated = new Set<HTMLElement>();
  for (const { source, minimum } of plan.intrinsicLabels) {
    const copy = copies.get(source);
    if (!(copy instanceof HTMLElement) || !translated.some((span) => copy.contains(span))) continue;
    Object.assign(copy.style, {
      width: 'max-content',
      minWidth: `${minimum}px`,
      whiteSpace: 'nowrap',
    });
  }
  for (const { source, inlineSize } of plan.columns) {
    const copy = copies.get(source);
    if (copy instanceof HTMLElement) copy.style.width = `${inlineSize}px`;
  }
  for (const row of plan.rows) {
    const copy = copies.get(row.source);
    // Only changed text needs an adaptive budget. Static graphic-only subrows
    // (including deliberately overlapping icons) must retain their source layout.
    if (!(copy instanceof HTMLElement) || !translated.some((span) => copy.contains(span))) continue;
    const cells = row.cells
      .map((cell) => ({ ...cell, copy: copies.get(cell.source) }))
      .filter((cell): cell is RowCell & { copy: HTMLElement } => cell.copy instanceof HTMLElement);
    if (cells.length !== row.cells.length) continue;
    // A copied row owns its shared inline space. Its children's original Chinese
    // widths are not independent slots, even when a fixed height keeps one line.
    for (const cell of cells) allocated.add(cell.copy);
    const needsBudget =
      copy.scrollWidth > copy.clientWidth + 1 ||
      cells.some((cell, index) => {
        const b = cell.copy.getBoundingClientRect(),
          previous = cells[index - 1];
        const prev = previous?.copy.getBoundingClientRect();
        return (
          cell.copy.scrollWidth > cell.copy.clientWidth + 1 ||
          cell.copy.scrollHeight > cell.copy.clientHeight + 1 ||
          (prev &&
            ((row.convert && Math.abs(b.top - prev.top) > 0.5) ||
              (row.direction === 'row' ? b.left - prev.right : prev.left - b.right) <
                row.gap - 0.5))
        );
      });
    if (!needsBudget) continue;
    for (const hidden of row.hidden) {
      const el = copies.get(hidden);
      if (el instanceof HTMLElement) el.style.display = 'none';
    }
    copy.style.columnGap = `${row.gap}px`;
    if (row.convert)
      Object.assign(copy.style, {
        display: row.inline ? 'inline-flex' : 'flex',
        flexDirection: row.direction,
        flexWrap: 'nowrap',
        alignItems: 'center',
      });
    for (const cell of cells) {
      Object.assign(cell.copy.style, {
        marginLeft: '0',
        marginRight: '0',
        minWidth: '0',
        flexShrink: '1',
        // Distribute the shared space, capping each cell at its intrinsic need.
        // Proportional shrink of auto bases also truncates short labels when a
        // few long translations dominate the row's preferred width.
        flexBasis: '0px',
        flexGrow: '1',
      });
      if (row.convert)
        Object.assign(cell.copy.style, {
          float: 'none',
          width: 'max-content',
          minWidth: `${cell.minimum}px`,
        });
      if (cell.decoration || !translated.some((span) => cell.copy.contains(span))) {
        // Original labels are not spare space for their translated neighbors.
        // This also applies after fallback, inside nested shared rows.
        const insets =
          cell.copy.style.boxSizing === 'border-box' ? 0 : horizontalInsets(cell.copy.style);
        Object.assign(cell.copy.style, {
          width: `${Math.max(0, cell.width - insets)}px`,
          flex: '0 0 auto',
        });
        continue;
      }
      // A text-free background/icon has no intrinsic text width. Its measured
      // graphic width above must not be capped to an empty max-content box.
      if (!cell.copy.style.maxWidth || cell.copy.style.maxWidth === 'none')
        cell.copy.style.maxWidth = 'max-content';
      allocated.add(cell.copy);
      constrainLabel(
        cell.copy,
        translated,
        cell.copy.style.display.includes('flex'),
        allocated,
        true,
      );
    }
  }
  for (const budget of plan.labels) {
    const copy = copies.get(budget.source);
    if (
      !(copy instanceof HTMLElement) ||
      allocated.has(copy) ||
      !translated.some((span) => copy.contains(span))
    )
      continue;
    if (budget.formatting !== 'clamp' && budget.lineLimit === 1) {
      const width = budget.inlineSize + (budget.borderBox ? budget.insets : 0);
      // Keep relative limits in CSS; parseFloat would turn 100% into 100px.
      // Intrinsic keywords are already accounted for by the measured source budget.
      const maximum = `min(${width}px, ${copy.style.maxWidth})`;
      Object.assign(copy.style, {
        minWidth: '0',
        maxWidth: CSS.supports('max-width', maximum) ? maximum : `${width}px`,
      });
      constrainLabel(
        copy,
        translated,
        budget.formatting === 'flex',
        budget.formatting === 'atomic' ? allocated : undefined,
      );
    } else if (budget.blockSize > 0) {
      // Keep the source's multi-line clamp/height; never synthesize a single-line
      // contract for prose simply because it includes a hyperlink.
      const s = copy.style;
      s.maxHeight = `${budget.blockSize + (budget.borderBox ? verticalInsets(s) : 0)}px`;
      s.overflow = 'hidden';
      if (parseInt(s.webkitLineClamp) > 0) s.webkitLineClamp = String(budget.lineLimit);
    }
  }
  // Decide only after shared row allocation. A button with spare inline space can
  // still translate; a label beside a native input/icon must not shrink its font
  // or change orientation just to fit. Use fractional painted geometry, not the
  // integer clientWidth/scrollWidth, and ignore the external lens clipping.
  const incomplete = new Set<HTMLElement>();
  const bounded = new Map<Element, { complete: boolean; lineLimit: number }>(
    plan.rows.flatMap((row) =>
      row.cells.map(({ source }) => [source, { complete: false, lineLimit: 1 }] as const),
    ),
  );
  for (const label of plan.labels) bounded.set(label.source, label);
  for (const [source, { complete, lineLimit }] of bounded) {
    const copy = copies.get(source);
    if (!(copy instanceof HTMLElement)) continue;
    const box = copy.getBoundingClientRect();
    // Tiny bounded readouts have the same failure as action labels: an ellipsis
    // in less than three em leaves at most a few glyphs. Ordinary longer title
    // cells keep their native ellipsis contract, independent of the page/site.
    if (
      !complete &&
      (lineLimit !== 1 ||
        box.width >= 3 * number(getComputedStyle(copy).fontSize) * (copy.currentCSSZoom || 1))
    )
      continue;
    for (const span of translated) {
      if (!copy.contains(span)) continue;
      const range = span.ownerDocument.createRange();
      range.selectNodeContents(span);
      const ink = range.getBoundingClientRect();
      if (ink.left < box.left - 0.5 || ink.right > box.right + 0.5) incomplete.add(span);
    }
  }
  return incomplete;
}
