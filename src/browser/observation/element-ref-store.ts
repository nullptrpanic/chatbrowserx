import type { IdGenerator } from '../../shared/ids';
import type { DebuggerSession } from '../debugger/debugger-transport';

export interface ViewportRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface InteractiveElement {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly state: readonly string[];
  readonly frame: string;
  readonly bounds: ViewportRect;
}

export interface ObservedElementTarget {
  readonly session: DebuggerSession;
  readonly backendNodeId: number;
  readonly role: string;
  readonly name: string;
  readonly state: readonly string[];
  readonly frame: string;
  readonly bounds: ViewportRect;
}

export interface ResolvedElementRef {
  readonly tabId: number;
  readonly generation: number;
  readonly session: DebuggerSession;
  readonly backendNodeId: number;
  readonly bounds: ViewportRect;
}

export type ElementRefStoreErrorCode =
  | 'REF_NOT_FOUND'
  | 'REF_SCOPE_MISMATCH'
  | 'STALE_REF'
  | 'AMBIGUOUS_TARGET'
  | 'REF_GENERATION_FAILED';

export class ElementRefStoreError extends Error {
  readonly code: ElementRefStoreErrorCode;

  constructor(code: ElementRefStoreErrorCode, message: string) {
    super(message);
    this.name = 'ElementRefStoreError';
    this.code = code;
  }
}

interface StoredElementRef extends ResolvedElementRef {
  readonly ref: string;
}

function targetKey(target: ObservedElementTarget): string {
  return `${target.session.tabId}:${target.session.sessionId ?? 'root'}:${target.backendNodeId}`;
}

/** Replaces generation-scoped element refs so stale model refs cannot target a new DOM. */
export class ElementRefStore {
  readonly #ids: Pick<IdGenerator, 'create'>;
  readonly #refs = new Map<string, StoredElementRef>();
  readonly #refsByTab = new Map<number, Set<string>>();

  constructor(ids: Pick<IdGenerator, 'create'>) {
    this.#ids = ids;
  }

  replaceSnapshot(
    tabId: number,
    generation: number,
    targets: readonly ObservedElementTarget[],
  ): readonly InteractiveElement[] {
    if (targets.length > 200) {
      throw new ElementRefStoreError('AMBIGUOUS_TARGET', 'The element snapshot is too large.');
    }
    const targetKeys = targets.map(targetKey);
    if (new Set(targetKeys).size !== targetKeys.length) {
      throw new ElementRefStoreError(
        'AMBIGUOUS_TARGET',
        'The element snapshot contains an ambiguous target.',
      );
    }

    this.invalidate(tabId);
    const tabRefs = new Set<string>();
    const elements = targets.map((target): InteractiveElement => {
      const ref = this.#createRef();
      this.#refs.set(ref, {
        ref,
        tabId,
        generation,
        session: { ...target.session },
        backendNodeId: target.backendNodeId,
        bounds: { ...target.bounds },
      });
      tabRefs.add(ref);
      return {
        ref,
        role: target.role,
        name: target.name,
        state: [...target.state],
        frame: target.frame,
        bounds: { ...target.bounds },
      };
    });
    this.#refsByTab.set(tabId, tabRefs);
    return elements;
  }

  resolve(ref: string, tabId: number, generation: number): ResolvedElementRef {
    const stored = this.#refs.get(ref);
    if (!stored) {
      throw new ElementRefStoreError('REF_NOT_FOUND', 'The element ref does not exist.');
    }
    if (stored.tabId !== tabId) {
      throw new ElementRefStoreError(
        'REF_SCOPE_MISMATCH',
        'The element ref belongs to a different tab.',
      );
    }
    if (stored.generation !== generation) {
      throw new ElementRefStoreError('STALE_REF', 'The element ref is stale.');
    }
    return {
      tabId: stored.tabId,
      generation: stored.generation,
      session: { ...stored.session },
      backendNodeId: stored.backendNodeId,
      bounds: { ...stored.bounds },
    };
  }

  invalidate(tabId: number): void {
    for (const ref of this.#refsByTab.get(tabId) ?? []) this.#refs.delete(ref);
    this.#refsByTab.delete(tabId);
  }

  #createRef(): string {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const ref = this.#ids.create('element').trim();
      if (ref.length > 0 && ref.length <= 128 && !this.#refs.has(ref)) return ref;
    }
    throw new ElementRefStoreError('REF_GENERATION_FAILED', 'An element ref could not be created.');
  }
}
