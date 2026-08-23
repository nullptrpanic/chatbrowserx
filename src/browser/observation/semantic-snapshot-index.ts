export interface SemanticSnapshotIndexNode {
  readonly documentFrameId: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly visible: boolean;
  readonly bounds?: readonly [number, number, number, number];
  readonly paintOrder?: number;
}

export interface SemanticSnapshotViewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const CELL_SIZE = 256;

function cellKey(x: number, y: number): string {
  return `${String(x)}:${String(y)}`;
}

/** Precomputes DOM-ID and viewport-spatial joins used repeatedly while projecting AX targets. */
export class SemanticSnapshotIndex<TNode extends SemanticSnapshotIndexNode> {
  readonly #nodes: readonly TNode[];
  readonly #viewport: SemanticSnapshotViewport | undefined;
  readonly #nodesByFrameAndId = new Map<string, Map<string, TNode>>();
  readonly #nodesByCell = new Map<string, TNode[]>();

  constructor(nodes: readonly TNode[], viewport?: SemanticSnapshotViewport) {
    this.#nodes = nodes;
    this.#viewport = viewport;
    for (const node of nodes) {
      const id = node.attributes.get('id');
      if (id) {
        const byId = this.#nodesByFrameAndId.get(node.documentFrameId) ?? new Map<string, TNode>();
        if (!byId.has(id)) byId.set(id, node);
        this.#nodesByFrameAndId.set(node.documentFrameId, byId);
      }
      this.#indexBounds(node);
    }
  }

  findByDomId(documentFrameId: string, id: string): TNode | undefined {
    return this.#nodesByFrameAndId.get(documentFrameId)?.get(id);
  }

  /** Returns every indexed node that could overlap the target; exact paint checks remain upstream. */
  coverageCandidates(
    bounds: readonly [number, number, number, number] | undefined,
  ): readonly TNode[] {
    const range = this.#cellRange(bounds);
    if (range === null) return this.#viewport === undefined ? this.#nodes : [];
    const candidates = new Set<TNode>();
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        for (const node of this.#nodesByCell.get(cellKey(x, y)) ?? []) candidates.add(node);
      }
    }
    return [...candidates];
  }

  #indexBounds(node: TNode): void {
    if (!node.visible || node.paintOrder === undefined) return;
    const range = this.#cellRange(node.bounds);
    if (range === null) return;
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        const key = cellKey(x, y);
        const cell = this.#nodesByCell.get(key) ?? [];
        cell.push(node);
        this.#nodesByCell.set(key, cell);
      }
    }
  }

  #cellRange(bounds: readonly [number, number, number, number] | undefined): {
    readonly minX: number;
    readonly maxX: number;
    readonly minY: number;
    readonly maxY: number;
  } | null {
    if (bounds === undefined || this.#viewport === undefined) return null;
    const left = Math.max(bounds[0], this.#viewport.x);
    const top = Math.max(bounds[1], this.#viewport.y);
    const right = Math.min(bounds[0] + bounds[2], this.#viewport.x + this.#viewport.width);
    const bottom = Math.min(bounds[1] + bounds[3], this.#viewport.y + this.#viewport.height);
    if (right <= left || bottom <= top) return null;
    return {
      minX: Math.floor(left / CELL_SIZE),
      maxX: Math.floor(right / CELL_SIZE),
      minY: Math.floor(top / CELL_SIZE),
      maxY: Math.floor(bottom / CELL_SIZE),
    };
  }
}
