import type { MaterializedToolResult } from '../../tasks/tool-result-types';
import { register } from '../register';
import type { ToolCompletionReview, ToolDeclaration, ToolRuntimeContext } from '../types';
import {
  TASK_PROGRESS_TOOL,
  progressDefinition,
  progressSchema,
  isProgressTool,
  progressRecordedSchemas,
  savedProgressInputSchema,
  savedProgressStateSchema,
  type ProgressInput,
  type ProgressState,
} from './contract';

/** Reject transport/execution failures, not successful observations of a negative result. */
function usableEvidence(context: ToolRuntimeContext): readonly MaterializedToolResult[] {
  return (context.toolResults ?? []).filter((result) => {
    if (
      result.taskId !== context.task?.id ||
      isProgressTool(result.toolName) ||
      result.toolName === 'commit_context'
    )
      return false;
    try {
      const output: unknown = JSON.parse(result.output);
      if (typeof output !== 'object' || output === null || Array.isArray(output)) return false;
      const value = output as Record<string, unknown>;
      return (
        Object.keys(value).length > 0 &&
        value.ok !== false &&
        (typeof value.code !== 'number' || value.code === 0) &&
        (value.executionStatus === undefined || value.executionStatus === 'succeeded')
      );
    } catch {
      return false;
    }
  });
}

function latestProgress(context: ToolRuntimeContext): {
  state: ProgressState;
  result: MaterializedToolResult;
  sequence: number;
} | null {
  for (const result of [...(context.toolResults ?? [])].reverse()) {
    if (!isProgressTool(result.toolName) || result.taskId !== context.task?.id) continue;
    try {
      const output = JSON.parse(result.output) as {
        ok?: boolean;
        updated?: boolean;
        state?: unknown;
      };
      if (output.ok !== true || output.updated !== true) continue;
      const state = savedProgressStateSchema.parse(output.state);
      const evidence = new Set(usableEvidence(context).map(({ callId }) => callId));
      // Reconcile persisted ledgers created before evidence validation, without rewriting history.
      state.plan = state.plan.map((item) =>
        item.status === 'completed' &&
        (item.evidenceCallId === null || !evidence.has(item.evidenceCallId))
          ? { ...item, status: 'uncertain' }
          : item,
      );
      const sequence =
        context.events?.find(
          (event) => event.type === 'tool.result' && event.callId === result.callId,
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
  const counts = { pending: 0, in_progress: 0, completed: 0, uncertain: 0, excluded: 0 };
  for (const item of state?.plan ?? []) counts[item.status] += 1;
  const next = (action: string, status?: 'pending' | 'in_progress' | 'uncertain') => ({
    action,
    itemIds: status
      ? (state?.plan ?? [])
          .filter((item) => item.status === status)
          .slice(0, 5)
          .map((item) => item.id)
      : [],
  });
  if (!state) {
    const attempted = context.toolResults?.some((result) => {
      if (!isProgressTool(result.toolName) || result.taskId !== context.task?.id) return false;
      try {
        return savedProgressInputSchema.parse(JSON.parse(result.argumentsJson)).update !== null;
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
          !isProgressTool(event.name) &&
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
  if (!state.inventory.complete)
    return {
      completion: 'continue',
      reason: 'incomplete_inventory',
      counts,
      next: next('complete_inventory'),
    };
  if (counts.pending || counts.in_progress)
    return {
      completion: 'continue',
      reason: 'pending_items',
      counts,
      next: next('execute_pending', counts.in_progress ? 'in_progress' : 'pending'),
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
  recordedSchemas: progressRecordedSchemas,
  order: -50,
  policy: { budgetGroup: 'progress', maxCalls: 200, errorSource: 'model' },
  reviewCompletion,
  async execute(call, context) {
    const previous = latestProgress(context);
    const update = call.arguments.update;
    // Provider envelope IDs are not reliably visible to the model. Expose actual, bounded
    // references here rather than asking it to guess IDs or changing every tool's output.
    const evidenceResults = usableEvidence(context);
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
    if (update.inventory.complete && !update.inventory.evidence)
      return fail('Full inventory coverage needs evidence.');
    if (new Set(update.plan.map((item) => item.id)).size !== update.plan.length)
      return fail('Item IDs must be unique.');
    for (const item of update.plan) {
      if ((item.status === 'excluded' || item.status === 'uncertain') && !item.reason)
        return fail(`${item.id}: this status needs evidence or an exclusion reason.`);
      if (
        item.status === 'completed' &&
        !evidenceResults.some((result) => result.callId === item.evidenceCallId)
      ) {
        return fail(
          `${item.id}: completed requires a usable observation tool call ID; failed or missing results cannot verify an outcome.`,
        );
      }
    }
    const items = new Map(previous?.state.plan.map((item) => [item.id, item]));
    for (const item of update.plan) items.set(item.id, item);
    const state = { ...update, plan: [...items.values()] };
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
