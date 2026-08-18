import { describe, expect, it } from 'vitest';
import {
  ElementRefStore,
  ElementRefStoreError,
} from '../../../src/browser/observation/element-ref-store';

const ELEMENT = {
  session: { tabId: 7 },
  backendNodeId: 42,
  role: 'button',
  name: 'Continue',
  state: ['focusable'],
  frame: 'main',
  bounds: { x: 10, y: 20, width: 100, height: 30 },
} as const;

describe('ElementRefStore', () => {
  it('creates opaque refs and resolves them only in the exact tab generation', () => {
    let id = 0;
    const store = new ElementRefStore({ create: () => `ref_${++id}` });

    const [element] = store.replaceSnapshot(7, 3, [ELEMENT]);

    expect(element).toEqual({
      ref: 'ref_1',
      role: 'button',
      name: 'Continue',
      state: ['focusable'],
      frame: 'main',
      bounds: ELEMENT.bounds,
    });
    expect(element?.ref).not.toMatch(/Continue|button|42/);
    expect(store.resolve('ref_1', 7, 3)).toEqual({
      tabId: 7,
      generation: 3,
      session: { tabId: 7 },
      backendNodeId: 42,
      bounds: ELEMENT.bounds,
    });
  });

  it('rejects cross-tab and stale-generation refs', () => {
    const store = new ElementRefStore({ create: () => 'ref_1' });
    store.replaceSnapshot(7, 3, [ELEMENT]);

    expect(() => store.resolve('ref_1', 8, 3)).toThrow(
      expect.objectContaining({ code: 'REF_SCOPE_MISMATCH' }),
    );
    expect(() => store.resolve('ref_1', 7, 4)).toThrow(
      expect.objectContaining({ code: 'STALE_REF' }),
    );

    store.replaceSnapshot(7, 4, [{ ...ELEMENT, backendNodeId: 43 }]);
    expect(() => store.resolve('ref_1', 7, 3)).toThrow(ElementRefStoreError);
  });

  it('rejects ambiguous duplicate backend targets instead of issuing two refs', () => {
    const store = new ElementRefStore({ create: () => crypto.randomUUID() });

    expect(() => store.replaceSnapshot(7, 3, [ELEMENT, { ...ELEMENT, name: 'Duplicate' }])).toThrow(
      expect.objectContaining({ code: 'AMBIGUOUS_TARGET' }),
    );
  });
});
