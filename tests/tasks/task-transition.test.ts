import { describe, expect, it } from 'vitest';
import { createTask } from '../../src/tasks/task-factory';
import { transitionTask } from '../../src/tasks/task-transition';
import type { TaskRun } from '../../src/tasks/task-types';

const clock = { now: () => 1_000 };
const ids = { create: (prefix: string) => `${prefix}_1` };

describe('task transitions', () => {
  it('creates a queued per-tab task and enters observation without mutating it', () => {
    const task = createTask(
      { conversationId: 'conv_1', tabId: 7, goal: 'Fill the form' },
      { clock, ids },
    );
    Object.freeze(task);

    const observing = transitionTask(task, {
      type: 'observation.started',
      at: 1_001,
      reason: 'Task execution started.',
    });

    expect(task.status).toBe('queued');
    expect(observing).not.toBe(task);
    expect(observing).toMatchObject({ status: 'observing', updatedAt: 1_001 });
  });

  it('advances through the normal durable execution states', () => {
    const queued = createTask(
      { conversationId: 'conv_1', tabId: 7, goal: 'Fill the form' },
      { clock, ids },
    );

    const observing = transitionTask(queued, {
      type: 'observation.started',
      at: 1_001,
      reason: 'Observe.',
    });
    const planning = transitionTask(observing, {
      type: 'planning.started',
      at: 1_002,
      reason: 'Plan.',
    });
    const acting = transitionTask(planning, {
      type: 'action.intent-recorded',
      at: 1_003,
      reason: 'Intent persisted.',
    });
    const verifying = transitionTask(acting, {
      type: 'action.evidence-recorded',
      at: 1_004,
      reason: 'Verify effect.',
    });
    const checkpointed = transitionTask(verifying, {
      type: 'action.verified',
      at: 1_005,
      reason: 'Effect verified.',
    });
    const completed = transitionTask(checkpointed, {
      type: 'task.completed',
      at: 1_006,
      reason: 'Goal verified.',
    });

    expect([
      observing.status,
      planning.status,
      acting.status,
      verifying.status,
      checkpointed.status,
      completed.status,
    ]).toEqual(['observing', 'planning', 'acting', 'verifying', 'checkpointed', 'completed']);
  });

  it.each([
    ['task.tab-missing', 'waiting_for_tab'],
    ['task.auth-required', 'waiting_for_auth'],
    ['task.confirmation-required', 'waiting_for_confirmation'],
    ['task.paused', 'paused'],
    ['task.budget-exhausted', 'paused'],
  ] as const)('maps %s to %s', (type, expectedStatus) => {
    const task = createTask(
      { conversationId: 'conv_1', tabId: 7, goal: 'Fill the form' },
      { clock, ids },
    );

    expect(transitionTask(task, { type, at: 1_001, reason: 'Execution must wait.' }).status).toBe(
      expectedStatus,
    );
  });

  it('resumes a waiting task from a clean queued boundary', () => {
    const task = createTask(
      { conversationId: 'conv_1', tabId: 7, goal: 'Fill the form' },
      { clock, ids },
    );
    const waiting = transitionTask(task, {
      type: 'task.auth-required',
      at: 1_001,
      reason: 'Token expired.',
      error: {
        code: 'AuthError',
        retryable: false,
        recoveryAction: 'Update the Access Token.',
        userMessage: 'Access Token 已失效。',
        evidenceRef: null,
      },
    });

    const resumed = transitionTask(waiting, {
      type: 'task.resumed',
      at: 1_002,
      reason: 'Token updated.',
    });

    expect(resumed).toMatchObject({ status: 'queued', lastError: null });
  });

  it('binds only an explicitly supplied replacement tab while resuming a missing-tab task', () => {
    const task = createTask(
      { conversationId: 'conv_1', tabId: 7, goal: 'Fill the form' },
      { clock, ids },
    );
    const missing = transitionTask(task, {
      type: 'task.tab-missing',
      at: 1_001,
      reason: 'Bound tab closed.',
    });

    expect(
      transitionTask(missing, {
        type: 'task.resumed',
        at: 1_002,
        reason: 'User selected replacement tab.',
        boundTabId: 9,
      }),
    ).toMatchObject({ status: 'queued', tabId: 9 });
  });

  it('rejects illegal transitions, stale timestamps, and terminal-state changes', () => {
    const queued = createTask(
      { conversationId: 'conv_1', tabId: 7, goal: 'Fill the form' },
      { clock, ids },
    );
    const completed: TaskRun = { ...queued, status: 'completed' };

    expect(() =>
      transitionTask(queued, {
        type: 'action.verified',
        at: 1_001,
        reason: 'Skipped required states.',
      }),
    ).toThrow(/illegal task transition/i);
    expect(() =>
      transitionTask(queued, {
        type: 'observation.started',
        at: 999,
        reason: 'Clock moved backwards.',
      }),
    ).toThrow(/transition timestamp/i);
    expect(() =>
      transitionTask(completed, {
        type: 'observation.started',
        at: 1_001,
        reason: 'Terminal tasks do not restart.',
      }),
    ).toThrow(/illegal task transition/i);
  });
});
