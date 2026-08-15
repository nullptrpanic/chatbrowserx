import { describe, expect, it } from 'vitest';
import type { ObservedElement, PageObservation } from '../../../src/browser/contracts/observation';
import type { ElementTarget } from '../../../src/browser/contracts/target';
import { createElementTarget } from '../../../src/browser/contracts/target';
import { resolveTarget } from '../../../src/browser/locate/target-resolver';

/** Builds a visible semantic candidate with durable defaults. */
function buildElement(overrides: Partial<ObservedElement> = {}): ObservedElement {
  return {
    observationRef: 'observation_1:element:0',
    framePath: [],
    shadowPath: [],
    role: 'button',
    name: 'Save',
    label: null,
    text: 'Save',
    value: null,
    stableAttributes: { 'data-testid': 'save-action' },
    ancestorHint: null,
    state: { disabled: false, checked: null, selected: null, expanded: null },
    rect: { x: 20, y: 20, width: 100, height: 32 },
    visible: true,
    obscured: false,
    backendNodeId: null,
    cdpSessionId: null,
    ...overrides,
  };
}

/** Wraps candidate elements in a valid observation for resolver tests. */
function buildObservation(elements: readonly ObservedElement[]): PageObservation {
  return {
    id: 'observation_1',
    capturedAt: 1_000,
    tabId: 7,
    url: 'https://example.test/form',
    title: 'Form',
    viewport: { width: 1_280, height: 720, scrollX: 0, scrollY: 0 },
    textRegions: [],
    elements,
    frames: [],
    truncated: false,
  };
}

describe('resolveTarget', () => {
  it('resolves the same semantic target after DOM reorder and observation ID changes', () => {
    const original = buildElement();
    const savedTarget = createElementTarget(original);
    const reordered = buildObservation([
      buildElement({
        observationRef: 'observation_2:element:0',
        name: 'Cancel',
        text: 'Cancel',
        stableAttributes: { 'data-testid': 'cancel-action' },
      }),
      buildElement({
        observationRef: 'observation_2:element:1',
        rect: { ...original.rect, y: 80 },
      }),
    ]);

    expect(resolveTarget(reordered, savedTarget)).toMatchObject({
      kind: 'resolved',
      element: { role: 'button', name: 'Save', observationRef: 'observation_2:element:1' },
    });
  });

  it('uses role, accessible name, and label after a generated ID changes', () => {
    const target: ElementTarget = {
      framePath: [],
      shadowPath: [],
      role: 'textbox',
      name: 'Email',
      label: 'Email',
      text: null,
      stableAttributes: {},
      ancestorHint: null,
      lastKnownRect: null,
    };
    const replacement = buildElement({
      role: 'textbox',
      name: 'Email',
      label: 'Email',
      text: null,
      stableAttributes: {},
    });

    expect(resolveTarget(buildObservation([replacement]), target)).toMatchObject({
      kind: 'resolved',
      element: { role: 'textbox', name: 'Email' },
    });
  });

  it('reports duplicate buttons as ambiguous until an ancestor hint separates them', () => {
    const billing = buildElement({
      observationRef: 'billing-save',
      ancestorHint: 'Billing',
      stableAttributes: {},
    });
    const shipping = buildElement({
      observationRef: 'shipping-save',
      ancestorHint: 'Shipping',
      stableAttributes: {},
      rect: { x: 20, y: 120, width: 100, height: 32 },
    });
    const target = createElementTarget(billing, null);
    const withoutAncestor = { ...target, ancestorHint: null, lastKnownRect: null };

    expect(resolveTarget(buildObservation([billing, shipping]), withoutAncestor)).toMatchObject({
      kind: 'ambiguous',
      candidates: [{ name: 'Save' }, { name: 'Save' }],
    });
    expect(
      resolveTarget(buildObservation([billing, shipping]), {
        ...withoutAncestor,
        ancestorHint: 'Billing',
      }),
    ).toMatchObject({ kind: 'resolved', element: { observationRef: 'billing-save' } });
  });

  it('penalizes disabled candidates instead of selecting the first semantic match', () => {
    const disabled = buildElement({
      observationRef: 'disabled-save',
      stableAttributes: { 'data-testid': 'save-action' },
      state: { disabled: true, checked: null, selected: null, expanded: null },
    });
    const enabled = buildElement({
      observationRef: 'enabled-save',
      stableAttributes: {},
      rect: { x: 20, y: 80, width: 100, height: 32 },
    });
    const target = createElementTarget(disabled);

    expect(resolveTarget(buildObservation([disabled, enabled]), target)).toMatchObject({
      kind: 'resolved',
      element: { observationRef: 'enabled-save' },
    });
  });

  it('returns not_found when the durable target disappeared', () => {
    const target = createElementTarget(buildElement());
    const observation = buildObservation([
      buildElement({ name: 'Cancel', text: 'Cancel', stableAttributes: {} }),
    ]);

    expect(resolveTarget(observation, target)).toMatchObject({ kind: 'not_found' });
  });
});
