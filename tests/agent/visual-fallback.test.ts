import { describe, expect, it, vi } from 'vitest';
import {
  shouldCaptureVisualFallback,
  ViewportVisualCapture,
} from '../../src/agent/visual-fallback';
import type { PageObservation } from '../../src/browser/contracts/observation';

const observation: PageObservation = {
  id: 'observation_1',
  capturedAt: 1,
  tabId: 7,
  url: 'https://example.com',
  title: 'Canvas editor',
  viewport: { width: 1200, height: 800, scrollX: 0, scrollY: 0 },
  textRegions: [],
  elements: [],
  frames: [],
  truncated: false,
};

describe('visual fallback policy', () => {
  it('captures only observations with no actionable semantics and little readable text', () => {
    expect(shouldCaptureVisualFallback(observation)).toBe(true);
    expect(
      shouldCaptureVisualFallback({
        ...observation,
        elements: [
          {
            observationRef: 'element_1',
            framePath: [],
            shadowPath: [],
            role: 'button',
            name: 'Save',
            label: null,
            text: 'Save',
            value: null,
            stableAttributes: {},
            ancestorHint: null,
            state: { disabled: false, checked: null, selected: null, expanded: null },
            rect: { x: 1, y: 1, width: 80, height: 30 },
            visible: true,
            obscured: false,
            backendNodeId: null,
            cdpSessionId: null,
          },
        ],
      }),
    ).toBe(false);
    expect(
      shouldCaptureVisualFallback({
        ...observation,
        textRegions: [
          {
            kind: 'article',
            text: 'A'.repeat(300),
            framePath: [],
            rect: { x: 0, y: 0, width: 500, height: 500 },
          },
        ],
      }),
    ).toBe(false);
  });

  it('hides owned overlays, captures a bounded image, and always restores overlays', async () => {
    const setOverlaysHidden = vi.fn(async () => undefined);
    const capture = vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
    const visuals = new ViewportVisualCapture({
      page: { setOverlaysHidden },
      capture,
    });

    await expect(visuals.capture(7)).resolves.toMatch(/^data:image\/png;base64,/);
    expect(setOverlaysHidden.mock.calls).toEqual([
      [7, true],
      [7, false],
    ]);

    capture.mockRejectedValueOnce(new Error('inactive tab'));
    await expect(visuals.capture(7)).rejects.toThrow('inactive tab');
    expect(setOverlaysHidden).toHaveBeenLastCalledWith(7, false);
  });

  it('rejects oversized or unsupported captures before encoding them', async () => {
    const page = { setOverlaysHidden: vi.fn(async () => undefined) };
    await expect(
      new ViewportVisualCapture({
        page,
        capture: vi.fn(async () => new Blob(['not-image'], { type: 'text/plain' })),
      }).capture(7),
    ).rejects.toThrow('Visual fallback image is invalid.');
  });
});
