import type { ScreenshotRect, ScreenshotSelection } from '../page/screenshot/screenshot-types';

export interface DecodedCapturedImage {
  readonly width: number;
  readonly height: number;
  close(): void;
}

export interface CropCanvasPort {
  getContext(contextId: '2d'): {
    drawImage(
      image: DecodedCapturedImage,
      sourceX: number,
      sourceY: number,
      sourceWidth: number,
      sourceHeight: number,
      destinationX: number,
      destinationY: number,
      destinationWidth: number,
      destinationHeight: number,
    ): void;
  } | null;
  convertToBlob(options: { readonly type: 'image/png' }): Promise<Blob>;
}

export interface CropCapturedImageDependencies {
  readonly decode: (blob: Blob) => Promise<DecodedCapturedImage>;
  readonly createCanvas: (width: number, height: number) => CropCanvasPort;
}

/** Clamps one number into an inclusive lower and upper bound. */
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Maps a CSS-pixel selection to a clamped integer source-image rectangle. */
export function computePixelCrop(
  selection: ScreenshotSelection,
  image: { readonly width: number; readonly height: number },
): ScreenshotRect {
  if (
    selection.viewportWidth <= 0 ||
    selection.viewportHeight <= 0 ||
    image.width <= 0 ||
    image.height <= 0
  ) {
    throw new Error('Screenshot dimensions are invalid.');
  }
  const scaleX = image.width / selection.viewportWidth;
  const scaleY = image.height / selection.viewportHeight;
  const x = clamp(Math.floor(selection.rect.x * scaleX), 0, image.width - 1);
  const y = clamp(Math.floor(selection.rect.y * scaleY), 0, image.height - 1);
  const right = clamp(
    Math.ceil((selection.rect.x + selection.rect.width) * scaleX),
    x + 1,
    image.width,
  );
  const bottom = clamp(
    Math.ceil((selection.rect.y + selection.rect.height) * scaleY),
    y + 1,
    image.height,
  );
  return { x, y, width: right - x, height: bottom - y };
}

/** Creates the production bitmap decoder while keeping it replaceable in deterministic tests. */
async function decodeCapturedImage(blob: Blob): Promise<DecodedCapturedImage> {
  return createImageBitmap(blob);
}

/** Creates one in-memory production crop canvas with no DOM attachment. */
function createCropCanvas(width: number, height: number): CropCanvasPort {
  return new OffscreenCanvas(width, height) as unknown as CropCanvasPort;
}

/** Crops one visible-tab PNG according to the originating viewport geometry. */
export async function cropCapturedImage(
  blob: Blob,
  selection: ScreenshotSelection,
  dependencies: CropCapturedImageDependencies = {
    decode: decodeCapturedImage,
    createCanvas: createCropCanvas,
  },
): Promise<Blob> {
  const image = await dependencies.decode(blob);
  try {
    const rect = computePixelCrop(selection, image);
    const canvas = dependencies.createCanvas(rect.width, rect.height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Screenshot crop canvas is unavailable.');
    context.drawImage(
      image,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      rect.width,
      rect.height,
    );
    const output = await canvas.convertToBlob({ type: 'image/png' });
    if (output.size <= 0) throw new Error('Screenshot crop produced an empty image.');
    return output;
  } finally {
    image.close();
  }
}
