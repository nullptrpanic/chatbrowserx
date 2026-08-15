import { useEffect, useMemo, useRef, useState } from 'react';
import { isUsableSelection, normalizeSelection } from './selection-geometry';
import type { ScreenshotDrag, ScreenshotRect, ScreenshotSelection } from './screenshot-types';

export interface ScreenshotOverlayProps {
  readonly view: Window;
  readonly onComplete: (selection: ScreenshotSelection) => void;
  readonly onCancel: () => void;
}

/** Converts the current rectangle and viewport into the bounded capture payload. */
function toSelection(rect: ScreenshotRect, view: Window): ScreenshotSelection {
  return {
    rect,
    devicePixelRatio: Math.max(1, view.devicePixelRatio || 1),
    viewportWidth: view.innerWidth,
    viewportHeight: view.innerHeight,
  };
}

/** Renders the transient full-viewport region selector inside an isolated Shadow Root. */
export function ScreenshotOverlay({ view, onComplete, onCancel }: ScreenshotOverlayProps) {
  const drag = useRef<ScreenshotDrag | null>(null);
  const [rect, setRect] = useState<ScreenshotRect | null>(null);
  const viewport = useMemo(
    () => ({ width: view.innerWidth, height: view.innerHeight }),
    [view, view.innerHeight, view.innerWidth],
  );

  useEffect(() => {
    /** Cancels selection through the standard keyboard escape gesture. */
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onCancel();
    }
    /** Invalidates stale geometry when the host viewport changes. */
    function handleResize(): void {
      drag.current = null;
      setRect(null);
    }
    view.addEventListener('keydown', handleKeyDown, true);
    view.addEventListener('resize', handleResize);
    return () => {
      view.removeEventListener('keydown', handleKeyDown, true);
      view.removeEventListener('resize', handleResize);
    };
  }, [onCancel, view]);

  /** Starts an owned pointer drag on the translucent selection surface. */
  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      startX: event.clientX,
      startY: event.clientY,
      endX: event.clientX,
      endY: event.clientY,
    };
    setRect(normalizeSelection(drag.current, viewport));
  }

  /** Updates the normalized selection while the owned pointer remains captured. */
  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    if (drag.current === null) return;
    drag.current = { ...drag.current, endX: event.clientX, endY: event.clientY };
    setRect(normalizeSelection(drag.current, viewport));
  }

  /** Finishes pointer capture while leaving the rectangle available for confirmation. */
  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    if (drag.current === null) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = { ...drag.current, endX: event.clientX, endY: event.clientY };
    const next = normalizeSelection(drag.current, viewport);
    setRect(isUsableSelection(next) ? next : null);
    drag.current = null;
  }

  return (
    <div
      className="cbx-shot-surface"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <style>{`
        :host { all: initial; }
        * { box-sizing: border-box; }
        .cbx-shot-surface { position: fixed; inset: 0; cursor: crosshair; background: rgba(12, 18, 30, .34); color: #f8fafc; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; user-select: none; }
        .cbx-shot-selection { position: absolute; border: 2px solid #70a5ff; background: rgba(91, 145, 255, .12); box-shadow: 0 0 0 9999px rgba(7, 12, 22, .16); pointer-events: none; }
        .cbx-shot-controls { position: fixed; top: 16px; left: 50%; display: flex; gap: 6px; padding: 6px; transform: translateX(-50%); border: 1px solid rgba(255,255,255,.16); border-radius: 12px; background: #171c27; box-shadow: 0 10px 30px rgba(0,0,0,.25); cursor: default; }
        button { min-height: 32px; padding: 0 11px; border: 0; border-radius: 8px; color: #e8edf8; background: #293142; font: inherit; cursor: pointer; }
        button:hover { background: #354158; }
        button:focus-visible { outline: 2px solid #8bb4ff; outline-offset: 2px; }
        button[data-primary="true"] { color: #fff; background: #346ee8; }
        button:disabled { opacity: .45; cursor: not-allowed; }
      `}</style>
      {rect === null ? null : (
        <div
          className="cbx-shot-selection"
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        />
      )}
      <div className="cbx-shot-controls" role="toolbar" aria-label="截图工具">
        <button
          type="button"
          onClick={() => {
            const full = { x: 0, y: 0, width: view.innerWidth, height: view.innerHeight };
            setRect(full);
          }}
        >
          当前视口
        </button>
        <button
          type="button"
          data-primary="true"
          disabled={rect === null || !isUsableSelection(rect)}
          onClick={() => {
            if (rect !== null && isUsableSelection(rect)) onComplete(toSelection(rect, view));
          }}
        >
          完成
        </button>
        <button type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
