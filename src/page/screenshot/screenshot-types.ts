export interface ScreenshotRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ScreenshotSelection {
  readonly rect: ScreenshotRect;
  readonly devicePixelRatio: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

export interface ScreenshotDrag {
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
}

export interface ScreenshotViewport {
  readonly width: number;
  readonly height: number;
}
