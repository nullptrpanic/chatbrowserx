export type TaskErrorCode =
  | 'AuthError'
  | 'RateLimitError'
  | 'TransientProviderError'
  | 'InvalidProviderResponse'
  | 'PermissionDenied'
  | 'TabUnavailable'
  | 'UnsupportedPage'
  | 'TargetNotFound'
  | 'TargetAmbiguous'
  | 'ActionBlocked'
  | 'ActionNoEffect'
  | 'NavigationInterrupted'
  | 'BudgetExceeded'
  | 'PolicyConfirmationRequired';

export interface TaskError {
  readonly code: TaskErrorCode;
  readonly retryable: boolean;
  readonly recoveryAction: string;
  readonly userMessage: string;
  readonly evidenceRef: string | null;
}
