import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const shellStyles = readFileSync(resolve(process.cwd(), 'src/side-panel/styles/shell.css'), 'utf8');

function styleRule(selector: string): CSSStyleRule {
  const style = document.createElement('style');
  style.textContent = shellStyles;
  document.head.append(style);
  const rule = [...(style.sheet?.cssRules ?? [])].find(
    (candidate): candidate is CSSStyleRule =>
      'selectorText' in candidate && candidate.selectorText === selector,
  );
  style.remove();
  if (rule === undefined) throw new Error(`Missing shell style rule: ${selector}`);
  return rule;
}

describe('Sandbox console action', () => {
  it('inherits the same transparent and hover backgrounds as the other icon actions', () => {
    expect(styleRule('.icon-button').style.background).toBe('transparent');
    expect(styleRule('.icon-button:hover').style.background).toBe('var(--cbx-hover)');
    expect(styleRule('.sandbox-console-button').style.background).toBe('');
    expect(styleRule('.sandbox-console-button:hover').style.background).toBe('');
    expect(styleRule('.sandbox-console-button.is-unavailable').style.color).toBe(
      'var(--cbx-danger)',
    );
  });
});
