import type {
  FrameSegment,
  ObservedElement,
  ObservedElementState,
  ObservedFrame,
  PageObservation,
  Rect,
  TextRegion,
  ViewportState,
} from '../contracts/observation';
import { normalizeText } from './dom-semantics';
import { DEFAULT_OBSERVATION_LIMITS } from './observation-limits';

export interface CdpCommandPort {
  send<TResult>(
    tabId: number,
    method: string,
    params?: object,
    sessionId?: string,
  ): Promise<TResult>;
  listSessions(tabId: number): Promise<readonly CdpSessionDescriptor[]>;
}

export interface CdpSessionDescriptor {
  readonly sessionId: string;
  readonly targetId: string;
  readonly type: string;
  readonly url: string;
  readonly title: string;
  readonly parentSessionId: string | null;
}

export interface CdpObservationInput {
  readonly id: string;
  readonly capturedAt: number;
  readonly tabId: number;
  readonly url: string;
  readonly title: string;
  readonly viewport: ViewportState;
}

interface AxValue {
  readonly value?: unknown;
}

interface AxNode {
  readonly backendDOMNodeId?: number;
  readonly frameId?: string;
  readonly role?: AxValue;
  readonly name?: AxValue;
  readonly value?: AxValue;
  readonly properties?: readonly { readonly name: string; readonly value?: AxValue }[];
}

interface DomNode {
  readonly nodeName?: string;
  readonly documentURL?: string;
  readonly frameId?: string;
  readonly attributes?: readonly string[];
  readonly children?: readonly DomNode[];
  readonly contentDocument?: DomNode;
}

interface DomSnapshotDocument {
  readonly nodes?: {
    readonly backendNodeId?: readonly number[];
    readonly attributes?: readonly (readonly number[])[];
  };
  readonly layout?: {
    readonly nodeIndex?: readonly number[];
    readonly bounds?: readonly (readonly number[])[];
  };
}

interface SnapshotMetadata {
  readonly rects: Map<number, Rect>;
  readonly attributes: Map<number, Readonly<Record<string, string>>>;
}

interface CdpSessionCapture {
  readonly elements: readonly ObservedElement[];
  readonly textRegions: readonly TextRegion[];
  readonly frames: readonly ObservedFrame[];
  readonly framePaths: ReadonlyMap<string, readonly FrameSegment[]>;
  readonly truncated: boolean;
}

/** Reads a primitive AX value while rejecting nested protocol objects. */
function readAxValue(value: AxValue | undefined): string {
  const primitive = value?.value;
  return typeof primitive === 'string' || typeof primitive === 'number'
    ? normalizeText(String(primitive), 2_000)
    : '';
}

/** Reads one boolean-like accessibility property by its protocol name. */
function readAxBoolean(node: AxNode, name: string): boolean | null {
  const primitive = node.properties?.find((property) => property.name === name)?.value?.value;
  if (typeof primitive === 'boolean') return primitive;
  if (primitive === 'true') return true;
  if (primitive === 'false') return false;
  return null;
}

/** Converts AX interaction properties into the common browser observation state. */
function readAxState(node: AxNode): ObservedElementState {
  return {
    disabled: readAxBoolean(node, 'disabled') ?? false,
    checked: readAxBoolean(node, 'checked'),
    selected: readAxBoolean(node, 'selected'),
    expanded: readAxBoolean(node, 'expanded'),
  };
}

/** Keeps only approved stable attributes from a DOMSnapshot string table. */
function readStableAttributes(
  encoded: readonly number[] | undefined,
  strings: readonly string[],
): Readonly<Record<string, string>> {
  const stable: Record<string, string> = {};
  const allowed = new Set(['data-testid', 'name', 'id', 'autocomplete', 'type']);
  for (let index = 0; index < (encoded?.length ?? 0); index += 2) {
    const name = strings[encoded?.[index] ?? -1];
    const value = strings[encoded?.[index + 1] ?? -1];
    if (name !== undefined && value !== undefined && allowed.has(name)) stable[name] = value;
  }
  return stable;
}

/** Decodes backend-node geometry and stable attributes from all snapshot documents. */
function readSnapshotMetadata(value: unknown): SnapshotMetadata {
  const snapshot = value as {
    readonly strings?: readonly string[];
    readonly documents?: readonly DomSnapshotDocument[];
  };
  const strings = snapshot.strings ?? [];
  const rects = new Map<number, Rect>();
  const attributes = new Map<number, Readonly<Record<string, string>>>();
  for (const document of snapshot.documents ?? []) {
    const backendIds = document.nodes?.backendNodeId ?? [];
    for (let index = 0; index < backendIds.length; index += 1) {
      const backendNodeId = backendIds[index];
      if (backendNodeId === undefined) continue;
      attributes.set(
        backendNodeId,
        readStableAttributes(document.nodes?.attributes?.[index], strings),
      );
    }
    const nodeIndexes = document.layout?.nodeIndex ?? [];
    const bounds = document.layout?.bounds ?? [];
    for (let index = 0; index < nodeIndexes.length; index += 1) {
      const nodeIndex = nodeIndexes[index];
      const backendNodeId = nodeIndex === undefined ? undefined : backendIds[nodeIndex];
      const bound = bounds[index];
      if (backendNodeId === undefined || bound === undefined) continue;
      const [x = 0, y = 0, width = 0, height = 0] = bound;
      rects.set(backendNodeId, { x, y, width, height });
    }
  }
  return { rects, attributes };
}

/** Reads a named attribute from the flat DOM protocol attribute array. */
function readDomAttribute(node: DomNode, name: string): string | null {
  const attributes = node.attributes ?? [];
  for (let index = 0; index < attributes.length; index += 2) {
    if (attributes[index] === name) return attributes[index + 1] ?? null;
  }
  return null;
}

/** Converts a URL into its non-opaque origin without propagating parsing failures. */
function readOrigin(url: string | null): string | null {
  if (url === null) return null;
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** Walks the CDP DOM tree to collect frame metadata and frame-ID semantic paths. */
function readFrames(
  root: DomNode | undefined,
  basePath: readonly FrameSegment[],
): {
  readonly frames: ObservedFrame[];
  readonly paths: Map<string, readonly FrameSegment[]>;
} {
  const frames: ObservedFrame[] = [];
  const paths = new Map<string, readonly FrameSegment[]>();

  const visit = (node: DomNode, parentPath: readonly FrameSegment[]): void => {
    let childPath = parentPath;
    if (node.nodeName?.toUpperCase() === 'IFRAME') {
      const document = node.contentDocument;
      const url = document?.documentURL ?? readDomAttribute(node, 'src');
      const segment: FrameSegment = {
        index: frames.length,
        name: readDomAttribute(node, 'name'),
        title: readDomAttribute(node, 'title'),
        origin: readOrigin(url),
      };
      childPath = [...parentPath, segment];
      frames.push({
        path: childPath,
        name: segment.name,
        title: segment.title,
        url,
        accessible: document !== undefined,
        rect: { x: 0, y: 0, width: 0, height: 0 },
      });
      const frameId = document?.frameId ?? node.frameId;
      if (frameId !== undefined) paths.set(frameId, childPath);
      if (document !== undefined) visit(document, childPath);
    }
    for (const child of node.children ?? []) visit(child, childPath);
  };

  if (root?.frameId !== undefined) paths.set(root.frameId, basePath);
  if (root !== undefined) visit(root, basePath);
  return { frames, paths };
}

/** Produces a stable semantic key for matching frame paths across session captures. */
function framePathKey(path: readonly FrameSegment[]): string {
  return path
    .map((segment) =>
      [segment.index, segment.name ?? '', segment.title ?? '', segment.origin ?? ''].join('|'),
    )
    .join('>');
}

/** Creates a bounded fallback path when Chromium omits the frame-owner ID from a DOM snapshot. */
function fallbackSessionPath(
  descriptor: CdpSessionDescriptor,
  parentPath: readonly FrameSegment[],
  index: number,
): readonly FrameSegment[] {
  return [
    ...parentPath,
    {
      index,
      name: null,
      title: normalizeText(descriptor.title, 200) || null,
      origin: readOrigin(descriptor.url),
    },
  ];
}

export class CdpObserver {
  readonly #transport: CdpCommandPort;

  /** Creates an accessibility and DOMSnapshot observer over an attached debugger transport. */
  constructor(transport: CdpCommandPort) {
    this.#transport = transport;
  }

  /** Captures root and recursively attached iframe sessions into one bounded semantic snapshot. */
  async observe(input: CdpObservationInput): Promise<PageObservation> {
    const root = await this.#captureSession(input, undefined, []);
    const sessions = await this.#transport.listSessions(input.tabId).catch(() => []);
    const elements: ObservedElement[] = [];
    const textRegions: TextRegion[] = [];
    let frames = [...root.frames];
    const framePaths = new Map(root.framePaths);
    const sessionPaths = new Map<string, readonly FrameSegment[]>();
    let textCharacters = 0;
    let truncated = root.truncated;

    const appendCapture = (capture: CdpSessionCapture): void => {
      for (const element of capture.elements) {
        if (elements.length >= DEFAULT_OBSERVATION_LIMITS.interactiveElements) {
          truncated = true;
          break;
        }
        elements.push(element);
      }
      for (const region of capture.textRegions) {
        if (
          textRegions.length >= DEFAULT_OBSERVATION_LIMITS.textRegions ||
          textCharacters >= DEFAULT_OBSERVATION_LIMITS.normalizedTextCharacters
        ) {
          truncated = true;
          break;
        }
        const remaining = DEFAULT_OBSERVATION_LIMITS.normalizedTextCharacters - textCharacters;
        const text = region.text.slice(0, remaining);
        if (text.length < region.text.length) truncated = true;
        textRegions.push({ ...region, text });
        textCharacters += text.length;
      }
      const frameKeys = new Set(frames.map((frame) => framePathKey(frame.path)));
      for (const frame of capture.frames) {
        const key = framePathKey(frame.path);
        if (!frameKeys.has(key)) {
          frameKeys.add(key);
          frames.push(frame);
        }
      }
      for (const [frameId, path] of capture.framePaths) framePaths.set(frameId, path);
      truncated ||= capture.truncated;
    };

    appendCapture(root);
    const pending = [...sessions].filter((session) => session.type === 'iframe');
    while (pending.length > 0) {
      let selectedIndex = pending.findIndex(
        (session) =>
          framePaths.has(session.targetId) ||
          session.parentSessionId === null ||
          sessionPaths.has(session.parentSessionId),
      );
      if (selectedIndex < 0) selectedIndex = 0;
      const [session] = pending.splice(selectedIndex, 1);
      if (session === undefined) continue;
      const parentPath =
        session.parentSessionId === null ? [] : (sessionPaths.get(session.parentSessionId) ?? []);
      const basePath =
        framePaths.get(session.targetId) ?? fallbackSessionPath(session, parentPath, frames.length);
      sessionPaths.set(session.sessionId, basePath);

      const baseKey = framePathKey(basePath);
      let foundBaseFrame = false;
      frames = frames.map((frame) => {
        if (framePathKey(frame.path) !== baseKey) return frame;
        foundBaseFrame = true;
        return {
          ...frame,
          url: session.url || frame.url,
          accessible: true,
        };
      });
      if (!foundBaseFrame) {
        const segment = basePath.at(-1);
        frames.push({
          path: basePath,
          name: segment?.name ?? null,
          title: segment?.title ?? null,
          url: session.url || null,
          accessible: true,
          rect: { x: 0, y: 0, width: 0, height: 0 },
        });
      }

      const capture = await this.#captureSession(input, session.sessionId, basePath).catch(
        () => null,
      );
      if (capture !== null) appendCapture(capture);
    }

    return {
      id: input.id,
      capturedAt: input.capturedAt,
      tabId: input.tabId,
      url: input.url,
      title: normalizeText(input.title, 500),
      viewport: input.viewport,
      textRegions,
      elements,
      frames,
      truncated,
    };
  }

  /** Captures one CDP target session without exposing arbitrary runtime evaluation. */
  async #captureSession(
    input: CdpObservationInput,
    sessionId: string | undefined,
    basePath: readonly FrameSegment[],
  ): Promise<CdpSessionCapture> {
    const [axResponse, domResponse, snapshotResponse] = await Promise.all([
      this.#transport.send<{ readonly nodes?: readonly AxNode[] }>(
        input.tabId,
        'Accessibility.getFullAXTree',
        {},
        sessionId,
      ),
      this.#transport.send<{ readonly root?: DomNode }>(
        input.tabId,
        'DOM.getDocument',
        { depth: -1, pierce: true },
        sessionId,
      ),
      this.#transport.send<unknown>(
        input.tabId,
        'DOMSnapshot.captureSnapshot',
        { computedStyles: [], includeDOMRects: true, includePaintOrder: true },
        sessionId,
      ),
    ]);
    const metadata = readSnapshotMetadata(snapshotResponse);
    const frameData = readFrames(domResponse.root, basePath);
    const elements: ObservedElement[] = [];
    const textRegions: TextRegion[] = [];
    let textCharacters = 0;
    let truncated = false;
    const sourceKey = sessionId === undefined ? 'root' : sessionId;

    for (const node of axResponse.nodes ?? []) {
      const role = readAxValue(node.role);
      const name = readAxValue(node.name);
      const framePath =
        node.frameId === undefined ? basePath : (frameData.paths.get(node.frameId) ?? basePath);
      if (role === 'StaticText') {
        if (
          name.length > 0 &&
          textRegions.length < DEFAULT_OBSERVATION_LIMITS.textRegions &&
          textCharacters < DEFAULT_OBSERVATION_LIMITS.normalizedTextCharacters
        ) {
          const text = name.slice(
            0,
            DEFAULT_OBSERVATION_LIMITS.normalizedTextCharacters - textCharacters,
          );
          textRegions.push({
            kind: 'staticText',
            text,
            framePath,
            rect: { x: 0, y: 0, width: 0, height: 0 },
          });
          textCharacters += text.length;
        } else if (name.length > 0) truncated = true;
        continue;
      }
      if (role.length === 0 || ['RootWebArea', 'generic', 'none'].includes(role)) continue;
      if (elements.length >= DEFAULT_OBSERVATION_LIMITS.interactiveElements) {
        truncated = true;
        continue;
      }
      const backendNodeId = node.backendDOMNodeId ?? null;
      const rect =
        backendNodeId === null
          ? { x: 0, y: 0, width: 0, height: 0 }
          : (metadata.rects.get(backendNodeId) ?? { x: 0, y: 0, width: 0, height: 0 });
      elements.push({
        observationRef: `${input.id}:cdp-${sourceKey}:element:${String(elements.length)}`,
        framePath,
        shadowPath: [],
        role,
        name,
        label: null,
        text: null,
        value: readAxValue(node.value) || null,
        stableAttributes:
          backendNodeId === null ? {} : (metadata.attributes.get(backendNodeId) ?? {}),
        ancestorHint: null,
        state: readAxState(node),
        rect,
        visible: rect.width > 0 && rect.height > 0,
        obscured: false,
        backendNodeId,
        cdpSessionId: sessionId ?? null,
      });
    }

    return {
      textRegions,
      elements,
      frames: frameData.frames,
      framePaths: frameData.paths,
      truncated,
    };
  }
}
