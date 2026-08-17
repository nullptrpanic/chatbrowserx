export type TaskErrorCode =
  | 'AuthError'
  | 'RateLimitError'
  | 'TransientProviderError'
  | 'InvalidProviderResponse'
  | 'ToolCallLimitError'
  | 'TaskInputError'
  | 'TaskInterrupted';

export interface TaskError {
  readonly code: TaskErrorCode;
  readonly retryable: boolean;
  readonly recoveryAction: string;
  readonly userMessage: string;
  readonly evidenceRef: string | null;
}
