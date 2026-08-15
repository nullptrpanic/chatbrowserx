import { describe, expect, it, vi } from 'vitest';
import type { PageObservation } from '../../../src/browser/contracts/observation';
import {
  ChromePageObservationSource,
  type PageObservationSourceDependencies,
} from '../../../src/platform/chrome/page-observation-source';

/** Builds an empty but valid content-script observation response. */
function buildObservation(): PageObservation {
  return {
    id: 'observation_1',
    capturedAt: 1_000,
    tabId: 7,
    url: 'https://example.test/form',
    title: 'Form',
    viewport: { width: 1_280, height: 720, scrollX: 0, scrollY: 0 },
    textRegions: [],
    elements: [],
    frames: [],
    truncated: false,
  };
}

describe('ChromePageObservationSource', () => {
  it('returns null without messaging when optional origin permission is missing', async () => {
    const dependencies: PageObservationSourceDependencies = {
      installer: {
        ensureInstalled: vi.fn(async () => ({
          status: 'permission_required' as const,
          originPattern: 'https://example.test/*',
        })),
      },
      messages: { sendMessage: vi.fn() },
      clock: { now: () => 1_000 },
      ids: { create: () => 'observation_1' },
    };
    const source = new ChromePageObservationSource(dependencies);

    await expect(
      source.observe({ tabId: 7, url: 'https://example.test/form' }),
    ).resolves.toBeNull();
    expect(dependencies.messages.sendMessage).not.toHaveBeenCalled();
  });

  it('installs on demand and validates a correlated page observation response', async () => {
    const observation = buildObservation();
    const dependencies: PageObservationSourceDependencies = {
      installer: {
        ensureInstalled: vi.fn(async () => ({
          status: 'installed' as const,
          originPattern: 'https://example.test/*',
        })),
      },
      messages: {
        sendMessage: vi.fn(async (_tabId, message) => ({
          version: 1,
          requestId: message.requestId,
          ok: true,
          data: observation,
        })),
      },
      clock: { now: () => 1_000 },
      ids: { create: () => 'observation_1' },
    };
    const source = new ChromePageObservationSource(dependencies);

    await expect(source.observe({ tabId: 7, url: 'https://example.test/form' })).resolves.toEqual(
      observation,
    );
    expect(dependencies.messages.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: 'page.observe',
        payload: { observationId: 'observation_1', tabId: 7, capturedAt: 1_000 },
      }),
    );
  });
});
