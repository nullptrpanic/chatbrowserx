import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createTranslator } from '../../../src/shared/i18n/i18n';
import { HistoryView } from '../../../src/side-panel/history/HistoryView';

describe('HistoryView', () => {
  it('deletes any history item after an explicit inline confirmation', async () => {
    const onDelete = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(
      <HistoryView
        conversations={[
          {
            id: 'conversation_active',
            title: 'Current task',
            tabId: 7,
            createdAt: 900,
            updatedAt: 1_100,
            taskStatus: 'completed',
          },
          {
            id: 'conversation_old',
            title: 'Older task',
            tabId: 7,
            createdAt: 800,
            updatedAt: 1_000,
            taskStatus: 'failed',
          },
        ]}
        activeId="conversation_active"
        t={createTranslator('zh-CN')}
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onClear={vi.fn(async () => undefined)}
        onDelete={onDelete}
      />,
    );

    expect(screen.getByText('ChatBrowserX · 所有标签页')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '删除对话：Older task' }));
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '确认删除：Older task' }));

    expect(onDelete).toHaveBeenCalledWith('conversation_old');
  });

  it('keeps delete confirmation available and reports a deletion failure', async () => {
    const user = userEvent.setup();
    render(
      <HistoryView
        conversations={[
          {
            id: 'conversation_old',
            title: 'Older task',
            tabId: 9,
            createdAt: 800,
            updatedAt: 1_000,
            taskStatus: 'failed',
          },
        ]}
        activeId={null}
        t={createTranslator('zh-CN')}
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onClear={vi.fn(async () => undefined)}
        onDelete={vi.fn(async () => Promise.reject(new Error('storage failure')))}
      />,
    );

    await user.click(screen.getByRole('button', { name: '删除对话：Older task' }));
    await user.click(screen.getByRole('button', { name: '确认删除：Older task' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('操作失败，请重试。');
    expect(screen.getByRole('button', { name: '确认删除：Older task' })).toBeVisible();
  });
});
