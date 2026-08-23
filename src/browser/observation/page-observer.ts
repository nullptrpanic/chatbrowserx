import type { Protocol } from 'devtools-protocol';
import type { AttachmentSource } from '../../attachments/attachment-types';
import type { DebuggerSession, DebuggerTransport } from '../debugger/debugger-transport';
import type { TargetSessionRegistry } from '../debugger/target-session-registry';
import type { ReadablePageContent } from './content-extractor';
import type { ElementRefStore, ObservedElementTarget } from './element-ref-store';
import { mapConcurrentOrdered } from './bounded-map';
import { prepareModelScreenshot } from './model-screenshot';
import {
  SEMANTIC_SNAPSHOT_STYLES,
  buildSemanticPageSnapshot,
  type SemanticAction,
  type SemanticPageEntry,
  type SemanticScrollMetrics,
} from './semantic-page-snapshot';

const INTERACTIVE_BUDGET = {
  elements: 240,
  targets: 120,
  characters: 32_000,
} as const;
const DEEP_INTERACTIVE_BUDGET = {
  elements: 500,
  targets: 200,
  characters: 60_000,
} as const;
const MAX_INTERACTIVE_SNAPSHOT_TABS = 50;
const MAX_SESSION_OBSERVATION_CONCURRENCY = 3;
const INTERACTIVE_ENTRY_KEYS =
  'd=depth,r=role(default generic),n=name,s=state,a=extra actions(ref defaults click),f=frame';
const MAX_CONTENT_CHARACTERS = 40_000;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

export interface PageObservationContentPort {
  readContent(tabId: number): Promise<ReadablePageContent>;
  setOverlaysHidden(tabId: number, hidden: boolean): Promise<void>;
}

export interface PageObservationResult {
  readonly tabId: number;
  readonly url: string | null;
  readonly data: Readonly<Record<string, unknown>>;
  readonly observation: null;
  readonly attachmentIds: readonly string[];
  readonly debuggerSession: 'none' | 'ephemeral';
  /** Internal AX-first policy signal; it is not serialized into the model-visible result. */
  readonly visualFallbackAllowed?: boolean;
}

export interface PageObserverDependencies {
  readonly sessions: Pick<TargetSessionRegistry, 'ensure'>;
  readonly transport: DebuggerTransport;
  readonly content: PageObservationContentPort;
  readonly refs: ElementRefStore;
  readonly persistScreenshot?: (
    blob: Blob,
    source: Extract<AttachmentSource, 'viewport_capture' | 'visual_fallback'>,
  ) => Promise<{ readonly id: string }>;
}

interface CompactSemanticPageEntry {
  readonly d: number;
  readonly r?: string;
  readonly n: string;
  readonly s?: readonly string[];
  readonly a?: readonly SemanticAction[];
  readonly f?: string;
  readonly ref?: string;
}

export interface PageInspectionOptions {
  readonly since?: string;
}

interface InteractiveSnapshot {
  readonly id: string;
  readonly documentEpoch: string;
  readonly elements: readonly CompactSemanticPageEntry[];
  readonly identities: readonly string[] | null;
  readonly coverage?: InteractiveCoverage;
}

interface InteractiveCoverage {
  readonly scope: 'viewport';
  readonly complete: false;
  readonly moreBefore: boolean | 'unknown';
  readonly moreAfter: boolean | 'unknown';
  readonly targets: readonly string[];
  readonly primaryTarget?: string;
  readonly recommendedAction: 'browser_scroll_until';
  readonly contentKey: string;
}

function compactSemanticEntry(entry: SemanticPageEntry, ref?: string): CompactSemanticPageEntry {
  const extraActions = entry.actions?.filter((action) => action !== 'click');
  return {
    d: entry.depth,
    ...(entry.role === 'generic' ? {} : { r: entry.role }),
    n: entry.name,
    ...(entry.state === undefined ? {} : { s: entry.state }),
    ...(extraActions === undefined || extraActions.length === 0 ? {} : { a: extraActions }),
    ...(entry.frame === undefined ? {} : { f: entry.frame }),
    ...(ref === undefined ? {} : { ref }),
  };
}

function createInteractiveSnapshotId(): string {
  return `s${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

function compactEntryIdentities(
  elements: readonly CompactSemanticPageEntry[],
  nativeIdentities: readonly string[],
): readonly string[] | null {
  if (elements.length !== nativeIdentities.length) return null;
  const identities = elements.map((entry, index) =>
    entry.ref ? `ref:${entry.ref}` : `node:${nativeIdentities[index] ?? ''}`,
  );
  return identities.every((identity) => !identity.endsWith(':')) &&
    new Set(identities).size === identities.length
    ? identities
    : null;
}

interface KeyedInteractiveDelta {
  readonly unchanged?: true;
  readonly upsert?: readonly Readonly<{
    k: string;
    e: CompactSemanticPageEntry;
  }>[];
  readonly remove?: readonly string[];
}

function keyedInteractiveDelta(
  previous: InteractiveSnapshot,
  current: InteractiveSnapshot,
): KeyedInteractiveDelta | null {
  if (
    previous.documentEpoch !== current.documentEpoch ||
    previous.identities === null ||
    current.identities === null
  ) {
    return null;
  }
  const previousByIdentity = new Map(
    previous.identities.map((identity, index) => [identity, previous.elements[index]]),
  );
  const currentByIdentity = new Map(
    current.identities.map((identity, index) => [identity, current.elements[index]]),
  );
  const upsert = current.identities.flatMap((identity, index) => {
    const entry = current.elements[index];
    if (!entry || JSON.stringify(previousByIdentity.get(identity)) === JSON.stringify(entry)) {
      return [];
    }
    return [{ k: identity, e: entry }];
  });
  const remove = previous.identities.filter((identity) => !currentByIdentity.has(identity));
  const changedIdentityCount = upsert.length + remove.length;
  if (changedIdentityCount === 0) return { unchanged: true };
  return {
    ...(upsert.length === 0 ? {} : { upsert }),
    ...(remove.length === 0 ? {} : { remove }),
  };
}

/** Gives deep inspection's bounded budget to actionable entries and their nearby context first. */
function interactiveCandidateIndexes(
  entries: readonly SemanticPageEntry[],
  deep: boolean,
): readonly number[] {
  if (!deep) {
    const priority = (entry: SemanticPageEntry): number => {
      if (entry.actions?.includes('scroll')) return -1;
      if (entry.inViewport && entry.targetIndex !== undefined) return 0;
      if (entry.inViewport) return 1;
      if (
        entry.state?.some((state) =>
          ['focused', 'selected', 'checked', 'invalid'].includes(state.split('=', 1)[0] ?? ''),
        )
      ) {
        return 2;
      }
      return entry.targetIndex === undefined ? 4 : 3;
    };
    return entries
      .map((_entry, index) => index)
      .toSorted((left, right) => {
        const leftEntry = entries[left];
        const rightEntry = entries[right];
        if (!leftEntry || !rightEntry) return left - right;
        return priority(leftEntry) - priority(rightEntry) || left - right;
      });
  }
  const indexes: number[] = [];
  const included = new Set<number>();
  const include = (index: number): void => {
    if (index < 0 || index >= entries.length || included.has(index)) return;
    included.add(index);
    indexes.push(index);
  };
  entries.forEach((entry, index) => {
    if (entry.targetIndex === undefined) return;
    include(index - 2);
    include(index - 1);
    include(index);
    include(index + 1);
  });
  entries.forEach((_entry, index) => include(index));
  return indexes;
}

function viewportFromLayoutMetrics(
  metrics: Partial<Protocol.Page.GetLayoutMetricsResponse>,
): BuildViewport | undefined {
  const viewport = metrics.visualViewport ?? metrics.layoutViewport;
  if (!viewport) return undefined;
  const { pageX, pageY, clientWidth, clientHeight } = viewport;
  if (
    ![pageX, pageY, clientWidth, clientHeight].every(
      (value) => typeof value === 'number' && Number.isFinite(value),
    ) ||
    clientWidth <= 0 ||
    clientHeight <= 0
  ) {
    return undefined;
  }
  return { x: pageX, y: pageY, width: clientWidth, height: clientHeight };
}

interface BuildViewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface DocumentViewportCoverage {
  readonly moreBefore: boolean;
  readonly moreAfter: boolean;
  readonly scrollMetrics: SemanticScrollMetrics;
}

function documentViewportCoverage(
  metrics: Partial<Protocol.Page.GetLayoutMetricsResponse>,
): DocumentViewportCoverage | undefined {
  const viewport = metrics.visualViewport ?? metrics.layoutViewport;
  const content = metrics.contentSize;
  if (!viewport || !content) return undefined;
  const values = [
    viewport.pageX,
    viewport.pageY,
    viewport.clientWidth,
    viewport.clientHeight,
    content.width,
    content.height,
  ];
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    return undefined;
  }
  const maxX = Math.max(0, content.width - viewport.clientWidth);
  const maxY = Math.max(0, content.height - viewport.clientHeight);
  const moreBefore = viewport.pageX > 1 || viewport.pageY > 1;
  const moreAfter = viewport.pageX < maxX - 1 || viewport.pageY < maxY - 1;
  return moreBefore || moreAfter
    ? {
        moreBefore,
        moreAfter,
        scrollMetrics: {
          bounds: [viewport.pageX, viewport.pageY, viewport.clientWidth, viewport.clientHeight],
          clientWidth: Math.max(0, viewport.clientWidth),
          clientHeight: Math.max(0, viewport.clientHeight),
          scrollWidth: Math.max(0, content.width),
          scrollHeight: Math.max(0, content.height),
        },
      }
    : undefined;
}

interface InteractiveScrollTarget {
  readonly ref: string;
  readonly name: string;
  readonly depth: number;
  readonly metrics?: SemanticScrollMetrics;
}

interface RankedScrollTarget extends InteractiveScrollTarget {
  readonly order: number;
  readonly span: number;
  readonly clientExtent: number;
  readonly score: number;
}

function scrollSpan(metrics: SemanticScrollMetrics | undefined): number {
  if (metrics === undefined) return 0;
  return Math.max(
    Math.max(0, metrics.scrollHeight - metrics.clientHeight),
    Math.max(0, metrics.scrollWidth - metrics.clientWidth),
  );
}

function nearIdenticalScrollGeometry(
  left: SemanticScrollMetrics | undefined,
  right: SemanticScrollMetrics | undefined,
): boolean {
  if (left?.bounds === undefined || right?.bounds === undefined) return false;
  const [leftX, leftY, leftWidth, leftHeight] = left.bounds;
  const [rightX, rightY, rightWidth, rightHeight] = right.bounds;
  const leftArea = Math.max(0, leftWidth) * Math.max(0, leftHeight);
  const rightArea = Math.max(0, rightWidth) * Math.max(0, rightHeight);
  const sharedWidth = Math.max(
    0,
    Math.min(leftX + leftWidth, rightX + rightWidth) - Math.max(leftX, rightX),
  );
  const sharedHeight = Math.max(
    0,
    Math.min(leftY + leftHeight, rightY + rightHeight) - Math.max(leftY, rightY),
  );
  const smallerArea = Math.min(leftArea, rightArea);
  if (smallerArea <= 0 || (sharedWidth * sharedHeight) / smallerArea < 0.92) return false;
  const leftSpan = scrollSpan(left);
  const rightSpan = scrollSpan(right);
  return (
    Math.min(leftSpan, rightSpan) >= 64 &&
    Math.min(leftSpan, rightSpan) / Math.max(leftSpan, rightSpan) >= 0.8
  );
}

function relatedScrollNames(left: string, right: string): boolean {
  const normalizedLeft = left.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
  const normalizedRight = right.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
  if (normalizedLeft === normalizedRight) return normalizedLeft.length > 0;
  const shorter =
    normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight;
  const longer = shorter === normalizedLeft ? normalizedRight : normalizedLeft;
  return shorter.length >= 8 && longer.includes(shorter);
}

/** Drops only a shallower duplicate of the same nested scroll surface. */
function canonicalScrollTargets(
  targets: readonly InteractiveScrollTarget[],
): readonly InteractiveScrollTarget[] {
  return targets.filter(
    (candidate) =>
      !targets.some(
        (other) =>
          other.ref !== candidate.ref &&
          other.depth > candidate.depth &&
          relatedScrollNames(candidate.name, other.name) &&
          nearIdenticalScrollGeometry(candidate.metrics, other.metrics),
      ),
  );
}

function rankedScrollTargets(
  targets: readonly InteractiveScrollTarget[],
): readonly RankedScrollTarget[] {
  return targets
    .map((target, order): RankedScrollTarget => {
      const verticalSpan = Math.max(
        0,
        (target.metrics?.scrollHeight ?? 0) - (target.metrics?.clientHeight ?? 0),
      );
      const horizontalSpan = Math.max(
        0,
        (target.metrics?.scrollWidth ?? 0) - (target.metrics?.clientWidth ?? 0),
      );
      const vertical = verticalSpan >= horizontalSpan;
      const span = vertical ? verticalSpan : horizontalSpan;
      const clientExtent = vertical
        ? (target.metrics?.clientHeight ?? 0)
        : (target.metrics?.clientWidth ?? 0);
      const crossExtent = vertical
        ? (target.metrics?.clientWidth ?? 0)
        : (target.metrics?.clientHeight ?? 0);
      return {
        ...target,
        order,
        span,
        clientExtent,
        score: span * Math.max(1, crossExtent),
      };
    })
    .toSorted((left, right) => right.score - left.score || left.order - right.order);
}

function primaryScrollTarget(targets: readonly RankedScrollTarget[]): string | undefined {
  const first = targets[0];
  if (!first) return undefined;
  if (targets.length === 1) return first.ref;
  const second = targets[1];
  if (
    first.span < Math.max(64, first.clientExtent / 2) ||
    first.score <= 0 ||
    second === undefined ||
    first.score < second.score * 2.5
  ) {
    return undefined;
  }
  return first.ref;
}

function semanticContentKey(elements: readonly CompactSemanticPageEntry[]): string {
  const value = JSON.stringify(
    elements.map((entry) => [entry.r ?? 'generic', entry.n, entry.s ?? [], entry.f ?? 'main']),
  );
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function interactiveCoverage(
  elements: readonly CompactSemanticPageEntry[],
  documentCoverage: DocumentViewportCoverage | undefined,
  elementMetrics: ReadonlyMap<string, SemanticScrollMetrics>,
): InteractiveCoverage | undefined {
  const candidates: InteractiveScrollTarget[] = [];
  const seen = new Set<string>();
  const include = (
    ref: string,
    metrics: SemanticScrollMetrics | undefined,
    name: string,
    depth: number,
  ): void => {
    if (seen.has(ref)) return;
    seen.add(ref);
    candidates.push({ ref, name, depth, ...(metrics === undefined ? {} : { metrics }) });
  };
  if (documentCoverage !== undefined) {
    candidates.push({
      ref: 'viewport',
      name: 'Document viewport',
      depth: -1,
      metrics: documentCoverage.scrollMetrics,
    });
    seen.add('viewport');
  }
  for (const entry of elements) {
    if (entry.ref && entry.a?.includes('scroll')) {
      include(entry.ref, elementMetrics.get(entry.ref), entry.n, entry.d);
    }
  }
  const ranked = rankedScrollTargets(canonicalScrollTargets(candidates));
  if (ranked.length === 0) return undefined;
  const targets = ranked.map(({ ref }) => ref);
  const primaryTarget = primaryScrollTarget(ranked);
  return {
    scope: 'viewport',
    complete: false,
    moreBefore: documentCoverage?.moreBefore ?? 'unknown',
    moreAfter: documentCoverage?.moreAfter ?? 'unknown',
    targets,
    ...(primaryTarget === undefined ? {} : { primaryTarget }),
    recommendedAction: 'browser_scroll_until',
    contentKey: semanticContentKey(elements),
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Page observation was aborted.', 'AbortError');
}

function screenshotPng(base64: string): Blob {
  if (base64.length === 0 || base64.length > Math.ceil((MAX_SCREENSHOT_BYTES * 4) / 3) + 4) {
    throw new Error('Browser screenshot is invalid.');
  }
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error('Browser screenshot is invalid.');
  }
  if (
    binary.length === 0 ||
    binary.length > MAX_SCREENSHOT_BYTES ||
    PNG_SIGNATURE.some((byte, index) => binary.charCodeAt(index) !== byte)
  ) {
    throw new Error('Browser screenshot is invalid.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: 'image/png' });
}

/** Builds lightweight content or compact native AX snapshots across flattened CDP sessions. */
export class PageObserver {
  readonly #dependencies: PageObserverDependencies;
  readonly #interactiveSnapshots = new Map<number, InteractiveSnapshot>();

  constructor(dependencies: PageObserverDependencies) {
    this.#dependencies = dependencies;
  }

  /** Drops model-visible delta bases so the next interactive inspection returns a full tree. */
  invalidateInteractiveSnapshots(): void {
    this.#interactiveSnapshots.clear();
  }

  async inspect(
    tabId: number,
    mode: 'content' | 'interactive' | 'interactive_deep' | 'screenshot',
    signal: AbortSignal,
    options: PageInspectionOptions = {},
  ): Promise<PageObservationResult> {
    throwIfAborted(signal);
    if (mode === 'content') return this.#inspectContent(tabId, signal);
    if (mode === 'interactive' || mode === 'interactive_deep') {
      return this.#inspectInteractive(tabId, mode === 'interactive_deep', signal, options);
    }
    return this.#inspectScreenshot(tabId, signal, 'visual_fallback');
  }

  /** Captures one task-owned viewport image without changing model-vision fallback state. */
  async capture(tabId: number, signal: AbortSignal): Promise<PageObservationResult> {
    throwIfAborted(signal);
    return this.#inspectScreenshot(tabId, signal, 'viewport_capture');
  }

  async #inspectScreenshot(
    tabId: number,
    signal: AbortSignal,
    source: Extract<AttachmentSource, 'viewport_capture' | 'visual_fallback'>,
  ): Promise<PageObservationResult> {
    const persist = this.#dependencies.persistScreenshot;
    if (!persist) throw new Error('Screenshot persistence is unavailable.');
    const browserSession = await this.#dependencies.sessions.ensure(tabId, signal);
    throwIfAborted(signal);
    let overlayHideAttempted = false;
    try {
      overlayHideAttempted = true;
      try {
        await this.#dependencies.content.setOverlaysHidden(tabId, true);
      } catch {
        // Extension-owned visual feedback is best-effort and must not block CDP capture.
      }
      throwIfAborted(signal);
      const [metrics, captured, metadata] = await Promise.all([
        this.#dependencies.transport.send<Protocol.Page.GetLayoutMetricsResponse>(
          browserSession.root,
          'Page.getLayoutMetrics',
        ),
        this.#dependencies.transport.send<Protocol.Page.CaptureScreenshotResponse>(
          browserSession.root,
          'Page.captureScreenshot',
          {
            format: 'png',
            fromSurface: true,
            captureBeyondViewport: false,
            optimizeForSpeed: true,
          },
        ),
        this.#pageMetadata(browserSession.root),
      ]);
      throwIfAborted(signal);
      const blob = screenshotPng(captured.data);
      const viewportWidth = Math.max(1, Math.round(metrics.visualViewport.clientWidth));
      const viewportHeight = Math.max(1, Math.round(metrics.visualViewport.clientHeight));
      const prepared = await prepareModelScreenshot(blob);
      const attachment = await persist(prepared.blob, source);
      if (attachment.id.trim().length === 0 || attachment.id.length > 256) {
        throw new Error('Screenshot persistence returned an invalid reference.');
      }
      return {
        tabId,
        url: metadata.url,
        data: {
          mode: 'screenshot',
          mimeType: 'image/png',
          width: prepared.width,
          height: prepared.height,
          viewportWidth,
          viewportHeight,
          attachmentId: attachment.id,
        },
        observation: null,
        attachmentIds: [attachment.id],
        debuggerSession: 'ephemeral',
      };
    } finally {
      if (overlayHideAttempted) {
        await this.#dependencies.content.setOverlaysHidden(tabId, false).catch(() => undefined);
      }
    }
  }

  async #inspectContent(tabId: number, signal: AbortSignal): Promise<PageObservationResult> {
    const top = await this.#dependencies.content.readContent(tabId);
    throwIfAborted(signal);
    return {
      tabId,
      url: top.url || null,
      data: {
        mode: 'content',
        title: top.title,
        url: top.url,
        text: top.text.slice(0, MAX_CONTENT_CHARACTERS),
        headings: top.headings.slice(0, 100),
        links: top.links.slice(0, 100),
        frames: [],
        truncated: top.truncated || top.text.length > MAX_CONTENT_CHARACTERS,
      },
      observation: null,
      attachmentIds: [],
      debuggerSession: 'none',
    };
  }

  async #inspectInteractive(
    tabId: number,
    deep: boolean,
    signal: AbortSignal,
    options: PageInspectionOptions,
  ): Promise<PageObservationResult> {
    const browserSession = await this.#dependencies.sessions.ensure(tabId, signal);
    throwIfAborted(signal);
    const targets: (ObservedElementTarget & { readonly scrollMetrics?: SemanticScrollMetrics })[] =
      [];
    const entries: SemanticPageEntry[] = [];
    const documentEpochParts: string[] = [];
    let mainDocumentCoverage: DocumentViewportCoverage | undefined;
    let hasVisualSurface = false;
    const sessionTargets: readonly {
      session: DebuggerSession;
      frame: string;
      frameTargetId: string | null;
    }[] = [
      { session: browserSession.root, frame: 'main', frameTargetId: null },
      ...[...browserSession.children.values()].map((child) => ({
        session: child.session,
        frame: child.targetId,
        frameTargetId: child.targetId,
      })),
    ];

    const sessionObservations = await mapConcurrentOrdered(
      sessionTargets,
      MAX_SESSION_OBSERVATION_CONCURRENCY,
      async (sessionTarget) => {
        throwIfAborted(signal);
        const [tree, domSnapshot, frameTree, metrics] = await Promise.all([
          this.#dependencies.transport.send<Protocol.Accessibility.GetFullAXTreeResponse>(
            sessionTarget.session,
            'Accessibility.getFullAXTree',
          ),
          this.#dependencies.transport.send<Protocol.DOMSnapshot.CaptureSnapshotResponse>(
            sessionTarget.session,
            'DOMSnapshot.captureSnapshot',
            {
              computedStyles: [...SEMANTIC_SNAPSHOT_STYLES],
              includeDOMRects: true,
              includePaintOrder: true,
            },
          ),
          this.#dependencies.transport.send<Protocol.Page.GetFrameTreeResponse>(
            sessionTarget.session,
            'Page.getFrameTree',
          ),
          this.#dependencies.transport
            .send<Protocol.Page.GetLayoutMetricsResponse>(
              sessionTarget.session,
              'Page.getLayoutMetrics',
            )
            .catch(() => ({}) as Protocol.Page.GetLayoutMetricsResponse),
        ]);
        const loaders = this.#frameLoaders(frameTree.frameTree);
        const viewport = viewportFromLayoutMetrics(metrics);
        return {
          sessionTarget,
          loaders,
          metrics,
          semantic: buildSemanticPageSnapshot({
            axNodes: tree.nodes,
            domSnapshot,
            frame: sessionTarget.frame,
            ...(viewport === undefined ? {} : { viewport }),
          }),
        };
      },
    );

    for (const { sessionTarget, loaders, metrics, semantic } of sessionObservations) {
      documentEpochParts.push(
        JSON.stringify([
          sessionTarget.frame,
          [...loaders.entries()].toSorted(([left], [right]) => left.localeCompare(right)),
        ]),
      );
      if (sessionTarget.frame === 'main') {
        mainDocumentCoverage = documentViewportCoverage(metrics);
      }
      hasVisualSurface ||= semantic.hasVisualSurface;
      const localTargetIndexes = new Map<number, number>();
      semantic.targets.forEach((target, localIndex) => {
        const loaderId = loaders.get(target.documentFrameId);
        if (!loaderId) return;
        localTargetIndexes.set(localIndex, targets.length);
        targets.push({
          frameTargetId: sessionTarget.frameTargetId,
          documentFrameId: target.documentFrameId,
          loaderId,
          backendNodeId: target.backendNodeId,
          ...(target.stateBackendNodeId === undefined
            ? {}
            : { stateBackendNodeId: target.stateBackendNodeId }),
          role: target.role,
          name: target.name,
          semanticLocator: target.semanticLocator,
          state: target.state,
          actions: target.actions,
          frame: sessionTarget.frame,
          ...(target.scrollMetrics === undefined ? {} : { scrollMetrics: target.scrollMetrics }),
        });
      });
      entries.push(
        ...semantic.entries.map((entry) => {
          if (entry.targetIndex === undefined) return entry;
          const targetIndex = localTargetIndexes.get(entry.targetIndex);
          if (targetIndex === undefined) {
            const { targetIndex: _targetIndex, actions: _actions, ...passive } = entry;
            void _targetIndex;
            void _actions;
            return passive;
          }
          return { ...entry, targetIndex };
        }),
      );
    }

    const originalCount = entries.length;
    const budget = deep ? DEEP_INTERACTIVE_BUDGET : INTERACTIVE_BUDGET;
    const selectedEntryIndexes: number[] = [];
    const usedTargetIndexes = new Set<number>();
    let serializedCharacters = JSON.stringify({ mode: 'interactive', elements: [] }).length;
    for (const entryIndex of interactiveCandidateIndexes(entries, deep)) {
      if (selectedEntryIndexes.length >= budget.elements) break;
      const entry = entries[entryIndex];
      if (!entry) continue;
      if (
        entry.targetIndex !== undefined &&
        !usedTargetIndexes.has(entry.targetIndex) &&
        usedTargetIndexes.size >= budget.targets
      ) {
        continue;
      }
      const entryCharacters = JSON.stringify(entry).length + (selectedEntryIndexes.length ? 1 : 0);
      if (serializedCharacters + entryCharacters > budget.characters) break;
      selectedEntryIndexes.push(entryIndex);
      serializedCharacters += entryCharacters;
      if (entry.targetIndex !== undefined) usedTargetIndexes.add(entry.targetIndex);
    }
    const boundedEntries = selectedEntryIndexes
      .toSorted((left, right) => left - right)
      .flatMap((index) => (entries[index] === undefined ? [] : [entries[index]]));
    const selectedTargetIndexes: number[] = [];
    const selectedTargets: ObservedElementTarget[] = [];
    for (const targetIndex of usedTargetIndexes) {
      const target = targets[targetIndex];
      if (!target) continue;
      selectedTargetIndexes.push(targetIndex);
      selectedTargets.push(target);
    }
    const refs = this.#dependencies.refs.reconcileSnapshot(tabId, selectedTargets);
    const refByTargetIndex = new Map(
      selectedTargetIndexes.map((targetIndex, index) => [targetIndex, refs[index] ?? '']),
    );
    const elements = boundedEntries.map((entry) => {
      const ref =
        entry.targetIndex === undefined ? undefined : refByTargetIndex.get(entry.targetIndex);
      return compactSemanticEntry(entry, ref || undefined);
    });
    const visibleElements = elements.filter(
      (_entry, index) => boundedEntries[index]?.inViewport !== false,
    );
    const scrollMetricsByRef = new Map<string, SemanticScrollMetrics>();
    selectedTargetIndexes.forEach((targetIndex, index) => {
      const ref = refs[index];
      const metrics = targets[targetIndex]?.scrollMetrics;
      if (ref && metrics) scrollMetricsByRef.set(ref, metrics);
    });
    const coverage = interactiveCoverage(visibleElements, mainDocumentCoverage, scrollMetricsByRef);
    const metadata = await this.#pageMetadata(browserSession.root);
    const snapshotId = createInteractiveSnapshotId();
    const truncated = boundedEntries.length < originalCount;
    const previous = this.#interactiveSnapshots.get(tabId);
    const current: InteractiveSnapshot = {
      id: snapshotId,
      documentEpoch: JSON.stringify(documentEpochParts),
      elements,
      identities: compactEntryIdentities(
        elements,
        boundedEntries.map((entry) => entry.identity),
      ),
      ...(coverage === undefined ? {} : { coverage }),
    };
    const visualFallbackAllowed = deep || selectedTargets.length === 0 || hasVisualSurface;
    this.#rememberInteractiveSnapshot(tabId, current);
    const canReturnDelta =
      options.since !== undefined && options.since.length > 0 && previous?.id === options.since;
    if (canReturnDelta) {
      const delta = keyedInteractiveDelta(previous, current);
      if (delta !== null) {
        const deltaData = {
          mode: 'interactive',
          snapshot: snapshotId,
          base: previous.id,
          ...delta,
          ...(coverage === undefined ? {} : { coverage }),
        };
        const fullData = {
          mode: 'interactive',
          snapshot: snapshotId,
          keys: INTERACTIVE_ENTRY_KEYS,
          elements,
          ...(truncated ? { truncated: true } : {}),
          ...(coverage === undefined ? {} : { coverage }),
        };
        if (
          delta.unchanged === true ||
          JSON.stringify(deltaData).length < JSON.stringify(fullData).length
        )
          return {
            tabId,
            url: metadata.url,
            data: deltaData,
            observation: null,
            attachmentIds: [],
            debuggerSession: 'ephemeral',
            visualFallbackAllowed,
          };
      }
    }
    return {
      tabId,
      url: metadata.url,
      data: {
        mode: 'interactive',
        snapshot: snapshotId,
        keys: INTERACTIVE_ENTRY_KEYS,
        elements,
        ...(truncated ? { truncated: true } : {}),
        ...(coverage === undefined ? {} : { coverage }),
      },
      observation: null,
      attachmentIds: [],
      debuggerSession: 'ephemeral',
      visualFallbackAllowed,
    };
  }

  #rememberInteractiveSnapshot(tabId: number, snapshot: InteractiveSnapshot): void {
    this.#interactiveSnapshots.delete(tabId);
    this.#interactiveSnapshots.set(tabId, snapshot);
    if (this.#interactiveSnapshots.size <= MAX_INTERACTIVE_SNAPSHOT_TABS) return;
    const oldestTabId = this.#interactiveSnapshots.keys().next().value as number | undefined;
    if (oldestTabId !== undefined) this.#interactiveSnapshots.delete(oldestTabId);
  }

  #frameLoaders(frameTree: Protocol.Page.FrameTree): ReadonlyMap<string, string> {
    const loaders = new Map<string, string>();
    const visit = (tree: Protocol.Page.FrameTree): void => {
      loaders.set(tree.frame.id, tree.frame.loaderId);
      for (const child of tree.childFrames ?? []) visit(child);
    };
    visit(frameTree);
    return loaders;
  }

  async #pageMetadata(session: DebuggerSession): Promise<{ url: string | null; title: string }> {
    try {
      const history =
        await this.#dependencies.transport.send<Protocol.Page.GetNavigationHistoryResponse>(
          session,
          'Page.getNavigationHistory',
        );
      const entry = history.entries[history.currentIndex];
      return {
        url: entry?.url.slice(0, 4_096) ?? null,
        title: entry?.title.slice(0, 500) ?? '',
      };
    } catch {
      return { url: null, title: '' };
    }
  }
}
