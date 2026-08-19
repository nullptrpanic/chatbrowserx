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
import type { PageObservationResult } from './observation/page-observer';
import type { BrowserActionPort } from './actions/browser-action-executor';
import type { NetworkCapturePort } from './network/network-capture-registry';

const MAX_OUTPUT_CHARACTERS = 100 * 1_024;
const TASK_SCOPED_OPERATIONS = new Set<ParsedBrowserToolCall['operation']>([
  'navigate',
  'reload',
  'inspect',
  'click',
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
type SessionPurpose = 'action' | 'operation' | 'network';

export interface BrowserToolExecutorDependencies {
  readonly tabs: BrowserTabPort;
  readonly observer?: {
    inspect(
      tabId: number,
      mode: 'content' | 'interactive' | 'interactive_deep' | 'screenshot',
      signal: AbortSignal,
    ): Promise<PageObservationResult>;
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
): BrowserToolFailure {
  return { ok: false, code, message, retryable, needsInspect };
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
        'The page observation bridge is unavailable. Reload the page and inspect again.',
        true,
        false,
      );
    case 'INVALID_PAGE_RESPONSE':
      return failure(
        'INVALID_PAGE_RESPONSE',
        'The page returned an invalid observation. Reload the page and inspect again.',
        true,
        false,
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
    case 'TYPE_VERIFICATION_FAILED':
      return failure(
        'TYPE_VERIFICATION_FAILED',
        'The page did not retain the requested text. Inspect the editor and try again.',
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
  output: unknown,
  attachmentIds: readonly string[] = [],
): BrowserToolExecutionResult {
  const serialized = JSON.stringify(output);
  if (serialized.length <= MAX_OUTPUT_CHARACTERS) {
    return { output: serialized, attachmentIds };
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
  readonly #ownersByRunner = new Map<string, Set<string>>();
  readonly #screenshotScales = new Map<number, ScreenshotCoordinateScale>();

  constructor(dependencies: BrowserToolExecutorDependencies) {
    this.#dependencies = dependencies;
  }

  async release(sessionOwnerId: string): Promise<void> {
    this.#screenshotScales.clear();
    const sessions = this.#dependencies.sessions;
    if (!sessions) return;
    const owners = [...(this.#ownersByRunner.get(sessionOwnerId) ?? [])];
    this.#ownersByRunner.delete(sessionOwnerId);
    await Promise.all([
      ...owners.map((ownerId) => sessions.releaseOwner(ownerId)),
      sessions.releaseOwner(sessionOwnerId),
    ]);
  }

  async execute(
    call: ParsedBrowserToolCall,
    signal: AbortSignal,
    context?: BrowserExecutionContext,
  ): Promise<BrowserToolExecutionResult> {
    throwIfAborted(signal);
    try {
      const taskTarget = resolveTaskTarget(call, context);
      if (taskTarget.failure !== null) return result(taskTarget.failure);
      let output: unknown;
      let attachmentIds: readonly string[] = [];
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
          output = success(tab, { title: tab.title, active: tab.active });
          break;
        }
        case 'reload': {
          const targetTabId = requiredTaskTabId(taskTarget);
          const tab = await this.#dependencies.tabs.reload(targetTabId);
          this.#screenshotScales.delete(targetTabId);
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
          };
          const targetTabId = requiredTaskTabId(taskTarget);
          const purpose = 'operation' as const;
          if (input.mode !== 'content') {
            await this.#retainPurpose(targetTabId, context?.sessionOwnerId, purpose);
          }
          let observed: PageObservationResult;
          try {
            observed = await this.#dependencies.observer.inspect(targetTabId, input.mode, signal);
          } catch (error) {
            await this.#releasePurpose(context?.sessionOwnerId, purpose);
            throw error;
          }
          await this.#releasePurpose(context?.sessionOwnerId, purpose);
          if (input.mode === 'screenshot') {
            const scale = screenshotCoordinateScale(observed.data);
            if (scale === null) this.#screenshotScales.delete(targetTabId);
            else this.#screenshotScales.set(targetTabId, scale);
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
        case 'click':
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
          const targetTabId = requiredTaskTabId(taskTarget);
          const boundCall = bindTaskTarget(
            mapScreenshotCoordinates(call, this.#screenshotScales.get(targetTabId)),
            targetTabId,
          );
          this.#screenshotScales.delete(targetTabId);
          await this.#retainPurpose(targetTabId, context?.sessionOwnerId, 'action');
          let action;
          try {
            action = await this.#dependencies.actions.execute(boundCall, signal);
          } finally {
            await this.#releasePurpose(context?.sessionOwnerId, 'action');
          }
          output = {
            ok: true,
            tabId: action.tabId,
            url: action.url,
            data: action.data,
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
          await this.#retainPurpose(targetTabId, context?.sessionOwnerId, 'network');
          let started;
          try {
            started = await this.#dependencies.network.start(targetTabId, signal);
          } catch (error) {
            await this.#releasePurpose(context?.sessionOwnerId, 'network');
            throw error;
          }
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
          try {
            await this.#dependencies.network.stop(targetTabId);
          } finally {
            await this.#releasePurpose(context?.sessionOwnerId, 'network');
          }
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
      return result(output, attachmentIds);
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      return result(failureFor(error));
    }
  }

  async #retainPurpose(
    tabId_: number,
    runnerId: string | undefined,
    purpose: SessionPurpose,
  ): Promise<void> {
    const sessions = this.#dependencies.sessions;
    if (!sessions || runnerId === undefined) return;
    const ownerId = `${runnerId}:${purpose}`;
    await sessions.retain(tabId_, ownerId);
    const owners = this.#ownersByRunner.get(runnerId) ?? new Set<string>();
    owners.add(ownerId);
    this.#ownersByRunner.set(runnerId, owners);
  }

  async #releasePurpose(runnerId: string | undefined, purpose: SessionPurpose): Promise<void> {
    const sessions = this.#dependencies.sessions;
    if (!sessions || runnerId === undefined) return;
    const ownerId = `${runnerId}:${purpose}`;
    const owners = this.#ownersByRunner.get(runnerId);
    if (!owners?.delete(ownerId)) return;
    if (owners.size === 0) this.#ownersByRunner.delete(runnerId);
    await sessions.releaseOwner(ownerId);
  }
}
