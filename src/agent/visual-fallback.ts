import type { PageObservation } from '../browser/contracts/observation';

const MAX_VISUAL_BYTES = 6 * 1024 * 1024;
const MIN_SEMANTIC_TEXT_CHARACTERS = 200;
const APPROVED_VISUAL_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface ViewportVisualCaptureDependencies {
  readonly page: {
    setOverlaysHidden(tabId: number, hidden: boolean): Promise<void>;
  };
  readonly capture: (tabId: number) => Promise<Blob>;
}

/** Chooses visual fallback only when semantic observation cannot describe an actionable page. */
export function shouldCaptureVisualFallback(observation: PageObservation): boolean {
  if (observation.elements.some((element) => element.visible)) return false;
  const textCharacters = observation.textRegions.reduce(
    (total, region) => total + region.text.length,
    0,
  );
  return textCharacters < MIN_SEMANTIC_TEXT_CHARACTERS;
}

/** Encodes a bounded image Blob without spreading large byte arrays onto the call stack. */
async function imageDataUrl(blob: Blob): Promise<string> {
  const mimeType = blob.type.toLowerCase();
  if (!APPROVED_VISUAL_TYPES.has(mimeType) || blob.size <= 0 || blob.size > MAX_VISUAL_BYTES) {
    throw new Error('Visual fallback image is invalid.');
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 8 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

export class ViewportVisualCapture {
  readonly #dependencies: ViewportVisualCaptureDependencies;

  /** Creates a transient capture boundary that never stores or references the screenshot. */
  constructor(dependencies: ViewportVisualCaptureDependencies) {
    this.#dependencies = dependencies;
  }

  /** Captures one active viewport with extension overlays hidden and returns a bounded data URL. */
  async capture(tabId: number): Promise<string> {
    await this.#dependencies.page.setOverlaysHidden(tabId, true);
    try {
      return await imageDataUrl(await this.#dependencies.capture(tabId));
    } finally {
      await this.#dependencies.page.setOverlaysHidden(tabId, false).catch(() => undefined);
    }
  }
}
