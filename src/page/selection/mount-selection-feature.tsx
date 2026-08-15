import { createRoot } from 'react-dom/client';
import {
  PROTOCOL_VERSION,
  type ExtensionMessage,
  type ExtensionResponse,
} from '../../shared/protocol/message-types';
import { registerPageOverlayHost } from '../page-overlay-registry';
import { readPageSelection } from './read-selection';
import { SelectionBubble } from './SelectionBubble';
import type { PageTextSelection } from './selection-types';
import { resolveSelectionLabels } from './selection-i18n';

export interface SelectionRuntimePort {
  sendMessage(message: ExtensionMessage): Promise<unknown>;
}

export interface MountSelectionFeatureOptions {
  readonly document?: Document;
  readonly view?: Window;
  readonly runtime?: SelectionRuntimePort;
}

const mountedDocuments = new WeakMap<Document, () => void>();

/** Creates a unique page-to-background request identifier without page-derived values. */
function requestId(): string {
  return `selection_${crypto.randomUUID()}`;
}

/** Requires the standard runtime response envelope and returns its sanitized data field. */
function responseData(value: unknown): unknown {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== PROTOCOL_VERSION ||
    !('ok' in value)
  ) {
    throw new Error('Selection response is invalid.');
  }
  const response = value as ExtensionResponse;
  if (!response.ok) throw new Error(response.error.code);
  return response.data;
}

/** Reads the single translation string permitted to cross back into the page context. */
function translationText(value: unknown): string {
  const data = responseData(value);
  if (
    typeof data !== 'object' ||
    data === null ||
    !('text' in data) ||
    typeof data.text !== 'string' ||
    data.text.trim().length === 0 ||
    data.text.length > 30_000
  ) {
    throw new Error('Translation response is invalid.');
  }
  return data.text;
}

/** Mounts one idempotent isolated selected-text feature for the current top-level document. */
export function mountSelectionFeature(options: MountSelectionFeatureOptions = {}): () => void {
  const document = options.document ?? globalThis.document;
  const view = options.view ?? globalThis.window;
  const runtime = options.runtime ?? {
    sendMessage: (message) => chrome.runtime.sendMessage(message),
  };
  const existing = mountedDocuments.get(document);
  if (existing !== undefined) return existing;

  const host = document.createElement('div');
  host.dataset.chatbrowserxOverlay = 'selection';
  host.style.position = 'fixed';
  host.style.inset = '0';
  host.style.zIndex = '2147483646';
  host.style.pointerEvents = 'none';
  const shadow = host.attachShadow({ mode: 'closed' });
  const mount = document.createElement('div');
  shadow.append(mount);
  document.documentElement.append(host);
  const unregisterOverlay = registerPageOverlayHost(host);
  const root = createRoot(mount);
  let selected: PageTextSelection | null = null;
  let disposed = false;

  /** Removes the visible bubble while preserving the page's native selection. */
  function clear(): void {
    selected = null;
    root.render(null);
  }

  /** Renders a snapshot of selected text without retaining its surrounding DOM nodes. */
  function render(selection: PageTextSelection): void {
    selected = selection;
    root.render(
      <SelectionBubble
        key={`${selection.pageUrl}:${selection.rect.left}:${selection.rect.top}:${selection.text}`}
        selection={selection}
        labels={resolveSelectionLabels(view.navigator.language)}
        onClose={clear}
        onTranslate={async () => {
          const response = await runtime.sendMessage({
            version: PROTOCOL_VERSION,
            requestId: requestId(),
            type: 'selection.translate',
            payload: {
              text: selection.text,
              pageUrl: selection.pageUrl,
              pageTitle: selection.pageTitle,
            },
          });
          return translationText(response);
        }}
        onAsk={async (question) => {
          responseData(
            await runtime.sendMessage({
              version: PROTOCOL_VERSION,
              requestId: requestId(),
              type: 'selection.ask',
              payload: {
                text: selection.text,
                question,
                pageUrl: selection.pageUrl,
                pageTitle: selection.pageTitle,
              },
            }),
          );
        }}
      />,
    );
  }

  /** Refreshes the bubble after native selection gestures but ignores extension-owned clicks. */
  function handleSelectionGesture(event: Event): void {
    if (event.composedPath().includes(host)) return;
    view.setTimeout(() => {
      if (disposed) return;
      const next = readPageSelection(document, view);
      if (next === null) clear();
      else render(next);
    }, 0);
  }

  /** Clears stale anchors whenever scrolling or history navigation invalidates page geometry. */
  function clearStaleSelection(): void {
    if (selected !== null) clear();
  }

  document.addEventListener('pointerup', handleSelectionGesture, true);
  document.addEventListener('keyup', handleSelectionGesture, true);
  document.addEventListener('selectionchange', handleSelectionGesture, true);
  view.addEventListener('scroll', clearStaleSelection, true);
  view.addEventListener('popstate', clearStaleSelection);
  view.addEventListener('hashchange', clearStaleSelection);
  view.addEventListener('pagehide', clearStaleSelection);

  /** Stops every owned listener, React root, registry entry, and host exactly once. */
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener('pointerup', handleSelectionGesture, true);
    document.removeEventListener('keyup', handleSelectionGesture, true);
    document.removeEventListener('selectionchange', handleSelectionGesture, true);
    view.removeEventListener('scroll', clearStaleSelection, true);
    view.removeEventListener('popstate', clearStaleSelection);
    view.removeEventListener('hashchange', clearStaleSelection);
    view.removeEventListener('pagehide', clearStaleSelection);
    unregisterOverlay();
    root.unmount();
    host.remove();
    mountedDocuments.delete(document);
  };
  mountedDocuments.set(document, dispose);
  return dispose;
}
