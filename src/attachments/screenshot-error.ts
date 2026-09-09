export type ScreenshotErrorCode =
  | 'TAB_NOT_VISIBLE'
  | 'CAPTURE_INVALID'
  | 'CAPTURE_FAILED'
  | 'PAGE_ACCESS_UNAVAILABLE'
  | 'SELECTION_FAILED'
  | 'IMAGE_PROCESSING_FAILED';

/** Safe screenshot errors shared by the capture, controller, and runtime boundaries. */
export class ScreenshotError extends Error {
  constructor(readonly code: ScreenshotErrorCode) {
    super('The screenshot could not be completed.');
    this.name = 'ScreenshotError';
  }

  /** Retains a known reason without retaining raw browser, image, or storage data. */
  static from(cause: unknown, code: ScreenshotErrorCode): ScreenshotError {
    return cause instanceof ScreenshotError ? cause : new ScreenshotError(code);
  }
}
