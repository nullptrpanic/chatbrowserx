import type { TranslationLensOptions } from '../../translation/region-translation';
import { registerPageOverlayHost } from '../page-overlay-registry';

/** UI only: a clipped observation window. It never captures, translates or invalidates content. */
export class TranslationLensView {
  readonly host: HTMLElement;
  readonly sheet: HTMLElement;
  readonly domLayer: HTMLElement;
  readonly imageLayer: HTMLElement;
  readonly action: HTMLButtonElement;
  private readonly frame: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly noticeText: Text;
  private readonly unregister: () => void;
  private point: { x: number; y: number };
  private scale = 1;
  private animation = 0;
  private statusKey = '';

  constructor(
    private readonly doc: Document,
    private readonly view: Window,
    private readonly options: TranslationLensOptions,
    private readonly changed: () => void,
    private readonly exit: () => void,
  ) {
    const host = (this.host = doc.createElement('div'));
    host.dataset.chatbrowserxOverlay = 'translation';
    host.setAttribute('aria-label', 'Region translation');
    Object.assign(host.style, {
      all: 'initial',
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      pointerEvents: 'none',
      overflow: 'hidden',
    });
    const shadow = host.attachShadow({ mode: 'closed' }),
      style = doc.createElement('style');
    style.textContent = `
      .frame{position:absolute;box-sizing:border-box;border:1.5px solid #769dea;border-radius:16px;box-shadow:0 4px 24px #21386224}
      :host([data-status="error"]) .frame{border-color:#df5968}
      .patch{position:absolute;inset:0}
      .notice{position:absolute;box-sizing:border-box;max-width:calc(100vw - 16px);height:28px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#45618d;background:#fffffff2;padding:4px 9px;border-radius:7px;font:13px/20px Arial;box-shadow:0 2px 10px #21386215}
      :host([data-status="error"]) .notice{color:#b92738}
      button{pointer-events:auto;cursor:pointer;border:0;background:transparent;color:inherit;font:inherit;padding:0 6px;text-decoration:underline}
    `;
    this.sheet = doc.createElement('div');
    Object.assign(this.sheet.style, { position: 'absolute', inset: '0' });
    this.domLayer = doc.createElement('div');
    this.imageLayer = doc.createElement('div');
    this.sheet.append(this.imageLayer, this.domLayer);
    this.frame = doc.createElement('div');
    this.frame.className = 'frame';
    this.notice = doc.createElement('div');
    this.notice.className = 'notice';
    this.notice.setAttribute('role', 'status');
    this.action = doc.createElement('button');
    this.action.type = 'button';
    this.action.hidden = true;
    this.noticeText = doc.createTextNode('');
    this.notice.append(this.noticeText, this.action);
    shadow.append(style, this.sheet, this.frame, this.notice);
    doc.documentElement.append(host);
    this.unregister = registerPageOverlayHost(host);
    this.point = { x: view.innerWidth / 2, y: view.innerHeight / 2 };
    view.addEventListener('pointermove', this.move);
    view.addEventListener('wheel', this.zoom, { passive: false });
    view.addEventListener('keydown', this.key, true);
  }

  private maximumScale() {
    return Math.max(0.5, this.view.innerWidth / 500, this.view.innerHeight / 260);
  }
  bounds() {
    const width = Math.max(1, Math.min(this.view.innerWidth, 500 * this.scale));
    const height = Math.max(1, Math.min(this.view.innerHeight, 260 * this.scale));
    return {
      x: Math.max(0, Math.min(this.view.innerWidth - width, this.point.x - width / 2)),
      y: Math.max(0, Math.min(this.view.innerHeight - height, this.point.y - height / 2)),
      width,
      height,
    };
  }
  redraw = () => {
    if (this.animation) return;
    this.animation = this.view.requestAnimationFrame(() => {
      this.animation = 0;
      this.scale = Math.min(this.scale, this.maximumScale());
      const r = this.bounds();
      Object.assign(this.frame.style, {
        left: `${r.x}px`,
        top: `${r.y}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
      this.sheet.style.clipPath = `inset(${r.y}px ${this.view.innerWidth - r.x - r.width}px ${this.view.innerHeight - r.y - r.height}px ${r.x}px round 16px)`;
      Object.assign(this.notice.style, {
        left: `${r.x}px`,
        top: `${r.y >= 34 ? r.y - 34 : r.y + r.height + 34 <= this.view.innerHeight ? r.y + r.height + 6 : Math.max(0, Math.min(r.y + 6, this.view.innerHeight - 28))}px`,
      });
      this.changed();
    });
  };
  status(value: 'waiting' | 'loading' | 'ready' | 'error' | 'unsupported', failure?: string) {
    const key = `${value}:${failure ?? ''}`;
    if (this.statusKey === key) return;
    this.statusKey = key;
    this.host.dataset.status = value;
    this.notice.hidden = value === 'ready';
    this.noticeText.textContent =
      value === 'error'
        ? `${this.options.errorText} (${failure}) `
        : value === 'unsupported'
          ? this.options.unsupportedText
          : this.options.loadingText;
    this.action.hidden = value !== 'error';
    this.action.textContent = value === 'error' ? this.options.retryText : '';
  }
  private move = (event: PointerEvent) => {
    if (
      event.composedPath().includes(this.host) ||
      (this.point.x === event.clientX && this.point.y === event.clientY)
    )
      return;
    this.point = { x: event.clientX, y: event.clientY };
    this.redraw();
  };
  private zoom = (event: WheelEvent) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    this.scale = Math.max(
      0.5,
      Math.min(this.maximumScale(), this.scale * Math.exp(-event.deltaY * 0.005)),
    );
    this.redraw();
  };
  private key = (event: KeyboardEvent) => {
    if (event.key === 'Escape') this.exit();
  };
  close() {
    this.view.cancelAnimationFrame(this.animation);
    this.view.removeEventListener('pointermove', this.move);
    this.view.removeEventListener('wheel', this.zoom);
    this.view.removeEventListener('keydown', this.key, true);
    this.unregister();
    this.host.remove();
  }
}
