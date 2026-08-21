import { describe, expect, it, vi } from 'vitest';
import type { ExtensionMessage } from '../../../src/shared/protocol/message-types';
import { runLiveScenario, type LiveRuntime } from '../../../scripts/live-e2e/run-live-scenario';
import type { LiveScenario } from '../../../scripts/live-e2e/live-types';

const scenario: LiveScenario = {
  name: 'read-chat',
  description: 'Reads one chat without changing it.',
  startUrl: 'https://example.com/chat',
  expectedOrigin: 'https://example.com',
  taskText: 'Read the latest messages without changing anything.',
  readinessTimeoutMs: 10_000,
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

function taskSnapshot(status: string) {
  return {
    task: {
      id: 'task_live',
      workSessionId: 'work_session_live',
      conversationId: 'conversation_live',
      tabId: 42,
      goal: scenario.taskText,
      status,
      createdAt: 1_000,
      updatedAt: 2_000,
      checkpointId: 'checkpoint_live',
      lease: null,
      lastError: null,
    },
    checkpoint: {
      id: 'checkpoint_live',
      taskId: 'task_live',
      sequence: 3,
      taskStatus: status,
      completedToolResults: [],
      continuationItems: [],
      pendingToolCall: null,
      createdAt: 1_000,
    },
    events: [
      {
        id: 'event_model_1',
        taskId: 'task_live',
        sequence: 1,
        type: 'planning.started',
        reason: 'model_turn_completed',
        at: 1_100,
        error: null,
        modelTurn: {
          inputItemCount: 1,
          elapsedMs: 120,
          firstEventMs: 20,
          inputTokens: 100,
          outputTokens: 30,
          totalTokens: 130,
          cachedInputTokens: 40,
          reasoningOutputTokens: 10,
        },
      },
      {
        id: 'event_model_2',
        taskId: 'task_live',
        sequence: 2,
        type: 'tool.call-recorded',
        reason: 'model_turn_completed',
        at: 1_200,
        error: null,
        modelTurn: {
          inputItemCount: 3,
          elapsedMs: 180,
          firstEventMs: 30,
          inputTokens: 200,
          outputTokens: 50,
          totalTokens: 250,
          cachedInputTokens: 80,
          reasoningOutputTokens: 20,
        },
      },
    ],
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

function liveRuntime(
  handler: (message: ExtensionMessage) => unknown | Promise<unknown>,
): LiveRuntime & { readonly messages: ExtensionMessage[] } {
  const messages: ExtensionMessage[] = [];
  return {
    messages,
    async openTarget() {
      return { tabId: 42, url: scenario.startUrl };
    },
    async send(message) {
      messages.push(message);
      return handler(message);
    },
  };
}

describe('live scenario orchestration', () => {
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
          return {
            id: 'task_live',
            status: 'completed',
            completedToolResults: [],
          };
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
          return taskSnapshot(taskPolls === 1 ? 'planning' : 'completed');
        case 'panel.getTaskDetails':
          return {
            id: 'task_live',
            status: 'completed',
            completedToolResults: [
              {
                callId: 'call_1',
                toolName: 'browser_inspect',
                argumentsJson: JSON.stringify({
                  mode: 'interactive',
                  authorization: 'secret',
                }),
                output: JSON.stringify({ ok: true, page: 'Example chat' }),
                resultRef: 'result_1',
                attachmentIds: [],
              },
            ],
          };
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
        reasoningOutputTokens: 30,
        elapsedMs: 300,
      },
      acceptance: { passed: true },
      harnessError: null,
    });
    expect(report.toolResults).toHaveLength(1);
    expect(report.toolResults[0]?.argumentsJson).not.toContain('secret');
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
          return {
            id: 'task_live',
            status: 'cancelled',
            completedToolResults: [],
          };
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
    expect(report.harnessError).toMatch(/timed out/i);
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
          return {
            id: 'task_live',
            status: 'cancelled',
            completedToolResults: [],
          };
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
    expect(outcome.harnessError).toMatch(/timed out/i);
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
          return {
            id: 'task_live',
            status: 'planning',
            completedToolResults: [],
          };
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
    expect(outcome.harnessError).toMatch(/timed out/i);
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
          return {
            id: 'task_live',
            status: 'cancelled',
            completedToolResults: [],
          };
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
