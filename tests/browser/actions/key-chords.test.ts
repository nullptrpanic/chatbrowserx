import { describe, expect, it } from 'vitest';
import { parseKeyChord } from '../../../src/browser/actions/key-chords';

describe('parseKeyChord', () => {
  it('normalizes modifier chords and named keys for CDP', () => {
    expect(parseKeyChord('CTRL+SHIFT+p')).toEqual({
      kind: 'key',
      key: 'p',
      code: 'KeyP',
      modifiers: 10,
    });
    expect(parseKeyChord('ENTER')).toEqual({
      kind: 'key',
      key: 'Enter',
      code: 'Enter',
      modifiers: 0,
    });
    expect(parseKeyChord('ESC')).toEqual({
      kind: 'key',
      key: 'Escape',
      code: 'Escape',
      modifiers: 0,
    });
  });

  it('uses explicit logical history tokens instead of platform shortcuts', () => {
    expect(parseKeyChord('BROWSER_BACK')).toEqual({ kind: 'history', direction: 'back' });
    expect(parseKeyChord('BROWSER_FORWARD')).toEqual({ kind: 'history', direction: 'forward' });
  });

  it.each(['CTRL+CTRL+A', 'CTRL', 'BROWSER_RELOAD', 'CTRL+BROWSER_BACK', 'UNKNOWN_NAMED_KEY'])(
    'rejects an ambiguous key chord: %s',
    (value) => expect(() => parseKeyChord(value)).toThrow(/key chord is invalid/i),
  );
});
