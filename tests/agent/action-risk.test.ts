import { describe, expect, it } from 'vitest';
import type { BrowserActionRequest } from '../../src/browser/contracts/action';
import type { ElementTarget } from '../../src/browser/contracts/target';
import { classifyActionRisk } from '../../src/agent/action-risk';

const benignTarget: ElementTarget = {
  framePath: [],
  shadowPath: [],
  role: 'button',
  name: 'Next page',
  label: null,
  text: 'Next',
  stableAttributes: { 'data-testid': 'next' },
  ancestorHint: 'Pagination',
  lastKnownRect: null,
};

/** Builds a click action whose semantic target can exercise policy classification. */
function buildClick(name: string, risk: 'low' | 'high' = 'low'): BrowserActionRequest {
  return {
    actionId: 'action_1',
    tabId: 7,
    type: 'click',
    target: { ...benignTarget, name, text: name },
    risk,
    expected: { type: 'page.stable', quietMs: 300 },
  };
}

describe('classifyActionRisk', () => {
  it('keeps ordinary navigation low risk', () => {
    expect(classifyActionRisk(buildClick('Next page'))).toBe('low');
  });

  it.each([
    'Submit application',
    'Send message',
    'Publish post',
    'Delete account',
    'Remove member',
    'Purchase now',
    'Pay invoice',
    'Transfer funds',
    'Confirm order',
    'Change password',
  ])('raises %s to high risk even when the planner marks it low', (name) => {
    expect(classifyActionRisk(buildClick(name, 'low'))).toBe('high');
  });

  it('allows a planner to raise risk but never lower a policy classification', () => {
    expect(classifyActionRisk(buildClick('Next page', 'high'))).toBe('high');
    expect(classifyActionRisk(buildClick('Delete record', 'low'))).toBe('high');
  });

  it('recognizes destructive and account actions on Chinese and Japanese pages', () => {
    expect(classifyActionRisk(buildClick('确认支付'))).toBe('high');
    expect(classifyActionRisk(buildClick('密码を変更'))).toBe('high');
  });

  it('does not classify arbitrary typed content as an action semantic', () => {
    const action: BrowserActionRequest = {
      actionId: 'action_2',
      tabId: 7,
      type: 'type',
      target: { ...benignTarget, role: 'textbox', name: 'Notes', text: null },
      text: 'Please do not delete this note.',
      replace: true,
      risk: 'low',
      expected: { type: 'page.stable', quietMs: 300 },
    };

    expect(classifyActionRisk(action)).toBe('low');
  });
});
