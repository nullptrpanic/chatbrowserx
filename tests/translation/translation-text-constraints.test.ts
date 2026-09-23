import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTranslationGeometry } from '../../src/page/translation/translation-geometry';
import { readTranslationTextConstraints } from '../../src/page/translation/translation-text-constraints';

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  const create = document.createRange.bind(document);
  vi.spyOn(document, 'createRange').mockImplementation(() =>
    Object.assign(create(), { getClientRects: () => [new DOMRect(0, 0, 100, 20)] }),
  );
});

it('limits constraint geometry reads to admitted copies instead of a large hidden subtree', () => {
  document.body.innerHTML =
    '<main><p style="text-overflow:ellipsis;overflow-x:hidden">Visible title</p><div hidden>' +
    '<span></span>'.repeat(8000) +
    '</div></main>';
  const root = document.querySelector('main');
  const paragraph = document.querySelector('p');
  const hidden = document.querySelector('div');
  const node = paragraph?.firstChild;
  if (!root || !paragraph || !hidden || !node) throw new Error('Missing constraint fixture');
  const copies = new Map<Node, Node>(
    [root, paragraph, node].map((node) => [node, node.cloneNode(false)]),
  );
  const geometry = createTranslationGeometry(window);
  const reads = vi.spyOn(geometry, 'facts');
  const constraints = readTranslationTextConstraints(
    root,
    undefined,
    [],
    geometry,
    { x: 0, y: 0, width: 600, height: 100 },
    copies,
  );
  expect(reads.mock.calls.filter(([el]) => el.parentElement === hidden)).toHaveLength(0);
  expect(constraints.labels.map((label) => label.source)).toEqual([paragraph]);
  expect(paragraph.textContent).toBe('Visible title');
});

it('does not scan an omitted sibling when deriving constraints for a sliced flow parent', () => {
  document.body.innerHTML =
    '<main style="-webkit-line-clamp:2"><section><p>First</p></section><section><p>Second</p></section><div><span>Live sibling</span></div></main>';
  const root = document.querySelector('main');
  const omitted = document.querySelector('div');
  if (!root || !omitted) throw new Error('Missing sliced-flow fixture');
  const children = [...root.querySelectorAll('section')];
  const admitted: Node[] = [root];
  for (const child of children) {
    const paragraph = child.firstChild;
    const node = paragraph?.firstChild;
    if (!paragraph || !node) throw new Error('Missing sliced-flow paragraph');
    admitted.push(child, paragraph, node);
  }
  const copies = new Map<Node, Node>(admitted.map((node) => [node, node.cloneNode(false)]));
  const geometry = createTranslationGeometry(window);
  const reads = vi.spyOn(geometry, 'facts');
  readTranslationTextConstraints(
    root,
    children,
    [],
    geometry,
    { x: 0, y: 0, width: 600, height: 100 },
    copies,
  );
  expect(reads.mock.calls.some(([el]) => omitted.contains(el))).toBe(false);
});
