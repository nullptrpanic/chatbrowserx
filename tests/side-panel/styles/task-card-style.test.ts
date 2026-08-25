import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const taskCardStyles = readFileSync(
  resolve(process.cwd(), 'src/side-panel/styles/task-card.css'),
  'utf8',
);

function installTaskCardStyles(): CSSStyleSheet {
  const style = document.createElement('style');
  style.dataset.testStyles = 'task-card';
  style.textContent = taskCardStyles;
  document.head.append(style);
  if (style.sheet === null) throw new Error('Task card stylesheet could not be parsed.');
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
  if (rule === undefined) throw new Error(`Missing task card style rule: ${selector}`);
  return rule;
}

afterEach(() => {
  document.querySelectorAll('[data-test-styles="task-card"]').forEach((style) => style.remove());
});

describe('tool result copy actions', () => {
  it('keeps copy icons visible without a framed background in normal and terminal headers', () => {
    const sheet = installTaskCardStyles();
    const action = styleRule(sheet, '.tool-copy-action');
    const terminalAction = styleRule(sheet, '.terminal-payload-header .tool-copy-action');

    expect(action.style.display).toBe('grid');
    expect(action.style.opacity).toBe('1');
    expect(action.style.visibility).toBe('visible');
    expect(action.style.border).toBe('0px');
    expect(action.style.color).toBe('var(--cbx-muted)');
    expect(action.style.background).toBe('transparent');

    expect(terminalAction.style.border).toBe('0px');
    expect(terminalAction.style.color).toBe('rgb(157, 169, 189)');
    expect(terminalAction.style.background).toBe('transparent');
  });

  it('keeps terminal commands and output horizontally scrollable without wrapping or clipping', () => {
    const sheet = installTaskCardStyles();
    const content = styleRule(sheet, '.terminal-content');
    const payload = styleRule(sheet, '.terminal-payload');
    const stream = styleRule(sheet, '.terminal-stream');
    const command = styleRule(sheet, '.terminal-command');
    const commandCode = styleRule(sheet, '.terminal-command code');
    const output = styleRule(sheet, '.terminal-output');

    expect(content.style.minWidth).toBe('0px');
    expect(payload.style.minWidth).toBe('0px');
    expect(stream.style.minWidth).toBe('0px');
    expect(command.style.maxWidth).toBe('100%');
    expect(command.style.overflowX).toBe('auto');
    expect(commandCode.style.whiteSpace).toBe('pre');
    expect(commandCode.style.overflowWrap).toBe('normal');
    expect(output.style.maxWidth).toBe('100%');
    expect(output.style.overflowX).toBe('auto');
    expect(output.style.whiteSpace).toBe('pre');
    expect(output.style.overflowWrap).toBe('normal');
  });
});
