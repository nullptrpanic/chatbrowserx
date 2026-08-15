import { describe, expect, it } from 'vitest';
import type { ObservedElement, PageObservation } from '../../../src/browser/contracts/observation';
import { mergeObservations } from '../../../src/browser/observe/merge-observations';

/**
 * Builds a semantic element whose individual fields can be varied per observation source.
 */
function buildElement(overrides: Partial<ObservedElement> = {}): ObservedElement {
  return {
    observationRef: 'observation:element:0',
    framePath: [],
    shadowPath: [],
    role: 'textbox',
    name: 'Email',
    label: 'Email',
    text: null,
    value: 'live@example.test',
    stableAttributes: { id: 'email' },
    ancestorHint: null,
    state: { disabled: false, checked: null, selected: null, expanded: null },
    rect: { x: 20, y: 20, width: 160, height: 32 },
    visible: true,
    obscured: false,
    backendNodeId: null,
    cdpSessionId: null,
    ...overrides,
  };
}

/**
 * Builds a minimal valid page observation around supplied semantic elements.
 */
function buildObservation(id: string, elements: readonly ObservedElement[]): PageObservation {
  return {
    id,
    capturedAt: 1_000,
    tabId: 7,
    url: 'https://example.test/form',
    title: 'Account form',
    viewport: { width: 1_280, height: 720, scrollX: 0, scrollY: 0 },
    textRegions: [],
    elements,
    frames: [],
    truncated: false,
  };
}

describe('mergeObservations', () => {
  it('prefers live DOM state while adding CDP backend hints and inaccessible candidates', () => {
    const domElement = buildElement();
    const cdpElement = buildElement({
      observationRef: 'cdp:element:0',
      value: 'stale@example.test',
      backendNodeId: 101,
      cdpSessionId: null,
    });
    const crossFrame = buildElement({
      observationRef: 'cdp:element:1',
      role: 'button',
      name: 'Remote Save',
      label: null,
      value: null,
      stableAttributes: { 'data-testid': 'remote-save' },
      framePath: [{ index: 0, name: 'remote', title: null, origin: 'https://frame.example' }],
      rect: { x: 10, y: 10, width: 100, height: 32 },
      backendNodeId: 202,
      cdpSessionId: 'session_remote',
    });

    const merged = mergeObservations(
      buildObservation('dom_observation', [domElement]),
      buildObservation('cdp_observation', [cdpElement, crossFrame]),
    );

    expect(merged.id).toBe('dom_observation');
    expect(merged.elements).toHaveLength(2);
    expect(merged.elements[0]).toMatchObject({
      observationRef: domElement.observationRef,
      value: 'live@example.test',
      backendNodeId: 101,
      cdpSessionId: null,
    });
    expect(merged.elements[1]).toMatchObject({
      name: 'Remote Save',
      backendNodeId: 202,
      cdpSessionId: 'session_remote',
    });
  });

  it('does not merge equal names from different frame paths', () => {
    const top = buildElement({ role: 'button', name: 'Save' });
    const framed = buildElement({
      role: 'button',
      name: 'Save',
      backendNodeId: 44,
      framePath: [{ index: 0, name: 'child', title: null, origin: 'https://example.test' }],
    });

    const merged = mergeObservations(
      buildObservation('dom', [top]),
      buildObservation('cdp', [framed]),
    );

    expect(merged.elements).toHaveLength(2);
  });
});
