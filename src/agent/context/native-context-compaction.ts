import { CODEX_EFFECTIVE_CONTEXT_WINDOW_TOKENS } from '../../providers/codex/codex-constants';
import type { ModelCompactionResult } from '../../providers/provider-types';
import type { Checkpoint } from '../../tasks/checkpoint-types';
import type { ContinuationItem } from '../../tasks/continuation-types';
import { CONTEXT_COMMIT_TOOL_NAME } from '../tools/context-commit-tool-schema';

export const AUTO_COMPACT_INPUT_TOKEN_HIGH_WATER = 220_000;
export const AUTO_COMPACT_INPUT_TOKEN_HARD_WATER = 240_000;
const MIN_TOOL_PAIRS_AFTER_COMPACTION = 8;
const MAX_COMPACTION_ENCRYPTED_CHARACTERS = 8 * 1024 * 1024;

if (AUTO_COMPACT_INPUT_TOKEN_HARD_WATER >= CODEX_EFFECTIVE_CONTEXT_WINDOW_TOKENS) {
  throw new Error('Native compaction hard water must remain below the effective context window.');
}

interface ContinuationPressure {
  readonly completedPairsAfterBoundary: number;
  readonly hasPriorBoundary: boolean;
}

function successfulLegacyCommit(output: string): boolean {
  try {
    const value: unknown = JSON.parse(output);
    return typeof value === 'object' && value !== null && 'ok' in value && value.ok === true;
  } catch {
    return false;
  }
}

function continuationPressure(items: readonly ContinuationItem[]): ContinuationPressure {
  let boundaryIndex = -1;
  let pendingCall: Extract<ContinuationItem, { readonly type: 'function_call' }> | null = null;
  const completedPairIndexes: number[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) continue;
    if (item.type === 'compaction') {
      boundaryIndex = index;
      pendingCall = null;
      continue;
    }
    if (item.type === 'function_call') {
      pendingCall = item;
      continue;
    }
    if (item.type !== 'function_call_output' || pendingCall?.callId !== item.callId) continue;
    if (pendingCall.name === CONTEXT_COMMIT_TOOL_NAME && successfulLegacyCommit(item.output)) {
      boundaryIndex = index;
      completedPairIndexes.length = 0;
    } else if (pendingCall.name !== CONTEXT_COMMIT_TOOL_NAME) {
      completedPairIndexes.push(index);
    }
    pendingCall = null;
  }
  return {
    completedPairsAfterBoundary: completedPairIndexes.filter((index) => index > boundaryIndex)
      .length,
    hasPriorBoundary: boundaryIndex >= 0,
  };
}

/** Uses measured Provider usage plus the unmeasured continuation suffix and a durable cooldown. */
export function shouldUseNativeContextCompaction(
  checkpoint: Checkpoint,
  unmeasuredInputTokens = 0,
): boolean {
  const measuredInputTokens = checkpoint.lastModelInputTokens;
  if (
    checkpoint.pendingToolCall !== null ||
    measuredInputTokens === undefined ||
    !Number.isSafeInteger(unmeasuredInputTokens) ||
    unmeasuredInputTokens < 0
  ) {
    return false;
  }
  const projectedInputTokens = measuredInputTokens + unmeasuredInputTokens;
  if (projectedInputTokens < AUTO_COMPACT_INPUT_TOKEN_HIGH_WATER) return false;
  const pressure = continuationPressure(checkpoint.continuationItems);
  if (pressure.completedPairsAfterBoundary === 0) return false;
  if (!pressure.hasPriorBoundary) return true;
  return (
    pressure.completedPairsAfterBoundary >= MIN_TOOL_PAIRS_AFTER_COMPACTION ||
    projectedInputTokens >= AUTO_COMPACT_INPUT_TOKEN_HARD_WATER
  );
}

/** Replaces Provider-owned process state while retaining local user/supplement chronology. */
export function createNativeCompactionContinuation(
  items: readonly ContinuationItem[],
  result: ModelCompactionResult,
): readonly ContinuationItem[] {
  if (
    result.itemId.length === 0 ||
    result.itemId.length > 256 ||
    result.encryptedContent.length === 0 ||
    result.encryptedContent.length > MAX_COMPACTION_ENCRYPTED_CHARACTERS
  ) {
    throw new Error('Native compaction result is invalid.');
  }
  return [
    ...items.filter(
      (item): item is Extract<ContinuationItem, { readonly type: 'message_ref' }> =>
        item.type === 'message_ref',
    ),
    {
      type: 'compaction',
      itemId: result.itemId,
      encryptedContent: result.encryptedContent,
    },
  ];
}
