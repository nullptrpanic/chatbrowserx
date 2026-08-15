export type ActionRecoveryDecision =
  'retry_action' | 'replan' | 'wait_for_confirmation' | 'pause_budget';

export interface ActionRecoveryInput {
  readonly risk: 'low' | 'high';
  readonly actionAttempts: number;
  readonly actionAttemptsLimit: number;
  readonly replansUsed: number;
  readonly replansLimit: number;
  readonly resultKnown: boolean;
}

/** Selects the next bounded recovery boundary without ever replaying high-risk effects silently. */
export function decideActionRecovery(input: ActionRecoveryInput): ActionRecoveryDecision {
  if (input.risk === 'high') return 'wait_for_confirmation';
  if (!input.resultKnown && input.actionAttempts < input.actionAttemptsLimit) {
    return 'retry_action';
  }
  if (input.replansUsed < input.replansLimit) return 'replan';
  return 'pause_budget';
}
