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
  readonly api: CaptureVisibleTabApi;
  readonly decodeDataUrl?: (dataUrl: string) => Promise<Blob>;
}

export type VisibleTabCaptureErrorCode = 'TAB_NOT_VISIBLE' | 'CAPTURE_INVALID';

export class VisibleTabCaptureError extends Error {
  readonly code: VisibleTabCaptureErrorCode;

  /** Creates a stable screenshot failure without retaining tab or image payloads. */
  constructor(code: VisibleTabCaptureErrorCode) {
    super('The requested browser viewport could not be captured.');
    this.name = 'VisibleTabCaptureError';
    this.code = code;
  }
}

/** Decodes one bounded browser-owned image data URL into a PNG Blob. */
async function decodePngDataUrl(dataUrl: string): Promise<Blob> {
  if (!dataUrl.startsWith('data:image/png;')) throw new VisibleTabCaptureError('CAPTURE_INVALID');
  const blob = await (await fetch(dataUrl)).blob();
  if (blob.size <= 0 || blob.type !== 'image/png') {
    throw new VisibleTabCaptureError('CAPTURE_INVALID');
  }
  return blob;
}

/** Captures exactly the requested tab after proving it is still visible in its own window. */
export async function captureVisibleTab(
  tabId: number,
  dependencies: CaptureVisibleTabDependencies = {
    api: chrome.tabs as unknown as CaptureVisibleTabApi,
  },
): Promise<Blob> {
  const tab = await dependencies.api.get(tabId);
  const [active] = await dependencies.api.query({ active: true, windowId: tab.windowId });
  if (!tab.active || active?.id !== tabId) throw new VisibleTabCaptureError('TAB_NOT_VISIBLE');
  const dataUrl = await dependencies.api.captureVisibleTab(tab.windowId, { format: 'png' });
  return (dependencies.decodeDataUrl ?? decodePngDataUrl)(dataUrl);
}
