import { describe, expect, it, vi } from 'vitest';
import { ScreenshotController } from '../../src/tasks/screenshot-controller';
import type { ScreenshotSelection } from '../../src/page/screenshot/screenshot-types';

const selection = {
  rect: { x: 10, y: 20, width: 100, height: 80 },
  devicePixelRatio: 2,
  viewportWidth: 500,
  viewportHeight: 400,
};

/** Builds screenshot collaborators with inspectable capture and persistence calls. */
function fixture() {
  const captured = new Blob(['capture'], { type: 'image/png' });
  const cropped = new Blob(['crop'], { type: 'image/png' });
  const page = {
    selectRegion: vi.fn(async (): Promise<ScreenshotSelection | null> => selection),
    setOverlaysHidden: vi.fn(async () => undefined),
  };
  const capture = vi.fn(async () => captured);
  const crop = vi.fn(async () => cropped);
  const persist = vi.fn(async (_blob: Blob, source: string) => ({ id: `attachment_${source}` }));
  return { captured, cropped, page, capture, crop, persist };
}

describe('ScreenshotController', () => {
  it('captures and persists the current viewport while restoring overlays', async () => {
    const deps = fixture();
    const controller = new ScreenshotController(deps);

    await expect(controller.captureViewport(7)).resolves.toEqual({
      id: 'attachment_viewport_capture',
    });
    expect(deps.page.setOverlaysHidden.mock.calls).toEqual([
      [7, true],
      [7, false],
    ]);
    expect(deps.persist).toHaveBeenCalledWith(deps.captured, 'viewport_capture');
  });

  it('selects, crops, and persists a region without capturing on cancellation', async () => {
    const deps = fixture();
    const controller = new ScreenshotController(deps);

    await expect(controller.captureRegion(7)).resolves.toEqual({
      id: 'attachment_region_capture',
    });
    expect(deps.crop).toHaveBeenCalledWith(deps.captured, selection);
    expect(deps.persist).toHaveBeenCalledWith(deps.cropped, 'region_capture');

    deps.page.selectRegion.mockResolvedValueOnce(null);
    await expect(controller.captureRegion(7)).resolves.toBeNull();
    expect(deps.capture).toHaveBeenCalledTimes(1);
  });

  it('restores overlays after capture failure', async () => {
    const deps = fixture();
    deps.capture.mockRejectedValueOnce(new Error('private capture failure'));
    const controller = new ScreenshotController(deps);

    await expect(controller.captureViewport(7)).rejects.toThrow();
    expect(deps.page.setOverlaysHidden.mock.calls).toEqual([
      [7, true],
      [7, false],
    ]);
  });
});
