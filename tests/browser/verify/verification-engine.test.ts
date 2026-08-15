import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObservedElement, PageObservation } from '../../../src/browser/contracts/observation';
import { createElementTarget } from '../../../src/browser/contracts/target';
import { DomConditionWaiter } from '../../../src/browser/verify/dom-condition-waiter';
import {
  VerificationEngine,
  type VerificationDependencies,
} from '../../../src/browser/verify/verification-engine';

afterEach(() => {
  vi.useRealTimers();
});

/** Builds one visible form element for verification checks. */
function buildElement(overrides: Partial<ObservedElement> = {}): ObservedElement {
  return {
    observationRef: 'observation_1:element:0',
    framePath: [],
    shadowPath: [],
    role: 'textbox',
    name: 'Message',
    label: 'Message',
    text: null,
    value: 'hello',
    stableAttributes: { id: 'message' },
    ancestorHint: null,
    state: { disabled: false, checked: null, selected: null, expanded: null },
    rect: { x: 20, y: 20, width: 120, height: 32 },
    visible: true,
    obscured: false,
    backendNodeId: null,
    cdpSessionId: null,
    ...overrides,
  };
}

/** Wraps semantic elements and text in a stable page observation. */
function buildObservation(
  elements: readonly ObservedElement[] = [buildElement()],
): PageObservation {
  return {
    id: 'observation_1',
    capturedAt: 1_000,
    tabId: 7,
    url: 'https://example.test/after',
    title: 'After',
    viewport: { width: 1_280, height: 720, scrollX: 0, scrollY: 0 },
    textRegions: [
      {
        kind: 'p',
        text: 'Saved successfully',
        framePath: [],
        rect: { x: 20, y: 80, width: 200, height: 20 },
      },
    ],
    elements,
    frames: [],
    truncated: false,
  };
}

/** Creates verification dependencies whose checks are immediately observable. */
function buildDependencies(observation = buildObservation()): VerificationDependencies {
  return {
    observations: { observe: async () => observation },
    tabs: {
      getUrl: async () => 'https://example.test/after',
      list: async () => [{ id: 8, openerTabId: 7, url: 'https://example.test/new' }],
    },
    waiter: new DomConditionWaiter(),
    navigation: {
      waitForStable: async () => ({ satisfied: true, quietMs: 500 }),
    },
    clock: { now: () => 2_000 },
  };
}

describe('VerificationEngine', () => {
  it('verifies URL, element, text, count, new-tab, and page-stable conditions', async () => {
    const element = buildElement();
    const target = createElementTarget(element);
    const checkbox = buildElement({
      observationRef: 'observation_1:element:1',
      role: 'checkbox',
      name: 'Accept',
      label: 'Accept',
      value: null,
      stableAttributes: { id: 'accept' },
      state: { disabled: false, checked: true, selected: null, expanded: null },
      rect: { x: 20, y: 60, width: 20, height: 20 },
    });
    const dependencies = buildDependencies(buildObservation([element, checkbox]));
    const verifier = new VerificationEngine(dependencies);
    const conditions = [
      { type: 'url.changed', from: 'https://example.test/before' },
      { type: 'url.matches', pattern: '/after$' },
      { type: 'element.value', target, equals: 'hello' },
      { type: 'element.visible', target, visible: true },
      {
        type: 'element.checked',
        target: createElementTarget(checkbox),
        checked: true,
      },
      { type: 'text.contains', text: 'Saved successfully' },
      { type: 'element.count', target, operator: 'eq', value: 1 },
      { type: 'tab.opened', openerTabId: 7 },
      { type: 'page.stable', quietMs: 500 },
    ] as const;

    for (const condition of conditions) {
      await expect(
        verifier.verify({ tabId: 7, condition, timeoutMs: 5_000 }),
      ).resolves.toMatchObject({
        satisfied: true,
        timedOut: false,
        evidence: { kind: condition.type },
      });
    }
  });

  it('treats a missing target as satisfying element.visible false', async () => {
    const target = createElementTarget(buildElement());
    const verifier = new VerificationEngine(buildDependencies(buildObservation([])));

    await expect(
      verifier.verify({
        tabId: 7,
        condition: { type: 'element.visible', target, visible: false },
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ satisfied: true });
  });

  it('times out at the requested bound and propagates abort without dangling timers', async () => {
    vi.useFakeTimers();
    const dependencies = buildDependencies();
    dependencies.tabs.getUrl = async () => 'https://example.test/same';
    const verifier = new VerificationEngine(dependencies);
    const pending = verifier.verify({
      tabId: 7,
      condition: { type: 'url.changed', from: 'https://example.test/same' },
      timeoutMs: 500,
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toMatchObject({ satisfied: false, timedOut: true });

    const controller = new AbortController();
    const aborted = verifier.verify({
      tabId: 7,
      condition: { type: 'url.changed', from: 'https://example.test/same' },
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
