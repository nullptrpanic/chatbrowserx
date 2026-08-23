import type { ContinuationItem, PendingToolCall } from '../../tasks/continuation-types';
import {
  CONTEXT_COMMIT_TOOL_NAME,
  parseRecordedContextCommitToolCall,
  type RecordedContextCommitToolInput,
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

export const INVALID_CONTEXT_COMMIT_CURSOR = 'INVALID_CONTEXT_COMMIT_CURSOR' as const;

export class ContextCommitCursorError extends Error {
  constructor() {
    super('Context commit cursor is invalid.');
    this.name = 'ContextCommitCursorError';
  }
}

const MAX_COMMITTED_STATE_CHARACTERS = 8_192;
const ELEMENT_REF_PATTERN =
  /\b(?:ref_[a-z0-9_-]{1,64}|e(?=[a-z0-9]{8,32}\b)(?=[a-z0-9]*\d)[a-z0-9]{8,32})\b/gi;
const SNAPSHOT_ID_PATTERN = /\bs(?=[a-f0-9]{16,32}\b)(?=[a-f0-9]*\d)[a-f0-9]{16,32}\b/gi;
const SCREENSHOT_COORDINATE_PATTERN = /\b(?:fromX|fromY|toX|toY|x|y)\s*[:=]\s*-?\d+(?:\.\d+)?\b/gi;
const EXPIRED_BROWSER_STATE_NOTE =
  'Browser refs, snapshot ids, and screenshot coordinates expired at this checkpoint; use a fresh interactive inspection before the next browser action.';

function durableCommittedState(state: string): string {
  let sanitized = state
    .replace(ELEMENT_REF_PATTERN, '[expired-browser-ref]')
    .replace(SNAPSHOT_ID_PATTERN, '[expired-browser-snapshot]');
  const browserEpochChanged = sanitized !== state || /\b(?:screenshot|coordinate)\b/i.test(state);
  if (browserEpochChanged)
    sanitized = sanitized.replace(SCREENSHOT_COORDINATE_PATTERN, '[expired]');
  if (sanitized === state) return state;
  const separator = sanitized.endsWith('\n') ? '' : '\n';
  return `${sanitized}${separator}${EXPIRED_BROWSER_STATE_NOTE}`.slice(
    0,
    MAX_COMMITTED_STATE_CHARACTERS,
  );
}

function invalidContinuation(): never {
  throw new Error('Context continuation is invalid.');
}

/** Counts opaque and summarized model output that disappears with one compacted call. */
function modelOutputCharacters(
  call: Extract<ContinuationItem, { readonly type: 'function_call' }>,
): number {
  return (call.modelOutputItems ?? []).reduce((total, item) => {
    if (item.type !== 'reasoning') return total;
    return (
      total +
      item.encryptedContent.length +
      item.summary.reduce((summaryTotal, summary) => summaryTotal + summary.text.length, 0)
    );
  }, 0);
}

function parsePendingCommit(pending: PendingToolCall): RecordedContextCommitToolInput | null {
  if (pending.executionState !== 'recorded') {
    return null;
  }

  try {
    return parseRecordedContextCommitToolCall(pending);
  } catch {
    return null;
  }
}

/** Identifies the model-visible rejection emitted for an invalid commit cursor. */
function isRejectedContextCommitOutput(output: string): boolean {
  try {
    const value: unknown = JSON.parse(output);
    return (
      typeof value === 'object' &&
      value !== null &&
      'ok' in value &&
      value.ok === false &&
      'code' in value &&
      value.code === INVALID_CONTEXT_COMMIT_CURSOR
    );
  } catch {
    return false;
  }
}

/** Returns current completed non-commit call IDs after the latest successful commit. */
export function contextCommitCandidateCallIds(
  items: readonly ContinuationItem[],
): readonly string[] {
  let pendingCall: Extract<ContinuationItem, { readonly type: 'function_call' }> | undefined;
  let callIds: string[] = [];

  for (const item of items) {
    if (item.type === 'message_ref') {
      if (pendingCall) invalidContinuation();
      continue;
    }
    if (item.type === 'compaction') {
      if (pendingCall) invalidContinuation();
      callIds = [];
      continue;
    }
    if (item.type === 'function_call') {
      if (pendingCall) invalidContinuation();
      pendingCall = item;
      continue;
    }
    if (!pendingCall || item.callId !== pendingCall.callId) {
      invalidContinuation();
    }
    if (pendingCall.name === CONTEXT_COMMIT_TOOL_NAME) {
      if (!isRejectedContextCommitOutput(item.output)) callIds = [];
    } else {
      callIds.push(pendingCall.callId);
    }
    pendingCall = undefined;
  }

  if (pendingCall) invalidContinuation();
  return callIds;
}

/** Replaces completed tool pairs through the requested cursor with one durable boundary. */
export function compactContextAtCommit(
  items: readonly ContinuationItem[],
  pending: PendingToolCall,
  resultRef: string,
): ContextCommitCompaction {
  const commitArguments = parsePendingCommit(pending);
  if (!commitArguments) {
    throw new Error('Pending context commit is invalid.');
  }
  if (resultRef.trim().length === 0) {
    throw new Error('Context commit result reference is invalid.');
  }

  const currentCommit = items.at(-1);
  if (
    !currentCommit ||
    currentCommit.type !== 'function_call' ||
    currentCommit.callId !== pending.callId ||
    currentCommit.name !== pending.name ||
    currentCommit.argumentsJson !== pending.argumentsJson
  ) {
    throw new Error('Pending context commit is invalid.');
  }

  type FunctionCallItem = Extract<ContinuationItem, { readonly type: 'function_call' }>;
  type FunctionOutputItem = Extract<ContinuationItem, { readonly type: 'function_call_output' }>;
  type ContinuationUnit =
    | { readonly type: 'message'; readonly item: ContinuationItem }
    | {
        readonly type: 'tool_pair';
        readonly call: FunctionCallItem;
        readonly output: FunctionOutputItem;
      };

  const units: ContinuationUnit[] = [];
  let openCall: FunctionCallItem | undefined;
  for (const item of items.slice(0, -1)) {
    if (item.type === 'message_ref' || item.type === 'compaction') {
      if (openCall) {
        invalidContinuation();
      }
      units.push({ type: 'message', item });
      continue;
    }
    if (item.type === 'function_call') {
      if (openCall) {
        invalidContinuation();
      }
      openCall = item;
      continue;
    }
    if (!openCall || item.callId !== openCall.callId) {
      invalidContinuation();
    }
    units.push({ type: 'tool_pair', call: openCall, output: item });
    openCall = undefined;
  }
  if (openCall) {
    invalidContinuation();
  }

  let cursorIndex = -1;
  let latestCommitIndex = -1;
  let latestCandidateIndex = -1;
  for (const [index, unit] of units.entries()) {
    if (unit.type !== 'tool_pair') continue;
    if (unit.call.name === CONTEXT_COMMIT_TOOL_NAME) {
      if (!isRejectedContextCommitOutput(unit.output.output)) {
        latestCommitIndex = index;
        latestCandidateIndex = -1;
      }
    } else {
      latestCandidateIndex = index;
    }
    if (
      commitArguments.throughCallId !== undefined &&
      unit.call.callId === commitArguments.throughCallId
    ) {
      if (cursorIndex !== -1) {
        invalidContinuation();
      }
      cursorIndex = index;
    }
  }
  if (commitArguments.throughCallId === undefined) {
    cursorIndex = latestCandidateIndex;
  }
  const cursorUnit = units[cursorIndex];
  if (
    !cursorUnit ||
    cursorUnit.type !== 'tool_pair' ||
    cursorUnit.call.name === CONTEXT_COMMIT_TOOL_NAME ||
    cursorIndex <= latestCommitIndex
  ) {
    throw new ContextCommitCursorError();
  }

  const beforeBoundary: ContinuationItem[] = [];
  const afterBoundary: ContinuationItem[] = [];
  const releasedAttachmentIds = new Set<string>();
  let compactedCalls = 0;
  let releasedTextChars = 0;

  for (const [index, unit] of units.entries()) {
    if (unit.type === 'message') {
      (index <= cursorIndex ? beforeBoundary : afterBoundary).push(unit.item);
      continue;
    }
    if (
      unit.call.name === CONTEXT_COMMIT_TOOL_NAME &&
      isRejectedContextCommitOutput(unit.output.output)
    ) {
      continue;
    }
    if (index > cursorIndex) {
      afterBoundary.push(unit.call, unit.output);
      continue;
    }
    compactedCalls += 1;
    releasedTextChars +=
      unit.call.argumentsJson.length + unit.output.output.length + modelOutputCharacters(unit.call);
    for (const attachmentId of unit.output.attachmentIds ?? []) {
      releasedAttachmentIds.add(attachmentId);
    }
  }

  const stats: ContextCommitStats = {
    compactedCalls,
    releasedTextChars,
    releasedImages: releasedAttachmentIds.size,
  };
  const output = JSON.stringify({ ok: true, ...stats });
  const durableState = durableCommittedState(commitArguments.state);
  const durableCommit =
    durableState === commitArguments.state
      ? currentCommit
      : {
          ...currentCommit,
          argumentsJson: JSON.stringify({
            state: durableState,
            ...(commitArguments.throughCallId === undefined
              ? {}
              : { throughCallId: commitArguments.throughCallId }),
          }),
        };
  const continuationItems: readonly ContinuationItem[] = [
    ...beforeBoundary,
    durableCommit,
    {
      type: 'function_call_output',
      callId: currentCommit.callId,
      output,
      resultRef,
      attachmentIds: [],
    },
    ...afterBoundary,
  ];

  return { continuationItems, output, stats };
}
