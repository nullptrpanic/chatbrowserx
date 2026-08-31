import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createEvaluationResult,
  evaluationResultFilename,
  parseEvaluationResult,
  writeEvaluationResult,
} from '../../runner/evaluation-result';
import type { LiveRunReport } from '../../runner/live-types';
import { liveRunReport, liveScenario } from './fixtures';

const scenario = liveScenario();

function report(overrides: Partial<LiveRunReport> = {}): LiveRunReport {
  const base = liveRunReport();
  return liveRunReport({
    executionMetrics: {
      ...base.executionMetrics,
      providerRetries: 1,
      providerRetryCounts: { 'transient_model_retry:upstream_failure': 1 },
    },
    ...overrides,
  });
}

describe('evaluation result', () => {
  it('records one comparable successful attempt with materialized input and all token counters', () => {
    const result = createEvaluationResult(scenario, report());

    expect(result).toEqual(
      expect.objectContaining({
        schemaVersion: 3,
        sampleId: 'example-read',
        runId: 'live_abc-123',
        productRevision: 'revision-dirty-fingerprint',
        scenarioContractVersion: 3,
        startedAt: '2026-08-27T12:33:46.514Z',
        endedAt: '2026-08-27T12:33:58.014Z',
        elapsedMs: 11_500,
        terminalStatus: 'completed',
        success: true,
        input: { text: 'Read marker live_abc-123 without changing anything.' },
        output: { text: 'Example read is complete.' },
        tokenUsage: {
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
          cachedInputTokens: 40,
          cacheWriteInputTokens: 0,
          reasoningOutputTokens: 10,
        },
        execution: expect.objectContaining({
          firstEventMs: 0,
          firstTextMs: 0,
          providerRetries: 1,
          providerRetryCounts: { 'transient_model_retry:upstream_failure': 1 },
          toolCalls: 1,
          toolCounts: { browser_inspect: 1 },
          toolDefinitionCharactersTotal: 11_000,
          toolDefinitionCharactersMax: 5_500,
          toolDefinitionSchemaChanges: 0,
          toolDefinitionSchemaVariants: 0,
        }),
      }),
    );
  });

  it('uses a sortable millisecond UTC timestamp and run ID in every filename', () => {
    expect(evaluationResultFilename(report())).toBe('20260827T123346.514Z__live_abc-123.json');
  });

  it('rejects fields outside the current result schema', () => {
    const result = {
      ...createEvaluationResult(scenario, report()),
      extraMetric: 1,
    };

    expect(() =>
      parseEvaluationResult(result, scenario.name, '20260827T123346.514Z__live_abc-123.json'),
    ).toThrow('extraMetric is not supported');
  });

  it('loads earlier schema-v3 failures that predate the task-error split', () => {
    const current = createEvaluationResult(
      scenario,
      report({
        acceptance: { passed: false, checks: [] },
        harnessError: 'Synthetic harness failure.',
      }),
    );
    const legacyFailure = { ...current.failure } as Record<string, unknown>;
    delete legacyFailure.taskError;

    const parsed = parseEvaluationResult(
      { ...current, failure: legacyFailure },
      scenario.name,
      '20260827T123346.514Z__live_abc-123.json',
    );

    expect(parsed.failure?.taskError).toBeNull();
  });

  it('records product task failures separately from harness failures', () => {
    const result = createEvaluationResult(
      scenario,
      report({
        terminalStatus: 'paused',
        finalText: '',
        acceptance: {
          passed: false,
          checks: [
            {
              name: 'terminal-status',
              passed: false,
              detail: 'Terminal status: paused.',
            },
          ],
        },
        taskError: 'The provider is temporarily unavailable.',
      }),
    );

    expect(result.success).toBe(false);
    expect(result.failure).toEqual({
      taskError: 'The provider is temporarily unavailable.',
      harnessError: null,
      failedChecks: [{ name: 'terminal-status', detail: 'Terminal status: paused.' }],
    });
  });

  it('writes exactly one timestamped JSON file below the owning sample results directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chatbrowserx-e2e-result-'));

    const path = await writeEvaluationResult(root, scenario, report());

    expect(path).toBe(
      join(
        root,
        'e2e',
        'samples',
        'example-read',
        'results',
        '20260827T123346.514Z__live_abc-123.json',
      ),
    );
    const stored = JSON.parse(await readFile(path, 'utf8')) as {
      success: boolean;
      runId: string;
    };
    expect(stored).toEqual(expect.objectContaining({ success: true, runId: 'live_abc-123' }));
  });
});
