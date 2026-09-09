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
  readonly api: CaptureVisibleTabApi;
  readonly decodeDataUrl?: (dataUrl: string) => Promise<Blob>;
}

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
  dependencies: CaptureVisibleTabDependencies = {
    api: chrome.tabs as unknown as CaptureVisibleTabApi,
  },
): Promise<Blob> {
  const tab = await dependencies.api.get(tabId).catch(() => {
    throw new ScreenshotError('TAB_NOT_VISIBLE');
  });
  const [active] = await dependencies.api.query({ active: true, windowId: tab.windowId });
  if (!tab.active || active?.id !== tabId) throw new ScreenshotError('TAB_NOT_VISIBLE');
  const dataUrl = await dependencies.api.captureVisibleTab(tab.windowId, { format: 'png' });
  const [stillActive] = await dependencies.api.query({ active: true, windowId: tab.windowId });
  if (stillActive?.id !== tabId) throw new ScreenshotError('TAB_NOT_VISIBLE');
  return (dependencies.decodeDataUrl ?? decodePngDataUrl)(dataUrl);
}
