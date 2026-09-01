import { materializeContinuationItems } from '../../tasks/continuation-materialization';
import type { ContinuationItem, PendingToolCall } from '../../tasks/continuation-types';
import type { Checkpoint } from '../../tasks/checkpoint-types';
import type { MaterializedToolResult } from '../../tasks/tool-result-types';
import { register } from '../register';
import type { ToolDeclaration, ToolRuntimeContext } from '../types';
import {
  compactContextAtCommit,
  contextCommitCandidateCallIds,
  ContextCommitCursorError,
  INVALID_CONTEXT_COMMIT_CURSOR,
} from './compaction';
import {
  CONTEXT_COMMIT_TOOL_NAME,
  contextCommitDefinition,
  contextCommitSchema,
  type ContextCommitToolInput,
} from './contract';

function contextState(context: ToolRuntimeContext): {
  readonly checkpoint: Checkpoint;
  readonly toolResults: readonly MaterializedToolResult[];
  readonly resultId: string;
} {
  if (
    context.checkpoint === undefined ||
    context.toolResults === undefined ||
    context.resultId === undefined ||
    context.resultId.length === 0
  ) {
    throw new Error('Context commit execution state is unavailable.');
  }
  return {
    checkpoint: context.checkpoint,
    toolResults: context.toolResults,
    resultId: context.resultId,
  };
}

function referencedContinuation(
  items: ReturnType<typeof compactContextAtCommit>['continuationItems'],
  checkpoint: Checkpoint,
  pending: PendingToolCall,
): readonly ContinuationItem[] {
  const referencedResultIds = new Set(
    checkpoint.continuationItems.flatMap((item) =>
      item.type === 'function_call_output_ref' ? [item.resultId] : [],
    ),
  );
  return items.map((item): ContinuationItem => {
    if (item.type !== 'function_call_output') return item;
    if (item.callId !== pending.callId && !referencedResultIds.has(item.resultId)) {
      throw new Error('Context commit produced an unowned tool result.');
    }
    return {
      type: 'function_call_output_ref',
      callId: item.callId,
      resultId: item.resultId,
      attachmentIds: item.attachmentIds ?? [],
    };
  });
}

export const contextCommitTool: ToolDeclaration<ContextCommitToolInput> = {
  name: CONTEXT_COMMIT_TOOL_NAME,
  definition: contextCommitDefinition,
  schema: contextCommitSchema,
  order: 50,
  policy: {
    budgetGroup: 'context',
    maxCalls: Number.MAX_SAFE_INTEGER,
    errorSource: 'model',
  },
  model: () => null,
  async execute(call, context) {
    const state = contextState(context);
    const pending: PendingToolCall = {
      callId: call.callId,
      name: call.name,
      argumentsJson: call.argumentsJson,
      executionState: 'recorded',
    };
    const materialized = materializeContinuationItems({
      continuationItems: state.checkpoint.continuationItems,
      toolResults: state.toolResults,
    });
    try {
      const compaction = compactContextAtCommit(materialized, pending, state.resultId);
      return {
        output: compaction.output,
        continuationItems: referencedContinuation(
          compaction.continuationItems,
          state.checkpoint,
          pending,
        ),
        contextCompacted: true,
      };
    } catch (error) {
      if (!(error instanceof ContextCommitCursorError)) throw error;
      const currentCommit = state.checkpoint.continuationItems.at(-1);
      const candidateItems =
        currentCommit?.type === 'function_call' && currentCommit.callId === pending.callId
          ? materialized.slice(0, -1)
          : materialized;
      return {
        output: JSON.stringify({
          ok: false,
          code: INVALID_CONTEXT_COMMIT_CURSOR,
          message:
            'throughCallId did not match a current completed non-commit tool call. Retry commit_context with one of validThroughCallIds.',
          validThroughCallIds: contextCommitCandidateCallIds(candidateItems),
        }),
      };
    }
  },
};

register(contextCommitTool);
