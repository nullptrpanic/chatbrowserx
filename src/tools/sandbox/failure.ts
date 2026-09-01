import { SandboxClientError } from '../../sandbox/sandbox-client';
import type { ToolFailureAction, ToolFailureContext, ValidatedToolCall } from '../types';

const recoveryPending: ToolFailureAction = {
  type: 'pause',
  reason: 'sandbox_execution_recovery_pending',
  userMessage: 'The Sandbox command is still running or its status is temporarily unavailable.',
};

/** Converts Sandbox transport failures into generic durable tool dispositions. */
export function sandboxFailure(
  error: unknown,
  call: ValidatedToolCall,
  context: ToolFailureContext,
): ToolFailureAction | null {
  if (!(error instanceof SandboxClientError) || error.code === 'ABORTED') return null;
  if (error.code === 'AUTH') {
    return {
      type: 'auth',
      reason: 'sandbox_authentication_required',
      userMessage: 'Sandbox authentication is required. Update the Sandbox Token in Settings.',
    };
  }
  if (
    context.phase === 'recover' ||
    (call.name === 'sandbox_exec' && error.dispatchState === 'may_have_dispatched')
  ) {
    return recoveryPending;
  }
  return {
    type: 'record',
    output: JSON.stringify(
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
  };
}
