import type { PageTextSelection, SelectionBubblePosition, SelectionRect } from './selection-types';

const MAX_SELECTION_LENGTH = 8_000;
const BUBBLE_MARGIN = 8;
const BUBBLE_GAP = 8;

/** Trims one selected string and returns only its bounded safe prefix. */
export function normalizeSelectionText(value: string): string | null {
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  return normalized.slice(0, MAX_SELECTION_LENGTH);
}

/** Selects the first finite visible line rectangle from a potentially multiline DOM range. */
export function pickSelectionRect(rectangles: Iterable<Partial<DOMRect>>): SelectionRect | null {
  for (const rectangle of rectangles) {
    const { left, top, right, bottom, width, height } = rectangle;
    const values = [left, top, right, bottom, width, height];
    if (
      values.every((value) => typeof value === 'number' && Number.isFinite(value)) &&
      typeof left === 'number' &&
      typeof top === 'number' &&
      typeof right === 'number' &&
      typeof bottom === 'number' &&
      typeof width === 'number' &&
      typeof height === 'number' &&
      width > 0 &&
      height > 0
    ) {
      return { left, top, right, bottom, width, height };
    }
  }
  return null;
}

/** Places a fixed selection bubble inside the viewport and flips below near its top edge. */
export function computeBubblePosition(
  selection: SelectionRect,
  viewport: { readonly width: number; readonly height: number },
  bubble: { readonly width: number; readonly height: number },
): SelectionBubblePosition {
  const maximumLeft = Math.max(BUBBLE_MARGIN, viewport.width - bubble.width - BUBBLE_MARGIN);
  const centeredLeft = selection.left + selection.width / 2 - bubble.width / 2;
  const left = Math.round(Math.min(maximumLeft, Math.max(BUBBLE_MARGIN, centeredLeft)));
  const fitsAbove = selection.top - BUBBLE_GAP - bubble.height >= BUBBLE_MARGIN;
  const desiredTop = fitsAbove
    ? selection.top - BUBBLE_GAP - bubble.height
    : selection.bottom + BUBBLE_GAP;
  const maximumTop = Math.max(BUBBLE_MARGIN, viewport.height - bubble.height - BUBBLE_MARGIN);
  return {
    left,
    top: Math.round(Math.min(maximumTop, Math.max(BUBBLE_MARGIN, desiredTop))),
    placement: fitsAbove ? 'above' : 'below',
  };
}

/** Resolves the element that owns a range container without assuming it is itself an Element. */
function rangeOwner(container: Node): Element | null {
  return container instanceof Element ? container : container.parentElement;
}

/** Rejects selections originating from secrets, editable surfaces, or extension-owned overlays. */
function isExcludedOwner(owner: Element | null): boolean {
  if (owner === null) return true;
  const password = owner.closest('input[type="password"]');
  if (password !== null) return true;
  if (owner.closest('[data-chatbrowserx-overlay]') !== null) return true;
  for (let current: Element | null = owner; current !== null; current = current.parentElement) {
    if (current instanceof HTMLElement && current.isContentEditable) return true;
    const editable = current.getAttribute('contenteditable');
    if (editable !== null && editable.toLowerCase() !== 'false') return true;
  }
  return false;
}

/** Reads one eligible browser selection without copying surrounding DOM or page markup. */
export function readPageSelection(document: Document, view: Window): PageTextSelection | null {
  const selection = view.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const text = normalizeSelectionText(selection.toString());
  if (text === null) return null;
  const range = selection.getRangeAt(0);
  if (isExcludedOwner(rangeOwner(range.commonAncestorContainer))) return null;
  const rect = pickSelectionRect(range.getClientRects());
  if (rect === null) return null;
  return {
    text,
    rect,
    pageUrl: document.location.href.slice(0, 4_096),
    pageTitle: document.title.slice(0, 500),
  };
}
