import { describe, expect, it } from 'vitest';
import { createTask } from '../../src/tasks/task-factory';
import { transitionTask } from '../../src/tasks/task-transition';
import type { TaskRun } from '../../src/tasks/task-types';

const clock = { now: () => 1_000 };
const ids = { create: (prefix: string) => `${prefix}_1` };

describe('task transitions', () => {
  it('advances through one durable model turn without browser states', () => {
    const queued = createTask(
      { conversationId: 'conv_1', tabId: 7, goal: 'Answer the message' },
      { clock, ids },
    );
    const planning = transitionTask(queued, {
      type: 'planning.started',
      at: 1_001,
      reason: 'Request started.',
    });
    const callRecorded = transitionTask(planning, {
      type: 'tool.call-recorded',
      at: 1_002,
      reason: 'Tavily call recorded.',
    });
    const executionStarted = transitionTask(callRecorded, {
      type: 'tool.execution-started',
      at: 1_003,
      reason: 'Browser mutation dispatch started.',
    });
    const resultRecorded = transitionTask(executionStarted, {
      type: 'tool.result-recorded',
      at: 1_004,
      reason: 'Tavily result recorded.',
    });
    const supplementsApplied = transitionTask(resultRecorded, {
      type: 'task.supplements-applied',
      at: 1_005,
      reason: 'User supplements applied.',
    });
    const completed = transitionTask(supplementsApplied, {
      type: 'task.completed',
      at: 1_006,
      reason: 'Response completed.',
    });

    expect(queued.status).toBe('queued');
    expect(planning.status).toBe('planning');
    expect(callRecorded.status).toBe('planning');
    expect(executionStarted.status).toBe('planning');
    expect(resultRecorded.status).toBe('planning');
    expect(supplementsApplied.status).toBe('planning');
    expect(completed.status).toBe('completed');
  });

  it('persists authentication waits and clears the error on resume', () => {
    const queued = createTask(
      { conversationId: 'conv_1', tabId: 7, goal: 'Answer the message' },
      { clock, ids },
    );
    const waiting = transitionTask(queued, {
      type: 'task.auth-required',
      at: 1_001,
      reason: 'Token expired.',
      error: {
        code: 'AuthError',
        retryable: false,
        recoveryAction: 'update_credentials',
        userMessage: 'Access Token is invalid.',
        evidenceRef: null,
      },
    });
    const resumed = transitionTask(waiting, {
      type: 'task.resumed',
      at: 1_002,
      reason: 'Token updated.',
    });

    expect(waiting.status).toBe('waiting_for_auth');
    expect(resumed).toMatchObject({ status: 'queued', lastError: null });
  });

  it('returns a failed task to the queued boundary only through retry', () => {
    const queued = createTask(
      { conversationId: 'conv_1', tabId: 7, goal: 'Answer the message' },
      { clock, ids },
    );
    const failed = transitionTask(queued, {
      type: 'task.failed',
      at: 1_001,
      reason: 'Provider failed.',
      error: {
        code: 'TransientProviderError',
        retryable: true,
        recoveryAction: 'resume_task',
        userMessage: 'The provider is temporarily unavailable.',
        evidenceRef: null,
      },
    });
    const retried = transitionTask(failed, {
      type: 'task.retried',
      at: 1_002,
      reason: 'User retried.',
    });

    expect(retried).toMatchObject({ status: 'queued', lastError: null });
    expect(() =>
      transitionTask(failed, {
        type: 'task.resumed',
        at: 1_002,
        reason: 'Failed tasks are retried, not resumed.',
      }),
    ).toThrow(/illegal task transition/i);
  });

  it('rejects skipped states, stale timestamps, and terminal-state changes', () => {
    const queued = createTask(
      { conversationId: 'conv_1', tabId: 7, goal: 'Answer the message' },
      { clock, ids },
    );
    const completed: TaskRun = { ...queued, status: 'completed' };

    expect(() =>
      transitionTask(queued, {
        type: 'task.completed',
        at: 1_001,
        reason: 'Skipped planning.',
      }),
    ).toThrow(/illegal task transition/i);
    expect(() =>
      transitionTask(queued, {
        type: 'planning.started',
        at: 999,
        reason: 'Clock moved backwards.',
      }),
    ).toThrow(/transition timestamp/i);
    expect(() =>
      transitionTask(completed, {
        type: 'task.paused',
        at: 1_001,
        reason: 'Terminal tasks do not restart.',
      }),
    ).toThrow(/illegal task transition/i);
  });
});
