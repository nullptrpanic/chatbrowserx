import type { TaskBudget } from './task-types';

export type TaskBudgetConsumption = TaskBudget & { readonly exhausted: boolean };

export const DEFAULT_TASK_BUDGET: TaskBudget = Object.freeze({
  browserActionsLimit: 50,
  browserActionsUsed: 0,
  actionAttemptsLimit: 3,
  replansLimit: 2,
  replansUsed: 0,
  wallClockLimitMs: 20 * 60 * 1_000,
});

/**
 * Consumes one browser action without allowing the persisted count to exceed its hard limit.
 */
export function consumeBrowserAction(budget: TaskBudget): TaskBudgetConsumption {
  const browserActionsUsed = Math.min(budget.browserActionsUsed + 1, budget.browserActionsLimit);

  return {
    ...budget,
    browserActionsUsed,
    exhausted: browserActionsUsed >= budget.browserActionsLimit,
  };
}

/**
 * Consumes one full replan without allowing the persisted count to exceed its hard limit.
 */
export function consumeReplan(budget: TaskBudget): TaskBudgetConsumption {
  const replansUsed = Math.min(budget.replansUsed + 1, budget.replansLimit);

  return {
    ...budget,
    replansUsed,
    exhausted: replansUsed >= budget.replansLimit,
  };
}

/**
 * Determines whether elapsed wall-clock time has reached the task's inclusive hard limit.
 */
export function isWallClockBudgetExhausted(
  budget: TaskBudget,
  taskStartedAt: number,
  now: number,
): boolean {
  return now - taskStartedAt >= budget.wallClockLimitMs;
}
