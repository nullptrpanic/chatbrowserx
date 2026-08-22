import type {
  LiveAcceptanceCheck,
  LiveAcceptanceResult,
  LiveRunInput,
  LiveScenario,
} from './live-types';

const SECRET_KEY = /authorization|cookie|password|secret|access[\s_-]?token|api[\s_-]?key/i;
const BEARER_TOKEN = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const TRUNCATION_KEY = '__truncated__';

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SECRET_KEY.test(key) ? '[REDACTED]' : redactValue(child),
      ]),
    );
  }
  return typeof value === 'string' ? value.replace(BEARER_TOKEN, 'Bearer [REDACTED]') : value;
}

function readArguments(value: string): Readonly<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}

function readOutput(value: string): Readonly<Record<string, unknown>> | null {
  return readArguments(value);
}

function structuralElements(
  value: Readonly<Record<string, unknown>> | null,
): readonly Readonly<Record<string, unknown>>[] {
  const data = value?.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return [];
  const elements = (data as Readonly<Record<string, unknown>>).elements;
  if (!Array.isArray(elements)) return [];
  return elements.flatMap((candidate) =>
    typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
      ? [candidate as Readonly<Record<string, unknown>>]
      : [],
  );
}

function check(name: string, passed: boolean, detail: string): LiveAcceptanceCheck {
  return { name, passed, detail };
}

function markdownCells(line: string): readonly string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return null;
  const withoutEdges = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const cells = withoutEdges.split('|').map((cell) => cell.trim());
  return cells.length >= 2 && cells.every((cell) => cell.length > 0) ? cells : null;
}

function markdownTableMetrics(text: string): {
  readonly rowCount: number;
  readonly distinctLabels: number;
} {
  const lines = text.split(/\r?\n/);
  let best = { rowCount: 0, distinctLabels: 0 };
  for (let separatorIndex = 1; separatorIndex < lines.length; separatorIndex += 1) {
    const header = markdownCells(lines[separatorIndex - 1] ?? '');
    const separator = markdownCells(lines[separatorIndex] ?? '');
    if (
      header === null ||
      separator === null ||
      header.length !== separator.length ||
      !separator.every((cell) => /^:?-{3,}:?$/.test(cell))
    ) {
      continue;
    }
    const labels = new Set<string>();
    let rowCount = 0;
    for (let rowIndex = separatorIndex + 1; rowIndex < lines.length; rowIndex += 1) {
      const row = markdownCells(lines[rowIndex] ?? '');
      if (row === null || row.length !== header.length) break;
      rowCount += 1;
      labels.add(row[0] ?? '');
    }
    if (
      Math.min(rowCount, labels.size) > Math.min(best.rowCount, best.distinctLabels) ||
      (labels.size === best.distinctLabels && rowCount > best.rowCount)
    ) {
      best = { rowCount, distinctLabels: labels.size };
    }
  }
  return best;
}

function boundedString(value: string, maxCharacters: number): string | undefined {
  if (maxCharacters < 2) return undefined;
  if (JSON.stringify(value).length <= maxCharacters) return value;
  const suffix = '…';
  if (JSON.stringify(suffix).length > maxCharacters) return '';
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(`${value.slice(0, middle)}${suffix}`).length <= maxCharacters) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}${suffix}`;
}

function boundedJsonValue(value: unknown, maxCharacters: number): unknown | undefined {
  const serialized = JSON.stringify(value);
  if (serialized !== undefined && serialized.length <= maxCharacters) return value;
  if (typeof value === 'string') return boundedString(value, maxCharacters);
  if (value === null || typeof value !== 'object') return maxCharacters >= 1 ? 0 : undefined;

  const marker = { [TRUNCATION_KEY]: true };
  if (Array.isArray(value)) {
    if (JSON.stringify([marker]).length > maxCharacters) return undefined;
    let compact: unknown[] = [marker];
    for (const child of value) {
      const available = Math.max(0, maxCharacters - JSON.stringify(compact).length - 1);
      const bounded = boundedJsonValue(child, available);
      if (bounded === undefined) break;
      const candidate = [...compact.slice(0, -1), bounded, marker];
      if (JSON.stringify(candidate).length > maxCharacters) break;
      compact = candidate;
    }
    return compact;
  }

  if (JSON.stringify(marker).length > maxCharacters) return undefined;
  let compact: Record<string, unknown> = { ...marker };
  for (const [key, child] of Object.entries(value)) {
    if (key === TRUNCATION_KEY) continue;
    const keyCost = JSON.stringify(key).length + 2;
    const available = Math.max(0, maxCharacters - JSON.stringify(compact).length - keyCost);
    const bounded = boundedJsonValue(child, available);
    if (bounded === undefined) continue;
    const candidate = { ...compact, [key]: bounded };
    if (JSON.stringify(candidate).length > maxCharacters) continue;
    compact = candidate;
  }
  return compact;
}

function boundedJson(value: unknown, maxCharacters: number): string {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxCharacters) return serialized;
  const bounded = boundedJsonValue(value, maxCharacters);
  const result = bounded === undefined ? '' : JSON.stringify(bounded);
  if (result.length > 0 && result.length <= maxCharacters) return result;
  if (maxCharacters >= 4) return 'null';
  return maxCharacters >= 1 ? '0' : '';
}

function containsExcludedFinalText(normalizedText: string, exclusion: string): boolean {
  const normalizedExclusion = exclusion.toLocaleLowerCase();
  if (!/^[a-z0-9_]+$/i.test(normalizedExclusion)) {
    return normalizedText.includes(normalizedExclusion);
  }
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${normalizedExclusion}(?![\\p{L}\\p{N}_])`, 'u');
  return pattern.test(normalizedText);
}

/** Redacts credential-shaped fields and keeps persisted live-run evidence strictly bounded. */
export function sanitizeToolPayload(value: string, maxCharacters: number): string {
  if (!Number.isInteger(maxCharacters) || maxCharacters <= 0) return '';
  try {
    return boundedJson(redactValue(JSON.parse(value)), maxCharacters);
  } catch {
    return value.replace(BEARER_TOKEN, 'Bearer [REDACTED]').slice(0, maxCharacters);
  }
}

/** Evaluates one live run without consulting mutable page state or provider payloads. */
export function evaluateLiveRun(scenario: LiveScenario, input: LiveRunInput): LiveAcceptanceResult {
  const toolNames = input.toolResults.map(({ toolName }) => toolName);
  const parsedCalls = input.toolResults.map((result) => ({
    result,
    arguments_: readArguments(result.argumentsJson),
    output: readOutput(result.output),
  }));
  const missingTools = scenario.requiredTools.filter((name) => !toolNames.includes(name));
  const usedForbiddenTools = scenario.forbiddenTools.filter((name) => toolNames.includes(name));
  const screenshotCalls = parsedCalls.filter(
    ({ result, arguments_ }) =>
      result.toolName === 'browser_inspect' && arguments_?.mode === 'screenshot',
  );
  const submittedTypes = parsedCalls.filter(
    ({ result, arguments_ }) => result.toolName === 'browser_type' && arguments_?.submit === true,
  );
  const typedTexts = parsedCalls.flatMap(({ result, arguments_ }) =>
    result.toolName === 'browser_type' && typeof arguments_?.text === 'string'
      ? [arguments_.text]
      : [],
  );
  const missingTypedText = (scenario.requiredTypedTextIncludes ?? []).filter(
    (value) => !typedTexts.some((text) => text.includes(value)),
  );
  const lastSubmittedIndex = parsedCalls.findLastIndex(
    ({ result, arguments_ }) => result.toolName === 'browser_type' && arguments_?.submit === true,
  );
  const postSubmitElements = parsedCalls
    .slice(lastSubmittedIndex + 1)
    .filter(({ result }) => result.toolName === 'browser_inspect')
    .flatMap(({ output }) => structuralElements(output));
  const requiredReadback = scenario.requiredToolOutputIncludes ?? [];
  const missingToolOutput = requiredReadback.filter(
    (value) =>
      !postSubmitElements.some((element) => element.r === 'statictext' && element.n === value),
  );
  const retainedSubmittedText = requiredReadback.filter((value) =>
    postSubmitElements.some(
      (element) =>
        (element.r === 'textbox' || element.r === 'searchbox') &&
        typeof element.n === 'string' &&
        element.n.includes(value),
    ),
  );
  const submittedStateVerified = submittedTypes.every(({ output }) => {
    const data = output?.data;
    return (
      typeof data === 'object' &&
      data !== null &&
      !Array.isArray(data) &&
      (data as Readonly<Record<string, unknown>>).submitted === true &&
      (data as Readonly<Record<string, unknown>>).submissionVerified === true
    );
  });
  const attachmentCount = input.toolResults.reduce(
    (total, result) => total + result.attachmentIds.length,
    0,
  );
  const expectedToolCounts = Object.entries(scenario.expectedToolCounts ?? {});
  const mismatchedToolCounts = expectedToolCounts.filter(
    ([name, expected]) => toolNames.filter((candidate) => candidate === name).length !== expected,
  );
  const unverifiedRequiredTools = (scenario.requiredVerifiedTools ?? []).filter((name) => {
    const calls = parsedCalls.filter(({ result }) => result.toolName === name);
    return (
      calls.length === 0 ||
      calls.some(({ output }) => {
        const data = output?.data;
        return (
          output?.ok !== true ||
          typeof data !== 'object' ||
          data === null ||
          Array.isArray(data) ||
          (data as Readonly<Record<string, unknown>>).verified !== true
        );
      })
    );
  });
  const maxAttachmentCount = scenario.maxAttachmentCount ?? 0;
  const missingFinalText = scenario.finalTextIncludes.filter(
    (value) => !input.finalText.includes(value),
  );
  const normalizedFinalText = input.finalText.toLocaleLowerCase();
  const presentExcludedFinalText = (scenario.finalTextExcludes ?? []).filter((value) =>
    containsExcludedFinalText(normalizedFinalText, value),
  );
  const tableMetrics = markdownTableMetrics(input.finalText);
  const minimumTableRows = scenario.minimumMarkdownTableRows;
  const providerTrace = input.providerTrace;
  const providerRequests = providerTrace?.requests ?? [];
  const malformedProviderRequests = providerRequests.filter(
    (request) =>
      !request.bodyValid ||
      !request.extensionOwned ||
      request.store !== false ||
      request.stream !== true ||
      request.parallelToolCalls !== false ||
      !request.includesEncryptedReasoning ||
      request.activeUserRequestOccurrences !== 1 ||
      request.orphanFunctionOutputCount !== 0 ||
      request.unpairedFunctionCallCount !== 0 ||
      request.duplicateFunctionCallIds ||
      request.response.status !== 200 ||
      !request.response.completed ||
      request.response.failed ||
      request.response.bodyTooLarge ||
      request.response.captureError !== null,
  );
  const missingReasoningContinuations = providerRequests
    .slice(0, -1)
    .filter(
      (request, index) =>
        request.response.encryptedReasoningOutputCount > 0 &&
        (providerRequests[index + 1]?.encryptedReasoningInputCount ?? 0) === 0,
    );

  const checks: LiveAcceptanceCheck[] = [
    check(
      'remote-mutation-scope',
      scenario.allowRemoteMutation || submittedTypes.length === 0,
      scenario.allowRemoteMutation
        ? 'The scenario explicitly declares its remote mutation.'
        : `${String(submittedTypes.length)} submitted type calls in a read-only scenario.`,
    ),
    check(
      'terminal-status',
      input.terminalStatus === 'completed',
      `Terminal status: ${input.terminalStatus}.`,
    ),
    check(
      'tool-call-ceiling',
      input.toolResults.length <= scenario.maxToolCalls,
      `${String(input.toolResults.length)} completed calls; ceiling ${String(scenario.maxToolCalls)}.`,
    ),
    check(
      'required-tools',
      missingTools.length === 0,
      missingTools.length === 0
        ? 'All required tools were used.'
        : `Missing: ${missingTools.join(', ')}.`,
    ),
    check(
      'forbidden-tools',
      usedForbiddenTools.length === 0,
      usedForbiddenTools.length === 0
        ? 'No forbidden tools were used.'
        : `Used: ${usedForbiddenTools.join(', ')}.`,
    ),
    check(
      'no-screenshot-inspection',
      !scenario.forbidScreenshotInspect || screenshotCalls.length === 0,
      `${String(screenshotCalls.length)} screenshot inspections.`,
    ),
    check(
      'no-image-attachments',
      attachmentCount <= maxAttachmentCount,
      `${String(attachmentCount)} image attachments; maximum ${String(maxAttachmentCount)}.`,
    ),
    check(
      'expected-tool-counts',
      mismatchedToolCounts.length === 0,
      mismatchedToolCounts.length === 0
        ? 'Every exact tool-count requirement was met.'
        : `Mismatched: ${mismatchedToolCounts
            .map(
              ([name, expected]) =>
                `${name}=${String(toolNames.filter((candidate) => candidate === name).length)} (expected ${String(expected)})`,
            )
            .join(', ')}.`,
    ),
    check(
      'required-tool-verification',
      unverifiedRequiredTools.length === 0,
      unverifiedRequiredTools.length === 0
        ? 'Every required tool result was independently verified.'
        : `Unverified: ${unverifiedRequiredTools.join(', ')}.`,
    ),
    check(
      'no-submitted-typing',
      !scenario.forbidSubmittedType || submittedTypes.length === 0,
      `${String(submittedTypes.length)} submitted type calls.`,
    ),
    check(
      'submitted-type-count',
      scenario.expectedSubmittedTypeCount === undefined ||
        submittedTypes.length === scenario.expectedSubmittedTypeCount,
      `${String(submittedTypes.length)} submitted type calls; expected ${scenario.expectedSubmittedTypeCount === undefined ? 'any allowed count' : String(scenario.expectedSubmittedTypeCount)}.`,
    ),
    check(
      'required-typed-text',
      missingTypedText.length === 0,
      missingTypedText.length === 0
        ? 'Every required text fragment was typed.'
        : `Missing required typed text: ${missingTypedText.join(', ')}.`,
    ),
    check(
      'required-tool-readback',
      missingToolOutput.length === 0,
      missingToolOutput.length === 0
        ? 'Every required value was observed as post-submit static text.'
        : `${String(missingToolOutput.length)} required values were not observed as post-submit static text.`,
    ),
    check(
      'submitted-state-readback',
      submittedTypes.length === 0 || (submittedStateVerified && retainedSubmittedText.length === 0),
      submittedTypes.length === 0
        ? 'No submitted typing required state verification.'
        : submittedStateVerified && retainedSubmittedText.length === 0
          ? 'Every submitted type was verified and no submitted value remained in an editor.'
          : `${String(retainedSubmittedText.length)} submitted values remained in an editor; verified=${String(submittedStateVerified)}.`,
    ),
    check(
      'final-text-content',
      missingFinalText.length === 0,
      missingFinalText.length === 0
        ? 'Final text includes every required phrase.'
        : `Missing: ${missingFinalText.join(', ')}.`,
    ),
    check(
      'final-text-exclusions',
      presentExcludedFinalText.length === 0,
      presentExcludedFinalText.length === 0
        ? 'Final text does not declare an unresolved scenario blocker.'
        : `Excluded blocker text present: ${presentExcludedFinalText.join(', ')}.`,
    ),
    check(
      'final-text-length',
      input.finalText.trim().length >= scenario.minFinalTextLength,
      `${String(input.finalText.trim().length)} characters; minimum ${String(scenario.minFinalTextLength)}.`,
    ),
    check(
      'markdown-table-rows',
      minimumTableRows === undefined ||
        (tableMetrics.rowCount >= minimumTableRows &&
          tableMetrics.distinctLabels >= minimumTableRows),
      minimumTableRows === undefined
        ? 'No Markdown table row minimum declared.'
        : `${String(tableMetrics.rowCount)} rows with ${String(tableMetrics.distinctLabels)} distinct first-column labels; minimum ${String(minimumTableRows)}.`,
    ),
    check(
      'provider-request-chain',
      providerTrace === undefined ||
        (providerTrace.requestCount === providerRequests.length &&
          providerTrace.requestCount === input.toolResults.length + 1),
      providerTrace === undefined
        ? 'No Provider trace supplied.'
        : `${String(providerTrace.requestCount)} Provider requests for ${String(input.toolResults.length)} completed tools.`,
    ),
    check(
      'provider-request-contract',
      providerTrace === undefined || malformedProviderRequests.length === 0,
      providerTrace === undefined
        ? 'No Provider trace supplied.'
        : `${String(malformedProviderRequests.length)} malformed or incomplete Provider requests.`,
    ),
    check(
      'encrypted-reasoning-continuation',
      providerTrace === undefined || missingReasoningContinuations.length === 0,
      providerTrace === undefined
        ? 'No Provider trace supplied.'
        : `${String(missingReasoningContinuations.length)} model turns dropped encrypted reasoning before the next request.`,
    ),
  ];

  return { passed: checks.every(({ passed }) => passed), checks };
}
