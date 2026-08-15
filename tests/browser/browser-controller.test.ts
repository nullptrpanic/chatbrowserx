import { describe, expect, it, vi } from 'vitest';
import type { ActionDriver } from '../../src/browser/act/action-driver';
import type { BrowserActionRequest } from '../../src/browser/contracts/action';
import type { ObservedElement, PageObservation } from '../../src/browser/contracts/observation';
import { createElementTarget } from '../../src/browser/contracts/target';
import {
  BrowserController,
  type BrowserControllerDependencies,
} from '../../src/browser/browser-controller';
import { InMemoryDriverOutcomeRepository } from '../../src/browser/route/driver-outcomes';
import { DriverRouter } from '../../src/browser/route/driver-router';

/** Builds a semantic button from either the DOM or CDP source. */
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

/** Wraps elements in a source-specific observation. */
function buildObservation(id: string, elements: readonly ObservedElement[]): PageObservation {
  return {
    id,
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

/** Creates controller dependencies with mergeable observations and inspectable collaborators. */
function buildDependencies() {
  const domElement = buildElement();
  const cdpElement = buildElement({
    observationRef: 'observation_1:cdp-element:0',
    backendNodeId: 101,
  });
  const domObservation = buildObservation('observation_1', [domElement]);
  const cdpObservation = buildObservation('observation_1', [cdpElement]);
  const acquire = vi.fn(async () => undefined);
  const release = vi.fn(async () => undefined);
  const isAttached = vi.fn(() => true);
  const domExecute = vi.fn<ActionDriver['execute']>(async (request) => ({
    actionId: request.actionId,
    actionKind: request.type,
    driver: 'dom',
    status: 'executed',
    startedAt: 1_000,
    finishedAt: 1_100,
    resolvedTarget: { role: 'button', name: 'Save', frameDepth: 0, shadowDepth: 0 },
    beforeUrl: domObservation.url,
    afterUrl: domObservation.url,
    commandResult: {},
  }));
  const cdpExecute = vi.fn<ActionDriver['execute']>(async (request) => ({
    actionId: request.actionId,
    actionKind: request.type,
    driver: 'cdp',
    status: 'executed',
    startedAt: 1_000,
    finishedAt: 1_100,
    resolvedTarget: { role: 'button', name: 'Save', frameDepth: 0, shadowDepth: 0 },
    beforeUrl: cdpObservation.url,
    afterUrl: cdpObservation.url,
    commandResult: {},
  }));
  const verify = vi.fn(async () => ({
    satisfied: true,
    timedOut: false,
    checkedAt: 1_200,
    evidence: { kind: 'page.stable' as const, details: { quietMs: 300 } },
  }));
  const outcomes = new InMemoryDriverOutcomeRepository();
  const dependencies: BrowserControllerDependencies = {
    tabs: { get: async () => ({ url: domObservation.url, title: domObservation.title }) },
    domObserver: {
      observe: vi.fn(async () => domObservation),
      release: vi.fn(async () => undefined),
    },
    cdpObserver: { observe: vi.fn(async () => cdpObservation) },
    debugger: { acquire, release, isAttached },
    drivers: {
      dom: { kind: 'dom', execute: domExecute },
      cdp: { kind: 'cdp', execute: cdpExecute },
    },
    router: new DriverRouter(outcomes),
    outcomes,
    verifier: { verify },
    clock: { now: () => 2_000 },
  };
  return {
    dependencies,
    domElement,
    acquire,
    release,
    isAttached,
    domExecute,
    cdpExecute,
    verify,
  };
}

describe('BrowserController', () => {
  it('merges DOM live state with CDP backend hints during observation', async () => {
    const fixture = buildDependencies();
    const controller = new BrowserController(fixture.dependencies);

    const observation = await controller.observe({ tabId: 7, ownerId: 'task_1' });

    expect(fixture.acquire).toHaveBeenCalledWith(7, 'task_1');
    expect(observation.elements).toHaveLength(1);
    expect(observation.elements[0]).toMatchObject({
      value: fixture.domElement.value,
      backendNodeId: 101,
    });
  });

  it('reacquires CDP when Chrome detached the debugger behind a retained task owner', async () => {
    const fixture = buildDependencies();
    fixture.isAttached.mockReturnValue(false);
    const controller = new BrowserController(fixture.dependencies);

    await controller.observe({ tabId: 7, ownerId: 'task_1' });
    await controller.observe({ tabId: 7, ownerId: 'task_1' });

    expect(fixture.acquire).toHaveBeenCalledTimes(2);
  });

  it('learns success only after explicit effect verification', async () => {
    const fixture = buildDependencies();
    const controller = new BrowserController(fixture.dependencies);
    const action: BrowserActionRequest = {
      actionId: 'action_1',
      tabId: 7,
      type: 'click',
      target: createElementTarget(fixture.domElement),
      risk: 'low',
      expected: { type: 'page.stable', quietMs: 300 },
    };

    const evidence = await controller.execute({
      ownerId: 'task_1',
      outcomeId: 'task_1:action_1:1',
      action,
    });
    expect(evidence).toMatchObject({
      driver: 'dom',
      status: 'executed',
    });
    expect(fixture.domExecute).toHaveBeenCalledWith(
      action,
      expect.objectContaining({ target: expect.objectContaining({ backendNodeId: 101 }) }),
    );
    expect(fixture.cdpExecute).not.toHaveBeenCalled();
    expect(fixture.verify).not.toHaveBeenCalled();
    await expect(
      fixture.dependencies.outcomes.list('https://example.test', 'click'),
    ).resolves.toEqual([]);

    const verification = await controller.verify({
      tabId: 7,
      condition: action.expected,
      timeoutMs: 5_000,
    });
    await controller.recordVerification({
      outcomeId: 'task_1:action_1:1',
      evidence,
      verification,
    });
    await expect(
      fixture.dependencies.outcomes.list('https://example.test', 'click'),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'task_1:action_1:1',
        driver: 'dom',
        outcome: 'success',
      }),
    ]);
  });

  it('delegates explicit verification and releases debugger plus transient page state', async () => {
    const fixture = buildDependencies();
    const controller = new BrowserController(fixture.dependencies);
    const verification = {
      tabId: 7,
      condition: { type: 'page.stable' as const, quietMs: 300 },
      timeoutMs: 5_000,
    };

    await controller.verify(verification);
    await controller.release(7, 'task_1');

    expect(fixture.verify).toHaveBeenCalledWith(verification);
    expect(fixture.release).toHaveBeenCalledWith(7, 'task_1');
    expect(fixture.dependencies.domObserver.release).toHaveBeenCalledWith(7);
  });

  it('does not fail a verified browser action when adaptive outcome storage is unavailable', async () => {
    const fixture = buildDependencies();
    const controller = new BrowserController(fixture.dependencies);
    vi.spyOn(fixture.dependencies.outcomes, 'record').mockRejectedValue(
      new Error('storage unavailable'),
    );

    await expect(
      controller.recordVerification({
        outcomeId: 'task_1:action_1:1',
        evidence: {
          actionId: 'action_1',
          actionKind: 'click',
          driver: 'dom',
          status: 'executed',
          startedAt: 1_000,
          finishedAt: 1_100,
          resolvedTarget: null,
          beforeUrl: 'https://example.test/form',
          afterUrl: 'https://example.test/form',
          commandResult: {},
        },
        verification: {
          satisfied: true,
          timedOut: false,
          checkedAt: 1_200,
          evidence: { kind: 'page.stable', details: { quietMs: 300 } },
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('learns a verified wait condition as success even though no driver effect is required', async () => {
    const fixture = buildDependencies();
    const controller = new BrowserController(fixture.dependencies);

    await controller.recordVerification({
      outcomeId: 'task_1:wait_1:1',
      evidence: {
        actionId: 'wait_1',
        actionKind: 'waitFor',
        driver: 'dom',
        status: 'unsupported',
        startedAt: 1_000,
        finishedAt: 1_000,
        resolvedTarget: null,
        beforeUrl: 'https://example.test/form',
        afterUrl: 'https://example.test/form',
        commandResult: { reason: 'verification_engine_required' },
      },
      verification: {
        satisfied: true,
        timedOut: false,
        checkedAt: 1_200,
        evidence: { kind: 'text.contains', details: { found: true } },
      },
    });

    await expect(
      fixture.dependencies.outcomes.list('https://example.test', 'waitFor'),
    ).resolves.toEqual([expect.objectContaining({ outcome: 'success' })]);
  });

  it('preserves the driver error when failure-outcome storage is unavailable', async () => {
    const fixture = buildDependencies();
    const controller = new BrowserController(fixture.dependencies);
    const originalError = new Error('driver disconnected');
    fixture.domExecute.mockRejectedValueOnce(originalError);
    vi.spyOn(fixture.dependencies.outcomes, 'record').mockRejectedValue(
      new Error('storage unavailable'),
    );

    await expect(
      controller.execute({
        ownerId: 'task_1',
        outcomeId: 'task_1:action_failure:1',
        action: {
          actionId: 'action_failure',
          tabId: 7,
          type: 'click',
          target: createElementTarget(fixture.domElement),
          risk: 'low',
          expected: { type: 'page.stable', quietMs: 300 },
        },
      }),
    ).rejects.toBe(originalError);
  });

  it('routes a cross-origin target through the fresh child CDP session', async () => {
    const fixture = buildDependencies();
    const remotePath = [
      { index: 0, name: 'remote', title: 'Remote frame', origin: 'https://frame.example' },
    ];
    const remote = buildElement({
      observationRef: 'observation_1:cdp-session_remote:element:0',
      name: 'Continue',
      framePath: remotePath,
      backendNodeId: 301,
      cdpSessionId: 'session_remote',
    });
    vi.mocked(fixture.dependencies.domObserver.observe).mockResolvedValue(
      buildObservation('observation_1', []),
    );
    vi.mocked(fixture.dependencies.cdpObserver.observe).mockResolvedValue(
      buildObservation('observation_1', [remote]),
    );
    const controller = new BrowserController(fixture.dependencies);
    const action: BrowserActionRequest = {
      actionId: 'action_remote',
      tabId: 7,
      type: 'click',
      target: createElementTarget(remote),
      risk: 'low',
      expected: { type: 'page.stable', quietMs: 300 },
    };

    await controller.execute({
      ownerId: 'task_1',
      outcomeId: 'task_1:action_remote:1',
      action,
    });

    expect(fixture.cdpExecute).toHaveBeenCalledWith(
      action,
      expect.objectContaining({
        target: expect.objectContaining({ cdpSessionId: 'session_remote' }),
      }),
    );
    expect(fixture.domExecute).not.toHaveBeenCalled();
  });

  it('keeps a CDP-only target on its child session even when the frame origin matches', async () => {
    const fixture = buildDependencies();
    const child = buildElement({
      observationRef: 'observation_1:cdp-session_child:element:0',
      framePath: [
        {
          index: 0,
          name: 'isolated',
          title: 'Isolated frame',
          origin: 'https://example.test',
        },
      ],
      backendNodeId: 302,
      cdpSessionId: 'session_child',
    });
    vi.mocked(fixture.dependencies.domObserver.observe).mockResolvedValue(
      buildObservation('observation_1', []),
    );
    vi.mocked(fixture.dependencies.cdpObserver.observe).mockResolvedValue(
      buildObservation('observation_1', [child]),
    );
    const action: BrowserActionRequest = {
      actionId: 'action_child',
      tabId: 7,
      type: 'click',
      target: createElementTarget(child),
      risk: 'low',
      expected: { type: 'page.stable', quietMs: 300 },
    };

    await new BrowserController(fixture.dependencies).execute({
      ownerId: 'task_1',
      outcomeId: 'task_1:action_child:1',
      action,
    });

    expect(fixture.cdpExecute).toHaveBeenCalledOnce();
    expect(fixture.domExecute).not.toHaveBeenCalled();
  });

  it('forces CDP when a drag destination belongs to a cross-origin child frame', async () => {
    const fixture = buildDependencies();
    const main = buildElement({ backendNodeId: 101 });
    const remote = buildElement({
      observationRef: 'observation_1:cdp-session_remote:element:1',
      name: 'Drop zone',
      text: 'Drop zone',
      framePath: [
        { index: 0, name: 'remote', title: 'Remote frame', origin: 'https://frame.example' },
      ],
      backendNodeId: 302,
      cdpSessionId: 'session_remote',
    });
    vi.mocked(fixture.dependencies.cdpObserver.observe).mockResolvedValue(
      buildObservation('observation_1', [main, remote]),
    );
    for (let index = 0; index < 5; index += 1) {
      await fixture.dependencies.outcomes.record({
        id: `dom_${String(index)}`,
        origin: 'https://example.test',
        actionKind: 'drag',
        driver: 'dom',
        outcome: 'success',
        durationMs: 10,
        recordedAt: 1_000 + index,
      });
      await fixture.dependencies.outcomes.record({
        id: `cdp_${String(index)}`,
        origin: 'https://example.test',
        actionKind: 'drag',
        driver: 'cdp',
        outcome: 'no_effect',
        durationMs: 10,
        recordedAt: 1_000 + index,
      });
    }
    const action: BrowserActionRequest = {
      actionId: 'drag_remote',
      tabId: 7,
      type: 'drag',
      target: createElementTarget(fixture.domElement),
      destination: createElementTarget(remote),
      risk: 'low',
      expected: { type: 'page.stable', quietMs: 300 },
    };

    await new BrowserController(fixture.dependencies).execute({
      ownerId: 'task_1',
      outcomeId: 'task_1:drag_remote:1',
      action,
    });

    expect(fixture.cdpExecute).toHaveBeenCalledOnce();
    expect(fixture.domExecute).not.toHaveBeenCalled();
  });
});
