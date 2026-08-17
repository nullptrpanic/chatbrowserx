import { createElement, type ReactNode } from 'react';
import { highlightCode } from './highlight-code';

const inlinePattern =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<]+)/g;
const unorderedItemPattern = /^\s*[-+*]\s+(.+)$/;
const orderedItemPattern = /^\s*\d+[.)]\s+(.+)$/;

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

function isBlockStart(line: string): boolean {
  return (
    /^#{1,6}\s+/.test(line) ||
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
      !isBlockStart(lines[index] ?? '')
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
