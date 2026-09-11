const overlayHosts = new Set<HTMLElement>();

/** Registers one extension-owned page overlay and returns its idempotent unregister callback. */
export function registerPageOverlayHost(host: HTMLElement): () => void {
  overlayHosts.add(host);
  return () => overlayHosts.delete(host);
}

/** Hides or reveals all extension-owned overlays without affecting host-page elements. */
export async function setPageOverlaysHidden(hidden: boolean, view: Window = window): Promise<void> {
  for (const host of overlayHosts) host.style.visibility = hidden ? 'hidden' : 'visible';
  if (!hidden || !overlayHosts.size) return;
  // A style mutation (or a single RAF) can precede painting. Capturing that frame would include
  // our own lens and translations, feeding them back into OCR and pixel-change detection.
  await new Promise<void>((resolve, reject) => {
    let frame = view.requestAnimationFrame(() => {
      frame = view.requestAnimationFrame(() => {
        view.clearTimeout(timeout);
        resolve();
      });
    });
    const timeout = view.setTimeout(() => {
      view.cancelAnimationFrame(frame);
      reject(new Error('Page rendering is unavailable.'));
    }, 1000);
  });
}
