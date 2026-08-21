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
  readonly text?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly cursor?: string;
  readonly clickable?: boolean;
  readonly checked?: boolean;
  readonly selected?: boolean;
  readonly bounds?: readonly [number, number, number, number];
  readonly overflowX?: string;
  readonly overflowY?: string;
  readonly scrollRect?: readonly [number, number, number, number];
  readonly clientRect?: readonly [number, number, number, number];
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
  const layoutScrollRects: number[][] = [];
  const layoutClientRects: number[][] = [];
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
                    : property === 'overflow-x'
                      ? (node.overflowX ?? 'visible')
                      : property === 'overflow-y'
                        ? (node.overflowY ?? 'visible')
                        : '',
          ),
        ),
      );
      layoutBounds.push([...node.bounds]);
      layoutScrollRects.push([...(node.scrollRect ?? node.bounds)]);
      layoutClientRects.push([...(node.clientRect ?? node.bounds)]);
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
          nodeType: nodes.map((node) =>
            node.nodeName === '#document' ? 9 : node.nodeName === '#text' ? 3 : 1,
          ),
          nodeName: nodes.map((node) => stringIndex(node.nodeName)),
          nodeValue: nodes.map((node) => stringIndex(node.text ?? '')),
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
          scrollRects: layoutScrollRects,
          clientRects: layoutClientRects,
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

function labeledCheckboxSnapshot(checked: boolean) {
  const strings = [
    '',
    'frame-main',
    '#document',
    'LABEL',
    'INPUT',
    '#text',
    'for',
    'choice-a',
    'id',
    'type',
    'checkbox',
    'pointer',
    'block',
    'visible',
    'auto',
  ];
  return {
    strings,
    documents: [
      {
        documentURL: 0,
        title: 0,
        baseURL: 0,
        contentLanguage: 0,
        encodingName: 0,
        publicId: 0,
        systemId: 0,
        frameId: 1,
        nodes: {
          parentIndex: [-1, 0, 1, 1],
          nodeType: [9, 1, 1, 3],
          nodeName: [2, 3, 4, 5],
          nodeValue: [0, 0, 0, 0],
          backendNodeId: [1, 11, 12, 13],
          attributes: [[], [6, 7], [8, 7, 9, 10], []],
          isClickable: { index: [1] },
          inputChecked: { index: checked ? [2] : [] },
        },
        layout: {
          nodeIndex: [1, 3],
          styles: [
            [11, 12, 13, 14],
            [11, 12, 13, 14],
          ],
          bounds: [
            [10, 20, 160, 30],
            [30, 20, 120, 30],
          ],
          text: [0, 0],
          stackingContexts: { index: [] },
        },
        textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
      },
    ],
  };
}

describe('buildSemanticPageSnapshot', () => {
  it('binds editable AX descendants to their nearest contenteditable host', () => {
    const editable = {
      name: 'editable',
      value: { type: 'boolean', value: true },
    } satisfies Protocol.Accessibility.AXProperty;
    const result = buildSemanticPageSnapshot({
      axNodes: [
        axNode('root', 1, 'RootWebArea', 'Messenger', { childIds: ['editor'] }),
        axNode('editor', 20, 'generic', '', {
          parentId: 'root',
          childIds: ['editor-text'],
          properties: [editable],
        }),
        axNode('editor-text', 23, 'StaticText', '\u200b', {
          parentId: 'editor',
          properties: [editable],
        }),
      ],
      domSnapshot: domSnapshot([
        { backendNodeId: 1, nodeName: '#document', parentIndex: -1 },
        {
          backendNodeId: 10,
          nodeName: 'DIV',
          parentIndex: 0,
          bounds: [100, 50, 700, 48],
        },
        {
          backendNodeId: 11,
          nodeName: 'SPAN',
          parentIndex: 1,
          bounds: [110, 60, 80, 28],
        },
        {
          backendNodeId: 12,
          nodeName: '#text',
          parentIndex: 2,
          text: 'Search',
          bounds: [110, 60, 80, 28],
        },
        {
          backendNodeId: 20,
          nodeName: 'DIV',
          parentIndex: 1,
          attributes: { contenteditable: 'true' },
          bounds: [200, 60, 580, 28],
        },
        {
          backendNodeId: 21,
          nodeName: 'DIV',
          parentIndex: 4,
          attributes: { class: 'ace-line' },
          bounds: [200, 60, 580, 28],
        },
        {
          backendNodeId: 22,
          nodeName: 'SPAN',
          parentIndex: 5,
          bounds: [200, 60, 12, 28],
        },
        {
          backendNodeId: 23,
          nodeName: '#text',
          parentIndex: 6,
          text: '\u200b',
          bounds: [200, 60, 12, 28],
        },
      ]),
      frame: 'main',
    });

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toEqual(
      expect.objectContaining({
        backendNodeId: 20,
        role: 'textbox',
        name: 'Search',
        actions: ['click', 'type'],
      }),
    );
    expect(result.targets).not.toContainEqual(expect.objectContaining({ backendNodeId: 23 }));
    expect(result.entries).toContainEqual(
      expect.objectContaining({
        role: 'textbox',
        name: 'Search',
        targetIndex: 0,
        actions: ['click', 'type'],
      }),
    );
  });

  it('synthesizes a named textbox target for an empty visible contenteditable missing from AX', () => {
    const result = buildSemanticPageSnapshot({
      axNodes: [axNode('root', 1, 'RootWebArea', 'Messenger')],
      domSnapshot: domSnapshot([
        { backendNodeId: 1, nodeName: '#document', parentIndex: -1 },
        {
          backendNodeId: 10,
          nodeName: 'DIV',
          parentIndex: 0,
          bounds: [100, 50, 700, 48],
        },
        {
          backendNodeId: 20,
          nodeName: 'DIV',
          parentIndex: 1,
          attributes: { contenteditable: 'true' },
          bounds: [140, 60, 600, 28],
        },
        {
          backendNodeId: 30,
          nodeName: 'SPAN',
          parentIndex: 1,
          bounds: [140, 60, 240, 28],
        },
        {
          backendNodeId: 31,
          nodeName: '#text',
          parentIndex: 3,
          text: 'Search people',
          bounds: [140, 60, 120, 28],
        },
      ]),
      frame: 'main',
    });

    expect(result.targets).toEqual([
      expect.objectContaining({
        backendNodeId: 20,
        role: 'textbox',
        name: 'Search people',
        state: [],
        actions: ['click', 'type'],
      }),
    ]);
    expect(result.entries).toContainEqual(
      expect.objectContaining({
        role: 'textbox',
        name: 'Search people',
        targetIndex: 0,
        actions: ['click', 'type'],
      }),
    );
  });

  it('exposes a nested overflow container as an explicit scroll target', () => {
    const result = buildSemanticPageSnapshot({
      axNodes: [
        axNode('root', 1, 'RootWebArea', 'Messenger', { childIds: ['message'] }),
        axNode('message', 20, 'StaticText', 'Newest message', { parentId: 'root' }),
      ],
      domSnapshot: domSnapshot([
        { backendNodeId: 1, nodeName: '#document', parentIndex: -1 },
        {
          backendNodeId: 10,
          nodeName: 'DIV',
          parentIndex: 0,
          attributes: { 'aria-label': 'Message history' },
          overflowY: 'auto',
          bounds: [400, 100, 600, 500],
          clientRect: [400, 100, 600, 500],
          scrollRect: [400, 100, 600, 4_000],
        },
        {
          backendNodeId: 20,
          nodeName: 'DIV',
          parentIndex: 1,
          bounds: [420, 560, 540, 30],
        },
      ]),
      frame: 'main',
    });

    expect(result.targets).toContainEqual(
      expect.objectContaining({
        backendNodeId: 10,
        role: 'region',
        name: 'Message history',
        actions: ['scroll'],
      }),
    );
    expect(result.entries).toContainEqual(
      expect.objectContaining({
        role: 'region',
        name: 'Message history',
        actions: ['scroll'],
      }),
    );
  });

  it('follows AX child order and preserves repeated labels in different groups', () => {
    const result = buildSemanticPageSnapshot({
      axNodes: [
        axNode('question-2-type', 22, 'StaticText', 'Single choice', {
          parentId: 'question-2',
        }),
        axNode('question-1-type', 12, 'StaticText', 'Single choice', {
          parentId: 'question-1',
        }),
        axNode('root', 1, 'RootWebArea', 'Exam', {
          childIds: ['question-1', 'question-2'],
        }),
        axNode('question-2-title', 23, 'StaticText', 'Second question?', {
          parentId: 'question-2',
        }),
        axNode('question-1', 10, 'group', 'Question 1', {
          parentId: 'root',
          childIds: ['question-1-type', 'question-1-title'],
        }),
        axNode('question-2', 20, 'group', 'Question 2', {
          parentId: 'root',
          childIds: ['question-2-type', 'question-2-title'],
        }),
        axNode('question-1-title', 13, 'StaticText', 'First question?', {
          parentId: 'question-1',
        }),
      ],
      domSnapshot: domSnapshot([{ backendNodeId: 1, nodeName: '#document', parentIndex: -1 }]),
      frame: 'main',
    });

    expect(result.entries).toEqual([
      { depth: 1, role: 'group', name: 'Question 1' },
      { depth: 2, role: 'statictext', name: 'Single choice' },
      { depth: 2, role: 'statictext', name: 'First question?' },
      { depth: 1, role: 'group', name: 'Question 2' },
      { depth: 2, role: 'statictext', name: 'Single choice' },
      { depth: 2, role: 'statictext', name: 'Second question?' },
    ]);
  });

  it('gives repeated controls stable container-scoped locators across node replacement', () => {
    const build = (firstBackendNodeId: number, secondBackendNodeId: number) =>
      buildSemanticPageSnapshot({
        axNodes: [
          axNode('root', 1, 'RootWebArea', 'Exam', {
            childIds: ['question-1', 'question-2'],
          }),
          axNode('question-1', 10, 'group', 'Question 1', {
            parentId: 'root',
            childIds: ['answer-1'],
          }),
          axNode('answer-1', firstBackendNodeId, 'checkbox', 'A', {
            parentId: 'question-1',
          }),
          axNode('question-2', 20, 'group', 'Question 2', {
            parentId: 'root',
            childIds: ['answer-2'],
          }),
          axNode('answer-2', secondBackendNodeId, 'checkbox', 'A', {
            parentId: 'question-2',
          }),
        ],
        domSnapshot: domSnapshot([
          { backendNodeId: 1, nodeName: '#document', parentIndex: -1 },
          { backendNodeId: 10, nodeName: 'SECTION', parentIndex: 0 },
          {
            backendNodeId: firstBackendNodeId,
            nodeName: 'INPUT',
            parentIndex: 1,
            attributes: { type: 'checkbox' },
            clickable: true,
            cursor: 'pointer',
            bounds: [20, 80, 20, 20],
          },
          { backendNodeId: 20, nodeName: 'SECTION', parentIndex: 0 },
          {
            backendNodeId: secondBackendNodeId,
            nodeName: 'INPUT',
            parentIndex: 3,
            attributes: { type: 'checkbox' },
            clickable: true,
            cursor: 'pointer',
            bounds: [20, 180, 20, 20],
          },
        ]),
        frame: 'main',
      });

    const initial = build(11, 21);
    const replaced = build(12, 22);
    const initialLocators = initial.targets.map((target) => target.semanticLocator);
    const replacedLocators = replaced.targets.map((target) => target.semanticLocator);

    expect(initialLocators).toHaveLength(2);
    expect(initialLocators[0]).toBeTruthy();
    expect(initialLocators[0]).not.toBe(initialLocators[1]);
    expect(replacedLocators).toEqual(initialLocators);
  });

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
        role: 'option',
        name: 'A. First answer',
        state: ['selected'],
        actions: ['click', 'set_checked'],
      }),
    ]);
    expect(result.entries).toEqual([
      {
        depth: 1,
        role: 'option',
        name: 'A. First answer',
        targetIndex: 0,
        state: ['selected'],
        actions: ['click', 'set_checked'],
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
        role: 'option',
        name: 'A. First answer',
        state: ['selected'],
        actions: ['click', 'set_checked'],
      }),
      expect.objectContaining({
        backendNodeId: 30,
        role: 'option',
        name: 'B. Second answer',
        state: ['selected=false'],
        actions: ['click', 'set_checked'],
      }),
      expect.objectContaining({ backendNodeId: 40, role: 'button', actions: ['click'] }),
    ]);
    expect(result.entries).toEqual([
      { depth: 1, role: 'statictext', name: '1. Which option is correct?' },
      {
        depth: 1,
        role: 'option',
        name: 'A. First answer',
        targetIndex: 0,
        state: ['selected'],
        actions: ['click', 'set_checked'],
      },
      {
        depth: 1,
        role: 'option',
        name: 'B. Second answer',
        targetIndex: 1,
        state: ['selected=false'],
        actions: ['click', 'set_checked'],
      },
      {
        depth: 1,
        role: 'button',
        name: 'Submit',
        targetIndex: 2,
        actions: ['click'],
      },
    ]);
    expect(result.hasVisualSurface).toBe(false);
    expect(JSON.stringify(result.entries)).not.toContain('bounds');
    expect(JSON.stringify(result.entries)).not.toContain('backendNodeId');
  });

  it('keeps every exam option selected when the whole multi-select group is checked', () => {
    const result = buildSemanticPageSnapshot({
      axNodes: [
        axNode('root', 1, 'RootWebArea', 'Exam', {
          childIds: ['choice-a', 'choice-b'],
        }),
        axNode('choice-a', 21, 'StaticText', 'A. First answer', { parentId: 'root' }),
        axNode('choice-b', 31, 'StaticText', 'B. Second answer', { parentId: 'root' }),
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
          bounds: [40, 170, 700, 28],
        },
        {
          backendNodeId: 30,
          nodeName: 'DIV',
          parentIndex: 0,
          attributes: { class: 'choice-option__7sZO8 checked__Hq2oI' },
          cursor: 'pointer',
          clickable: true,
          bounds: [20, 220, 760, 48],
        },
        {
          backendNodeId: 31,
          nodeName: 'SPAN',
          parentIndex: 3,
          cursor: 'pointer',
          bounds: [40, 230, 700, 28],
        },
      ]),
      frame: 'main',
    });

    expect(result.targets).toEqual([
      expect.objectContaining({
        backendNodeId: 20,
        role: 'option',
        state: ['selected'],
        actions: ['click', 'set_checked'],
      }),
      expect.objectContaining({
        backendNodeId: 30,
        role: 'option',
        state: ['selected'],
        actions: ['click', 'set_checked'],
      }),
    ]);
  });

  it('reads an explicit state class on a standalone custom checkbox', () => {
    const result = buildSemanticPageSnapshot({
      axNodes: [
        axNode('root', 1, 'RootWebArea', 'Settings', { childIds: ['toggle'] }),
        axNode('toggle', 20, 'checkbox', 'Enable alerts', { parentId: 'root' }),
      ],
      domSnapshot: domSnapshot([
        { backendNodeId: 1, nodeName: '#document', parentIndex: -1 },
        {
          backendNodeId: 20,
          nodeName: 'DIV',
          parentIndex: 0,
          attributes: { class: 'ui-checkbox is-checked' },
          cursor: 'pointer',
          clickable: true,
          bounds: [20, 20, 160, 32],
        },
      ]),
      frame: 'main',
    });

    expect(result.targets).toEqual([
      expect.objectContaining({
        backendNodeId: 20,
        role: 'checkbox',
        state: ['checked'],
        actions: ['click', 'set_checked'],
      }),
    ]);
  });

  it('reads exact data-state semantics on a standalone custom switch', () => {
    const result = buildSemanticPageSnapshot({
      axNodes: [
        axNode('root', 1, 'RootWebArea', 'Settings', { childIds: ['toggle'] }),
        axNode('toggle', 20, 'switch', 'Dark mode', { parentId: 'root' }),
      ],
      domSnapshot: domSnapshot([
        { backendNodeId: 1, nodeName: '#document', parentIndex: -1 },
        {
          backendNodeId: 20,
          nodeName: 'BUTTON',
          parentIndex: 0,
          attributes: { class: 'toggle-switch', 'data-state': 'checked' },
          cursor: 'pointer',
          clickable: true,
          bounds: [20, 20, 80, 32],
        },
      ]),
      frame: 'main',
    });

    expect(result.targets).toEqual([
      expect.objectContaining({
        backendNodeId: 20,
        role: 'switch',
        state: ['checked'],
        actions: ['click', 'set_checked'],
      }),
    ]);
  });

  it('keeps authoritative AX selection state ahead of CSS state hints', () => {
    const result = buildSemanticPageSnapshot({
      axNodes: [
        axNode('root', 1, 'RootWebArea', 'Settings', {
          childIds: ['first-toggle', 'second-toggle'],
        }),
        axNode('first-toggle', 20, 'checkbox', 'First toggle', {
          parentId: 'root',
          properties: [{ name: 'checked', value: { type: 'boolean', value: false } }],
        }),
        axNode('second-toggle', 30, 'checkbox', 'Second toggle', { parentId: 'root' }),
      ],
      domSnapshot: domSnapshot([
        { backendNodeId: 1, nodeName: '#document', parentIndex: -1 },
        {
          backendNodeId: 20,
          nodeName: 'DIV',
          parentIndex: 0,
          attributes: { class: 'ui-checkbox checked' },
          cursor: 'pointer',
          clickable: true,
          bounds: [20, 20, 160, 32],
        },
        {
          backendNodeId: 30,
          nodeName: 'DIV',
          parentIndex: 0,
          attributes: { class: 'ui-checkbox' },
          cursor: 'pointer',
          clickable: true,
          bounds: [20, 60, 160, 32],
        },
      ]),
      frame: 'main',
    });

    expect(result.targets[0]).toEqual(
      expect.objectContaining({
        backendNodeId: 20,
        role: 'checkbox',
        state: ['checked=false'],
      }),
    );
  });

  it('does not treat an active checkbox class as checked state', () => {
    const result = buildSemanticPageSnapshot({
      axNodes: [
        axNode('root', 1, 'RootWebArea', 'Settings', {
          childIds: ['first-toggle', 'second-toggle'],
        }),
        axNode('first-toggle', 20, 'checkbox', 'First toggle', { parentId: 'root' }),
        axNode('second-toggle', 30, 'checkbox', 'Second toggle', { parentId: 'root' }),
      ],
      domSnapshot: domSnapshot([
        { backendNodeId: 1, nodeName: '#document', parentIndex: -1 },
        {
          backendNodeId: 20,
          nodeName: 'DIV',
          parentIndex: 0,
          attributes: { class: 'ui-checkbox active' },
          cursor: 'pointer',
          clickable: true,
          bounds: [20, 20, 160, 32],
        },
        {
          backendNodeId: 30,
          nodeName: 'DIV',
          parentIndex: 0,
          attributes: { class: 'ui-checkbox' },
          cursor: 'pointer',
          clickable: true,
          bounds: [20, 60, 160, 32],
        },
      ]),
      frame: 'main',
    });

    expect(result.targets[0]).toEqual(
      expect.objectContaining({
        backendNodeId: 20,
        role: 'checkbox',
        state: ['checked=false'],
      }),
    );
  });

  it('recognizes an unselected custom choice group before any option is selected', () => {
    const result = buildSemanticPageSnapshot({
      axNodes: [
        axNode('root', 1, 'RootWebArea', 'Survey', {
          childIds: ['choice-a', 'choice-b'],
        }),
        axNode('choice-a', 21, 'StaticText', 'A. First answer', { parentId: 'root' }),
        axNode('choice-b', 31, 'StaticText', 'B. Second answer', { parentId: 'root' }),
      ],
      domSnapshot: domSnapshot([
        { backendNodeId: 1, nodeName: '#document', parentIndex: -1 },
        {
          backendNodeId: 20,
          nodeName: 'DIV',
          parentIndex: 0,
          attributes: { class: 'choice-option__7sZO8' },
          cursor: 'pointer',
          clickable: true,
          bounds: [20, 160, 760, 48],
        },
        {
          backendNodeId: 21,
          nodeName: 'SPAN',
          parentIndex: 1,
          cursor: 'pointer',
          bounds: [40, 170, 700, 28],
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
        {
          backendNodeId: 31,
          nodeName: 'SPAN',
          parentIndex: 3,
          cursor: 'pointer',
          bounds: [40, 230, 700, 28],
        },
      ]),
      frame: 'main',
    });

    expect(result.targets).toEqual([
      expect.objectContaining({
        backendNodeId: 20,
        role: 'option',
        state: ['selected=false'],
        actions: ['click', 'set_checked'],
      }),
      expect.objectContaining({
        backendNodeId: 30,
        role: 'option',
        state: ['selected=false'],
        actions: ['click', 'set_checked'],
      }),
    ]);
  });

  it('does not advertise actions for a disabled control', () => {
    const result = buildSemanticPageSnapshot({
      axNodes: [
        axNode('root', 1, 'RootWebArea', 'Form', { childIds: ['submit'] }),
        axNode('submit', 20, 'button', 'Submit', {
          parentId: 'root',
          properties: [
            { name: 'focusable', value: { type: 'boolean', value: true } },
            { name: 'disabled', value: { type: 'boolean', value: true } },
          ],
        }),
      ],
      domSnapshot: domSnapshot([
        { backendNodeId: 1, nodeName: '#document', parentIndex: -1 },
        {
          backendNodeId: 20,
          nodeName: 'BUTTON',
          parentIndex: 0,
          attributes: { disabled: '' },
          cursor: 'pointer',
          clickable: true,
          bounds: [20, 20, 120, 40],
        },
      ]),
      frame: 'main',
    });

    expect(result.targets).toEqual([]);
    expect(result.entries).toEqual([
      { depth: 1, role: 'button', name: 'Submit', state: ['disabled'] },
    ]);
  });

  it('does not advertise typing for a native readonly editor', () => {
    const result = buildSemanticPageSnapshot({
      axNodes: [
        axNode('root', 1, 'RootWebArea', 'Profile', { childIds: ['account-id'] }),
        axNode('account-id', 20, 'textbox', 'Account ID', { parentId: 'root' }),
      ],
      domSnapshot: domSnapshot([
        { backendNodeId: 1, nodeName: '#document', parentIndex: -1 },
        {
          backendNodeId: 20,
          nodeName: 'INPUT',
          parentIndex: 0,
          attributes: { readonly: '' },
          cursor: 'text',
          clickable: true,
          bounds: [20, 20, 240, 40],
        },
      ]),
      frame: 'main',
    });

    expect(result.targets).toEqual([
      expect.objectContaining({
        backendNodeId: 20,
        role: 'textbox',
        state: ['readonly'],
        actions: ['click'],
      }),
    ]);
  });

  it('keeps answer-sheet navigation as ordinary clicks without selection semantics', () => {
    const result = buildSemanticPageSnapshot({
      axNodes: [
        axNode('root', 1, 'RootWebArea', 'Exam', { childIds: ['jump-1', 'jump-2'] }),
        axNode('jump-1', 21, 'StaticText', '1', { parentId: 'root' }),
        axNode('jump-2', 31, 'StaticText', '2', { parentId: 'root' }),
      ],
      domSnapshot: domSnapshot([
        { backendNodeId: 1, nodeName: '#document', parentIndex: -1 },
        {
          backendNodeId: 10,
          nodeName: 'DIV',
          parentIndex: 0,
          attributes: { class: 'answer-list__WdF-a' },
          bounds: [0, 0, 200, 100],
        },
        {
          backendNodeId: 20,
          nodeName: 'DIV',
          parentIndex: 1,
          attributes: { class: 'answer__3XFOT finished__Z49Cw' },
          cursor: 'pointer',
          clickable: true,
          bounds: [10, 10, 32, 32],
        },
        {
          backendNodeId: 21,
          nodeName: 'SPAN',
          parentIndex: 2,
          cursor: 'pointer',
          bounds: [10, 10, 32, 32],
        },
        {
          backendNodeId: 30,
          nodeName: 'DIV',
          parentIndex: 1,
          attributes: { class: 'answer__3XFOT' },
          cursor: 'pointer',
          clickable: true,
          bounds: [50, 10, 32, 32],
        },
        {
          backendNodeId: 31,
          nodeName: 'SPAN',
          parentIndex: 4,
          cursor: 'pointer',
          bounds: [50, 10, 32, 32],
        },
      ]),
      frame: 'main',
    });

    expect(result.targets).toEqual([
      expect.objectContaining({
        backendNodeId: 20,
        role: 'statictext',
        name: '1',
        state: [],
        actions: ['click'],
      }),
      expect.objectContaining({
        backendNodeId: 30,
        role: 'statictext',
        name: '2',
        state: [],
        actions: ['click'],
      }),
    ]);
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

  it('detects a rendered canvas as a visual fallback surface', () => {
    const result = buildSemanticPageSnapshot({
      axNodes: [axNode('root', 1, 'RootWebArea', 'Canvas app')],
      domSnapshot: domSnapshot([
        { backendNodeId: 1, nodeName: '#document', parentIndex: -1 },
        {
          backendNodeId: 2,
          nodeName: 'CANVAS',
          parentIndex: 0,
          bounds: [0, 0, 800, 600],
        },
      ]),
      frame: 'main',
    });

    expect(result.hasVisualSurface).toBe(true);
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
        actions: ['click', 'set_checked'],
        frame: 'frame-child',
      },
    ]);
  });

  it.each([
    [false, ['checked=false']],
    [true, ['checked']],
  ] as const)(
    'uses the backing checkbox semantics for a clickable static-text label (checked=%s)',
    (checked, state) => {
      const result = buildSemanticPageSnapshot({
        axNodes: [
          {
            nodeId: 'label-text',
            backendDOMNodeId: 13,
            ignored: false,
            role: { type: 'role', value: 'StaticText' },
            name: { type: 'computedString', value: 'Option A' },
          },
        ],
        domSnapshot: labeledCheckboxSnapshot(checked),
        frame: 'main',
      });

      expect(result.entries).toEqual([
        {
          depth: 0,
          role: 'checkbox',
          name: 'Option A',
          targetIndex: 0,
          state,
          actions: ['click', 'set_checked'],
        },
      ]);
      expect(result.targets).toEqual([
        {
          backendNodeId: 11,
          stateBackendNodeId: 12,
          documentFrameId: 'frame-main',
          role: 'checkbox',
          name: 'Option A',
          semanticLocator: expect.any(String),
          state,
          actions: ['click', 'set_checked'],
        },
      ]);
    },
  );

  it('marks viewport membership for local prioritization without changing page semantics', () => {
    const result = buildSemanticPageSnapshot({
      axNodes: [
        axNode('visible', 11, 'StaticText', 'Visible question'),
        axNode('offscreen', 12, 'StaticText', 'Offscreen appendix'),
      ],
      domSnapshot: domSnapshot([
        { backendNodeId: 1, nodeName: '#document', parentIndex: -1 },
        {
          backendNodeId: 11,
          nodeName: 'DIV',
          parentIndex: 0,
          bounds: [20, 40, 500, 40],
        },
        {
          backendNodeId: 12,
          nodeName: 'DIV',
          parentIndex: 0,
          bounds: [20, 1_400, 500, 40],
        },
      ]),
      frame: 'main',
      viewport: { x: 0, y: 0, width: 1_000, height: 800 },
    });

    expect(result.entries).toEqual([
      expect.objectContaining({ name: 'Visible question', inViewport: true }),
      expect.objectContaining({ name: 'Offscreen appendix', inViewport: false }),
    ]);
  });
});
