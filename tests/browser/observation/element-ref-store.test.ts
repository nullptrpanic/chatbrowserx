import { describe, expect, it } from 'vitest';
import {
  ElementRefStore,
  ElementRefStoreError,
} from '../../../src/browser/observation/element-ref-store';

const ELEMENT = {
  frameTargetId: null,
  documentFrameId: 'frame-main',
  loaderId: 'loader-1',
  backendNodeId: 42,
  role: 'button',
  name: 'Continue',
  state: ['focusable'],
  actions: ['click'],
  frame: 'main',
} as const;

describe('ElementRefStore', () => {
  it('compacts production-sized ids without reusing an invalidated ref', () => {
    let id = 0;
    const store = new ElementRefStore({
      create: () => `element_00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    });

    const [first] = store.replaceSnapshot(7, [ELEMENT]);
    const [second] = store.replaceSnapshot(7, [{ ...ELEMENT, backendNodeId: 43 }]);

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) throw new Error('Expected compact refs.');
    expect(first).toMatch(/^e[0-9a-z]+$/);
    expect(first.length).toBeLessThanOrEqual(16);
    expect(second).not.toBe(first);
    expect(() => store.resolve(first, 7)).toThrow(
      expect.objectContaining({ code: 'REF_NOT_FOUND' }),
    );
    expect(store.resolve(second, 7)).toMatchObject({ backendNodeId: 43 });
  });

  it('creates opaque refs that retain document identity across debugger attachments', () => {
    let id = 0;
    const store = new ElementRefStore({ create: () => `ref_${++id}` });

    const [ref] = store.replaceSnapshot(7, [ELEMENT]);

    expect(ref).toBe('ref_1');
    expect(ref).not.toMatch(/Continue|button|42|loader/);
    expect(store.resolve('ref_1', 7)).toEqual({
      tabId: 7,
      frameTargetId: null,
      documentFrameId: 'frame-main',
      loaderId: 'loader-1',
      backendNodeId: 42,
      role: 'button',
      state: ['focusable'],
      actions: ['click'],
    });
  });

  it('rejects cross-tab refs and invalidates the previous observation snapshot', () => {
    let id = 0;
    const store = new ElementRefStore({ create: () => `ref_${++id}` });
    store.replaceSnapshot(7, [ELEMENT]);

    expect(() => store.resolve('ref_1', 8)).toThrow(
      expect.objectContaining({ code: 'REF_SCOPE_MISMATCH' }),
    );

    store.replaceSnapshot(7, [{ ...ELEMENT, backendNodeId: 43 }]);
    expect(() => store.resolve('ref_1', 7)).toThrow(ElementRefStoreError);
  });

  it('rejects ambiguous duplicate backend targets instead of issuing two refs', () => {
    const store = new ElementRefStore({ create: () => crypto.randomUUID() });

    expect(() => store.replaceSnapshot(7, [ELEMENT, { ...ELEMENT, name: 'Duplicate' }])).toThrow(
      expect.objectContaining({ code: 'AMBIGUOUS_TARGET' }),
    );
  });
});
