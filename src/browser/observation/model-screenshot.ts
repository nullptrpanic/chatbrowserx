const MAX_MODEL_SCREENSHOT_LONG_EDGE = 1440;

export interface DecodedModelScreenshot {
  readonly width: number;
  readonly height: number;
  close(): void;
}

export interface ModelScreenshotCanvas {
  getContext(contextId: '2d'): {
    drawImage(
      image: DecodedModelScreenshot,
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

export interface ModelScreenshotDependencies {
  readonly decode: (blob: Blob) => Promise<DecodedModelScreenshot>;
  readonly createCanvas: (width: number, height: number) => ModelScreenshotCanvas;
}

export interface PreparedModelScreenshot {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
}

async function decodeModelScreenshot(blob: Blob): Promise<DecodedModelScreenshot> {
  return createImageBitmap(blob);
}

function createModelScreenshotCanvas(width: number, height: number): ModelScreenshotCanvas {
  return new OffscreenCanvas(width, height) as unknown as ModelScreenshotCanvas;
}

/** Produces one bounded PNG for model vision while retaining the screenshot aspect ratio. */
export async function prepareModelScreenshot(
  blob: Blob,
  dependencies: ModelScreenshotDependencies = {
    decode: decodeModelScreenshot,
    createCanvas: createModelScreenshotCanvas,
  },
): Promise<PreparedModelScreenshot> {
  const image = await dependencies.decode(blob);
  try {
    const longEdge = Math.max(image.width, image.height);
    if (longEdge <= MAX_MODEL_SCREENSHOT_LONG_EDGE) {
      return { blob, width: image.width, height: image.height };
    }
    const scale = MAX_MODEL_SCREENSHOT_LONG_EDGE / longEdge;
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = dependencies.createCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Model screenshot canvas is unavailable.');
    context.drawImage(image, 0, 0, image.width, image.height, 0, 0, width, height);
    const output = await canvas.convertToBlob({ type: 'image/png' });
    if (output.size <= 0 || output.type !== 'image/png') {
      throw new Error('Model screenshot preparation failed.');
    }
    return { blob: output, width, height };
  } finally {
    image.close();
  }
}
