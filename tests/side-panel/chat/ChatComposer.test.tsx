import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createTranslator } from '../../../src/shared/i18n/i18n';
import { ChatComposer } from '../../../src/side-panel/chat/ChatComposer';
import type { PanelClient } from '../../../src/side-panel/state/panel-client';

describe('ChatComposer', () => {
  it('renders pending image thumbnails inside the same input surface as the textarea', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:draft-image');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const file = new File(['png'], 'draft.png', { type: 'image/png' });
    const attachments = {
      addFiles: vi.fn(async () => [
        {
          id: 'attachment_1',
          blob: file,
          mimeType: file.type,
          byteSize: file.size,
          width: 10,
          height: 10,
          source: 'file' as const,
          createdAt: 1_000,
          fileName: file.name,
        },
      ]),
      get: vi.fn(async () => undefined),
    };
    const client = {
      submit: vi.fn(async () => undefined),
      captureScreenshot: vi.fn(async () => null),
      cancelTask: vi.fn(async () => undefined),
    } as unknown as PanelClient;
    const user = userEvent.setup();

    render(
      <ChatComposer
        client={client}
        attachments={attachments}
        text=""
        running={false}
        taskLocked={false}
        hasToken
        t={createTranslator('zh-CN')}
        onTextChange={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    await user.upload(screen.getByLabelText('添加图片'), file);

    const surface = screen.getByRole('textbox').closest('.composer-input-surface');
    expect(surface).not.toBeNull();
    expect(surface).toContainElement(await screen.findByRole('img', { name: '待发送图片' }));
  });

  it('submits text as a runtime supplement and keeps Stop as a separate action', async () => {
    const supplement = vi.fn(async () => undefined);
    const submit = vi.fn(async () => undefined);
    const cancelTask = vi.fn(async () => undefined);
    const onTextChange = vi.fn();
    const client = {
      supplement,
      submit,
      captureScreenshot: vi.fn(async () => null),
      cancelTask,
    } as unknown as PanelClient;
    const user = userEvent.setup();

    render(
      <ChatComposer
        client={client}
        attachments={{ addFiles: vi.fn(async () => []), get: vi.fn(async () => undefined) }}
        text="Please also compare the mobile layout"
        running
        taskLocked
        hasToken
        t={createTranslator('zh-CN')}
        onTextChange={onTextChange}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '补充' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '停止' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /图片/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /截图/ })).toBeEnabled();

    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() =>
      expect(supplement).toHaveBeenCalledWith('Please also compare the mobile layout', []),
    );
    expect(submit).not.toHaveBeenCalled();
    expect(onTextChange).toHaveBeenCalledWith('');

    await user.click(screen.getByRole('button', { name: '停止' }));
    expect(cancelTask).toHaveBeenCalledTimes(1);
  });

  it('accepts an image-only runtime supplement', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:supplement-image');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const file = new File(['png'], 'detail.png', { type: 'image/png' });
    const supplement = vi.fn(async () => undefined);
    const client = {
      supplement,
      submit: vi.fn(async () => undefined),
      captureScreenshot: vi.fn(async () => null),
      cancelTask: vi.fn(async () => undefined),
    } as unknown as PanelClient;
    const user = userEvent.setup();

    render(
      <ChatComposer
        client={client}
        attachments={{
          addFiles: vi.fn(async () => [
            {
              id: 'attachment_detail',
              blob: file,
              mimeType: file.type,
              byteSize: file.size,
              width: 10,
              height: 10,
              source: 'file' as const,
              createdAt: 1_000,
              fileName: file.name,
            },
          ]),
          get: vi.fn(async () => undefined),
        }}
        text=""
        running
        taskLocked
        hasToken
        t={createTranslator('zh-CN')}
        onTextChange={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    await user.upload(screen.getByLabelText('添加图片'), file);
    await user.click(screen.getByRole('button', { name: '补充' }));

    expect(supplement).toHaveBeenCalledWith('', ['attachment_detail']);
  });

  it('preserves a running draft when a completion race rejects the supplement', async () => {
    const onTextChange = vi.fn();
    const client = {
      supplement: vi.fn(async () => Promise.reject(new Error('TASK_NOT_RUNNING'))),
      submit: vi.fn(async () => undefined),
      captureScreenshot: vi.fn(async () => null),
      cancelTask: vi.fn(async () => undefined),
    } as unknown as PanelClient;
    const user = userEvent.setup();

    render(
      <ChatComposer
        client={client}
        attachments={{ addFiles: vi.fn(async () => []), get: vi.fn(async () => undefined) }}
        text="Keep this draft"
        running
        taskLocked
        hasToken
        t={createTranslator('zh-CN')}
        onTextChange={onTextChange}
        onOpenSettings={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: '补充' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('补充失败，草稿已保留');
    expect(onTextChange).not.toHaveBeenCalledWith('');
    expect(screen.getByRole('textbox')).toHaveValue('Keep this draft');
  });

  it('shows the global task message when a cross-tab submit race reaches the backend', async () => {
    const client = {
      submit: vi.fn(async () => Promise.reject(new Error('TASK_ALREADY_RUNNING'))),
      captureScreenshot: vi.fn(async () => null),
      cancelTask: vi.fn(async () => undefined),
    } as unknown as PanelClient;
    const user = userEvent.setup();

    render(
      <ChatComposer
        client={client}
        attachments={{ addFiles: vi.fn(async () => []), get: vi.fn(async () => undefined) }}
        text="Keep this draft"
        running={false}
        taskLocked={false}
        hasToken
        t={createTranslator('zh-CN')}
        onTextChange={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('已有任务运行中');
    expect(screen.getByRole('textbox')).toHaveValue('Keep this draft');
  });
});
