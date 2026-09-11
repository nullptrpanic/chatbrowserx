import { ScreenshotError } from '../../attachments/screenshot-error';

export interface CaptureVisibleTabApi {
  get(
    tabId: number,
  ): Promise<{ readonly id?: number; readonly windowId: number; readonly active: boolean }>;
  query(queryInfo: {
    readonly active: true;
    readonly windowId: number;
  }): Promise<readonly { readonly id?: number }[]>;
  captureVisibleTab(windowId: number, options: { readonly format: 'png' }): Promise<string>;
}

export interface CaptureVisibleTabDependencies {
  readonly api?: CaptureVisibleTabApi;
  readonly decodeDataUrl?: (dataUrl: string) => Promise<Blob>;
  readonly beforeCapture?: () => Promise<void>;
  readonly afterCapture?: () => Promise<void>;
  readonly signal?: AbortSignal;
}

const captureSlots = new WeakMap<CaptureVisibleTabApi, { tail: Promise<void>; next: number }>();

/** Decodes one bounded browser-owned image data URL into a PNG Blob. */
async function decodePngDataUrl(dataUrl: string): Promise<Blob> {
  if (!dataUrl.startsWith('data:image/png;')) throw new ScreenshotError('CAPTURE_INVALID');
  const blob = await (await fetch(dataUrl)).blob();
  if (blob.size <= 0 || blob.type !== 'image/png') {
    throw new ScreenshotError('CAPTURE_INVALID');
  }
  return blob;
}

/** Captures exactly the requested tab after proving it is still visible in its own window. */
export async function captureVisibleTab(
  tabId: number,
  dependencies: CaptureVisibleTabDependencies = {},
): Promise<Blob> {
  const api = dependencies.api ?? (chrome.tabs as unknown as CaptureVisibleTabApi);
  let slot = captureSlots.get(api);
  if (!slot) {
    slot = { tail: Promise.resolve(), next: 0 };
    captureSlots.set(api, slot);
  }
  const previous = slot.tail;
  let release!: () => void;
  slot.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const delay = slot.next - Date.now();
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    dependencies.signal?.throwIfAborted();
    const tab = await api.get(tabId).catch(() => {
      throw new ScreenshotError('TAB_NOT_VISIBLE');
    });
    const [active] = await api.query({ active: true, windowId: tab.windowId });
    if (!tab.active || active?.id !== tabId) throw new ScreenshotError('TAB_NOT_VISIBLE');
    try {
      await dependencies.beforeCapture?.();
      dependencies.signal?.throwIfAborted();
      slot.next = Date.now() + 600;
      const dataUrl = await api.captureVisibleTab(tab.windowId, { format: 'png' });
      const [stillActive] = await api.query({ active: true, windowId: tab.windowId });
      if (stillActive?.id !== tabId) throw new ScreenshotError('TAB_NOT_VISIBLE');
      return await (dependencies.decodeDataUrl ?? decodePngDataUrl)(dataUrl);
    } finally {
      await dependencies.afterCapture?.();
    }
  } finally {
    release();
  }
}
