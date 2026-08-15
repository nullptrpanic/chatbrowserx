import { describe, expect, it } from 'vitest';
import { decideActionRecovery } from '../../src/agent/retry-policy';

describe('decideActionRecovery', () => {
  it('allows at most three low-risk action attempts', () => {
    expect(
      decideActionRecovery({
        risk: 'low',
        actionAttempts: 1,
        actionAttemptsLimit: 3,
        replansUsed: 0,
        replansLimit: 2,
        resultKnown: false,
      }),
    ).toBe('retry_action');
    expect(
      decideActionRecovery({
        risk: 'low',
        actionAttempts: 3,
        actionAttemptsLimit: 3,
        replansUsed: 0,
        replansLimit: 2,
        resultKnown: false,
      }),
    ).toBe('replan');
  });

  it('replans a known no-effect result instead of replaying the same action', () => {
    expect(
      decideActionRecovery({
        risk: 'low',
        actionAttempts: 1,
        actionAttemptsLimit: 3,
        replansUsed: 0,
        replansLimit: 2,
        resultKnown: true,
      }),
    ).toBe('replan');
  });

  it('never automatically retries an uncertain high-risk effect', () => {
    expect(
      decideActionRecovery({
        risk: 'high',
        actionAttempts: 1,
        actionAttemptsLimit: 3,
        replansUsed: 0,
        replansLimit: 2,
        resultKnown: false,
      }),
    ).toBe('wait_for_confirmation');
  });

  it('pauses after the replan budget is exhausted', () => {
    expect(
      decideActionRecovery({
        risk: 'low',
        actionAttempts: 3,
        actionAttemptsLimit: 3,
        replansUsed: 2,
        replansLimit: 2,
        resultKnown: false,
      }),
    ).toBe('pause_budget');
  });
});
