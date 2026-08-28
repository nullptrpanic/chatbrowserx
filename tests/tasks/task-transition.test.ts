import { describe, expect, it } from 'vitest';
import { createTaskRecords } from '../../src/tasks/task-factory';
import { transitionTask } from '../../src/tasks/task-transition';

const clock = { now: () => 1_000 };
let identifier = 0;
const ids = { create: (prefix: string) => `${prefix}_${String(++identifier)}` };

function queuedRecords() {
  return createTaskRecords(
    { conversationId: 'conversation_1', tabId: 7, goal: 'Answer the message' },
    { clock, ids },
  );
}

describe('transitionTask', () => {
  it('updates the logical task and latest run together through one model turn', () => {
    const queued = queuedRecords();
    const planning = transitionTask(queued.task, queued.run, {
      type: 'planning.started',
      at: 1_001,
      reason: 'model_request_started',
    });
    const call = transitionTask(planning.task, planning.run, {
      type: 'tool.call-recorded',
      at: 1_002,
      reason: 'browser_click_call_recorded',
    });
    const result = transitionTask(call.task, call.run, {
      type: 'tool.result-recorded',
      at: 1_003,
      reason: 'browser_click_result_recorded',
    });
    const completed = transitionTask(result.task, result.run, {
      type: 'task.completed',
      at: 1_004,
      reason: 'model_response_completed',
    });

    expect(planning).toMatchObject({ task: { status: 'planning' }, run: { status: 'planning' } });
    expect(result).toMatchObject({ task: { status: 'planning' }, run: { status: 'planning' } });
    expect(completed).toMatchObject({
      task: { status: 'completed', latestRunId: queued.run.id },
      run: { status: 'completed', endedAt: 1_004, lease: null },
    });
  });

  it('normalizes auth, pause, failure, and cancellation on the current run', () => {
    const error = {
      code: 'AuthError',
      retryable: false,
      recoveryAction: 'update_credentials',
      userMessage: 'Access Token is invalid.',
      evidenceRef: null,
    } as const;
    for (const [type, expected] of [
      ['task.auth-required', 'waiting_for_auth'],
      ['task.paused', 'paused'],
      ['task.cancelled', 'cancelled'],
    ] as const) {
      const queued = queuedRecords();
      expect(
        transitionTask(queued.task, queued.run, {
          type,
          at: 1_001,
          reason: type,
          ...(type === 'task.auth-required' ? { error } : {}),
        }),
      ).toMatchObject({ task: { status: expected }, run: { status: expected, endedAt: 1_001 } });
    }

    const queued = queuedRecords();
    expect(
      transitionTask(queued.task, queued.run, {
        type: 'task.failed',
        at: 1_001,
        reason: 'provider_failed',
        error,
      }),
    ).toMatchObject({
      task: { status: 'failed' },
      run: { status: 'failed', error, endedAt: 1_001 },
    });
  });

  it('requires a new TaskRun for resume and retry instead of reopening a terminal run', () => {
    const queued = queuedRecords();
    const paused = transitionTask(queued.task, queued.run, {
      type: 'task.paused',
      at: 1_001,
      reason: 'user_pause',
    });
    expect(() =>
      transitionTask(paused.task, paused.run, {
        type: 'planning.started',
        at: 1_002,
        reason: 'resume_without_new_run',
      }),
    ).toThrow(/illegal task transition/i);
  });

  it.each([
    ['task.paused', 'paused'],
    ['task.auth-required', 'waiting_for_auth'],
  ] as const)('allows cancellation from the resumable %s state', (waitingType, expectedStatus) => {
    const queued = queuedRecords();
    const waiting = transitionTask(queued.task, queued.run, {
      type: waitingType,
      at: 1_001,
      reason: waitingType,
      ...(waitingType === 'task.auth-required'
        ? {
            error: {
              code: 'AuthError',
              retryable: false,
              recoveryAction: 'update_credentials',
              userMessage: 'Access Token is invalid.',
              evidenceRef: null,
            } as const,
          }
        : {}),
    });
    expect(waiting.task.status).toBe(expectedStatus);

    expect(
      transitionTask(waiting.task, waiting.run, {
        type: 'task.cancelled',
        at: 1_002,
        reason: 'user_cancel',
      }),
    ).toMatchObject({ task: { status: 'cancelled' }, run: { status: 'cancelled' } });
  });

  it('preserves the real run end time when cancelled context is cleared later', () => {
    const queued = queuedRecords();
    const cancelled = transitionTask(queued.task, queued.run, {
      type: 'task.cancelled',
      at: 1_001,
      reason: 'user_cancel',
    });
    const cleared = transitionTask(cancelled.task, cancelled.run, {
      type: 'task.context-cleared',
      at: 1_100,
      reason: 'user_clear_task_context',
    });

    expect(cleared).toMatchObject({
      task: { status: 'cancelled', updatedAt: 1_100 },
      run: { status: 'cancelled', endedAt: 1_001 },
    });
  });

  it('rejects mismatched runs, skipped states, stale time, and incomplete failures', () => {
    const queued = queuedRecords();
    expect(() =>
      transitionTask(
        queued.task,
        { ...queued.run, id: 'another_run' },
        {
          type: 'planning.started',
          at: 1_001,
          reason: 'wrong_run',
        },
      ),
    ).toThrow(/latest run/i);
    expect(() =>
      transitionTask(queued.task, queued.run, {
        type: 'task.completed',
        at: 1_001,
        reason: 'skipped_planning',
      }),
    ).toThrow(/illegal task transition/i);
    expect(() =>
      transitionTask(queued.task, queued.run, {
        type: 'planning.started',
        at: 999,
        reason: 'clock_moved_backwards',
      }),
    ).toThrow(/timestamp/i);
    expect(() =>
      transitionTask(queued.task, queued.run, {
        type: 'task.failed',
        at: 1_001,
        reason: 'missing_error',
      }),
    ).toThrow(/require.*error/i);
  });
});
