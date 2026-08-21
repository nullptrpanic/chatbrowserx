import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTranslator } from '../../../src/shared/i18n/i18n';
import { copyMessageToClipboard } from '../../../src/side-panel/chat/copy-message';
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
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalClipboard === undefined) {
    Reflect.deleteProperty(navigator, 'clipboard');
  } else {
    Object.defineProperty(navigator, 'clipboard', originalClipboard);
  }
});

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')));
    reader.addEventListener('error', () => reject(new Error('Test Blob could not be read.')));
    reader.readAsText(blob);
  });
}

function requireBlob(value: ClipboardItemData | undefined): Blob {
  if (!(value instanceof Blob)) throw new Error('Expected clipboard data to be a Blob.');
  return value;
}

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

  it('renders the existing copy action for a user message', () => {
    render(
      <MessageItem
        message={{
          id: 'user_copy',
          taskId: 'task_1',
          role: 'user',
          status: 'complete',
          text: '复制这段用户输入',
          attachmentIds: [],
          createdAt: 1_000,
          updatedAt: 1_000,
        }}
        attachments={attachments}
        t={t}
      />,
    );

    expect(screen.getByRole('button', { name: '复制' })).toBeVisible();
  });

  it('renders the source page beside the user label and opens it from the question bubble', async () => {
    const user = userEvent.setup();
    const sourcePage = {
      tabId: 7,
      title: 'Median of Two Sorted Arrays',
      url: 'https://leetcode.com/problems/median-of-two-sorted-arrays/description/',
      favIconUrl: 'https://leetcode.com/favicon.ico',
    };
    const onOpenSourcePage = vi.fn(async () => undefined);
    render(
      <MessageItem
        message={{
          id: 'user_source',
          taskId: 'task_1',
          role: 'user',
          status: 'complete',
          text: '帮我填写这道题',
          attachmentIds: [],
          sourcePage,
          createdAt: 1_000,
          updatedAt: 1_000,
        }}
        attachments={attachments}
        t={t}
        onOpenSourcePage={onOpenSourcePage}
      />,
    );

    const meta = screen.getByText('你').closest('.message-meta');
    expect(meta).not.toBeNull();
    const source = within(meta as HTMLElement).getByRole('button', {
      name: '打开来源页面：Median of Two Sorted Arrays',
    });
    expect(source).toHaveTextContent('Median of Two Sorted Arrays');
    expect(source.querySelector('img')).toHaveAttribute('src', 'https://leetcode.com/favicon.ico');

    await user.click(source);

    expect(onOpenSourcePage).toHaveBeenCalledWith(sourcePage);
    expect(screen.getByRole('article')).toHaveClass('has-source-page');
  });

  it('copies user text and images as cross-application plain and rich clipboard formats', async () => {
    let clipboardData: Record<string, ClipboardItemData> | undefined;
    function TestClipboardItem(data: Record<string, ClipboardItemData>) {
      clipboardData = data;
      return { data };
    }
    vi.stubGlobal('ClipboardItem', TestClipboardItem);
    const user = userEvent.setup();
    const write = vi.fn(async () => undefined);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write, writeText },
    });
    render(
      <MessageItem
        message={{
          id: 'user_rich_copy',
          taskId: 'task_1',
          role: 'user',
          status: 'complete',
          text: '<script>unsafe</script>\n第二行',
          attachmentIds: ['attachment_1'],
          createdAt: 1_000,
          updatedAt: 1_000,
        }}
        attachments={attachments}
        t={t}
      />,
    );

    await user.click(screen.getByRole('button', { name: '复制' }));
    await screen.findByRole('button', { name: '已复制' });

    expect(clipboardData).toBeDefined();
    expect(write).toHaveBeenCalledOnce();
    expect(writeText).not.toHaveBeenCalled();
    expect(await readBlobText(requireBlob(clipboardData?.['text/plain']))).toBe(
      '<script>unsafe</script>\n第二行',
    );
    const html = await readBlobText(requireBlob(clipboardData?.['text/html']));
    expect(html).toContain('&lt;script&gt;unsafe&lt;/script&gt;<br>第二行');
    expect(html).toContain('data:image/png;base64,cG5n');
    expect(html).not.toContain('<script>');
  });

  it('offers the copy action for an image-only user message', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:copy-image');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    render(
      <MessageItem
        message={{
          id: 'user_image_copy',
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

    expect(await screen.findByRole('button', { name: '复制' })).toBeVisible();
  });

  it('falls back to plain text when a target rejects the rich clipboard item', async () => {
    function TestClipboardItem(data: Record<string, ClipboardItemData>) {
      return { data };
    }
    vi.stubGlobal('ClipboardItem', TestClipboardItem);
    const write = vi.fn(async () => {
      throw new DOMException('Rich clipboard is unavailable.', 'NotAllowedError');
    });
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write, writeText },
    });

    await expect(
      copyMessageToClipboard({
        text: '保留文字',
        attachmentIds: ['attachment_1'],
        client: attachments,
      }),
    ).resolves.toBeUndefined();

    expect(write).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith('保留文字');
  });

  it('keeps the copy action unchanged when the system clipboard rejects the write', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {
      throw new DOMException('Clipboard permission denied.', 'NotAllowedError');
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(
      <MessageItem
        message={{
          id: 'user_copy_failure',
          taskId: 'task_1',
          role: 'user',
          status: 'complete',
          text: '不能误报成功',
          attachmentIds: [],
          createdAt: 1_000,
          updatedAt: 1_000,
        }}
        attachments={attachments}
        t={t}
      />,
    );

    await user.click(screen.getByRole('button', { name: '复制' }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());

    expect(screen.getByRole('button', { name: '复制' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '已复制' })).not.toBeInTheDocument();
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

  it('keeps an empty failed assistant reply with its failure details and retry action', () => {
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
        task={{
          id: 'task_error',
          status: 'failed',
          goal: 'Failed request',
          tabId: 7,
          createdAt: 1_000,
          updatedAt: 1_000,
          sequence: 1,
          lastError: {
            code: 'TaskInputError',
            retryable: false,
            userMessage: 'Task input could not be prepared.',
          },
          events: [
            {
              sequence: 1,
              type: 'task.failed',
              reason: 'task_input_preparation_failed',
              at: 1_000,
            },
          ],
          completedToolResults: [],
          supplements: [],
        }}
        taskInteractive
      />,
    );

    expect(screen.getByRole('article')).toHaveClass('message-assistant', 'is-error');
    expect(screen.getByText('任务执行失败，未生成回复。')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Task input could not be prepared.');
    expect(screen.getByRole('button', { name: '重试' })).toBeVisible();

    rerender(
      <MessageItem
        message={{
          id: 'assistant_interrupted',
          taskId: 'task_interrupted',
          role: 'assistant',
          status: 'interrupted',
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

  it('confirms cancelled-task context clearing and shows the shared cleared state', async () => {
    const user = userEvent.setup();
    const onClearTaskContext = vi.fn(async () => undefined);
    const message = {
      id: 'assistant_cancelled',
      taskId: 'task_cancelled',
      role: 'assistant' as const,
      status: 'interrupted' as const,
      text: '已保留的部分回复',
      attachmentIds: [],
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    const task = {
      id: 'task_cancelled',
      status: 'cancelled' as const,
      goal: 'Cancelled task',
      tabId: 7,
      createdAt: 1_000,
      updatedAt: 1_100,
      sequence: 2,
      lastError: null,
      events: [],
      completedToolResults: [],
      supplements: [],
    };
    const { rerender } = render(
      <MessageItem
        message={message}
        task={task}
        taskInteractive
        attachments={attachments}
        t={t}
        onClearTaskContext={onClearTaskContext}
      />,
    );

    await user.click(screen.getByRole('button', { name: '清除任务上下文' }));
    expect(
      screen.getByText('只清除用于继续执行的上下文，聊天记录和执行详情会保留。'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: '确认清除' }));
    expect(onClearTaskContext).toHaveBeenCalledOnce();

    rerender(
      <MessageItem
        message={message}
        task={{ ...task, contextCleared: true }}
        taskInteractive
        attachments={attachments}
        t={t}
        onClearTaskContext={onClearTaskContext}
      />,
    );
    expect(screen.getByRole('button', { name: '上下文已清除' })).toBeDisabled();
  });
});
