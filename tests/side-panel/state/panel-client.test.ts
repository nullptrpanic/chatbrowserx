import { describe, expect, it, vi } from 'vitest';
import type { RuntimePort } from '../../../src/platform/chrome/runtime-port';
import type { PanelSnapshot } from '../../../src/shared/protocol/panel-types';
import { PanelClient } from '../../../src/side-panel/state/panel-client';
import { parsePanelSettings } from '../../../src/side-panel/state/panel-state';

/** Builds a valid sanitized snapshot at one deterministic task sequence. */
function snapshot(sequence = 1): PanelSnapshot {
  const task = {
    id: 'task_1',
    status: 'planning' as const,
    goal: 'Task',
    tabId: 7,
    createdAt: 1_000,
    updatedAt: 1_000,
    sequence,
    lastError: null,
    events: [],
    completedToolResults: [],
  };
  return {
    generatedAt: 1_000 + sequence,
    tab: {
      id: 7,
      title: 'Example',
      url: 'https://example.com',
      origin: 'https://example.com',
      supported: true,
      hasPermission: true,
    },
    conversation: {
      id: 'conversation_1',
      title: 'Task',
      tabId: 7,
      createdAt: 1_000,
      updatedAt: 1_000,
      taskStatus: 'planning',
    },
    conversations: [],
    messages: [],
    attachments: [],
    tasks: [task],
    task,
    settings: {
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      systemPrompt: '',
      language: 'system',
      historyMessageLimit: 50,
      hasCodexToken: true,
    },
  };
}

describe('PanelClient', () => {
  it('defaults an older settings projection to 50 history messages', () => {
    expect(
      parsePanelSettings({
        model: 'gpt-5.6-terra',
        reasoningEffort: 'medium',
        systemPrompt: '',
        language: 'zh-CN',
        hasCodexToken: true,
      }),
    ).toMatchObject({ historyMessageLimit: 50 });
  });

  it('loads persisted credentials through the explicit settings query', async () => {
    const editableSettings = {
      model: 'gpt-5.6-terra',
      reasoningEffort: 'high' as const,
      systemPrompt: 'Be precise',
      language: 'zh-CN' as const,
      historyMessageLimit: 50,
      codexAccessToken: 'saved-token',
    };
    const send = vi.fn<RuntimePort['send']>(async (message) => ({
      version: 1,
      requestId: message.requestId,
      ok: true,
      data: message.type === 'settings.get' ? editableSettings : {},
    }));
    const client = new PanelClient(
      { send },
      {
        getActiveTab: vi.fn(async () => ({ id: 7 })),
      },
      { pollIntervalMs: 60_000 },
    );

    await expect(client.getSettings()).resolves.toEqual(editableSettings);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'settings.get', payload: {} }),
    );
    client.dispose();
  });

  it('connects through a full snapshot and can start a clean conversation draft', async () => {
    const runtime: RuntimePort = {
      send: vi.fn(async (message) => ({
        version: 1 as const,
        requestId: message.requestId,
        ok: true as const,
        data: message.type === 'panel.getSnapshot' ? snapshot() : { connected: true },
      })),
    };
    const client = new PanelClient(
      runtime,
      {
        getActiveTab: vi.fn(async () => ({ id: 7 })),
      },
      { pollIntervalMs: 60_000 },
    );

    await client.connect();
    expect(client.getSnapshot()).toMatchObject({
      status: 'ready',
      activeConversationId: undefined,
      snapshot: { task: { sequence: 1 } },
    });

    client.newConversation();
    expect(client.getSnapshot()).toMatchObject({
      activeConversationId: null,
      snapshot: { conversation: null, messages: [], tasks: [], task: null },
    });
    client.dispose();
  });

  it('submits into the latest conversation restored after reconnecting the panel', async () => {
    const submitted: Array<{
      readonly tabId: number;
      readonly conversationId?: string | undefined;
      readonly text: string;
      readonly attachmentIds: readonly string[];
    }> = [];
    const send = vi.fn<RuntimePort['send']>(async (message) => {
      if (message.type === 'panel.getSnapshot') {
        return {
          version: 1,
          requestId: message.requestId,
          ok: true,
          data: snapshot(),
        };
      }
      if (message.type === 'chat.submit') {
        submitted.push(message.payload);
        return {
          version: 1,
          requestId: message.requestId,
          ok: true,
          data: { task: { conversationId: 'conversation_1' } },
        };
      }
      return { version: 1, requestId: message.requestId, ok: true, data: {} };
    });
    const client = new PanelClient(
      { send },
      { getActiveTab: vi.fn(async () => ({ id: 7 })) },
      { pollIntervalMs: 60_000 },
    );
    await client.connect();

    await client.submit('Continue the restored task', []);

    expect(submitted).toEqual([
      {
        tabId: 7,
        conversationId: 'conversation_1',
        text: 'Continue the restored task',
        attachmentIds: [],
      },
    ]);
    client.dispose();
  });

  it('requests a page-wide preview for one persisted attachment', async () => {
    const send = vi.fn<RuntimePort['send']>(async (message) => ({
      version: 1,
      requestId: message.requestId,
      ok: true,
      data:
        message.type === 'panel.getSnapshot'
          ? snapshot()
          : message.type === 'image.preview.open'
            ? { opened: true }
            : {},
    }));
    const client = new PanelClient(
      { send },
      { getActiveTab: vi.fn(async () => ({ id: 7 })) },
      { pollIntervalMs: 60_000 },
    );
    await client.connect();

    await expect(client.openImagePreview('attachment_1')).resolves.toBe(true);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'image.preview.open',
        payload: { tabId: 7, attachmentId: 'attachment_1' },
      }),
    );
    client.dispose();
  });

  it('keeps an explicitly selected global conversation when the active tab changes', async () => {
    let activeTabId = 7;
    const sentSnapshots: Array<{ tabId: number; conversationId?: string | undefined }> = [];
    const send = vi.fn<RuntimePort['send']>(async (message) => {
      if (message.type === 'panel.getSnapshot') {
        sentSnapshots.push(message.payload);
        return {
          version: 1,
          requestId: message.requestId,
          ok: true,
          data: {
            ...snapshot(),
            tab: { ...snapshot().tab, id: activeTabId },
          },
        };
      }
      return { version: 1, requestId: message.requestId, ok: true, data: {} };
    });
    const client = new PanelClient(
      { send },
      { getActiveTab: vi.fn(async () => ({ id: activeTabId })) },
      { pollIntervalMs: 60_000 },
    );
    await client.connect();
    await client.selectConversation('conversation_1');

    activeTabId = 9;
    await client.refresh();

    expect(sentSnapshots.at(-1)).toEqual({ tabId: 9, conversationId: 'conversation_1' });
    expect(client.getSnapshot()).toMatchObject({
      activeConversationId: 'conversation_1',
      snapshot: { conversation: { id: 'conversation_1' }, task: { id: 'task_1' } },
    });
    client.dispose();
  });

  it('keeps an implicit panel selection following the globally latest conversation', async () => {
    let conversationId = 'conversation_1';
    const snapshotPayloads: Array<{ tabId: number; conversationId?: string | undefined }> = [];
    const send = vi.fn<RuntimePort['send']>(async (message) => {
      if (message.type === 'panel.getSnapshot') {
        snapshotPayloads.push(message.payload);
        const current = snapshot();
        return {
          version: 1,
          requestId: message.requestId,
          ok: true,
          data: {
            ...current,
            conversation:
              current.conversation === null
                ? null
                : { ...current.conversation, id: conversationId },
          },
        };
      }
      return { version: 1, requestId: message.requestId, ok: true, data: {} };
    });
    const client = new PanelClient(
      { send },
      { getActiveTab: vi.fn(async () => ({ id: 7 })) },
      { pollIntervalMs: 60_000 },
    );
    await client.connect();

    conversationId = 'conversation_2';
    await client.refresh();

    expect(snapshotPayloads.at(-1)).toEqual({ tabId: 7 });
    expect(client.getSnapshot()).toMatchObject({
      activeConversationId: undefined,
      snapshot: { conversation: { id: 'conversation_2' } },
    });
    client.dispose();
  });

  it('keeps a clean draft empty across polling while still receiving global history', async () => {
    const runtime: RuntimePort = {
      send: vi.fn(async (message) => ({
        version: 1 as const,
        requestId: message.requestId,
        ok: true as const,
        data:
          message.type === 'panel.getSnapshot'
            ? { ...snapshot(), conversations: [snapshot().conversation] }
            : {},
      })),
    };
    const client = new PanelClient(
      runtime,
      { getActiveTab: vi.fn(async () => ({ id: 7 })) },
      { pollIntervalMs: 60_000 },
    );
    await client.connect();
    client.newConversation();

    await client.refresh();

    expect(client.getSnapshot()).toMatchObject({
      activeConversationId: null,
      snapshot: {
        conversation: null,
        conversations: [{ id: 'conversation_1' }],
        messages: [],
        tasks: [],
        task: null,
      },
    });
    client.dispose();
  });

  it('ignores a stale snapshot after a newer refresh completes', async () => {
    const resolvers: Array<(value: ReturnType<typeof snapshot>) => void> = [];
    let snapshotRequests = 0;
    const runtime: RuntimePort = {
      send: vi.fn(async (message) => {
        if (message.type !== 'panel.getSnapshot') {
          return {
            version: 1 as const,
            requestId: message.requestId,
            ok: true as const,
            data: {},
          };
        }
        snapshotRequests += 1;
        const data = await new Promise<PanelSnapshot>((resolve) => resolvers.push(resolve));
        return {
          version: 1 as const,
          requestId: message.requestId,
          ok: true as const,
          data,
        };
      }),
    };
    const client = new PanelClient(
      runtime,
      {
        getActiveTab: vi.fn(async () => ({ id: 7 })),
      },
      { pollIntervalMs: 60_000 },
    );

    const first = client.refresh();
    await vi.waitFor(() => expect(snapshotRequests).toBe(1));
    const second = client.refresh();
    await vi.waitFor(() => expect(snapshotRequests).toBe(2));
    resolvers[1]?.(snapshot(2));
    await second;
    resolvers[0]?.(snapshot(1));
    await first;

    expect(client.getSnapshot().snapshot?.task?.sequence).toBe(2);
    client.dispose();
  });

  it('reinstalls page features when the same tab navigates to a newly authorized origin', async () => {
    let origin = 'https://first.example';
    const send = vi.fn<RuntimePort['send']>(async (message) => ({
      version: 1,
      requestId: message.requestId,
      ok: true,
      data:
        message.type === 'panel.getSnapshot'
          ? {
              ...snapshot(),
              tab: {
                ...snapshot().tab,
                url: `${origin}/page`,
                origin,
              },
            }
          : {},
    }));
    const client = new PanelClient(
      { send },
      {
        getActiveTab: vi.fn(async () => ({ id: 7 })),
      },
      { pollIntervalMs: 60_000 },
    );

    await client.refresh();
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'page.features.ensure' })),
    );
    const firstEnsureCount = send.mock.calls.filter(
      ([message]) => message.type === 'page.features.ensure',
    ).length;
    await client.refresh();
    expect(
      send.mock.calls.filter(([message]) => message.type === 'page.features.ensure'),
    ).toHaveLength(firstEnsureCount);

    origin = 'https://second.example';
    await client.refresh();
    await vi.waitFor(() =>
      expect(
        send.mock.calls.filter(([message]) => message.type === 'page.features.ensure'),
      ).toHaveLength(firstEnsureCount + 1),
    );
    client.dispose();
  });

  it('resumes a paused task without requesting current-site access', async () => {
    const events: string[] = [];
    const current = snapshot();
    if (current.conversation === null || current.task === null) {
      throw new Error('Task fixture is incomplete.');
    }
    const pausedSnapshot: PanelSnapshot = {
      ...current,
      tab: { ...current.tab, hasPermission: false },
      conversation: { ...current.conversation, taskStatus: 'paused' },
      task: { ...current.task, status: 'paused' },
    };
    const send = vi.fn<RuntimePort['send']>(async (message) => {
      events.push(message.type);
      return {
        version: 1,
        requestId: message.requestId,
        ok: true,
        data: message.type === 'panel.getSnapshot' ? pausedSnapshot : {},
      };
    });
    const requestOriginPermission = vi.fn(async () => {
      events.push('permission.granted');
      return true;
    });
    const environmentWithLegacyRequest = {
      getActiveTab: vi.fn(async () => ({ id: 7 })),
      requestOriginPermission,
    };
    const client = new PanelClient({ send }, environmentWithLegacyRequest, {
      pollIntervalMs: 60_000,
    });
    await client.connect();

    await client.resumeTask();

    expect(requestOriginPermission).not.toHaveBeenCalled();
    expect(events).not.toContain('permission.granted');
    client.dispose();
  });

  it('retries a failed task with the dedicated retry command', async () => {
    const failed = snapshot();
    if (failed.conversation === null || failed.task === null) {
      throw new Error('Task fixture is incomplete.');
    }
    const failedSnapshot: PanelSnapshot = {
      ...failed,
      conversation: { ...failed.conversation, taskStatus: 'failed' },
      task: {
        ...failed.task,
        status: 'failed',
        lastError: {
          code: 'TransientProviderError',
          retryable: true,
          userMessage: 'The provider is temporarily unavailable.',
        },
      },
    };
    const send = vi.fn<RuntimePort['send']>(async (message) => ({
      version: 1,
      requestId: message.requestId,
      ok: true,
      data: message.type === 'panel.getSnapshot' ? failedSnapshot : {},
    }));
    const client = new PanelClient(
      { send },
      { getActiveTab: vi.fn(async () => ({ id: 7 })) },
      { pollIntervalMs: 60_000 },
    );
    await client.connect();

    await client.retryTask();

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'task.retry' }));
    client.dispose();
  });

  it('deletes a selected history conversation without clearing the active conversation', async () => {
    const current = snapshot();
    const send = vi.fn<RuntimePort['send']>(async (message) => ({
      version: 1,
      requestId: message.requestId,
      ok: true,
      data: message.type === 'panel.getSnapshot' ? current : {},
    }));
    const client = new PanelClient(
      { send },
      { getActiveTab: vi.fn(async () => ({ id: 7 })) },
      { pollIntervalMs: 60_000 },
    );
    await client.connect();

    await client.deleteConversation('conversation_old');

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'conversation.clear',
        payload: { conversationId: 'conversation_old' },
      }),
    );
    expect(client.getSnapshot()).toMatchObject({
      activeConversationId: undefined,
      snapshot: { conversation: { id: 'conversation_1' } },
    });
    client.dispose();
  });
});
