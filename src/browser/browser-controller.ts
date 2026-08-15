import type { Clock } from '../shared/time';
import type { BrowserActionRequest } from './contracts/action';
import type { BrowserActionEvidence } from './contracts/evidence';
import type { PageObservation } from './contracts/observation';
import type { ActionDriver, ActionDriverContext } from './act/action-driver';
import { ActionExecutionError } from './act/action-errors';
import { resolveTarget } from './locate/target-resolver';
import { mergeObservations } from './observe/merge-observations';
import type { CdpObservationInput } from './observe/cdp-observer';
import type { DriverCapability } from './route/driver-capabilities';
import type { DriverOutcomeKind, DriverOutcomeRepository } from './route/driver-outcomes';
import type { DriverRouter } from './route/driver-router';
import type { VerificationRequest, VerificationResult } from './verify/verification-engine';

export interface BrowserObserveRequest {
  readonly tabId: number;
  readonly ownerId: string;
}

export interface BrowserExecuteRequest {
  readonly ownerId: string;
  readonly outcomeId: string;
  readonly action: BrowserActionRequest;
}

export interface BrowserVerificationOutcomeRequest {
  readonly outcomeId: string;
  readonly evidence: BrowserActionEvidence;
  readonly verification: VerificationResult;
}

export interface BrowserControllerDependencies {
  readonly tabs: { get(tabId: number): Promise<{ readonly url: string; readonly title: string }> };
  readonly domObserver: {
    observe(input: {
      readonly tabId: number;
      readonly url: string;
    }): Promise<PageObservation | null>;
    release(tabId: number): Promise<void>;
  };
  readonly cdpObserver: { observe(input: CdpObservationInput): Promise<PageObservation> };
  readonly debugger: {
    acquire(tabId: number, ownerId: string): Promise<void>;
    release(tabId: number, ownerId: string): Promise<void>;
    isAttached(tabId: number): boolean;
  };
  readonly drivers: Readonly<Record<'dom' | 'cdp', ActionDriver>>;
  readonly router: DriverRouter;
  readonly outcomes: DriverOutcomeRepository;
  readonly verifier: { verify(request: VerificationRequest): Promise<VerificationResult> };
  readonly clock: Clock;
}

/** Returns a normalized origin or the empty opaque-origin marker for unsupported URLs. */
function readOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** Maps a non-successful driver report into the rolling routing outcome vocabulary. */
function unsuccessfulEvidenceOutcome(evidence: BrowserActionEvidence): DriverOutcomeKind {
  if (evidence.status === 'blocked') return 'target_failure';
  if (evidence.status === 'failed') return 'transport_failure';
  return 'no_effect';
}

/** Returns whether a resolved element requires a child CDP session for safe interaction. */
function requiresCrossOriginDriver(
  element: PageObservation['elements'][number] | null,
  pageOrigin: string,
): boolean {
  const targetOrigin = element?.framePath.at(-1)?.origin;
  return (
    (element?.cdpSessionId !== null && element?.cdpSessionId !== undefined) ||
    (targetOrigin !== undefined && targetOrigin !== null && targetOrigin !== pageOrigin)
  );
}

export class BrowserController {
  readonly #dependencies: BrowserControllerDependencies;
  readonly #debuggerOwners = new Set<string>();

  /** Creates the orchestration boundary for observation, action, verification, and release. */
  constructor(dependencies: BrowserControllerDependencies) {
    this.#dependencies = dependencies;
  }

  /** Merges available DOM and CDP semantic data while tolerating either optional source failing. */
  async observe(request: BrowserObserveRequest): Promise<PageObservation> {
    const tab = await this.#dependencies.tabs.get(request.tabId);
    const dom = await this.#dependencies.domObserver
      .observe({ tabId: request.tabId, url: tab.url })
      .catch(() => null);

    const ownerKey = this.#ownerKey(request.tabId, request.ownerId);
    const cdp = await (async (): Promise<PageObservation> => {
      if (
        !this.#debuggerOwners.has(ownerKey) ||
        !this.#dependencies.debugger.isAttached(request.tabId)
      ) {
        await this.#dependencies.debugger.acquire(request.tabId, request.ownerId);
        this.#debuggerOwners.add(ownerKey);
      }
      const now = this.#dependencies.clock.now();
      const input: CdpObservationInput = {
        id: dom?.id ?? `observation_${String(request.tabId)}_${String(now)}`,
        capturedAt: now,
        tabId: request.tabId,
        url: dom?.url ?? tab.url,
        title: dom?.title ?? tab.title,
        viewport: dom?.viewport ?? { width: 0, height: 0, scrollX: 0, scrollY: 0 },
      };
      return this.#dependencies.cdpObserver.observe(input);
    })().catch(() => null);

    if (dom !== null && cdp !== null) return mergeObservations(dom, cdp);
    if (dom !== null) return dom;
    if (cdp !== null) return cdp;
    throw new ActionExecutionError('ACTION_FAILED', 'No browser observation source is available.');
  }

  /** Resolves targets, selects a capable adaptive driver, and defers success until verification. */
  async execute(request: BrowserExecuteRequest): Promise<BrowserActionEvidence> {
    const observation = await this.observe({
      tabId: request.action.tabId,
      ownerId: request.ownerId,
    });
    const target =
      'target' in request.action && request.action.target !== null
        ? this.#resolve(observation, request.action.target)
        : null;
    const destination =
      request.action.type === 'drag'
        ? this.#resolve(observation, request.action.destination)
        : null;
    const origin = readOrigin(observation.url);
    const requiredCapabilities: DriverCapability[] = [];
    if (
      requiresCrossOriginDriver(target, origin) ||
      requiresCrossOriginDriver(destination, origin)
    ) {
      requiredCapabilities.push('cross_origin_frame');
    }
    const selection = await this.#dependencies.router.select({
      origin,
      actionKind: request.action.type,
      requiredCapabilities,
    });
    const context: ActionDriverContext = { target, destination };
    const startedAt = this.#dependencies.clock.now();
    try {
      const evidence = await this.#dependencies.drivers[selection.driver].execute(
        request.action,
        context,
      );
      if (evidence.status !== 'executed') {
        await this.#recordOutcome(
          request.outcomeId,
          evidence,
          unsuccessfulEvidenceOutcome(evidence),
        );
      }
      return evidence;
    } catch (error) {
      await this.#dependencies.outcomes
        .record({
          id: request.outcomeId,
          origin,
          actionKind: request.action.type,
          driver: selection.driver,
          outcome: error instanceof ActionExecutionError ? 'target_failure' : 'transport_failure',
          durationMs: Math.max(0, this.#dependencies.clock.now() - startedAt),
          recordedAt: this.#dependencies.clock.now(),
        })
        .catch(() => undefined);
      throw error;
    }
  }

  /** Delegates explicit post-action verification without conflating it with command dispatch. */
  verify(request: VerificationRequest): Promise<VerificationResult> {
    return this.#dependencies.verifier.verify(request);
  }

  /** Records a command as successful only when its declared page effect was verified. */
  async recordVerification(request: BrowserVerificationOutcomeRequest): Promise<void> {
    const waitOutcome = request.verification.satisfied ? 'success' : 'no_effect';
    await this.#recordOutcome(
      request.outcomeId,
      request.evidence,
      request.evidence.actionKind === 'waitFor'
        ? waitOutcome
        : request.evidence.status === 'executed'
          ? request.verification.satisfied
            ? 'success'
            : 'no_effect'
          : unsuccessfulEvidenceOutcome(request.evidence),
    );
  }

  /** Releases debugger ownership and any transient page channel associated with one tab. */
  async release(tabId: number, ownerId: string): Promise<void> {
    const ownerKey = this.#ownerKey(tabId, ownerId);
    this.#debuggerOwners.delete(ownerKey);
    await this.#dependencies.debugger.release(tabId, ownerId);
    await this.#dependencies.domObserver.release(tabId);
  }

  /** Resolves one target or returns a stable ambiguity/not-found action failure. */
  #resolve(
    observation: PageObservation,
    target: Extract<BrowserActionRequest, { readonly target: unknown }>['target'],
  ) {
    if (target === null) return null;
    const resolution = resolveTarget(observation, target);
    if (resolution.kind === 'not_found') {
      throw new ActionExecutionError('TARGET_NOT_FOUND', 'Browser target could not be found.');
    }
    if (resolution.kind === 'ambiguous') {
      throw new ActionExecutionError('TARGET_AMBIGUOUS', 'Browser target is ambiguous.');
    }
    return resolution.element;
  }

  /** Produces an unambiguous in-memory ownership key for one tab and task runner. */
  #ownerKey(tabId: number, ownerId: string): string {
    return `${String(tabId)}:${ownerId.length}:${ownerId}`;
  }

  /** Persists one idempotent verified driver sample for adaptive routing. */
  #recordOutcome(
    id: string,
    evidence: BrowserActionEvidence,
    outcome: DriverOutcomeKind,
  ): Promise<void> {
    return this.#dependencies.outcomes
      .record({
        id,
        origin: readOrigin(evidence.beforeUrl),
        actionKind: evidence.actionKind,
        driver: evidence.driver,
        outcome,
        durationMs: Math.max(0, evidence.finishedAt - evidence.startedAt),
        recordedAt: this.#dependencies.clock.now(),
      })
      .catch(() => undefined);
  }
}
