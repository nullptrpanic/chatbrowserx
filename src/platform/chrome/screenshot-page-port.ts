import type { ScreenshotSelection } from '../../page/screenshot/screenshot-types';
import { ScreenshotError } from '../../attachments/screenshot-error';
import { PROTOCOL_VERSION, type PageCommand } from '../../shared/protocol/message-types';
import type { IdGenerator } from '../../shared/ids';
import type { ContentScriptInstaller } from './content-script-installer';

export interface ScreenshotPagePortDependencies {
  readonly installer: Pick<ContentScriptInstaller, 'ensureInstalled'>;
  readonly tabs: {
    get(tabId: number): Promise<{ readonly url?: string | undefined }>;
    sendMessage(
      tabId: number,
      message: PageCommand,
      options: { readonly frameId: number },
    ): Promise<unknown>;
  };
  readonly ids: IdGenerator;
}

export interface PageImagePreview {
  readonly src: string;
  readonly alt: string;
}

/** Checks the complete finite geometry returned by the isolated selection overlay. */
function isScreenshotSelection(value: unknown): value is ScreenshotSelection {
  if (typeof value !== 'object' || value === null) return false;
  const selection = value as Partial<ScreenshotSelection>;
  const rect = selection.rect;
  return (
    typeof rect === 'object' &&
    rect !== null &&
    [
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      selection.devicePixelRatio,
      selection.viewportWidth,
      selection.viewportHeight,
    ].every((candidate) => typeof candidate === 'number' && Number.isFinite(candidate)) &&
    rect.width >= 8 &&
    rect.height >= 8 &&
    (selection.viewportWidth ?? 0) > 0 &&
    (selection.viewportHeight ?? 0) > 0
  );
}

/** Reads the correlated success data from one page command response. */
function readResponse(value: unknown, requestId: string): unknown {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('requestId' in value) ||
    value.requestId !== requestId ||
    !('ok' in value) ||
    value.ok !== true ||
    !('data' in value)
  ) {
    throw new Error('Screenshot page command failed.');
  }
  return value.data;
}

export class ChromeScreenshotPagePort {
  readonly #dependencies: ScreenshotPagePortDependencies;

  /** Creates the credential-free screenshot command boundary for one visible web page. */
  constructor(dependencies: ScreenshotPagePortDependencies) {
    this.#dependencies = dependencies;
  }

  /** Opens the isolated region selector and returns null only for explicit user cancellation. */
  async selectRegion(tabId: number): Promise<ScreenshotSelection | null> {
    await this.#ensurePage(tabId);
    const requestId = this.#dependencies.ids.create('page_request');
    const response = await this.#dependencies.tabs.sendMessage(
      tabId,
      { version: PROTOCOL_VERSION, requestId, type: 'page.screenshot.select', payload: {} },
      { frameId: 0 },
    );
    const data = readResponse(response, requestId);
    if (data === null) return null;
    if (!isScreenshotSelection(data)) throw new Error('Screenshot selection is invalid.');
    return data;
  }

  /** Displays one already validated image across the current page viewport. */
  async openImagePreview(tabId: number, preview: PageImagePreview): Promise<void> {
    await this.#ensurePage(tabId);
    const requestId = this.#dependencies.ids.create('page_request');
    const response = await this.#dependencies.tabs.sendMessage(
      tabId,
      {
        version: PROTOCOL_VERSION,
        requestId,
        type: 'page.imagePreview.open',
        payload: preview,
      },
      { frameId: 0 },
    );
    readResponse(response, requestId);
  }

  /** Hides or restores all extension-owned page overlays around viewport capture. */
  async setOverlaysHidden(
    tabId: number,
    hidden: boolean,
  ): Promise<Pick<ScreenshotSelection, 'viewportWidth' | 'viewportHeight'>> {
    // Restoration must be immediate and must not inject into a replacement document.
    if (hidden) await this.#ensurePage(tabId);
    const requestId = this.#dependencies.ids.create('page_request');
    const response = await this.#dependencies.tabs.sendMessage(
      tabId,
      {
        version: PROTOCOL_VERSION,
        requestId,
        type: 'page.overlays.setHidden',
        payload: { hidden },
      },
      { frameId: 0 },
    );
    const data = readResponse(response, requestId);
    if (
      typeof data !== 'object' ||
      data === null ||
      !('viewportWidth' in data) ||
      typeof data.viewportWidth !== 'number' ||
      !('viewportHeight' in data) ||
      typeof data.viewportHeight !== 'number' ||
      !Number.isFinite(data.viewportWidth) ||
      data.viewportWidth <= 0 ||
      !Number.isFinite(data.viewportHeight) ||
      data.viewportHeight <= 0
    )
      throw new ScreenshotError('CAPTURE_GEOMETRY_CHANGED');
    return { viewportWidth: data.viewportWidth, viewportHeight: data.viewportHeight };
  }

  /** Ensures the on-demand page bundle is available under an already granted origin permission. */
  async #ensurePage(tabId: number): Promise<void> {
    const tab = await this.#dependencies.tabs.get(tabId);
    const installation = await this.#dependencies.installer.ensureInstalled(tabId, tab.url ?? '');
    if (
      installation.status === 'permission_required' ||
      installation.status === 'unsupported_origin'
    ) {
      throw new ScreenshotError('PAGE_ACCESS_UNAVAILABLE');
    }
  }
}
