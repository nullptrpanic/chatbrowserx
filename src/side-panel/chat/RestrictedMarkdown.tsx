import type { ReactNode } from 'react';

/** Renders inline code and safe HTTP(S) links while React escapes all remaining text. */
function renderInline(text: string): ReactNode[] {
  const pattern = /(`[^`\n]+`|https?:\/\/[^\s<]+)/g;
  return text.split(pattern).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={`${String(index)}:code`}>{part.slice(1, -1)}</code>;
    }
    if (/^https?:\/\//.test(part)) {
      return (
        <a key={`${String(index)}:link`} href={part} target="_blank" rel="noreferrer noopener">
          {part}
        </a>
      );
    }
    return part;
  });
}

/** Renders a deliberately restricted Markdown subset with no raw HTML interpretation. */
export function RestrictedMarkdown({ text }: { readonly text: string }) {
  const blocks = text.split(/(```[\s\S]*?```)/g).filter((block) => block.length > 0);
  return (
    <div className="message-markdown">
      {blocks.map((block, blockIndex) => {
        if (block.startsWith('```') && block.endsWith('```')) {
          const content = block.slice(3, -3).replace(/^\w+\n/, '');
          return (
            <pre key={`${String(blockIndex)}:fence`}>
              <code>{content}</code>
            </pre>
          );
        }
        return block
          .split(/\n{2,}/)
          .map((paragraph, paragraphIndex) => (
            <p key={`${String(blockIndex)}:${String(paragraphIndex)}`}>
              {paragraph
                .split('\n')
                .flatMap((line, lineIndex) => [
                  ...(lineIndex === 0 ? [] : [<br key={`${String(lineIndex)}:break`} />]),
                  ...renderInline(line),
                ])}
            </p>
          ));
      })}
    </div>
  );
}
