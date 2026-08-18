import type { ParsedBrowserToolCall } from '../agent/tools/browser-tool-schema';
import type {
  BrowserExecutionPort,
  BrowserToolExecutionResult,
  BrowserToolFailure,
  BrowserToolFailureCode,
} from './browser-execution-types';
import { BrowserTabError, type BrowserTabPort, type BrowserTabState } from './tab-service';
import type { PageObservationResult } from './observation/page-observer';
import type { BrowserActionPort } from './actions/browser-action-executor';
import type { NetworkCapturePort } from './network/network-capture-registry';

const MAX_OUTPUT_CHARACTERS = 100 * 1_024;

export interface BrowserToolExecutorDependencies {
  readonly tabs: BrowserTabPort;
  readonly observer?: {
    inspect(
      tabId: number,
      mode: 'content' | 'interactive' | 'screenshot',
      signal: AbortSignal,
    ): Promise<PageObservationResult>;
  };
  readonly actions?: BrowserActionPort;
  readonly network?: NetworkCapturePort;
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Browser operation was aborted.', 'AbortError');
}

/** Dispatches validated browser calls and always returns a bounded, normalized result. */
export class BrowserToolExecutor implements BrowserExecutionPort {
  readonly #dependencies: BrowserToolExecutorDependencies;

  constructor(dependencies: BrowserToolExecutorDependencies) {
    this.#dependencies = dependencies;
  }

  async execute(
    call: ParsedBrowserToolCall,
    signal: AbortSignal,
  ): Promise<BrowserToolExecutionResult> {
    throwIfAborted(signal);
    try {
      let output: unknown;
      let attachmentIds: readonly string[] = [];
      switch (call.operation) {
        case 'list_tabs': {
          const tabs = await this.#dependencies.tabs.list();
          output = { ok: true, tabId: null, url: null, data: { tabs }, observation: null };
          break;
        }
        case 'open_tab': {
          const input = call.arguments as { readonly url: string; readonly activate: boolean };
          const tab = await this.#dependencies.tabs.open(input.url, input.activate);
          output = success(tab, { title: tab.title, active: tab.active });
          break;
        }
        case 'switch_tab': {
          const tab = await this.#dependencies.tabs.activate(tabId(call.arguments));
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
          const input = call.arguments as { readonly tabId: number; readonly url: string };
          const tab = await this.#dependencies.tabs.navigate(input.tabId, input.url);
          output = success(tab, { title: tab.title, active: tab.active });
          break;
        }
        case 'reload': {
          const tab = await this.#dependencies.tabs.reload(tabId(call.arguments));
          output = success(tab, { title: tab.title, active: tab.active, reloaded: true });
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
            readonly tabId: number;
            readonly mode: 'content' | 'interactive' | 'screenshot';
          };
          const observed = await this.#dependencies.observer.inspect(
            input.tabId,
            input.mode,
            signal,
          );
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
          const action = await this.#dependencies.actions.execute(call, signal);
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
          const input = call.arguments as { readonly tabId: number };
          const started = await this.#dependencies.network.start(input.tabId, signal);
          output = {
            ok: true,
            tabId: input.tabId,
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
            readonly tabId: number;
            readonly urlPattern: string;
            readonly limit: number;
          };
          const requests = await this.#dependencies.network.list(
            input.tabId,
            input.urlPattern,
            input.limit,
          );
          output = {
            ok: true,
            tabId: input.tabId,
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
            readonly tabId: number;
            readonly requestId: string;
            readonly includeBody: boolean;
          };
          const request = await this.#dependencies.network.get(
            input.tabId,
            input.requestId,
            input.includeBody,
          );
          output = {
            ok: true,
            tabId: input.tabId,
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
          const input = call.arguments as { readonly tabId: number };
          await this.#dependencies.network.stop(input.tabId);
          output = {
            ok: true,
            tabId: input.tabId,
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
}
