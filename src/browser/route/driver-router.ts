import type { BrowserActionKind } from '../../tasks/task-types';
import type { DriverCapability, DriverKind } from './driver-capabilities';
import { supportsCapabilities } from './driver-capabilities';
import type { DriverOutcome, DriverOutcomeRepository } from './driver-outcomes';

export interface DriverRoutingInput {
  readonly origin: string;
  readonly actionKind: BrowserActionKind;
  readonly requiredCapabilities: readonly DriverCapability[];
}

export type DriverRoutingReason =
  'capability_required' | 'higher_expected_success' | 'near_equal_prefer_dom';

export interface DriverSelection {
  readonly driver: DriverKind;
  readonly reason: DriverRoutingReason;
  readonly expectedSuccess: Readonly<Record<DriverKind, number | null>>;
  readonly samples: Readonly<Record<DriverKind, number>>;
}

const priorSampleWeight = 2;
const domPreferenceDifference = 0.02;

/** Returns the scenario prior blended with real outcomes from the first verified sample onward. */
function scenarioDefault(actionKind: BrowserActionKind, driver: DriverKind): number {
  if (actionKind === 'drag') return driver === 'dom' ? 0.55 : 0.8;
  if (actionKind === 'pressKey' || actionKind === 'type') return driver === 'dom' ? 0.76 : 0.84;
  return 0.8;
}

/** Computes a learned success rate and median duration from one driver's recent outcomes. */
function summarizeOutcomes(outcomes: readonly DriverOutcome[]): {
  readonly samples: number;
  readonly successRate: number | null;
  readonly medianDurationMs: number | null;
} {
  if (outcomes.length === 0) return { samples: 0, successRate: null, medianDurationMs: null };
  const successes = outcomes.filter((outcome) => outcome.outcome === 'success').length;
  const durations = outcomes.map((outcome) => outcome.durationMs).sort((a, b) => a - b);
  return {
    samples: outcomes.length,
    successRate: successes / outcomes.length,
    medianDurationMs: durations[Math.floor(durations.length / 2)] ?? null,
  };
}

/** Blends sparse observed outcomes with a small scenario prior so retries adapt immediately. */
function expectedSuccessRate(prior: number, summary: ReturnType<typeof summarizeOutcomes>): number {
  const observedSuccesses = (summary.successRate ?? 0) * summary.samples;
  return (prior * priorSampleWeight + observedSuccesses) / (priorSampleWeight + summary.samples);
}

export class DriverRouter {
  readonly #outcomes: DriverOutcomeRepository;

  /** Creates an adaptive driver router over recent per-origin action outcomes. */
  constructor(outcomes: DriverOutcomeRepository) {
    this.#outcomes = outcomes;
  }

  /** Eliminates incapable drivers, then selects by learned or scenario expected success. */
  async select(input: DriverRoutingInput): Promise<DriverSelection> {
    const capable = (['dom', 'cdp'] as const).filter((driver) =>
      supportsCapabilities(driver, input.requiredCapabilities),
    );
    if (capable.length === 0) throw new Error('No browser driver satisfies required capabilities.');
    const outcomes = await this.#outcomes.list(input.origin, input.actionKind).catch(() => []);
    const summaries = {
      dom: summarizeOutcomes(outcomes.filter((outcome) => outcome.driver === 'dom')),
      cdp: summarizeOutcomes(outcomes.filter((outcome) => outcome.driver === 'cdp')),
    };
    const rates: Record<DriverKind, number | null> = { dom: null, cdp: null };
    for (const driver of capable) {
      const summary = summaries[driver];
      rates[driver] = expectedSuccessRate(scenarioDefault(input.actionKind, driver), summary);
    }
    const samples = { dom: summaries.dom.samples, cdp: summaries.cdp.samples };
    if (capable.length === 1) {
      const driver = capable[0];
      if (driver === undefined) throw new Error('No browser driver is available.');
      return { driver, reason: 'capability_required', expectedSuccess: rates, samples };
    }

    const domRate = rates.dom ?? 0;
    const cdpRate = rates.cdp ?? 0;
    if (Math.abs(domRate - cdpRate) < domPreferenceDifference) {
      return {
        driver: 'dom',
        reason: 'near_equal_prefer_dom',
        expectedSuccess: rates,
        samples,
      };
    }
    return {
      driver: domRate > cdpRate ? 'dom' : 'cdp',
      reason: 'higher_expected_success',
      expectedSuccess: rates,
      samples,
    };
  }
}
