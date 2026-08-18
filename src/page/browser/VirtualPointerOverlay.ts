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

/** Renders an isolated, non-interactive cursor, click ripple, and drag trail over the page. */
export class VirtualPointerOverlay {
  readonly #document: Document;
  readonly #window: Window;
  readonly #host: HTMLElement;
  readonly #shadow: ShadowRoot;
  readonly #cursor: HTMLElement;
  readonly #unregister: () => void;

  constructor(document_: Document, window_: Window) {
    this.#document = document_;
    this.#window = window_;
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
        position: fixed; left: -7px; top: -7px; width: 14px; height: 14px;
        border: 2px solid rgba(255,255,255,.98); border-radius: 999px;
        background: #346ee8; box-shadow: 0 2px 9px rgba(26,52,104,.42);
        transition: transform 180ms cubic-bezier(.22,.8,.32,1); will-change: transform;
      }
      [data-part="ripple"] {
        position: fixed; width: 34px; height: 34px; margin: -17px;
        border: 2px solid rgba(52,110,232,.72); border-radius: 999px;
        box-shadow: 0 0 0 7px rgba(52,110,232,.12);
      }
      [data-part="drag-trail"] {
        position: fixed; height: 3px; transform-origin: 0 50%; border-radius: 999px;
        background: linear-gradient(90deg, rgba(52,110,232,.18), rgba(52,110,232,.7));
      }
    `;
    this.#cursor = document_.createElement('div');
    this.#cursor.dataset.part = 'cursor';
    this.#shadow.append(style, this.#cursor);
    (document_.documentElement ?? document_.body).append(this.#host);
    this.#unregister = registerPageOverlayHost(this.#host);
  }

  get connected(): boolean {
    return this.#host.isConnected;
  }

  async show(effect: PointerEffect): Promise<void> {
    this.#shadow
      .querySelectorAll('[data-part="ripple"], [data-part="drag-trail"]')
      .forEach((node) => node.remove());
    this.#cursor.style.transitionDuration = '0ms';
    this.#cursor.style.transform = `translate3d(${effect.fromX}px, ${effect.fromY}px, 0)`;
    if (effect.effect === 'drag') this.#addDragTrail(effect);
    await new Promise<void>((resolve) => this.#window.requestAnimationFrame(() => resolve()));
    this.#cursor.style.transitionDuration = effect.effect === 'drag' ? '260ms' : '180ms';
    this.#cursor.style.transform = `translate3d(${effect.x}px, ${effect.y}px, 0)`;
    await wait(this.#window, effect.effect === 'drag' ? 260 : 180);
    if (effect.effect === 'click' || effect.effect === 'double_click') {
      this.#addRipple(effect.x, effect.y);
      if (effect.effect === 'double_click') this.#addRipple(effect.x, effect.y, 8);
    }
  }

  destroy(): void {
    this.#unregister();
    this.#host.remove();
  }

  #addRipple(x: number, y: number, inset = 0): void {
    const ripple = this.#document.createElement('div');
    ripple.dataset.part = 'ripple';
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    if (inset > 0) ripple.style.transform = `scale(${1 + inset / 34})`;
    this.#shadow.append(ripple);
  }

  #addDragTrail(effect: PointerEffect): void {
    const trail = this.#document.createElement('div');
    trail.dataset.part = 'drag-trail';
    const deltaX = effect.x - effect.fromX;
    const deltaY = effect.y - effect.fromY;
    trail.style.left = `${effect.fromX}px`;
    trail.style.top = `${effect.fromY}px`;
    trail.style.width = `${Math.hypot(deltaX, deltaY)}px`;
    trail.style.transform = `rotate(${Math.atan2(deltaY, deltaX)}rad)`;
    this.#shadow.append(trail);
  }
}
