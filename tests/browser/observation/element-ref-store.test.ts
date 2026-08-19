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

  it('reuses a ref for the same document target while refreshing its semantic state', () => {
    let id = 0;
    const store = new ElementRefStore({ create: () => `ref_${++id}` });

    const [first] = store.reconcileSnapshot(7, [ELEMENT]);
    const [second] = store.reconcileSnapshot(7, [{ ...ELEMENT, state: ['focusable', 'checked'] }]);

    expect(second).toBe(first);
    expect(store.resolve('ref_1', 7)).toMatchObject({
      backendNodeId: 42,
      state: ['focusable', 'checked'],
    });
  });

  it('issues a new ref when the document loader changes and removes the stale ref', () => {
    let id = 0;
    const store = new ElementRefStore({ create: () => `ref_${++id}` });

    const [first] = store.reconcileSnapshot(7, [ELEMENT]);
    const [second] = store.reconcileSnapshot(7, [{ ...ELEMENT, loaderId: 'loader-2' }]);

    expect(first).toBe('ref_1');
    expect(second).toBe('ref_2');
    expect(() => store.resolve('ref_1', 7)).toThrow(
      expect.objectContaining({ code: 'REF_NOT_FOUND' }),
    );
    expect(store.resolve('ref_2', 7)).toMatchObject({ loaderId: 'loader-2' });
  });

  it('updates known ref states even when the observed page has more than 200 targets', () => {
    const store = new ElementRefStore({ create: () => 'ref_known' });
    store.reconcileSnapshot(7, [ELEMENT]);
    const observed = [
      { ...ELEMENT, state: ['focusable', 'checked'] },
      ...Array.from({ length: 200 }, (_, index) => ({
        ...ELEMENT,
        backendNodeId: 1_000 + index,
        name: `Choice ${String(index)}`,
      })),
    ];

    expect(store.updateObservedStates(7, observed)).toEqual([
      {
        ref: 'ref_known',
        role: 'button',
        state: ['focusable', 'checked'],
        changed: true,
      },
    ]);
  });

  it('rebinds a ref when a uniquely named semantic target is recreated', () => {
    const store = new ElementRefStore({ create: () => 'ref_known' });
    store.reconcileSnapshot(7, [
      {
        ...ELEMENT,
        role: 'checkbox',
        name: 'A. TCE service upgrade',
        state: ['checked=false'],
        actions: ['click', 'set_checked'],
      },
    ]);

    expect(
      store.updateObservedStates(7, [
        {
          ...ELEMENT,
          backendNodeId: 77,
          role: 'checkbox',
          name: 'A. TCE service upgrade',
          state: ['checked'],
          actions: ['click', 'set_checked'],
        },
      ]),
    ).toEqual([
      {
        ref: 'ref_known',
        role: 'checkbox',
        state: ['checked'],
        changed: true,
      },
    ]);
    expect(store.resolve('ref_known', 7)).toMatchObject({
      backendNodeId: 77,
      state: ['checked'],
    });
  });

  it('does not rebind a recreated target when its semantic identity is ambiguous', () => {
    const store = new ElementRefStore({ create: () => 'ref_known' });
    store.reconcileSnapshot(7, [
      {
        ...ELEMENT,
        role: 'checkbox',
        name: 'Select answer',
        state: ['checked=false'],
        actions: ['click', 'set_checked'],
      },
    ]);

    expect(
      store.updateObservedStates(7, [
        {
          ...ELEMENT,
          backendNodeId: 77,
          role: 'checkbox',
          name: 'Select answer',
          state: ['checked'],
          actions: ['click', 'set_checked'],
        },
        {
          ...ELEMENT,
          backendNodeId: 78,
          role: 'checkbox',
          name: 'Select answer',
          state: ['checked=false'],
          actions: ['click', 'set_checked'],
        },
      ]),
    ).toEqual([]);
    expect(store.resolve('ref_known', 7)).toMatchObject({ backendNodeId: 42 });
  });
});
