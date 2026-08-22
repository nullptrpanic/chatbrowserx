export interface LiveScenario {
  readonly name: string;
  readonly description: string;
  readonly startUrl: string;
  readonly expectedOrigin: string;
  readonly taskText: string;
  readonly readinessTimeoutMs: number;
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
  /** Maximum durable image references expected across tool results; defaults to zero. */
  readonly maxAttachmentCount?: number;
  readonly requiredTypedTextIncludes?: readonly string[];
  readonly requiredToolOutputIncludes?: readonly string[];
  readonly finalTextIncludes: readonly string[];
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
}

export interface LiveRunInput {
  readonly terminalStatus: string;
  readonly finalText: string;
  readonly toolResults: readonly LiveToolResult[];
  readonly providerTrace?: LiveProviderTrace;
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
  readonly providerTrace: LiveProviderTrace;
  readonly acceptance: LiveAcceptanceResult;
  readonly harnessError: string | null;
}
