import { describe, expect, it } from 'vitest';
import { parseTranslation, projectBox } from '../fixtures/translation-lens/lens';

describe('translation lens feasibility', () => {
  it('accepts plain model JSON and preserves recognized text and translation', () => {
    const blocks = [{ text: 'Save', translation: '保存', box: [100, 200, 300, 40] }];
    expect(parseTranslation(JSON.stringify({ blocks }))).toEqual(blocks);
  });

  it('accepts a single fenced JSON response', () => {
    expect(parseTranslation('```json\n{"blocks": []}\n```')).toEqual([]);
  });

  it.each([
    '{"blocks":[{"text":"Save","translation":"保存","box":[100,200,-1,40]}]}',
    '{"blocks":[{"text":"Save","translation":"保存","box":[900,200,200,40]}]}',
    '{"blocks":[{"text":"Save","translation":"保存","box":[0,0,null,40]}]}',
    '{"blocks":[{"text":"Save","box":[0,0,30,40]}]}',
  ])('rejects invalid model coordinates or missing translations', (value) => {
    expect(() => parseTranslation(value)).toThrow();
  });

  it('projects normalized screenshot coordinates into viewport CSS pixels', () => {
    expect(projectBox([100, 200, 300, 40], 1440, 900)).toEqual({
      left: 144,
      top: 180,
      width: 432,
      height: 36,
    });
  });
});
