import type { LiveExecutionMetrics, LiveProviderTrace, LiveToolResult } from './live-types';
import { jsonRecord } from './json-contract';
import { readTraversalSegments } from './live-scroll-metrics';

interface LiveExecutionMetricInput {
  readonly modelTurns: number;
  readonly toolResults: readonly LiveToolResult[];
  readonly providerTrace: LiveProviderTrace;
  readonly providerRetryReasons?: readonly string[];
}

function parseRecord(value: string): Readonly<Record<string, unknown>> | null {
  try {
    return jsonRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function canonicalValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (depth >= 8) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 64).map((item) => canonicalValue(item, depth + 1));
  }
  const valueRecord = jsonRecord(value);
  if (valueRecord === null) return null;
  return Object.fromEntries(
    Object.keys(valueRecord)
      .sort()
      .slice(0, 64)
      .map((key) => [key, canonicalValue(valueRecord[key], depth + 1)]),
  );
}

function callFingerprint(result: LiveToolResult): string | null {
  const argumentsValue = parseRecord(result.argumentsJson);
  if (argumentsValue === null) return null;
  return `${result.toolName}:${JSON.stringify(canonicalValue(argumentsValue))}`;
}

/** Derives bounded aggregate metrics without retaining raw arguments or tool output. */
export function deriveLiveExecutionMetrics(input: LiveExecutionMetricInput): LiveExecutionMetrics {
  const toolCounts = new Map<string, number>();
  const providerRetryCounts = new Map<string, number>();
  const fingerprintCounts = new Map<string, number>();
  let fullInteractiveObservations = 0;
  let traversalSegments = 0;
  let screenshotFallbacks = 0;
  const screenshotFallbackReasons = new Map<string, number>();
  let staleRefs = 0;
  let stateMismatches = 0;
  let verifiedMutations = 0;
  let ambiguousMutations = 0;
  const enabledToolsets = new Set<string>();
  let noProgressBlocks = 0;
  let exactReads = 0;
  let auditOutputCharacters = 0;
  let modelOutputCharacters = 0;
  const auditOutputCharactersByTool = new Map<string, number>();
  const modelOutputCharactersByTool = new Map<string, number>();

  for (const reason of input.providerRetryReasons ?? []) {
    providerRetryCounts.set(reason, (providerRetryCounts.get(reason) ?? 0) + 1);
  }

  for (const result of input.toolResults) {
    toolCounts.set(result.toolName, (toolCounts.get(result.toolName) ?? 0) + 1);
    const fingerprint = callFingerprint(result);
    if (fingerprint !== null) {
      fingerprintCounts.set(fingerprint, (fingerprintCounts.get(fingerprint) ?? 0) + 1);
    }

    const argumentsValue = parseRecord(result.argumentsJson);
    const output = parseRecord(result.output);
    const data = jsonRecord(output?.data);
    const auditCharacters = result.auditOutputCharacters ?? result.output.length;
    const modelCharacters = result.modelOutputCharacters ?? result.output.length;
    auditOutputCharacters += auditCharacters;
    modelOutputCharacters += modelCharacters;
    auditOutputCharactersByTool.set(
      result.toolName,
      (auditOutputCharactersByTool.get(result.toolName) ?? 0) + auditCharacters,
    );
    modelOutputCharactersByTool.set(
      result.toolName,
      (modelOutputCharactersByTool.get(result.toolName) ?? 0) + modelCharacters,
    );
    if (
      result.toolName === 'toolset_enable' &&
      output?.ok === true &&
      typeof output.toolset === 'string'
    ) {
      enabledToolsets.add(output.toolset);
    }
    if (output?.code === 'NO_PROGRESS') noProgressBlocks += 1;
    if (result.toolName === 'history_read') exactReads += 1;
    if (result.toolName === 'browser_inspect' && argumentsValue?.mode === 'interactive') {
      fullInteractiveObservations += 1;
    }
    if (result.toolName === 'browser_scroll') {
      traversalSegments += readTraversalSegments(data) ?? 0;
    }
    if (result.toolName === 'browser_inspect' && argumentsValue?.mode === 'screenshot') {
      screenshotFallbacks += 1;
      if (typeof data?.fallbackReason === 'string') {
        screenshotFallbackReasons.set(
          data.fallbackReason,
          (screenshotFallbackReasons.get(data.fallbackReason) ?? 0) + 1,
        );
      }
    }
    if (output?.code === 'STALE_REF') staleRefs += 1;
    if (output?.code === 'ACTION_STATE_MISMATCH') stateMismatches += 1;
    if (
      result.toolName.startsWith('browser_') &&
      (data?.verified === true || data?.reconciliation === 'verified')
    ) {
      verifiedMutations += 1;
    }
    if (output?.code === 'AMBIGUOUS_MUTATION' || output?.code === 'AMBIGUOUS_EXECUTION') {
      ambiguousMutations += 1;
    }
  }

  const toolDefinitionFingerprints = input.providerTrace.requests.flatMap((request) =>
    request.toolDefinitionFingerprint === null ? [] : [request.toolDefinitionFingerprint],
  );
  const toolDefinitionSchemaChanges = toolDefinitionFingerprints.reduce(
    (changes, fingerprint, index) =>
      index > 0 && fingerprint !== toolDefinitionFingerprints[index - 1] ? changes + 1 : changes,
    0,
  );

  return {
    modelRounds: input.modelTurns,
    providerRetries: input.providerRetryReasons?.length ?? 0,
    providerRetryCounts: Object.fromEntries(
      [...providerRetryCounts].sort(([left], [right]) => left.localeCompare(right)),
    ),
    toolCalls: input.toolResults.length,
    toolCounts: Object.fromEntries(
      [...toolCounts].sort(([left], [right]) => left.localeCompare(right)),
    ),
    fullInteractiveObservations,
    traversalSegments,
    screenshotFallbacks,
    screenshotFallbackReasons: Object.fromEntries(
      [...screenshotFallbackReasons].sort(([left], [right]) => left.localeCompare(right)),
    ),
    staleRefs,
    stateMismatches,
    repeatedFingerprints: [...fingerprintCounts.values()].reduce(
      (total, count) => total + Math.max(0, count - 1),
      0,
    ),
    verifiedMutations,
    ambiguousMutations,
    toolDefinitionCharactersTotal: input.providerTrace.requests.reduce(
      (total, request) => total + request.toolDefinitionCharacters,
      0,
    ),
    toolDefinitionCharactersMax: input.providerTrace.requests.reduce(
      (maximum, request) => Math.max(maximum, request.toolDefinitionCharacters),
      0,
    ),
    toolDefinitionSchemaChanges,
    toolDefinitionSchemaVariants: new Set(toolDefinitionFingerprints).size,
    enabledToolsets: [...enabledToolsets].sort(),
    skillCatalogDisclosureCount: input.providerTrace.requests.reduce(
      (maximum, request) => Math.max(maximum, request.skillCatalogDisclosureCount),
      0,
    ),
    noProgressBlocks,
    exactReads,
    auditOutputCharacters,
    modelOutputCharacters,
    modelOutputReductionCharacters: Math.max(0, auditOutputCharacters - modelOutputCharacters),
    auditOutputCharactersByTool: Object.fromEntries(
      [...auditOutputCharactersByTool].sort(([left], [right]) => left.localeCompare(right)),
    ),
    modelOutputCharactersByTool: Object.fromEntries(
      [...modelOutputCharactersByTool].sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}
