import { expect, it } from 'vitest';
import { classifyTranslationStyleChange } from '../../src/page/translation/translation-animation';

it.each([
  ['', '', 'none'],
  ['color:red', 'color:red', 'none'],
  ['', 'background-color:blue', 'appearance'],
  ['box-shadow:none', 'box-shadow:0 16px 32px -16px #0002', 'appearance'],
  ['', 'box-shadow:0 16px 32px -16px #0002;height:32px', 'layout'],
  ['font-size:12px', 'font-size:18px', 'layout'],
  ['', 'transform:translateY(3px);color:red', 'motion'],
  ['', 'translate:2px', 'motion'],
  ['', 'top:2px', 'motion'],
  ['', 'left:4px', 'motion'],
  ['left:4px', '', 'motion'],
  ['left:4px', 'left:4px!important', 'motion'],
])('classifies complete source style changes %s → %s as %s', (before, after, expected) => {
  const a = document.createElement('div').style,
    b = document.createElement('div').style;
  a.cssText = before;
  b.cssText = after;
  expect(classifyTranslationStyleChange(a, b)).toBe(expected);
});
