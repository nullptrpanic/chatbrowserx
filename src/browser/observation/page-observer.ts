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

  constructor(dependencies: PageObserverDependencies) {
    this.#dependencies = dependencies;
  }

  async inspect(
    tabId: number,
    mode: 'content' | 'interactive' | 'interactive_deep' | 'screenshot',
    signal: AbortSignal,
  ): Promise<PageObservationResult> {
    throwIfAborted(signal);
    if (mode === 'content') return this.#inspectContent(tabId, signal);
    if (mode === 'interactive' || mode === 'interactive_deep') {
      return this.#inspectInteractive(tabId, mode === 'interactive_deep', signal);
    }
    return this.#inspectScreenshot(tabId, signal);
  }

  async #inspectScreenshot(tabId: number, signal: AbortSignal): Promise<PageObservationResult> {
    const persist = this.#dependencies.persistScreenshot;
    if (!persist) throw new Error('Screenshot persistence is unavailable.');
    const browserSession = await this.#dependencies.sessions.ensure(tabId, signal);
    throwIfAborted(signal);
    let overlaysHidden = false;
    try {
      await this.#dependencies.content.setOverlaysHidden(tabId, true);
      overlaysHidden = true;
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
      if (overlaysHidden) {
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
    _deep: boolean,
    signal: AbortSignal,
  ): Promise<PageObservationResult> {
    const browserSession = await this.#dependencies.sessions.ensure(tabId, signal);
    throwIfAborted(signal);
    const targets: ObservedElementTarget[] = [];
    const entries: SemanticPageEntry[] = [];
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
          role: target.role,
          name: target.name,
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
    const boundedEntries: SemanticPageEntry[] = [];
    const usedTargetIndexes = new Set<number>();
    for (const entry of entries.slice(0, MAX_INTERACTIVE_ELEMENTS)) {
      if (
        entry.targetIndex !== undefined &&
        !usedTargetIndexes.has(entry.targetIndex) &&
        usedTargetIndexes.size >= MAX_INTERACTIVE_TARGETS
      ) {
        continue;
      }
      boundedEntries.push(entry);
      if (entry.targetIndex !== undefined) usedTargetIndexes.add(entry.targetIndex);
      if (
        JSON.stringify({ mode: 'interactive', elements: boundedEntries }).length >
        MAX_INTERACTIVE_JSON_CHARACTERS
      ) {
        boundedEntries.pop();
        break;
      }
    }
    const selectedTargetIndexes: number[] = [];
    const selectedTargets: ObservedElementTarget[] = [];
    for (const targetIndex of usedTargetIndexes) {
      const target = targets[targetIndex];
      if (!target) continue;
      selectedTargetIndexes.push(targetIndex);
      selectedTargets.push(target);
    }
    const refs = this.#dependencies.refs.replaceSnapshot(tabId, selectedTargets);
    const refByTargetIndex = new Map(
      selectedTargetIndexes.map((targetIndex, index) => [targetIndex, refs[index] ?? '']),
    );
    const elements = boundedEntries.map((entry) => {
      const ref =
        entry.targetIndex === undefined ? undefined : refByTargetIndex.get(entry.targetIndex);
      return compactSemanticEntry(entry, ref || undefined);
    });
    const metadata = await this.#pageMetadata(browserSession.root);
    return {
      tabId,
      url: metadata.url,
      data: {
        mode: 'interactive',
        keys: INTERACTIVE_ENTRY_KEYS,
        elements,
        ...(boundedEntries.length < originalCount ? { truncated: true } : {}),
      },
      observation: null,
      attachmentIds: [],
      debuggerSession: 'ephemeral',
    };
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
