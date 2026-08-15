import type { ScreenshotDrag, ScreenshotRect, ScreenshotViewport } from './screenshot-types';

export const MINIMUM_SCREENSHOT_SELECTION_PX = 8;

/** Clamps one finite pointer coordinate to the live viewport axis. */
function clamp(value: number, maximum: number): number {
  const normalized = Number.isFinite(value) ? value : 0;
  return Math.min(Math.max(0, maximum), Math.max(0, normalized));
}

/** Normalizes any drag direction into a viewport-clamped CSS-pixel rectangle. */
export function normalizeSelection(
  drag: ScreenshotDrag,
  viewport: ScreenshotViewport,
): ScreenshotRect {
  const startX = clamp(drag.startX, viewport.width);
  const endX = clamp(drag.endX, viewport.width);
  const startY = clamp(drag.startY, viewport.height);
  const endY = clamp(drag.endY, viewport.height);
  return {
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  };
}

/** Reports whether a normalized region is large enough to capture intentionally. */
export function isUsableSelection(rect: ScreenshotRect): boolean {
  return (
    rect.width >= MINIMUM_SCREENSHOT_SELECTION_PX && rect.height >= MINIMUM_SCREENSHOT_SELECTION_PX
  );
}
