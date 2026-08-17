import { render, screen } from '@testing-library/react';
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
});
