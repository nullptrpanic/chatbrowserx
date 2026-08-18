import type { ParsedBrowserToolCall } from '../agent/tools/browser-tool-schema';

export interface BrowserToolExecutionResult {
  readonly output: string;
  readonly attachmentIds: readonly string[];
}

export interface BrowserExecutionPort {
  execute(call: ParsedBrowserToolCall, signal: AbortSignal): Promise<BrowserToolExecutionResult>;
}

export type BrowserToolFailureCode =
  | 'INVALID_TAB'
  | 'TAB_NOT_FOUND'
  | 'TAB_NOT_CONTROLLABLE'
  | 'URL_NOT_ALLOWED'
  | 'LOAD_TIMEOUT'
  | 'NETWORK_CAPTURE_LOST'
  | 'NETWORK_REQUEST_NOT_FOUND'
  | 'STALE_REF'
  | 'POINT_OUT_OF_VIEWPORT'
  | 'WAIT_TIMEOUT'
  | 'DEBUGGER_UNAVAILABLE'
  | 'HISTORY_UNAVAILABLE'
  | 'UNSUPPORTED_ACTION'
  | 'OPERATION_UNAVAILABLE'
  | 'RESULT_TOO_LARGE'
  | 'BROWSER_OPERATION_FAILED';

export interface BrowserToolFailure {
  readonly ok: false;
  readonly code: BrowserToolFailureCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly needsInspect: boolean;
}
