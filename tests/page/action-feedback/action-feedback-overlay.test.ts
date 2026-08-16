import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActionFeedbackOverlay,
  mountActionFeedbackOverlay,
  type ActionFeedbackOverlay,
} from "../../../src/page/action-feedback/action-feedback-overlay";
import { setPageOverlaysHidden } from "../../../src/page/page-overlay-registry";

describe("mountActionFeedbackOverlay", () => {
  let overlay: ActionFeedbackOverlay | undefined;
  let shadow: ShadowRoot;
  let attachShadow: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    attachShadow = vi.spyOn(Element.prototype, "attachShadow");
  });

  afterEach(() => {
    overlay?.dispose();
    overlay = undefined;
    setPageOverlaysHidden(false);
    attachShadow.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function mount(): ActionFeedbackOverlay {
    overlay = mountActionFeedbackOverlay({ document, view: window });
    shadow = attachShadow.mock.results.at(-1)?.value as ShadowRoot;
    return overlay;
  }

  it("mounts one isolated pointer-transparent overlay per document", () => {
    const first = mount();
    const host = document.querySelector<HTMLElement>(
      '[data-chatbrowserx-overlay="action-feedback"]',
    );

    expect(mountActionFeedbackOverlay({ document, view: window })).toBe(first);
    expect(getActionFeedbackOverlay(document)).toBe(first);
    expect(
      document.querySelectorAll(
        '[data-chatbrowserx-overlay="action-feedback"]',
      ),
    ).toHaveLength(1);
    expect(host?.style.pointerEvents).toBe("none");
    expect(host?.shadowRoot).toBeNull();

    setPageOverlaysHidden(true);
    expect(host?.style.visibility).toBe("hidden");
  });

  it("shows a clamped cursor and transient click ripple, then fades automatically", () => {
    const mounted = mount();
    mounted.show({ kind: "click", x: -100, y: Number.MAX_SAFE_INTEGER });

    const cursor = shadow.querySelector<HTMLElement>(".cbx-agent-cursor");
    const ripple = shadow.querySelector<HTMLElement>(".cbx-agent-ripple");
    expect(cursor?.classList.contains("is-visible")).toBe(true);
    expect(cursor?.style.transform).toContain(
      `translate3d(0px, ${window.innerHeight - 1}px, 0)`,
    );
    expect(ripple).not.toBeNull();
    expect(ripple?.style.left).toBe("0px");
    expect(ripple?.style.top).toBe(`${window.innerHeight - 1}px`);

    vi.advanceTimersByTime(900);
    expect(cursor?.classList.contains("is-visible")).toBe(false);
    expect(shadow.querySelector(".cbx-agent-ripple")).toBeNull();
  });

  it("places the first appearance immediately and animates later moves", () => {
    const mounted = mount();
    const cursor = shadow.querySelector<HTMLElement>(".cbx-agent-cursor");

    mounted.show({ kind: "move", x: 20, y: 30 });
    expect(cursor?.style.transitionDuration).toBe("0ms");

    mounted.show({ kind: "move", x: 200, y: 300 });
    expect(cursor?.style.transitionDuration).toBe("140ms, 120ms");
  });

  it("moves from the drag source to destination and clears pending effects when hidden", () => {
    const mounted = mount();
    mounted.show({ kind: "drag", fromX: 10, fromY: 20, toX: 300, toY: 400 });
    const cursor = shadow.querySelector<HTMLElement>(".cbx-agent-cursor");

    expect(cursor?.style.transform).toContain("translate3d(10px, 20px, 0)");
    expect(cursor?.classList.contains("is-dragging")).toBe(true);

    vi.advanceTimersByTime(16);
    expect(cursor?.style.transform).toContain("translate3d(300px, 400px, 0)");

    mounted.hide();
    expect(cursor?.classList.contains("is-visible")).toBe(false);
    expect(cursor?.classList.contains("is-dragging")).toBe(false);
    expect(shadow.querySelector(".cbx-agent-ripple")).toBeNull();
  });

  it("uses an immediate short indicator when reduced motion is requested", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const mounted = mount();

    mounted.show({ kind: "drag", fromX: 10, fromY: 20, toX: 300, toY: 400 });

    const cursor = shadow.querySelector<HTMLElement>(".cbx-agent-cursor");
    const ripple = shadow.querySelector<HTMLElement>(".cbx-agent-ripple");
    expect(cursor?.style.transform).toContain("translate3d(300px, 400px, 0)");
    expect(cursor?.style.transitionDuration).toBe("0ms");
    expect(ripple?.style.animationDuration).toBe("120ms");
  });

  it("removes its host, registry entry, and timers when disposed", () => {
    const mounted = mount();
    mounted.show({ kind: "click", x: 50, y: 60 });

    mounted.dispose();
    overlay = undefined;

    expect(getActionFeedbackOverlay(document)).toBeUndefined();
    expect(
      document.querySelector('[data-chatbrowserx-overlay="action-feedback"]'),
    ).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
