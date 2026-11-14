import {
  SELECTION_TRANSLATION_PORT,
  selectionTranslationReplySchema,
  selectionTranslationTextSchema,
  type SelectionTranslationPageOptions,
} from '../../translation/selection-translation';
import { registerPageOverlayHost } from '../page-overlay-registry';

const active = new WeakMap<Document, () => void>();

export function closeSelectionTranslation(doc: Document = document): void {
  active.get(doc)?.();
}

/** Opens a reading-only bubble for the selection supplied by the browser menu. */
export function openSelectionTranslation(
  options: SelectionTranslationPageOptions,
  doc: Document,
  view: Window,
): boolean {
  if (doc.hidden || new URL(options.url).href !== doc.URL) return false;
  const selection = view.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return false;
  // The native menu and Selection API can serialize line breaks differently.
  const normalized = (text: string) => text.replace(/\s+/gu, ' ').trim();
  if (normalized(selection.toString()) !== normalized(options.text)) return false;
  const range = selection.getRangeAt(0).cloneRange();
  const ancestor = range.commonAncestorContainer;
  const owner =
    ancestor.nodeType === Node.ELEMENT_NODE ? (ancestor as Element) : ancestor.parentElement;
  if (!owner || owner.closest('[data-chatbrowserx-overlay]')) return false;
  if (!range.getBoundingClientRect().width) return false;
  closeSelectionTranslation(doc);

  const host = doc.createElement('div');
  host.dataset.chatbrowserxOverlay = 'selection';
  Object.assign(host.style, {
    all: 'initial',
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    pointerEvents: 'none',
    zoom: String(1 / (doc.documentElement.currentCSSZoom || 1)),
  });
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = `
    .bubble {
      --surface: light-dark(#fff, #1d2330);
      --ink: light-dark(#172338, #e9eef9);
      --muted: light-dark(#54647c, #aebbd1);
      --edge: light-dark(#dce4f0, #3b475d);
      color-scheme: light dark;
      position: absolute;
      box-sizing: border-box;
      width: min(310px, calc(100% - 16px));
      max-height: min(240px, calc(100% - 16px));
      display: flex;
      flex-direction: column;
      padding: 8px 12px 11px;
      background: var(--surface);
      color: var(--ink);
      border: 1px solid var(--edge);
      border-radius: 10px;
      box-shadow: 0 6px 20px light-dark(#1c3c7529, #080e217d);
      font: 14px/1.55 Inter, system-ui, sans-serif;
      pointer-events: auto;
    }
    .bubble::before {
      content: '';
      position: absolute;
      left: var(--arrow-left, 22px);
      top: -5px;
      width: 8px;
      height: 8px;
      background: var(--surface);
      border-top: 1px solid var(--edge);
      border-left: 1px solid var(--edge);
      transform: rotate(45deg);
    }
    .bubble[data-placement="above"]::before {
      top: auto;
      bottom: -5px;
      transform: rotate(225deg);
    }
    .bubble[data-placement="overlap"]::before { display: none; }
    .heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
    }
    button {
      appearance: none;
      width: 28px;
      height: 28px;
      padding: 0;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: inherit;
      font: 19px/1 system-ui, sans-serif;
      cursor: pointer;
    }
    button:hover { background: light-dark(#f0f4fb, #2d374b); }
    .result {
      min-height: 0;
      margin: 3px 0 0;
      overflow: auto;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      user-select: text;
    }
    .result[aria-busy="true"] { color: var(--muted); }
  `;
  const bubble = doc.createElement('section');
  bubble.className = 'bubble';
  bubble.setAttribute('role', 'dialog');
  bubble.setAttribute('aria-label', options.title);
  const heading = doc.createElement('div');
  heading.className = 'heading';
  const label = doc.createElement('span');
  label.textContent = options.title;
  const dismiss = doc.createElement('button');
  dismiss.type = 'button';
  dismiss.setAttribute('aria-label', options.closeText);
  dismiss.textContent = '×';
  heading.append(label, dismiss);
  const result = doc.createElement('p');
  result.className = 'result';
  result.setAttribute('role', 'status');
  result.setAttribute('aria-busy', 'true');
  result.textContent = options.loadingText;
  bubble.append(heading, result);
  shadow.append(style, bubble);
  doc.documentElement.append(host);
  const unregister = registerPageOverlayHost(host);
  let port: chrome.runtime.Port | undefined;
  let closed = false;
  let frame = 0;

  function position() {
    const anchor = [...range.getClientRects()].findLast(
      (rect) =>
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < view.innerHeight &&
        rect.right > 0 &&
        rect.left < view.innerWidth,
    );
    if (!host.isConnected || !anchor) return close();
    host.style.zoom = String(1 / (doc.documentElement.currentCSSZoom || 1));
    const { width, height } = bubble.getBoundingClientRect();
    const margin = 8;
    const viewportWidth = doc.documentElement.clientWidth || view.innerWidth;
    const viewportHeight = doc.documentElement.clientHeight || view.innerHeight;
    const left = Math.max(margin, Math.min(anchor.left, viewportWidth - width - margin));
    const below = anchor.bottom + margin;
    const above = anchor.top - height - margin;
    const placement =
      below + height <= viewportHeight - margin ? 'below' : above >= margin ? 'above' : 'overlap';
    const top =
      placement === 'above'
        ? above
        : Math.max(margin, Math.min(below, viewportHeight - height - margin));
    bubble.dataset.placement = placement;
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
    bubble.style.setProperty(
      '--arrow-left',
      `${Math.max(8, Math.min(anchor.left + anchor.width / 2 - left - 4, width - 16))}px`,
    );
  }

  function reposition() {
    if (frame) return;
    frame = view.requestAnimationFrame(() => {
      frame = 0;
      position();
    });
  }

  function releasePort() {
    const connection = port;
    port = undefined;
    connection?.disconnect();
  }

  function close() {
    if (closed) return;
    closed = true;
    if (frame) view.cancelAnimationFrame(frame);
    view.removeEventListener('pointerdown', outside, true);
    view.removeEventListener('keydown', escape, true);
    view.removeEventListener('scroll', reposition, true);
    view.removeEventListener('resize', reposition);
    view.removeEventListener('blur', close);
    view.removeEventListener('pagehide', close);
    doc.removeEventListener('visibilitychange', visibility);
    unregister();
    host.remove();
    active.delete(doc);
    releasePort();
  }

  function outside(event: PointerEvent) {
    if (!event.composedPath().includes(host)) close();
  }
  function escape(event: KeyboardEvent) {
    if (event.key === 'Escape') close();
  }
  function visibility() {
    if (doc.hidden) close();
  }
  function update(text: string) {
    if (closed) return;
    result.removeAttribute('aria-busy');
    result.textContent = text;
    position();
  }

  active.set(doc, close);
  dismiss.addEventListener('click', close);
  view.addEventListener('pointerdown', outside, true);
  view.addEventListener('keydown', escape, true);
  view.addEventListener('scroll', reposition, true);
  view.addEventListener('resize', reposition);
  view.addEventListener('blur', close);
  view.addEventListener('pagehide', close);
  doc.addEventListener('visibilitychange', visibility);
  position();
  if (closed) return false;
  if (!selectionTranslationTextSchema.safeParse(options.text).success) {
    update(options.tooLongText);
    return true;
  }
  try {
    const connection = chrome.runtime.connect({ name: SELECTION_TRANSLATION_PORT });
    port = connection;
    connection.onMessage.addListener((value: unknown) => {
      if (port !== connection) return;
      const reply = selectionTranslationReplySchema.safeParse(value);
      releasePort();
      if (reply.success) {
        label.textContent = reply.data.languageName;
        result.lang = reply.data.language;
        update(reply.data.text);
      } else update(options.errorText);
    });
    connection.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (port !== connection) return;
      port = undefined;
      update(options.errorText);
    });
    connection.postMessage(options.text);
  } catch {
    releasePort();
    update(options.errorText);
  }
  return true;
}
