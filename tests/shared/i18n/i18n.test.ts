import { describe, expect, it } from 'vitest';
import { createTranslator, resolveLanguage } from '../../../src/shared/i18n/i18n';
import { en } from '../../../src/shared/i18n/messages.en';
import { ja } from '../../../src/shared/i18n/messages.ja';
import { zhCN } from '../../../src/shared/i18n/messages.zh-CN';
import { resolveSelectionLabels } from '../../../src/page/selection/selection-i18n';

describe('interface translations', () => {
  it('keeps every catalog key aligned and every visible value nonblank', () => {
    const expectedKeys = Object.keys(zhCN).sort();
    expect(Object.keys(en).sort()).toEqual(expectedKeys);
    expect(Object.keys(ja).sort()).toEqual(expectedKeys);
    for (const catalog of [zhCN, en, ja]) {
      expect(Object.values(catalog).every((value) => value.trim().length > 0)).toBe(true);
    }
  });

  it('resolves system languages and interpolates named values without evaluation', () => {
    expect(resolveLanguage('system', 'zh-Hans-CN')).toBe('zh-CN');
    expect(resolveLanguage('system', 'ja-JP')).toBe('ja');
    expect(resolveLanguage('system', 'fr-FR')).toBe('en');
    expect(createTranslator('en')('actionsProgress', { used: 2, limit: 50 })).toBe(
      '2/50 browser actions verified',
    );
  });

  it('localizes page selection controls from the browser locale only', () => {
    expect(resolveSelectionLabels('zh-CN').translate).toBe('翻译');
    expect(resolveSelectionLabels('ja-JP').translate).toBe('翻訳');
    expect(resolveSelectionLabels('de-DE').translate).toBe('Translate');
  });
});
