import type { ContinuationItem, PendingToolCall } from '../../tasks/continuation-types';
import {
  CONTEXT_COMMIT_TOOL_NAME,
  contextCommitToolSchema,
} from '../tools/context-commit-tool-schema';

export interface ContextCommitStats {
  readonly compactedCalls: number;
  readonly releasedTextChars: number;
  readonly releasedImages: number;
}

export interface ContextCommitCompaction {
  readonly continuationItems: readonly ContinuationItem[];
  readonly output: string;
  readonly stats: ContextCommitStats;
}

function invalidContinuation(): never {
  throw new Error('Context continuation is invalid.');
}

function isValidPendingCommit(pending: PendingToolCall): boolean {
  if (
    pending.executionState !== 'recorded' ||
    pending.name !== CONTEXT_COMMIT_TOOL_NAME ||
    pending.callId.trim().length === 0
  ) {
    return false;
  }

  try {
    const value: unknown = JSON.parse(pending.argumentsJson);
    return contextCommitToolSchema.safeParse(value).success;
  } catch {
    return false;
  }
}

/** Returns whether a completed non-commit result exists after the latest commit. */
export function hasContextCommitCandidate(items: readonly ContinuationItem[]): boolean {
  let pendingCall: Extract<ContinuationItem, { readonly type: 'function_call' }> | undefined;
  let hasCandidate = false;

  for (const item of items) {
    if (item.type === 'message_ref') {
      if (pendingCall) {
        invalidContinuation();
      }
      continue;
    }

    if (item.type === 'function_call') {
      if (pendingCall) {
        invalidContinuation();
      }
      pendingCall = item;
      continue;
    }

    if (!pendingCall || item.callId !== pendingCall.callId) {
      invalidContinuation();
    }
    hasCandidate = pendingCall.name === CONTEXT_COMMIT_TOOL_NAME ? false : true;
    pendingCall = undefined;
  }

  if (pendingCall) {
    invalidContinuation();
  }
  return hasCandidate;
}

/** Replaces completed tool pairs with one durable model-facing commit boundary. */
export function compactContextAtCommit(
  items: readonly ContinuationItem[],
  pending: PendingToolCall,
  resultRef: string,
): ContextCommitCompaction {
  if (!isValidPendingCommit(pending)) {
    throw new Error('Pending context commit is invalid.');
  }
  if (resultRef.trim().length === 0) {
    throw new Error('Context commit result reference is invalid.');
  }

  const retainedMessages: ContinuationItem[] = [];
  const releasedAttachmentIds = new Set<string>();
  let pendingCall: Extract<ContinuationItem, { readonly type: 'function_call' }> | undefined;
  let currentCommit: Extract<ContinuationItem, { readonly type: 'function_call' }> | undefined;
  let compactedCalls = 0;
  let releasedTextChars = 0;
  let hasCandidate = false;

  for (const [index, item] of items.entries()) {
    if (item.type === 'message_ref') {
      if (pendingCall) {
        invalidContinuation();
      }
      retainedMessages.push(item);
      continue;
    }

    if (item.type === 'function_call') {
      if (pendingCall) {
        invalidContinuation();
      }
      pendingCall = item;
      if (index === items.length - 1) {
        currentCommit = item;
      }
      continue;
    }

    if (!pendingCall || item.callId !== pendingCall.callId) {
      invalidContinuation();
    }

    compactedCalls += 1;
    releasedTextChars += pendingCall.argumentsJson.length + item.output.length;
    for (const attachmentId of item.attachmentIds ?? []) {
      releasedAttachmentIds.add(attachmentId);
    }
    hasCandidate = pendingCall.name === CONTEXT_COMMIT_TOOL_NAME ? false : true;
    pendingCall = undefined;
  }

  if (!pendingCall || !currentCommit || pendingCall !== currentCommit) {
    invalidContinuation();
  }
  if (
    currentCommit.callId !== pending.callId ||
    currentCommit.name !== pending.name ||
    currentCommit.argumentsJson !== pending.argumentsJson
  ) {
    throw new Error('Pending context commit is invalid.');
  }
  if (!hasCandidate) {
    throw new Error('There are no new tool results to commit.');
  }

  const stats: ContextCommitStats = {
    compactedCalls,
    releasedTextChars,
    releasedImages: releasedAttachmentIds.size,
  };
  const output = JSON.stringify({ ok: true, ...stats });
  const continuationItems: readonly ContinuationItem[] = [
    ...retainedMessages,
    currentCommit,
    {
      type: 'function_call_output',
      callId: currentCommit.callId,
      output,
      resultRef,
      attachmentIds: [],
    },
  ];

  return { continuationItems, output, stats };
}
