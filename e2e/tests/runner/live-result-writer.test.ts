import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { persistLiveEvaluationAttempt } from '../../runner/live-result-writer';
import { liveRunReport, liveScenario } from './fixtures';

const scenario = liveScenario({
  contractVersion: 1,
  description: 'Reads one page.',
  taskText: 'Read this page.',
  finalTextIncludes: ['done'],
  minFinalTextLength: 4,
});

function report(runId: string, success: boolean) {
  return liveRunReport({
    runId,
    startedAt: success ? '2026-08-27T13:00:00.001Z' : '2026-08-27T13:01:02.345Z',
    endedAt: success ? '2026-08-27T13:00:01.001Z' : '2026-08-27T13:01:03.345Z',
    elapsedMs: 1_000,
    terminalStatus: success ? 'completed' : 'failed',
    finalText: success ? 'done' : '',
    productRevision: 'revision',
    scenarioContractVersion: 1,
    acceptance: {
      passed: success,
      checks: [
        {
          name: 'terminal-status',
          passed: success,
          detail: success ? 'Completed.' : 'Terminal status: failed.',
        },
      ],
    },
    harnessError: success ? null : 'Provider failed.',
  });
}

describe('live result writer', () => {
  it.each([
    ['successful', 'live_success', true, '20260827T130000.001Z__live_success.json'],
    ['failed', 'live_failure', false, '20260827T130102.345Z__live_failure.json'],
  ] as const)(
    'persists raw evidence and one timestamped standard result for a %s attempt',
    async (_label, runId, success, expectedFilename) => {
      const root = await mkdtemp(join(tmpdir(), 'chatbrowserx-live-attempt-'));

      const paths = await persistLiveEvaluationAttempt(root, scenario, report(runId, success));

      expect(paths.rawReportPath).toBe(
        join(root, 'e2e', '.runtime', 'live-results', runId, 'report.json'),
      );
      expect(paths.evaluationResultPath).toBe(
        join(root, 'e2e', 'samples', 'example-read', 'results', expectedFilename),
      );
      const stored = JSON.parse(await readFile(paths.evaluationResultPath, 'utf8')) as {
        success: boolean;
        sourceReport: string;
      };
      expect(stored.success).toBe(success);
      expect(stored.sourceReport).toBe(`e2e/.runtime/live-results/${runId}/report.json`);
    },
  );
});
