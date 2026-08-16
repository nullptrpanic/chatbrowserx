import type { PageActionFeedback } from "../../shared/protocol/message-types";
import { registerPageOverlayHost } from "../page-overlay-registry";

export interface ActionFeedbackOverlay {
  show(feedback: PageActionFeedback): void;
  hide(): void;
  dispose(): void;
}

export interface MountActionFeedbackOverlayOptions {
  readonly document?: Document;
  readonly view?: Window;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

const mountedOverlays = new WeakMap<Document, ActionFeedbackOverlay>();

function clampCoordinate(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, value), Math.max(0, maximum - 1));
}

function clampPoint(x: number, y: number, view: Window): Point {
  return {
    x: clampCoordinate(x, view.innerWidth),
    y: clampCoordinate(y, view.innerHeight),
  };
}

/** Returns the feedback controller mounted in a document, when present. */
export function getActionFeedbackOverlay(
  document: Document,
): ActionFeedbackOverlay | undefined {
  return mountedOverlays.get(document);
}

/** Mounts one isolated, pointer-transparent Agent action overlay for a document. */
export function mountActionFeedbackOverlay(
  options: MountActionFeedbackOverlayOptions = {},
): ActionFeedbackOverlay {
  const document = options.document ?? globalThis.document;
  const view = options.view ?? globalThis.window;
  const existing = mountedOverlays.get(document);
  if (existing !== undefined) return existing;

  const reducedMotion =
    typeof view.matchMedia === "function" &&
    view.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const host = document.createElement("div");
  host.dataset.chatbrowserxOverlay = "action-feedback";
  host.setAttribute("aria-hidden", "true");
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.zIndex = "2147483645";
  host.style.pointerEvents = "none";

  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .cbx-agent-layer {
      position: fixed;
      inset: 0;
      overflow: hidden;
      pointer-events: none;
    }
    .cbx-agent-cursor {
      position: absolute;
      left: 0;
      top: 0;
      width: 18px;
      height: 22px;
      opacity: 0;
      transform: translate3d(0, 0, 0);
      transform-origin: 0 0;
      transition-property: transform, opacity;
      transition-duration: 140ms, 120ms;
      transition-timing-function: cubic-bezier(.2, .8, .2, 1), ease-out;
      will-change: transform, opacity;
    }
    .cbx-agent-cursor.is-visible { opacity: 1; }
    .cbx-agent-cursor.is-dragging { transform-origin: 1px 1px; }
    .cbx-agent-cursor.is-dragging svg { transform: scale(.9); }
    .cbx-agent-cursor.is-dragging::after {
      content: '';
      position: absolute;
      left: -4px;
      top: -4px;
      width: 8px;
      height: 8px;
      border: 2px solid rgba(255, 255, 255, .92);
      border-radius: 999px;
      background: #2563eb;
      box-shadow: 0 1px 4px rgba(15, 23, 42, .32);
    }
    .cbx-agent-cursor svg {
      display: block;
      width: 18px;
      height: 22px;
      filter: drop-shadow(0 2px 3px rgba(15, 23, 42, .28));
      transition: transform 100ms ease-out;
    }
    .cbx-agent-ripple {
      position: absolute;
      width: 8px;
      height: 8px;
      margin: -4px 0 0 -4px;
      box-sizing: border-box;
      border: 2px solid rgba(37, 99, 235, .9);
      border-radius: 999px;
      background: rgba(96, 165, 250, .2);
      animation: cbx-agent-ripple 420ms cubic-bezier(.16, 1, .3, 1) forwards;
    }
    @keyframes cbx-agent-ripple {
      from { opacity: .95; transform: scale(1); }
      to { opacity: 0; transform: scale(4.25); }
    }
  `;

  const layer = document.createElement("div");
  layer.className = "cbx-agent-layer";
  const cursor = document.createElement("div");
  cursor.className = "cbx-agent-cursor";
  cursor.innerHTML = `
    <svg viewBox="0 0 22 27" aria-hidden="true">
      <path d="M2 1.5v20.3l5.1-4.7 3.8 8.1 3.7-1.8-3.8-7.8h7.4L2 1.5Z"
        fill="#fff" stroke="#2563eb" stroke-width="1.8" stroke-linejoin="round" />
    </svg>
  `;
  layer.append(cursor);
  shadow.append(style, layer);
  document.documentElement.append(host);
  const unregisterOverlay = registerPageOverlayHost(host);
  const timers = new Set<number>();
  let disposed = false;
  let positioned = false;

  function schedule(callback: () => void, delay: number): void {
    const timer = view.setTimeout(() => {
      timers.delete(timer);
      if (!disposed) callback();
    }, delay);
    timers.add(timer);
  }

  function clearEffects(): void {
    for (const timer of timers) view.clearTimeout(timer);
    timers.clear();
    for (const ripple of shadow.querySelectorAll(".cbx-agent-ripple"))
      ripple.remove();
    cursor.classList.remove("is-dragging");
  }

  function moveCursor(point: Point, duration: number): void {
    const effectiveDuration = positioned ? duration : 0;
    cursor.style.transitionDuration =
      effectiveDuration === 0 ? "0ms" : `${effectiveDuration}ms, 120ms`;
    cursor.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
    cursor.classList.add("is-visible");
    positioned = true;
  }

  function addRipple(point: Point, duration = reducedMotion ? 120 : 420): void {
    const ripple = document.createElement("div");
    ripple.className = "cbx-agent-ripple";
    ripple.style.left = `${point.x}px`;
    ripple.style.top = `${point.y}px`;
    ripple.style.animationDuration = `${duration}ms`;
    layer.append(ripple);
    schedule(() => ripple.remove(), duration);
  }

  function hide(): void {
    clearEffects();
    cursor.classList.remove("is-visible");
  }

  function show(feedback: PageActionFeedback): void {
    if (disposed) return;
    clearEffects();
    if (feedback.kind === "hide") {
      cursor.classList.remove("is-visible");
      return;
    }

    if (feedback.kind === "drag") {
      const from = clampPoint(feedback.fromX, feedback.fromY, view);
      const to = clampPoint(feedback.toX, feedback.toY, view);
      if (reducedMotion) {
        moveCursor(to, 0);
        addRipple(to);
        schedule(hide, 120);
        return;
      }
      moveCursor(from, 0);
      cursor.classList.add("is-dragging");
      schedule(() => moveCursor(to, 260), 16);
      schedule(() => {
        cursor.classList.remove("is-dragging");
        addRipple(to);
      }, 276);
      schedule(hide, 900);
      return;
    }

    const point = clampPoint(feedback.x, feedback.y, view);
    moveCursor(point, reducedMotion ? 0 : 140);
    if (feedback.kind === "click") addRipple(point);
    schedule(hide, reducedMotion ? 120 : feedback.kind === "move" ? 700 : 900);
  }

  const overlay: ActionFeedbackOverlay = {
    show,
    hide,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearEffects();
      unregisterOverlay();
      host.remove();
      mountedOverlays.delete(document);
    },
  };
  mountedOverlays.set(document, overlay);
  return overlay;
}
