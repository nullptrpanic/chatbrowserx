import { describe, expect, it, vi } from 'vitest';
import { ScreenshotController } from '../../src/tasks/screenshot-controller';
import { ScreenshotError } from '../../src/attachments/screenshot-error';
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
    setOverlaysHidden: vi.fn(async () => ({
      viewportWidth: selection.viewportWidth,
      viewportHeight: selection.viewportHeight,
    })),
  };
  const capture = vi.fn(async () => captured);
  const crop = vi.fn(async () => cropped);
  const persist = vi.fn(async (_blob: Blob, source: string) => ({ id: `attachment_${source}` }));
  return { captured, cropped, page, capture, crop, persist };
}

describe('ScreenshotController', () => {
  it.each(['before', 'after'] as const)(
    'rejects changed viewport %s capture without storing a wrong crop',
    async (phase) => {
      const deps = fixture();
      if (phase === 'after')
        deps.page.setOverlaysHidden.mockResolvedValueOnce({
          viewportWidth: 500,
          viewportHeight: 400,
        });
      deps.page.setOverlaysHidden.mockResolvedValueOnce({
        viewportWidth: 700,
        viewportHeight: 400,
      });
      await expect(new ScreenshotController(deps).captureRegion(7)).rejects.toMatchObject({
        code: 'CAPTURE_GEOMETRY_CHANGED',
      });
      expect(deps.crop).not.toHaveBeenCalled();
      expect(deps.persist).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['selectRegion', 'SELECTION_FAILED'],
    ['crop', 'IMAGE_PROCESSING_FAILED'],
    ['persist', 'IMAGE_PROCESSING_FAILED'],
  ] as const)('reports a safe %s failure without private error details', async (stage, code) => {
    const deps = fixture();
    const operation = stage === 'selectRegion' ? deps.page.selectRegion : deps[stage];
    operation.mockRejectedValueOnce(new Error('private browser and image details'));
    const error: unknown = await new ScreenshotController(deps)
      .captureRegion(7)
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain('private browser and image details');
  });

  it('preserves the known tab-switch reason without saving a wrong-page image', async () => {
    const deps = fixture();
    deps.capture.mockRejectedValueOnce(new ScreenshotError('TAB_NOT_VISIBLE'));
    await expect(new ScreenshotController(deps).captureRegion(7)).rejects.toMatchObject({
      code: 'TAB_NOT_VISIBLE',
    });
    expect(deps.crop).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
    expect(deps.page.setOverlaysHidden.mock.calls).toEqual([
      [7, true],
      [7, false],
    ]);
  });

  it('still captures and restores when optional overlay hiding is unavailable', async () => {
    const deps = fixture();
    deps.page.setOverlaysHidden.mockRejectedValueOnce(new Error('Page receiver unavailable'));
    await expect(new ScreenshotController(deps).captureViewport(7)).resolves.toEqual({
      id: 'attachment_viewport_capture',
    });
    expect(deps.page.setOverlaysHidden.mock.calls).toEqual([
      [7, true],
      [7, false],
    ]);
    expect(deps.persist).toHaveBeenCalledWith(deps.captured, 'viewport_capture');
  });

  it.each([true, false])(
    'does not save a region if the hidden=%s acknowledgement is lost',
    async (hidden) => {
      const deps = fixture();
      if (!hidden) deps.page.setOverlaysHidden.mockResolvedValueOnce(selection);
      deps.page.setOverlaysHidden.mockRejectedValueOnce(new Error('Page receiver disappeared'));
      await expect(new ScreenshotController(deps).captureRegion(7)).rejects.toMatchObject({
        code: 'CAPTURE_GEOMETRY_CHANGED',
      });
      expect(deps.persist).not.toHaveBeenCalled();
      expect(deps.crop).not.toHaveBeenCalled();
      expect(deps.page.setOverlaysHidden.mock.calls).toEqual([
        [7, true],
        [7, false],
      ]);
    },
  );

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
