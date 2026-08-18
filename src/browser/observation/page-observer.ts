import type { Protocol } from 'devtools-protocol';
import type { DebuggerSession, DebuggerTransport } from '../debugger/debugger-transport';
import type {
  BrowserSessionSnapshot,
  ChildTargetSession,
  TargetSessionRegistry,
} from '../debugger/target-session-registry';
import type { DomObservedElement, ReadablePageContent } from './content-extractor';
import type {
  ElementRefStore,
  InteractiveElement,
  ObservedElementTarget,
  ViewportRect,
} from './element-ref-store';

const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'menuitem',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);
const MAX_INTERACTIVE_ELEMENTS = 200;
const MAX_INTERACTIVE_JSON_CHARACTERS = 60_000;
const MAX_CONTENT_CHARACTERS = 40_000;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

export interface PageObservationContentPort {
  readContent(tabId: number): Promise<ReadablePageContent>;
  observeElements(tabId: number): Promise<readonly DomObservedElement[]>;
  setOverlaysHidden(tabId: number, hidden: boolean): Promise<void>;
}

export interface PageObservationResult {
  readonly tabId: number;
  readonly url: string | null;
  readonly data: Readonly<Record<string, unknown>>;
  readonly observation: null;
  readonly attachmentIds: readonly string[];
}

export interface PageObserverDependencies {
  readonly sessions: Pick<TargetSessionRegistry, 'ensure'>;
  readonly transport: DebuggerTransport;
  readonly content: PageObservationContentPort;
  readonly refs: ElementRefStore;
  readonly persistScreenshot?: (blob: Blob) => Promise<{ readonly id: string }>;
}

interface SessionOffset {
  readonly x: number;
  readonly y: number;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Page observation was aborted.', 'AbortError');
}

function axString(value: Protocol.Accessibility.AXValue | undefined): string {
  return typeof value?.value === 'string' ? value.value.replace(/\s+/g, ' ').trim() : '';
}

function axBoolean(value: Protocol.Accessibility.AXValue | undefined): boolean {
  return value?.value === true;
}

function axState(node: Protocol.Accessibility.AXNode): readonly string[] {
  const states: string[] = [];
  for (const property of node.properties ?? []) {
    if (axBoolean(property.value)) states.push(property.name);
    else if (
      ['checked', 'expanded', 'selected', 'pressed'].includes(property.name) &&
      (typeof property.value.value === 'string' || typeof property.value.value === 'number')
    ) {
      states.push(`${property.name}=${String(property.value.value).slice(0, 100)}`);
    }
  }
  return [...new Set(states)].slice(0, 20);
}

function isInteractive(node: Protocol.Accessibility.AXNode, role: string): boolean {
  return (
    INTERACTIVE_ROLES.has(role) ||
    (node.properties ?? []).some(
      (property) =>
        (property.name === 'focusable' || property.name === 'editable') &&
        axBoolean(property.value),
    )
  );
}

function quadRect(quad: readonly number[] | undefined): ViewportRect | undefined {
  if (!quad || quad.length < 8 || quad.some((coordinate) => !Number.isFinite(coordinate))) {
    return undefined;
  }
  const xs = [quad[0], quad[2], quad[4], quad[6]].filter(
    (value): value is number => value !== undefined,
  );
  const ys = [quad[1], quad[3], quad[5], quad[7]].filter(
    (value): value is number => value !== undefined,
  );
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = Math.max(...xs) - x;
  const height = Math.max(...ys) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

function matchingFallback(
  role: string,
  bounds: ViewportRect,
  fallbacks: readonly DomObservedElement[],
): DomObservedElement | undefined {
  const matches = fallbacks.filter(
    (candidate) =>
      candidate.role === role &&
      Math.abs(candidate.bounds.x - bounds.x) <= 4 &&
      Math.abs(candidate.bounds.y - bounds.y) <= 4 &&
      Math.abs(candidate.bounds.width - bounds.width) <= 4 &&
      Math.abs(candidate.bounds.height - bounds.height) <= 4,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function sessionKey(session: DebuggerSession): string {
  return session.sessionId ?? 'root';
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

/** Builds content and semantic snapshots from the page bundle plus flattened CDP sessions. */
export class PageObserver {
  readonly #dependencies: PageObserverDependencies;

  constructor(dependencies: PageObserverDependencies) {
    this.#dependencies = dependencies;
  }

  async inspect(
    tabId: number,
    mode: 'content' | 'interactive' | 'screenshot',
    signal: AbortSignal,
  ): Promise<PageObservationResult> {
    throwIfAborted(signal);
    if (mode === 'content') return this.#inspectContent(tabId, signal);
    if (mode === 'interactive') return this.#inspectInteractive(tabId, signal);
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
      const attachment = await persist(blob);
      if (attachment.id.trim().length === 0 || attachment.id.length > 256) {
        throw new Error('Screenshot persistence returned an invalid reference.');
      }
      return {
        tabId,
        url: metadata.url,
        data: {
          mode: 'screenshot',
          mimeType: 'image/png',
          width: Math.max(1, Math.round(metrics.visualViewport.clientWidth)),
          height: Math.max(1, Math.round(metrics.visualViewport.clientHeight)),
          attachmentId: attachment.id,
        },
        observation: null,
        attachmentIds: [attachment.id],
      };
    } finally {
      if (overlaysHidden) {
        await this.#dependencies.content.setOverlaysHidden(tabId, false).catch(() => undefined);
      }
    }
  }

  async #inspectContent(tabId: number, signal: AbortSignal): Promise<PageObservationResult> {
    const [top, browserSession] = await Promise.all([
      this.#dependencies.content.readContent(tabId),
      this.#dependencies.sessions.ensure(tabId, signal),
    ]);
    throwIfAborted(signal);
    const frameTexts: { url: string; text: string }[] = [];
    for (const child of browserSession.children.values()) {
      const tree =
        await this.#dependencies.transport.send<Protocol.Accessibility.GetFullAXTreeResponse>(
          child.session,
          'Accessibility.getFullAXTree',
        );
      const text = [
        ...new Set(
          tree.nodes
            .filter((node) => !node.ignored)
            .filter((node) => ['StaticText', 'heading', 'paragraph'].includes(axString(node.role)))
            .map((node) => axString(node.name))
            .filter(Boolean),
        ),
      ].join(' ');
      if (text.length > 0) frameTexts.push({ url: child.url, text: text.slice(0, 20_000) });
    }
    const fullText = [top.text, ...frameTexts.map(({ text }) => text)].filter(Boolean).join('\n\n');
    return {
      tabId,
      url: top.url || null,
      data: {
        mode: 'content',
        title: top.title,
        url: top.url,
        text: fullText.slice(0, MAX_CONTENT_CHARACTERS),
        headings: top.headings.slice(0, 100),
        links: top.links.slice(0, 100),
        frames: frameTexts,
        truncated: top.truncated || fullText.length > MAX_CONTENT_CHARACTERS,
      },
      observation: null,
      attachmentIds: [],
    };
  }

  async #inspectInteractive(tabId: number, signal: AbortSignal): Promise<PageObservationResult> {
    const [browserSession, fallbacks] = await Promise.all([
      this.#dependencies.sessions.ensure(tabId, signal),
      this.#dependencies.content.observeElements(tabId),
    ]);
    throwIfAborted(signal);
    const offsets = new Map<string, Promise<SessionOffset>>();
    const targets: ObservedElementTarget[] = [];
    const sessionTargets: readonly { session: DebuggerSession; frame: string }[] = [
      { session: browserSession.root, frame: 'main' },
      ...[...browserSession.children.values()].map((child) => ({
        session: child.session,
        frame: child.targetId,
      })),
    ];

    for (const sessionTarget of sessionTargets) {
      const [tree, viewport, offset] = await Promise.all([
        this.#dependencies.transport.send<Protocol.Accessibility.GetFullAXTreeResponse>(
          sessionTarget.session,
          'Accessibility.getFullAXTree',
        ),
        this.#visualViewport(sessionTarget.session),
        this.#sessionOffset(browserSession, sessionTarget.session, offsets),
      ]);
      for (const node of tree.nodes) {
        const role = axString(node.role).toLowerCase();
        if (
          node.ignored ||
          node.backendDOMNodeId === undefined ||
          !Number.isInteger(node.backendDOMNodeId) ||
          !isInteractive(node, role)
        ) {
          continue;
        }
        let model: Protocol.DOM.GetBoxModelResponse;
        try {
          model = await this.#dependencies.transport.send<Protocol.DOM.GetBoxModelResponse>(
            sessionTarget.session,
            'DOM.getBoxModel',
            { backendNodeId: node.backendDOMNodeId },
          );
        } catch {
          continue;
        }
        const local = quadRect(model.model.border);
        if (!local) continue;
        const bounds = {
          x: local.x - viewport.pageX + offset.x,
          y: local.y - viewport.pageY + offset.y,
          width: local.width,
          height: local.height,
        };
        const cdpName = axString(node.name).slice(0, 500);
        const fallback =
          cdpName.length === 0 ? matchingFallback(role, bounds, fallbacks) : undefined;
        targets.push({
          session: sessionTarget.session,
          backendNodeId: node.backendDOMNodeId,
          role: role.slice(0, 100),
          name: cdpName || fallback?.name.slice(0, 500) || '',
          state: axState(node),
          frame: sessionTarget.frame,
          bounds,
        });
      }
    }

    const originalCount = targets.length;
    let boundedTargets = targets.slice(0, MAX_INTERACTIVE_ELEMENTS);
    let elements: readonly InteractiveElement[] = [];
    while (boundedTargets.length >= 0) {
      elements = this.#dependencies.refs.replaceSnapshot(
        tabId,
        browserSession.generation,
        boundedTargets,
      );
      if (
        JSON.stringify({ mode: 'interactive', generation: browserSession.generation, elements })
          .length <= MAX_INTERACTIVE_JSON_CHARACTERS
      ) {
        break;
      }
      boundedTargets = boundedTargets.slice(0, -1);
    }
    const metadata = await this.#pageMetadata(browserSession.root);
    return {
      tabId,
      url: metadata.url,
      data: {
        mode: 'interactive',
        generation: browserSession.generation,
        elements,
        truncated: elements.length < originalCount,
      },
      observation: null,
      attachmentIds: [],
    };
  }

  async #visualViewport(session: DebuggerSession): Promise<{ pageX: number; pageY: number }> {
    const metrics = await this.#dependencies.transport.send<Protocol.Page.GetLayoutMetricsResponse>(
      session,
      'Page.getLayoutMetrics',
    );
    return {
      pageX: metrics.visualViewport.pageX,
      pageY: metrics.visualViewport.pageY,
    };
  }

  #sessionOffset(
    snapshot: BrowserSessionSnapshot,
    session: DebuggerSession,
    cache: Map<string, Promise<SessionOffset>>,
  ): Promise<SessionOffset> {
    const key = sessionKey(session);
    const cached = cache.get(key);
    if (cached) return cached;
    const calculating = this.#calculateSessionOffset(snapshot, session, cache);
    cache.set(key, calculating);
    return calculating;
  }

  async #calculateSessionOffset(
    snapshot: BrowserSessionSnapshot,
    session: DebuggerSession,
    cache: Map<string, Promise<SessionOffset>>,
  ): Promise<SessionOffset> {
    if (session.sessionId === undefined) return { x: 0, y: 0 };
    const child = [...snapshot.children.values()].find(
      (candidate) => candidate.session.sessionId === session.sessionId,
    );
    if (!child) return { x: 0, y: 0 };
    const parent = this.#parentSession(snapshot, child);
    const [parentOffset, parentViewport, owner] = await Promise.all([
      this.#sessionOffset(snapshot, parent, cache),
      this.#visualViewport(parent),
      this.#dependencies.transport.send<Protocol.DOM.GetFrameOwnerResponse>(
        parent,
        'DOM.getFrameOwner',
        { frameId: child.targetId },
      ),
    ]);
    const ownerModel = await this.#dependencies.transport.send<Protocol.DOM.GetBoxModelResponse>(
      parent,
      'DOM.getBoxModel',
      { backendNodeId: owner.backendNodeId },
    );
    const ownerBounds = quadRect(ownerModel.model.border);
    return ownerBounds
      ? {
          x: parentOffset.x + ownerBounds.x - parentViewport.pageX,
          y: parentOffset.y + ownerBounds.y - parentViewport.pageY,
        }
      : parentOffset;
  }

  #parentSession(snapshot: BrowserSessionSnapshot, child: ChildTargetSession): DebuggerSession {
    if (child.parentSessionId === null) return snapshot.root;
    return (
      [...snapshot.children.values()].find(
        (candidate) => candidate.session.sessionId === child.parentSessionId,
      )?.session ?? snapshot.root
    );
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
