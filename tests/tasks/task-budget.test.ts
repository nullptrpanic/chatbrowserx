import { describe, expect, it } from 'vitest';
import {
  consumeBrowserAction,
  consumeReplan,
  DEFAULT_TASK_BUDGET,
  isWallClockBudgetExhausted,
} from '../../src/tasks/task-budget';

describe('task budget', () => {
  it('exhausts the browser-action budget at exactly 50 actions', () => {
    expect(consumeBrowserAction({ ...DEFAULT_TASK_BUDGET, browserActionsUsed: 49 })).toMatchObject({
      browserActionsUsed: 50,
      exhausted: true,
    });
  });

  it('never increments an already exhausted browser-action budget', () => {
    expect(consumeBrowserAction({ ...DEFAULT_TASK_BUDGET, browserActionsUsed: 50 })).toMatchObject({
      browserActionsUsed: 50,
      exhausted: true,
    });
  });

  it('exhausts the replan budget at exactly two replans', () => {
    expect(consumeReplan({ ...DEFAULT_TASK_BUDGET, replansUsed: 1 })).toMatchObject({
      replansUsed: 2,
      exhausted: true,
    });
  });

  it('treats the wall-clock limit as an inclusive boundary', () => {
    expect(
      isWallClockBudgetExhausted(DEFAULT_TASK_BUDGET, 1_000, 1_000 + 20 * 60 * 1_000 - 1),
    ).toBe(false);
    expect(isWallClockBudgetExhausted(DEFAULT_TASK_BUDGET, 1_000, 1_000 + 20 * 60 * 1_000)).toBe(
      true,
    );
  });
});
