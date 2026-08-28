import type { Checkpoint } from '../../tasks/checkpoint-types';
import { materializeContinuationItems } from '../../tasks/continuation-materialization';
import type { MaterializedContinuationItem } from '../../tasks/continuation-types';
import type { MaterializedToolResult } from '../../tasks/tool-result-types';
import type { ModelToolChoice, ModelToolDefinition } from '../../tools/contracts/model-tool';
import {
  BROWSER_TOOL_DEFINITIONS,
  BROWSER_TOOL_DEFINITION_BY_NAME,
  type BrowserToolName,
} from './browser-tool-schema';

const DISCOVERY_TOOL_NAMES = new Set<BrowserToolName>([
  'browser_list_tabs',
  'browser_open_tab',
  'browser_switch_tab',
  'browser_close_tab',
  'browser_navigate',
  'browser_reload',
  'browser_inspect',
  'browser_capture_screenshot',
  'browser_wait',
  'browser_network_start',
]);

const INTERACTIVE_TOOL_NAMES = new Set<BrowserToolName>([
  'browser_click',
  'browser_set_checked',
  'browser_type',
  'browser_keypress',
  'browser_scroll',
  'browser_hover',
  'browser_select',
  'browser_drag',
]);

const VISUAL_INVALIDATING_TOOLS = new Set<BrowserToolName>([
  'browser_open_tab',
  'browser_switch_tab',
  'browser_close_tab',
  'browser_navigate',
  'browser_reload',
  'browser_paste_image',
  'browser_click',
  'browser_set_checked',
  'browser_set_checked_many',
  'browser_type',
  'browser_keypress',
  'browser_scroll',
  'browser_hover',
  'browser_select',
  'browser_drag',
  'browser_wait',
  'browser_click_point',
  'browser_drag_point',
]);

interface CapabilityState {
  semanticSnapshotCurrent: boolean;
  visualSnapshotCurrent: boolean;
  networkReadable: boolean;
  inspectSatisfiedByLatestScroll: boolean;
  selectableRefs: Set<string>;
  scrollableRefs: Set<string>;
  readonly usedTools: Set<BrowserToolName>;
}

type MaterializedFunctionOutput = Extract<
  MaterializedContinuationItem,
  { readonly type: 'function_call_output' }
>;

interface BrowserToolHistory {
  readonly items: readonly MaterializedContinuationItem[];
  readonly outputRecords: Map<MaterializedFunctionOutput, Readonly<Record<string, unknown>> | null>;
}

export interface BrowserScrollContinuation {
  readonly next: 'inspect' | 'scroll';
  readonly mode: 'distance' | 'traverse';
  readonly tabId: number;
  readonly target: string;
  readonly targetOptions?: readonly string[];
  readonly remainingDeltaX: number;
  readonly remainingDeltaY: number;
  readonly boundaryProbeDeltaX?: number;
  readonly boundaryProbeDeltaY?: number;
  readonly maxSegments: number;
  readonly stopText: string;
}

export interface BrowserToolContract {
  readonly tools: readonly ModelToolDefinition[];
  readonly toolChoice?: ModelToolChoice;
  readonly scrollContinuation?: BrowserScrollContinuation;
}

const MAX_EXPOSED_ASSET_IDS = 8;
const MAX_BOUND_SCROLL_REFS = 32;

export interface BrowserToolState {
  readonly checkpoint: Pick<Checkpoint, 'continuationItems'>;
  readonly toolResults: readonly MaterializedToolResult[];
}

function availableAssetIds(toolResults: readonly MaterializedToolResult[]): readonly string[] {
  const ids = [
    ...new Set(
      toolResults.flatMap((result) =>
        result.toolName.startsWith('browser_') ? [...(result.attachmentIds ?? [])] : [],
      ),
    ),
  ];
  return ids.slice(-MAX_EXPOSED_ASSET_IDS);
}

function bindAvailableAssets(
  definition: ModelToolDefinition,
  assetIds: readonly string[],
): ModelToolDefinition {
  if (definition.name !== 'browser_paste_image' || assetIds.length === 0) return definition;
  const properties = definition.parameters.properties as Readonly<Record<string, unknown>>;
  const assetId = properties.assetId as Readonly<Record<string, unknown>>;
  return {
    ...definition,
    parameters: {
      ...definition.parameters,
      properties: {
        ...properties,
        assetId: { ...assetId, enum: [...assetIds] },
      },
    },
  };
}

function bindScrollableTargets(
  definition: ModelToolDefinition,
  refs: ReadonlySet<string>,
): ModelToolDefinition {
  if (
    definition.name !== 'browser_scroll' ||
    refs.size === 0 ||
    refs.size > MAX_BOUND_SCROLL_REFS
  ) {
    return definition;
  }
  const properties = definition.parameters.properties as Readonly<Record<string, unknown>>;
  const target = properties.target as Readonly<Record<string, unknown>>;
  return {
    ...definition,
    parameters: {
      ...definition.parameters,
      properties: {
        ...properties,
        target: { ...target, enum: [...refs] },
      },
    },
  };
}

function jsonRecord(value: string): Readonly<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}

/** Materializes one checkpoint and parses each stored tool result at most once per model turn. */
function browserToolHistory(state: BrowserToolState): BrowserToolHistory {
  return {
    items: materializeContinuationItems({
      continuationItems: state.checkpoint.continuationItems,
      toolResults: state.toolResults,
    }),
    outputRecords: new Map(),
  };
}

function outputRecord(
  history: BrowserToolHistory,
  output: MaterializedFunctionOutput,
): Readonly<Record<string, unknown>> | null {
  if (history.outputRecords.has(output)) return history.outputRecords.get(output) ?? null;
  const record = jsonRecord(output.output);
  history.outputRecords.set(output, record);
  return record;
}

function successfulOutputRecord(
  history: BrowserToolHistory,
  output: MaterializedFunctionOutput,
): Readonly<Record<string, unknown>> | null {
  const record = outputRecord(history, output);
  return record?.ok === true ? record : null;
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

function isSemanticInspectionMode(value: unknown): boolean {
  return value === 'interactive' || value === 'interactive_deep';
}

function integerContinuationDelta(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.sign(value) * Math.ceil(Math.abs(value));
}

function embeddedInteractiveObservations(
  data: Readonly<Record<string, unknown>> | null,
): readonly Readonly<Record<string, unknown>>[] {
  if (data === null) return [];
  const direct = [childRecord(data, 'verification'), childRecord(data, 'pageVerification')].filter(
    (value): value is Readonly<Record<string, unknown>> => value !== null,
  );
  const segmented = Array.isArray(data.observations)
    ? data.observations.filter(
        (value): value is Readonly<Record<string, unknown>> =>
          typeof value === 'object' && value !== null && !Array.isArray(value),
      )
    : [];
  return [...direct, ...segmented].filter(
    (value) => isSemanticInspectionMode(value.mode) && typeof value.snapshot === 'string',
  );
}

const SCROLL_INVALIDATING_TOOLS = new Set([
  'browser_open_tab',
  'browser_switch_tab',
  'browser_close_tab',
  'browser_navigate',
  'browser_reload',
]);

/** Reconstructs one unfinished virtualized scroll without adding mutable checkpoint state. */
export function browserScrollContinuationForCheckpoint(
  state: BrowserToolState,
): BrowserScrollContinuation | null {
  return browserScrollContinuation(browserToolHistory(state));
}

function browserScrollContinuation(history: BrowserToolHistory): BrowserScrollContinuation | null {
  const calls = new Map<
    string,
    Extract<MaterializedContinuationItem, { readonly type: 'function_call' }>
  >();
  const state: {
    continuation: BrowserScrollContinuation | null;
    continuationFailures: number;
  } = { continuation: null, continuationFailures: 0 };
  for (const item of history.items) {
    if (item.type === 'compaction') {
      calls.clear();
      state.continuation = null;
      state.continuationFailures = 0;
      continue;
    }
    if (item.type === 'function_call') {
      calls.set(item.callId, item);
      continue;
    }
    if (item.type !== 'function_call_output') continue;
    const call = calls.get(item.callId);
    calls.delete(item.callId);
    if (!call) continue;
    const output = successfulOutputRecord(history, item);
    if (SCROLL_INVALIDATING_TOOLS.has(call.name) && output !== null) {
      state.continuation = null;
      state.continuationFailures = 0;
      continue;
    }
    if (call.name === 'browser_inspect' && state.continuation !== null) {
      if (output === null) {
        state.continuation = { ...state.continuation, next: 'inspect' };
      } else if (
        state.continuation.remainingDeltaX !== 0 ||
        state.continuation.remainingDeltaY !== 0 ||
        state.continuation.boundaryProbeDeltaX !== undefined ||
        state.continuation.boundaryProbeDeltaY !== undefined
      ) {
        if (state.continuationFailures >= 2) {
          state.continuation = null;
          state.continuationFailures = 0;
        } else if (state.continuationFailures > 0) {
          const refs = scrollableRefs(childRecord(output, 'data'));
          const target = refs.includes(state.continuation.target)
            ? state.continuation.target
            : refs.length === 1
              ? refs[0]
              : undefined;
          if (target === undefined && state.continuation.mode === 'traverse' && refs.length > 1) {
            state.continuation = {
              ...state.continuation,
              target: refs[0] as string,
              targetOptions: refs,
              next: 'scroll',
            };
          } else if (target === undefined) {
            state.continuation = null;
            state.continuationFailures = 0;
          } else {
            state.continuation = {
              ...state.continuation,
              target,
              next: 'scroll',
            };
          }
        } else {
          state.continuation = {
            ...state.continuation,
            next: 'scroll',
          };
        }
      } else {
        state.continuation = null;
        state.continuationFailures = 0;
      }
      continue;
    }
    if (call.name !== 'browser_scroll') continue;
    if (output === null) {
      if (state.continuation !== null) {
        state.continuationFailures += 1;
        state.continuation = { ...state.continuation, next: 'inspect' };
      }
      continue;
    }
    const data = childRecord(output, 'data');
    if (data?.action === 'scroll' && data.mode === 'traverse') {
      const arguments_ = jsonRecord(call.argumentsJson);
      if (data?.stopReason === 'evidence_budget' || data?.stopReason === 'segment_limit') {
        state.continuation = null;
        state.continuationFailures = 0;
        continue;
      }
      if (
        data?.action !== 'scroll' ||
        data.mode !== 'traverse' ||
        data.continuationRequired !== true ||
        typeof arguments_?.target !== 'string' ||
        typeof arguments_.maxSegments !== 'number' ||
        !Number.isInteger(arguments_.maxSegments) ||
        typeof arguments_.stopText !== 'string'
      ) {
        state.continuation = null;
        state.continuationFailures = 0;
        continue;
      }
      const requestedDeltaX = integerContinuationDelta(arguments_.deltaX);
      const requestedDeltaY = integerContinuationDelta(arguments_.deltaY);
      const nextDeltaX = integerContinuationDelta(data.nextDeltaX) ?? requestedDeltaX;
      const nextDeltaY = integerContinuationDelta(data.nextDeltaY) ?? requestedDeltaY;
      if (
        requestedDeltaX === null ||
        requestedDeltaY === null ||
        nextDeltaX === null ||
        nextDeltaY === null ||
        (nextDeltaX === 0 && nextDeltaY === 0)
      ) {
        state.continuation = null;
        state.continuationFailures = 0;
        continue;
      }
      state.continuationFailures =
        state.continuation?.mode === 'traverse' ? state.continuationFailures + 1 : 1;
      state.continuation = {
        next: 'inspect',
        mode: 'traverse',
        tabId:
          typeof arguments_.tabId === 'number' && Number.isInteger(arguments_.tabId)
            ? arguments_.tabId
            : 0,
        target: arguments_.target,
        remainingDeltaX: nextDeltaX,
        remainingDeltaY: nextDeltaY,
        maxSegments: arguments_.maxSegments,
        stopText: arguments_.stopText,
      };
      continue;
    }
    state.continuationFailures = 0;
    const arguments_ = jsonRecord(call.argumentsJson);
    const remainingDeltaX = integerContinuationDelta(data?.remainingDeltaX);
    const remainingDeltaY = integerContinuationDelta(data?.remainingDeltaY);
    const requestedDeltaX = arguments_?.deltaX;
    const requestedDeltaY = arguments_?.deltaY;
    const needsBoundaryProbe = data?.needsBoundaryProbe === true;
    const hasInteractiveEvidence =
      embeddedInteractiveObservations(data).length > 0 &&
      data?.verificationUnavailable !== true &&
      data?.continuationFailure === undefined;
    const incomplete =
      data?.action === 'scroll' &&
      data.requestedDeltaApplied === false &&
      data.boundaryVerified !== true &&
      remainingDeltaX !== null &&
      remainingDeltaY !== null &&
      (remainingDeltaX !== 0 || remainingDeltaY !== 0) &&
      typeof arguments_?.target === 'string';
    if (data?.action !== 'scroll' || typeof arguments_?.target !== 'string') {
      state.continuation = null;
      continue;
    }
    state.continuation = {
      next: hasInteractiveEvidence ? 'scroll' : 'inspect',
      mode: 'distance',
      tabId:
        typeof arguments_?.tabId === 'number' && Number.isInteger(arguments_.tabId)
          ? arguments_.tabId
          : 0,
      target: arguments_.target as string,
      maxSegments: 1,
      stopText: '',
      remainingDeltaX: incomplete ? (remainingDeltaX ?? 0) : 0,
      remainingDeltaY: incomplete ? (remainingDeltaY ?? 0) : 0,
      ...(needsBoundaryProbe &&
      typeof requestedDeltaX === 'number' &&
      Number.isFinite(requestedDeltaX) &&
      typeof requestedDeltaY === 'number' &&
      Number.isFinite(requestedDeltaY) &&
      (requestedDeltaX !== 0 || requestedDeltaY !== 0)
        ? {
            boundaryProbeDeltaX: requestedDeltaX,
            boundaryProbeDeltaY: requestedDeltaY,
          }
        : {}),
    };
    if (
      hasInteractiveEvidence &&
      state.continuation.remainingDeltaX === 0 &&
      state.continuation.remainingDeltaY === 0 &&
      state.continuation.boundaryProbeDeltaX === undefined &&
      state.continuation.boundaryProbeDeltaY === undefined
    ) {
      state.continuation = null;
    }
  }
  return state.continuation;
}

function refWithAction(value: unknown, action: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entry = value as Readonly<Record<string, unknown>>;
  const actions = Array.isArray(entry.a)
    ? entry.a
    : Array.isArray(entry.actions)
      ? entry.actions
      : [];
  return typeof entry.ref === 'string' && actions.includes(action) ? entry.ref : null;
}

function scrollableRefFromEntry(value: unknown): string | null {
  return refWithAction(value, 'scroll');
}

function scrollableRefs(data: Readonly<Record<string, unknown>> | null): readonly string[] {
  if (data === null || !isSemanticInspectionMode(data.mode)) return [];
  const refs = new Set<string>();
  if (Array.isArray(data.elements)) {
    for (const entry of data.elements) {
      const ref = scrollableRefFromEntry(entry);
      if (ref) refs.add(ref);
    }
  }
  if (Array.isArray(data.upsert)) {
    for (const item of data.upsert) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const ref = scrollableRefFromEntry((item as Readonly<Record<string, unknown>>).e);
      if (ref) refs.add(ref);
    }
  }
  for (const target of coverageScrollTargets(data)) refs.add(target);
  return [...refs];
}

function coverageScrollTargets(data: Readonly<Record<string, unknown>>): readonly string[] {
  const coverage = childRecord(data, 'coverage');
  if (!Array.isArray(coverage?.targets)) return [];
  return coverage.targets.filter(
    (target): target is string =>
      typeof target === 'string' && target.length > 0 && target.length <= 128,
  );
}

function browserToolName(value: string): BrowserToolName | null {
  return Object.hasOwn(BROWSER_TOOL_DEFINITION_BY_NAME, value) ? (value as BrowserToolName) : null;
}

function selectableRefFromEntry(value: unknown): string | null {
  return refWithAction(value, 'set_checked');
}

function applySemanticRefState(
  data: unknown,
  refs: Set<string>,
  refFromEntry: (value: unknown) => string | null,
): void {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
  const record = data as Readonly<Record<string, unknown>>;
  if (isSemanticInspectionMode(record.mode) && Array.isArray(record.elements)) {
    refs.clear();
    for (const entry of record.elements) {
      const ref = refFromEntry(entry);
      if (ref) refs.add(ref);
    }
  }
  if (Array.isArray(record.remove)) {
    for (const identity of record.remove) {
      if (typeof identity === 'string' && identity.startsWith('ref:'))
        refs.delete(identity.slice(4));
    }
  }
  if (Array.isArray(record.upsert)) {
    for (const item of record.upsert) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const value = item as Readonly<Record<string, unknown>>;
      const identity = typeof value.k === 'string' ? value.k : '';
      if (identity.startsWith('ref:')) refs.delete(identity.slice(4));
      const ref = refFromEntry(value.e);
      if (ref) refs.add(ref);
    }
  }
}

function applySuccessfulBrowserResult(
  name: BrowserToolName,
  result: Readonly<Record<string, unknown>>,
  state: CapabilityState,
): void {
  const data =
    typeof result.data === 'object' && result.data !== null && !Array.isArray(result.data)
      ? (result.data as Readonly<Record<string, unknown>>)
      : null;
  state.inspectSatisfiedByLatestScroll = false;
  if (name === 'browser_inspect') {
    state.visualSnapshotCurrent = data?.mode === 'screenshot';
    state.semanticSnapshotCurrent = isSemanticInspectionMode(data?.mode);
    applySemanticRefState(data, state.selectableRefs, selectableRefFromEntry);
    applySemanticRefState(data, state.scrollableRefs, scrollableRefFromEntry);
    if (data !== null) {
      const coverageTargets = coverageScrollTargets(data);
      if (coverageTargets.length > 0) {
        state.scrollableRefs.clear();
        for (const target of coverageTargets) state.scrollableRefs.add(target);
      }
    }
    return;
  }
  if (VISUAL_INVALIDATING_TOOLS.has(name)) {
    state.visualSnapshotCurrent = false;
    state.semanticSnapshotCurrent = false;
  }
  if (
    name === 'browser_navigate' ||
    name === 'browser_reload' ||
    name === 'browser_switch_tab' ||
    name === 'browser_close_tab'
  ) {
    state.selectableRefs.clear();
    state.scrollableRefs.clear();
  }
  if (name === 'browser_network_start') state.networkReadable = true;
  const embeddedObservations = embeddedInteractiveObservations(data);
  state.inspectSatisfiedByLatestScroll =
    name === 'browser_scroll' &&
    data?.mode !== 'traverse' &&
    data?.verificationUnavailable !== true &&
    data?.continuationFailure === undefined &&
    embeddedObservations.length > 0 &&
    embeddedObservations.every((observation) => observation.truncated !== true);
  for (const observation of embeddedObservations) {
    state.semanticSnapshotCurrent = true;
    applySemanticRefState(observation, state.selectableRefs, selectableRefFromEntry);
    applySemanticRefState(observation, state.scrollableRefs, scrollableRefFromEntry);
    const coverageTargets = coverageScrollTargets(observation);
    if (coverageTargets.length > 0) {
      state.scrollableRefs.clear();
      for (const target of coverageTargets) state.scrollableRefs.add(target);
    }
  }
}

function successfulCommit(
  call: MaterializedContinuationItem,
  output: MaterializedFunctionOutput,
  history: BrowserToolHistory,
): boolean {
  return (
    call.type === 'function_call' &&
    call.name === 'commit_context' &&
    successfulOutputRecord(history, output) !== null
  );
}

/** Selects only tools justified by durable state, including calls retained for current replay. */
function availableBrowserToolDefinitions(
  source: BrowserToolState,
  history: BrowserToolHistory,
): readonly ModelToolDefinition[] {
  const state: CapabilityState = {
    semanticSnapshotCurrent: false,
    visualSnapshotCurrent: false,
    networkReadable: false,
    inspectSatisfiedByLatestScroll: false,
    selectableRefs: new Set(),
    scrollableRefs: new Set(),
    usedTools: new Set(),
  };
  const pendingCalls = new Map<
    string,
    Extract<MaterializedContinuationItem, { readonly type: 'function_call' }>
  >();
  for (const item of history.items) {
    if (item.type === 'compaction') {
      state.semanticSnapshotCurrent = false;
      state.visualSnapshotCurrent = false;
      state.networkReadable = false;
      state.inspectSatisfiedByLatestScroll = false;
      state.selectableRefs.clear();
      state.scrollableRefs.clear();
      state.usedTools.clear();
      pendingCalls.clear();
      continue;
    }
    if (item.type === 'function_call') {
      pendingCalls.set(item.callId, item);
      continue;
    }
    if (item.type !== 'function_call_output') continue;
    const call = pendingCalls.get(item.callId);
    pendingCalls.delete(item.callId);
    if (!call) continue;
    if (successfulCommit(call, item, history)) {
      state.semanticSnapshotCurrent = false;
      state.visualSnapshotCurrent = false;
      state.networkReadable = false;
      state.inspectSatisfiedByLatestScroll = false;
      state.selectableRefs.clear();
      state.scrollableRefs.clear();
      state.usedTools.clear();
      continue;
    }
    const name = browserToolName(call.name);
    if (!name) continue;
    state.usedTools.add(name);
    const output = successfulOutputRecord(history, item);
    if (output) {
      applySuccessfulBrowserResult(name, output, state);
      continue;
    }
    state.inspectSatisfiedByLatestScroll = false;
    const failed = outputRecord(history, item);
    for (const observation of embeddedInteractiveObservations(
      failed === null ? null : childRecord(failed, 'data'),
    )) {
      state.semanticSnapshotCurrent = true;
      applySemanticRefState(observation, state.selectableRefs, selectableRefFromEntry);
      applySemanticRefState(observation, state.scrollableRefs, scrollableRefFromEntry);
      const coverageTargets = coverageScrollTargets(observation);
      if (coverageTargets.length > 0) {
        state.scrollableRefs.clear();
        for (const target of coverageTargets) state.scrollableRefs.add(target);
      }
    }
  }

  // Keep semantic action definitions stable across model turns. Their ref preconditions remain
  // executor-enforced; dynamically introducing them after inspection can leave the model anchored
  // to the smaller first-turn tool set and make it incorrectly report that a declared tool is absent.
  const enabled = new Set<BrowserToolName>([
    ...DISCOVERY_TOOL_NAMES,
    ...INTERACTIVE_TOOL_NAMES,
    ...state.usedTools,
  ]);
  // A successful scroll already returns the latest interactive state. Suppress one immediately
  // redundant inspection, while preserving it whenever evidence was unavailable or truncated.
  if (state.inspectSatisfiedByLatestScroll) enabled.delete('browser_inspect');
  if (state.visualSnapshotCurrent) {
    enabled.add('browser_click_point');
    enabled.add('browser_drag_point');
  }
  if (state.networkReadable) {
    enabled.add('browser_network_list');
    enabled.add('browser_network_get');
    enabled.add('browser_network_stop');
  }
  if (state.selectableRefs.size >= 2) enabled.add('browser_set_checked_many');

  const assetIds = availableAssetIds(source.toolResults);
  if (assetIds.length > 0) enabled.add('browser_paste_image');
  return BROWSER_TOOL_DEFINITIONS.filter(({ name }) => enabled.has(name as BrowserToolName)).map(
    (definition) =>
      bindScrollableTargets(bindAvailableAssets(definition, assetIds), state.scrollableRefs),
  );
}

function constrainedContinuationDefinition(
  continuation: BrowserScrollContinuation,
): ModelToolDefinition {
  const name = continuation.next === 'inspect' ? 'browser_inspect' : 'browser_scroll';
  const definition = BROWSER_TOOL_DEFINITION_BY_NAME[name];
  const properties = definition.parameters.properties as Readonly<Record<string, unknown>>;
  const hasRemainingDistance =
    continuation.remainingDeltaX !== 0 || continuation.remainingDeltaY !== 0;
  const requiresBoundaryProbe =
    continuation.boundaryProbeDeltaX !== undefined ||
    continuation.boundaryProbeDeltaY !== undefined;
  const nextDeltaX = hasRemainingDistance
    ? continuation.remainingDeltaX
    : (continuation.boundaryProbeDeltaX ?? 0);
  const nextDeltaY = hasRemainingDistance
    ? continuation.remainingDeltaY
    : (continuation.boundaryProbeDeltaY ?? 0);
  return {
    ...definition,
    description:
      continuation.next === 'inspect'
        ? continuation.mode === 'traverse'
          ? 'A bounded traversal still requires more evidence, but its latest page state was unavailable or made no reliable progress. Inspect one fresh full interactive state, then resume the same traversal before any final answer.'
          : hasRemainingDistance
            ? 'A virtualized scroll still has unconsumed distance. Inspect the newly exposed interactive batch before any further scrolling or final answer.'
            : requiresBoundaryProbe
              ? 'The scroll only just reached an apparent boundary. Inspect the exposed batch, then verify the boundary with one same-direction probe before any final answer.'
              : 'The page was scrolled. Inspect the resulting interactive state before any further action or final answer.'
        : continuation.mode === 'traverse'
          ? continuation.targetOptions !== undefined
            ? 'Continue the same unfinished bounded traversal. Choose the semantically matching target from the fresh schema-constrained refs, preserve its direction, stop marker, and segment bound, and do not finish while continuation is required.'
            : 'Continue the same unfinished bounded traversal. Preserve its direction, stop marker, and segment bound; do not switch strategy or finish while continuation is required.'
          : requiresBoundaryProbe && !hasRemainingDistance
            ? 'Verify the apparent boundary with one same-direction scroll probe. Use the schema-constrained distance and current scrollable ref; do not finish yet.'
            : 'Continue the unfinished virtualized scroll after reading the exposed batch. Use the schema-constrained distance and the current scrollable ref; do not finish yet.',
    parameters: {
      ...definition.parameters,
      properties: {
        ...properties,
        tabId: {
          ...(properties.tabId as Readonly<Record<string, unknown>>),
          enum: [continuation.tabId],
        },
        ...(continuation.next === 'inspect'
          ? {
              mode: {
                ...(properties.mode as Readonly<Record<string, unknown>>),
                enum: ['interactive'],
              },
              since: {
                ...(properties.since as Readonly<Record<string, unknown>>),
                enum: [''],
              },
            }
          : {
              target: {
                ...(properties.target as Readonly<Record<string, unknown>>),
                enum: continuation.targetOptions ?? [continuation.target],
              },
              deltaX: {
                ...(properties.deltaX as Readonly<Record<string, unknown>>),
                enum: [nextDeltaX],
              },
              deltaY: {
                ...(properties.deltaY as Readonly<Record<string, unknown>>),
                enum: [nextDeltaY],
              },
              maxSegments: {
                ...(properties.maxSegments as Readonly<Record<string, unknown>>),
                enum: [continuation.maxSegments],
              },
              stopText: {
                ...(properties.stopText as Readonly<Record<string, unknown>>),
                enum: [continuation.stopText],
              },
            }),
      },
    },
  };
}

/** Preserves unconsumed virtualized distance and forces only genuinely missing evidence. */
export function browserToolContractForCheckpoint(state: BrowserToolState): BrowserToolContract {
  const history = browserToolHistory(state);
  const scrollContinuation = browserScrollContinuation(history);
  if (scrollContinuation !== null) {
    const name = scrollContinuation.next === 'inspect' ? 'browser_inspect' : 'browser_scroll';
    return {
      tools: [constrainedContinuationDefinition(scrollContinuation)],
      toolChoice: { type: 'function', name },
      scrollContinuation,
    };
  }
  return { tools: availableBrowserToolDefinitions(state, history) };
}

export function browserToolDefinitionsForCheckpoint(
  state: BrowserToolState,
): readonly ModelToolDefinition[] {
  return browserToolContractForCheckpoint(state).tools;
}
