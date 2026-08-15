import { describe, expect, it, vi } from 'vitest';
import type { RuntimePort } from '../../../src/platform/chrome/runtime-port';
import type { PanelSnapshot } from '../../../src/shared/protocol/panel-types';
import { PanelClient } from '../../../src/side-panel/state/panel-client';

/** Builds a valid sanitized snapshot at one deterministic task sequence. */
function snapshot(sequence = 1): PanelSnapshot {
  return {
    generatedAt: 1_000 + sequence,
    tab: {
      id: 7,
      title: 'Example',
      url: 'https://example.com',
      origin: 'https://example.com',
      supported: true,
      hasPermission: true,
      debuggerAttached: false,
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
    task: {
      id: 'task_1',
      status: 'planning',
      goal: 'Task',
      tabId: 7,
      createdAt: 1_000,
      updatedAt: 1_000,
      sequence,
      browserActionsUsed: 0,
      browserActionsLimit: 50,
      lastError: null,
      pendingConfirmation: null,
      events: [],
    },
    settings: {
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      systemPrompt: '',
      language: 'system',
      hasCodexToken: true,
      hasTavilyKey: false,
    },
  };
}

describe('PanelClient', () => {
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
        requestOriginPermission: vi.fn(async () => true),
      },
      { pollIntervalMs: 60_000 },
    );

    await client.connect();
    expect(client.getSnapshot()).toMatchObject({
      status: 'ready',
      activeConversationId: 'conversation_1',
      snapshot: { task: { sequence: 1 } },
    });

    client.newConversation();
    expect(client.getSnapshot()).toMatchObject({
      activeConversationId: null,
      snapshot: { conversation: null, messages: [], task: null },
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
        requestOriginPermission: vi.fn(async () => true),
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
        requestOriginPermission: vi.fn(async () => true),
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
});
