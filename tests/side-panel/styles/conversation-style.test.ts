import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const conversationStyles = readFileSync(
  resolve(process.cwd(), 'src/side-panel/styles/conversation.css'),
  'utf8',
);

function installConversationStyles(): CSSStyleSheet {
  const style = document.createElement('style');
  style.dataset.testStyles = 'conversation';
  style.textContent = conversationStyles;
  document.head.append(style);
  if (style.sheet === null) throw new Error('Conversation stylesheet could not be parsed.');
  return style.sheet;
}

function hasSelectorText(rule: CSSRule): rule is CSSStyleRule {
  return 'selectorText' in rule && typeof rule.selectorText === 'string';
}

function styleRule(sheet: CSSStyleSheet, selector: string): CSSStyleRule {
  const normalizedSelector = selector.replace(/\s+/g, ' ').trim();
  const rule = [...sheet.cssRules].find(
    (candidate): candidate is CSSStyleRule =>
      hasSelectorText(candidate) &&
      candidate.selectorText.replace(/\s+/g, ' ').trim() === normalizedSelector,
  );
  if (rule === undefined) throw new Error(`Missing conversation style rule: ${selector}`);
  return rule;
}

afterEach(() => {
  document.querySelectorAll('[data-test-styles="conversation"]').forEach((style) => style.remove());
});

describe('conversation message actions', () => {
  it('keeps copy actions visible without hover-driven layout changes', () => {
    expect(conversationStyles).toContain('.message-actions');
    const sheet = installConversationStyles();
    expect(sheet.cssRules.length).toBeGreaterThan(0);
    const actions = styleRule(sheet, '.message-actions');

    expect(actions.style.display).toBe('flex');
    expect(actions.style.marginTop).toBe('5px');
    expect(actions.style.opacity).not.toBe('0');
    expect(actions.style.pointerEvents).not.toBe('none');
    expect(actions.style.maxHeight).not.toBe('0px');
    expect(actions.style.overflow).not.toBe('hidden');
  });
});
