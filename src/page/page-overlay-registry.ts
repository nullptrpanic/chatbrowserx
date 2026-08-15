const overlayHosts = new Set<HTMLElement>();

/** Registers one extension-owned page overlay and returns its idempotent unregister callback. */
export function registerPageOverlayHost(host: HTMLElement): () => void {
  overlayHosts.add(host);
  return () => overlayHosts.delete(host);
}

/** Hides or reveals all extension-owned overlays without affecting host-page elements. */
export function setPageOverlaysHidden(hidden: boolean): void {
  for (const host of overlayHosts) host.style.visibility = hidden ? 'hidden' : 'visible';
}
