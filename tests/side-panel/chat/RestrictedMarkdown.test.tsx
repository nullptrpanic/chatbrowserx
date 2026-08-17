import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RestrictedMarkdown } from '../../../src/side-panel/chat/RestrictedMarkdown';

describe('RestrictedMarkdown', () => {
  it('renders common safe Markdown blocks and distinguishes fenced from inline code', () => {
    const { container } = render(
      <RestrictedMarkdown
        text={[
          '## 示例',
          '',
          '**代码描述：**',
          '',
          '- 主包使用 `package main`',
          '- 输出一行文本',
          '',
          '> 只展示安全文本',
          '',
          '```go',
          'package main',
          '',
          'func main() {',
          '  fmt.Println("Hello")',
          '}',
          '```',
        ].join('\n')}
      />,
    );

    expect(screen.getByRole('heading', { level: 2, name: '示例' })).toBeVisible();
    expect(screen.getByText('代码描述：').tagName).toBe('STRONG');
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('只展示安全文本').closest('blockquote')).not.toBeNull();
    expect(screen.getByText('package main', { selector: 'code' })).toHaveClass(
      'markdown-inline-code',
    );
    const fencedCode = container.querySelector('pre.markdown-code-block code');
    expect(fencedCode).toHaveTextContent('package main');
    expect(fencedCode?.closest('pre')).toHaveAttribute('data-language', 'go');
    expect(within(fencedCode as HTMLElement).getByText('package')).toHaveClass('syntax-keyword');
    expect(within(fencedCode as HTMLElement).getByText('func')).toHaveClass('syntax-keyword');
    expect(within(fencedCode as HTMLElement).getByText('"Hello"')).toHaveClass('syntax-string');
  });

  it('highlights lightweight Rust syntax in a rust fence', () => {
    const { container } = render(
      <RestrictedMarkdown
        text={['```rust', '// start', 'fn main() {', '  let count = 2;', '}', '```'].join('\n')}
      />,
    );

    const code = container.querySelector('pre.markdown-code-block code') as HTMLElement;
    expect(within(code).getByText('// start')).toHaveClass('syntax-comment');
    expect(within(code).getByText('fn')).toHaveClass('syntax-keyword');
    expect(within(code).getByText('let')).toHaveClass('syntax-keyword');
    expect(within(code).getByText('2')).toHaveClass('syntax-number');
  });

  it('highlights Bash built-ins and variables in a bash fence', () => {
    const { container } = render(
      <RestrictedMarkdown text={['```bash', 'echo $TARGET', '```'].join('\n')} />,
    );

    const code = container.querySelector('pre.markdown-code-block code') as HTMLElement;
    expect(within(code).getByText('echo')).toHaveClass('syntax-builtin');
    expect(within(code).getByText('$TARGET')).toHaveClass('syntax-variable');
  });

  it('highlights lightweight C syntax in a c fence', () => {
    const { container } = render(
      <RestrictedMarkdown
        text={['```c', 'const int count = 2;', 'return count;', '```'].join('\n')}
      />,
    );

    const code = container.querySelector('pre.markdown-code-block code') as HTMLElement;
    expect(within(code).getByText('const')).toHaveClass('syntax-keyword');
    expect(within(code).getByText('int')).toHaveClass('syntax-keyword');
    expect(within(code).getByText('return')).toHaveClass('syntax-keyword');
    expect(within(code).getByText('2')).toHaveClass('syntax-number');
  });

  it('highlights lightweight C++ syntax in a c++ fence', () => {
    const { container } = render(
      <RestrictedMarkdown
        text={['```c++', 'template <typename T>', 'class Box {', 'public:', '};', '```'].join('\n')}
      />,
    );

    const code = container.querySelector('pre.markdown-code-block code') as HTMLElement;
    expect(within(code).getByText('template')).toHaveClass('syntax-keyword');
    expect(within(code).getByText('typename')).toHaveClass('syntax-keyword');
    expect(within(code).getByText('class')).toHaveClass('syntax-keyword');
    expect(within(code).getByText('public')).toHaveClass('syntax-keyword');
  });
});
