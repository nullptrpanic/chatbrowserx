export type ActionExecutionErrorCode =
  | 'TARGET_NOT_FOUND'
  | 'TARGET_AMBIGUOUS'
  | 'ACTION_BLOCKED'
  | 'ACTION_UNSUPPORTED'
  | 'ACTION_FAILED';

export class ActionExecutionError extends Error {
  readonly code: ActionExecutionErrorCode;

  /** Creates a stable browser-action failure without embedding page content or protocol payloads. */
  constructor(code: ActionExecutionErrorCode, message: string) {
    super(message);
    this.name = 'ActionExecutionError';
    this.code = code;
  }
}
