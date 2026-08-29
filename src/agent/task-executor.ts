import type { ConversationRepository } from '../persistence/conversation-repository';
import type { BrowserExecutionPort } from '../browser/browser-execution-types';
import { TaskRepositoryConflictError, type TaskRepository } from '../persistence/task-repository';
import { isProviderError, type ProviderError } from '../providers/provider-errors';
import type { TavilyExecutionPort, TavilyResultSet } from '../providers/tavily/tavily-types';
import type { IdGenerator, TaskId } from '../shared/ids';
import type { Clock } from '../shared/time';
import { SandboxClientError } from '../sandbox/sandbox-client';
import type { SandboxExecutionPort } from '../sandbox/sandbox-tool-executor';
import type { Checkpoint } from '../tasks/checkpoint-types';
import { materializeContinuationItems } from '../tasks/continuation-materialization';
import type {
  ContinuationItem,
  MaterializedContinuationItem,
  PendingToolCall,
} from '../tasks/continuation-types';
import type { TaskSnapshot } from '../tasks/task-command-service';
import type { TaskError } from '../tasks/task-errors';
import type { TaskHistoryReaderPort } from '../tasks/task-history-reader';
import { TaskLeaseManager } from '../tasks/task-lease';
import { retainTaskReply } from '../tasks/task-reply-retention';
import { transitionTask, type TaskTransitionType } from '../tasks/task-transition';
import type { Task, TaskEvent, TaskModelTurnMetrics, TaskRun } from '../tasks/task-types';
import type { MaterializedToolResult, ToolResult } from '../tasks/tool-result-types';
import { selectPendingTaskSupplements } from '../tasks/task-supplements';
import type { AgentEvent, AgentModelTurn, AgentPlanner } from './execution-types';
import {
  compactContextAtCommit,
  contextCommitCandidateCallIds,
  ContextCommitCursorError,
  INVALID_CONTEXT_COMMIT_CURSOR,
} from './context/context-commit';
import { parseBrowserToolCall } from './tools/browser-tool-schema';
import { browserScrollContinuationForCheckpoint } from './tools/browser-tool-availability';
import { CONTEXT_COMMIT_TOOL_NAME } from './tools/context-commit-tool-schema';
import { parseSandboxToolCall } from './tools/sandbox-tool-schema';
import { parseHistoryToolCall } from './tools/history-tool-schema';
import { parseTavilyToolCall } from './tools/tavily-tool-schema';

export type TaskExecutorErrorCode =
  | 'TASK_NOT_FOUND'
  | 'CHECKPOINT_NOT_FOUND'
  | 'TASK_BUSY'
  | 'TASK_STATE_STALE'
  | 'PLANNER_RESULT_INVALID';

export class TaskExecutorError extends Error {
  readonly code: TaskExecutorErrorCode;

  constructor(code: TaskExecutorErrorCode, message: string) {
    super(message);
    this.name = 'TaskExecutorError';
    this.code = code;
  }
}

export interface TaskExecutorDependencies {
  readonly repository: TaskRepository;
  readonly conversations: Pick<ConversationRepository, 'listMessages' | 'updateMessage'>;
  readonly planner: AgentPlanner;
  readonly tavily: TavilyExecutionPort;
  readonly browser: BrowserExecutionPort;
  readonly sandbox?: SandboxExecutionPort;
  readonly history?: TaskHistoryReaderPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface BoundaryInput {
  readonly type: TaskTransitionType;
  readonly reason: string;
  readonly error?: TaskError;
  readonly toolResults?: readonly MaterializedToolResult[];
  readonly continuationItems?: readonly ContinuationItem[];
  readonly pendingToolCall?: PendingToolCall | null;
  readonly reasoningSummary?: string;
  readonly modelTurn?: TaskModelTurnMetrics;
  readonly browserToolCallsInAttempt?: number;
  readonly browserTargetTabId?: number | null;
  readonly supplementIds?: readonly string[];
  readonly lastModelInputTokens?: number | null;
}

interface ActiveTaskSnapshot extends TaskSnapshot {
  readonly checkpoint: Checkpoint;
}

type AgentOutcome = Exclude<AgentEvent, { readonly type: 'reasoning.summary' }>;

const runnableStatuses = new Set<TaskRun['status']>(['queued', 'planning']);
const TAVILY_TOOL_CALL_LIMIT = 8;
const BROWSER_TOOL_CALL_LIMIT = 256;
const SANDBOX_TOOL_CALL_LIMIT = 128;
/** Number of retries after the initial request for transient Provider failures. */
const MODEL_TRANSIENT_RETRY_LIMIT = 3;
const MODEL_TRANSIENT_RETRY_DELAYS_MS = Object.freeze([500, 1_500, 3_000] as const);
/** Number of retries after invalid model responses within one planning attempt. */
const MODEL_INVALID_RESPONSE_RETRY_LIMIT = 3;
const tavilyToolNames = new Set(['tavily_search', 'tavily_extract', 'tavily_crawl']);
const sandboxToolNames = new Set(['sandbox_read', 'sandbox_exec']);
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Task execution was aborted.', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function sleepWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      globalThis.clearTimeout(timer);
      reject(new DOMException('Task execution was aborted.', 'AbortError'));
    };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function invalidPlannerResultError(): TaskError {
  return {
    code: 'InvalidProviderResponse',
    retryable: false,
    recoveryAction: 'review_provider_status',
    userMessage: 'The provider returned an invalid response.',
    evidenceRef: null,
  };
}

function taskInputError(): TaskError {
  return {
    code: 'TaskInputError',
    retryable: false,
    recoveryAction: 'review_task_input',
    userMessage: 'Task input could not be prepared.',
    evidenceRef: null,
  };
}

function toolCallLimitError(family: 'Tavily' | 'browser' | 'Sandbox'): TaskError {
  return {
    code: 'ToolCallLimitError',
    retryable: false,
    recoveryAction: 'review_task_input',
    userMessage: `The task exceeded the ${family} tool-call limit.`,
    evidenceRef: null,
  };
}

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

function taskErrorFromProvider(error: ProviderError, source: 'model' | 'tavily'): TaskError {
  switch (error.code) {
    case 'AUTH':
      return {
        code: 'AuthError',
        retryable: false,
        recoveryAction: 'update_credentials',
        userMessage:
          source === 'tavily'
            ? 'Tavily authentication is required. Update the Tavily API Key in Settings.'
            : 'Provider authentication is required.',
        evidenceRef: null,
      };
    case 'RATE_LIMIT':
      return {
        code: 'RateLimitError',
        retryable: true,
        recoveryAction: 'resume_later',
        userMessage: 'The provider rate limit was reached.',
        evidenceRef: null,
      };
    case 'TRANSIENT':
      return {
        code: 'TransientProviderError',
        retryable: true,
        recoveryAction: 'resume_task',
        userMessage: 'The provider is temporarily unavailable.',
        evidenceRef: null,
      };
    case 'INVALID_RESPONSE':
      return {
        code: 'InvalidProviderResponse',
        retryable: false,
        recoveryAction: 'review_provider_status',
        userMessage:
          error.invalidResponseStage === null
            ? 'The provider returned an invalid response.'
            : `The provider returned an invalid response (stage: ${error.invalidResponseStage}).`,
        evidenceRef: null,
      };
    case 'ABORTED':
      return {
        code: 'TaskInterrupted',
        retryable: true,
        recoveryAction: 'resume_task',
        userMessage: 'The task was interrupted.',
        evidenceRef: null,
      };
  }
}

/** Counts bounded automatic invalid-response retries in the current planning attempt. */
function invalidModelResponseRetryCount(events: readonly TaskEvent[]): number {
  let planningStartIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'status.changed' && event.reason === 'model_request_started') {
      planningStartIndex = index;
      break;
    }
  }
  return events
    .slice(planningStartIndex + 1)
    .filter(
      (event) =>
        event.type === 'status.changed' && event.reason.startsWith('invalid_model_response_retry:'),
    ).length;
}

/** Projects one completed provider turn onto bounded numeric task telemetry. */
function taskModelTurnMetrics(turn: AgentModelTurn): TaskModelTurnMetrics {
  const usage = turn.usage;
  return {
    inputItemCount: turn.inputItemCount,
    elapsedMs: turn.elapsedMs,
    firstEventMs: turn.firstEventMs,
    ...(turn.firstTextMs === undefined ? {} : { firstTextMs: turn.firstTextMs }),
    ...(usage === null
      ? {}
      : {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          ...(usage.cachedInputTokens === undefined
            ? {}
            : { cachedInputTokens: usage.cachedInputTokens }),
          ...(usage.cacheWriteInputTokens === undefined
            ? {}
            : { cacheWriteInputTokens: usage.cacheWriteInputTokens }),
          ...(usage.reasoningOutputTokens === undefined
            ? {}
            : { reasoningOutputTokens: usage.reasoningOutputTokens }),
        }),
  };
}

/** Runs a durable sequential Tavily/model loop with checkpointed results. */
export class TaskExecutor {
  readonly #dependencies: TaskExecutorDependencies;
  readonly #leases: TaskLeaseManager;

  constructor(dependencies: TaskExecutorDependencies) {
    this.#dependencies = dependencies;
    this.#leases = new TaskLeaseManager(dependencies.repository);
  }

  async run(taskId: TaskId, signal: AbortSignal): Promise<TaskSnapshot> {
    throwIfAborted(signal);
    const ownerId = this.#createId('runner');
    const acquired = await this.#leases.acquire(taskId, ownerId, this.#dependencies.clock.now());
    if (!acquired) throw new TaskExecutorError('TASK_BUSY', 'Task is already running.');

    try {
      let snapshot = await this.#loadSnapshot(taskId);
      if (!runnableStatuses.has(snapshot.task.status)) return snapshot;
      if (snapshot.task.status !== 'planning') {
        snapshot = await this.#saveBoundary(snapshot, ownerId, signal, {
          type: 'planning.started',
          reason: 'model_request_started',
        });
      }

      let transientModelRetryCount = 0;
      while (true) {
        throwIfAborted(signal);
        if (snapshot.checkpoint.pendingToolCall !== null) {
          snapshot = await this.#executePendingTool(snapshot, ownerId, signal);
          if (!runnableStatuses.has(snapshot.task.status)) return snapshot;
          continue;
        }
        snapshot = await this.#applySupplements(snapshot, ownerId, signal);
        if (!runnableStatuses.has(snapshot.task.status)) return snapshot;
        let result: AgentOutcome;
        try {
          result = await this.#planOne(snapshot, signal, async (reasoningSummary) => {
            snapshot = await this.#refreshCurrentAttempt(snapshot);
            if (!runnableStatuses.has(snapshot.task.status)) return;
            snapshot = await this.#saveBoundary(snapshot, ownerId, signal, {
              type: 'reasoning.summary-recorded',
              reason: 'model_reasoning_summary_recorded',
              reasoningSummary,
            });
          });
        } catch (error) {
          if (
            isProviderError(error) &&
            error.code === 'TRANSIENT' &&
            transientModelRetryCount < MODEL_TRANSIENT_RETRY_LIMIT
          ) {
            const retryDelay =
              MODEL_TRANSIENT_RETRY_DELAYS_MS[transientModelRetryCount] ??
              MODEL_TRANSIENT_RETRY_DELAYS_MS.at(-1) ??
              3_000;
            transientModelRetryCount += 1;
            snapshot = await this.#saveBoundary(snapshot, ownerId, signal, {
              type: 'planning.retrying',
              reason: 'transient_model_retry:upstream_failure',
            });
            await (this.#dependencies.sleep ?? sleepWithAbort)(retryDelay, signal);
            continue;
          }
          if (
            isProviderError(error) &&
            error.code === 'INVALID_RESPONSE' &&
            invalidModelResponseRetryCount(snapshot.events) < MODEL_INVALID_RESPONSE_RETRY_LIMIT
          ) {
            snapshot = await this.#saveBoundary(snapshot, ownerId, signal, {
              type: 'planning.retrying',
              reason: `invalid_model_response_retry:${error.invalidResponseStage ?? 'unknown'}`,
            });
            continue;
          }
          return await this.#handleFailure(snapshot, ownerId, signal, error, 'model');
        }
        snapshot = await this.#refreshCurrentAttempt(snapshot);
        if (!runnableStatuses.has(snapshot.task.status)) return snapshot;
        transientModelRetryCount = 0;

        if (result.type === 'task.completed') {
          if (
            browserScrollContinuationForCheckpoint({
              checkpoint: snapshot.checkpoint,
              toolResults: snapshot.toolResults,
            }) !== null
          ) {
            await this.#interruptReply(snapshot.task, result.messageId);
            continue;
          }
          const continuationItems = snapshot.checkpoint.continuationItems.some(
            (item) => item.type === 'message_ref' && item.messageId === result.messageId,
          )
            ? snapshot.checkpoint.continuationItems
            : [
                ...snapshot.checkpoint.continuationItems,
                { type: 'message_ref' as const, messageId: result.messageId },
              ];
          try {
            return await this.#saveBoundary(snapshot, ownerId, signal, {
              type: 'task.completed',
              reason: result.reason,
              continuationItems,
              pendingToolCall: null,
              ...(result.modelTurn === undefined
                ? {}
                : { modelTurn: taskModelTurnMetrics(result.modelTurn) }),
            });
          } catch (error) {
            if (!(error instanceof TaskRepositoryConflictError)) throw error;
            await this.#interruptReply(snapshot.task, result.messageId);
            continue;
          }
        }

        // Planner-provided native compaction uses the same durable boundary as automatic compaction.
        if (result.type === 'context.compacted') {
          this.#dependencies.browser.resetObservationBaselines();
          snapshot = await this.#saveBoundary(snapshot, ownerId, signal, {
            type: 'task.context-compacted',
            reason: 'native_context_compacted',
            continuationItems: result.continuationItems,
            pendingToolCall: null,
            lastModelInputTokens: null,
          });
          continue;
        }

        const call =
          result.type === 'browser.call' ||
          result.type === 'context.commit' ||
          result.type === 'sandbox.call' ||
          result.type === 'history.call'
            ? result.call
            : result;
        if (snapshot.toolResults.some((completed) => completed.callId === call.callId)) {
          return this.#saveBoundary(snapshot, ownerId, signal, {
            type: 'task.failed',
            reason: 'duplicate_tool_call_id',
            error: invalidPlannerResultError(),
          });
        }
        if (result.type !== 'context.commit' && result.type !== 'history.call') {
          const isBrowserCall = result.type === 'browser.call';
          const isSandboxCall = result.type === 'sandbox.call';
          const completedFamilyCalls = isBrowserCall
            ? (snapshot.checkpoint.browserToolCallsInAttempt ?? 0)
            : snapshot.toolResults.filter((completed) =>
                (isSandboxCall ? sandboxToolNames : tavilyToolNames).has(completed.toolName),
              ).length;
          const familyLimit = isBrowserCall
            ? BROWSER_TOOL_CALL_LIMIT
            : isSandboxCall
              ? SANDBOX_TOOL_CALL_LIMIT
              : TAVILY_TOOL_CALL_LIMIT;
          if (completedFamilyCalls >= familyLimit) {
            const family = isBrowserCall ? 'browser' : isSandboxCall ? 'sandbox' : 'tavily';
            return this.#saveBoundary(snapshot, ownerId, signal, {
              type: 'task.failed',
              reason: `${family}_tool_call_limit_reached`,
              error: toolCallLimitError(
                isBrowserCall ? 'browser' : isSandboxCall ? 'Sandbox' : 'Tavily',
              ),
            });
          }
        }

        const toolName =
          result.type === 'browser.call' ||
          result.type === 'context.commit' ||
          result.type === 'sandbox.call' ||
          result.type === 'history.call'
            ? result.call.name
            : `tavily_${result.operation}`;

        snapshot = await this.#saveBoundary(snapshot, ownerId, signal, {
          type: 'tool.call-recorded',
          reason: `${toolName}_call_recorded`,
          continuationItems: [
            ...snapshot.checkpoint.continuationItems,
            {
              type: 'function_call',
              callId: call.callId,
              name: toolName,
              argumentsJson: call.argumentsJson,
              ...(result.modelOutputItems === undefined || result.modelOutputItems.length === 0
                ? {}
                : { modelOutputItems: result.modelOutputItems }),
            },
          ],
          pendingToolCall: {
            callId: call.callId,
            name: toolName,
            argumentsJson: call.argumentsJson,
            executionState: 'recorded',
            ...(toolName === 'sandbox_exec'
              ? { executionId: this.#createId('sandboxExecution') }
              : {}),
          },
          ...(result.modelTurn === undefined
            ? {}
            : { modelTurn: taskModelTurnMetrics(result.modelTurn) }),
        });
      }
    } finally {
      try {
        await this.#dependencies.browser.release(ownerId);
      } finally {
        await this.#leases.release(taskId, ownerId);
      }
    }
  }

  /** Executes a durably recorded tool and prevents ambiguous browser mutations from replaying. */
  async #executePendingTool(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<ActiveTaskSnapshot> {
    const pending = snapshot.checkpoint.pendingToolCall;
    if (pending === null) return snapshot;

    if (pending.name === CONTEXT_COMMIT_TOOL_NAME) {
      return this.#executePendingContextCommit(snapshot, ownerId, signal, pending);
    }
    if (pending.name.startsWith('browser_')) {
      return this.#executePendingBrowserTool(snapshot, ownerId, signal, pending);
    }
    if (pending.name.startsWith('sandbox_')) {
      return this.#executePendingSandboxTool(snapshot, ownerId, signal, pending);
    }
    if (
      pending.name === 'history_read' ||
      pending.name === 'history_read_task' ||
      pending.name === 'result_read'
    ) {
      return this.#executePendingHistoryTool(snapshot, ownerId, signal, pending);
    }

    let call: Extract<AgentEvent, { readonly type: 'tavily.call' }>;
    let toolResult: TavilyResultSet;
    try {
      const parsed = parseTavilyToolCall(pending);
      call = { type: 'tavily.call', ...parsed };
      toolResult = await this.#executeTavily(call, signal);
    } catch (error) {
      return this.#handleFailure(snapshot, ownerId, signal, error, 'tavily');
    }

    return this.#recordToolResult(
      snapshot,
      ownerId,
      signal,
      pending,
      JSON.stringify({
        ok: true,
        results: toolResult.results,
        truncated: toolResult.truncated,
      }),
    );
  }

  async #executePendingHistoryTool(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    pending: PendingToolCall,
  ): Promise<ActiveTaskSnapshot> {
    const history = this.#dependencies.history;
    if (!history) {
      return this.#handleFailure(
        snapshot,
        ownerId,
        signal,
        new Error('Conversation history retrieval is unavailable.'),
        'model',
      );
    }

    try {
      const call = parseHistoryToolCall(pending);
      const context = {
        conversationId: snapshot.task.conversationId,
        currentTaskId: snapshot.task.id,
      };
      const result =
        call.operation === 'history'
          ? await history.readHistory(context, call.arguments)
          : call.operation === 'history_task'
            ? await history.readTaskHistory(context, call.arguments)
            : await history.readResult(context, call.arguments);
      return this.#recordToolResult(snapshot, ownerId, signal, pending, JSON.stringify(result));
    } catch (error) {
      return this.#handleFailure(snapshot, ownerId, signal, error, 'model');
    }
  }

  async #executePendingSandboxTool(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    pending: PendingToolCall,
  ): Promise<ActiveTaskSnapshot> {
    let call: ReturnType<typeof parseSandboxToolCall>;
    try {
      call = parseSandboxToolCall(pending);
    } catch (error) {
      return this.#handleFailure(snapshot, ownerId, signal, error, 'sandbox');
    }

    const sandbox = this.#dependencies.sandbox;
    if (!sandbox) {
      return this.#handleFailure(
        snapshot,
        ownerId,
        signal,
        new Error('Sandbox execution is unavailable.'),
        'sandbox',
      );
    }

    if (call.operation === 'exec' && pending.executionState === 'may_have_dispatched') {
      if (pending.executionId === undefined) {
        return this.#recordToolResult(
          snapshot,
          ownerId,
          signal,
          pending,
          JSON.stringify({
            ok: false,
            code: 'AMBIGUOUS_EXECUTION',
            message:
              'The previous Sandbox command may already have run. Inspect its effects before choosing the next action.',
            retryable: false,
          }),
        );
      }
      try {
        const recovery = await sandbox.recover(pending.executionId, signal);
        if (recovery.status === 'finished') {
          return this.#recordToolResult(snapshot, ownerId, signal, pending, recovery.output);
        }
        if (recovery.status === 'running') {
          return this.#pauseSandboxRecovery(snapshot, ownerId, signal, pending);
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error;
        if (error instanceof SandboxClientError && error.code === 'AUTH') {
          return this.#saveBoundary(snapshot, ownerId, signal, {
            type: 'task.auth-required',
            reason: 'sandbox_authentication_required',
            error: {
              code: 'AuthError',
              retryable: false,
              recoveryAction: 'update_credentials',
              userMessage:
                'Sandbox authentication is required. Update the Sandbox Token in Settings.',
              evidenceRef: null,
            },
            pendingToolCall: pending,
          });
        }
        return this.#pauseSandboxRecovery(snapshot, ownerId, signal, pending);
      }
    }

    if (call.replay === 'mutation' && pending.executionState === 'recorded') {
      snapshot = await this.#saveBoundary(snapshot, ownerId, signal, {
        type: 'tool.execution-started',
        reason: `${call.name}_execution_started`,
        pendingToolCall: { ...pending, executionState: 'may_have_dispatched' },
      });
    }
    try {
      const output = await sandbox.execute(call, signal, {
        ...(pending.executionId === undefined ? {} : { executionId: pending.executionId }),
      });
      return this.#recordToolResult(snapshot, ownerId, signal, pending, output);
    } catch (error) {
      return this.#handleSandboxFailure(snapshot, ownerId, signal, pending, call, error);
    }
  }

  #pauseSandboxRecovery(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    pending: PendingToolCall,
  ): Promise<ActiveTaskSnapshot> {
    return this.#saveBoundary(snapshot, ownerId, signal, {
      type: 'task.paused',
      reason: 'sandbox_execution_recovery_pending',
      error: {
        code: 'TransientProviderError',
        retryable: true,
        recoveryAction: 'retry',
        userMessage:
          'The Sandbox command is still running or its status is temporarily unavailable.',
        evidenceRef: null,
      },
      pendingToolCall: { ...pending, executionState: 'may_have_dispatched' },
    });
  }

  /** Resolves the internal commit without dispatching an external side effect. */
  async #executePendingContextCommit(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    pending: PendingToolCall,
  ): Promise<ActiveTaskSnapshot> {
    const resultId = this.#createId('toolResult');
    let compaction: ReturnType<typeof compactContextAtCommit>;
    try {
      compaction = compactContextAtCommit(
        materializeContinuationItems({
          continuationItems: snapshot.checkpoint.continuationItems,
          toolResults: snapshot.toolResults,
        }),
        pending,
        resultId,
      );
    } catch (error) {
      if (error instanceof ContextCommitCursorError) {
        const currentCommit = snapshot.checkpoint.continuationItems.at(-1);
        const materializedItems = materializeContinuationItems({
          continuationItems: snapshot.checkpoint.continuationItems,
          toolResults: snapshot.toolResults,
        });
        const candidateItems =
          currentCommit?.type === 'function_call' && currentCommit.callId === pending.callId
            ? materializedItems.slice(0, -1)
            : materializedItems;
        return this.#recordToolResult(
          snapshot,
          ownerId,
          signal,
          pending,
          JSON.stringify({
            ok: false,
            code: INVALID_CONTEXT_COMMIT_CURSOR,
            message:
              'throughCallId did not match a current completed non-commit tool call. Retry commit_context with one of validThroughCallIds.',
            validThroughCallIds: contextCommitCandidateCallIds(candidateItems),
          }),
        );
      }
      return this.#handleFailure(snapshot, ownerId, signal, error, 'model');
    }

    const completedResult: MaterializedToolResult = {
      id: resultId,
      taskId: snapshot.task.id,
      runId: snapshot.run.id,
      callId: pending.callId,
      toolName: pending.name,
      argumentsJson: pending.argumentsJson,
      output: compaction.output,
      attachmentIds: [],
      createdAt: this.#dependencies.clock.now(),
    };
    const referencedResultIds = new Set(
      snapshot.checkpoint.continuationItems.flatMap((item) =>
        item.type === 'function_call_output_ref' ? [item.resultId] : [],
      ),
    );
    const continuationItems = compaction.continuationItems.map((item): ContinuationItem => {
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
    this.#dependencies.browser.resetObservationBaselines();
    return this.#saveBoundary(snapshot, ownerId, signal, {
      type: 'tool.result-recorded',
      reason: `${pending.name}_result_recorded`,
      toolResults: [...snapshot.toolResults, completedResult],
      continuationItems,
      pendingToolCall: null,
    });
  }

  async #executePendingBrowserTool(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    pending: PendingToolCall,
  ): Promise<ActiveTaskSnapshot> {
    let call: ReturnType<typeof parseBrowserToolCall>;
    try {
      call = parseBrowserToolCall(pending);
    } catch (error) {
      return this.#handleFailure(snapshot, ownerId, signal, error, 'browser');
    }

    if (pending.executionState === 'may_have_dispatched') {
      return this.#recordToolResult(
        snapshot,
        ownerId,
        signal,
        pending,
        JSON.stringify({
          ok: false,
          code: 'AMBIGUOUS_MUTATION',
          message:
            'The previous browser action may already have run. Inspect the current page before choosing the next action.',
          retryable: false,
          needsInspect: true,
        }),
      );
    }

    const duplicateFailure = duplicateFailedBrowserTypeOutput(snapshot, call);
    if (duplicateFailure !== null) {
      return this.#recordToolResult(snapshot, ownerId, signal, pending, duplicateFailure);
    }

    const noProgressFailure = noProgressBrowserOutput(snapshot, pending);
    if (noProgressFailure !== null) {
      return this.#recordToolResult(snapshot, ownerId, signal, pending, noProgressFailure);
    }

    if (call.replay === 'mutation') {
      snapshot = await this.#saveBoundary(snapshot, ownerId, signal, {
        type: 'tool.execution-started',
        reason: `${call.name}_execution_started`,
        pendingToolCall: { ...pending, executionState: 'may_have_dispatched' },
      });
    }

    try {
      const toolResult = await this.#dependencies.browser.execute(call, signal, {
        currentTabId: currentBrowserTarget(snapshot),
        sessionOwnerId: ownerId,
        availableAssetIds: [
          ...new Set(snapshot.toolResults.flatMap((result) => [...(result.attachmentIds ?? [])])),
        ],
      });
      return this.#recordToolResult(
        snapshot,
        ownerId,
        signal,
        pending,
        toolResult.output,
        toolResult.attachmentIds,
        toolResult.modelAttachmentIds,
        browserTargetAfterCall(snapshot, call, toolResult.output),
        toolResult.modelOutput,
      );
    } catch (error) {
      return this.#handleFailure(snapshot, ownerId, signal, error, 'browser');
    }
  }

  async #recordToolResult(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    pending: PendingToolCall,
    output: string,
    attachmentIds: readonly string[] = [],
    modelAttachmentIds: readonly string[] | undefined = undefined,
    browserTargetTabId?: number | null,
    modelOutput: string | undefined = undefined,
  ): Promise<ActiveTaskSnapshot> {
    const durableAttachmentIds = [...new Set(attachmentIds)];
    const continuationAttachmentIds = [...new Set(modelAttachmentIds ?? durableAttachmentIds)];
    if (
      durableAttachmentIds.length > 8 ||
      durableAttachmentIds.some((id) => id.length === 0 || id.length > 256) ||
      continuationAttachmentIds.length > 8 ||
      continuationAttachmentIds.some(
        (id) => id.length === 0 || id.length > 256 || !durableAttachmentIds.includes(id),
      )
    ) {
      throw new Error('Browser tool attachment references are invalid.');
    }
    const resultId = this.#createId('toolResult');
    const completedResult: MaterializedToolResult = {
      id: resultId,
      taskId: snapshot.task.id,
      runId: snapshot.run.id,
      callId: pending.callId,
      toolName: pending.name,
      argumentsJson: pending.argumentsJson,
      output,
      ...(modelOutput === undefined || modelOutput.length >= output.length ? {} : { modelOutput }),
      attachmentIds: durableAttachmentIds,
      createdAt: this.#dependencies.clock.now(),
    };
    return this.#saveBoundary(snapshot, ownerId, signal, {
      type: 'tool.result-recorded',
      reason: `${pending.name}_result_recorded`,
      toolResults: [...snapshot.toolResults, completedResult],
      continuationItems: [
        ...snapshot.checkpoint.continuationItems,
        {
          type: 'function_call_output_ref',
          callId: pending.callId,
          resultId: completedResult.id,
          attachmentIds: continuationAttachmentIds,
        },
      ],
      pendingToolCall: null,
      browserToolCallsInAttempt:
        (snapshot.checkpoint.browserToolCallsInAttempt ?? 0) +
        (pending.name.startsWith('browser_') ? 1 : 0),
      ...(browserTargetTabId === undefined ? {} : { browserTargetTabId }),
    });
  }

  /** Commits every accepted but unconsumed task supplement before the next model request. */
  async #applySupplements(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<ActiveTaskSnapshot> {
    snapshot = await this.#refreshCurrentAttempt(snapshot);
    if (!runnableStatuses.has(snapshot.task.status)) return snapshot;
    const messages = await this.#dependencies.conversations.listMessages(
      snapshot.task.conversationId,
    );
    const supplements = selectPendingTaskSupplements(messages, snapshot.events, snapshot.task.id);
    if (supplements.length === 0) return snapshot;

    return this.#saveBoundary(snapshot, ownerId, signal, {
      type: 'task.supplements-applied',
      reason: 'user_supplements_applied',
      supplementIds: supplements.map(({ id }) => id).slice(-100),
      continuationItems: [
        ...snapshot.checkpoint.continuationItems,
        ...supplements.map((message): ContinuationItem => ({
          type: 'message_ref',
          messageId: message.id,
        })),
      ],
    });
  }

  /** Returns a just-completed reply to the reusable interrupted state without changing its text. */
  async #interruptReply(task: Task, messageId: string): Promise<void> {
    const messages = await this.#dependencies.conversations.listMessages(task.conversationId);
    const message = messages.find(
      (candidate) =>
        candidate.id === messageId &&
        candidate.taskId === task.id &&
        candidate.kind === 'conversation' &&
        candidate.role === 'assistant',
    );
    if (message === undefined) {
      throw new TaskExecutorError('TASK_STATE_STALE', 'Completed reply message is missing.');
    }
    if (message.status === 'interrupted') return;
    if (message.status !== 'complete') {
      throw new TaskExecutorError('TASK_STATE_STALE', 'Completed reply message is invalid.');
    }
    await this.#dependencies.conversations.updateMessage({
      ...message,
      status: 'interrupted',
      updatedAt: Math.max(message.updatedAt, this.#dependencies.clock.now()),
    });
  }

  /** Persists progress events while collecting exactly one outcome for one model response. */
  async #planOne(
    snapshot: ActiveTaskSnapshot,
    signal: AbortSignal,
    onReasoningSummary: (summary: string) => Promise<void>,
  ): Promise<AgentOutcome> {
    let result: AgentOutcome | null = null;
    for await (const event of this.#dependencies.planner.plan(
      {
        task: snapshot.task,
        events: snapshot.events,
        checkpoint: snapshot.checkpoint,
        toolResults: snapshot.toolResults,
      },
      signal,
    )) {
      throwIfAborted(signal);
      if (event.type === 'reasoning.summary') {
        if (result !== null) {
          throw new TaskExecutorError(
            'PLANNER_RESULT_INVALID',
            'Planner returned progress after its outcome.',
          );
        }
        await onReasoningSummary(event.text);
        continue;
      }
      if (result !== null) {
        throw new TaskExecutorError(
          'PLANNER_RESULT_INVALID',
          'Planner returned more than one result.',
        );
      }
      result = event;
    }
    if (result === null) {
      throw new TaskExecutorError('PLANNER_RESULT_INVALID', 'Planner returned no result.');
    }
    return result;
  }

  /** Dispatches one already validated Tavily call without parallel execution. */
  #executeTavily(
    event: Extract<AgentEvent, { readonly type: 'tavily.call' }>,
    signal: AbortSignal,
  ): Promise<TavilyResultSet> {
    switch (event.operation) {
      case 'search':
        return this.#dependencies.tavily.search(event.arguments, signal);
      case 'extract':
        return this.#dependencies.tavily.extract(event.arguments, signal);
      case 'crawl':
        return this.#dependencies.tavily.crawl(event.arguments, signal);
    }
  }

  async #handleSandboxFailure(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    pending: PendingToolCall,
    call: ReturnType<typeof parseSandboxToolCall>,
    error: unknown,
  ): Promise<ActiveTaskSnapshot> {
    if (signal.aborted || isAbortError(error)) throw error;
    if (!(error instanceof SandboxClientError)) {
      return this.#handleFailure(snapshot, ownerId, signal, error, 'sandbox');
    }
    if (error.code === 'ABORTED') throw error;

    if (error.code === 'AUTH') {
      return this.#saveBoundary(snapshot, ownerId, signal, {
        type: 'task.auth-required',
        reason: 'sandbox_authentication_required',
        error: {
          code: 'AuthError',
          retryable: false,
          recoveryAction: 'update_credentials',
          userMessage: 'Sandbox authentication is required. Update the Sandbox Token in Settings.',
          evidenceRef: null,
        },
        pendingToolCall: { ...pending, executionState: 'recorded' },
      });
    }

    if (call.replay === 'mutation' && error.dispatchState === 'may_have_dispatched') {
      return this.#pauseSandboxRecovery(snapshot, ownerId, signal, {
        ...pending,
        executionState: 'may_have_dispatched',
      });
    }

    return this.#recordToolResult(
      snapshot,
      ownerId,
      signal,
      pending,
      JSON.stringify(
        error.code === 'INVALID_RESPONSE'
          ? {
              ok: false,
              code: 'SANDBOX_INVALID_RESPONSE',
              message: 'The Sandbox returned an invalid response.',
              retryable: false,
            }
          : {
              ok: false,
              code: 'SANDBOX_UNAVAILABLE',
              message: 'The Sandbox is temporarily unavailable.',
              retryable: true,
            },
      ),
    );
  }

  /** Converts one safe model or Tavily failure into its durable task boundary. */
  async #handleFailure(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    error: unknown,
    source: 'model' | 'tavily' | 'browser' | 'sandbox',
  ): Promise<ActiveTaskSnapshot> {
    if (signal.aborted || isAbortError(error)) throw error;
    if (error instanceof TaskExecutorError && error.code === 'PLANNER_RESULT_INVALID') {
      return this.#saveBoundary(snapshot, ownerId, signal, {
        type: 'task.failed',
        reason: 'invalid_planner_result',
        error: invalidPlannerResultError(),
      });
    }
    if (!isProviderError(error)) {
      return this.#saveBoundary(snapshot, ownerId, signal, {
        type: 'task.failed',
        reason:
          source === 'tavily'
            ? 'tavily_execution_failed'
            : source === 'browser'
              ? 'browser_execution_failed'
              : source === 'sandbox'
                ? 'sandbox_execution_failed'
                : 'task_input_preparation_failed',
        error: taskInputError(),
      });
    }
    if (error.code === 'ABORTED') throw error;
    const taskError = taskErrorFromProvider(error, source === 'tavily' ? 'tavily' : 'model');
    return this.#saveBoundary(snapshot, ownerId, signal, {
      type:
        error.code === 'AUTH'
          ? 'task.auth-required'
          : error.code === 'INVALID_RESPONSE'
            ? 'task.failed'
            : 'task.paused',
      reason:
        error.code === 'AUTH'
          ? `${source}_authentication_required`
          : error.code === 'INVALID_RESPONSE'
            ? `invalid_${source}_response${
                error.invalidResponseStage === null ? '' : `:${error.invalidResponseStage}`
              }`
            : `${source}_retry_required`,
      error: taskError,
    });
  }

  async #loadSnapshot(taskId: TaskId): Promise<ActiveTaskSnapshot> {
    const snapshot = await this.#dependencies.repository.readActiveRuntimeSnapshot(taskId);
    if (snapshot === undefined) {
      throw new TaskExecutorError('TASK_NOT_FOUND', 'Task does not exist.');
    }
    if (snapshot.run.checkpointId === null) {
      throw new TaskExecutorError('CHECKPOINT_NOT_FOUND', 'Task checkpoint is missing.');
    }
    if (snapshot.checkpoint === undefined) {
      throw new TaskExecutorError('CHECKPOINT_NOT_FOUND', 'Task checkpoint is missing.');
    }
    return {
      task: snapshot.task,
      run: snapshot.run,
      checkpoint: snapshot.checkpoint,
      events: snapshot.events,
      toolResults: snapshot.toolResults,
    };
  }

  /** Reloads durable events written during a model turn without crossing attempt boundaries. */
  async #refreshCurrentAttempt(snapshot: ActiveTaskSnapshot): Promise<ActiveTaskSnapshot> {
    const delta = await this.#dependencies.repository.readActiveRuntimeDelta(
      snapshot.task.id,
      snapshot.task.lastEventSequence,
    );
    if (
      delta === undefined ||
      delta.run.id !== snapshot.run.id ||
      delta.checkpoint?.id !== snapshot.checkpoint.id
    ) {
      throw new TaskExecutorError(
        'TASK_STATE_STALE',
        'Task attempt changed while preparing the next model request.',
      );
    }
    return {
      task: delta.task,
      run: delta.run,
      checkpoint: delta.checkpoint,
      events: [...snapshot.events, ...delta.events],
      toolResults: snapshot.toolResults,
    };
  }

  async #saveBoundary(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    input: BoundaryInput & { readonly type: 'task.completed' },
  ): Promise<TaskSnapshot>;
  async #saveBoundary(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    input: BoundaryInput,
  ): Promise<ActiveTaskSnapshot>;
  async #saveBoundary(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    input: BoundaryInput,
  ): Promise<TaskSnapshot> {
    throwIfAborted(signal);
    const now = this.#dependencies.clock.now();
    const renewed = await this.#leases.renew(snapshot.task.id, ownerId, now);
    if (!renewed) throw new TaskExecutorError('TASK_BUSY', 'Task lease was lost.');
    const current = await this.#refreshCurrentAttempt(snapshot);
    const currentTask = current.task;
    const currentRun = current.run;
    const currentCheckpoint = current.checkpoint;
    if (
      currentTask.latestRunId !== snapshot.run.id ||
      currentRun.checkpointId !== snapshot.checkpoint.id ||
      currentCheckpoint.id !== snapshot.checkpoint.id
    ) {
      throw new TaskExecutorError('TASK_STATE_STALE', 'Task changed during execution.');
    }

    const transitioned = transitionTask(currentTask, currentRun, {
      type: input.type,
      at: now,
      reason: input.reason,
      ...(input.error === undefined ? {} : { error: input.error }),
    });
    const nextToolResults = input.toolResults ?? current.toolResults;
    const previousResultIds = new Set(current.toolResults.map((result) => result.id));
    const newResults = nextToolResults.filter((result) => !previousResultIds.has(result.id));
    const canonicalResults: ToolResult[] = newResults.map((result) => ({
      id: result.id,
      taskId: result.taskId,
      runId: result.runId,
      callId: result.callId,
      toolName: result.toolName,
      output: result.output,
      ...(result.modelOutput === undefined ? {} : { modelOutput: result.modelOutput }),
      attachmentIds: result.attachmentIds,
      createdAt: result.createdAt,
    }));

    let sequence = currentTask.lastEventSequence;
    const eventBase = () => ({
      id: this.#createId('event'),
      taskId: currentTask.id,
      runId: currentRun.id,
      sequence: (sequence += 1),
      at: now,
    });
    const events: TaskEvent[] = [];
    if (input.modelTurn !== undefined) {
      events.push({ ...eventBase(), type: 'model.turn', metrics: input.modelTurn });
    }
    if (input.type === 'reasoning.summary-recorded') {
      if (input.reasoningSummary === undefined) {
        throw new TaskExecutorError('TASK_STATE_STALE', 'Reasoning summary is missing.');
      }
      events.push({ ...eventBase(), type: 'reasoning.summary', summary: input.reasoningSummary });
    } else if (input.type === 'tool.call-recorded') {
      const pending = input.pendingToolCall;
      if (pending === undefined || pending === null) {
        throw new TaskExecutorError('TASK_STATE_STALE', 'Recorded tool call is missing.');
      }
      events.push({
        ...eventBase(),
        type: 'tool.call',
        callId: pending.callId,
        name: pending.name,
        argumentsJson: pending.argumentsJson,
      });
    } else if (input.type === 'tool.execution-started') {
      const pending = input.pendingToolCall ?? currentCheckpoint.pendingToolCall;
      if (pending === null || pending === undefined) {
        throw new TaskExecutorError('TASK_STATE_STALE', 'Dispatched tool call is missing.');
      }
      events.push({ ...eventBase(), type: 'tool.dispatched', callId: pending.callId });
    } else if (input.type === 'tool.result-recorded') {
      const result = newResults.at(-1);
      if (result === undefined) {
        throw new TaskExecutorError('TASK_STATE_STALE', 'Recorded tool result is missing.');
      }
      events.push({
        ...eventBase(),
        type: 'tool.result',
        callId: result.callId,
        resultId: result.id,
      });
    } else if (input.type === 'task.supplements-applied') {
      for (const messageId of input.supplementIds ?? []) {
        events.push({ ...eventBase(), type: 'supplement.applied', messageId });
      }
    } else if (input.type === 'task.context-compacted') {
      events.push({
        ...eventBase(),
        type: 'context.compacted',
        releasedTextCharacters: 0,
        releasedImages: 0,
      });
    } else {
      events.push({
        ...eventBase(),
        type: 'status.changed',
        taskStatus: transitioned.task.status,
        runStatus: transitioned.run.status,
        reason: input.reason,
        error: input.error ?? transitioned.run.error,
      });
    }
    if (events.length === 0) {
      throw new TaskExecutorError('TASK_STATE_STALE', 'Task boundary produced no event.');
    }

    const { lastModelInputTokens: previousLastModelInputTokens, ...previousCheckpoint } =
      currentCheckpoint;
    const lastModelInputTokens =
      input.lastModelInputTokens === null
        ? undefined
        : (input.lastModelInputTokens ??
          input.modelTurn?.inputTokens ??
          previousLastModelInputTokens);
    const checkpoint: Checkpoint = {
      ...previousCheckpoint,
      continuationItems: input.continuationItems ?? currentCheckpoint.continuationItems,
      pendingToolCall:
        input.pendingToolCall === undefined
          ? currentCheckpoint.pendingToolCall
          : input.pendingToolCall,
      ...(lastModelInputTokens === undefined ? {} : { lastModelInputTokens }),
      browserToolCallsInAttempt:
        input.browserToolCallsInAttempt ?? currentCheckpoint.browserToolCallsInAttempt ?? 0,
      ...(input.browserTargetTabId === undefined
        ? {}
        : { browserTargetTabId: input.browserTargetTabId }),
    };
    const completed = input.type === 'task.completed';
    const task: Task = { ...transitioned.task, lastEventSequence: sequence };
    const run: TaskRun = {
      ...transitioned.run,
      checkpointId: completed ? null : checkpoint.id,
    };
    await this.#dependencies.repository.saveTransition({
      task,
      run,
      events,
      checkpoint,
      ...(completed
        ? {
            deleteCheckpoint: true,
          }
        : {}),
      ...(canonicalResults.length === 0 ? {} : { toolResults: canonicalResults }),
    });
    if (input.type === 'task.failed') {
      await retainTaskReply(task, 'error', this.#dependencies);
      return this.#refreshCurrentAttempt({
        task,
        run,
        checkpoint,
        events: [...current.events, ...events],
        toolResults: nextToolResults,
      });
    }
    return {
      task,
      run,
      checkpoint: completed ? null : checkpoint,
      events: [...current.events, ...events],
      toolResults: nextToolResults,
    };
  }

  #createId(prefix: string): string {
    const id = this.#dependencies.ids.create(prefix).trim();
    if (id.length === 0) {
      throw new TaskExecutorError('TASK_STATE_STALE', 'Identifier generation failed.');
    }
    return id;
  }
}
