import { registerPageOverlayHost } from '../page-overlay-registry';

export interface PointerEffect {
  readonly x: number;
  readonly y: number;
  readonly fromX: number;
  readonly fromY: number;
  readonly effect: 'move' | 'click' | 'double_click' | 'drag';
}

function wait(window_: Window, milliseconds: number): Promise<void> {
  return new Promise((resolve) => window_.setTimeout(resolve, milliseconds));
}

/** Renders an isolated, non-interactive cursor and click feedback over the page. */
export class VirtualPointerOverlay {
  readonly #document: Document;
  readonly #window: Window;
  readonly #host: HTMLElement;
  readonly #shadow: ShadowRoot;
  readonly #cursor: SVGSVGElement;
  readonly #unregister: () => void;
  #hideTimer: number | undefined;
  #showSequence = 0;

  constructor(document_: Document, window_: Window) {
    this.#document = document_;
    this.#window = window_;
    document_
      .querySelectorAll('[data-chatbrowserx-overlay="virtual-pointer"]')
      .forEach((node) => node.remove());
    this.#host = document_.createElement('div');
    this.#host.dataset.chatbrowserxOverlay = 'virtual-pointer';
    Object.assign(this.#host.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '2147483647',
      overflow: 'hidden',
    });
    this.#shadow = this.#host.attachShadow({ mode: 'open' });
    const style = document_.createElement('style');
    style.textContent = `
      :host { all: initial; }
      [data-part="cursor"] {
        position: fixed; left: 0; top: 0; width: 18px; height: 22px;
        overflow: visible;
        opacity: 0;
        filter: drop-shadow(0 1px 1px rgba(15,23,42,.42)) drop-shadow(0 0 4px rgba(64,149,238,.74)) drop-shadow(0 0 10px rgba(80,166,244,.38));
        transform-origin: 0 0;
        transition: transform 180ms cubic-bezier(.2,.78,.28,1), opacity 120ms ease-out;
        will-change: transform, opacity;
      }
      [data-part="ripple"] {
        position: fixed; width: 20px; height: 20px; margin: -10px;
        border: 1.5px solid rgba(74,120,237,.9); border-radius: 999px;
        background: transparent;
        box-shadow: 0 0 0 4px rgba(74,120,237,.11);
        opacity: 0;
        animation: cbx-pointer-ripple 360ms cubic-bezier(.16,.72,.22,1) forwards;
      }
      @keyframes cbx-pointer-ripple {
        0% { opacity: .9; transform: scale(.45); }
        58% { opacity: .48; }
        100% { opacity: 0; transform: scale(1.45); }
      }
    `;
    this.#cursor = document_.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.#cursor.dataset.part = 'cursor';
    this.#cursor.setAttribute('viewBox', '0 0 20 24');
    this.#cursor.setAttribute('aria-hidden', 'true');
    const cursorOutline = document_.createElementNS('http://www.w3.org/2000/svg', 'path');
    cursorOutline.dataset.layer = 'outline';
    cursorOutline.setAttribute(
      'd',
      'M1.45 .55 C.75 .28 .08 .98 .3 1.72 L6.1 21.4 C6.6 23.08 8.95 23.12 9.55 21.48 L12.6 13.16 L18.05 11.56 C19.75 11.06 19.9 8.72 18.28 8.02 Z',
    );
    cursorOutline.setAttribute('fill', '#ffffff');
    const cursorFill = document_.createElementNS('http://www.w3.org/2000/svg', 'path');
    cursorFill.dataset.layer = 'fill';
    cursorFill.setAttribute(
      'd',
      'M2.55 2.2 L17.4 9.02 C18 9.3 17.95 10.1 17.3 10.3 L11.45 12 L8.18 20.95 C7.96 21.55 7.12 21.54 6.94 20.91 L1.58 2.86 C1.42 2.3 1.97 1.93 2.55 2.2 Z',
    );
    cursorFill.setAttribute('fill', '#050505');
    this.#cursor.append(cursorOutline, cursorFill);
    this.#shadow.append(style, this.#cursor);
    (document_.documentElement ?? document_.body).append(this.#host);
    this.#unregister = registerPageOverlayHost(this.#host);
  }

  get connected(): boolean {
    return this.#host.isConnected;
  }

  ensureExclusive(): void {
    this.#document
      .querySelectorAll('[data-chatbrowserx-overlay="virtual-pointer"]')
      .forEach((node) => {
        if (node !== this.#host) node.remove();
      });
  }

  async show(effect: PointerEffect): Promise<void> {
    const sequence = ++this.#showSequence;
    this.#cancelHide();
    this.#shadow.querySelectorAll('[data-part="ripple"]').forEach((node) => node.remove());
    this.#cursor.style.transitionDuration = '0ms';
    this.#cursor.style.opacity = '1';
    this.#cursor.style.transform = `translate3d(${effect.fromX}px, ${effect.fromY}px, 0)`;
    await new Promise<void>((resolve) => this.#window.requestAnimationFrame(() => resolve()));
    this.#cursor.style.transitionDuration = effect.effect === 'drag' ? '260ms' : '180ms';
    this.#cursor.style.transform = `translate3d(${effect.x}px, ${effect.y}px, 0)`;
    await wait(this.#window, effect.effect === 'drag' ? 260 : 180);
    if (sequence !== this.#showSequence) return;
    if (effect.effect === 'click' || effect.effect === 'double_click') {
      this.#addRipple(effect.x, effect.y);
      if (effect.effect === 'double_click') this.#addRipple(effect.x, effect.y, 90);
    }
    this.#scheduleHide(effect.effect, sequence);
  }

  destroy(): void {
    this.#showSequence += 1;
    this.#cancelHide();
    this.#unregister();
    this.#host.remove();
  }

  #cancelHide(): void {
    if (this.#hideTimer === undefined) return;
    this.#window.clearTimeout(this.#hideTimer);
    this.#hideTimer = undefined;
  }

  #scheduleHide(effect: PointerEffect['effect'], sequence: number): void {
    const delay = effect === 'move' ? 360 : effect === 'drag' ? 520 : 480;
    this.#hideTimer = this.#window.setTimeout(() => {
      if (sequence !== this.#showSequence) return;
      this.#hideTimer = undefined;
      this.#cursor.style.transitionDuration = '120ms';
      this.#cursor.style.opacity = '0';
    }, delay);
  }

  #addRipple(x: number, y: number, delayMs = 0): void {
    const ripple = this.#document.createElement('div');
    ripple.dataset.part = 'ripple';
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    if (delayMs > 0) ripple.style.animationDelay = `${delayMs}ms`;
    this.#shadow.append(ripple);
  }
}
