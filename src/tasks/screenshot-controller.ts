import type { AttachmentSource } from '../attachments/attachment-types';
import { ScreenshotError } from '../attachments/screenshot-error';
import type { ScreenshotSelection } from '../page/screenshot/screenshot-types';

export interface ScreenshotAttachmentResult {
  readonly id: string;
}

export interface ScreenshotControllerDependencies {
  readonly page: {
    selectRegion(tabId: number): Promise<ScreenshotSelection | null>;
    setOverlaysHidden(tabId: number, hidden: boolean): Promise<void>;
  };
  readonly capture: (tabId: number) => Promise<Blob>;
  readonly crop: (blob: Blob, selection: ScreenshotSelection) => Promise<Blob>;
  readonly persist: (
    blob: Blob,
    source: Extract<AttachmentSource, 'viewport_capture' | 'region_capture'>,
  ) => Promise<ScreenshotAttachmentResult>;
}

export class ScreenshotController {
  readonly #dependencies: ScreenshotControllerDependencies;

  /** Creates the user-triggered screenshot workflow over explicit page and capture ports. */
  constructor(dependencies: ScreenshotControllerDependencies) {
    this.#dependencies = dependencies;
  }

  /** Captures the current visible viewport and always restores extension page overlays. */
  async captureViewport(tabId: number): Promise<ScreenshotAttachmentResult> {
    const blob = await this.#captureWithoutOverlays(tabId);
    return this.#dependencies.persist(blob, 'viewport_capture').catch((cause: unknown) => {
      throw ScreenshotError.from(cause, 'IMAGE_PROCESSING_FAILED');
    });
  }

  /** Lets the user select a region, then captures, crops, and persists the resulting PNG. */
  async captureRegion(tabId: number): Promise<ScreenshotAttachmentResult | null> {
    const selection = await this.#dependencies.page.selectRegion(tabId).catch((cause: unknown) => {
      throw ScreenshotError.from(cause, 'SELECTION_FAILED');
    });
    if (selection === null) return null;
    const captured = await this.#captureWithoutOverlays(tabId);
    try {
      const cropped = await this.#dependencies.crop(captured, selection);
      return await this.#dependencies.persist(cropped, 'region_capture');
    } catch (cause) {
      throw ScreenshotError.from(cause, 'IMAGE_PROCESSING_FAILED');
    }
  }

  /** Hides all owned overlays around the privileged browser capture call. */
  async #captureWithoutOverlays(tabId: number): Promise<Blob> {
    await this.#dependencies.page.setOverlaysHidden(tabId, true).catch(() => undefined);
    try {
      return await this.#dependencies.capture(tabId);
    } catch (cause) {
      throw ScreenshotError.from(cause, 'CAPTURE_FAILED');
    } finally {
      await this.#dependencies.page.setOverlaysHidden(tabId, false).catch(() => undefined);
    }
  }
}
