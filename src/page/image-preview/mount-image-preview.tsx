import { createRoot } from 'react-dom/client';
import { registerPageOverlayHost } from '../page-overlay-registry';
import { ImagePreviewOverlay } from './ImagePreviewOverlay';

export interface PageImagePreviewInput {
  readonly src: string;
  readonly alt: string;
}

const activePreviews = new WeakMap<Document, () => void>();

/** Mounts one replaceable full-page preview inside an isolated closed Shadow Root. */
export function openPageImagePreview(
  preview: PageImagePreviewInput,
  document: Document = globalThis.document,
  view: Window = globalThis.window,
): void {
  activePreviews.get(document)?.();

  const host = document.createElement('div');
  host.dataset.chatbrowserxOverlay = 'image-preview';
  Object.assign(host.style, {
    all: 'initial',
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    visibility: 'visible',
  });
  const shadow = host.attachShadow({ mode: 'closed' });
  const mount = document.createElement('div');
  shadow.append(mount);
  document.documentElement.append(host);
  const unregister = registerPageOverlayHost(host);
  const root = createRoot(mount);
  let closed = false;

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') close();
  }

  function close(): void {
    if (closed) return;
    closed = true;
    view.removeEventListener('keydown', handleKeyDown, true);
    root.unmount();
    unregister();
    host.remove();
    if (activePreviews.get(document) === close) activePreviews.delete(document);
  }

  view.addEventListener('keydown', handleKeyDown, true);
  activePreviews.set(document, close);
  root.render(
    <ImagePreviewOverlay src={preview.src} alt={preview.alt} view={view} onClose={close} />,
  );
}
