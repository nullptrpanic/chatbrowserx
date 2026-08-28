export type LiveEnvironmentReadinessCheck =
  | {
      readonly kind: 'url_includes' | 'url_excludes' | 'page_text_includes' | 'page_text_excludes';
      readonly value: string;
    }
  | { readonly kind: 'page_text_any'; readonly values: readonly string[] };

export interface LiveEnvironmentDefinition {
  readonly targetSetupMode: 'none' | 'interactive';
  readonly targetSetupInstructions: readonly string[];
  readonly readinessChecks: readonly LiveEnvironmentReadinessCheck[];
}

export interface LiveScenario {
  readonly contractVersion: number;
  readonly name: string;
  readonly description: string;
  readonly startUrl: string;
  readonly expectedOrigin: string;
  readonly taskText: string;
  readonly readinessTimeoutMs: number;
  readonly environment?: LiveEnvironmentDefinition;
  readonly taskTimeoutMs: number;
  readonly maxToolCalls: number;
  readonly requiredTools: readonly string[];
  readonly forbiddenTools: readonly string[];
  readonly forbidScreenshotInspect: boolean;
  readonly forbidSubmittedType: boolean;
  readonly expectedSubmittedTypeCount?: number;
  readonly expectedToolCounts?: Readonly<Record<string, number>>;
  /** Tools whose every recorded result must report ok=true and data.verified=true. */
  readonly requiredVerifiedTools?: readonly string[];
  /** Rejects scroll calls that can traverse more segments than this before model reassessment. */
  readonly maxScrollSegmentsPerCall?: number;
  /** Allows boundary overlap, but rejects any later scroll after a declared section becomes active. */
  readonly stopScrollingAfterActiveElementNames?: readonly string[];
  /** Requires ordered evidence that a vertical read reached its top before reaching its bottom. */
  readonly requireVerticalBoundaryCoverage?: boolean;
  /** Maximum durable image references expected across tool results; defaults to zero. */
  readonly maxAttachmentCount?: number;
  readonly requiredTypedTextIncludes?: readonly string[];
  readonly requiredToolOutputIncludes?: readonly string[];
  readonly finalTextIncludes: readonly string[];
  /** Every inner group requires at least one normalized alternative to be present. */
  readonly finalTextIncludesAny?: readonly (readonly string[])[];
  /** Requires the first provider request to contain only the active user message. */
  readonly requireFreshProviderContext?: boolean;
  /** Any occurrence indicates the model reported an unresolved blocker instead of success. */
  readonly finalTextExcludes?: readonly string[];
  readonly minFinalTextLength: number;
  readonly minimumMarkdownTableRows?: number;
  readonly allowRemoteMutation: boolean;
}

export interface LiveToolResult {
  readonly toolName: string;
  readonly argumentsJson: string;
  readonly output: string;
  readonly attachmentIds: readonly string[];
  readonly auditOutputCharacters?: number;
  readonly modelOutputCharacters?: number;
}

export interface LiveRunInput {
  readonly terminalStatus: string;
  readonly finalText: string;
  readonly toolResults: readonly LiveToolResult[];
  readonly providerTrace?: LiveProviderTrace;
  /** Durable model retry boundaries used only to verify otherwise unavailable response bodies. */
  readonly providerRetryReasons?: readonly string[];
}

export interface LiveAcceptanceCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface LiveAcceptanceResult {
  readonly passed: boolean;
  readonly checks: readonly LiveAcceptanceCheck[];
}

export interface LiveModelMetrics {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly elapsedMs: number;
}

export interface LiveExecutionMetrics {
  readonly modelRounds: number;
  readonly providerRetries: number;
  readonly providerRetryCounts: Readonly<Record<string, number>>;
  readonly toolCalls: number;
  readonly toolCounts: Readonly<Record<string, number>>;
  readonly fullInteractiveObservations: number;
  readonly traversalSegments: number;
  readonly screenshotFallbacks: number;
  readonly screenshotFallbackReasons: Readonly<Record<string, number>>;
  readonly staleRefs: number;
  readonly stateMismatches: number;
  readonly repeatedFingerprints: number;
  readonly verifiedMutations: number;
  readonly ambiguousMutations: number;
  readonly toolDefinitionCharactersTotal: number;
  readonly toolDefinitionCharactersMax: number;
  readonly enabledToolsets: readonly string[];
  readonly skillCatalogDisclosureCount: number;
  readonly noProgressBlocks: number;
  readonly exactReads: number;
  readonly auditOutputCharacters: number;
  readonly modelOutputCharacters: number;
  readonly modelOutputReductionCharacters: number;
}

export interface LiveProviderInputItemSummary {
  readonly position: number;
  readonly type: string;
  readonly role?: string;
  readonly contentTypes?: readonly string[];
  readonly textCharacters?: number;
  readonly matchesActiveUserRequest?: boolean;
  readonly toolName?: string;
  readonly argumentCharacters?: number;
  readonly outputCharacters?: number;
  readonly encryptedContentCharacters?: number;
}

export interface LiveProviderRequestBodySummary {
  readonly bodyValid: boolean;
  readonly model: string | null;
  readonly instructionCharacters: number;
  readonly store: boolean | null;
  readonly stream: boolean | null;
  readonly parallelToolCalls: boolean | null;
  readonly includesEncryptedReasoning: boolean;
  readonly toolNames: readonly string[];
  readonly toolDefinitionCharacters: number;
  readonly skillCatalogDisclosureCount: number;
  readonly toolChoice: string | null;
  readonly inputItems: readonly LiveProviderInputItemSummary[];
  readonly activeUserRequestOccurrences: number;
  readonly runtimeSupplementOccurrences: number;
  readonly functionCallCount: number;
  readonly functionOutputCount: number;
  readonly orphanFunctionOutputCount: number;
  readonly unpairedFunctionCallCount: number;
  readonly duplicateFunctionCallIds: boolean;
  readonly encryptedReasoningInputCount: number;
}

export interface LiveProviderResponseSummary {
  readonly status: number | null;
  readonly contentType: string | null;
  readonly bodyBytes: number;
  readonly bodyTooLarge: boolean;
  readonly completed: boolean;
  readonly failed: boolean;
  readonly eventTypes: readonly string[];
  readonly encryptedReasoningOutputCount: number;
  readonly captureError: string | null;
}

export interface LiveProviderRequestTrace extends LiveProviderRequestBodySummary {
  readonly sequence: number;
  readonly extensionOwned: boolean;
  readonly response: LiveProviderResponseSummary;
}

export interface LiveProviderTrace {
  readonly requestCount: number;
  readonly requests: readonly LiveProviderRequestTrace[];
  /** Calls to the unsupported legacy native-compaction URL; every live run requires zero. */
  readonly compactionRequestCount?: number;
  readonly compactionRequests?: readonly LiveProviderRequestTrace[];
}

export interface LiveRunReport {
  readonly runId: string;
  readonly scenario: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly elapsedMs: number;
  readonly terminalStatus: string;
  readonly taskId: string;
  readonly conversationId: string;
  readonly finalText: string;
  readonly toolResults: readonly LiveToolResult[];
  readonly modelMetrics: LiveModelMetrics;
  readonly executionMetrics: LiveExecutionMetrics;
  readonly providerTrace: LiveProviderTrace;
  readonly productRevision: string;
  readonly scenarioContractVersion: number;
  readonly acceptance: LiveAcceptanceResult;
  readonly harnessError: string | null;
}
