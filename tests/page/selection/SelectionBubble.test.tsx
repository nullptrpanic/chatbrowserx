import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SelectionBubble } from '../../../src/page/selection/SelectionBubble';

const selection = {
  text: 'Selected text',
  rect: { left: 40, top: 100, right: 180, bottom: 120, width: 140, height: 20 },
  pageUrl: 'https://example.com/article',
  pageTitle: 'Article',
};

describe('SelectionBubble', () => {
  it('starts with exactly Translate and Ask AI actions', () => {
    render(
      <SelectionBubble
        selection={selection}
        onTranslate={vi.fn()}
        onAsk={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: '翻译' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Ask AI' })).toBeVisible();
  });

  it('renders a translation result with copy and an Ask AI continuation', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(
      <SelectionBubble
        selection={selection}
        onTranslate={vi.fn(async () => '翻译结果')}
        onAsk={vi.fn(async () => undefined)}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '翻译' }));
    expect(await screen.findByText('翻译结果')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    expect(writeText).toHaveBeenCalledWith('翻译结果');
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    expect(screen.getByPlaceholderText('针对选中文本提问…')).toBeVisible();
  });

  it('submits a question without placing page text in UI-owned attributes', async () => {
    const onAsk = vi.fn(async () => undefined);
    render(
      <SelectionBubble
        selection={selection}
        onTranslate={vi.fn(async () => '')}
        onAsk={onAsk}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    fireEvent.change(screen.getByPlaceholderText('针对选中文本提问…'), {
      target: { value: '这是什么意思？' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送到侧栏' }));

    await vi.waitFor(() => expect(onAsk).toHaveBeenCalledWith('这是什么意思？'));
    expect(await screen.findByText('已发送到侧栏')).toBeVisible();
  });
});
