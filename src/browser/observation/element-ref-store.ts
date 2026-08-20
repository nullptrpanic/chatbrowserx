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
  readonly stateBackendNodeId?: number;
  readonly role: string;
  readonly name: string;
  readonly semanticLocator?: string;
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
  readonly stateBackendNodeId?: number;
  readonly role: string;
  readonly name: string;
  readonly semanticLocator?: string;
  readonly state: readonly string[];
  readonly actions: readonly string[];
}

export interface ObservedElementRefState {
  readonly ref: string;
  readonly role: string;
  readonly state: readonly string[];
  readonly changed: boolean;
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
  readonly name: string;
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

function targetKey(
  target: Pick<
    ObservedElementTarget,
    'frameTargetId' | 'documentFrameId' | 'loaderId' | 'backendNodeId'
  >,
): string {
  return `${target.frameTargetId ?? 'root'}:${target.documentFrameId}:${target.loaderId}:${String(target.backendNodeId)}`;
}

function semanticTargetKey(
  target: Pick<
    ObservedElementTarget,
    'frameTargetId' | 'documentFrameId' | 'loaderId' | 'role' | 'name' | 'semanticLocator'
  >,
): string {
  const locator = target.semanticLocator?.trim();
  return JSON.stringify([
    target.frameTargetId,
    target.documentFrameId,
    target.loaderId,
    ...(locator ? ['locator', locator] : ['semantic', target.role, target.name]),
  ]);
}

function validateTargetUniqueness(targets: readonly ObservedElementTarget[]): void {
  const targetKeys = targets.map(targetKey);
  if (new Set(targetKeys).size !== targetKeys.length) {
    throw new ElementRefStoreError(
      'AMBIGUOUS_TARGET',
      'The element snapshot contains an ambiguous target.',
    );
  }
}

function validateSnapshotTargets(targets: readonly ObservedElementTarget[]): void {
  if (targets.length > 200) {
    throw new ElementRefStoreError('AMBIGUOUS_TARGET', 'The element snapshot is too large.');
  }
  validateTargetUniqueness(targets);
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
    validateSnapshotTargets(targets);

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
        ...(target.stateBackendNodeId === undefined
          ? {}
          : { stateBackendNodeId: target.stateBackendNodeId }),
        role: target.role,
        name: target.name,
        ...(target.semanticLocator === undefined
          ? {}
          : { semanticLocator: target.semanticLocator }),
        state: [...target.state],
        actions: [...target.actions],
      });
      tabRefs.add(ref);
      return ref;
    });
    this.#refsByTab.set(tabId, tabRefs);
    return refs;
  }

  reconcileSnapshot(tabId: number, targets: readonly ObservedElementTarget[]): readonly string[] {
    validateSnapshotTargets(targets);
    const existingByTarget = new Map<string, string>();
    const existingBySemanticTarget = new Map<string, string[]>();
    for (const ref of this.#refsByTab.get(tabId) ?? []) {
      const stored = this.#refs.get(ref);
      if (!stored) continue;
      existingByTarget.set(targetKey(stored), ref);
      const semanticKey = semanticTargetKey(stored);
      const semanticRefs = existingBySemanticTarget.get(semanticKey) ?? [];
      semanticRefs.push(ref);
      existingBySemanticTarget.set(semanticKey, semanticRefs);
    }
    const incomingSemanticCounts = new Map<string, number>();
    for (const target of targets) {
      const semanticKey = semanticTargetKey(target);
      incomingSemanticCounts.set(semanticKey, (incomingSemanticCounts.get(semanticKey) ?? 0) + 1);
    }

    const nextRefs = new Set<string>();
    const refs = targets.map((target): string => {
      const semanticKey = semanticTargetKey(target);
      const semanticRefs = existingBySemanticTarget.get(semanticKey) ?? [];
      const exactRef = existingByTarget.get(targetKey(target));
      const semanticRef =
        incomingSemanticCounts.get(semanticKey) === 1 && semanticRefs.length === 1
          ? semanticRefs[0]
          : undefined;
      const reusableRef = exactRef ?? semanticRef;
      const ref =
        reusableRef !== undefined && !nextRefs.has(reusableRef) ? reusableRef : this.#createRef();
      this.#refs.set(ref, {
        ref,
        tabId,
        frameTargetId: target.frameTargetId,
        documentFrameId: target.documentFrameId,
        loaderId: target.loaderId,
        backendNodeId: target.backendNodeId,
        ...(target.stateBackendNodeId === undefined
          ? {}
          : { stateBackendNodeId: target.stateBackendNodeId }),
        role: target.role,
        name: target.name,
        ...(target.semanticLocator === undefined
          ? {}
          : { semanticLocator: target.semanticLocator }),
        state: [...target.state],
        actions: [...target.actions],
      });
      nextRefs.add(ref);
      return ref;
    });

    for (const ref of this.#refsByTab.get(tabId) ?? []) {
      if (!nextRefs.has(ref)) this.#refs.delete(ref);
    }
    this.#refsByTab.set(tabId, nextRefs);
    return refs;
  }

  /** Updates states for already-issued refs without dropping targets from other frames. */
  updateObservedStates(
    tabId: number,
    targets: readonly ObservedElementTarget[],
  ): readonly ObservedElementRefState[] {
    validateTargetUniqueness(targets);
    const observedByTarget = new Map(targets.map((target) => [targetKey(target), target]));
    const observedBySemanticTarget = new Map<string, ObservedElementTarget[]>();
    for (const target of targets) {
      const key = semanticTargetKey(target);
      const candidates = observedBySemanticTarget.get(key) ?? [];
      candidates.push(target);
      observedBySemanticTarget.set(key, candidates);
    }
    const storedSemanticCounts = new Map<string, number>();
    for (const ref of this.#refsByTab.get(tabId) ?? []) {
      const stored = this.#refs.get(ref);
      if (!stored) continue;
      const key = semanticTargetKey(stored);
      storedSemanticCounts.set(key, (storedSemanticCounts.get(key) ?? 0) + 1);
    }
    const observations: ObservedElementRefState[] = [];
    for (const ref of this.#refsByTab.get(tabId) ?? []) {
      const stored = this.#refs.get(ref);
      if (!stored) continue;
      const semanticKey = semanticTargetKey(stored);
      const semanticCandidates = observedBySemanticTarget.get(semanticKey) ?? [];
      const observed =
        observedByTarget.get(targetKey(stored)) ??
        (storedSemanticCounts.get(semanticKey) === 1 && semanticCandidates.length === 1
          ? semanticCandidates[0]
          : undefined);
      if (!observed) continue;
      const changed = JSON.stringify(stored.state) !== JSON.stringify(observed.state);
      const {
        semanticLocator: _storedSemanticLocator,
        stateBackendNodeId: _storedStateBackendNodeId,
        ...stable
      } = stored;
      void _storedSemanticLocator;
      void _storedStateBackendNodeId;
      this.#refs.set(ref, {
        ...stable,
        backendNodeId: observed.backendNodeId,
        ...(observed.stateBackendNodeId === undefined
          ? {}
          : { stateBackendNodeId: observed.stateBackendNodeId }),
        role: observed.role,
        name: observed.name,
        ...(observed.semanticLocator === undefined
          ? {}
          : { semanticLocator: observed.semanticLocator }),
        state: [...observed.state],
        actions: [...observed.actions],
      });
      observations.push({
        ref,
        role: observed.role,
        state: [...observed.state],
        changed,
      });
    }
    return observations;
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
      ...(stored.stateBackendNodeId === undefined
        ? {}
        : { stateBackendNodeId: stored.stateBackendNodeId }),
      role: stored.role,
      name: stored.name,
      ...(stored.semanticLocator === undefined ? {} : { semanticLocator: stored.semanticLocator }),
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
