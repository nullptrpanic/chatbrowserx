import { describe, expect, it, vi } from 'vitest';
import type { ExtensionMessage } from '../../../src/shared/protocol/message-types';
import { runLiveScenario, type LiveRuntime } from '../../runner/run-live-scenario';
import type { LiveProviderTrace, LiveScenario } from '../../runner/live-types';

const scenario: LiveScenario = {
  contractVersion: 1,
  name: 'read-chat',
  description: 'Reads one chat without changing it.',
  startUrl: 'https://example.com/chat',
  expectedOrigin: 'https://example.com',
  taskText: 'Read the latest messages without changing anything.',
  readinessTimeoutMs: 10_000,
  environment: {
    targetSetupMode: 'interactive',
    targetSetupInstructions: ['Sign in with the evaluation account.'],
    readinessChecks: [{ kind: 'page_text_includes', value: 'Example chat' }],
  },
  taskTimeoutMs: 2_000,
  maxToolCalls: 12,
  requiredTools: ['browser_inspect'],
  forbiddenTools: ['browser_click_point'],
  forbidScreenshotInspect: true,
  forbidSubmittedType: true,
  finalTextIncludes: ['Example chat'],
  minFinalTextLength: 20,
  allowRemoteMutation: false,
};

function taskSnapshot(status: string, includeEvidence = false) {
  const output = JSON.stringify({
    ok: true,
    page: 'Example chat',
    accessToken: 'secret-output',
  });
  const modelOutput = JSON.stringify({ ok: true, page: 'Example chat' });
  return {
    task: {
      id: 'task_live',
      conversationId: 'conversation_live',
      status,
      lastError: null,
    },
    events: includeEvidence
      ? [
          {
            id: 'event_model_1',
            taskId: 'task_live',
            runId: 'run_task_live',
            sequence: 1,
            type: 'model.turn',
            at: 1_100,
            metrics: {
              inputItemCount: 1,
              elapsedMs: 120,
              firstEventMs: 20,
              inputTokens: 100,
              outputTokens: 30,
              totalTokens: 130,
              cachedInputTokens: 40,
              cacheWriteInputTokens: 5,
              reasoningOutputTokens: 10,
            },
          },
          {
            id: 'event_call_1',
            taskId: 'task_live',
            runId: 'run_task_live',
            sequence: 2,
            type: 'tool.call',
            at: 1_200,
            callId: 'call_1',
            name: 'browser_inspect',
            argumentsJson: JSON.stringify({
              mode: 'interactive',
              authorization: 'secret-argument',
            }),
          },
          {
            id: 'event_result_1',
            taskId: 'task_live',
            runId: 'run_task_live',
            sequence: 3,
            type: 'tool.result',
            at: 1_300,
            callId: 'call_1',
            resultId: 'result_1',
          },
          {
            id: 'event_model_2',
            taskId: 'task_live',
            runId: 'run_task_live',
            sequence: 4,
            type: 'model.turn',
            at: 1_400,
            metrics: {
              inputItemCount: 3,
              elapsedMs: 180,
              firstEventMs: 30,
              firstTextMs: 60,
              inputTokens: 200,
              outputTokens: 50,
              totalTokens: 250,
              cachedInputTokens: 80,
              cacheWriteInputTokens: 7,
              reasoningOutputTokens: 20,
            },
          },
        ]
      : [],
    toolResults: includeEvidence
      ? [
          {
            id: 'result_1',
            taskId: 'task_live',
            runId: 'run_task_live',
            callId: 'call_1',
            toolName: 'browser_inspect',
            argumentsJson: JSON.stringify({
              mode: 'interactive',
              authorization: 'secret-argument',
            }),
            output,
            modelOutput,
            attachmentIds: [],
            createdAt: 1_300,
          },
        ]
      : [],
  };
}

function panelSnapshot() {
  return {
    generatedAt: 2_000,
    tab: {
      id: 42,
      title: 'Example',
      url: scenario.startUrl,
      origin: scenario.expectedOrigin,
      supported: true,
      hasPermission: true,
    },
    conversation: { id: 'conversation_live' },
    conversations: [],
    messages: [
      {
        id: 'message_final',
        taskId: 'task_live',
        role: 'assistant',
        status: 'complete',
        text: 'Example chat contains the latest visible discussion.',
        attachmentIds: [],
        createdAt: 2_000,
        updatedAt: 2_000,
      },
    ],
    attachments: [],
    tasks: [],
    task: null,
    settings: { hasCodexToken: true },
  };
}

function panelTaskDetails(completedToolCallCount: number) {
  return {
    id: 'task_live',
    detailLevel: 'full',
    completedToolCallCount,
    toolResults: Array.from({ length: completedToolCallCount }, (_, index) => ({
      resultId: `result_${String(index + 1)}`,
    })),
  };
}

function providerTrace(functionOutputCount: number, requestCount = 2): LiveProviderTrace {
  return {
    requestCount,
    requests: Array.from({ length: requestCount }, (_, index) => {
      const count = index === requestCount - 1 ? functionOutputCount : 0;
      return {
        sequence: index + 1,
        extensionOwned: true,
        bodyValid: true,
        model: 'gpt-5.6-terra',
        instructionCharacters: 100,
        store: false,
        stream: true,
        parallelToolCalls: false,
        includesEncryptedReasoning: true,
        toolNames: ['browser_inspect'],
        toolDefinitionCharacters: 100,
        toolDefinitionFingerprint: 'aaaaaaaaaaaaaaaa',
        skillCatalogDisclosureCount: 0,
        toolChoice: 'auto',
        inputItems: [],
        activeUserRequestOccurrences: index === 0 ? 1 : 0,
        runtimeSupplementOccurrences: 0,
        functionCallCount: count,
        functionOutputCount: count,
        orphanFunctionOutputCount: 0,
        unpairedFunctionCallCount: 0,
        duplicateFunctionCallIds: false,
        encryptedReasoningInputCount: index,
        response: {
          status: 200,
          contentType: 'text/event-stream',
          bodyBytes: 100,
          bodyTooLarge: false,
          completed: true,
          failed: false,
          eventTypes: ['response.completed'],
          encryptedReasoningOutputCount: 1,
          captureError: null,
        },
      };
    }),
  };
}

function liveRuntime(
  handler: (message: ExtensionMessage) => unknown | Promise<unknown>,
): LiveRuntime & { readonly messages: ExtensionMessage[] } {
  const messages: ExtensionMessage[] = [];
  return {
    messages,
    async openTarget() {
      return { tabId: 42, url: scenario.startUrl };
    },
    async verifyEnvironment() {
      return {
        passed: true,
        checks: [{ kind: 'page_text_includes', passed: true, detail: 'Matched.' }],
      };
    },
    async send(message) {
      messages.push(message);
      return handler(message);
    },
  };
}

async function runCompletedSnapshot(
  snapshot: unknown,
  panelToolCount: number,
  trace?: LiveProviderTrace,
  liveScenario: LiveScenario = scenario,
) {
  const base = liveRuntime((message) => {
    switch (message.type) {
      case 'panel.getSnapshot':
        return panelSnapshot();
      case 'chat.submit':
        return snapshot;
      case 'panel.getTaskDetails':
        return panelTaskDetails(panelToolCount);
      default:
        throw new Error('Unexpected message: ' + message.type);
    }
  });
  const runtime: LiveRuntime =
    trace === undefined
      ? base
      : {
          ...base,
          startProviderTrace() {},
          async finishProviderTrace() {
            return trace;
          },
        };
  return runLiveScenario(runtime, liveScenario, {
    now: () => 10_000,
    sleep: vi.fn(),
    createRunId: () => 'run_evidence_check',
  });
}

describe('live scenario orchestration', () => {
  it('does not submit a task when target environment verification fails', async () => {
    const runtime = liveRuntime(() => {
      throw new Error('No extension request is expected.');
    });
    runtime.verifyEnvironment = async () => ({
      passed: false,
      checks: [{ kind: 'page_text_includes', passed: false, detail: 'Not matched.' }],
    });

    const report = await runLiveScenario(runtime, scenario, {
      now: () => 10_000,
      sleep: vi.fn(),
      createRunId: () => 'run_environment_failure',
    });

    expect(runtime.messages).toHaveLength(0);
    expect(report.harnessError).toContain('Target environment verification failed');
  });

  it('expands the run marker before submitting a code-owned live scenario', async () => {
    const templatedScenario: LiveScenario = {
      ...scenario,
      taskText: 'Send marker {{RUN_ID}} once.',
      finalTextIncludes: ['{{RUN_ID}}'],
    };
    const runtime = liveRuntime((message) => {
      switch (message.type) {
        case 'panel.getSnapshot':
          return panelSnapshot();
        case 'chat.submit':
          return taskSnapshot('completed');
        case 'panel.getTaskDetails':
          return panelTaskDetails(0);
        default:
          throw new Error(`Unexpected message: ${message.type}`);
      }
    });

    await runLiveScenario(runtime, templatedScenario, {
      now: () => 10_000,
      sleep: vi.fn(),
      createRunId: () => 'run_unique_123',
    });

    expect(runtime.messages.find(({ type }) => type === 'chat.submit')).toMatchObject({
      payload: { text: 'Send marker run_unique_123 once.' },
    });
  });

  it('submits exactly once, captures bounded evidence, and aggregates numeric model metrics', async () => {
    let taskPolls = 0;
    const runtime = liveRuntime((message) => {
      switch (message.type) {
        case 'panel.getSnapshot':
          return panelSnapshot();
        case 'chat.submit':
          return taskSnapshot('queued');
        case 'task.getSnapshot':
          taskPolls += 1;
          return taskSnapshot(taskPolls === 1 ? 'planning' : 'completed', taskPolls !== 1);
        case 'panel.getTaskDetails':
          return panelTaskDetails(1);
        default:
          throw new Error(`Unexpected message: ${message.type}`);
      }
    });
    let currentTime = 10_000;

    const report = await runLiveScenario(runtime, scenario, {
      now: () => currentTime,
      sleep: async (milliseconds) => {
        currentTime += milliseconds;
      },
      createRunId: () => 'run_live',
    });

    expect(runtime.messages.filter(({ type }) => type === 'chat.submit')).toHaveLength(1);
    expect(runtime.messages.filter(({ type }) => type === 'task.cancel')).toHaveLength(0);
    expect(report).toMatchObject({
      runId: 'run_live',
      terminalStatus: 'completed',
      taskId: 'task_live',
      conversationId: 'conversation_live',
      finalText: 'Example chat contains the latest visible discussion.',
      modelMetrics: {
        inputTokens: 300,
        outputTokens: 80,
        totalTokens: 380,
        cachedInputTokens: 120,
        cacheWriteInputTokens: 12,
        reasoningOutputTokens: 30,
        elapsedMs: 300,
        firstEventMs: 20,
        firstTextMs: 60,
      },
      executionMetrics: { modelRounds: 2 },
      acceptance: { passed: true },
      harnessError: null,
    });
    expect(report.toolResults).toHaveLength(1);
    expect(report.toolResults[0]?.argumentsJson).not.toContain('secret');
  });

  it('recovers a completed task when the first final panel snapshot request fails', async () => {
    let panelSnapshotRequests = 0;
    const runtime = liveRuntime((message) => {
      switch (message.type) {
        case 'panel.getSnapshot':
          panelSnapshotRequests += 1;
          if (panelSnapshotRequests === 2) throw new Error('runtime connection lost');
          return panelSnapshot();
        case 'chat.submit':
          return taskSnapshot('completed', true);
        case 'panel.getTaskDetails':
          return panelTaskDetails(1);
        default:
          throw new Error(`Unexpected message: ${message.type}`);
      }
    });

    const report = await runLiveScenario(runtime, scenario, {
      now: () => 10_000,
      sleep: vi.fn(async () => undefined),
      createRunId: () => 'run_final_snapshot_retry',
    });

    expect(panelSnapshotRequests).toBe(3);
    expect(report.finalText).toBe('Example chat contains the latest visible discussion.');
    expect(report.harnessError).toBeNull();
  });

  it('counts durable provider retry reasons from status-change events', async () => {
    const snapshot = structuredClone(taskSnapshot('completed', true));
    const events = snapshot.events as unknown as Array<Record<string, unknown>>;
    events.splice(1, 0, {
      id: 'event_retry_1',
      taskId: 'task_live',
      runId: 'run_task_live',
      sequence: 2,
      type: 'status.changed',
      at: 1_150,
      taskStatus: 'planning',
      runStatus: 'planning',
      reason: 'transient_model_retry:upstream_failure',
      error: null,
    });

    const report = await runCompletedSnapshot(snapshot, 1);

    expect(report.executionMetrics.providerRetries).toBe(1);
    expect(report.executionMetrics.providerRetryCounts).toEqual({
      'transient_model_retry:upstream_failure': 1,
    });
  });

  it('preserves a legitimate zero-millisecond first event latency', async () => {
    const snapshot = structuredClone(taskSnapshot('completed', true));
    const firstModelTurn = snapshot.events.find((event) => event.type === 'model.turn');
    if (firstModelTurn?.type !== 'model.turn' || firstModelTurn.metrics === undefined) {
      throw new Error('Expected a model turn fixture.');
    }
    firstModelTurn.metrics.firstEventMs = 0;

    const report = await runCompletedSnapshot(snapshot, 1);

    expect(report.modelMetrics.firstEventMs).toBe(0);
    expect(report.modelMetrics.firstTextMs).toBe(60);
  });

  it('reads factual tool and model evidence from the legacy checkpoint snapshot', async () => {
    const argumentsJson = JSON.stringify({ mode: 'interactive' });
    const output = JSON.stringify({ ok: true, page: 'Example chat' });
    const runtime = liveRuntime((message) => {
      switch (message.type) {
        case 'panel.getSnapshot':
          return panelSnapshot();
        case 'chat.submit':
          return {
            task: {
              id: 'task_live',
              conversationId: 'conversation_live',
              status: 'completed',
              lastError: null,
            },
            checkpoint: {
              completedToolResults: [
                {
                  callId: 'call_legacy_1',
                  toolName: 'browser_inspect',
                  argumentsJson,
                  output,
                  modelOutput: output,
                  resultRef: 'result_legacy_1',
                  attachmentIds: [],
                },
              ],
            },
            events: [
              {
                type: 'tool.result-recorded',
                reason: 'browser_result_recorded',
                modelTurn: {
                  inputItemCount: 3,
                  elapsedMs: 250,
                  firstEventMs: 20,
                  inputTokens: 200,
                  outputTokens: 40,
                  totalTokens: 240,
                  cachedInputTokens: 80,
                  reasoningOutputTokens: 10,
                },
              },
            ],
          };
        case 'panel.getTaskDetails':
          return {
            id: 'task_live',
            detailLevel: 'full',
            completedToolCallCount: 1,
            completedToolResults: [{ resultRef: 'result_legacy_1' }],
          };
        default:
          throw new Error(`Unexpected message: ${message.type}`);
      }
    });

    const report = await runLiveScenario(runtime, scenario, {
      now: () => 10_000,
      sleep: vi.fn(async () => undefined),
      createRunId: () => 'run_legacy_snapshot',
    });

    expect(report.harnessError).toBeNull();
    expect(report.toolResults).toEqual([
      expect.objectContaining({
        toolName: 'browser_inspect',
        argumentsJson,
        output,
      }),
    ]);
    expect(report.modelMetrics).toMatchObject({
      inputTokens: 200,
      outputTokens: 40,
      totalTokens: 240,
      elapsedMs: 250,
    });
  });

  it('reports the current run error when a task pauses after provider retries', async () => {
    const runtime = liveRuntime((message) => {
      switch (message.type) {
        case 'panel.getSnapshot':
          return panelSnapshot();
        case 'chat.submit':
          return {
            task: {
              id: 'task_live',
              conversationId: 'conversation_live',
              status: 'paused',
            },
            run: {
              error: {
                code: 'TransientProviderError',
                retryable: true,
                userMessage: 'The provider is temporarily unavailable.',
              },
            },
            checkpoint: null,
            events: [],
            toolResults: [],
          };
        case 'panel.getTaskDetails':
          return panelTaskDetails(0);
        default:
          throw new Error(`Unexpected message: ${message.type}`);
      }
    });

    const report = await runLiveScenario(runtime, scenario, {
      now: () => 10_000,
      sleep: vi.fn(async () => undefined),
      createRunId: () => 'run_provider_paused',
    });

    expect(report.terminalStatus).toBe('paused');
    expect(report.taskError).toContain('The provider is temporarily unavailable.');
    expect(report.harnessError).toBeNull();
  });

  it('cancels a paused task before starting a fresh WorkSession', async () => {
    const runtime = liveRuntime((message) => {
      switch (message.type) {
        case 'panel.getSnapshot':
          return {
            ...panelSnapshot(),
            tasks: [{ id: 'task_paused', status: 'paused' }],
          };
        case 'task.cancel':
          return {
            ...taskSnapshot('cancelled'),
            task: {
              ...taskSnapshot('cancelled').task,
              id: 'task_paused',
            },
          };
        case 'chat.submit':
          return taskSnapshot('completed');
        case 'panel.getTaskDetails':
          return panelTaskDetails(0);
        default:
          throw new Error(`Unexpected message: ${message.type}`);
      }
    });

    const report = await runLiveScenario(runtime, scenario, {
      now: () => 10_000,
      sleep: vi.fn(),
      createRunId: () => 'run_after_paused_task',
    });

    expect(runtime.messages.filter(({ type }) => type === 'task.cancel')).toEqual([
      expect.objectContaining({ payload: { taskId: 'task_paused' } }),
    ]);
    expect(runtime.messages.filter(({ type }) => type === 'chat.submit')).toHaveLength(1);
    expect(report.terminalStatus).toBe('completed');
    expect(report.harnessError).toBeNull();
  });

  it('reads tools and model metrics from the authoritative current TaskSnapshot protocol', async () => {
    const runtime = liveRuntime((message) => {
      switch (message.type) {
        case 'panel.getSnapshot':
          return panelSnapshot();
        case 'chat.submit':
          return taskSnapshot('completed', true);
        case 'panel.getTaskDetails':
          return {
            id: 'task_live',
            detailLevel: 'full',
            completedToolCallCount: 1,
            toolResults: [{ resultId: 'result_1' }],
          };
        default:
          throw new Error('Unexpected message: ' + message.type);
      }
    });

    const report = await runLiveScenario(runtime, scenario, {
      now: () => 10_000,
      sleep: vi.fn(),
      createRunId: () => 'run_current_snapshot',
    });

    expect(report.harnessError).toBeNull();
    expect(report.toolResults).toEqual([
      expect.objectContaining({
        toolName: 'browser_inspect',
        auditOutputCharacters: 63,
        modelOutputCharacters: 33,
      }),
    ]);
    expect(report.toolResults[0]?.argumentsJson).not.toContain('secret-argument');
    expect(report.toolResults[0]?.output).not.toContain('secret-output');
    expect(report.modelMetrics).toEqual({
      inputTokens: 300,
      outputTokens: 80,
      totalTokens: 380,
      cachedInputTokens: 120,
      cacheWriteInputTokens: 12,
      reasoningOutputTokens: 30,
      elapsedMs: 300,
      firstEventMs: 20,
      firstTextMs: 60,
    });
  });

  it('evaluates complete tool evidence while keeping the reported projection bounded', async () => {
    const tail = 'CHATBROWSERX_TAIL_DIAGNOSTIC_9471';
    const snapshot = structuredClone(taskSnapshot('completed', true));
    const result = snapshot.toolResults[0];
    if (result === undefined) throw new Error('Missing tool-result fixture.');
    result.output = 'x'.repeat(55_000) + tail;
    const evidenceScenario: LiveScenario = {
      ...scenario,
      requiredToolResultIncludes: [tail],
    };

    const report = await runCompletedSnapshot(snapshot, 1, undefined, evidenceScenario);

    expect(
      report.acceptance.checks.find(({ name }) => name === 'required-tool-result-content'),
    ).toMatchObject({ passed: true });
    expect(report.toolResults[0]?.output).not.toContain(tail);
    expect(report.toolResults[0]?.output.length).toBeLessThanOrEqual(50_000);
    expect(report.toolResults[0]?.auditOutputCharacters).toBe(55_000 + tail.length);
  });

  it('fails closed when Provider tool outputs have no local TaskSnapshot results', async () => {
    const snapshot = structuredClone(taskSnapshot('completed', true));
    snapshot.events = snapshot.events.filter(
      (event) => event.type !== 'tool.call' && event.type !== 'tool.result',
    );
    snapshot.toolResults = [];

    const report = await runCompletedSnapshot(snapshot, 0, providerTrace(1));

    expect(report.harnessError).toContain('E2E_EVIDENCE_MISMATCH');
    expect(report.harnessError).toContain('Provider function outputs exceed');
  });

  it('fails closed when Provider requests have no durable model-turn metrics', async () => {
    const report = await runCompletedSnapshot(taskSnapshot('completed'), 0, providerTrace(0));

    expect(report.harnessError).toContain('E2E_EVIDENCE_MISMATCH');
    expect(report.harnessError).toContain('no model.turn events');
  });

  it('fails closed when a model turn has no complete Provider usage', async () => {
    const snapshot = structuredClone(taskSnapshot('completed', true));
    const modelTurn = snapshot.events.find((event) => event.type === 'model.turn');
    if (modelTurn?.type !== 'model.turn') throw new Error('Missing model-turn fixture.');
    const mutableModelTurn = modelTurn as unknown as {
      metrics: { inputTokens?: number };
    };
    delete mutableModelTurn.metrics.inputTokens;

    const report = await runCompletedSnapshot(snapshot, 1, providerTrace(1));

    expect(report.harnessError).toContain('E2E_EVIDENCE_MISMATCH');
    expect(report.harnessError).toContain('no complete Provider usage');
  });

  it('fails closed when a durable tool result has no matching call event', async () => {
    const snapshot = structuredClone(taskSnapshot('completed', true));
    const resultEvent = snapshot.events.find((event) => event.type === 'tool.result');
    if (resultEvent?.type !== 'tool.result') throw new Error('Missing result-event fixture.');
    resultEvent.callId = 'call_without_event';

    const report = await runCompletedSnapshot(snapshot, 1);

    expect(report.harnessError).toContain('E2E_EVIDENCE_MISMATCH');
    expect(report.harnessError).toContain('no matching tool.call event');
  });

  it('fails closed when TaskSnapshot tool data has no matching result event', async () => {
    const snapshot = structuredClone(taskSnapshot('completed', true));
    snapshot.events = snapshot.events.filter((event) => event.type !== 'tool.result');

    const report = await runCompletedSnapshot(snapshot, 1);

    expect(report.harnessError).toContain('E2E_EVIDENCE_MISMATCH');
    expect(report.harnessError).toContain('no matching tool.result event');
  });

  it('fails closed when a tool call has neither a result event nor a snapshot result', async () => {
    const snapshot = structuredClone(taskSnapshot('completed', true));
    snapshot.events = snapshot.events.filter((event) => event.type !== 'tool.result');
    snapshot.toolResults = [];

    const report = await runCompletedSnapshot(snapshot, 0);

    expect(report.harnessError).toContain('E2E_EVIDENCE_MISMATCH');
    expect(report.harnessError).toContain('tool.call event has no matching tool result');
  });

  it('fails closed when one call ID has multiple durable results', async () => {
    const snapshot = structuredClone(taskSnapshot('completed', true));
    const original = snapshot.toolResults[0];
    if (original === undefined) throw new Error('Missing tool-result fixture.');
    snapshot.toolResults.push({ ...original, id: 'result_2' });
    snapshot.events.push({
      id: 'event_result_2',
      taskId: 'task_live',
      runId: 'run_task_live',
      sequence: 5,
      type: 'tool.result',
      at: 1_500,
      callId: 'call_1',
      resultId: 'result_2',
    });

    const report = await runCompletedSnapshot(snapshot, 2);

    expect(report.harnessError).toContain('E2E_EVIDENCE_MISMATCH');
    expect(report.harnessError).toContain('identity appears more than once');
  });

  it('fails closed when the Panel tool count differs from the factual snapshot', async () => {
    const report = await runCompletedSnapshot(taskSnapshot('completed', true), 0);

    expect(report.harnessError).toContain('E2E_EVIDENCE_MISMATCH');
    expect(report.harnessError).toContain('Panel and TaskSnapshot');
  });

  it('cancels only its submitted task on timeout and still returns a failed report', async () => {
    const runtime = liveRuntime((message) => {
      switch (message.type) {
        case 'panel.getSnapshot':
          return panelSnapshot();
        case 'chat.submit':
          return taskSnapshot('queued');
        case 'task.getSnapshot':
          return taskSnapshot('planning');
        case 'task.cancel':
          return taskSnapshot('cancelled');
        case 'panel.getTaskDetails':
          return panelTaskDetails(0);
        default:
          throw new Error(`Unexpected message: ${message.type}`);
      }
    });
    let currentTime = 20_000;

    const report = await runLiveScenario(runtime, scenario, {
      now: () => currentTime,
      sleep: async (milliseconds) => {
        currentTime += milliseconds;
      },
      createRunId: () => 'run_timeout',
    });

    const cancellations = runtime.messages.filter(({ type }) => type === 'task.cancel');
    expect(cancellations).toEqual([expect.objectContaining({ payload: { taskId: 'task_live' } })]);
    expect(report.terminalStatus).toBe('timed_out');
    expect(report.acceptance.passed).toBe(false);
    expect(report.taskError).toMatch(/timed out/i);
    expect(report.harnessError).toBeNull();
  });

  it('bounds a polling request that never resolves by the task deadline', async () => {
    const pendingSnapshot = new Promise<never>(() => undefined);
    const runtime = liveRuntime((message) => {
      switch (message.type) {
        case 'panel.getSnapshot':
          return panelSnapshot();
        case 'chat.submit':
          return taskSnapshot('queued');
        case 'task.getSnapshot':
          return pendingSnapshot;
        case 'task.cancel':
          return taskSnapshot('cancelled');
        case 'panel.getTaskDetails':
          return panelTaskDetails(0);
        default:
          throw new Error(`Unexpected message: ${message.type}`);
      }
    });
    const boundedScenario: LiveScenario = { ...scenario, taskTimeoutMs: 25 };

    const outcome = await Promise.race([
      runLiveScenario(runtime, boundedScenario, {
        now: () => Date.now(),
        sleep: async () => undefined,
        createRunId: () => 'run_stalled_poll',
      }),
      new Promise<'test-timeout'>((resolve) => {
        globalThis.setTimeout(() => resolve('test-timeout'), 150);
      }),
    ]);

    expect(outcome).not.toBe('test-timeout');
    if (outcome === 'test-timeout') return;
    expect(outcome.terminalStatus).toBe('timed_out');
    expect(outcome.taskError).toMatch(/timed out/i);
    expect(outcome.harnessError).toBeNull();
    expect(runtime.messages.filter(({ type }) => type === 'task.cancel')).toHaveLength(1);
  });

  it('returns a timed-out report when cancellation itself never resolves', async () => {
    const pendingCancellation = new Promise<never>(() => undefined);
    const runtime = liveRuntime((message) => {
      switch (message.type) {
        case 'panel.getSnapshot':
          return panelSnapshot();
        case 'chat.submit':
          return taskSnapshot('queued');
        case 'task.getSnapshot':
          return taskSnapshot('planning');
        case 'task.cancel':
          return pendingCancellation;
        case 'panel.getTaskDetails':
          return panelTaskDetails(0);
        default:
          throw new Error(`Unexpected message: ${message.type}`);
      }
    });
    let currentTime = 40_000;

    const outcome = await Promise.race([
      runLiveScenario(
        runtime,
        { ...scenario, taskTimeoutMs: 500 },
        {
          now: () => currentTime,
          sleep: async (milliseconds) => {
            currentTime += milliseconds;
          },
          createRunId: () => 'run_stalled_cancel',
          cleanupRequestTimeoutMs: 25,
        },
      ),
      new Promise<'test-timeout'>((resolve) => {
        globalThis.setTimeout(() => resolve('test-timeout'), 150);
      }),
    ]);

    expect(outcome).not.toBe('test-timeout');
    if (outcome === 'test-timeout') return;
    expect(outcome.terminalStatus).toBe('timed_out');
    expect(outcome.taskError).toMatch(/timed out/i);
    expect(outcome.harnessError).toMatch(/cancellation/i);
    expect(runtime.messages.filter(({ type }) => type === 'task.cancel')).toHaveLength(1);
  });

  it('cancels its submitted task when polling fails before a terminal state', async () => {
    const runtime = liveRuntime((message) => {
      switch (message.type) {
        case 'panel.getSnapshot':
          return panelSnapshot();
        case 'chat.submit':
          return taskSnapshot('queued');
        case 'task.getSnapshot':
          throw new Error('runtime connection lost');
        case 'task.cancel':
          return taskSnapshot('cancelled');
        case 'panel.getTaskDetails':
          return panelTaskDetails(0);
        default:
          throw new Error(`Unexpected message: ${message.type}`);
      }
    });
    let currentTime = 25_000;

    const report = await runLiveScenario(runtime, scenario, {
      now: () => currentTime,
      sleep: async (milliseconds) => {
        currentTime += milliseconds;
      },
      createRunId: () => 'run_poll_failure',
    });

    expect(runtime.messages.filter(({ type }) => type === 'task.cancel')).toEqual([
      expect.objectContaining({ payload: { taskId: 'task_live' } }),
    ]);
    expect(report.terminalStatus).toBe('harness_failed');
    expect(report.harnessError).toMatch(/runtime connection lost/i);
  });

  it('does not submit when the dedicated profile has no configured access token', async () => {
    const runtime = liveRuntime((message) => {
      if (message.type !== 'panel.getSnapshot') {
        throw new Error(`Unexpected message: ${message.type}`);
      }
      return {
        ...panelSnapshot(),
        settings: { hasCodexToken: false },
      };
    });

    const report = await runLiveScenario(runtime, scenario, {
      now: () => 30_000,
      sleep: vi.fn(),
      createRunId: () => 'run_no_token',
    });

    expect(runtime.messages.filter(({ type }) => type === 'chat.submit')).toHaveLength(0);
    expect(report.terminalStatus).toBe('preflight_failed');
    expect(report.harnessError).toMatch(/access token/i);
  });
});
