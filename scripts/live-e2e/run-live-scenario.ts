import { randomUUID } from 'node:crypto';
import type { ExtensionSession } from './extension-session';
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

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const POLL_INTERVAL_MS = 500;
const CLEANUP_REQUEST_TIMEOUT_MS = 10_000;
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
  send(message: ExtensionMessage): Promise<unknown>;
  startProviderTrace?(activeUserText: string): void;
  finishProviderTrace?(): Promise<LiveProviderTrace>;
}

export interface LiveRunDependencies {
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly createRunId: () => string;
  readonly cleanupRequestTimeoutMs?: number;
}

interface RuntimeTask {
  readonly id: string;
  readonly conversationId: string;
  readonly status: string;
  readonly lastError?: { readonly userMessage?: unknown } | null;
}

interface RuntimeModelTurn {
  readonly elapsedMs?: unknown;
  readonly inputTokens?: unknown;
  readonly outputTokens?: unknown;
  readonly totalTokens?: unknown;
  readonly cachedInputTokens?: unknown;
  readonly reasoningOutputTokens?: unknown;
}

interface RuntimeTaskSnapshot {
  readonly task: RuntimeTask;
  readonly events: readonly { readonly modelTurn?: RuntimeModelTurn }[];
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Extension response has no valid ${field}.`);
  }
  return value;
}

function readTaskSnapshot(value: unknown): RuntimeTaskSnapshot {
  const container = record(value);
  const task = record(container?.task);
  if (container === null || task === null) {
    throw new Error('Extension response has no valid task snapshot.');
  }
  const events = Array.isArray(container.events)
    ? container.events.flatMap((event) => {
        const eventRecord = record(event);
        if (eventRecord === null) return [];
        const modelTurn = record(eventRecord.modelTurn);
        return [{ ...(modelTurn === null ? {} : { modelTurn }) }];
      })
    : [];
  const lastError = task.lastError === null ? null : record(task.lastError);
  return {
    task: {
      id: requiredString(task.id, 'task ID'),
      conversationId: requiredString(task.conversationId, 'conversation ID'),
      status: requiredString(task.status, 'task status'),
      ...(task.lastError === null ? { lastError: null } : lastError === null ? {} : { lastError }),
    },
    events,
  };
}

function readPreflightSnapshot(value: unknown, tabId: number): void {
  const snapshot = record(value);
  const settings = record(snapshot?.settings);
  const tab = record(snapshot?.tab);
  if (settings?.hasCodexToken !== true) {
    throw new Error('Dedicated live E2E profile has no configured Codex access token.');
  }
  if (tab === null || tab.id !== tabId || tab.supported !== true || tab.hasPermission !== true) {
    throw new Error('The target tab is unavailable to the ChatBrowserX extension.');
  }
}

function readToolResults(value: unknown): LiveToolResult[] {
  const details = record(value);
  if (!Array.isArray(details?.completedToolResults)) return [];
  return details.completedToolResults.flatMap((candidate) => {
    const result = record(candidate);
    if (
      result === null ||
      typeof result.toolName !== 'string' ||
      typeof result.argumentsJson !== 'string' ||
      typeof result.output !== 'string'
    ) {
      return [];
    }
    return [
      {
        toolName: result.toolName.slice(0, 128),
        argumentsJson: sanitizeToolPayload(result.argumentsJson, MAX_REPORTED_ARGUMENT_CHARACTERS),
        output: sanitizeToolPayload(result.output, MAX_REPORTED_OUTPUT_CHARACTERS),
        attachmentIds: Array.isArray(result.attachmentIds)
          ? result.attachmentIds.filter((id): id is string => typeof id === 'string').slice(0, 8)
          : [],
      },
    ];
  });
}

function readFinalText(value: unknown, taskId: string): string {
  const snapshot = record(value);
  if (!Array.isArray(snapshot?.messages)) return '';
  return (
    snapshot.messages
      .flatMap((candidate) => {
        const message = record(candidate);
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

function finiteMetric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function aggregateMetrics(events: RuntimeTaskSnapshot['events']): LiveModelMetrics {
  return events.reduce<LiveModelMetrics>(
    (metrics, event) => ({
      inputTokens: metrics.inputTokens + finiteMetric(event.modelTurn?.inputTokens),
      outputTokens: metrics.outputTokens + finiteMetric(event.modelTurn?.outputTokens),
      totalTokens: metrics.totalTokens + finiteMetric(event.modelTurn?.totalTokens),
      cachedInputTokens:
        metrics.cachedInputTokens + finiteMetric(event.modelTurn?.cachedInputTokens),
      reasoningOutputTokens:
        metrics.reasoningOutputTokens + finiteMetric(event.modelTurn?.reasoningOutputTokens),
      elapsedMs: metrics.elapsedMs + finiteMetric(event.modelTurn?.elapsedMs),
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

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeToolPayload(message, MAX_REPORTED_ERROR_CHARACTERS);
}

function addError(current: string | null, error: unknown): string {
  const next = errorMessage(error);
  return current === null ? next : `${current} ${next}`.slice(0, MAX_REPORTED_ERROR_CHARACTERS);
}

function defaultDependencies(): LiveRunDependencies {
  return {
    now: () => Date.now(),
    sleep: (milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }),
    createRunId: () => `live_${randomUUID()}`,
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
  dependencies: LiveRunDependencies = defaultDependencies(),
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
    const preflight = await withRequestTimeout(
      runtime.send(request('panel.getSnapshot', { tabId: target.tabId })),
      expandedScenario.readinessTimeoutMs,
      'Live preflight request',
    );
    readPreflightSnapshot(preflight, target.tabId);
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

    while (!TERMINAL_STATUSES.has(terminalStatus) && dependencies.now() < deadline) {
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

    if (!TERMINAL_STATUSES.has(terminalStatus)) {
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
      (latestSnapshot === null || !TERMINAL_STATUSES.has(latestSnapshot.task.status))
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
    try {
      toolResults = readToolResults(
        await withRequestTimeout(
          runtime.send(request('panel.getTaskDetails', { taskId })),
          cleanupRequestTimeoutMs,
          'Live task details request',
        ),
      );
    } catch (error) {
      harnessError = addError(harnessError, error);
    }
    if (target !== null && conversationId.length > 0) {
      try {
        finalText = readFinalText(
          await withRequestTimeout(
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

  const endedAtMs = dependencies.now();
  const acceptance = evaluateLiveRun(expandedScenario, {
    terminalStatus,
    finalText,
    toolResults,
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
    providerTrace,
    acceptance,
    harnessError,
  };
}

/** Adapts one loaded production extension session to the live scenario runner. */
export function createPlaywrightLiveRuntime(session: ExtensionSession): LiveRuntime {
  const providerTrace = new ResponsesTraceCollector(session.context, session.extensionId);
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
          return { tabId: created.tabId, url: tab.url };
        }
        await session.sidePanelPage.waitForTimeout(250);
      }
      throw new Error(`Target page was not ready after ${String(scenario.readinessTimeoutMs)} ms.`);
    },
    async send(message) {
      const response: unknown = await session.sidePanelPage.evaluate(
        async (request) => chrome.runtime.sendMessage(request),
        message,
      );
      const envelope = record(response);
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
