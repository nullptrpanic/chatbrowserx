import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '../../../src/shared/protocol/message-types';
import {
  TaskCommandError,
  type TaskCommandPort,
  type TaskSnapshot,
} from '../../../src/tasks/task-command-service';
import { createMessageRouter } from '../../../src/platform/chrome/message-router';
import { createTask } from '../../../src/tasks/task-factory';
import type { Checkpoint } from '../../../src/tasks/checkpoint-types';
import type {
  PanelEditableSettings,
  PanelSettingsSnapshot,
  PanelSnapshot,
  PanelTask,
} from '../../../src/shared/protocol/panel-types';

/**
 * Builds a complete queued snapshot returned by command doubles.
 */
function buildSnapshot(): TaskSnapshot {
  const task = {
    ...createTask(
      { conversationId: 'conv_1', tabId: 7, goal: 'Complete the page' },
      { clock: { now: () => 1_000 }, ids: { create: () => 'task_1' } },
    ),
    checkpointId: 'checkpoint_1',
  };
  const checkpoint: Checkpoint = {
    id: 'checkpoint_1',
    taskId: task.id,
    sequence: 0,
    taskStatus: 'queued',
    completedToolResults: [],
    continuationItems: [],
    pendingToolCall: null,
    createdAt: task.createdAt,
  };
  return { task, checkpoint, events: [] };
}

/**
 * Builds command doubles that return the same valid snapshot by default.
 */
function buildCommands(snapshot: TaskSnapshot): TaskCommandPort {
  return {
    create: vi.fn(async () => snapshot),
    getSnapshot: vi.fn(async () => snapshot),
    pause: vi.fn(async () => snapshot),
    resume: vi.fn(async () => snapshot),
    retry: vi.fn(async () => snapshot),
    cancel: vi.fn(async () => snapshot),
    clearContext: vi.fn(async () => snapshot),
  };
}

/** Builds screenshot command doubles that return only serializable attachment identifiers. */
function buildScreenshots() {
  return {
    captureViewport: vi.fn(async () => ({ id: 'attachment_viewport' })),
    captureRegion: vi.fn(async () => ({ id: 'attachment_region' })),
  };
}

/** Builds sanitized panel query and command doubles for runtime routing tests. */
function buildPanel() {
  const settings: PanelSettingsSnapshot = {
    model: 'gpt-5.6-terra',
    reasoningEffort: 'medium',
    systemPrompt: '',
    language: 'system',
    historyMessageLimit: 50,
    hasCodexToken: false,
    hasTavilyKey: false,
  };
  const editableSettings: PanelEditableSettings = {
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    systemPrompt: settings.systemPrompt,
    language: settings.language,
    historyMessageLimit: settings.historyMessageLimit,
    codexAccessToken: 'saved-token',
    tavilyKey: 'saved-tavily-key',
  };
  const snapshot: PanelSnapshot = {
    generatedAt: 1_000,
    tab: {
      id: 7,
      title: 'Example',
      url: 'https://example.com',
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
    settings,
  };
  return {
    getStateVersion: vi.fn(() => ({ stateVersion: 7 })),
    getSnapshot: vi.fn(async () => snapshot),
    getTaskDetails: vi.fn(async (): Promise<PanelTask> => ({
      id: 'task_1',
      detailLevel: 'full',
      status: 'completed',
      goal: 'Complete the page',
      tabId: 7,
      createdAt: 1_000,
      updatedAt: 2_000,
      sequence: 1,
      lastError: null,
      events: [],
      completedToolResults: [],
      supplements: [],
    })),
    submit: vi.fn(async () => buildSnapshot()),
    supplement: vi.fn(async () => ({ accepted: true as const, id: 'supplement_1' })),
    openImagePreview: vi.fn(async () => ({ opened: true as const })),
    clearConversation: vi.fn(async () => ({ deletedAttachments: 0 })),
    getSettings: vi.fn(async () => editableSettings),
    saveSettings: vi.fn(async () => ({ ...settings, hasCodexToken: true, hasTavilyKey: true })),
  };
}

describe('createMessageRouter', () => {
  it('returns a redacted INVALID_MESSAGE envelope for malformed input', async () => {
    const secret = 'must-not-appear';
    const router = createMessageRouter({
      commands: buildCommands(buildSnapshot()),
      panel: buildPanel(),
      screenshots: buildScreenshots(),
      requestRecoveryScan: vi.fn(async () => undefined),
      scheduleTask: vi.fn(async () => undefined),
    });

    const response = await router({
      version: PROTOCOL_VERSION,
      requestId: 'req_bad',
      type: 'task.create',
      payload: { tabId: 7, conversationId: 'conv_1', goal: secret, extra: secret },
    });

    expect(response).toMatchObject({
      version: PROTOCOL_VERSION,
      requestId: 'req_bad',
      ok: false,
      error: { code: 'INVALID_MESSAGE' },
    });
    expect(JSON.stringify(response)).not.toContain(secret);
  });

  it('pings the background and requests an ordinary recovery scan', async () => {
    const requestRecoveryScan = vi.fn(async () => undefined);
    const router = createMessageRouter({
      commands: buildCommands(buildSnapshot()),
      panel: buildPanel(),
      screenshots: buildScreenshots(),
      requestRecoveryScan,
      scheduleTask: vi.fn(async () => undefined),
    });

    await expect(
      router({
        version: PROTOCOL_VERSION,
        requestId: 'req_ping',
        type: 'system.ping',
        payload: {},
      }),
    ).resolves.toEqual({
      version: PROTOCOL_VERSION,
      requestId: 'req_ping',
      ok: true,
      data: { connected: true },
    });
    expect(requestRecoveryScan).toHaveBeenCalledTimes(1);
  });

  it('installs page features through the trusted background service', async () => {
    const pageFeatures = { ensure: vi.fn(async () => ({ status: 'installed' })) };
    const router = createMessageRouter({
      commands: buildCommands(buildSnapshot()),
      panel: buildPanel(),
      screenshots: buildScreenshots(),
      requestRecoveryScan: vi.fn(async () => undefined),
      scheduleTask: vi.fn(async () => undefined),
      pageFeatures,
    });
    await router({
      version: PROTOCOL_VERSION,
      requestId: 'req_features',
      type: 'page.features.ensure',
      payload: { tabId: 9 },
    });

    expect(pageFeatures.ensure).toHaveBeenCalledWith(9);
  });

  it('rejects credential settings commands sent from a page context', async () => {
    const panel = buildPanel();
    const router = createMessageRouter({
      commands: buildCommands(buildSnapshot()),
      panel,
      screenshots: buildScreenshots(),
      requestRecoveryScan: vi.fn(async () => undefined),
      scheduleTask: vi.fn(async () => undefined),
    });

    const readResponse = await router(
      {
        version: PROTOCOL_VERSION,
        requestId: 'req_settings_read',
        type: 'settings.get',
        payload: {},
      },
      { senderTabId: 7 },
    );
    const saveResponse = await router(
      {
        version: PROTOCOL_VERSION,
        requestId: 'req_settings_save',
        type: 'settings.save',
        payload: {
          reasoningEffort: 'medium',
          systemPrompt: '',
          language: 'zh-CN',
          codexAccessToken: 'must-not-be-stored',
          tavilyKey: 'must-not-be-stored',
        },
      },
      { senderTabId: 7 },
    );

    expect(readResponse).toMatchObject({ ok: false, error: { code: 'INVALID_CONTEXT' } });
    expect(saveResponse).toMatchObject({ ok: false, error: { code: 'INVALID_CONTEXT' } });
    expect(JSON.stringify([readResponse, saveResponse])).not.toContain('must-not-be-stored');
    expect(panel.getSettings).not.toHaveBeenCalled();
    expect(panel.saveSettings).not.toHaveBeenCalled();
  });

  it('delegates task commands and schedules create, resume, and retry', async () => {
    const snapshot = buildSnapshot();
    const commands = buildCommands(snapshot);
    const scheduleTask = vi.fn(async () => undefined);
    const router = createMessageRouter({
      commands,
      panel: buildPanel(),
      screenshots: buildScreenshots(),
      requestRecoveryScan: vi.fn(async () => undefined),
      scheduleTask,
    });

    await router({
      version: PROTOCOL_VERSION,
      requestId: 'req_create',
      type: 'task.create',
      payload: { tabId: 7, conversationId: 'conv_1', goal: 'Complete the page' },
    });
    await router({
      version: PROTOCOL_VERSION,
      requestId: 'req_pause',
      type: 'task.pause',
      payload: { taskId: snapshot.task.id },
    });
    await router({
      version: PROTOCOL_VERSION,
      requestId: 'req_clear_context',
      type: 'task.clearContext',
      payload: { taskId: snapshot.task.id },
    });
    await router({
      version: PROTOCOL_VERSION,
      requestId: 'req_snapshot',
      type: 'task.getSnapshot',
      payload: { taskId: snapshot.task.id },
    });
    await router({
      version: PROTOCOL_VERSION,
      requestId: 'req_resume',
      type: 'task.resume',
      payload: { taskId: snapshot.task.id },
    });
    await router({
      version: PROTOCOL_VERSION,
      requestId: 'req_retry',
      type: 'task.retry',
      payload: { taskId: snapshot.task.id },
    });
    await router({
      version: PROTOCOL_VERSION,
      requestId: 'req_cancel',
      type: 'task.cancel',
      payload: { taskId: snapshot.task.id },
    });

    expect(commands.create).toHaveBeenCalledWith({
      tabId: 7,
      conversationId: 'conv_1',
      goal: 'Complete the page',
    });
    expect(commands.pause).toHaveBeenCalledWith(snapshot.task.id);
    expect(commands.getSnapshot).toHaveBeenCalledWith(snapshot.task.id);
    expect(commands.resume).toHaveBeenCalledWith(snapshot.task.id);
    expect(commands.retry).toHaveBeenCalledWith(snapshot.task.id);
    expect(commands.cancel).toHaveBeenCalledWith(snapshot.task.id);
    expect(commands.clearContext).toHaveBeenCalledWith(snapshot.task.id);
    expect(scheduleTask).toHaveBeenNthCalledWith(1, snapshot.task.id);
    expect(scheduleTask).toHaveBeenNthCalledWith(2, snapshot.task.id);
    expect(scheduleTask).toHaveBeenNthCalledWith(3, snapshot.task.id);
  });

  it('maps known and unexpected command failures to stable public errors', async () => {
    const commands = buildCommands(buildSnapshot());
    vi.mocked(commands.getSnapshot).mockRejectedValueOnce(
      new TaskCommandError('TASK_NOT_FOUND', 'Task does not exist.'),
    );
    vi.mocked(commands.pause).mockRejectedValueOnce(new Error('private storage details'));
    const router = createMessageRouter({
      commands,
      panel: buildPanel(),
      screenshots: buildScreenshots(),
      requestRecoveryScan: vi.fn(async () => undefined),
      scheduleTask: vi.fn(async () => undefined),
    });

    const missing = await router({
      version: PROTOCOL_VERSION,
      requestId: 'req_missing',
      type: 'task.getSnapshot',
      payload: { taskId: 'missing' },
    });
    const unexpected = await router({
      version: PROTOCOL_VERSION,
      requestId: 'req_failed',
      type: 'task.pause',
      payload: { taskId: 'task_1' },
    });

    expect(missing).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
    expect(unexpected).toEqual({
      version: PROTOCOL_VERSION,
      requestId: 'req_failed',
      ok: false,
      error: { code: 'COMMAND_FAILED', message: 'Task command could not be completed.' },
    });
    expect(JSON.stringify(unexpected)).not.toContain('private storage details');
  });

  it('routes viewport and region screenshot capture without exposing image bytes', async () => {
    const screenshots = buildScreenshots();
    const router = createMessageRouter({
      commands: buildCommands(buildSnapshot()),
      panel: buildPanel(),
      screenshots,
      requestRecoveryScan: vi.fn(async () => undefined),
      scheduleTask: vi.fn(async () => undefined),
    });

    const viewport = await router({
      version: PROTOCOL_VERSION,
      requestId: 'req_viewport',
      type: 'screenshot.capture',
      payload: { tabId: 7, mode: 'viewport' },
    });
    const region = await router({
      version: PROTOCOL_VERSION,
      requestId: 'req_region',
      type: 'screenshot.capture',
      payload: { tabId: 7, mode: 'region' },
    });

    expect(viewport).toMatchObject({ ok: true, data: { id: 'attachment_viewport' } });
    expect(region).toMatchObject({ ok: true, data: { id: 'attachment_region' } });
    expect(screenshots.captureViewport).toHaveBeenCalledWith(7);
    expect(screenshots.captureRegion).toHaveBeenCalledWith(7);
  });

  it('routes a trusted side-panel image preview request by attachment reference only', async () => {
    const panel = buildPanel();
    const router = createMessageRouter({
      commands: buildCommands(buildSnapshot()),
      panel,
      screenshots: buildScreenshots(),
      requestRecoveryScan: vi.fn(async () => undefined),
      scheduleTask: vi.fn(async () => undefined),
    });

    const response = await router({
      version: PROTOCOL_VERSION,
      requestId: 'req_preview',
      type: 'image.preview.open',
      payload: { tabId: 7, attachmentId: 'attachment_1' },
    });

    expect(response).toMatchObject({ ok: true, data: { opened: true } });
    expect(panel.openImagePreview).toHaveBeenCalledWith(7, 'attachment_1');
    expect(JSON.stringify(response)).not.toContain('data:image');
  });

  it('routes panel snapshots and chat submission through the sanitized panel boundary', async () => {
    const panel = buildPanel();
    const router = createMessageRouter({
      commands: buildCommands(buildSnapshot()),
      panel,
      screenshots: buildScreenshots(),
      requestRecoveryScan: vi.fn(async () => undefined),
      scheduleTask: vi.fn(async () => undefined),
    });

    await router({
      version: PROTOCOL_VERSION,
      requestId: 'req_panel',
      type: 'panel.getSnapshot',
      payload: { tabId: 7 },
    });
    await router({
      version: PROTOCOL_VERSION,
      requestId: 'req_chat',
      type: 'chat.submit',
      payload: { tabId: 7, text: 'Do it', attachmentIds: [] },
    });
    await router({
      version: PROTOCOL_VERSION,
      requestId: 'req_supplement',
      type: 'chat.supplement',
      payload: { taskId: 'task_1', text: 'Use official sources', attachmentIds: [] },
    });
    await router({
      version: PROTOCOL_VERSION,
      requestId: 'req_task_details',
      type: 'panel.getTaskDetails',
      payload: { taskId: 'task_1' },
    });

    expect(panel.getSnapshot).toHaveBeenCalledWith(7, undefined);
    expect(panel.getTaskDetails).toHaveBeenCalledWith('task_1');
    expect(panel.submit).toHaveBeenCalledWith({ tabId: 7, text: 'Do it', attachmentIds: [] });
    expect(panel.supplement).toHaveBeenCalledWith({
      taskId: 'task_1',
      text: 'Use official sources',
      attachmentIds: [],
    });
  });
});
