import { describe, expect, it, vi } from 'vitest';
import { parseLiveBenchmarkArguments, runLiveBenchmark } from '../../runner/live-benchmark';
import type { LiveRunReport } from '../../runner/live-types';
import { liveRunReport } from './fixtures';

function report(passed: boolean, runId: string): LiveRunReport {
  return liveRunReport({
    runId,
    scenario: 'exam',
    terminalStatus: passed ? 'completed' : 'failed',
    finalText: passed ? 'completed' : 'failed',
    productRevision: 'revision_1',
    acceptance: { passed, checks: [] },
    harnessError: passed ? null : 'synthetic first failure',
  });
}

describe('live benchmark', () => {
  it('defaults an omitted run count to one attempt', () => {
    expect(parseLiveBenchmarkArguments(['example-read'])).toEqual({
      scenario: 'example-read',
      runs: 1,
    });
  });

  it('stops on the first failed attempt and preserves completed reports', async () => {
    const runAttempt = vi
      .fn<(attempt: number) => Promise<LiveRunReport>>()
      .mockResolvedValueOnce(report(true, 'run_1'))
      .mockResolvedValueOnce(report(false, 'run_2'))
      .mockResolvedValueOnce(report(true, 'run_3'));

    const aggregate = await runLiveBenchmark({
      scenario: 'exam',
      runs: 5,
      productRevision: 'revision_1',
      scenarioContractVersion: 3,
      runAttempt,
    });

    expect(runAttempt).toHaveBeenCalledTimes(2);
    expect(aggregate).toEqual({
      requestedRuns: 5,
      completedRuns: 2,
      passedRuns: 1,
      stoppedOnFailure: true,
    });
  });

  it('rejects an unsafe run count before starting work', async () => {
    const runAttempt = vi.fn<(attempt: number) => Promise<LiveRunReport>>();

    await expect(
      runLiveBenchmark({
        scenario: 'exam',
        runs: 21,
        productRevision: 'revision_1',
        scenarioContractVersion: 3,
        runAttempt,
      }),
    ).rejects.toThrow('between 1 and 20');
    expect(runAttempt).not.toHaveBeenCalled();
  });

  it('rejects reports from a different product revision', async () => {
    const incompatible = {
      ...report(true, 'run_other'),
      productRevision: 'revision_2',
    };

    await expect(
      runLiveBenchmark({
        scenario: 'exam',
        runs: 1,
        productRevision: 'revision_1',
        scenarioContractVersion: 3,
        runAttempt: async () => incompatible,
      }),
    ).rejects.toThrow('revision');
  });
});
