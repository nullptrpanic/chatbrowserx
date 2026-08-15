import { describe, expect, it, vi } from 'vitest';
import { computePixelCrop, cropCapturedImage } from '../../src/attachments/crop-captured-image';

describe('cropCapturedImage', () => {
  it('maps CSS selection coordinates to source-image pixels', () => {
    expect(
      computePixelCrop(
        {
          rect: { x: 10, y: 5, width: 20, height: 10 },
          devicePixelRatio: 2,
          viewportWidth: 100,
          viewportHeight: 50,
        },
        { width: 200, height: 100 },
      ),
    ).toEqual({ x: 20, y: 10, width: 40, height: 20 });
  });

  it('draws the clamped crop and closes its decoded image', async () => {
    const close = vi.fn();
    const drawImage = vi.fn();
    const output = new Blob(['crop'], { type: 'image/png' });
    const convertToBlob = vi.fn(async () => output);
    const source = { width: 200, height: 100, close };
    const createCanvas = vi.fn(() => ({
      getContext: () => ({ drawImage }),
      convertToBlob,
    }));

    await expect(
      cropCapturedImage(
        new Blob(['source']),
        {
          rect: { x: 10, y: 5, width: 20, height: 10 },
          devicePixelRatio: 2,
          viewportWidth: 100,
          viewportHeight: 50,
        },
        { decode: vi.fn(async () => source), createCanvas },
      ),
    ).resolves.toBe(output);

    expect(createCanvas).toHaveBeenCalledWith(40, 20);
    expect(drawImage).toHaveBeenCalledWith(source, 20, 10, 40, 20, 0, 0, 40, 20);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
