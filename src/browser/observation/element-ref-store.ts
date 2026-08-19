import type { IdGenerator } from '../../shared/ids';

export interface ViewportRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ObservedElementTarget {
  readonly frameTargetId: string | null;
  readonly documentFrameId: string;
  readonly loaderId: string;
  readonly backendNodeId: number;
  readonly role: string;
  readonly name: string;
  readonly state: readonly string[];
  readonly actions: readonly string[];
  readonly frame: string;
}

export interface ResolvedElementRef {
  readonly tabId: number;
  readonly frameTargetId: string | null;
  readonly documentFrameId: string;
  readonly loaderId: string;
  readonly backendNodeId: number;
  readonly role: string;
  readonly state: readonly string[];
  readonly actions: readonly string[];
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

const MAX_PASSTHROUGH_REF_CHARACTERS = 16;
const FNV_64_OFFSET = 0xcbf29ce484222325n;
const FNV_64_PRIME = 0x100000001b3n;

function compactRef(value: string): string {
  if (value.length <= MAX_PASSTHROUGH_REF_CHARACTERS && /^[a-z0-9_-]+$/i.test(value)) {
    return value;
  }
  let hash = FNV_64_OFFSET;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * FNV_64_PRIME);
  }
  return `e${hash.toString(36)}`;
}

function targetKey(target: ObservedElementTarget): string {
  return `${target.frameTargetId ?? 'root'}:${target.documentFrameId}:${target.backendNodeId}`;
}

/** Stores opaque refs against document identity rather than an ephemeral debugger attachment. */
export class ElementRefStore {
  readonly #ids: Pick<IdGenerator, 'create'>;
  readonly #refs = new Map<string, StoredElementRef>();
  readonly #refsByTab = new Map<number, Set<string>>();
  readonly #issuedRefs = new Set<string>();

  constructor(ids: Pick<IdGenerator, 'create'>) {
    this.#ids = ids;
  }

  replaceSnapshot(tabId: number, targets: readonly ObservedElementTarget[]): readonly string[] {
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
    const refs = targets.map((target): string => {
      const ref = this.#createRef();
      this.#refs.set(ref, {
        ref,
        tabId,
        frameTargetId: target.frameTargetId,
        documentFrameId: target.documentFrameId,
        loaderId: target.loaderId,
        backendNodeId: target.backendNodeId,
        role: target.role,
        state: [...target.state],
        actions: [...target.actions],
      });
      tabRefs.add(ref);
      return ref;
    });
    this.#refsByTab.set(tabId, tabRefs);
    return refs;
  }

  resolve(ref: string, tabId: number): ResolvedElementRef {
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
    return {
      tabId: stored.tabId,
      frameTargetId: stored.frameTargetId,
      documentFrameId: stored.documentFrameId,
      loaderId: stored.loaderId,
      backendNodeId: stored.backendNodeId,
      role: stored.role,
      state: [...stored.state],
      actions: [...stored.actions],
    };
  }

  invalidate(tabId: number): void {
    for (const ref of this.#refsByTab.get(tabId) ?? []) this.#refs.delete(ref);
    this.#refsByTab.delete(tabId);
  }

  #createRef(): string {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const source = this.#ids.create('element').trim();
      if (source.length === 0 || source.length > 128) continue;
      const ref = compactRef(source);
      if (ref.length > 128 || this.#issuedRefs.has(ref)) continue;
      this.#issuedRefs.add(ref);
      return ref;
    }
    throw new ElementRefStoreError('REF_GENERATION_FAILED', 'An element ref could not be created.');
  }
}
