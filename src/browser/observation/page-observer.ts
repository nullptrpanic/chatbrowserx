import type { Protocol } from 'devtools-protocol';
import type { DebuggerSession, DebuggerTransport } from '../debugger/debugger-transport';
import type { TargetSessionRegistry } from '../debugger/target-session-registry';
import type { ReadablePageContent } from './content-extractor';
import type { ElementRefStore, ObservedElementTarget } from './element-ref-store';
import { prepareModelScreenshot } from './model-screenshot';
import {
  SEMANTIC_SNAPSHOT_STYLES,
  buildSemanticPageSnapshot,
  type SemanticAction,
  type SemanticPageEntry,
} from './semantic-page-snapshot';

const MAX_INTERACTIVE_ELEMENTS = 500;
const MAX_INTERACTIVE_TARGETS = 200;
const MAX_INTERACTIVE_JSON_CHARACTERS = 60_000;
const MAX_INTERACTIVE_SNAPSHOT_TABS = 50;
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
  readonly persistScreenshot?: (blob: Blob) => Promise<{ readonly id: string }>;
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
  readonly structure: string;
  readonly elements: readonly CompactSemanticPageEntry[];
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

function interactiveStructure(
  elements: readonly CompactSemanticPageEntry[],
  truncated: boolean,
): string {
  return JSON.stringify({
    elements: elements.map((entry) => {
      const structure: Record<string, unknown> = { ...entry };
      delete structure.s;
      return structure;
    }),
    ...(truncated ? { truncated: true } : {}),
  });
}

function interactiveStateChanges(
  previous: readonly CompactSemanticPageEntry[],
  current: readonly CompactSemanticPageEntry[],
): readonly Readonly<{ i: number; s: readonly string[] | null }>[] {
  const changes: Readonly<{ i: number; s: readonly string[] | null }>[] = [];
  current.forEach((entry, index) => {
    const prior = previous[index];
    const before = prior?.s ?? null;
    const after = entry.s ?? null;
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ i: index, s: after });
  });
  return changes;
}

/** Gives deep inspection's bounded budget to actionable entries and their nearby context first. */
function interactiveCandidateIndexes(
  entries: readonly SemanticPageEntry[],
  deep: boolean,
): readonly number[] {
  if (!deep) return entries.map((_entry, index) => index);
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
    return this.#inspectScreenshot(tabId, signal);
  }

  async #inspectScreenshot(tabId: number, signal: AbortSignal): Promise<PageObservationResult> {
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
      const attachment = await persist(prepared.blob);
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
    const targets: ObservedElementTarget[] = [];
    const entries: SemanticPageEntry[] = [];
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

    for (const sessionTarget of sessionTargets) {
      throwIfAborted(signal);
      const [tree, domSnapshot, frameTree] = await Promise.all([
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
          },
        ),
        this.#dependencies.transport.send<Protocol.Page.GetFrameTreeResponse>(
          sessionTarget.session,
          'Page.getFrameTree',
        ),
      ]);
      const loaders = this.#frameLoaders(frameTree.frameTree);
      const semantic = buildSemanticPageSnapshot({
        axNodes: tree.nodes,
        domSnapshot,
        frame: sessionTarget.frame,
      });
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
    const selectedEntryIndexes: number[] = [];
    const usedTargetIndexes = new Set<number>();
    for (const entryIndex of interactiveCandidateIndexes(entries, deep)) {
      if (selectedEntryIndexes.length >= MAX_INTERACTIVE_ELEMENTS) break;
      const entry = entries[entryIndex];
      if (!entry) continue;
      if (
        entry.targetIndex !== undefined &&
        !usedTargetIndexes.has(entry.targetIndex) &&
        usedTargetIndexes.size >= MAX_INTERACTIVE_TARGETS
      ) {
        continue;
      }
      selectedEntryIndexes.push(entryIndex);
      if (entry.targetIndex !== undefined) usedTargetIndexes.add(entry.targetIndex);
      if (
        JSON.stringify({
          mode: 'interactive',
          elements: selectedEntryIndexes.map((index) => entries[index]),
        }).length > MAX_INTERACTIVE_JSON_CHARACTERS
      ) {
        selectedEntryIndexes.pop();
        if (entry.targetIndex !== undefined) {
          const stillUsed = selectedEntryIndexes.some(
            (index) => entries[index]?.targetIndex === entry.targetIndex,
          );
          if (!stillUsed) usedTargetIndexes.delete(entry.targetIndex);
        }
        break;
      }
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
    const metadata = await this.#pageMetadata(browserSession.root);
    const snapshotId = createInteractiveSnapshotId();
    const truncated = boundedEntries.length < originalCount;
    const previous = this.#interactiveSnapshots.get(tabId);
    const current: InteractiveSnapshot = {
      id: snapshotId,
      structure: interactiveStructure(elements, truncated),
      elements,
    };
    const visualFallbackAllowed = selectedTargets.length === 0 || hasVisualSurface;
    this.#rememberInteractiveSnapshot(tabId, current);
    const canReturnDelta =
      options.since !== undefined &&
      options.since.length > 0 &&
      previous?.id === options.since &&
      previous.structure === current.structure;
    if (canReturnDelta) {
      const changes = interactiveStateChanges(previous.elements, elements);
      return {
        tabId,
        url: metadata.url,
        data: {
          mode: 'interactive',
          snapshot: snapshotId,
          base: previous.id,
          ...(changes.length === 0 ? { unchanged: true } : { changes }),
        },
        observation: null,
        attachmentIds: [],
        debuggerSession: 'ephemeral',
        visualFallbackAllowed,
      };
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
