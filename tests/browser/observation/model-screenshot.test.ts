import { describe, expect, it, vi } from 'vitest';
import { prepareModelScreenshot } from '../../../src/browser/observation/model-screenshot';

describe('prepareModelScreenshot', () => {
  it('downscales a large screenshot to a 1440 pixel longest edge', async () => {
    const close = vi.fn();
    const source = { width: 2510, height: 1600, close };
    const drawImage = vi.fn();
    const output = new Blob(['prepared'], { type: 'image/png' });
    const createCanvas = vi.fn(() => ({
      getContext: () => ({ drawImage }),
      convertToBlob: vi.fn(async () => output),
    }));

    const result = await prepareModelScreenshot(new Blob(['source'], { type: 'image/png' }), {
      decode: vi.fn(async () => source),
      createCanvas,
    });

    expect(result).toEqual({ blob: output, width: 1440, height: 918 });
    expect(createCanvas).toHaveBeenCalledWith(1440, 918);
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0, 2510, 1600, 0, 0, 1440, 918);
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps a screenshot that is already within the model bound', async () => {
    const close = vi.fn();
    const input = new Blob(['source'], { type: 'image/png' });
    const createCanvas = vi.fn(() => ({
      getContext: () => ({ drawImage: vi.fn() }),
      convertToBlob: vi.fn(async () => new Blob(['upscaled'], { type: 'image/png' })),
    }));

    const result = await prepareModelScreenshot(input, {
      decode: vi.fn(async () => ({ width: 1280, height: 720, close })),
      createCanvas,
    });

    expect(result).toEqual({ blob: input, width: 1280, height: 720 });
    expect(createCanvas).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
