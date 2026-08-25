import { createElement, type ReactNode } from 'react';
import { highlightCode } from './highlight-code';

const inlinePattern =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<]+)/g;
const unorderedItemPattern = /^\s*[-+*]\s+(.+)$/;
const orderedItemPattern = /^\s*\d+[.)]\s+(.+)$/;
const thematicBreakPattern = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;

type TableAlignment = 'left' | 'center' | 'right' | undefined;

interface ParsedMarkdownTable {
  readonly headers: readonly string[];
  readonly alignments: readonly TableAlignment[];
  readonly rows: readonly (readonly string[])[];
  readonly nextIndex: number;
}

/** Renders a safe inline Markdown subset while React escapes all remaining text. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(inlinePattern).map((part, index) => {
    const key = `${keyPrefix}:${String(index)}`;
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code className="markdown-inline-code" key={`${key}:code`}>
          {part.slice(1, -1)}
        </code>
      );
    }
    if (
      (part.startsWith('**') && part.endsWith('**')) ||
      (part.startsWith('__') && part.endsWith('__'))
    ) {
      return <strong key={`${key}:strong`}>{renderInline(part.slice(2, -2), key)}</strong>;
    }
    const markdownLink = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    if (markdownLink !== null) {
      return (
        <a key={`${key}:link`} href={markdownLink[2]} target="_blank" rel="noreferrer noopener">
          {markdownLink[1]}
        </a>
      );
    }
    if (/^https?:\/\//.test(part)) {
      return (
        <a key={`${key}:link`} href={part} target="_blank" rel="noreferrer noopener">
          {part}
        </a>
      );
    }
    return part;
  });
}

function renderLines(lines: readonly string[], keyPrefix: string): ReactNode[] {
  return lines.flatMap((line, index) => [
    ...(index === 0 ? [] : [<br key={`${keyPrefix}:${String(index)}:break`} />]),
    ...renderInline(line, `${keyPrefix}:${String(index)}`),
  ]);
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/** Splits one pipe row without treating escaped or inline-code pipes as column boundaries. */
function splitTableRow(line: string): readonly string[] | null {
  let source = line.trim();
  if (!source.includes('|')) return null;

  let hasOuterPipe = false;
  if (source.startsWith('|')) {
    source = source.slice(1);
    hasOuterPipe = true;
  }
  if (source.endsWith('|') && !isEscaped(source, source.length - 1)) {
    source = source.slice(0, -1);
    hasOuterPipe = true;
  }

  const cells: string[] = [];
  let cell = '';
  let insideCode = false;
  let foundSeparator = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    if (character === '\\' && source[index + 1] === '|') {
      cell += '|';
      index += 1;
      continue;
    }
    if (character === '`' && !isEscaped(source, index)) {
      insideCode = !insideCode;
      cell += character;
      continue;
    }
    if (character === '|' && !insideCode) {
      cells.push(cell.trim());
      cell = '';
      foundSeparator = true;
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());
  return hasOuterPipe || foundSeparator ? cells : null;
}

function tableAlignment(value: string): TableAlignment | null {
  const separator = /^(:)?-{3,}(:)?$/.exec(value.trim());
  if (separator === null) return null;
  if (separator[1] && separator[2]) return 'center';
  if (separator[1]) return 'left';
  if (separator[2]) return 'right';
  return undefined;
}

/** Recognizes one bounded GFM-style table beginning at the requested prose line. */
function parseTable(lines: readonly string[], startIndex: number): ParsedMarkdownTable | null {
  const headers = splitTableRow(lines[startIndex] ?? '');
  const separators = splitTableRow(lines[startIndex + 1] ?? '');
  if (headers === null || separators === null || headers.length !== separators.length) return null;

  const alignments = separators.map(tableAlignment);
  if (alignments.some((alignment) => alignment === null)) return null;

  const rows: string[][] = [];
  let index = startIndex + 2;
  while (index < lines.length && (lines[index] ?? '').trim().length > 0) {
    const cells = splitTableRow(lines[index] ?? '');
    if (cells === null) break;
    rows.push(headers.map((_, cellIndex) => cells[cellIndex] ?? ''));
    index += 1;
  }
  return {
    headers,
    alignments: alignments as readonly TableAlignment[],
    rows,
    nextIndex: index,
  };
}

function renderTable(table: ParsedMarkdownTable, keyPrefix: string): ReactNode {
  const alignmentStyle = (index: number) => {
    const textAlign = table.alignments[index];
    return textAlign === undefined ? undefined : { textAlign };
  };
  return (
    <div className="markdown-table-scroll" key={`${keyPrefix}:table`}>
      <table>
        <thead>
          <tr>
            {table.headers.map((header, index) => (
              <th key={`${keyPrefix}:header:${String(index)}`} style={alignmentStyle(index)}>
                {renderInline(header, `${keyPrefix}:header:${String(index)}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={`${keyPrefix}:row:${String(rowIndex)}`}>
              {row.map((cell, cellIndex) => (
                <td
                  key={`${keyPrefix}:row:${String(rowIndex)}:cell:${String(cellIndex)}`}
                  style={alignmentStyle(cellIndex)}
                >
                  {renderInline(
                    cell,
                    `${keyPrefix}:row:${String(rowIndex)}:cell:${String(cellIndex)}`,
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function isBlockStart(line: string): boolean {
  return (
    /^#{1,6}\s+/.test(line) ||
    thematicBreakPattern.test(line) ||
    unorderedItemPattern.test(line) ||
    orderedItemPattern.test(line) ||
    /^\s*>\s?/.test(line)
  );
}

/** Converts non-fenced prose into a small set of common semantic Markdown blocks. */
function renderProse(text: string, keyPrefix: string): ReactNode[] {
  const lines = text.split('\n');
  const nodes: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const table = parseTable(lines, index);
    if (table !== null) {
      nodes.push(renderTable(table, `${keyPrefix}:${String(index)}`));
      index = table.nextIndex;
      continue;
    }

    if (thematicBreakPattern.test(line)) {
      nodes.push(<hr key={`${keyPrefix}:${String(index)}:thematic-break`} />);
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? '').length;
      nodes.push(
        createElement(
          `h${String(level)}`,
          { key: `${keyPrefix}:${String(index)}:heading` },
          ...renderInline(heading[2] ?? '', `${keyPrefix}:${String(index)}:heading`),
        ),
      );
      index += 1;
      continue;
    }

    const unorderedItem = unorderedItemPattern.exec(line);
    if (unorderedItem !== null) {
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const match = unorderedItemPattern.exec(lines[index] ?? '');
        if (match === null) break;
        items.push(
          <li key={`${keyPrefix}:${String(index)}:item`}>
            {renderInline(match[1] ?? '', `${keyPrefix}:${String(index)}:item`)}
          </li>,
        );
        index += 1;
      }
      nodes.push(<ul key={`${keyPrefix}:${String(index)}:list`}>{items}</ul>);
      continue;
    }

    const orderedItem = orderedItemPattern.exec(line);
    if (orderedItem !== null) {
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const match = orderedItemPattern.exec(lines[index] ?? '');
        if (match === null) break;
        items.push(
          <li key={`${keyPrefix}:${String(index)}:item`}>
            {renderInline(match[1] ?? '', `${keyPrefix}:${String(index)}:item`)}
          </li>,
        );
        index += 1;
      }
      nodes.push(<ol key={`${keyPrefix}:${String(index)}:list`}>{items}</ol>);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      const quoteStart = index;
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? '')) {
        quoteLines.push((lines[index] ?? '').replace(/^\s*>\s?/, ''));
        index += 1;
      }
      nodes.push(
        <blockquote key={`${keyPrefix}:${String(quoteStart)}:quote`}>
          {renderLines(quoteLines, `${keyPrefix}:${String(quoteStart)}:quote`)}
        </blockquote>,
      );
      continue;
    }

    const paragraphLines = [line];
    const paragraphStart = index;
    index += 1;
    while (
      index < lines.length &&
      (lines[index] ?? '').trim().length > 0 &&
      !isBlockStart(lines[index] ?? '') &&
      parseTable(lines, index) === null
    ) {
      paragraphLines.push(lines[index] ?? '');
      index += 1;
    }
    nodes.push(
      <p key={`${keyPrefix}:${String(paragraphStart)}:paragraph`}>
        {renderLines(paragraphLines, `${keyPrefix}:${String(paragraphStart)}:paragraph`)}
      </p>,
    );
  }

  return nodes;
}

function parseFence(block: string): { readonly content: string; readonly language?: string } {
  const body = block.slice(3, -3);
  const firstNewline = body.indexOf('\n');
  if (firstNewline < 0) return { content: body };

  const firstLine = body.slice(0, firstNewline).trim();
  const remaining = body.slice(firstNewline + 1);
  if (firstLine.length === 0) return { content: remaining };
  if (/^[\w+-]{1,32}$/.test(firstLine)) return { content: remaining, language: firstLine };
  return { content: body };
}

/** Renders a deliberately restricted Markdown subset with no raw HTML interpretation. */
export function RestrictedMarkdown({ text }: { readonly text: string }) {
  const blocks = text.split(/(```[\s\S]*?```)/g).filter((block) => block.length > 0);
  return (
    <div className="message-markdown">
      {blocks.flatMap((block, blockIndex) => {
        const key = String(blockIndex);
        if (block.startsWith('```') && block.endsWith('```')) {
          const fence = parseFence(block);
          return (
            <pre
              className="markdown-code-block"
              data-language={fence.language}
              key={`${key}:fence`}
            >
              <code>{highlightCode(fence.content, fence.language)}</code>
            </pre>
          );
        }
        return renderProse(block, key);
      })}
    </div>
  );
}
