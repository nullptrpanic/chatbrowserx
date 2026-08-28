import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { ExtensionSession } from './extension-session';
import { jsonRecord } from './json-contract';
import {
  configuredEnvironmentFailureMessage,
  evaluateConfiguredLiveEnvironment,
  targetEnvironmentFailureMessage,
  waitForTargetEnvironment,
  type LiveEnvironmentVerification,
} from './live-environment';
import { deriveLiveExecutionMetrics } from './live-metrics';
import { evaluateLiveRun, sanitizeToolPayload } from './live-policy';
import { ResponsesTraceCollector } from './provider-trace';
import type {
  LiveModelMetrics,
  LiveProviderTrace,
  LiveRunReport,
  LiveScenario,
  LiveToolResult,
} from './live-types';
import type { ExtensionMessage, ExtensionResponse } from '../../src/shared/protocol/message-types';

const RUN_STOP_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'paused',
  'waiting_for_auth',
]);
const FINISHED_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const POLL_INTERVAL_MS = 500;
const CLEANUP_REQUEST_TIMEOUT_MS = 10_000;
const FINAL_SNAPSHOT_ATTEMPTS = 3;
const FINAL_SNAPSHOT_RETRY_DELAY_MS = 250;
const MAX_REPORTED_ARGUMENT_CHARACTERS = 20_000;
const MAX_REPORTED_OUTPUT_CHARACTERS = 50_000;
const MAX_REPORTED_ERROR_CHARACTERS = 2_000;

class LiveRequestTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} did not complete within ${String(timeoutMs)} ms.`);
    this.name = 'LiveRequestTimeoutError';
  }
}

async function withRequestTimeout<T>(
  request: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const boundedTimeout = Math.max(1, Math.floor(timeoutMs));
  let deadline: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        deadline = globalThis.setTimeout(
          () => reject(new LiveRequestTimeoutError(label, boundedTimeout)),
          boundedTimeout,
        );
      }),
    ]);
  } finally {
    if (deadline !== undefined) globalThis.clearTimeout(deadline);
  }
}

export interface LiveTarget {
  readonly tabId: number;
  readonly url: string;
}

export interface LiveRuntime {
  openTarget(scenario: LiveScenario): Promise<LiveTarget>;
  verifyEnvironment?(
    scenario: LiveScenario,
    target: LiveTarget,
  ): Promise<LiveEnvironmentVerification>;
  send(message: ExtensionMessage): Promise<unknown>;
  startProviderTrace?(activeUserText: string): void;
  finishProviderTrace?(): Promise<LiveProviderTrace>;
}

export interface LiveRunDependencies {
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly createRunId: () => string;
  readonly productRevision?: string;
  readonly cleanupRequestTimeoutMs?: number;
}

interface RuntimeTask {
  readonly id: string;
  readonly conversationId: string;
  readonly status: string;
  readonly lastError?: { readonly userMessage?: unknown } | null;
}

interface RuntimeModelTurn {
  readonly elapsedMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningOutputTokens?: number;
}

interface RuntimeTaskEvent {
  readonly type: string;
  readonly reason?: string;
  readonly callId?: string;
  readonly name?: string;
  readonly argumentsJson?: string;
  readonly resultId?: string;
  readonly metrics?: RuntimeModelTurn;
}

interface RuntimeToolResult {
  readonly id: string;
  readonly callId: string;
  readonly toolName: string;
  readonly argumentsJson: string;
  readonly output: string;
  readonly modelOutput?: string;
  readonly attachmentIds: readonly string[];
}

interface RuntimeTaskSnapshot {
  readonly task: RuntimeTask;
  readonly events: readonly RuntimeTaskEvent[];
  readonly toolResults: readonly RuntimeToolResult[];
}

const EVIDENCE_MISMATCH_CODE = 'E2E_EVIDENCE_MISMATCH';

class LiveEvidenceMismatchError extends Error {
  constructor(message: string) {
    super(EVIDENCE_MISMATCH_CODE + ': ' + message);
    this.name = 'LiveEvidenceMismatchError';
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LiveEvidenceMismatchError('Extension response has no valid ' + field + '.');
  }
  return value;
}

function optionalMetric(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new LiveEvidenceMismatchError(field + ' must be a finite non-negative number.');
  }
  return value;
}

function requiredMetric(value: unknown, field: string): number {
  const parsed = optionalMetric(value, field);
  if (parsed === undefined) {
    throw new LiveEvidenceMismatchError(field + ' is missing.');
  }
  return parsed;
}

function optionalMetricField(
  input: Readonly<Record<string, unknown>>,
  name: string,
  field: string,
): Readonly<Record<string, number>> {
  const value = optionalMetric(input[name], field + '.' + name);
  return value === undefined ? {} : { [name]: value };
}

function readModelTurnMetrics(value: unknown, field: string): RuntimeModelTurn {
  const metrics = jsonRecord(value);
  if (metrics === null) {
    throw new LiveEvidenceMismatchError(field + ' is missing.');
  }
  return {
    elapsedMs: requiredMetric(metrics.elapsedMs, field + '.elapsedMs'),
    ...optionalMetricField(metrics, 'inputTokens', field),
    ...optionalMetricField(metrics, 'outputTokens', field),
    ...optionalMetricField(metrics, 'totalTokens', field),
    ...optionalMetricField(metrics, 'cachedInputTokens', field),
    ...optionalMetricField(metrics, 'reasoningOutputTokens', field),
  };
}

function readTaskEvent(value: unknown, index: number): RuntimeTaskEvent {
  const event = jsonRecord(value);
  if (event === null) {
    throw new LiveEvidenceMismatchError(
      'TaskSnapshot.events[' + String(index) + '] is not an object.',
    );
  }
  const field = 'TaskSnapshot.events[' + String(index) + ']';
  const type = requiredString(event.type, field + '.type');
  if (type === 'model.turn') {
    return {
      type,
      metrics: readModelTurnMetrics(event.metrics, field + '.metrics'),
    };
  }
  if (type === 'tool.call') {
    return {
      type,
      callId: requiredString(event.callId, field + '.callId'),
      name: requiredString(event.name, field + '.name'),
      argumentsJson: requiredString(event.argumentsJson, field + '.argumentsJson'),
    };
  }
  if (type === 'tool.result') {
    return {
      type,
      callId: requiredString(event.callId, field + '.callId'),
      resultId: requiredString(event.resultId, field + '.resultId'),
    };
  }
  return {
    type: type.slice(0, 128),
    ...(typeof event.reason === 'string' ? { reason: event.reason.slice(0, 256) } : {}),
  };
}

function readLegacyToolResult(value: unknown, index: number): RuntimeToolResult {
  const result = jsonRecord(value);
  const field = 'TaskSnapshot.checkpoint.completedToolResults[' + String(index) + ']';
  if (result === null) throw new LiveEvidenceMismatchError(field + ' is not an object.');
  const attachmentIds = result.attachmentIds ?? [];
  if (!Array.isArray(attachmentIds) || attachmentIds.some((id) => typeof id !== 'string')) {
    throw new LiveEvidenceMismatchError(field + '.attachmentIds is invalid.');
  }
  if (result.modelOutput !== undefined && typeof result.modelOutput !== 'string') {
    throw new LiveEvidenceMismatchError(field + '.modelOutput is invalid.');
  }
  return {
    id: requiredString(result.resultRef, field + '.resultRef'),
    callId: requiredString(result.callId, field + '.callId'),
    toolName: requiredString(result.toolName, field + '.toolName'),
    argumentsJson: requiredString(result.argumentsJson, field + '.argumentsJson'),
    output: requiredString(result.output, field + '.output'),
    ...(typeof result.modelOutput === 'string' ? { modelOutput: result.modelOutput } : {}),
    attachmentIds,
  };
}

function readRuntimeToolResult(value: unknown, index: number): RuntimeToolResult {
  const result = jsonRecord(value);
  const field = 'TaskSnapshot.toolResults[' + String(index) + ']';
  if (result === null) {
    throw new LiveEvidenceMismatchError(field + ' is not an object.');
  }
  if (
    !Array.isArray(result.attachmentIds) ||
    result.attachmentIds.some((id) => typeof id !== 'string')
  ) {
    throw new LiveEvidenceMismatchError(field + '.attachmentIds is invalid.');
  }
  if (result.modelOutput !== undefined && typeof result.modelOutput !== 'string') {
    throw new LiveEvidenceMismatchError(field + '.modelOutput is invalid.');
  }
  return {
    id: requiredString(result.id, field + '.id'),
    callId: requiredString(result.callId, field + '.callId'),
    toolName: requiredString(result.toolName, field + '.toolName'),
    argumentsJson: requiredString(result.argumentsJson, field + '.argumentsJson'),
    output: requiredString(result.output, field + '.output'),
    ...(typeof result.modelOutput === 'string' ? { modelOutput: result.modelOutput } : {}),
    attachmentIds: result.attachmentIds,
  };
}

function readTaskSnapshot(value: unknown): RuntimeTaskSnapshot {
  const container = jsonRecord(value);
  const task = jsonRecord(container?.task);
  if (container === null || task === null) {
    throw new LiveEvidenceMismatchError('Extension response has no valid task snapshot.');
  }
  if (!Array.isArray(container.events)) {
    throw new LiveEvidenceMismatchError('TaskSnapshot.events is missing.');
  }
  const checkpoint = jsonRecord(container.checkpoint);
  const hasCurrentToolResults = Array.isArray(container.toolResults);
  const hasLegacyToolResults = Array.isArray(checkpoint?.completedToolResults);
  if (!hasCurrentToolResults && !hasLegacyToolResults) {
    throw new LiveEvidenceMismatchError('TaskSnapshot.toolResults is missing.');
  }
  const run = jsonRecord(container.run);
  const rawLastError = task.lastError === undefined ? run?.error : task.lastError;
  const lastError = rawLastError === null ? null : jsonRecord(rawLastError);
  const events = container.events.flatMap((value, index) => {
    const event = readTaskEvent(value, index);
    const legacyModelTurn = jsonRecord(jsonRecord(value)?.modelTurn);
    return legacyModelTurn === null
      ? [event]
      : [
          event,
          {
            type: 'model.turn',
            metrics: readModelTurnMetrics(
              legacyModelTurn,
              'TaskSnapshot.events[' + String(index) + '].modelTurn',
            ),
          },
        ];
  });
  const toolResults = hasCurrentToolResults
    ? (container.toolResults as readonly unknown[]).map(readRuntimeToolResult)
    : (checkpoint?.completedToolResults as readonly unknown[]).map(readLegacyToolResult);
  const evidenceEvents = hasCurrentToolResults
    ? events
    : [
        ...events,
        ...toolResults.flatMap((result) => [
          {
            type: 'tool.call',
            callId: result.callId,
            name: result.toolName,
            argumentsJson: result.argumentsJson,
          },
          { type: 'tool.result', callId: result.callId, resultId: result.id },
        ]),
      ];
  return {
    task: {
      id: requiredString(task.id, 'task ID'),
      conversationId: requiredString(task.conversationId, 'conversation ID'),
      status: requiredString(task.status, 'task status'),
      ...(rawLastError === null ? { lastError: null } : lastError === null ? {} : { lastError }),
    },
    events: evidenceEvents,
    toolResults,
  };
}

function readPreflightSnapshot(value: unknown): readonly string[] {
  const snapshot = jsonRecord(value);
  if (snapshot === null) throw new Error('The live preflight snapshot is invalid.');
  const tasks = snapshot?.tasks;
  if (!Array.isArray(tasks)) return [];
  return [
    ...new Set(
      tasks.flatMap((candidate) => {
        const task = jsonRecord(candidate);
        return task !== null &&
          typeof task.id === 'string' &&
          task.id.length > 0 &&
          typeof task.status === 'string' &&
          !FINISHED_TASK_STATUSES.has(task.status)
          ? [task.id]
          : [];
      }),
    ),
  ];
}

function readToolResults(results: readonly RuntimeToolResult[]): LiveToolResult[] {
  return results.map((result) => ({
    toolName: result.toolName.slice(0, 128),
    argumentsJson: sanitizeToolPayload(result.argumentsJson, MAX_REPORTED_ARGUMENT_CHARACTERS),
    output: sanitizeToolPayload(result.output, MAX_REPORTED_OUTPUT_CHARACTERS),
    auditOutputCharacters: result.output.length,
    modelOutputCharacters: (result.modelOutput ?? result.output).length,
    attachmentIds: result.attachmentIds.slice(0, 8),
  }));
}

function validateTaskEvidence(snapshot: RuntimeTaskSnapshot): void {
  const calls = new Map<string, RuntimeTaskEvent>();
  const resultEventsByCall = new Map<string, RuntimeTaskEvent>();
  const resultEventsById = new Map<string, RuntimeTaskEvent>();
  for (const event of snapshot.events) {
    if (event.type === 'tool.call') {
      const callId = event.callId;
      if (callId === undefined) {
        throw new LiveEvidenceMismatchError('A tool.call event has no call ID.');
      }
      if (calls.has(callId)) {
        throw new LiveEvidenceMismatchError('A call ID appears in more than one tool.call event.');
      }
      calls.set(callId, event);
    }
    if (event.type === 'tool.result') {
      const callId = event.callId;
      const resultId = event.resultId;
      if (callId === undefined || resultId === undefined) {
        throw new LiveEvidenceMismatchError('A tool.result event has incomplete identity.');
      }
      if (!calls.has(callId)) {
        throw new LiveEvidenceMismatchError('A tool.result event has no matching tool.call event.');
      }
      if (resultEventsByCall.has(callId) || resultEventsById.has(resultId)) {
        throw new LiveEvidenceMismatchError('A tool result identity appears more than once.');
      }
      resultEventsByCall.set(callId, event);
      resultEventsById.set(resultId, event);
    }
  }

  const snapshotResultsByCall = new Map<string, RuntimeToolResult>();
  const snapshotResultsById = new Map<string, RuntimeToolResult>();
  for (const result of snapshot.toolResults) {
    if (snapshotResultsByCall.has(result.callId) || snapshotResultsById.has(result.id)) {
      throw new LiveEvidenceMismatchError('TaskSnapshot contains duplicate tool results.');
    }
    const call = calls.get(result.callId);
    if (call === undefined) {
      throw new LiveEvidenceMismatchError(
        'TaskSnapshot tool result has no matching tool.call event.',
      );
    }
    if (call.name !== result.toolName || call.argumentsJson !== result.argumentsJson) {
      throw new LiveEvidenceMismatchError(
        'TaskSnapshot tool result differs from its tool.call event.',
      );
    }
    const resultEvent = resultEventsByCall.get(result.callId);
    if (resultEvent?.resultId !== result.id) {
      throw new LiveEvidenceMismatchError(
        'TaskSnapshot tool result has no matching tool.result event.',
      );
    }
    snapshotResultsByCall.set(result.callId, result);
    snapshotResultsById.set(result.id, result);
  }

  for (const [resultId, event] of resultEventsById) {
    const result = snapshotResultsById.get(resultId);
    if (result === undefined || result.callId !== event.callId) {
      throw new LiveEvidenceMismatchError(
        'A tool.result event has no matching TaskSnapshot tool result.',
      );
    }
  }
}

function readPanelCompletedToolCount(value: unknown): number {
  const details = jsonRecord(value);
  if (details === null || details.detailLevel !== 'full') {
    throw new LiveEvidenceMismatchError('Panel task details have an invalid tool projection.');
  }
  const results = Array.isArray(details.toolResults)
    ? details.toolResults
    : Array.isArray(details.completedToolResults)
      ? details.completedToolResults
      : null;
  if (results === null) {
    throw new LiveEvidenceMismatchError('Panel task details have an invalid tool projection.');
  }
  const count = details.completedToolCallCount ?? results.length;
  if (!Number.isSafeInteger(count) || (count as number) < 0) {
    throw new LiveEvidenceMismatchError('Panel task details have an invalid tool projection.');
  }
  return count as number;
}

function validateProviderEvidence(
  snapshot: RuntimeTaskSnapshot,
  providerTrace: LiveProviderTrace,
): void {
  const modelTurns = snapshot.events.filter((event) => event.type === 'model.turn');
  if (providerTrace.requestCount > 0 && modelTurns.length === 0) {
    throw new LiveEvidenceMismatchError(
      'Provider requests exist but TaskSnapshot has no model.turn events.',
    );
  }
  if (
    modelTurns.some(
      (event) =>
        event.metrics?.inputTokens === undefined ||
        event.metrics.outputTokens === undefined ||
        event.metrics.totalTokens === undefined,
    )
  ) {
    throw new LiveEvidenceMismatchError(
      'A model.turn event has no complete Provider usage metrics.',
    );
  }

  const providerFunctionOutputs = providerTrace.requests.reduce(
    (maximum, request) => Math.max(maximum, request.functionOutputCount),
    0,
  );
  const contextWasCompacted = snapshot.events.some(
    (event) =>
      event.type === 'context.compacted' ||
      event.type === 'context.cleared' ||
      (event.type === 'tool.call' && event.name === 'context_commit'),
  );
  if (providerFunctionOutputs > snapshot.toolResults.length) {
    throw new LiveEvidenceMismatchError(
      'Provider function outputs exceed TaskSnapshot tool results.',
    );
  }
  if (!contextWasCompacted && providerFunctionOutputs !== snapshot.toolResults.length) {
    throw new LiveEvidenceMismatchError(
      'Provider function outputs and TaskSnapshot tool results disagree.',
    );
  }
}

function readFinalText(value: unknown, taskId: string): string {
  const snapshot = jsonRecord(value);
  if (!Array.isArray(snapshot?.messages)) return '';
  return (
    snapshot.messages
      .flatMap((candidate) => {
        const message = jsonRecord(candidate);
        return message?.taskId === taskId &&
          message.role === 'assistant' &&
          typeof message.text === 'string'
          ? [{ text: message.text, updatedAt: Number(message.updatedAt) || 0 }]
          : [];
      })
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .at(-1)?.text ?? ''
  );
}

async function readFinalTextWithRetry(
  loadSnapshot: () => Promise<unknown>,
  taskId: string,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<string> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < FINAL_SNAPSHOT_ATTEMPTS; attempt += 1) {
    try {
      const text = readFinalText(await loadSnapshot(), taskId);
      lastError = null;
      if (text.length > 0) return text;
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < FINAL_SNAPSHOT_ATTEMPTS) {
      await sleep(FINAL_SNAPSHOT_RETRY_DELAY_MS);
    }
  }
  if (lastError !== null) throw lastError;
  return '';
}

function finiteMetric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function aggregateMetrics(events: RuntimeTaskSnapshot['events']): LiveModelMetrics {
  return events.reduce<LiveModelMetrics>(
    (metrics, event) => ({
      inputTokens: metrics.inputTokens + finiteMetric(event.metrics?.inputTokens),
      outputTokens: metrics.outputTokens + finiteMetric(event.metrics?.outputTokens),
      totalTokens: metrics.totalTokens + finiteMetric(event.metrics?.totalTokens),
      cachedInputTokens: metrics.cachedInputTokens + finiteMetric(event.metrics?.cachedInputTokens),
      reasoningOutputTokens:
        metrics.reasoningOutputTokens + finiteMetric(event.metrics?.reasoningOutputTokens),
      elapsedMs: metrics.elapsedMs + finiteMetric(event.metrics?.elapsedMs),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      elapsedMs: 0,
    },
  );
}

function providerRetryReasons(events: RuntimeTaskSnapshot['events']): readonly string[] {
  return events.flatMap((event) =>
    (event.type === 'status.changed' || event.type === 'planning.retrying') &&
    typeof event.reason === 'string' &&
    /^(?:transient_model_retry|invalid_model_response_retry):/u.test(event.reason)
      ? [event.reason]
      : [],
  );
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeToolPayload(message, MAX_REPORTED_ERROR_CHARACTERS);
}

function addError(current: string | null, error: unknown): string {
  const next = errorMessage(error);
  return current === null ? next : `${current} ${next}`.slice(0, MAX_REPORTED_ERROR_CHARACTERS);
}

/** Creates the production live-run dependencies while keeping revision lookup at the CLI boundary. */
export function createLiveRunDependencies(productRevision = 'unknown'): LiveRunDependencies {
  return {
    now: () => Date.now(),
    sleep: (milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }),
    createRunId: () => `live_${randomUUID()}`,
    productRevision,
  };
}

/** Records a setup/authorization failure as a normal immutable evaluation attempt. */
export function createLiveHarnessFailureReport(
  scenario: LiveScenario,
  error: unknown,
  dependencies: LiveRunDependencies = createLiveRunDependencies(),
): LiveRunReport {
  const runId = dependencies.createRunId();
  const expandedScenario = expandScenario(scenario, runId);
  const startedAtMs = dependencies.now();
  const endedAtMs = dependencies.now();
  const harnessError = errorMessage(error);
  const providerTrace: LiveProviderTrace = { requestCount: 0, requests: [] };
  const acceptance = evaluateLiveRun(expandedScenario, {
    terminalStatus: 'preflight_failed',
    finalText: '',
    toolResults: [],
    providerRetryReasons: [],
    providerTrace,
  });
  return {
    runId,
    scenario: scenario.name,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    elapsedMs: Math.max(0, endedAtMs - startedAtMs),
    terminalStatus: 'preflight_failed',
    taskId: '',
    conversationId: '',
    finalText: '',
    toolResults: [],
    modelMetrics: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      elapsedMs: 0,
    },
    executionMetrics: deriveLiveExecutionMetrics({
      toolResults: [],
      providerTrace,
      providerRetryReasons: [],
    }),
    providerTrace,
    productRevision: dependencies.productRevision ?? 'unknown',
    scenarioContractVersion: scenario.contractVersion,
    acceptance,
    harnessError,
  };
}

function expandRunMarker(value: string, runId: string): string {
  return value.split('{{RUN_ID}}').join(runId);
}

function expandScenario(scenario: LiveScenario, runId: string): LiveScenario {
  const expandAll = (values: readonly string[]): readonly string[] =>
    values.map((value) => expandRunMarker(value, runId));
  return {
    ...scenario,
    taskText: expandRunMarker(scenario.taskText, runId),
    finalTextIncludes: scenario.finalTextIncludes.map((value) => expandRunMarker(value, runId)),
    ...(scenario.finalTextExcludes === undefined
      ? {}
      : {
          finalTextExcludes: expandAll(scenario.finalTextExcludes),
        }),
    ...(scenario.requiredTypedTextIncludes === undefined
      ? {}
      : {
          requiredTypedTextIncludes: expandAll(scenario.requiredTypedTextIncludes),
        }),
    ...(scenario.requiredToolOutputIncludes === undefined
      ? {}
      : {
          requiredToolOutputIncludes: expandAll(scenario.requiredToolOutputIncludes),
        }),
  };
}

/** Runs one production extension task and always returns a sanitized, policy-evaluated report. */
export async function runLiveScenario(
  runtime: LiveRuntime,
  scenario: LiveScenario,
  dependencies: LiveRunDependencies = createLiveRunDependencies(),
): Promise<LiveRunReport> {
  const runId = dependencies.createRunId();
  const expandedScenario = expandScenario(scenario, runId);
  const startedAtMs = dependencies.now();
  let target: LiveTarget | null = null;
  let latestSnapshot: RuntimeTaskSnapshot | null = null;
  let taskId = '';
  let conversationId = '';
  let terminalStatus: string;
  let finalText = '';
  let toolResults: LiveToolResult[] = [];
  let providerTrace: LiveProviderTrace = { requestCount: 0, requests: [] };
  let harnessError: string | null = null;
  let requestSequence = 0;
  const cleanupRequestTimeoutMs =
    dependencies.cleanupRequestTimeoutMs ?? CLEANUP_REQUEST_TIMEOUT_MS;
  const request = <TType extends ExtensionMessage['type']>(
    type: TType,
    payload: Extract<ExtensionMessage, { readonly type: TType }>['payload'],
  ): ExtensionMessage =>
    ({
      version: 1,
      requestId: `${runId}_${String(++requestSequence)}`,
      type,
      payload,
    }) as ExtensionMessage;

  try {
    target = await runtime.openTarget(expandedScenario);
    if (new URL(target.url).origin !== expandedScenario.expectedOrigin) {
      throw new Error(
        `Target origin ${new URL(target.url).origin} does not match ${expandedScenario.expectedOrigin}.`,
      );
    }
    let environmentVerification: LiveEnvironmentVerification = {
      passed: true,
      checks: [],
    };
    if (expandedScenario.environment !== undefined) {
      if (runtime.verifyEnvironment === undefined) {
        throw new Error('Live runtime cannot verify the declared target environment.');
      }
      environmentVerification = await withRequestTimeout(
        runtime.verifyEnvironment(expandedScenario, target),
        expandedScenario.readinessTimeoutMs,
        'Target environment verification',
      );
      if (!environmentVerification.passed) {
        throw new Error(targetEnvironmentFailureMessage(environmentVerification));
      }
    }
    const preflight = await withRequestTimeout(
      runtime.send(request('panel.getSnapshot', { tabId: target.tabId })),
      expandedScenario.readinessTimeoutMs,
      'Live preflight request',
    );
    const configuredEnvironment = evaluateConfiguredLiveEnvironment(
      expandedScenario,
      target,
      preflight,
      environmentVerification,
    );
    if (!configuredEnvironment.passed) {
      throw new Error(configuredEnvironmentFailureMessage(configuredEnvironment));
    }
    const leftoverTaskIds = readPreflightSnapshot(preflight);
    for (const leftoverTaskId of leftoverTaskIds) {
      const cancelled = readTaskSnapshot(
        await withRequestTimeout(
          runtime.send(request('task.cancel', { taskId: leftoverTaskId })),
          cleanupRequestTimeoutMs,
          'Live leftover task cancellation',
        ),
      );
      if (
        cancelled.task.id !== leftoverTaskId ||
        !FINISHED_TASK_STATUSES.has(cancelled.task.status)
      ) {
        throw new Error('A leftover Live E2E task could not be cancelled.');
      }
    }
    runtime.startProviderTrace?.(expandedScenario.taskText);
    const deadline = dependencies.now() + expandedScenario.taskTimeoutMs;

    latestSnapshot = readTaskSnapshot(
      await withRequestTimeout(
        runtime.send(
          request('chat.submit', {
            tabId: target.tabId,
            text: expandedScenario.taskText,
            attachmentIds: [],
          }),
        ),
        Math.max(1, deadline - dependencies.now()),
        'Live task submission',
      ),
    );
    taskId = latestSnapshot.task.id;
    conversationId = latestSnapshot.task.conversationId;
    terminalStatus = latestSnapshot.task.status;

    while (!RUN_STOP_STATUSES.has(terminalStatus) && dependencies.now() < deadline) {
      await dependencies.sleep(POLL_INTERVAL_MS);
      if (dependencies.now() >= deadline) break;
      try {
        latestSnapshot = readTaskSnapshot(
          await withRequestTimeout(
            runtime.send(request('task.getSnapshot', { taskId })),
            Math.max(1, deadline - dependencies.now()),
            'Live task polling',
          ),
        );
      } catch (error) {
        if (error instanceof LiveRequestTimeoutError) break;
        throw error;
      }
      terminalStatus = latestSnapshot.task.status;
    }

    if (!RUN_STOP_STATUSES.has(terminalStatus)) {
      terminalStatus = 'timed_out';
      harnessError = `Live task timed out after ${String(expandedScenario.taskTimeoutMs)} ms and was cancelled.`;
      try {
        latestSnapshot = readTaskSnapshot(
          await withRequestTimeout(
            runtime.send(request('task.cancel', { taskId })),
            cleanupRequestTimeoutMs,
            'Live task cancellation',
          ),
        );
      } catch (cancelError) {
        harnessError = addError(harnessError, cancelError);
      }
    } else if (terminalStatus !== 'completed') {
      const userMessage = latestSnapshot.task.lastError?.userMessage;
      harnessError =
        typeof userMessage === 'string' && userMessage.length > 0
          ? errorMessage(userMessage)
          : `Live task ended with status ${terminalStatus}.`;
    }
  } catch (error) {
    harnessError = addError(harnessError, error);
    if (
      taskId.length > 0 &&
      (latestSnapshot === null || !RUN_STOP_STATUSES.has(latestSnapshot.task.status))
    ) {
      try {
        latestSnapshot = readTaskSnapshot(
          await withRequestTimeout(
            runtime.send(request('task.cancel', { taskId })),
            cleanupRequestTimeoutMs,
            'Live task cancellation',
          ),
        );
      } catch (cancelError) {
        harnessError = addError(harnessError, cancelError);
      }
    }
    terminalStatus = taskId.length === 0 ? 'preflight_failed' : 'harness_failed';
  }

  if (taskId.length > 0) {
    if (latestSnapshot === null) {
      harnessError = addError(
        harnessError,
        new LiveEvidenceMismatchError('The final TaskSnapshot is unavailable.'),
      );
    } else {
      try {
        validateTaskEvidence(latestSnapshot);
        toolResults = readToolResults(latestSnapshot.toolResults);
      } catch (error) {
        harnessError = addError(harnessError, error);
      }
      try {
        const panelToolCount = readPanelCompletedToolCount(
          await withRequestTimeout(
            runtime.send(request('panel.getTaskDetails', { taskId })),
            cleanupRequestTimeoutMs,
            'Live task details request',
          ),
        );
        if (panelToolCount !== latestSnapshot.toolResults.length) {
          throw new LiveEvidenceMismatchError(
            'Panel and TaskSnapshot completed tool counts disagree.',
          );
        }
      } catch (error) {
        harnessError = addError(harnessError, error);
      }
    }
    if (target !== null && conversationId.length > 0) {
      try {
        finalText = await readFinalTextWithRetry(
          () =>
            withRequestTimeout(
              runtime.send(
                request('panel.getSnapshot', {
                  tabId: target.tabId,
                  conversationId,
                }),
              ),
              cleanupRequestTimeoutMs,
              'Live final snapshot request',
            ),
          taskId,
          dependencies.sleep,
        );
      } catch (error) {
        harnessError = addError(harnessError, error);
      }
    }
  }

  if (runtime.finishProviderTrace !== undefined) {
    try {
      providerTrace = await withRequestTimeout(
        runtime.finishProviderTrace(),
        cleanupRequestTimeoutMs,
        'Live provider trace collection',
      );
    } catch (error) {
      harnessError = addError(harnessError, error);
    }
  }

  if (latestSnapshot !== null && runtime.finishProviderTrace !== undefined) {
    try {
      validateProviderEvidence(latestSnapshot, providerTrace);
    } catch (error) {
      harnessError = addError(harnessError, error);
    }
  }

  const endedAtMs = dependencies.now();
  const retryReasons = providerRetryReasons(latestSnapshot?.events ?? []);
  const acceptance = evaluateLiveRun(expandedScenario, {
    terminalStatus,
    finalText,
    toolResults,
    providerRetryReasons: retryReasons,
    ...(runtime.finishProviderTrace === undefined ? {} : { providerTrace }),
  });
  return {
    runId,
    scenario: scenario.name,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    elapsedMs: Math.max(0, endedAtMs - startedAtMs),
    terminalStatus,
    taskId,
    conversationId,
    finalText,
    toolResults,
    modelMetrics: aggregateMetrics(latestSnapshot?.events ?? []),
    executionMetrics: deriveLiveExecutionMetrics({
      toolResults,
      providerTrace,
      providerRetryReasons: retryReasons,
    }),
    providerTrace,
    productRevision: dependencies.productRevision ?? 'unknown',
    scenarioContractVersion: scenario.contractVersion,
    acceptance,
    harnessError,
  };
}

/** Adapts one loaded production extension session to the live scenario runner. */
export function createPlaywrightLiveRuntime(session: ExtensionSession): LiveRuntime {
  const providerTrace = new ResponsesTraceCollector(session.context, session.extensionId);
  const targetPages = new Map<number, Page>();
  return {
    async openTarget(scenario) {
      const targetPagePromise = session.context.waitForEvent('page', {
        timeout: scenario.readinessTimeoutMs,
      });
      const created = await session.sidePanelPage.evaluate(async (url) => {
        const tab = await chrome.tabs.create({ url, active: true });
        if (typeof tab.id !== 'number') throw new Error('Chrome did not return a target tab ID.');
        return { tabId: tab.id };
      }, scenario.startUrl);
      const targetPage = await targetPagePromise;
      const deadline = Date.now() + scenario.readinessTimeoutMs;
      while (Date.now() < deadline) {
        const tab = await session.sidePanelPage.evaluate(async (tabId) => {
          try {
            const current = await chrome.tabs.get(tabId);
            return { url: current.url ?? '', status: current.status ?? '' };
          } catch {
            return null;
          }
        }, created.tabId);
        const domReady = await targetPage
          .evaluate(
            () => document.readyState === 'interactive' || document.readyState === 'complete',
          )
          .catch(() => false);
        if (tab !== null && tab.url.length > 0 && (tab.status === 'complete' || domReady)) {
          targetPages.set(created.tabId, targetPage);
          return { tabId: created.tabId, url: tab.url };
        }
        await session.sidePanelPage.waitForTimeout(250);
      }
      throw new Error(`Target page was not ready after ${String(scenario.readinessTimeoutMs)} ms.`);
    },
    async verifyEnvironment(scenario, target) {
      if (scenario.environment === undefined) return { passed: true, checks: [] };
      const targetPage = targetPages.get(target.tabId);
      if (targetPage === undefined) {
        throw new Error('Target page is unavailable for environment verification.');
      }
      return waitForTargetEnvironment(scenario.environment, {
        timeoutMs: scenario.readinessTimeoutMs,
        sleep: async (milliseconds) => session.sidePanelPage.waitForTimeout(milliseconds),
        readState: async () =>
          targetPage.evaluate(() => ({
            url: globalThis.location.href,
            pageText: (document.body?.innerText ?? '').slice(0, 1_000_000),
          })),
      });
    },
    async send(message) {
      const response: unknown = await session.sidePanelPage.evaluate(
        async (request) => chrome.runtime.sendMessage(request),
        message,
      );
      const envelope = jsonRecord(response);
      if (
        envelope === null ||
        envelope.version !== 1 ||
        envelope.requestId !== message.requestId ||
        typeof envelope.ok !== 'boolean'
      ) {
        throw new Error(`${message.type} returned an invalid extension response.`);
      }
      const typed = response as ExtensionResponse<unknown>;
      if (!typed.ok) {
        throw new Error(`${message.type} failed with ${typed.error.code}: ${typed.error.message}`);
      }
      return typed.data;
    },
    startProviderTrace(activeUserText) {
      providerTrace.start(activeUserText);
    },
    async finishProviderTrace() {
      return providerTrace.finish();
    },
  };
}
