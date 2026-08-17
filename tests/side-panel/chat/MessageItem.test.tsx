import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createTranslator } from '../../../src/shared/i18n/i18n';
import { MessageItem } from '../../../src/side-panel/chat/MessageItem';

const t = createTranslator('zh-CN');
const attachments = {
  addFiles: vi.fn(async () => []),
  get: vi.fn(async (id: string) => ({
    id,
    blob: new Blob(['png'], { type: 'image/png' }),
    mimeType: 'image/png',
    byteSize: 3,
    width: 10,
    height: 10,
    source: 'file' as const,
    createdAt: 1_000,
    fileName: 'photo.png',
  })),
};

describe('MessageItem', () => {
  it('renders assistant content inside a left-aligned message bubble', () => {
    render(
      <MessageItem
        message={{
          id: 'assistant_1',
          taskId: 'task_1',
          role: 'assistant',
          status: 'complete',
          text: '这是回复内容。',
          attachmentIds: [],
          createdAt: 1_000,
          updatedAt: 1_000,
        }}
        attachments={attachments}
        t={t}
      />,
    );

    expect(screen.getByText('这是回复内容。').closest('.message-bubble')).not.toBeNull();
    expect(screen.getByRole('article')).toHaveClass('message-assistant');
    expect(
      screen.getByRole('button', { name: '复制' }).querySelector('.lucide-copy'),
    ).not.toBeNull();
  });

  it('keeps sent images inside the user message bubble', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:message-image');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    render(
      <MessageItem
        message={{
          id: 'user_1',
          taskId: 'task_1',
          role: 'user',
          status: 'complete',
          text: '看这张图',
          attachmentIds: ['attachment_1'],
          createdAt: 1_000,
          updatedAt: 1_000,
        }}
        attachments={attachments}
        t={t}
      />,
    );

    expect(
      (await screen.findByRole('img', { name: 'photo.png' })).closest('.message-bubble'),
    ).not.toBeNull();
  });

  it('opens a sent image in the page viewport when that surface is available', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:message-image');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const openImagePreview = vi.fn(async () => true);
    const user = userEvent.setup();
    render(
      <MessageItem
        message={{
          id: 'user_preview',
          taskId: 'task_1',
          role: 'user',
          status: 'complete',
          text: '',
          attachmentIds: ['attachment_1'],
          createdAt: 1_000,
          updatedAt: 1_000,
        }}
        attachments={attachments}
        t={t}
        onOpenImagePreview={openImagePreview}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'photo.png' }));

    expect(openImagePreview).toHaveBeenCalledWith('attachment_1');
    expect(screen.queryByRole('dialog', { name: '图片预览' })).not.toBeInTheDocument();
  });

  it('keeps the local preview close control outside the image canvas', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:message-image');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(
      <MessageItem
        message={{
          id: 'user_local_preview',
          taskId: 'task_1',
          role: 'user',
          status: 'complete',
          text: '',
          attachmentIds: ['attachment_1'],
          createdAt: 1_000,
          updatedAt: 1_000,
        }}
        attachments={attachments}
        t={t}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'photo.png' }));

    const dialog = screen.getByRole('dialog', { name: '图片预览' });
    const close = screen.getByRole('button', { name: '关闭预览' });
    const canvas = dialog.querySelector('.image-preview-canvas');
    expect(close.closest('.image-preview-toolbar')).not.toBeNull();
    expect(canvas).not.toBeNull();
    expect(canvas).not.toContainElement(close);
  });

  it('omits an empty failed assistant placeholder but keeps an empty streaming bubble', () => {
    const { rerender } = render(
      <MessageItem
        message={{
          id: 'assistant_error',
          taskId: 'task_error',
          role: 'assistant',
          status: 'error',
          text: '',
          attachmentIds: [],
          createdAt: 1_000,
          updatedAt: 1_000,
        }}
        attachments={attachments}
        t={t}
      />,
    );
    expect(screen.queryByRole('article')).not.toBeInTheDocument();

    rerender(
      <MessageItem
        message={{
          id: 'assistant_streaming',
          taskId: 'task_streaming',
          role: 'assistant',
          status: 'streaming',
          text: '',
          attachmentIds: [],
          createdAt: 1_000,
          updatedAt: 1_000,
        }}
        attachments={attachments}
        t={t}
      />,
    );
    expect(screen.getByRole('article')).toHaveClass('message-assistant');
    expect(screen.getByRole('status')).toHaveTextContent('正在生成');
  });
});
