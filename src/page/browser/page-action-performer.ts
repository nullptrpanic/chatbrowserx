import type { PageCommand } from '../../shared/protocol/message-types';
import { showVirtualPointer } from './mount-virtual-pointer';

type PageAction = Extract<PageCommand, { readonly type: 'page.action.perform' }>['payload'];
export interface PageActionResult {
  readonly action: 'scroll';
  readonly applied: boolean;
  readonly url: string;
  readonly reason?: 'scroll_target_not_found';
  readonly moved: boolean;
  readonly actualDeltaX: number;
  readonly actualDeltaY: number;
}

function viewportTarget(document_: Document, deltaX: number, deltaY: number): Element | null {
  const root = document_.scrollingElement;
  if (!root) return null;
  const canMoveX = deltaX !== 0 && root.scrollWidth > root.clientWidth;
  const canMoveY = deltaY !== 0 && root.scrollHeight > root.clientHeight;
  return canMoveX || canMoveY ? root : null;
}

function pageUrl(document_: Document): string {
  return document_.location.href.slice(0, 4_096);
}

async function showElementPointer(
  element: Element,
  effect: 'move' | 'click',
  document_: Document,
  window_: Window,
): Promise<void> {
  const bounds = element.getBoundingClientRect();
  const point = {
    x: Math.max(0, bounds.x + bounds.width / 2),
    y: Math.max(0, bounds.y + bounds.height / 2),
  };
  await showVirtualPointer(
    { ...point, fromX: point.x, fromY: point.y, effect },
    document_,
    window_,
  ).catch(() => undefined);
}

function scrollElement(element: Element, deltaX: number, deltaY: number): void {
  if ('scrollBy' in element && typeof element.scrollBy === 'function') {
    element.scrollBy({ left: deltaX, top: deltaY, behavior: 'auto' });
    return;
  }
  element.scrollLeft += deltaX;
  element.scrollTop += deltaY;
}

/** Scrolls the document viewport and reports measured movement. Element actions use CDP. */
export async function performPageAction(
  action: PageAction,
  document_: Document,
  window_: Window,
): Promise<PageActionResult> {
  const url = pageUrl(document_);
  const target = viewportTarget(document_, action.deltaX, action.deltaY);
  if (!target) {
    return {
      action: 'scroll',
      applied: false,
      moved: false,
      actualDeltaX: 0,
      actualDeltaY: 0,
      url,
      reason: 'scroll_target_not_found',
    };
  }

  await showElementPointer(target, 'move', document_, window_);
  const beforeX = target.scrollLeft;
  const beforeY = target.scrollTop;
  scrollElement(target, action.deltaX, action.deltaY);
  const actualDeltaX = target.scrollLeft - beforeX;
  const actualDeltaY = target.scrollTop - beforeY;
  return {
    action: 'scroll',
    applied: true,
    moved: actualDeltaX !== 0 || actualDeltaY !== 0,
    actualDeltaX,
    actualDeltaY,
    url,
  };
}
