import type { LiveRunReport } from './live-types';

export interface LiveBenchmarkInput {
  readonly scenario: string;
  readonly runs: number;
  readonly productRevision: string;
  readonly scenarioContractVersion: number;
  readonly runAttempt: (attempt: number) => Promise<LiveRunReport>;
}

export interface LiveBenchmarkStatus {
  readonly requestedRuns: number;
  readonly completedRuns: number;
  readonly passedRuns: number;
  readonly stoppedOnFailure: boolean;
}

export function parseLiveBenchmarkArguments(arguments_: readonly string[]): {
  readonly scenario: string;
  readonly runs: number;
} {
  const normalized = arguments_[0] === '--' ? arguments_.slice(1) : [...arguments_];
  const scenario = normalized[0]?.trim() ?? '';
  const runs = normalized[1] === undefined ? 1 : Number(normalized[1]);
  if (
    normalized.length < 1 ||
    normalized.length > 2 ||
    scenario.length === 0 ||
    !Number.isSafeInteger(runs)
  ) {
    throw new Error('Usage: npm run e2e:live:benchmark -- <scenario> [runs].');
  }
  return { scenario, runs };
}

/** Runs sequential first-attempt validations and stops on the first material failure. */
export async function runLiveBenchmark(input: LiveBenchmarkInput): Promise<LiveBenchmarkStatus> {
  if (!Number.isSafeInteger(input.runs) || input.runs < 1 || input.runs > 20) {
    throw new RangeError('Live benchmark runs must be an integer between 1 and 20.');
  }
  if (!Number.isSafeInteger(input.scenarioContractVersion) || input.scenarioContractVersion < 1) {
    throw new RangeError('Live benchmark scenario contract version must be a positive integer.');
  }

  const reports: LiveRunReport[] = [];
  let stoppedOnFailure = false;
  for (let attempt = 1; attempt <= input.runs; attempt += 1) {
    const report = await input.runAttempt(attempt);
    if (report.scenario !== input.scenario) {
      throw new Error('Live benchmark report scenario does not match the requested scenario.');
    }
    if (report.productRevision !== input.productRevision) {
      throw new Error('Live benchmark report product revision does not match the batch revision.');
    }
    if (report.scenarioContractVersion !== input.scenarioContractVersion) {
      throw new Error('Live benchmark report contract version does not match the batch contract.');
    }
    reports.push(report);
    if (!report.acceptance.passed || report.taskError !== null || report.harnessError !== null) {
      stoppedOnFailure = true;
      break;
    }
  }

  return {
    requestedRuns: input.runs,
    completedRuns: reports.length,
    passedRuns: reports.filter(
      (report) =>
        report.acceptance.passed && report.taskError === null && report.harnessError === null,
    ).length,
    stoppedOnFailure,
  };
}
