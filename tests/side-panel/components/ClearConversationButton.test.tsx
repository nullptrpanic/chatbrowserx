import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createTranslator } from '../../../src/shared/i18n/i18n';
import { ClearConversationButton } from '../../../src/side-panel/components/ClearConversationButton';

describe('ClearConversationButton', () => {
  it('clears only after confirmation and can be cancelled', async () => {
    const onClear = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(<ClearConversationButton t={createTranslator('zh-CN')} onClear={onClear} />);

    await user.click(screen.getByRole('button', { name: '清空当前对话' }));
    expect(onClear).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '清空当前对话？' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '清空当前对话' }));
    await user.click(screen.getByRole('button', { name: '确认清空' }));

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('keeps the confirmation open and reports a failed clear', async () => {
    const user = userEvent.setup();
    render(
      <ClearConversationButton
        t={createTranslator('zh-CN')}
        onClear={vi.fn(async () => Promise.reject(new Error('storage failure')))}
      />,
    );

    await user.click(screen.getByRole('button', { name: '清空当前对话' }));
    await user.click(screen.getByRole('button', { name: '确认清空' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('清空失败，请重试。');
    expect(screen.getByRole('dialog', { name: '清空当前对话？' })).toBeVisible();
  });
});
