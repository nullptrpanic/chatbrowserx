import type { ParsedBrowserToolCall } from '../agent/tools/browser-tool-schema';
import type {
  BrowserExecutionContext,
  BrowserExecutionPort,
  BrowserSessionLifecyclePort,
  BrowserToolExecutionResult,
  BrowserToolFailure,
  BrowserToolFailureCode,
} from './browser-execution-types';
import { BrowserTabError, type BrowserTabPort, type BrowserTabState } from './tab-service';
import type { PageInspectionOptions, PageObservationResult } from './observation/page-observer';
import type { BrowserActionPort } from './actions/browser-action-executor';
import type { NetworkCapturePort } from './network/network-capture-registry';
import { readSelectionState } from './selection-state';

const MAX_OUTPUT_CHARACTERS = 100 * 1_024;
const RELOAD_RECOVERY_FAILURES = new Set<BrowserToolFailureCode>([
  'LOAD_TIMEOUT',
  'PAGE_UNAVAILABLE',
  'INVALID_PAGE_RESPONSE',
  'BROWSER_OPERATION_FAILED',
]);
const TASK_SCOPED_OPERATIONS = new Set<ParsedBrowserToolCall['operation']>([
  'navigate',
  'reload',
  'inspect',
  'capture_screenshot',
  'paste_image',
  'click',
  'set_checked',
  'set_checked_many',
  'type',
  'keypress',
  'scroll',
  'hover',
  'select',
  'drag',
  'wait',
  'click_point',
  'drag_point',
  'network_start',
  'network_list',
  'network_get',
  'network_stop',
]);

interface ReloadRecoveryState {
  readonly operation: ParsedBrowserToolCall['operation'];
  readonly code: BrowserToolFailureCode;
  readonly reloadAttempted: boolean;
}

export interface BrowserToolExecutorDependencies {
  readonly tabs: BrowserTabPort;
  readonly observer?: {
    inspect(
      tabId: number,
      mode: 'content' | 'interactive' | 'interactive_deep' | 'screenshot',
      signal: AbortSignal,
      options?: PageInspectionOptions,
    ): Promise<PageObservationResult>;
    capture?(tabId: number, signal: AbortSignal): Promise<PageObservationResult>;
    invalidateInteractiveSnapshots?(): void;
  };
  readonly actions?: BrowserActionPort;
  readonly network?: NetworkCapturePort;
  readonly sessions?: BrowserSessionLifecyclePort;
}

function failure(
  code: BrowserToolFailureCode,
  message: string,
  retryable: boolean,
  needsInspect: boolean,
  stage?: BrowserToolFailure['stage'],
): BrowserToolFailure {
  return {
    ok: false,
    code,
    message,
    retryable,
    needsInspect,
    ...(stage ? { stage } : {}),
  };
}

const BROWSER_ACTION_FAILURE_STAGES = new Set<NonNullable<BrowserToolFailure['stage']>>([
  'focus',
  'insert',
  'readback',
  'submit',
]);

function browserActionFailureStage(error: unknown): BrowserToolFailure['stage'] {
  if (typeof error !== 'object' || error === null) return undefined;
  if (
    'stage' in error &&
    typeof error.stage === 'string' &&
    BROWSER_ACTION_FAILURE_STAGES.has(error.stage as NonNullable<BrowserToolFailure['stage']>)
  ) {
    return error.stage as NonNullable<BrowserToolFailure['stage']>;
  }
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  if (message === 'The focused editor could not receive the requested text.') return 'insert';
  if (
    message === 'The focused editable value did not contain the requested input.' ||
    message === 'The target did not retain the requested text.'
  ) {
    return 'readback';
  }
  return undefined;
}

function failureFor(error: unknown): BrowserToolFailure {
  const code =
    error instanceof BrowserTabError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string')
      ? String(error.code)
      : 'BROWSER_OPERATION_FAILED';
  switch (code) {
    case 'INVALID_TAB':
      return failure('INVALID_TAB', 'The browser tab ID is invalid.', false, false);
    case 'ASSET_NOT_AVAILABLE':
      return failure(
        'ASSET_NOT_AVAILABLE',
        'This image asset is not available in the current WorkSession.',
        false,
        false,
      );
    case 'ATTACHMENT_VERIFICATION_FAILED':
      return failure(
        'ATTACHMENT_VERIFICATION_FAILED',
        'The editor handled the image paste, but an attachment preview could not be verified. Do not paste the same asset again; inspect the current page.',
        false,
        true,
      );
    case 'TAB_NOT_FOUND':
      return failure('TAB_NOT_FOUND', 'The browser tab no longer exists.', true, true);
    case 'TAB_NOT_CONTROLLABLE':
      return failure(
        'TAB_NOT_CONTROLLABLE',
        'This browser tab cannot be controlled.',
        false,
        false,
      );
    case 'URL_NOT_ALLOWED':
      return failure('URL_NOT_ALLOWED', 'This browser URL cannot be controlled.', false, false);
    case 'LOAD_TIMEOUT':
      return failure('LOAD_TIMEOUT', 'The page did not become ready in time.', true, true);
    case 'PAGE_UNAVAILABLE':
      return failure(
        'PAGE_UNAVAILABLE',
        'The page content bridge is unavailable. Continue with mode interactive; do not reload solely for this error.',
        false,
        true,
      );
    case 'INVALID_PAGE_RESPONSE':
      return failure(
        'INVALID_PAGE_RESPONSE',
        'The page content bridge returned an invalid response. Continue with mode interactive; do not reload solely for this error.',
        false,
        true,
      );
    case 'NETWORK_CAPTURE_LOST':
      return failure(
        'NETWORK_CAPTURE_LOST',
        'Network capture was lost. Start capture again.',
        true,
        false,
      );
    case 'NETWORK_REQUEST_NOT_FOUND':
      return failure(
        'NETWORK_REQUEST_NOT_FOUND',
        'The captured network request is no longer available.',
        false,
        false,
      );
    case 'REF_NOT_FOUND':
    case 'REF_SCOPE_MISMATCH':
    case 'STALE_REF':
    case 'AMBIGUOUS_TARGET':
      return failure(
        'STALE_REF',
        'The element reference is stale. Inspect interactive elements again.',
        true,
        true,
      );
    case 'POINT_OUT_OF_VIEWPORT':
      return failure(
        'POINT_OUT_OF_VIEWPORT',
        'The point is outside the current viewport. Take a new screenshot.',
        true,
        true,
      );
    case 'STALE_SCREENSHOT':
      return failure(
        'STALE_SCREENSHOT',
        'The screenshot no longer represents the current page state. Take a new screenshot before using coordinates.',
        true,
        true,
      );
    case 'TYPE_VERIFICATION_FAILED':
      return failure(
        'TYPE_VERIFICATION_FAILED',
        'The page did not retain the requested text. Inspect the editor and try again.',
        true,
        true,
        browserActionFailureStage(error),
      );
    case 'ACTION_STATE_MISMATCH':
      return failure(
        'ACTION_STATE_MISMATCH',
        'The page did not retain the requested selection. Inspect fresh refs before another action.',
        false,
        true,
      );
    case 'ACTION_STATE_UNAVAILABLE':
      return failure(
        'ACTION_STATE_UNAVAILABLE',
        'The browser could not measure the requested state. Inspect fresh refs before another action.',
        true,
        true,
      );
    case 'ACTION_TARGET_OBSCURED':
      return failure(
        'ACTION_TARGET_OBSCURED',
        'The target is covered by another element. Inspect the page before retrying.',
        true,
        true,
      );
    case 'WAIT_TIMEOUT':
      return failure(
        'WAIT_TIMEOUT',
        'The page did not reach the requested condition in time.',
        true,
        true,
      );
    case 'DEBUGGER_UNAVAILABLE':
      return failure(
        'DEBUGGER_UNAVAILABLE',
        'The browser debugger is unavailable for this tab.',
        true,
        false,
      );
    case 'HISTORY_UNAVAILABLE':
      return failure(
        'HISTORY_UNAVAILABLE',
        'The requested browser history entry is unavailable.',
        false,
        true,
      );
    case 'UNSUPPORTED_ACTION':
      return failure(
        'UNSUPPORTED_ACTION',
        'This browser action is unsupported for the selected target.',
        false,
        true,
      );
    case 'SELECTABLE_ACTION_REQUIRED':
      return failure(
        'SELECTABLE_ACTION_REQUIRED',
        'This ref advertises set_checked; use browser_set_checked instead of browser_click.',
        true,
        false,
      );
    default:
      return failure(
        'BROWSER_OPERATION_FAILED',
        'The browser operation could not be completed.',
        true,
        true,
      );
  }
}

function success(tab: BrowserTabState, data: Readonly<Record<string, unknown>>) {
  return {
    ok: true as const,
    tabId: tab.tabId,
    url: tab.url,
    data,
    observation: null,
  };
}

function result(
  _operation: ParsedBrowserToolCall['operation'],
  output: unknown,
  attachmentIds: readonly string[] = [],
  modelAttachmentIds?: readonly string[],
): BrowserToolExecutionResult {
  const serialized = JSON.stringify(output);
  if (serialized.length <= MAX_OUTPUT_CHARACTERS) {
    return {
      output: serialized,
      attachmentIds,
      ...(modelAttachmentIds === undefined ? {} : { modelAttachmentIds }),
    };
  }
  return {
    output: JSON.stringify(
      failure(
        'RESULT_TOO_LARGE',
        'The browser result was too large. Narrow the request and try again.',
        true,
        false,
      ),
    ),
    attachmentIds: [],
  };
}

function browserFailure(value: unknown): BrowserToolFailure | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('ok' in value) ||
    value.ok !== false ||
    !('code' in value) ||
    typeof value.code !== 'string'
  ) {
    return null;
  }
  return value as BrowserToolFailure;
}

function hasSelectableRef(data: Readonly<Record<string, unknown>>): boolean {
  if (!Array.isArray(data.elements)) return false;
  return data.elements.some((element) => {
    if (typeof element !== 'object' || element === null) return false;
    const value = element as {
      readonly ref?: unknown;
      readonly a?: unknown;
      readonly actions?: unknown;
    };
    const actions = Array.isArray(value.a)
      ? value.a
      : Array.isArray(value.actions)
        ? value.actions
        : [];
    return typeof value.ref === 'string' && value.ref.length > 0 && actions.includes('set_checked');
  });
}

function interactiveSnapshotId(data: Readonly<Record<string, unknown>>): string | null {
  return typeof data.snapshot === 'string' && data.snapshot.length > 0 ? data.snapshot : null;
}

interface SelectableRefIdentity {
  readonly semanticKey: string;
  readonly selected: boolean | undefined;
}

function selectableRefs(
  data: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, SelectableRefIdentity> | null {
  if (!Array.isArray(data.elements)) return null;
  const candidates: Array<{
    readonly ref: string;
    readonly semanticKey: string;
    readonly selected: boolean | undefined;
  }> = [];
  const counts = new Map<string, number>();
  for (const element of data.elements) {
    if (typeof element !== 'object' || element === null) continue;
    const value = element as {
      readonly ref?: unknown;
      readonly r?: unknown;
      readonly n?: unknown;
      readonly s?: unknown;
      readonly a?: unknown;
      readonly actions?: unknown;
    };
    const actions = Array.isArray(value.a)
      ? value.a
      : Array.isArray(value.actions)
        ? value.actions
        : [];
    if (
      typeof value.ref !== 'string' ||
      value.ref.length === 0 ||
      typeof value.n !== 'string' ||
      value.n.length === 0 ||
      !actions.includes('set_checked')
    ) {
      continue;
    }
    const semanticKey = JSON.stringify([
      typeof value.r === 'string' ? value.r : 'generic',
      value.n,
    ]);
    candidates.push({
      ref: value.ref,
      semanticKey,
      selected: readSelectionState(value.s),
    });
    counts.set(semanticKey, (counts.get(semanticKey) ?? 0) + 1);
  }
  return new Map(
    candidates
      .filter(({ semanticKey }) => counts.get(semanticKey) === 1)
      .map(({ ref, semanticKey, selected }) => [ref, { semanticKey, selected }]),
  );
}

function semanticStructure(data: Readonly<Record<string, unknown>>): string | null {
  if (!Array.isArray(data.elements)) return null;
  return JSON.stringify(
    data.elements.map((element) => {
      if (typeof element !== 'object' || element === null) return null;
      const value = element as {
        readonly d?: unknown;
        readonly r?: unknown;
        readonly n?: unknown;
        readonly a?: unknown;
        readonly actions?: unknown;
        readonly f?: unknown;
      };
      return [
        typeof value.d === 'number' ? value.d : null,
        typeof value.r === 'string' ? value.r : 'generic',
        typeof value.n === 'string' ? value.n : '',
        Array.isArray(value.a) ? value.a : Array.isArray(value.actions) ? value.actions : [],
        typeof value.f === 'string' ? value.f : null,
      ];
    }),
  );
}

function tabId(arguments_: unknown): number {
  return (arguments_ as { readonly tabId: number }).tabId;
}

interface TaskTargetResolution {
  readonly tabId: number | null;
  readonly failure: BrowserToolFailure | null;
}

interface ScreenshotCoordinateScale {
  readonly x: number;
  readonly y: number;
}

function screenshotCoordinateScale(
  data: Readonly<Record<string, unknown>>,
): ScreenshotCoordinateScale | null {
  const width = data.width;
  const height = data.height;
  const viewportWidth = data.viewportWidth;
  const viewportHeight = data.viewportHeight;
  if (
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    height <= 0 ||
    typeof viewportWidth !== 'number' ||
    !Number.isFinite(viewportWidth) ||
    viewportWidth <= 0 ||
    typeof viewportHeight !== 'number' ||
    !Number.isFinite(viewportHeight) ||
    viewportHeight <= 0
  ) {
    return null;
  }
  return { x: viewportWidth / width, y: viewportHeight / height };
}

function mapScreenshotCoordinates(
  call: ParsedBrowserToolCall,
  scale: ScreenshotCoordinateScale | undefined,
): ParsedBrowserToolCall {
  if (scale === undefined) return call;
  if (call.operation === 'drag_point') {
    const input = call.arguments as {
      readonly fromX: number;
      readonly fromY: number;
      readonly toX: number;
      readonly toY: number;
    };
    return {
      ...call,
      arguments: {
        ...(call.arguments as Readonly<Record<string, unknown>>),
        fromX: input.fromX * scale.x,
        fromY: input.fromY * scale.y,
        toX: input.toX * scale.x,
        toY: input.toY * scale.y,
      } as ParsedBrowserToolCall['arguments'],
    };
  }
  if (call.operation !== 'click_point') return call;
  const input = call.arguments as { readonly x: number; readonly y: number };
  return {
    ...call,
    arguments: {
      ...(call.arguments as Readonly<Record<string, unknown>>),
      x: input.x * scale.x,
      y: input.y * scale.y,
    } as ParsedBrowserToolCall['arguments'],
  };
}

/** Resolves zero and legacy omissions from the durable target, or selects a background tab. */
function resolveTaskTarget(
  call: ParsedBrowserToolCall,
  context: BrowserExecutionContext | undefined,
): TaskTargetResolution {
  if (!TASK_SCOPED_OPERATIONS.has(call.operation)) return { tabId: null, failure: null };
  const explicitTabId = (call.arguments as { readonly tabId?: number }).tabId;
  if (explicitTabId !== undefined && explicitTabId !== 0) {
    return { tabId: explicitTabId, failure: null };
  }
  if (context?.currentTabId === undefined || context.currentTabId === null) {
    return {
      tabId: null,
      failure: failure(
        'CURRENT_TAB_UNAVAILABLE',
        'This task has no current browser tab. List tabs and switch to one before continuing.',
        false,
        false,
      ),
    };
  }
  return { tabId: context.currentTabId, failure: null };
}

/** Adds the trusted target only to the internal action call, never to model-owned arguments. */
function bindTaskTarget(call: ParsedBrowserToolCall, targetTabId: number): ParsedBrowserToolCall {
  return {
    ...call,
    arguments: {
      ...(call.arguments as Readonly<Record<string, unknown>>),
      tabId: targetTabId,
    },
  };
}

function requiredTaskTabId(resolution: TaskTargetResolution): number {
  if (resolution.tabId === null) throw new Error('Task-scoped browser target is unavailable.');
  return resolution.tabId;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Browser operation was aborted.', 'AbortError');
}

/** Dispatches validated browser calls and always returns a bounded, normalized result. */
export class BrowserToolExecutor implements BrowserExecutionPort {
  readonly #dependencies: BrowserToolExecutorDependencies;
  readonly #retainedTabsByRunner = new Map<string, Set<number>>();
  readonly #screenshotScales = new Map<number, ScreenshotCoordinateScale>();
  readonly #visualFallbackByTab = new Map<number, boolean>();
  readonly #stateMismatchFallbackByTab = new Set<number>();
  readonly #interactiveSnapshotByTab = new Map<number, string>();
  readonly #selectableRefsByTab = new Map<number, ReadonlyMap<string, SelectableRefIdentity>>();
  readonly #semanticStructureByTab = new Map<number, string>();
  readonly #failedSelectionsByTab = new Map<number, Map<string, boolean>>();
  readonly #reloadRecoveryByTab = new Map<number, ReloadRecoveryState>();

  constructor(dependencies: BrowserToolExecutorDependencies) {
    this.#dependencies = dependencies;
  }

  resetObservationBaselines(): void {
    this.#screenshotScales.clear();
    this.#visualFallbackByTab.clear();
    this.#stateMismatchFallbackByTab.clear();
    this.#interactiveSnapshotByTab.clear();
    this.#selectableRefsByTab.clear();
    this.#semanticStructureByTab.clear();
    this.#failedSelectionsByTab.clear();
    this.#dependencies.observer?.invalidateInteractiveSnapshots?.();
  }

  async release(sessionOwnerId: string): Promise<void> {
    this.#screenshotScales.clear();
    this.#visualFallbackByTab.clear();
    this.#stateMismatchFallbackByTab.clear();
    this.#interactiveSnapshotByTab.clear();
    this.#selectableRefsByTab.clear();
    this.#semanticStructureByTab.clear();
    this.#failedSelectionsByTab.clear();
    this.#reloadRecoveryByTab.clear();
    const sessions = this.#dependencies.sessions;
    if (!sessions) return;
    this.#retainedTabsByRunner.delete(sessionOwnerId);
    await sessions.releaseOwner(sessionOwnerId);
  }

  async execute(
    call: ParsedBrowserToolCall,
    signal: AbortSignal,
    context?: BrowserExecutionContext,
  ): Promise<BrowserToolExecutionResult> {
    throwIfAborted(signal);
    let recoveryTabId: number | null = null;
    try {
      const taskTarget = resolveTaskTarget(call, context);
      if (taskTarget.failure !== null) return result(call.operation, taskTarget.failure);
      recoveryTabId = taskTarget.tabId;
      let output: unknown;
      let attachmentIds: readonly string[] = [];
      let modelAttachmentIds: readonly string[] | undefined;
      switch (call.operation) {
        case 'get_current_tab': {
          if (context?.currentTabId === undefined || context.currentTabId === null) {
            output = failure(
              'CURRENT_TAB_UNAVAILABLE',
              'This task has no current browser tab. List tabs and switch to one before continuing.',
              false,
              false,
            );
            break;
          }
          const tab = await this.#dependencies.tabs.get(context.currentTabId);
          output = success(tab, {
            title: tab.title,
            active: tab.active,
            taskBound: true,
          });
          break;
        }
        case 'list_tabs': {
          const tabs = await this.#dependencies.tabs.list();
          output = {
            ok: true,
            tabId: null,
            url: null,
            data: { tabs },
            observation: null,
          };
          break;
        }
        case 'open_tab': {
          const input = call.arguments as {
            readonly url: string;
            readonly activate: boolean;
          };
          const tab = await this.#dependencies.tabs.open(input.url, input.activate);
          output = success(tab, { title: tab.title, active: tab.active });
          break;
        }
        case 'switch_tab': {
          const tab = await this.#dependencies.tabs.get(tabId(call.arguments));
          output = success(tab, { title: tab.title, active: tab.active });
          break;
        }
        case 'close_tab': {
          const targetTabId = tabId(call.arguments);
          await this.#dependencies.tabs.close(targetTabId);
          this.#screenshotScales.delete(targetTabId);
          this.#visualFallbackByTab.delete(targetTabId);
          this.#stateMismatchFallbackByTab.delete(targetTabId);
          this.#interactiveSnapshotByTab.delete(targetTabId);
          this.#selectableRefsByTab.delete(targetTabId);
          this.#semanticStructureByTab.delete(targetTabId);
          this.#failedSelectionsByTab.delete(targetTabId);
          this.#reloadRecoveryByTab.delete(targetTabId);
          output = {
            ok: true,
            tabId: targetTabId,
            url: null,
            data: { closed: true },
            observation: null,
          };
          break;
        }
        case 'navigate': {
          const input = call.arguments as { readonly url: string };
          const targetTabId = requiredTaskTabId(taskTarget);
          const tab = await this.#dependencies.tabs.navigate(targetTabId, input.url);
          this.#screenshotScales.delete(targetTabId);
          this.#visualFallbackByTab.delete(targetTabId);
          this.#stateMismatchFallbackByTab.delete(targetTabId);
          this.#interactiveSnapshotByTab.delete(targetTabId);
          this.#selectableRefsByTab.delete(targetTabId);
          this.#semanticStructureByTab.delete(targetTabId);
          this.#failedSelectionsByTab.delete(targetTabId);
          output = success(tab, { title: tab.title, active: tab.active });
          break;
        }
        case 'reload': {
          const targetTabId = requiredTaskTabId(taskTarget);
          const recovery = this.#reloadRecoveryByTab.get(targetTabId);
          if (recovery?.reloadAttempted) {
            output = failure(
              'REPEATED_RECOVERY_BLOCKED',
              'Reload already failed to recover this browser error. Continue with another inspection or action strategy.',
              false,
              true,
            );
            break;
          }
          const tab = await this.#dependencies.tabs.reload(targetTabId);
          this.#screenshotScales.delete(targetTabId);
          this.#visualFallbackByTab.delete(targetTabId);
          this.#stateMismatchFallbackByTab.delete(targetTabId);
          this.#interactiveSnapshotByTab.delete(targetTabId);
          this.#selectableRefsByTab.delete(targetTabId);
          this.#semanticStructureByTab.delete(targetTabId);
          this.#failedSelectionsByTab.delete(targetTabId);
          if (recovery) {
            this.#reloadRecoveryByTab.set(targetTabId, {
              ...recovery,
              reloadAttempted: true,
            });
          }
          output = success(tab, {
            title: tab.title,
            active: tab.active,
            reloaded: true,
          });
          break;
        }
        case 'inspect': {
          if (!this.#dependencies.observer) {
            output = failure(
              'OPERATION_UNAVAILABLE',
              'This browser operation is not connected yet.',
              false,
              false,
            );
            break;
          }
          const input = call.arguments as {
            readonly mode: 'content' | 'interactive' | 'interactive_deep' | 'screenshot';
            readonly since?: string;
          };
          const targetTabId = requiredTaskTabId(taskTarget);
          if (input.mode !== 'screenshot') this.#screenshotScales.delete(targetTabId);
          if (input.mode === 'screenshot') {
            const allowed = this.#visualFallbackByTab.get(targetTabId);
            const mismatchFallback = this.#stateMismatchFallbackByTab.has(targetTabId);
            if (allowed === undefined && !mismatchFallback) {
              output = failure(
                'INTERACTIVE_INSPECTION_REQUIRED',
                'Inspect the page with mode interactive before requesting a screenshot.',
                true,
                true,
              );
              break;
            }
            if (!allowed && !mismatchFallback) {
              output = failure(
                'SEMANTIC_INSPECTION_AVAILABLE',
                'The current accessibility tree already contains sufficient semantic targets. Continue with refs and verify state with mode interactive.',
                false,
                false,
              );
              break;
            }
          }
          if (input.mode !== 'content') {
            await this.#retainRunner(targetTabId, context?.sessionOwnerId);
          }
          const observed: PageObservationResult =
            input.since === undefined
              ? await this.#dependencies.observer.inspect(targetTabId, input.mode, signal)
              : await this.#dependencies.observer.inspect(targetTabId, input.mode, signal, {
                  since: input.since,
                });
          if (input.mode === 'interactive' || input.mode === 'interactive_deep') {
            this.#rememberSelectableRefs(targetTabId, observed.data);
            const snapshotId = interactiveSnapshotId(observed.data);
            if (snapshotId === null) this.#interactiveSnapshotByTab.delete(targetTabId);
            else this.#interactiveSnapshotByTab.set(targetTabId, snapshotId);
            this.#visualFallbackByTab.set(
              targetTabId,
              observed.visualFallbackAllowed ?? this.#fallbackFromElements(observed.data),
            );
            if (hasSelectableRef(observed.data)) {
              this.#stateMismatchFallbackByTab.delete(targetTabId);
            }
          }
          if (input.mode === 'screenshot') {
            const scale = screenshotCoordinateScale(observed.data);
            if (scale === null) this.#screenshotScales.delete(targetTabId);
            else this.#screenshotScales.set(targetTabId, scale);
            this.#stateMismatchFallbackByTab.delete(targetTabId);
          }
          output = {
            ok: true,
            tabId: observed.tabId,
            url: observed.url,
            data: observed.data,
            observation: observed.observation,
          };
          attachmentIds = observed.attachmentIds;
          break;
        }
        case 'capture_screenshot': {
          const capture = this.#dependencies.observer?.capture;
          if (!capture) {
            output = failure(
              'OPERATION_UNAVAILABLE',
              'This browser operation is not connected yet.',
              false,
              false,
            );
            break;
          }
          const targetTabId = requiredTaskTabId(taskTarget);
          await this.#retainRunner(targetTabId, context?.sessionOwnerId);
          const observed = await capture.call(this.#dependencies.observer, targetTabId, signal);
          const attachmentId =
            typeof observed.data.attachmentId === 'string'
              ? observed.data.attachmentId
              : observed.attachmentIds[0];
          if (!attachmentId || !observed.attachmentIds.includes(attachmentId)) {
            throw new Error('Screenshot capture returned no durable asset.');
          }
          output = {
            ok: true,
            tabId: observed.tabId,
            url: observed.url,
            data: {
              mimeType: observed.data.mimeType,
              width: observed.data.width,
              height: observed.data.height,
              assetId: attachmentId,
            },
            observation: null,
          };
          attachmentIds = observed.attachmentIds;
          modelAttachmentIds = [];
          break;
        }
        case 'click':
        case 'set_checked':
        case 'set_checked_many':
        case 'paste_image':
        case 'type':
        case 'keypress':
        case 'scroll':
        case 'hover':
        case 'select':
        case 'drag':
        case 'wait':
        case 'click_point':
        case 'drag_point': {
          if (!this.#dependencies.actions) {
            output = failure(
              'OPERATION_UNAVAILABLE',
              'This browser operation is not connected yet.',
              false,
              false,
            );
            break;
          }
          if (call.operation === 'paste_image') {
            const { assetId } = call.arguments as { readonly assetId: string };
            if (!context?.availableAssetIds?.includes(assetId)) {
              output = failure(
                'ASSET_NOT_AVAILABLE',
                'This image asset is not available in the current WorkSession.',
                false,
                false,
              );
              break;
            }
          }
          const targetTabId = requiredTaskTabId(taskTarget);
          if (this.#isDuplicateFailedSelection(call, targetTabId)) {
            output = failure(
              'DUPLICATE_FAILED_ACTION',
              'The same selection already failed on this unchanged page state. Use another target or action strategy.',
              false,
              true,
            );
            break;
          }
          const screenshotScale = this.#screenshotScales.get(targetTabId);
          const coordinateAction =
            call.operation === 'click_point' || call.operation === 'drag_point';
          if (coordinateAction && screenshotScale === undefined) {
            output = failure(
              'STALE_SCREENSHOT',
              'The screenshot no longer represents the current page state. Take a new screenshot before using coordinates.',
              true,
              true,
            );
            break;
          }
          const boundCall = bindTaskTarget(
            mapScreenshotCoordinates(call, screenshotScale),
            targetTabId,
          );
          this.#screenshotScales.delete(targetTabId);
          await this.#retainRunner(targetTabId, context?.sessionOwnerId);
          const action = await this.#dependencies.actions.execute(boundCall, signal);
          if (action.failure !== undefined) {
            const normalized = failureFor(action.failure);
            if (normalized.code === 'ACTION_STATE_MISMATCH') {
              this.#stateMismatchFallbackByTab.add(targetTabId);
            }
            output = {
              ...normalized,
              tabId: action.tabId,
              url: action.url,
              data: action.data,
              observation: action.observation,
            };
            break;
          }
          this.#clearFailedSelection(call, targetTabId);
          this.#stateMismatchFallbackByTab.delete(targetTabId);
          let verification: Readonly<Record<string, unknown>> | undefined;
          let verificationUnavailable = false;
          const baseSnapshot = this.#interactiveSnapshotByTab.get(targetTabId);
          if (
            call.operation === 'click_point' &&
            baseSnapshot !== undefined &&
            this.#dependencies.observer
          ) {
            verification =
              (await this.#observeAfterAction(
                targetTabId,
                baseSnapshot,
                signal,
                context?.sessionOwnerId,
              )) ?? undefined;
            verificationUnavailable = verification === undefined;
          }
          output = {
            ok: true,
            tabId: action.tabId,
            url: action.url,
            data: {
              ...action.data,
              ...(verification === undefined ? {} : { verification }),
              ...(verificationUnavailable ? { verificationUnavailable: true } : {}),
            },
            observation: action.observation,
          };
          break;
        }
        case 'network_start': {
          if (!this.#dependencies.network) {
            output = failure(
              'OPERATION_UNAVAILABLE',
              'This browser operation is not connected yet.',
              false,
              false,
            );
            break;
          }
          const targetTabId = requiredTaskTabId(taskTarget);
          await this.#retainRunner(targetTabId, context?.sessionOwnerId);
          const started = await this.#dependencies.network.start(targetTabId, signal);
          output = {
            ok: true,
            tabId: targetTabId,
            url: null,
            data: started,
            observation: null,
          };
          break;
        }
        case 'network_list': {
          if (!this.#dependencies.network) {
            output = failure(
              'OPERATION_UNAVAILABLE',
              'This browser operation is not connected yet.',
              false,
              false,
            );
            break;
          }
          const input = call.arguments as {
            readonly urlPattern: string;
            readonly limit: number;
          };
          const targetTabId = requiredTaskTabId(taskTarget);
          const requests = await this.#dependencies.network.list(
            targetTabId,
            input.urlPattern,
            input.limit,
          );
          output = {
            ok: true,
            tabId: targetTabId,
            url: null,
            data: { requests },
            observation: null,
          };
          break;
        }
        case 'network_get': {
          if (!this.#dependencies.network) {
            output = failure(
              'OPERATION_UNAVAILABLE',
              'This browser operation is not connected yet.',
              false,
              false,
            );
            break;
          }
          const input = call.arguments as {
            readonly requestId: string;
            readonly includeBody: boolean;
          };
          const targetTabId = requiredTaskTabId(taskTarget);
          const request = await this.#dependencies.network.get(
            targetTabId,
            input.requestId,
            input.includeBody,
          );
          output = {
            ok: true,
            tabId: targetTabId,
            url: null,
            data: { request },
            observation: null,
          };
          break;
        }
        case 'network_stop': {
          if (!this.#dependencies.network) {
            output = failure(
              'OPERATION_UNAVAILABLE',
              'This browser operation is not connected yet.',
              false,
              false,
            );
            break;
          }
          const targetTabId = requiredTaskTabId(taskTarget);
          await this.#dependencies.network.stop(targetTabId);
          output = {
            ok: true,
            tabId: targetTabId,
            url: null,
            data: { stopped: true },
            observation: null,
          };
          break;
        }
        default:
          output = failure(
            'OPERATION_UNAVAILABLE',
            'This browser operation is not connected yet.',
            false,
            false,
          );
      }
      throwIfAborted(signal);
      this.#recordRecoveryOutcome(call.operation, recoveryTabId, output);
      return result(call.operation, output, attachmentIds, modelAttachmentIds);
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      const normalized = failureFor(error);
      if (normalized.code === 'ACTION_STATE_MISMATCH' && recoveryTabId !== null) {
        this.#stateMismatchFallbackByTab.add(recoveryTabId);
        this.#rememberFailedSelection(call, recoveryTabId);
      }
      this.#recordRecoveryOutcome(call.operation, recoveryTabId, normalized);
      return result(call.operation, normalized);
    }
  }

  #fallbackFromElements(data: Readonly<Record<string, unknown>>): boolean {
    if (!Array.isArray(data.elements)) return false;
    return !data.elements.some(
      (element) =>
        typeof element === 'object' &&
        element !== null &&
        'ref' in element &&
        typeof element.ref === 'string' &&
        element.ref.length > 0,
    );
  }

  #selectionIntent(
    call: ParsedBrowserToolCall,
    tabId_: number,
  ): { readonly semanticKey: string; readonly selected: boolean } | null {
    if (call.operation !== 'set_checked' && call.operation !== 'click') return null;
    const arguments_ = call.arguments as {
      readonly ref?: unknown;
      readonly checked?: unknown;
      readonly button?: unknown;
      readonly count?: unknown;
    };
    if (typeof arguments_.ref !== 'string') return null;
    const identity = this.#selectableRefsByTab.get(tabId_)?.get(arguments_.ref);
    if (!identity) return null;
    if (call.operation === 'set_checked') {
      return typeof arguments_.checked === 'boolean'
        ? { semanticKey: identity.semanticKey, selected: arguments_.checked }
        : null;
    }
    if (arguments_.button !== 'left' || arguments_.count !== 1 || identity.selected === undefined) {
      return null;
    }
    return { semanticKey: identity.semanticKey, selected: !identity.selected };
  }

  #isDuplicateFailedSelection(call: ParsedBrowserToolCall, tabId_: number): boolean {
    const intent = this.#selectionIntent(call, tabId_);
    if (!intent) return false;
    return this.#failedSelectionsByTab.get(tabId_)?.get(intent.semanticKey) === intent.selected;
  }

  #rememberFailedSelection(call: ParsedBrowserToolCall, tabId_: number): void {
    const intent = this.#selectionIntent(call, tabId_);
    if (!intent) return;
    const failures = this.#failedSelectionsByTab.get(tabId_) ?? new Map<string, boolean>();
    failures.set(intent.semanticKey, intent.selected);
    this.#failedSelectionsByTab.set(tabId_, failures);
  }

  #clearFailedSelection(call: ParsedBrowserToolCall, tabId_: number): void {
    const intent = this.#selectionIntent(call, tabId_);
    if (!intent) return;
    this.#failedSelectionsByTab.get(tabId_)?.delete(intent.semanticKey);
  }

  #rememberSelectableRefs(tabId_: number, data: Readonly<Record<string, unknown>>): void {
    const refs = selectableRefs(data);
    if (refs === null) return;
    const structure = semanticStructure(data);
    const previousStructure = this.#semanticStructureByTab.get(tabId_);
    if (structure !== null) {
      this.#semanticStructureByTab.set(tabId_, structure);
      if (previousStructure !== undefined && previousStructure !== structure) {
        this.#failedSelectionsByTab.delete(tabId_);
      }
    }
    this.#selectableRefsByTab.set(tabId_, refs);
    const failures = this.#failedSelectionsByTab.get(tabId_);
    if (!failures) return;
    for (const identity of refs.values()) {
      if (identity.selected === failures.get(identity.semanticKey)) {
        failures.delete(identity.semanticKey);
      }
    }
    if (failures.size === 0) this.#failedSelectionsByTab.delete(tabId_);
  }

  #recordRecoveryOutcome(
    operation: ParsedBrowserToolCall['operation'],
    tabId_: number | null,
    output: unknown,
  ): void {
    if (tabId_ === null || operation === 'reload') return;
    const failed = browserFailure(output);
    if (failed && RELOAD_RECOVERY_FAILURES.has(failed.code)) {
      const current = this.#reloadRecoveryByTab.get(tabId_);
      this.#reloadRecoveryByTab.set(tabId_, {
        operation,
        code: failed.code,
        reloadAttempted:
          current?.operation === operation && current.code === failed.code
            ? current.reloadAttempted
            : false,
      });
      return;
    }
    if (
      failed === null &&
      (operation === 'inspect' ||
        operation === 'navigate' ||
        this.#reloadRecoveryByTab.get(tabId_)?.operation === operation)
    ) {
      this.#reloadRecoveryByTab.delete(tabId_);
    }
  }

  async #observeAfterAction(
    tabId_: number,
    baseSnapshot: string,
    signal: AbortSignal,
    runnerId: string | undefined,
  ): Promise<Readonly<Record<string, unknown>> | null> {
    const observer = this.#dependencies.observer;
    if (!observer) return null;
    try {
      await this.#retainRunner(tabId_, runnerId);
      const observed = await observer.inspect(tabId_, 'interactive', signal, {
        since: baseSnapshot,
      });
      this.#rememberSelectableRefs(tabId_, observed.data);
      const snapshotId = interactiveSnapshotId(observed.data);
      if (snapshotId === null) this.#interactiveSnapshotByTab.delete(tabId_);
      else this.#interactiveSnapshotByTab.set(tabId_, snapshotId);
      this.#visualFallbackByTab.set(
        tabId_,
        observed.visualFallbackAllowed ?? this.#fallbackFromElements(observed.data),
      );
      if (hasSelectableRef(observed.data)) this.#stateMismatchFallbackByTab.delete(tabId_);
      return observed.data;
    } catch {
      // The mutation already completed. Surface observation loss without replaying it.
      return null;
    }
  }

  async #retainRunner(tabId_: number, runnerId: string | undefined): Promise<void> {
    const sessions = this.#dependencies.sessions;
    if (!sessions || runnerId === undefined) return;
    const retainedTabs = this.#retainedTabsByRunner.get(runnerId) ?? new Set<number>();
    if (retainedTabs.has(tabId_)) return;
    await sessions.retain(tabId_, runnerId);
    retainedTabs.add(tabId_);
    this.#retainedTabsByRunner.set(runnerId, retainedTabs);
  }
}
