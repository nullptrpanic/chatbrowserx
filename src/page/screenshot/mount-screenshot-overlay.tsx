import { createRoot, type Root } from 'react-dom/client';
import { registerPageOverlayHost } from '../page-overlay-registry';
import { ScreenshotOverlay } from './ScreenshotOverlay';
import type { ScreenshotSelection } from './screenshot-types';

let activeSelection: Promise<ScreenshotSelection | null> | null = null;

/** Mounts one isolated selector and coalesces duplicate selection requests for the document. */
export function selectScreenshotRegion(
  document: Document = globalThis.document,
  view: Window = globalThis.window,
): Promise<ScreenshotSelection | null> {
  if (activeSelection !== null) return activeSelection;

  const selection = new Promise<ScreenshotSelection | null>((resolve) => {
    const host = document.createElement('div');
    host.dataset.chatbrowserxOverlay = 'screenshot';
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
    let root: Root | null = createRoot(mount);

    /** Unmounts the ephemeral overlay before resolving its page command. */
    function finish(value: ScreenshotSelection | null): void {
      const currentRoot = root;
      root = null;
      currentRoot?.unmount();
      unregister();
      host.remove();
      resolve(value);
    }

    root.render(
      <ScreenshotOverlay view={view} onComplete={finish} onCancel={() => finish(null)} />,
    );
  }).finally(() => {
    if (activeSelection === selection) activeSelection = null;
  });
  activeSelection = selection;
  return selection;
}
