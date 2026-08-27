import { render, screen, waitFor } from '@testing-library/react';
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
    },
    conversation: null,
    conversations: [],
    messages: [],
    attachments: [],
    tasks: [],
    task: null,
    settings: {
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      systemPrompt: '',
      language: 'zh-CN',
      historyMessageLimit: 50,
      hasCodexToken: true,
      hasTavilyKey: true,
    },
  };
}

const environment = {
  getActiveTab: vi.fn(async () => ({ id: 7 })),
};
const attachments = {
  addFiles: vi.fn(async () => []),
  get: vi.fn(async () => undefined),
};

describe('App background connection', () => {
  it('edits and saves the model history message limit', async () => {
    const send = vi.fn<RuntimePort['send']>(async (message) => {
      const settings = {
        model: 'gpt-5.6-terra',
        reasoningEffort: 'medium' as const,
        systemPrompt: '',
        language: 'zh-CN' as const,
        historyMessageLimit: 50,
        hasCodexToken: true,
        hasTavilyKey: true,
      };
      return {
        version: 1,
        requestId: message.requestId,
        ok: true,
        data:
          message.type === 'panel.getSnapshot'
            ? { ...buildSnapshot(), settings }
            : message.type === 'settings.get'
              ? { ...settings, codexAccessToken: '', tavilyKey: '' }
              : message.type === 'settings.save'
                ? settings
                : { connected: true },
      };
    });
    const user = userEvent.setup();

    render(<App runtimePort={{ send }} environment={environment} attachmentClient={attachments} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));
    const input = await screen.findByRole('spinbutton', { name: '历史消息条数' });
    await user.clear(input);
    await user.type(input, '24');
    await user.click(screen.getByRole('button', { name: '保存设置' }));

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'settings.save',
        payload: expect.objectContaining({ historyMessageLimit: 24 }),
      }),
    );
  });

  it('edits Sandbox Server and Token on a separate settings tab', async () => {
    const send = vi.fn<RuntimePort['send']>(async (message) => {
      const settings = {
        ...buildSnapshot().settings,
        sandboxServer: 'https://sandbox.example.com/root',
        hasSandboxToken: true,
      };
      return {
        version: 1,
        requestId: message.requestId,
        ok: true,
        data:
          message.type === 'panel.getSnapshot'
            ? { ...buildSnapshot(), settings }
            : message.type === 'settings.get'
              ? {
                  model: settings.model,
                  reasoningEffort: settings.reasoningEffort,
                  systemPrompt: settings.systemPrompt,
                  language: settings.language,
                  historyMessageLimit: settings.historyMessageLimit,
                  sandboxServer: settings.sandboxServer,
                  codexAccessToken: '',
                  tavilyKey: '',
                  sandboxToken: 'stored-sandbox-token',
                }
              : message.type === 'settings.save'
                ? settings
                : { connected: true },
      };
    });
    const user = userEvent.setup();

    render(<App runtimePort={{ send }} environment={environment} attachmentClient={attachments} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));
    await user.click(await screen.findByRole('tab', { name: '沙箱' }));
    const server = await screen.findByLabelText('Sandbox Server');
    const token = await screen.findByDisplayValue('stored-sandbox-token');
    expect(server).toHaveValue('https://sandbox.example.com/root');
    expect(token).toHaveValue('stored-sandbox-token');
    expect(token).toHaveAttribute('type', 'password');
    await user.clear(server);
    await user.type(server, 'http://localhost:8787');
    await user.clear(token);
    await user.type(token, 'new-sandbox-token');
    await user.click(screen.getByRole('button', { name: '保存设置' }));

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'settings.save',
        payload: expect.objectContaining({
          sandboxServer: 'http://localhost:8787',
          sandboxToken: 'new-sandbox-token',
        }),
      }),
    );
  });

  it('loads persisted credentials into masked settings fields and reveals them on request', async () => {
    const send = vi.fn<RuntimePort['send']>(async (message) => ({
      version: 1,
      requestId: message.requestId,
      ok: true,
      data:
        message.type === 'panel.getSnapshot'
          ? buildSnapshot()
          : message.type === 'settings.get'
            ? {
                model: 'gpt-5.6-terra',
                reasoningEffort: 'medium',
                systemPrompt: '',
                language: 'zh-CN',
                codexAccessToken: 'saved-token',
                tavilyKey: 'saved-tavily-key',
              }
            : { connected: true },
    }));
    const user = userEvent.setup();

    render(<App runtimePort={{ send }} environment={environment} attachmentClient={attachments} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));

    const tokenInput = await screen.findByDisplayValue('saved-token');
    const tavilyInput = await screen.findByDisplayValue('saved-tavily-key');
    expect(tokenInput).toHaveAttribute('type', 'password');
    expect(tavilyInput).toHaveAttribute('type', 'password');

    const showTokenButton = screen.getAllByRole('button', { name: '显示密钥' })[0];
    if (showTokenButton === undefined) throw new Error('Token reveal button is missing.');
    await user.click(showTokenButton);
    expect(tokenInput).toHaveAttribute('type', 'text');
    expect(tavilyInput).toHaveAttribute('type', 'password');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'settings.get', payload: {} }),
    );
  });

  it('keeps newly saved credentials visible in the settings fields', async () => {
    let saved = false;
    const send = vi.fn<RuntimePort['send']>(async (message) => {
      let data: unknown = { connected: true };
      if (message.type === 'panel.getSnapshot') {
        const current = buildSnapshot();
        data = {
          ...current,
          settings: {
            ...current.settings,
            hasCodexToken: saved,
            hasTavilyKey: saved,
          },
        };
      } else if (message.type === 'settings.get') {
        data = {
          model: 'gpt-5.6-terra',
          reasoningEffort: 'medium',
          systemPrompt: '',
          language: 'zh-CN',
          codexAccessToken: '',
          tavilyKey: '',
        };
      } else if (message.type === 'settings.save') {
        saved = true;
        data = {
          ...buildSnapshot().settings,
          hasCodexToken: true,
          hasTavilyKey: true,
        };
      }
      return { version: 1, requestId: message.requestId, ok: true, data };
    });
    const user = userEvent.setup();

    render(<App runtimePort={{ send }} environment={environment} attachmentClient={attachments} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));
    const tokenInput = screen.getByLabelText(/Codex Access Token/);
    const tavilyInput = screen.getByLabelText(/Tavily API Key/);
    await user.type(tokenInput, 'new-token');
    await user.type(tavilyInput, 'new-tavily-key');

    await user.click(screen.getByRole('button', { name: '保存设置' }));

    expect(await screen.findByText('设置已保存')).toBeVisible();
    expect(tokenInput).toHaveValue('new-token');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'settings.save',
        payload: expect.objectContaining({
          codexAccessToken: 'new-token',
          tavilyKey: 'new-tavily-key',
        }),
      }),
    );
  });

  it('omits a Tavily key that the user clears so the stored value is preserved', async () => {
    const send = vi.fn<RuntimePort['send']>(async (message) => ({
      version: 1,
      requestId: message.requestId,
      ok: true,
      data:
        message.type === 'panel.getSnapshot'
          ? buildSnapshot()
          : message.type === 'settings.get'
            ? {
                model: 'gpt-5.6-terra',
                reasoningEffort: 'medium',
                systemPrompt: '',
                language: 'zh-CN',
                historyMessageLimit: 50,
                codexAccessToken: '',
                tavilyKey: 'saved-tavily-key',
              }
            : message.type === 'settings.save'
              ? buildSnapshot().settings
              : { connected: true },
    }));
    const user = userEvent.setup();

    render(<App runtimePort={{ send }} environment={environment} attachmentClient={attachments} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));
    const tavilyInput = await screen.findByLabelText(/Tavily API Key/);
    await user.clear(tavilyInput);
    await user.click(screen.getByRole('button', { name: '保存设置' }));

    const saveMessage = send.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === 'settings.save');
    expect(saveMessage?.payload).not.toHaveProperty('tavilyKey');
  });

  it('reports a credential load failure separately from save failures', async () => {
    const send = vi.fn<RuntimePort['send']>(async (message) =>
      message.type === 'settings.get'
        ? {
            version: 1,
            requestId: message.requestId,
            ok: false,
            error: { code: 'COMMAND_FAILED', message: 'Settings could not be loaded.' },
          }
        : {
            version: 1,
            requestId: message.requestId,
            ok: true,
            data: message.type === 'panel.getSnapshot' ? buildSnapshot() : { connected: true },
          },
    );
    const user = userEvent.setup();

    render(<App runtimePort={{ send }} environment={environment} attachmentClient={attachments} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));

    expect(await screen.findByText('密钥读取失败，请重新打开设置重试。')).toBeVisible();
    expect(screen.queryByText('设置保存失败，请检查输入。')).not.toBeInTheDocument();
  });

  it('renders the connected page context and conversation-first empty state', async () => {
    const send = vi.fn<RuntimePort['send']>(async (message) => ({
      version: 1,
      requestId: message.requestId,
      ok: true,
      data: message.type === 'panel.getSnapshot' ? buildSnapshot() : { connected: true },
    }));

    render(<App runtimePort={{ send }} environment={environment} attachmentClient={attachments} />);

    expect(await screen.findByText('今天想聊什么？')).toBeVisible();
    expect(screen.getByText('Example form')).toBeVisible();
    expect(screen.queryByText('ChatBrowserX')).not.toBeInTheDocument();
    expect(screen.getByLabelText('ChatBrowserX')).toBeVisible();
    expect(screen.getByLabelText('已连接')).toBeVisible();
    expect(screen.queryByRole('button', { name: '清空当前对话' })).not.toBeInTheDocument();
    expect(screen.queryByTitle('Debugger 按需连接')).not.toBeInTheDocument();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ version: 1, type: 'system.ping', payload: {} }),
    );
  });

  it('shows the connected Sandbox console action before trash only in the conversation view', async () => {
    const current = buildSnapshot();
    const snapshot: PanelSnapshot = {
      ...current,
      settings: {
        ...current.settings,
        sandboxServer: 'http://127.0.0.1:8787',
        hasSandboxToken: true,
      },
      conversation: {
        id: 'conversation_1',
        title: 'Existing conversation',
        tabId: 7,
        createdAt: 900,
        updatedAt: 1_000,
        taskStatus: null,
      },
    };
    const send = vi.fn<RuntimePort['send']>(async (message) => ({
      version: 1,
      requestId: message.requestId,
      ok: true,
      data:
        message.type === 'panel.getSnapshot'
          ? snapshot
          : message.type === 'sandbox.getConsole'
            ? { url: 'http://127.0.0.1:43130/#token=viewer-token' }
            : { connected: true },
    }));
    const openSandboxConsole = vi.fn(async () => undefined);
    const user = userEvent.setup();

    render(
      <App
        runtimePort={{ send }}
        environment={{ ...environment, openSandboxConsole }}
        attachmentClient={attachments}
      />,
    );

    const consoleButton = await screen.findByRole('button', { name: '沙箱控制台' });
    expect(consoleButton).toBeEnabled();
    const clearButton = screen.getByRole('button', { name: '清空当前对话' });
    expect(consoleButton).toHaveClass('sandbox-console-button');
    expect(
      consoleButton.compareDocumentPosition(clearButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    await user.click(consoleButton);
    expect(openSandboxConsole).toHaveBeenCalledWith('http://127.0.0.1:43130/#token=viewer-token');

    await user.click(screen.getByRole('button', { name: '设置' }));
    expect(screen.queryByRole('button', { name: '沙箱控制台' })).not.toBeInTheDocument();
  });

  it('shows a disabled red Sandbox action with an x after a configured console probe fails', async () => {
    const current = buildSnapshot();
    const snapshot: PanelSnapshot = {
      ...current,
      settings: {
        ...current.settings,
        sandboxServer: 'http://127.0.0.1:8787',
        hasSandboxToken: true,
      },
    };
    const send = vi.fn<RuntimePort['send']>(async (message) =>
      message.type === 'sandbox.getConsole'
        ? {
            version: 1,
            requestId: message.requestId,
            ok: false,
            error: { code: 'SANDBOX_UNAVAILABLE', message: 'Sandbox is unavailable.' },
          }
        : {
            version: 1,
            requestId: message.requestId,
            ok: true,
            data: message.type === 'panel.getSnapshot' ? snapshot : { connected: true },
          },
    );

    render(<App runtimePort={{ send }} environment={environment} attachmentClient={attachments} />);

    const consoleButton = await screen.findByRole('button', { name: '沙箱控制台' });
    expect(consoleButton).toBeDisabled();
    expect(consoleButton).toHaveClass('is-unavailable');
    expect(consoleButton.querySelectorAll('svg')).toHaveLength(2);
  });

  it('submits directly without requesting current-site access', async () => {
    const events: string[] = [];
    const snapshot = buildSnapshot();
    const guardedEnvironment = {
      getActiveTab: vi.fn(async () => ({ id: 7 })),
      requestOriginPermission: vi.fn(async () => {
        events.push('permission.granted');
        return true;
      }),
    };
    const send = vi.fn<RuntimePort['send']>(async (message) => {
      events.push(message.type);
      return {
        version: 1,
        requestId: message.requestId,
        ok: true,
        data:
          message.type === 'panel.getSnapshot'
            ? { ...snapshot, tab: { ...snapshot.tab, hasPermission: false } }
            : { connected: true },
      };
    });
    const user = userEvent.setup();

    render(
      <App
        runtimePort={{ send }}
        environment={guardedEnvironment}
        attachmentClient={attachments}
      />,
    );
    await user.type(await screen.findByRole('textbox'), 'Summarize this page');
    await user.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.submit' })),
    );
    expect(guardedEnvironment.requestOriginPermission).not.toHaveBeenCalled();
    expect(events).not.toContain('permission.granted');
  });

  it('routes the running composer to a supplement while keeping Stop separate', async () => {
    const base = buildSnapshot();
    const task = {
      id: 'task_running',
      status: 'planning' as const,
      goal: 'Inspect the current layout',
      tabId: 7,
      createdAt: 900,
      updatedAt: 1_000,
      sequence: 1,
      lastError: null,
      events: [{ sequence: 1, type: 'planning.started', reason: 'started', at: 1_000 }],
      completedToolResults: [],
      supplements: [],
    };
    const runningSnapshot: PanelSnapshot = {
      ...base,
      conversation: {
        id: 'conversation_running',
        title: task.goal,
        tabId: 7,
        createdAt: 900,
        updatedAt: 1_000,
        taskStatus: task.status,
      },
      tasks: [task],
      task,
    };
    const send = vi.fn<RuntimePort['send']>(async (message) => ({
      version: 1,
      requestId: message.requestId,
      ok: true,
      data:
        message.type === 'panel.getSnapshot'
          ? runningSnapshot
          : message.type === 'chat.supplement'
            ? { accepted: true, id: 'supplement_1' }
            : {},
    }));
    const user = userEvent.setup();

    render(<App runtimePort={{ send }} environment={environment} attachmentClient={attachments} />);
    await user.type(await screen.findByRole('textbox'), 'Also check the compact header');
    await user.click(screen.getByRole('button', { name: '补充' }));

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'chat.supplement',
          payload: {
            taskId: task.id,
            text: 'Also check the compact header',
            attachmentIds: [],
          },
        }),
      ),
    );
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.submit' }));
    expect(screen.getByRole('button', { name: '停止' })).toBeVisible();
    expect(screen.getByRole('textbox')).toHaveValue('');
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
        lastError: null,
        events: [{ sequence: 1, type: 'task.paused', reason: 'user_pause', at: 1_000 }],
        completedToolResults: [],
        supplements: [],
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
    const textbox = await screen.findByRole('textbox');
    await user.type(textbox, 'Start another task');

    expect(textbox).toBeDisabled();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    expect(screen.getAllByText('任务已暂停').length).toBeGreaterThan(0);
    expect(screen.queryByText(/浏览器动作/)).not.toBeInTheDocument();
    expect(screen.queryByText(/1\/50/)).not.toBeInTheDocument();
    expect(screen.queryByText('user_pause')).not.toBeInTheDocument();
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.submit' }));
  });

  it('locks a different conversation composer when a globally shared task is unfinished', async () => {
    const snapshot: PanelSnapshot = {
      ...buildSnapshot(),
      conversations: [
        {
          id: 'conversation_running_elsewhere',
          title: 'Running elsewhere',
          tabId: 9,
          createdAt: 900,
          updatedAt: 1_000,
          taskStatus: 'planning',
        },
      ],
    };
    const send = vi.fn<RuntimePort['send']>(async (message) => ({
      version: 1,
      requestId: message.requestId,
      ok: true,
      data: message.type === 'panel.getSnapshot' ? snapshot : { connected: true },
    }));

    render(<App runtimePort={{ send }} environment={environment} attachmentClient={attachments} />);

    expect(await screen.findByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: /图片/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^截图/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  });

  it('shows Retry for a failed task and sends the dedicated retry command', async () => {
    const base = buildSnapshot();
    const failedSnapshot: PanelSnapshot = {
      ...base,
      conversation: {
        id: 'conversation_1',
        title: 'Failed task',
        tabId: 7,
        createdAt: 900,
        updatedAt: 1_000,
        taskStatus: 'failed',
      },
      task: {
        id: 'task_1',
        status: 'failed',
        goal: 'Failed task',
        tabId: 7,
        createdAt: 900,
        updatedAt: 1_000,
        sequence: 1,
        lastError: {
          code: 'TransientProviderError',
          retryable: true,
          userMessage: 'Temporary failure.',
        },
        events: [{ sequence: 1, type: 'task.failed', reason: 'provider_failure', at: 1_000 }],
        completedToolResults: [],
        supplements: [],
      },
    };
    const send = vi.fn<RuntimePort['send']>(async (message) => ({
      version: 1,
      requestId: message.requestId,
      ok: true,
      data: message.type === 'panel.getSnapshot' ? failedSnapshot : {},
    }));
    const user = userEvent.setup();

    render(<App runtimePort={{ send }} environment={environment} attachmentClient={attachments} />);
    await user.click(await screen.findByRole('button', { name: '重试' }));

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'task.retry' }));
    expect(screen.queryByRole('button', { name: '继续' })).not.toBeInTheDocument();
  });

  it('clears the current conversation from the top bar only after confirmation', async () => {
    const activeSnapshot: PanelSnapshot = {
      ...buildSnapshot(),
      conversation: {
        id: 'conversation_1',
        title: 'Current conversation',
        tabId: 7,
        createdAt: 900,
        updatedAt: 1_000,
        taskStatus: null,
      },
    };
    const send = vi.fn<RuntimePort['send']>(async (message) => ({
      version: 1,
      requestId: message.requestId,
      ok: true,
      data: message.type === 'panel.getSnapshot' ? activeSnapshot : {},
    }));
    const user = userEvent.setup();

    render(<App runtimePort={{ send }} environment={environment} attachmentClient={attachments} />);
    await user.click(await screen.findByRole('button', { name: '清空当前对话' }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'conversation.clear' }));
    await user.click(screen.getByRole('button', { name: '确认清空' }));

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'conversation.clear',
          payload: { conversationId: 'conversation_1' },
        }),
      ),
    );
  });
});
