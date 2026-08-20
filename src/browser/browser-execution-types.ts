import type { ParsedBrowserToolCall } from '../agent/tools/browser-tool-schema';

export interface BrowserToolExecutionResult {
  readonly output: string;
  readonly attachmentIds: readonly string[];
}

export interface BrowserExecutionContext {
  /** Durable task target; null means the prior target was explicitly closed. */
  readonly currentTabId: number | null;
  /** One ephemeral runner owner whose debugger sessions are released when the run stops. */
  readonly sessionOwnerId?: string;
}

export interface BrowserSessionLifecyclePort {
  retain(tabId: number, ownerId: string): Promise<void>;
  releaseOwner(ownerId: string): Promise<void>;
}

export interface BrowserExecutionPort {
  execute(
    call: ParsedBrowserToolCall,
    signal: AbortSignal,
    context?: BrowserExecutionContext,
  ): Promise<BrowserToolExecutionResult>;
  /** Invalidates model-facing screenshot and interactive-delta baselines after compaction. */
  resetObservationBaselines(): void;
  /** Releases every debugger attachment retained by one task runner. */
  release(sessionOwnerId: string): Promise<void>;
}

export type BrowserToolFailureCode =
  | 'CURRENT_TAB_UNAVAILABLE'
  | 'TAB_SCOPE_MISMATCH'
  | 'INVALID_TAB'
  | 'TAB_NOT_FOUND'
  | 'TAB_NOT_CONTROLLABLE'
  | 'URL_NOT_ALLOWED'
  | 'LOAD_TIMEOUT'
  | 'PAGE_UNAVAILABLE'
  | 'INVALID_PAGE_RESPONSE'
  | 'INTERACTIVE_INSPECTION_REQUIRED'
  | 'SEMANTIC_INSPECTION_AVAILABLE'
  | 'SELECTABLE_ACTION_REQUIRED'
  | 'ACTION_STATE_MISMATCH'
  | 'ACTION_STATE_UNAVAILABLE'
  | 'ACTION_TARGET_OBSCURED'
  | 'REPEATED_RECOVERY_BLOCKED'
  | 'NETWORK_CAPTURE_LOST'
  | 'NETWORK_REQUEST_NOT_FOUND'
  | 'STALE_REF'
  | 'STALE_SCREENSHOT'
  | 'POINT_OUT_OF_VIEWPORT'
  | 'TYPE_VERIFICATION_FAILED'
  | 'DUPLICATE_FAILED_ACTION'
  | 'NO_PROGRESS'
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
  readonly stage?: 'focus' | 'insert' | 'readback' | 'submit';
}
