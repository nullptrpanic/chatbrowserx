import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LiveRunReport, LiveScenario } from './live-types';
import { writeEvaluationResult } from './evaluation-result';

export interface PersistedLiveEvaluationAttempt {
  readonly rawReportPath: string;
  readonly evaluationResultPath: string;
}

/** Persists the bounded result first so a later raw-report failure cannot erase the attempt. */
export async function persistLiveEvaluationAttempt(
  repositoryRoot: string,
  scenario: LiveScenario,
  report: LiveRunReport,
): Promise<PersistedLiveEvaluationAttempt> {
  const evaluationResultPath = await writeEvaluationResult(repositoryRoot, scenario, report);
  const rawReportDirectory = join(repositoryRoot, 'e2e', '.runtime', 'live-results', report.runId);
  const rawReportPath = join(rawReportDirectory, 'report.json');
  await mkdir(rawReportDirectory, { recursive: true });
  await writeFile(rawReportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return { rawReportPath, evaluationResultPath };
}
