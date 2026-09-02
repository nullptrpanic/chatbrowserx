import { describe, expect, it } from 'vitest';
import { deriveLiveExecutionMetrics } from '../../runner/live-metrics';
import type { LiveToolResult } from '../../runner/live-types';

function tool(toolName: string, argumentsValue: unknown, outputValue: unknown): LiveToolResult {
  return {
    toolName,
    argumentsJson: JSON.stringify(argumentsValue),
    output: JSON.stringify(outputValue),
    attachmentIds: [],
  };
}

describe('live execution metrics', () => {
  it('counts model rounds, tools, observations, traversals, fallbacks, and mutations', () => {
    const inspect = {
      ...tool('browser_inspect', { mode: 'interactive' }, { ok: true, data: { refs: [] } }),
      auditOutputCharacters: 200,
      modelOutputCharacters: 80,
    };
    const metrics = deriveLiveExecutionMetrics({
      modelTurns: 2,
      toolResults: [
        inspect,
        tool(
          'browser_scroll',
          { target: 'viewport', maxSegments: 2, deltaY: 800 },
          { ok: true, data: { segments: 1, observations: [{ index: 0 }, { index: 1 }] } },
        ),
        tool(
          'browser_inspect',
          { tabId: 7, mode: 'screenshot' },
          {
            ok: true,
            data: { attachmentId: 'a1', fallbackReason: 'semantic_coverage' },
          },
        ),
        tool('browser_click', { ref: 'e1' }, { ok: true, data: { verified: true } }),
        tool('browser_type', { ref: 'e2', text: 'bounded' }, { ok: false, code: 'STALE_REF' }),
        tool(
          'browser_select',
          { ref: 'e3', value: 'one' },
          { ok: false, code: 'ACTION_STATE_MISMATCH' },
        ),
        tool('browser_click', { ref: 'e4' }, { ok: false, code: 'AMBIGUOUS_MUTATION' }),
        tool(
          'browser_set_checked',
          { ref: 'e5', checked: true },
          { ok: true, data: { recovered: true, reconciliation: 'verified' } },
        ),
      ],
      providerTrace: {
        requestCount: 3,
        requests: [
          {
            toolDefinitionCharacters: 100,
            toolDefinitionFingerprint: 'aaaaaaaaaaaaaaaa',
            skillCatalogDisclosureCount: 0,
          },
          {
            toolDefinitionCharacters: 100,
            toolDefinitionFingerprint: 'aaaaaaaaaaaaaaaa',
            skillCatalogDisclosureCount: 0,
          },
          {
            toolDefinitionCharacters: 150,
            toolDefinitionFingerprint: 'bbbbbbbbbbbbbbbb',
            skillCatalogDisclosureCount: 0,
          },
        ],
      } as never,
      providerRetryReasons: [
        'transient_model_retry:upstream_failure',
        'transient_model_retry:upstream_failure',
      ],
    });

    expect(metrics).toEqual({
      modelRounds: 2,
      providerRetries: 2,
      providerRetryCounts: { 'transient_model_retry:upstream_failure': 2 },
      toolCalls: 8,
      toolCounts: {
        browser_click: 2,
        browser_inspect: 2,
        browser_scroll: 1,
        browser_select: 1,
        browser_set_checked: 1,
        browser_type: 1,
      },
      fullInteractiveObservations: 1,
      traversalSegments: 1,
      screenshotFallbacks: 1,
      screenshotFallbackReasons: { semantic_coverage: 1 },
      staleRefs: 1,
      stateMismatches: 1,
      repeatedFingerprints: 0,
      verifiedMutations: 2,
      ambiguousMutations: 1,
      toolDefinitionCharactersTotal: 350,
      toolDefinitionCharactersMax: 150,
      toolDefinitionSchemaChanges: 1,
      toolDefinitionSchemaVariants: 2,
      enabledToolsets: [],
      skillCatalogDisclosureCount: 0,
      noProgressBlocks: 0,
      exactReads: 0,
      auditOutputCharacters: expect.any(Number),
      modelOutputCharacters: expect.any(Number),
      modelOutputReductionCharacters: 120,
      auditOutputCharactersByTool: expect.objectContaining({
        browser_inspect: 277,
      }),
      modelOutputCharactersByTool: expect.objectContaining({
        browser_inspect: 157,
      }),
    });
  });

  it('counts only repeated parsed call fingerprints and ignores malformed payload text', () => {
    const repeated = tool(
      'browser_scroll',
      { deltaY: 400, target: 'viewport' },
      { ok: true, data: { observations: [] } },
    );
    const sameWithDifferentKeyOrder: LiveToolResult = {
      ...repeated,
      argumentsJson: '{"target":"viewport","deltaY":400}',
    };
    const malformed: LiveToolResult = {
      toolName: 'browser_scroll',
      argumentsJson: '{unsafe-secret',
      output: '{unsafe-output',
      attachmentIds: [],
    };

    const metrics = deriveLiveExecutionMetrics({
      modelTurns: 0,
      toolResults: [repeated, sameWithDifferentKeyOrder, malformed],
      providerTrace: { requestCount: 0, requests: [] },
    });

    expect(metrics.repeatedFingerprints).toBe(1);
    expect(JSON.stringify(metrics)).not.toContain('unsafe');
  });
});
