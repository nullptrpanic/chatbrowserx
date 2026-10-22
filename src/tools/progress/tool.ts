import type { MaterializedToolResult } from '../../tasks/tool-result-types';
import { register } from '../register';
import type { ToolCompletionReview, ToolDeclaration, ToolRuntimeContext } from '../types';
import {
  TASK_PROGRESS_TOOL,
  progressDefinition,
  progressSchema,
  progressStateSchema,
  type ProgressInput,
  type ProgressState,
} from './contract';

function latestProgress(context: ToolRuntimeContext): {
  state: ProgressState;
  result: MaterializedToolResult;
  sequence: number;
} | null {
  for (const result of [...(context.toolResults ?? [])].reverse()) {
    if (result.toolName !== TASK_PROGRESS_TOOL || result.taskId !== context.task?.id) continue;
    try {
      const output = JSON.parse(result.output) as {
        ok?: boolean;
        updated?: boolean;
        state?: unknown;
      };
      if (output.ok !== true || output.updated !== true) continue;
      const state = progressStateSchema.parse(output.state);
      const sequence =
        context.events?.find(
          (event) => event.type === 'tool.result' && event.resultId === result.id,
        )?.sequence ?? 0;
      return { state, result, sequence };
    } catch {
      /* Invalid/failed updates cannot replace a valid ledger. */
    }
  }
  return null;
}

function progressReview(context: ToolRuntimeContext, updatedState?: ProgressState) {
  const progress = latestProgress(context);
  const state = updatedState ?? progress?.state;
  const counts = { pending: 0, uncertain: 0, verified: 0, excluded: 0 };
  for (const item of state?.items ?? []) counts[item.status] += 1;
  const next = (action: string, status?: 'pending' | 'uncertain') => ({
    action,
    itemIds: status
      ? (state?.items ?? [])
          .filter((item) => item.status === status)
          .slice(0, 5)
          .map((item) => item.id)
      : [],
  });
  if (!state) {
    const attempted = context.toolResults?.some((result) => {
      if (result.toolName !== TASK_PROGRESS_TOOL || result.taskId !== context.task?.id)
        return false;
      try {
        return progressSchema.parse(JSON.parse(result.argumentsJson)).update !== null;
      } catch {
        return true;
      }
    });
    return {
      completion: attempted ? 'continue' : 'not_tracked',
      reason: 'no_inventory',
      counts,
      next: attempted ? next('record_inventory') : null,
    };
  }
  const scopeChanged =
    !updatedState &&
    progress &&
    (progress.result.runId !== context.checkpoint?.runId ||
      context.events?.some(
        (event) =>
          event.sequence > progress.sequence &&
          (event.type === 'supplement.applied' ||
            event.type === 'supplement.queued' ||
            event.type === 'context.cleared'),
      ));
  const changed =
    scopeChanged ||
    (!updatedState &&
      progress &&
      context.events?.some(
        (event) =>
          event.sequence > progress.sequence &&
          event.type === 'tool.call' &&
          event.name !== TASK_PROGRESS_TOOL &&
          event.name !== 'commit_context',
      ));
  const reconcile = {
    completion: 'continue',
    reason: 'stale_progress',
    counts,
    next: next('reconcile_progress'),
  };
  if (scopeChanged) return reconcile;
  if (!changed && state.blocker)
    return {
      completion: 'blocked',
      reason: 'external_blocker',
      blocker: state.blocker,
      counts,
      next: null,
    };
  if (counts.uncertain)
    return {
      completion: 'continue',
      reason: 'unverified_outcomes',
      counts,
      next: next('observe_outcomes', 'uncertain'),
    };
  if (!state.inventoryComplete)
    return {
      completion: 'continue',
      reason: 'incomplete_inventory',
      counts,
      next: next('complete_inventory'),
    };
  if (counts.pending)
    return {
      completion: 'continue',
      reason: 'pending_items',
      counts,
      next: next('execute_pending', 'pending'),
    };
  if (changed) return reconcile;
  return {
    completion: 'ready',
    reason: 'recorded_outcomes_verified',
    counts,
    next: null,
  };
}

function reviewCompletion(context: ToolRuntimeContext): ToolCompletionReview | null {
  const review = progressReview(context);
  if (review.completion === 'blocked' && review.blocker)
    return { type: 'blocked', reason: review.blocker };
  return review.completion === 'continue'
    ? {
        type: 'continue',
        toolName: TASK_PROGRESS_TOOL,
        feedback: JSON.stringify(review),
      }
    : null;
}

export const taskProgressTool: ToolDeclaration<ProgressInput> = {
  name: TASK_PROGRESS_TOOL,
  definition: progressDefinition,
  schema: progressSchema,
  order: -50,
  policy: { budgetGroup: 'progress', maxCalls: 200, errorSource: 'model' },
  reviewCompletion,
  async execute(call, context) {
    const previous = latestProgress(context);
    const update = call.arguments.update;
    // Provider envelope IDs are not reliably visible to the model. Expose actual, bounded
    // references here rather than asking it to guess IDs or changing every tool's output.
    const evidenceResults = (context.toolResults ?? []).filter(
      (result) =>
        result.taskId === context.task?.id &&
        result.toolName !== TASK_PROGRESS_TOOL &&
        result.toolName !== 'commit_context',
    );
    const availableEvidence = evidenceResults
      .slice(-12)
      .map(({ callId, toolName }) => ({ callId, toolName }));
    if (!update)
      return {
        output: JSON.stringify({
          ok: true,
          updated: false,
          state: previous?.state ?? null,
          review: progressReview(context),
          availableEvidence,
        }),
      };
    const fail = (message: string) => ({
      output: JSON.stringify({
        ok: false,
        message,
        state: previous?.state ?? null,
        review: progressReview(context),
        availableEvidence,
      }),
    });
    if (update.inventoryComplete && !update.inventoryEvidence)
      return fail('Full inventory coverage needs evidence.');
    if (new Set(update.items.map((item) => item.id)).size !== update.items.length)
      return fail('Item IDs must be unique.');
    for (const item of update.items) {
      if (item.status !== 'pending' && !item.evidence)
        return fail(`${item.id}: this status needs evidence or an exclusion reason.`);
      if (
        item.status === 'verified' &&
        !evidenceResults.some((result) => result.callId === item.evidenceCallId)
      ) {
        return fail(`${item.id}: verified requires an existing observation tool call ID.`);
      }
    }
    const items = new Map(previous?.state.items.map((item) => [item.id, item]));
    for (const item of update.items) items.set(item.id, item);
    const state = { ...update, items: [...items.values()] };
    if (items.size > 100 || JSON.stringify(state).length > 32_768)
      return fail('Ledger exceeds its 100-item / 32768-character limit.');
    return {
      output: JSON.stringify({
        ok: true,
        updated: true,
        state,
        review: progressReview(context, state),
        availableEvidence,
      }),
    };
  },
};

register(taskProgressTool);
