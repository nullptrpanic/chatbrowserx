import { describe, expect, it } from 'vitest';
import { SemanticSnapshotIndex } from '../../../src/browser/observation/semantic-snapshot-index';

interface Node {
  readonly id: number;
  readonly documentFrameId: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly visible: boolean;
  readonly bounds?: readonly [number, number, number, number];
  readonly paintOrder?: number;
}

function node(id: number, x: number, y: number, attributes: Record<string, string> = {}): Node {
  return {
    id,
    documentFrameId: 'main',
    attributes: new Map(Object.entries(attributes)),
    visible: true,
    bounds: [x, y, 20, 20],
    paintOrder: id,
  };
}

describe('SemanticSnapshotIndex', () => {
  it('indexes DOM IDs and returns a bounded spatial candidate superset', () => {
    const nodes = Array.from({ length: 2_000 }, (_, index) =>
      node(index, (index % 50) * 40, Math.floor(index / 50) * 40),
    );
    const labelled = node(2_001, 100, 100, { id: 'control' });
    const index = new SemanticSnapshotIndex([...nodes, labelled], {
      x: 0,
      y: 0,
      width: 2_000,
      height: 1_600,
    });

    expect(index.findByDomId('main', 'control')).toBe(labelled);
    const candidates = index.coverageCandidates([90, 90, 60, 60]);
    expect(candidates).toContain(labelled);
    expect(candidates.length).toBeLessThan(nodes.length / 4);
  });
});
