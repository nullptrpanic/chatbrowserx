import type { Clock } from '../../shared/time';
import type { PageObservation } from '../contracts/observation';
import { resolveTarget, TARGET_MINIMUM_SCORE } from '../locate/target-resolver';
import { scoreTargetCandidate } from '../locate/target-score';
import type { DomConditionWaiter } from './dom-condition-waiter';
import type { ExpectedCondition } from './expected-condition';

export interface VerificationTab {
  readonly id: number;
  readonly openerTabId: number | null;
  readonly url: string;
}

export interface VerificationDependencies {
  readonly observations: { observe(tabId: number): Promise<PageObservation> };
  readonly tabs: {
    getUrl(tabId: number): Promise<string>;
    list(): Promise<readonly VerificationTab[]>;
  };
  readonly waiter: DomConditionWaiter;
  readonly navigation: {
    waitForStable(
      tabId: number,
      quietMs: number,
      timeoutMs: number,
      signal?: AbortSignal,
    ): Promise<{ readonly satisfied: boolean; readonly quietMs: number }>;
  };
  readonly clock: Clock;
}

export interface VerificationRequest {
  readonly tabId: number;
  readonly condition: ExpectedCondition;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface VerificationEvidence {
  readonly kind: ExpectedCondition['type'];
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export interface VerificationResult {
  readonly satisfied: boolean;
  readonly timedOut: boolean;
  readonly checkedAt: number;
  readonly evidence: VerificationEvidence;
}

interface ConditionCheck {
  readonly satisfied: boolean;
  readonly evidence: VerificationEvidence;
}

/** Compares a bounded integer count through the explicit condition operator. */
function compareCount(count: number, operator: 'eq' | 'gt' | 'lt', value: number): boolean {
  if (operator === 'eq') return count === value;
  if (operator === 'gt') return count > value;
  return count < value;
}

/** Compiles a bounded URL pattern and treats malformed patterns as an unsatisfied condition. */
function matchesUrl(url: string, pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > 500) return false;
  try {
    return new RegExp(pattern).test(url);
  } catch {
    return false;
  }
}

export class VerificationEngine {
  readonly #dependencies: VerificationDependencies;

  /** Creates a condition engine over fresh observations, tabs, events, and an injected clock. */
  constructor(dependencies: VerificationDependencies) {
    this.#dependencies = dependencies;
  }

  /** Waits until the declared effect is observed, times out, or the caller aborts. */
  async verify(request: VerificationRequest): Promise<VerificationResult> {
    if (request.condition.type === 'page.stable') {
      const stable = await this.#dependencies.navigation.waitForStable(
        request.tabId,
        request.condition.quietMs,
        request.timeoutMs,
        request.signal,
      );
      return {
        satisfied: stable.satisfied,
        timedOut: !stable.satisfied,
        checkedAt: this.#dependencies.clock.now(),
        evidence: {
          kind: 'page.stable',
          details: { quietMs: stable.quietMs },
        },
      };
    }

    let evidence: VerificationEvidence = {
      kind: request.condition.type,
      details: {},
    };
    const waited = await this.#dependencies.waiter.waitFor(
      async () => {
        const checked = await this.#check(request.tabId, request.condition);
        evidence = checked.evidence;
        return checked.satisfied;
      },
      request.signal === undefined
        ? { timeoutMs: request.timeoutMs }
        : { timeoutMs: request.timeoutMs, signal: request.signal },
    );
    return {
      satisfied: waited.satisfied,
      timedOut: waited.timedOut,
      checkedAt: this.#dependencies.clock.now(),
      evidence,
    };
  }

  /** Evaluates one condition against a fresh minimal source and returns bounded evidence. */
  async #check(tabId: number, condition: ExpectedCondition): Promise<ConditionCheck> {
    switch (condition.type) {
      case 'url.changed': {
        const url = await this.#dependencies.tabs.getUrl(tabId);
        return {
          satisfied: url !== condition.from,
          evidence: { kind: condition.type, details: { changed: url !== condition.from } },
        };
      }
      case 'url.matches': {
        const url = await this.#dependencies.tabs.getUrl(tabId);
        const matched = matchesUrl(url, condition.pattern);
        return { satisfied: matched, evidence: { kind: condition.type, details: { matched } } };
      }
      case 'tab.opened': {
        const tabs = await this.#dependencies.tabs.list();
        const opened = tabs.some((tab) => tab.openerTabId === condition.openerTabId);
        return { satisfied: opened, evidence: { kind: condition.type, details: { opened } } };
      }
      case 'text.contains': {
        const observation = await this.#dependencies.observations.observe(tabId);
        const expected = condition.text.toLocaleLowerCase();
        const found =
          observation.textRegions.some((region) =>
            region.text.toLocaleLowerCase().includes(expected),
          ) ||
          observation.elements.some((element) =>
            [element.name, element.label, element.text]
              .filter((value): value is string => value !== null)
              .some((value) => value.toLocaleLowerCase().includes(expected)),
          );
        return { satisfied: found, evidence: { kind: condition.type, details: { found } } };
      }
      case 'element.count': {
        const observation = await this.#dependencies.observations.observe(tabId);
        const count = observation.elements.filter(
          (element) => scoreTargetCandidate(condition.target, element) >= TARGET_MINIMUM_SCORE,
        ).length;
        return {
          satisfied: compareCount(count, condition.operator, condition.value),
          evidence: { kind: condition.type, details: { count } },
        };
      }
      case 'element.value': {
        const observation = await this.#dependencies.observations.observe(tabId);
        const resolution = resolveTarget(observation, condition.target);
        const value = resolution.kind === 'resolved' ? resolution.element.value : null;
        return {
          satisfied: value === condition.equals,
          evidence: { kind: condition.type, details: { matched: value === condition.equals } },
        };
      }
      case 'element.visible': {
        const observation = await this.#dependencies.observations.observe(tabId);
        const resolution = resolveTarget(observation, condition.target);
        const visible = resolution.kind === 'resolved' && resolution.element.visible;
        return {
          satisfied: visible === condition.visible,
          evidence: { kind: condition.type, details: { visible } },
        };
      }
      case 'element.checked': {
        const observation = await this.#dependencies.observations.observe(tabId);
        const resolution = resolveTarget(observation, condition.target);
        const checked = resolution.kind === 'resolved' ? resolution.element.state.checked : null;
        return {
          satisfied: checked === condition.checked,
          evidence: { kind: condition.type, details: { checked } },
        };
      }
      case 'page.stable':
        return {
          satisfied: false,
          evidence: { kind: condition.type, details: { delegated: true } },
        };
    }
  }
}
