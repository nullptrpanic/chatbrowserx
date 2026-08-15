import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimePort } from '../../src/platform/chrome/runtime-port';
import type { PanelSnapshot } from '../../src/shared/protocol/panel-types';
import { App } from '../../src/side-panel/App';

/** Builds the minimal complete panel snapshot rendered by the conversation-first shell. */
function buildSnapshot(): PanelSnapshot {
  return {
    generatedAt: 1_000,
    tab: {
      id: 7,
      title: 'Example form',
      url: 'https://example.com/form',
      origin: 'https://example.com',
      supported: true,
      hasPermission: true,
      debuggerAttached: false,
    },
    conversation: null,
    conversations: [],
    messages: [],
    attachments: [],
    task: null,
    settings: {
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      systemPrompt: '',
      language: 'zh-CN',
      hasCodexToken: true,
      hasTavilyKey: false,
    },
  };
}

const environment = {
  getActiveTab: vi.fn(async () => ({ id: 7 })),
  requestOriginPermission: vi.fn(async () => true),
};
const attachments = {
  addFiles: vi.fn(async () => []),
  get: vi.fn(async () => undefined),
};

describe('App background connection', () => {
  it('renders the connected page context and conversation-first empty state', async () => {
    const send = vi.fn<RuntimePort['send']>(async (message) => ({
      version: 1,
      requestId: message.requestId,
      ok: true,
      data: message.type === 'panel.getSnapshot' ? buildSnapshot() : { connected: true },
    }));

    render(<App runtimePort={{ send }} environment={environment} attachmentClient={attachments} />);

    expect(await screen.findByText('今天要在这个页面完成什么？')).toBeVisible();
    expect(screen.getByText('Example form')).toBeVisible();
    expect(screen.getByLabelText('已连接')).toBeVisible();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ version: 1, type: 'system.ping', payload: {} }),
    );
  });

  it('shows an unavailable recovery action when the background cannot answer', async () => {
    const send = vi.fn<RuntimePort['send']>(async () => {
      throw new Error('Service worker stopped');
    });

    render(<App runtimePort={{ send }} environment={environment} attachmentClient={attachments} />);

    expect(await screen.findByText('Background unavailable')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeVisible();
  });

  it('keeps the composer locked while the conversation has an unfinished paused task', async () => {
    const snapshot: PanelSnapshot = {
      ...buildSnapshot(),
      conversation: {
        id: 'conversation_1',
        title: 'Existing task',
        tabId: 7,
        createdAt: 900,
        updatedAt: 1_000,
        taskStatus: 'paused',
      },
      task: {
        id: 'task_1',
        status: 'paused',
        goal: 'Existing task',
        tabId: 7,
        createdAt: 900,
        updatedAt: 1_000,
        sequence: 1,
        browserActionsUsed: 1,
        browserActionsLimit: 50,
        lastError: null,
        pendingConfirmation: null,
        events: [{ sequence: 1, type: 'task.paused', reason: 'user_pause', at: 1_000 }],
      },
    };
    const send = vi.fn<RuntimePort['send']>(async (message) => ({
      version: 1,
      requestId: message.requestId,
      ok: true,
      data: message.type === 'panel.getSnapshot' ? snapshot : { connected: true },
    }));
    const user = userEvent.setup();

    render(<App runtimePort={{ send }} environment={environment} attachmentClient={attachments} />);
    await user.type(await screen.findByRole('textbox'), 'Start another task');

    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    expect(screen.getAllByText('任务已暂停').length).toBeGreaterThan(0);
    expect(screen.queryByText('user_pause')).not.toBeInTheDocument();
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.submit' }));
  });
});
