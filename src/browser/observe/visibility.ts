import type { Rect, ViewportState } from '../contracts/observation';

/**
 * Converts a live DOM rectangle into the serializable bounded geometry contract.
 */
export function toRect(rect: DOMRect): Rect {
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/**
 * Returns the composed parent across ordinary DOM and open Shadow Root boundaries.
 */
function getComposedParent(element: Element): Element | null {
  if (element.parentElement !== null) {
    return element.parentElement;
  }
  const root = element.getRootNode();
  return root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in root
    ? (root as ShadowRoot).host
    : null;
}

/**
 * Checks rendered style, box geometry, and viewport intersection without changing page state.
 */
export function isElementVisible(element: Element, viewport: ViewportState): boolean {
  let current: Element | null = element;
  while (current !== null) {
    if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') {
      return false;
    }
    const view = current.ownerDocument.defaultView;
    const style = view?.getComputedStyle(current);
    if (
      style !== undefined &&
      (style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.opacity === '0')
    ) {
      return false;
    }
    current = getComposedParent(current);
  }

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || element.getClientRects().length === 0) {
    return false;
  }

  return (
    rect.right > 0 && rect.bottom > 0 && rect.left < viewport.width && rect.top < viewport.height
  );
}

/**
 * Checks the center hit-test while treating unsupported hit testing as inconclusive, not blocked.
 */
export function isElementObscured(element: Element, rect: Rect): boolean {
  const document = element.ownerDocument;
  if (typeof document.elementFromPoint !== 'function') {
    return false;
  }

  const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  if (hit === null) {
    return false;
  }
  return hit !== element && !element.contains(hit) && !hit.contains(element);
}
