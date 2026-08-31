import {
  createEvaluationBatch,
  createEvaluationResult,
  type EvaluationResult,
} from '../../runner/evaluation-result';
import type { LiveRunReport, LiveScenario } from '../../runner/live-types';
import type { EvaluationSampleDefinition } from '../../runner/sample-loader';

export function evaluationSampleDefinition(
  overrides: Partial<EvaluationSampleDefinition> = {},
): EvaluationSampleDefinition {
  return {
    schemaVersion: 3,
    id: 'example-read',
    contractVersion: 3,
    description: 'Reads one complete example page.',
    requiredRuns: 5,
    target: {
      url: 'https://example.com/document',
      expectedOrigin: 'https://example.com',
      readinessTimeoutMs: 10_000,
    },
    environment: {
      targetSetupMode: 'interactive',
      targetSetupInstructions: ['Sign in to the example site with the evaluation account.'],
      readinessChecks: [
        { kind: 'url_excludes', value: '/login' },
        {
          kind: 'page_text_any',
          values: ['Example document', 'Example workspace'],
        },
      ],
    },
    input: { text: 'Read the complete page without changing it.' },
    execution: {
      taskTimeoutMs: 20_000,
      maxToolCalls: 8,
      requiredTools: ['browser_inspect'],
      forbiddenTools: ['browser_type'],
    },
    sideEffects: { mode: 'read_only' },
    evaluation: {
      method: 'deterministic',
      policy: {
        forbidScreenshotInspect: true,
        forbidSubmittedType: true,
        maxScrollSegmentsPerCall: 2,
        requireVerticalBoundaryCoverage: true,
        finalTextIncludes: ['complete'],
        finalTextIncludesAny: [['top', 'beginning']],
        finalTextExcludes: ['blocked'],
        minFinalTextLength: 40,
        requireFreshProviderContext: true,
      },
    },
    ...overrides,
  };
}

export function liveScenario(overrides: Partial<LiveScenario> = {}): LiveScenario {
  return {
    contractVersion: 3,
    name: 'example-read',
    description: 'Reads one example page.',
    startUrl: 'https://example.com/',
    expectedOrigin: 'https://example.com',
    taskText: 'Read marker {{RUN_ID}} without changing anything.',
    readinessTimeoutMs: 10_000,
    taskTimeoutMs: 20_000,
    maxToolCalls: 4,
    requiredTools: ['browser_inspect'],
    forbiddenTools: [],
    forbidScreenshotInspect: true,
    forbidSubmittedType: true,
    finalTextIncludes: ['complete'],
    minFinalTextLength: 8,
    allowRemoteMutation: false,
    ...overrides,
  };
}

export function liveRunReport(overrides: Partial<LiveRunReport> = {}): LiveRunReport {
  return {
    runId: 'live_abc-123',
    scenario: 'example-read',
    startedAt: '2026-08-27T12:33:46.514Z',
    endedAt: '2026-08-27T12:33:58.014Z',
    elapsedMs: 11_500,
    terminalStatus: 'completed',
    taskId: 'task_1',
    conversationId: 'conversation_1',
    finalText: 'Example read is complete.',
    toolResults: [],
    modelMetrics: {
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 10,
      elapsedMs: 9_000,
      firstEventMs: 0,
      firstTextMs: 0,
    },
    executionMetrics: {
      modelRounds: 2,
      providerRetries: 0,
      providerRetryCounts: {},
      toolCalls: 1,
      toolCounts: { browser_inspect: 1 },
      fullInteractiveObservations: 1,
      traversalSegments: 0,
      screenshotFallbacks: 0,
      screenshotFallbackReasons: {},
      staleRefs: 0,
      stateMismatches: 0,
      repeatedFingerprints: 0,
      verifiedMutations: 0,
      ambiguousMutations: 0,
      toolDefinitionCharactersTotal: 11_000,
      toolDefinitionCharactersMax: 5_500,
      toolDefinitionSchemaChanges: 0,
      toolDefinitionSchemaVariants: 0,
      enabledToolsets: [],
      skillCatalogDisclosureCount: 0,
      noProgressBlocks: 0,
      exactReads: 0,
      auditOutputCharacters: 2_000,
      modelOutputCharacters: 1_000,
      modelOutputReductionCharacters: 1_000,
      auditOutputCharactersByTool: { browser_inspect: 2_000 },
      modelOutputCharactersByTool: { browser_inspect: 1_000 },
    },
    providerTrace: { requestCount: 2, requests: [] },
    productRevision: 'revision-dirty-fingerprint',
    scenarioContractVersion: 3,
    acceptance: {
      passed: true,
      checks: [{ name: 'terminal-status', passed: true, detail: 'Completed.' }],
    },
    taskError: null,
    harnessError: null,
    ...overrides,
  };
}

export function evaluationResult(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
  return {
    ...createEvaluationResult(
      liveScenario(),
      createEvaluationBatch('results', '2026-08-27T12:30:00.000Z', 1),
      1,
      liveRunReport(),
    ),
    ...overrides,
  };
}
