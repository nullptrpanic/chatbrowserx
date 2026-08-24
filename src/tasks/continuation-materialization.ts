import type { CompletedToolResult } from './checkpoint-types';
import type { ContinuationItem, MaterializedContinuationItem } from './continuation-types';

interface ContinuationSource {
  readonly completedToolResults: readonly CompletedToolResult[];
  readonly continuationItems: readonly ContinuationItem[];
}

/** Resolves lightweight result references only at consumers that need model-visible output. */
export function materializeContinuationItems(
  source: ContinuationSource,
): readonly MaterializedContinuationItem[] {
  const results = new Map<string, CompletedToolResult>();
  for (const result of source.completedToolResults) {
    if (results.has(result.resultRef)) {
      throw new Error('WorkSession tool result reference is invalid.');
    }
    results.set(result.resultRef, result);
  }
  return source.continuationItems.map((item): MaterializedContinuationItem => {
    if (item.type !== 'function_call_output_ref') return item;
    const result = results.get(item.resultRef);
    const attachmentIds = item.attachmentIds ?? [];
    if (
      result === undefined ||
      result.callId !== item.callId ||
      attachmentIds.some((id) => !(result.attachmentIds ?? []).includes(id))
    ) {
      throw new Error('WorkSession tool result reference is invalid.');
    }
    return {
      type: 'function_call_output',
      callId: item.callId,
      output: result.modelOutput ?? result.output,
      resultRef: item.resultRef,
      attachmentIds,
    };
  });
}
