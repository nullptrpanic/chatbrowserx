import type { Protocol } from 'devtools-protocol';
import { describe, expect, it } from 'vitest';
import {
  SEMANTIC_SNAPSHOT_STYLES,
  buildSemanticPageSnapshot,
} from '../../../src/browser/observation/semantic-page-snapshot';

interface FixtureNode {
  readonly backendNodeId: number;
  readonly nodeName: string;
  readonly parentIndex: number;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly cursor?: string;
  readonly clickable?: boolean;
  readonly checked?: boolean;
  readonly selected?: boolean;
  readonly bounds?: readonly [number, number, number, number];
}

function domSnapshot(nodes: readonly FixtureNode[]): Protocol.DOMSnapshot.CaptureSnapshotResponse {
  const strings: string[] = [];
  const stringIndexes = new Map<string, number>();
  const stringIndex = (value: string): number => {
    const existing = stringIndexes.get(value);
    if (existing !== undefined) return existing;
    const index = strings.length;
    strings.push(value);
    stringIndexes.set(value, index);
    return index;
  };
  const clickableIndexes: number[] = [];
  const checkedIndexes: number[] = [];
  const selectedIndexes: number[] = [];
  const layoutNodeIndexes: number[] = [];
  const layoutStyles: number[][] = [];
  const layoutBounds: number[][] = [];
  nodes.forEach((node, nodeIndex) => {
    if (node.clickable) clickableIndexes.push(nodeIndex);
    if (node.checked) checkedIndexes.push(nodeIndex);
    if (node.selected) selectedIndexes.push(nodeIndex);
    if (node.bounds) {
      layoutNodeIndexes.push(nodeIndex);
      layoutStyles.push(
        SEMANTIC_SNAPSHOT_STYLES.map((property) =>
          stringIndex(
            property === 'cursor'
              ? (node.cursor ?? 'auto')
              : property === 'display'
                ? 'block'
                : property === 'visibility'
                  ? 'visible'
                  : property === 'pointer-events'
                    ? 'auto'
                    : '',
          ),
        ),
      );
      layoutBounds.push([...node.bounds]);
    }
  });
  return {
    strings,
    documents: [
      {
        documentURL: stringIndex('https://exam.test/'),
        title: stringIndex('Exam'),
        baseURL: stringIndex('https://exam.test/'),
        contentLanguage: stringIndex('zh-CN'),
        encodingName: stringIndex('UTF-8'),
        publicId: stringIndex(''),
        systemId: stringIndex(''),
        frameId: stringIndex('frame-main'),
        nodes: {
          parentIndex: nodes.map((node) => node.parentIndex),
          nodeType: nodes.map((node) => (node.nodeName === '#document' ? 9 : 1)),
          nodeName: nodes.map((node) => stringIndex(node.nodeName)),
          nodeValue: nodes.map(() => stringIndex('')),
          backendNodeId: nodes.map((node) => node.backendNodeId),
          attributes: nodes.map((node) =>
            Object.entries(node.attributes ?? {}).flatMap(([name, value]) => [
              stringIndex(name),
              stringIndex(value),
            ]),
          ),
          isClickable: { index: clickableIndexes },
          inputChecked: { index: checkedIndexes },
          optionSelected: { index: selectedIndexes },
        },
        layout: {
          nodeIndex: layoutNodeIndexes,
          styles: layoutStyles,
          bounds: layoutBounds,
          text: layoutNodeIndexes.map(() => stringIndex('')),
          stackingContexts: { index: [] },
        },
        textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
      },
    ],
  };
}

function axNode(
  nodeId: string,
  backendNodeId: number,
  role: string,
  name: string,
  options: {
    readonly parentId?: string;
    readonly childIds?: readonly string[];
    readonly properties?: Protocol.Accessibility.AXProperty[];
  } = {},
): Protocol.Accessibility.AXNode {
  return {
    nodeId,
    backendDOMNodeId: backendNodeId,
    ignored: false,
    role: { type: 'role', value: role },
    name: { type: 'computedString', value: name },
    ...(options.parentId ? { parentId: options.parentId } : {}),
    ...(options.childIds ? { childIds: [...options.childIds] } : {}),
    ...(options.properties ? { properties: [...options.properties] } : {}),
  };
}

describe('buildSemanticPageSnapshot', () => {
  it('merges accessible label fragments that resolve to one click target', () => {
    const result = buildSemanticPageSnapshot({
      axNodes: [
        axNode('root', 1, 'RootWebArea', 'Exam', {
          childIds: ['choice-label', 'choice-text'],
        }),
        axNode('choice-label', 21, 'generic', 'A.', { parentId: 'root' }),
        axNode('choice-text', 22, 'StaticText', 'First answer', { parentId: 'root' }),
      ],
      domSnapshot: domSnapshot([
        { backendNodeId: 1, nodeName: '#document', parentIndex: -1 },
        {
          backendNodeId: 20,
          nodeName: 'DIV',
          parentIndex: 0,
          attributes: { class: 'choice-option__7sZO8 checked__Hq2oI' },
          cursor: 'pointer',
          clickable: true,
          bounds: [20, 160, 760, 48],
        },
        {
          backendNodeId: 21,
          nodeName: 'SPAN',
          parentIndex: 1,
          cursor: 'pointer',
          bounds: [40, 170, 24, 28],
        },
        {
          backendNodeId: 22,
          nodeName: 'SPAN',
          parentIndex: 1,
          cursor: 'pointer',
          bounds: [72, 170, 650, 28],
        },
        {
          backendNodeId: 30,
          nodeName: 'DIV',
          parentIndex: 0,
          attributes: { class: 'choice-option__7sZO8' },
          cursor: 'pointer',
          clickable: true,
          bounds: [20, 220, 760, 48],
        },
      ]),
      frame: 'main',
    });

    expect(result.targets).toEqual([
      expect.objectContaining({
        backendNodeId: 20,
        name: 'A. First answer',
        state: ['checked'],
        actions: ['click'],
      }),
    ]);
    expect(result.entries).toEqual([
      {
        depth: 1,
        role: 'generic',
        name: 'A. First answer',
        targetIndex: 0,
        state: ['checked'],
        actions: ['click'],
      },
    ]);
  });

  it('turns an exam-style pointer island into one named generic click target with state', () => {
    const snapshot = domSnapshot([
      { backendNodeId: 1, nodeName: '#document', parentIndex: -1 },
      {
        backendNodeId: 10,
        nodeName: 'DIV',
        parentIndex: 0,
        attributes: { class: 'content__2DJ2k' },
        cursor: 'auto',
        bounds: [0, 100, 800, 500],
      },
      {
        backendNodeId: 20,
        nodeName: 'DIV',
        parentIndex: 1,
        attributes: { class: 'choice-option__7sZO8 checked__Hq2oI' },
        cursor: 'pointer',
        clickable: true,
        bounds: [20, 160, 760, 48],
      },
      {
        backendNodeId: 21,
        nodeName: 'DIV',
        parentIndex: 2,
        attributes: { class: 'name__z5H3t' },
        cursor: 'pointer',
        bounds: [40, 170, 700, 28],
      },
      {
        backendNodeId: 30,
        nodeName: 'DIV',
        parentIndex: 1,
        attributes: { class: 'choice-option__7sZO8' },
        cursor: 'pointer',
        clickable: true,
        bounds: [20, 220, 760, 48],
      },
      {
        backendNodeId: 31,
        nodeName: 'DIV',
        parentIndex: 4,
        attributes: { class: 'name__z5H3t' },
        cursor: 'pointer',
        bounds: [40, 230, 700, 28],
      },
      {
        backendNodeId: 40,
        nodeName: 'BUTTON',
        parentIndex: 1,
        cursor: 'pointer',
        clickable: true,
        bounds: [650, 640, 120, 40],
      },
    ]);
    const result = buildSemanticPageSnapshot({
      axNodes: [
        axNode('root', 1, 'RootWebArea', 'Exam', {
          childIds: ['question', 'choice-a', 'choice-a-text', 'choice-b', 'submit'],
        }),
        axNode('question', 10, 'StaticText', '1. Which option is correct?', {
          parentId: 'root',
        }),
        axNode('choice-a', 21, 'generic', 'A. First answer', { parentId: 'root' }),
        axNode('choice-a-text', 21, 'StaticText', 'A. First answer', {
          parentId: 'choice-a',
        }),
        axNode('choice-b', 31, 'generic', 'B. Second answer', { parentId: 'root' }),
        axNode('submit', 40, 'button', 'Submit', {
          parentId: 'root',
          properties: [{ name: 'focusable', value: { type: 'boolean', value: true } }],
        }),
      ],
      domSnapshot: snapshot,
      frame: 'main',
    });

    expect(result.targets).toEqual([
      expect.objectContaining({
        backendNodeId: 20,
        role: 'generic',
        name: 'A. First answer',
        state: ['checked'],
        actions: ['click'],
      }),
      expect.objectContaining({
        backendNodeId: 30,
        role: 'generic',
        name: 'B. Second answer',
        state: [],
        actions: ['click'],
      }),
      expect.objectContaining({ backendNodeId: 40, role: 'button', actions: ['click'] }),
    ]);
    expect(result.entries).toEqual([
      { depth: 1, role: 'statictext', name: '1. Which option is correct?' },
      {
        depth: 1,
        role: 'generic',
        name: 'A. First answer',
        targetIndex: 0,
        state: ['checked'],
        actions: ['click'],
      },
      {
        depth: 1,
        role: 'generic',
        name: 'B. Second answer',
        targetIndex: 1,
        actions: ['click'],
      },
      {
        depth: 1,
        role: 'button',
        name: 'Submit',
        targetIndex: 2,
        actions: ['click'],
      },
    ]);
    expect(JSON.stringify(result.entries)).not.toContain('bounds');
    expect(JSON.stringify(result.entries)).not.toContain('backendNodeId');
  });

  it('does not expose a document-level delegated click listener as an action', () => {
    const result = buildSemanticPageSnapshot({
      axNodes: [axNode('root', 1, 'RootWebArea', 'Delegated app')],
      domSnapshot: domSnapshot([
        { backendNodeId: 1, nodeName: '#document', parentIndex: -1, clickable: true },
        {
          backendNodeId: 2,
          nodeName: 'BODY',
          parentIndex: 0,
          clickable: true,
          cursor: 'auto',
          bounds: [0, 0, 1280, 2000],
        },
      ]),
      frame: 'main',
    });

    expect(result.targets).toEqual([]);
    expect(result.entries).toEqual([]);
  });

  it('keeps native checked state and prunes duplicate inline text', () => {
    const checked = { name: 'checked', value: { type: 'tristate', value: 'true' } } as const;
    const result = buildSemanticPageSnapshot({
      axNodes: [
        axNode('root', 1, 'RootWebArea', 'Form', { childIds: ['checkbox'] }),
        axNode('checkbox', 2, 'checkbox', 'Accept', {
          parentId: 'root',
          childIds: ['inline'],
          properties: [checked],
        }),
        axNode('inline', 2, 'InlineTextBox', 'Accept', { parentId: 'checkbox' }),
      ],
      domSnapshot: domSnapshot([
        { backendNodeId: 1, nodeName: '#document', parentIndex: -1 },
        {
          backendNodeId: 2,
          nodeName: 'INPUT',
          parentIndex: 0,
          attributes: { type: 'checkbox' },
          checked: true,
          clickable: true,
          cursor: 'pointer',
          bounds: [10, 20, 20, 20],
        },
      ]),
      frame: 'frame-child',
    });

    expect(result.entries).toEqual([
      {
        depth: 1,
        role: 'checkbox',
        name: 'Accept',
        targetIndex: 0,
        state: ['checked'],
        actions: ['click'],
        frame: 'frame-child',
      },
    ]);
  });
});
