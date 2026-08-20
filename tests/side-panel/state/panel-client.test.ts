import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimePort } from '../../../src/platform/chrome/runtime-port';
import type {
  PanelMessageSourcePage,
  PanelSnapshot,
} from '../../../src/shared/protocol/panel-types';
import {
  createChromePanelEnvironment,
  PanelClient,
} from '../../../src/side-panel/state/panel-client';
import { parsePanelSettings, parsePanelSnapshot } from '../../../src/side-panel/state/panel-state';

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
    supplements: [],
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
      hasTavilyKey: true,
    },
  };
}

const sourcePage: PanelMessageSourcePage = {
  title: 'Median of Two Sorted Arrays',
  url: 'https://leetcode.com/problems/median-of-two-sorted-arrays/description/',
  favIconUrl: 'https://leetcode.com/favicon.ico',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PanelClient', () => {
  it('opens the saved source URL without reusing a previously recorded tab', async () => {
    const get = vi.fn(async () => ({ id: 17, windowId: 4 }));
    const update = vi.fn(async () => ({ id: 17 }));
    const create = vi.fn(async () => ({ id: 18 }));
    const focusWindow = vi.fn(async () => ({ id: 4 }));
    vi.stubGlobal('chrome', {
      tabs: { query: vi.fn(), get, update, create },
      windows: { update: focusWindow },
    });
    const environment = createChromePanelEnvironment() as ReturnType<
      typeof createChromePanelEnvironment
    > & {
      openSourcePage(source: PanelMessageSourcePage): Promise<void>;
    };

    await environment.openSourcePage(sourcePage);

    expect(create).toHaveBeenCalledWith({ url: sourcePage.url, active: true });
    expect(get).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(focusWindow).not.toHaveBeenCalled();
  });

  it('accepts a bounded source page snapshot on a user message', () => {
    expect(
      parsePanelSnapshot({
        ...snapshot(),
        messages: [
          {
            id: 'message_source',
            taskId: 'task_1',
            role: 'user',
            status: 'complete',
            text: 'Fill in this solution',
            attachmentIds: [],
            sourcePage: {
              title: 'Median of Two Sorted Arrays',
              url: 'https://leetcode.com/problems/median-of-two-sorted-arrays/description/',
              favIconUrl: 'https://leetcode.com/favicon.ico',
            },
            createdAt: 1_000,
            updatedAt: 1_000,
          },
        ],
      }),
    ).toMatchObject({
      messages: [
        {
          sourcePage: {
            title: 'Median of Two Sorted Arrays',
            url: 'https://leetcode.com/problems/median-of-two-sorted-arrays/description/',
          },
        },
      ],
    });
  });

  it('defaults an older settings projection to 50 history messages', () => {
    expect(
      parsePanelSettings({
        model: 'gpt-5.6-terra',
        reasoningEffort: 'medium',
        systemPrompt: '',
        language: 'zh-CN',
        hasCodexToken: true,
        hasTavilyKey: false,
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
      tavilyKey: 'saved-tavily-key',
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

  it('loads full historical task details on demand and retains them across polling', async () => {
    const summary = snapshot();
    const summaryTask = summary.tasks[0];
    if (summaryTask === undefined) throw new Error('Task fixture is missing.');
    const detailedTask = {
      ...summaryTask,
      detailLevel: 'full' as const,
      sequence: 442,
      updatedAt: 2_000,
      events: Array.from({ length: 100 }, (_, index) => ({
        sequence: index + 343,
        type: index === 99 ? 'task.completed' : 'reasoning.summary-recorded',
        reason: index === 99 ? 'done' : 'progress',
        at: 1_342 + index,
      })),
      completedToolResults: Array.from({ length: 22 }, (_, index) => ({
        callId: `call_${index}`,
        toolName: 'browser_inspect',
        argumentsJson: '{}',
        output: `output_${index}`,
        resultRef: `result_${index}`,
        attachmentIds: [],
      })),
    };
    const send = vi.fn<RuntimePort['send']>(async (message) => ({
      version: 1,
      requestId: message.requestId,
      ok: true,
      data:
        message.type === 'panel.getTaskDetails'
          ? detailedTask
          : message.type === 'panel.getSnapshot'
            ? summary
            : { connected: true },
    }));
    const client = new PanelClient(
      { send },
      { getActiveTab: vi.fn(async () => ({ id: 7 })) },
      { pollIntervalMs: 60_000 },
    );
    await client.connect();

    await client.loadTaskDetails('task_1');
    await client.refresh();

    expect(client.getSnapshot().snapshot?.task).toMatchObject({
      id: 'task_1',
      detailLevel: 'full',
      sequence: 442,
    });
    expect(client.getSnapshot().snapshot?.task?.events).toHaveLength(100);
    expect(client.getSnapshot().snapshot?.task?.events[0]?.sequence).toBe(343);
    expect(client.getSnapshot().snapshot?.task?.completedToolResults).toHaveLength(22);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'panel.getTaskDetails',
        payload: { taskId: 'task_1' },
      }),
    );
    client.dispose();
  });

  it('keeps loaded tool details mounted while a newer live summary is being expanded', async () => {
    let liveSnapshot = snapshot(1);
    const initialTask = liveSnapshot.tasks[0];
    if (initialTask === undefined) throw new Error('Task fixture is missing.');
    let detailedTask = {
      ...initialTask,
      detailLevel: 'full' as const,
      events: [
        {
          sequence: 1,
          type: 'tool.result-recorded',
          reason: 'browser_inspect_result_recorded',
          at: 1_000,
        },
      ],
      completedToolResults: [
        {
          callId: 'call_1',
          toolName: 'browser_inspect',
          argumentsJson: '{"tabId":7}',
          output: '{"ok":true}',
          resultRef: 'result_1',
          attachmentIds: [],
        },
      ],
    };
    const send = vi.fn<RuntimePort['send']>(async (message) => ({
      version: 1,
      requestId: message.requestId,
      ok: true,
      data:
        message.type === 'panel.getTaskDetails'
          ? detailedTask
          : message.type === 'panel.getSnapshot'
            ? liveSnapshot
            : { connected: true },
    }));
    const client = new PanelClient(
      { send },
      { getActiveTab: vi.fn(async () => ({ id: 7 })) },
      { pollIntervalMs: 60_000 },
    );
    await client.connect();
    await client.loadTaskDetails('task_1');

    const nextSnapshot = snapshot(2);
    const nextSummary = nextSnapshot.tasks[0];
    if (nextSummary === undefined) throw new Error('Next task fixture is missing.');
    liveSnapshot = {
      ...nextSnapshot,
      tasks: [{ ...nextSummary, completedToolCallCount: 2 }],
      task: { ...nextSummary, completedToolCallCount: 2 },
    };
    await client.refresh();

    expect(client.getSnapshot().snapshot?.task).toMatchObject({
      detailLevel: 'summary',
      sequence: 2,
      completedToolCallCount: 2,
      completedToolResults: [{ callId: 'call_1' }],
    });

    detailedTask = {
      ...nextSummary,
      detailLevel: 'full',
      completedToolCallCount: 2,
      events: [
        ...detailedTask.events,
        {
          sequence: 2,
          type: 'tool.result-recorded',
          reason: 'browser_click_result_recorded',
          at: 1_100,
        },
      ],
      completedToolResults: [
        ...detailedTask.completedToolResults,
        {
          callId: 'call_2',
          toolName: 'browser_click',
          argumentsJson: '{"tabId":7,"ref":"e2"}',
          output: '{"ok":true}',
          resultRef: 'result_2',
          attachmentIds: [],
        },
      ],
    };
    await client.loadTaskDetails('task_1');

    expect(client.getSnapshot().snapshot?.task).toMatchObject({
      detailLevel: 'full',
      sequence: 2,
      completedToolResults: [{ callId: 'call_1' }, { callId: 'call_2' }],
    });
    client.dispose();
  });

  it('queues a fresh detail read when the live sequence advances during an in-flight read', async () => {
    let liveSnapshot = snapshot(1);
    const firstSummary = liveSnapshot.tasks[0];
    if (firstSummary === undefined) throw new Error('Task fixture is missing.');
    let releaseFirstRead: (() => void) | undefined;
    const firstReadBlocked = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let detailReads = 0;
    const send = vi.fn<RuntimePort['send']>(async (message) => {
      if (message.type === 'panel.getTaskDetails') {
        detailReads += 1;
        const current = liveSnapshot.tasks[0];
        if (current === undefined) throw new Error('Current task fixture is missing.');
        if (detailReads === 1) await firstReadBlocked;
        return {
          version: 1,
          requestId: message.requestId,
          ok: true,
          data: {
            ...current,
            detailLevel: 'full',
            completedToolResults: Array.from({ length: current.sequence }, (_, index) => ({
              callId: `call_${String(index + 1)}`,
              toolName: 'browser_inspect',
              argumentsJson: '{}',
              output: '{"ok":true}',
              resultRef: `result_${String(index + 1)}`,
              attachmentIds: [],
            })),
          },
        };
      }
      return {
        version: 1,
        requestId: message.requestId,
        ok: true,
        data: message.type === 'panel.getSnapshot' ? liveSnapshot : { connected: true },
      };
    });
    const client = new PanelClient(
      { send },
      { getActiveTab: vi.fn(async () => ({ id: 7 })) },
      { pollIntervalMs: 60_000 },
    );
    await client.connect();

    const firstLoad = client.loadTaskDetails('task_1');
    const nextSnapshot = snapshot(2);
    liveSnapshot = nextSnapshot;
    await client.refresh();
    const latestLoad = client.loadTaskDetails('task_1');
    releaseFirstRead?.();
    await Promise.all([firstLoad, latestLoad]);

    expect(detailReads).toBe(2);
    expect(client.getSnapshot().snapshot?.task).toMatchObject({
      detailLevel: 'full',
      sequence: 2,
      completedToolResults: [{ callId: 'call_1' }, { callId: 'call_2' }],
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

  it('uses the active tab at send time when the user switches before the next poll', async () => {
    let activeTabId = 7;
    const submittedTabIds: number[] = [];
    const send = vi.fn<RuntimePort['send']>(async (message) => {
      if (message.type === 'panel.getSnapshot') {
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
      if (message.type === 'chat.submit') {
        submittedTabIds.push(message.payload.tabId);
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
      { getActiveTab: vi.fn(async () => ({ id: activeTabId })) },
      { pollIntervalMs: 60_000 },
    );
    await client.connect();

    activeTabId = 9;
    await client.submit('Question from the newly active page', []);

    expect(submittedTabIds).toEqual([9]);
    client.dispose();
  });

  it('submits a runtime supplement to the current running task and refreshes it', async () => {
    const sentTypes: string[] = [];
    const send = vi.fn<RuntimePort['send']>(async (message) => {
      sentTypes.push(message.type);
      return {
        version: 1,
        requestId: message.requestId,
        ok: true,
        data:
          message.type === 'panel.getSnapshot'
            ? snapshot()
            : message.type === 'chat.supplement'
              ? { accepted: true, id: 'supplement_1' }
              : {},
      };
    });
    const client = new PanelClient(
      { send },
      { getActiveTab: vi.fn(async () => ({ id: 7 })) },
      { pollIntervalMs: 60_000 },
    );
    await client.connect();
    sentTypes.length = 0;

    await client.supplement('Use the attached detail', ['attachment_1']);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.supplement',
        payload: {
          taskId: 'task_1',
          text: 'Use the attached detail',
          attachmentIds: ['attachment_1'],
        },
      }),
    );
    expect(sentTypes).toEqual(['chat.supplement', 'panel.getSnapshot']);
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
