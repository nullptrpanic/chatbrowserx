import { VirtualPointerOverlay, type PointerEffect } from './VirtualPointerOverlay';

const mounted = new WeakMap<Document, VirtualPointerOverlay>();

/** Reuses one guarded virtual pointer per isolated content-script document. */
export function mountVirtualPointer(
  document_: Document = document,
  window_: Window = window,
): VirtualPointerOverlay {
  const existing = mounted.get(document_);
  if (existing?.connected) {
    existing.ensureExclusive();
    return existing;
  }
  const pointer = new VirtualPointerOverlay(document_, window_);
  mounted.set(document_, pointer);
  return pointer;
}

export async function showVirtualPointer(
  effect: PointerEffect,
  document_: Document = document,
  window_: Window = window,
): Promise<void> {
  await mountVirtualPointer(document_, window_).show(effect);
}
