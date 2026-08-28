import type { MaterializedToolResult } from './tool-result-types';
import type { ContinuationItem, MaterializedContinuationItem } from './continuation-types';

interface ContinuationSource {
  readonly toolResults: readonly MaterializedToolResult[];
  readonly continuationItems: readonly ContinuationItem[];
}

/** Resolves lightweight result references only at consumers that need model-visible output. */
export function materializeContinuationItems(
  source: ContinuationSource,
): readonly MaterializedContinuationItem[] {
  const results = new Map<string, MaterializedToolResult>();
  for (const result of source.toolResults) {
    if (results.has(result.id)) {
      throw new Error('Task tool result reference is invalid.');
    }
    results.set(result.id, result);
  }
  return source.continuationItems.map((item): MaterializedContinuationItem => {
    if (item.type !== 'function_call_output_ref') {
      if (
        item.type !== 'message_ref' &&
        item.type !== 'function_call' &&
        item.type !== 'compaction'
      ) {
        throw new Error('Task continuation item is invalid.');
      }
      return item;
    }
    const result = results.get(item.resultId);
    const attachmentIds = item.attachmentIds ?? [];
    if (
      result === undefined ||
      result.callId !== item.callId ||
      attachmentIds.some((id) => !(result.attachmentIds ?? []).includes(id))
    ) {
      throw new Error('Task tool result reference is invalid.');
    }
    return {
      type: 'function_call_output',
      callId: item.callId,
      output: result.modelOutput ?? result.output,
      resultId: item.resultId,
      attachmentIds,
    };
  });
}
