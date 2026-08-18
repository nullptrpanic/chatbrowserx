export type ParsedKeyChord =
  | { readonly kind: 'history'; readonly direction: 'back' | 'forward' }
  | {
      readonly kind: 'key';
      readonly key: string;
      readonly code: string;
      readonly modifiers: number;
    };

const MODIFIERS = new Map([
  ['ALT', 1],
  ['CTRL', 2],
  ['META', 4],
  ['SHIFT', 8],
]);

const NAMED_KEYS: Readonly<Record<string, { readonly key: string; readonly code: string }>> = {
  ENTER: { key: 'Enter', code: 'Enter' },
  TAB: { key: 'Tab', code: 'Tab' },
  ESCAPE: { key: 'Escape', code: 'Escape' },
  SPACE: { key: ' ', code: 'Space' },
  BACKSPACE: { key: 'Backspace', code: 'Backspace' },
  DELETE: { key: 'Delete', code: 'Delete' },
  INSERT: { key: 'Insert', code: 'Insert' },
  HOME: { key: 'Home', code: 'Home' },
  END: { key: 'End', code: 'End' },
  PAGEUP: { key: 'PageUp', code: 'PageUp' },
  PAGEDOWN: { key: 'PageDown', code: 'PageDown' },
  ARROWUP: { key: 'ArrowUp', code: 'ArrowUp' },
  ARROWDOWN: { key: 'ArrowDown', code: 'ArrowDown' },
  ARROWLEFT: { key: 'ArrowLeft', code: 'ArrowLeft' },
  ARROWRIGHT: { key: 'ArrowRight', code: 'ArrowRight' },
};

function invalid(): never {
  throw new Error('The key chord is invalid.');
}

/** Parses a small logical chord grammar without accepting browser reload or arbitrary scripts. */
export function parseKeyChord(source: string): ParsedKeyChord {
  if (source === 'BROWSER_BACK') return { kind: 'history', direction: 'back' };
  if (source === 'BROWSER_FORWARD') return { kind: 'history', direction: 'forward' };
  if (source.length === 0 || source.length > 100 || source.trim() !== source) invalid();

  const parts = source.split('+');
  if (parts.some((part) => part.length === 0)) invalid();
  let modifiers = 0;
  const seenModifiers = new Set<string>();
  const keyParts: string[] = [];
  for (const part of parts) {
    const upper = part.toUpperCase();
    const modifier = MODIFIERS.get(upper);
    if (modifier !== undefined) {
      if (seenModifiers.has(upper)) invalid();
      seenModifiers.add(upper);
      modifiers |= modifier;
    } else {
      keyParts.push(part);
    }
  }
  if (keyParts.length !== 1) invalid();
  const rawKey = keyParts[0];
  if (!rawKey) invalid();
  const upperKey = rawKey.toUpperCase();
  if (upperKey.startsWith('BROWSER_')) invalid();
  const named = NAMED_KEYS[upperKey];
  if (named) return { kind: 'key', ...named, modifiers };
  if (/^F(?:[1-9]|1[0-2])$/.test(upperKey)) {
    return { kind: 'key', key: upperKey, code: upperKey, modifiers };
  }
  if (rawKey.length !== 1 || /[_\s]/.test(rawKey)) invalid();
  const code = /[a-z]/i.test(rawKey)
    ? `Key${rawKey.toUpperCase()}`
    : /\d/.test(rawKey)
      ? `Digit${rawKey}`
      : '';
  if (!code) invalid();
  return { kind: 'key', key: rawKey, code, modifiers };
}
