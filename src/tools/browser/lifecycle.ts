import { materializeContinuationItems } from '../../tasks/continuation-materialization';
import type { MaterializedContinuationItem, PendingToolCall } from '../../tasks/continuation-types';
import type { Checkpoint } from '../../tasks/checkpoint-types';
import type { MaterializedToolResult } from '../../tasks/tool-result-types';
import type { ToolExecutionResult, ToolRuntimeContext, ValidatedToolCall } from '../types';
import { parseBrowserToolCall, type ParsedBrowserToolCall } from './contract';

const CONTEXT_COMMIT_TOOL_NAME = 'commit_context';

interface ActiveTaskSnapshot {
  readonly checkpoint: Checkpoint;
  readonly toolResults: readonly MaterializedToolResult[];
}

const readOnlyBrowserToolNames = new Set([
  'browser_get_current_tab',
  'browser_list_tabs',
  'browser_inspect',
  'browser_wait',
  'browser_network_list',
  'browser_network_get',
]);
const browserProgressDynamicKeys = new Set([
  'base',
  'snapshot',
  'snapshotId',
  'timestamp',
  'createdAt',
  'updatedAt',
  'generatedAt',
  'elapsedMs',
  'durationMs',
]);

/** Reads the browser target captured by the current checkpoint. */
function currentBrowserTarget(snapshot: ActiveTaskSnapshot): number | null {
  return snapshot.checkpoint.browserTargetTabId;
}

/** Reads only the trusted internal success envelope fields needed to advance tab state. */
function successfulBrowserTabId(output: string): number | undefined {
  try {
    const value: unknown = JSON.parse(output);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('ok' in value) ||
      value.ok !== true ||
      !('tabId' in value) ||
      typeof value.tabId !== 'number' ||
      !Number.isSafeInteger(value.tabId) ||
      value.tabId < 0 ||
      value.tabId > 2_147_483_647
    ) {
      return undefined;
    }
    return value.tabId;
  } catch {
    return undefined;
  }
}

/** Advances the durable target only after a browser operation proves its state change succeeded. */
function browserTargetAfterCall(
  snapshot: ActiveTaskSnapshot,
  call: ReturnType<typeof parseBrowserToolCall>,
  output: string,
): number | null | undefined {
  const resultTabId = successfulBrowserTabId(output);
  if (resultTabId === undefined) return undefined;
  if (
    call.operation === 'close_tab' &&
    (call.arguments as { readonly tabId: number }).tabId === currentBrowserTarget(snapshot)
  ) {
    return null;
  }
  if (call.operation === 'switch_tab') return resultTabId;
  if (
    call.operation === 'open_tab' &&
    (call.arguments as { readonly activate: boolean }).activate
  ) {
    return resultTabId;
  }
  return undefined;
}

interface BrowserTypeArguments {
  readonly tabId?: number;
  readonly ref: string;
  readonly text: string;
  readonly replace: boolean;
  readonly submit: boolean;
}

function resolvedBrowserTypeTabId(arguments_: BrowserTypeArguments, currentTabId: number): number {
  return arguments_.tabId === undefined || arguments_.tabId === 0 ? currentTabId : arguments_.tabId;
}

function sameBrowserTypeArguments(
  snapshot: ActiveTaskSnapshot,
  current: BrowserTypeArguments,
  previous: BrowserTypeArguments,
): boolean {
  const currentTarget = currentBrowserTarget(snapshot);
  return (
    currentTarget !== null &&
    resolvedBrowserTypeTabId(current, currentTarget) ===
      resolvedBrowserTypeTabId(previous, currentTarget) &&
    current.ref === previous.ref &&
    current.text === previous.text &&
    current.replace === previous.replace &&
    current.submit === previous.submit
  );
}

/** Detects an immediately repeated failed editor write before it can redispatch a mutation. */
function duplicateFailedBrowserTypeOutput(
  snapshot: ActiveTaskSnapshot,
  call: ReturnType<typeof parseBrowserToolCall>,
): string | null {
  if (call.operation !== 'type') return null;
  const previous = snapshot.toolResults.findLast((result) =>
    result.toolName.startsWith('browser_'),
  );
  if (previous?.toolName !== 'browser_type') return null;
  try {
    const envelope: unknown = JSON.parse(previous.output);
    if (typeof envelope !== 'object' || envelope === null || !('code' in envelope)) return null;
    if (
      envelope.code !== 'TYPE_VERIFICATION_FAILED' &&
      envelope.code !== 'DUPLICATE_FAILED_ACTION'
    ) {
      return null;
    }
    const previousCall = parseBrowserToolCall({
      callId: previous.callId,
      name: previous.toolName,
      argumentsJson: previous.argumentsJson,
    });
    if (previousCall.operation !== 'type') return null;
    const currentArguments = call.arguments as BrowserTypeArguments;
    const previousArguments = previousCall.arguments as BrowserTypeArguments;
    if (!sameBrowserTypeArguments(snapshot, currentArguments, previousArguments)) {
      return null;
    }
    return JSON.stringify({
      ok: false,
      code: 'DUPLICATE_FAILED_ACTION',
      message:
        'The same editor input already failed on this page state. Inspect the page before trying again.',
      retryable: false,
      needsInspect: true,
    });
  } catch {
    return null;
  }
}

interface CompletedBrowserProgress {
  readonly callFingerprint: string;
  readonly pairFingerprint: string;
  readonly eligible: boolean;
}

interface VerifiedSelectionProgress {
  readonly tabId: number;
  readonly ref: string;
  readonly checked: boolean;
  readonly pageEpoch: string;
  readonly mutationVersion: number;
  readonly output: Readonly<Record<string, unknown>>;
}

interface VerifiedSubmitProgress {
  readonly callFingerprint: string;
  readonly pageEpoch: string | null;
  readonly mutationVersion: number;
  readonly output: Readonly<Record<string, unknown>>;
}

interface ImmobileScrollProgress {
  readonly callFingerprint: string;
  readonly pageEpoch: string | null;
  readonly mutationVersion: number;
  readonly position?: unknown;
  readonly direction: Readonly<{ deltaX: number; deltaY: number }>;
}

interface BrowserProgressState {
  readonly completed: readonly CompletedBrowserProgress[];
  readonly pageEpoch: string | null;
  readonly mutationVersion: number;
  readonly verifiedSelection?: VerifiedSelectionProgress;
  readonly verifiedSubmit?: VerifiedSubmitProgress;
  readonly immobileScroll?: ImmobileScrollProgress;
}

const browserPageChangeToolNames = new Set([
  'browser_open_tab',
  'browser_switch_tab',
  'browser_close_tab',
  'browser_navigate',
  'browser_reload',
]);
const browserSemanticMutationToolNames = new Set([
  'browser_click',
  'browser_set_checked',
  'browser_set_checked_many',
  'browser_paste_image',
  'browser_type',
  'browser_keypress',
  'browser_scroll',
  'browser_select',
  'browser_drag',
  'browser_click_point',
  'browser_drag_point',
]);

/** Removes transport-only churn while preserving page semantics for progress comparisons. */
function canonicalBrowserProgressValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalBrowserProgressValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !browserProgressDynamicKeys.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalBrowserProgressValue(child)]),
  );
}

function canonicalBrowserProgressJson(raw: string, normalizeTabId: boolean): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      normalizeTabId &&
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      'tabId' in parsed &&
      parsed.tabId === 0
    ) {
      const { tabId: _tabId, ...rest } = parsed;
      void _tabId;
      return JSON.stringify(canonicalBrowserProgressValue(rest));
    }
    return JSON.stringify(canonicalBrowserProgressValue(parsed));
  } catch {
    return raw;
  }
}

function browserCallFingerprint(name: string, argumentsJson: string): string {
  return `${name}:${canonicalBrowserProgressJson(argumentsJson, true)}`;
}

function browserOutputFailed(output: string): boolean {
  try {
    const value: unknown = JSON.parse(output);
    return typeof value === 'object' && value !== null && 'ok' in value && value.ok === false;
  } catch {
    return false;
  }
}

function jsonRecord(raw: string): Readonly<Record<string, unknown>> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}

function childRecord(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | null {
  const child = value[key];
  return typeof child === 'object' && child !== null && !Array.isArray(child)
    ? (child as Readonly<Record<string, unknown>>)
    : null;
}

function outputSnapshot(record: Readonly<Record<string, unknown>>): string | null {
  const data = childRecord(record, 'data');
  if (!data) return null;
  if (typeof data.snapshot === 'string' && data.snapshot.length > 0) return data.snapshot;
  const direct = childRecord(data, 'pageVerification') ?? childRecord(data, 'verification');
  if (typeof direct?.snapshot === 'string' && direct.snapshot.length > 0) return direct.snapshot;
  if (!Array.isArray(data.observations)) return null;
  for (let index = data.observations.length - 1; index >= 0; index -= 1) {
    const observation = data.observations[index];
    if (
      typeof observation === 'object' &&
      observation !== null &&
      !Array.isArray(observation) &&
      'snapshot' in observation &&
      typeof observation.snapshot === 'string' &&
      observation.snapshot.length > 0
    ) {
      return observation.snapshot;
    }
  }
  return null;
}

function outputSelection(
  record: Readonly<Record<string, unknown>>,
): Readonly<{ tabId: number; ref: string; checked: boolean }> | null {
  if (record.ok !== true || typeof record.tabId !== 'number') return null;
  const data = childRecord(record, 'data');
  const observation = childRecord(record, 'observation');
  const target = observation === null ? null : childRecord(observation, 'target');
  if (
    data?.action !== 'set_checked' ||
    data.verified !== true ||
    typeof data.requested !== 'boolean' ||
    typeof target?.ref !== 'string'
  ) {
    return null;
  }
  const targetState = Array.isArray(target.state) ? target.state : [];
  const selected = targetState.some((state) => state === 'checked' || state === 'selected');
  const unselected = targetState.some(
    (state) => state === 'checked=false' || state === 'selected=false',
  );
  if ((data.requested && !selected) || (!data.requested && !unselected)) return null;
  return { tabId: record.tabId, ref: target.ref, checked: data.requested };
}

function outputImmobileScroll(
  record: Readonly<Record<string, unknown>>,
): Readonly<{ position?: unknown }> | null {
  if (record.ok !== true) return null;
  const data = childRecord(record, 'data');
  const immobile =
    (data?.action === 'scroll' && data.moved === false) ||
    (data?.action === 'scroll' && data.mode === 'traverse' && data.stopReason === 'no_progress');
  if (!immobile) return null;
  return data.position === undefined ? {} : { position: data.position };
}

function outputVerifiedSubmit(record: Readonly<Record<string, unknown>>): boolean {
  if (record.ok !== true) return false;
  const data = childRecord(record, 'data');
  return (
    data?.action === 'type' &&
    data.submitted === true &&
    data.submissionVerified === true &&
    data.verified === true
  );
}

/** Reconstructs page-state evidence while keeping user supplements as non-destructive boundaries. */
function recentBrowserProgress(
  items: readonly MaterializedContinuationItem[],
): BrowserProgressState {
  const calls = new Map<
    string,
    Extract<MaterializedContinuationItem, { readonly type: 'function_call' }>
  >();
  const completed: CompletedBrowserProgress[] = [];
  let pageEpoch: string | null = null;
  let mutationVersion = 0;
  let verifiedSelection: VerifiedSelectionProgress | undefined;
  let verifiedSubmit: VerifiedSubmitProgress | undefined;
  let immobileScroll: ImmobileScrollProgress | undefined;
  for (const item of items) {
    if (item.type === 'message_ref' || item.type === 'compaction') {
      calls.clear();
      completed.length = 0;
      pageEpoch = null;
      mutationVersion = 0;
      verifiedSelection = undefined;
      verifiedSubmit = undefined;
      immobileScroll = undefined;
      continue;
    }
    if (item.type === 'function_call') {
      if (item.name === CONTEXT_COMMIT_TOOL_NAME) {
        calls.clear();
        completed.length = 0;
        pageEpoch = null;
        mutationVersion = 0;
        verifiedSelection = undefined;
        verifiedSubmit = undefined;
        immobileScroll = undefined;
        continue;
      }
      calls.set(item.callId, item);
      continue;
    }
    const call = calls.get(item.callId);
    calls.delete(item.callId);
    if (call === undefined || !call.name.startsWith('browser_')) continue;
    const callFingerprint = browserCallFingerprint(call.name, call.argumentsJson);
    const outputFingerprint = canonicalBrowserProgressJson(item.output, false);
    completed.push({
      callFingerprint,
      pairFingerprint: `${callFingerprint}=>${outputFingerprint}`,
      eligible: readOnlyBrowserToolNames.has(call.name) || browserOutputFailed(item.output),
    });

    const output = jsonRecord(item.output);
    if (output?.ok !== true) continue;
    if (browserPageChangeToolNames.has(call.name)) {
      completed.length = 0;
      pageEpoch = null;
      mutationVersion += 1;
      verifiedSelection = undefined;
      verifiedSubmit = undefined;
      immobileScroll = undefined;
      continue;
    }

    const nextEpoch = outputSnapshot(output);
    if (call.name === 'browser_inspect') {
      if (nextEpoch !== null && nextEpoch !== pageEpoch) {
        const previousImmobileScroll =
          childRecord(output, 'data')?.unchanged === true ? immobileScroll : undefined;
        pageEpoch = nextEpoch;
        verifiedSelection = undefined;
        verifiedSubmit = undefined;
        immobileScroll =
          previousImmobileScroll === undefined
            ? undefined
            : { ...previousImmobileScroll, pageEpoch: nextEpoch };
      }
      continue;
    }

    const immobile = call.name === 'browser_scroll' ? outputImmobileScroll(output) : null;
    if (browserSemanticMutationToolNames.has(call.name) && immobile === null) {
      mutationVersion += 1;
      verifiedSelection = undefined;
      verifiedSubmit = undefined;
      immobileScroll = undefined;
    }
    if (nextEpoch !== null && nextEpoch !== pageEpoch) {
      pageEpoch = nextEpoch;
      verifiedSelection = undefined;
      verifiedSubmit = undefined;
      immobileScroll = undefined;
    }

    const selection = outputSelection(output);
    if (selection !== null && pageEpoch !== null) {
      verifiedSelection = {
        ...selection,
        pageEpoch,
        mutationVersion,
        output,
      };
    }
    if (call.name === 'browser_type' && outputVerifiedSubmit(output)) {
      verifiedSubmit = {
        callFingerprint,
        pageEpoch,
        mutationVersion,
        output,
      };
    }
    if (immobile !== null) {
      const arguments_ = jsonRecord(call.argumentsJson);
      const deltaX = arguments_?.deltaX;
      const deltaY = arguments_?.deltaY;
      if (typeof deltaX === 'number' && typeof deltaY === 'number') {
        immobileScroll = {
          callFingerprint,
          pageEpoch,
          mutationVersion,
          ...(immobile.position === undefined ? {} : { position: immobile.position }),
          direction: { deltaX, deltaY },
        };
      }
    }
  }
  return {
    completed,
    pageEpoch,
    mutationVersion,
    ...(verifiedSelection === undefined ? {} : { verifiedSelection }),
    ...(verifiedSubmit === undefined ? {} : { verifiedSubmit }),
    ...(immobileScroll === undefined ? {} : { immobileScroll }),
  };
}

function replayVerifiedSelectionOutput(
  progress: BrowserProgressState,
  pending: PendingToolCall,
): string | null {
  if (pending.name !== 'browser_set_checked') return null;
  const evidence = progress.verifiedSelection;
  const arguments_ = jsonRecord(pending.argumentsJson);
  if (
    evidence === undefined ||
    progress.pageEpoch !== evidence.pageEpoch ||
    progress.mutationVersion !== evidence.mutationVersion ||
    arguments_?.ref !== evidence.ref ||
    arguments_?.checked !== evidence.checked ||
    (typeof arguments_.tabId === 'number' &&
      arguments_.tabId !== 0 &&
      arguments_.tabId !== evidence.tabId)
  ) {
    return null;
  }
  const data = childRecord(evidence.output, 'data') ?? {};
  return JSON.stringify({
    ...evidence.output,
    data: {
      ...data,
      dispatched: false,
      strategy: 'already_verified',
      replayed: true,
    },
  });
}

function replayVerifiedSubmitOutput(
  progress: BrowserProgressState,
  pending: PendingToolCall,
): string | null {
  const evidence = progress.verifiedSubmit;
  if (
    pending.name !== 'browser_type' ||
    evidence === undefined ||
    evidence.callFingerprint !== browserCallFingerprint(pending.name, pending.argumentsJson) ||
    evidence.pageEpoch !== progress.pageEpoch ||
    evidence.mutationVersion !== progress.mutationVersion
  ) {
    return null;
  }
  const data = childRecord(evidence.output, 'data') ?? {};
  return JSON.stringify({
    ...evidence.output,
    data: {
      ...data,
      dispatched: false,
      replayed: true,
    },
  });
}

function immobileScrollOutput(
  progress: BrowserProgressState,
  pending: PendingToolCall,
): string | null {
  const evidence = progress.immobileScroll;
  if (
    pending.name !== 'browser_scroll' ||
    evidence === undefined ||
    evidence.callFingerprint !== browserCallFingerprint(pending.name, pending.argumentsJson) ||
    evidence.pageEpoch !== progress.pageEpoch ||
    evidence.mutationVersion !== progress.mutationVersion
  ) {
    return null;
  }
  return JSON.stringify({
    ok: false,
    code: 'NO_PROGRESS',
    message:
      'The same scroll direction already stopped at this position. Choose another direction, target, or page region.',
    retryable: false,
    needsInspect: false,
    data: {
      direction: evidence.direction,
      ...(evidence.position === undefined ? {} : { position: evidence.position }),
    },
  });
}

/** Stops a repeated read/failure strategy only after two semantically identical cycles. */
function noProgressBrowserOutput(
  snapshot: ActiveTaskSnapshot,
  pending: PendingToolCall,
): string | null {
  const progress = recentBrowserProgress(
    materializeContinuationItems({
      continuationItems: snapshot.checkpoint.continuationItems,
      toolResults: snapshot.toolResults,
    }),
  );
  const replayedSelection = replayVerifiedSelectionOutput(progress, pending);
  if (replayedSelection !== null) return replayedSelection;
  const replayedSubmit = replayVerifiedSubmitOutput(progress, pending);
  if (replayedSubmit !== null) return replayedSubmit;
  const stoppedScroll = immobileScrollOutput(progress, pending);
  if (stoppedScroll !== null) return stoppedScroll;

  const completed = progress.completed;
  const pendingFingerprint = browserCallFingerprint(pending.name, pending.argumentsJson);
  for (let cycleLength = 1; cycleLength <= 4; cycleLength += 1) {
    if (completed.length < cycleLength * 2) continue;
    const previous = completed.slice(-cycleLength * 2, -cycleLength);
    const latest = completed.slice(-cycleLength);
    if (
      previous.every(
        (entry, index) =>
          entry.eligible &&
          latest[index]?.eligible === true &&
          entry.pairFingerprint === latest[index]?.pairFingerprint,
      ) &&
      previous[0]?.callFingerprint === pendingFingerprint
    ) {
      const repeatedInspect = pending.name === 'browser_inspect';
      return JSON.stringify({
        ok: false,
        code: 'NO_PROGRESS',
        message: repeatedInspect
          ? 'The same inspection repeated without a semantic state change. Inspect another region or use a different action strategy.'
          : 'The same browser strategy repeated without a semantic state change. Inspect fresh state or choose a different action.',
        retryable: false,
        needsInspect: !repeatedInspect,
      });
    }
  }
  return null;
}

/** Applies durable browser replay/no-progress guards before any external dispatch. */
export function browserPreflight(
  call: ValidatedToolCall,
  context: ToolRuntimeContext,
): ToolExecutionResult | null {
  const checkpoint = context.checkpoint;
  const toolResults = context.toolResults;
  if (typeof checkpoint !== 'object' || checkpoint === null || !Array.isArray(toolResults)) {
    throw new Error('Browser execution context is unavailable.');
  }
  const snapshot: ActiveTaskSnapshot = {
    checkpoint: checkpoint as Checkpoint,
    toolResults: toolResults as readonly MaterializedToolResult[],
  };
  const parsed = call as ParsedBrowserToolCall;
  const executionState =
    context.executionState === 'may_have_dispatched' ? 'may_have_dispatched' : 'recorded';
  const checkpointEffect = { browserToolCallsInAttemptDelta: 1 } as const;
  if (executionState === 'may_have_dispatched') {
    return {
      output: JSON.stringify({
        ok: false,
        code: 'AMBIGUOUS_MUTATION',
        message:
          'The previous browser action may already have run. Inspect the current page before choosing the next action.',
        retryable: false,
        needsInspect: true,
      }),
      checkpoint: checkpointEffect,
    };
  }
  const pending: PendingToolCall = {
    callId: call.callId,
    name: call.name,
    argumentsJson: call.argumentsJson,
    executionState,
  };
  const duplicateFailure = duplicateFailedBrowserTypeOutput(snapshot, parsed);
  if (duplicateFailure !== null) {
    return { output: duplicateFailure, checkpoint: checkpointEffect };
  }
  const noProgressFailure = noProgressBrowserOutput(snapshot, pending);
  return noProgressFailure === null
    ? null
    : { output: noProgressFailure, checkpoint: checkpointEffect };
}

/** Projects a successful browser result onto the generic durable checkpoint effect. */
export function browserCheckpointAfterExecution(
  call: ValidatedToolCall,
  context: ToolRuntimeContext,
  output: string,
): NonNullable<ToolExecutionResult['checkpoint']> {
  const checkpoint = context.checkpoint;
  if (typeof checkpoint !== 'object' || checkpoint === null) {
    throw new Error('Browser execution context is unavailable.');
  }
  const snapshot: ActiveTaskSnapshot = {
    checkpoint: checkpoint as Checkpoint,
    toolResults: Array.isArray(context.toolResults)
      ? (context.toolResults as readonly MaterializedToolResult[])
      : [],
  };
  const browserTargetTabId = browserTargetAfterCall(
    snapshot,
    call as ParsedBrowserToolCall,
    output,
  );
  return {
    browserToolCallsInAttemptDelta: 1,
    ...(browserTargetTabId === undefined ? {} : { browserTargetTabId }),
  };
}
