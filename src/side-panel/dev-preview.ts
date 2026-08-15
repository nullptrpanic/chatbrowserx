import type { RuntimePort } from '../platform/chrome/runtime-port';
import type { PanelSnapshot } from '../shared/protocol/panel-types';
import type { AttachmentDraftClient } from './chat/use-image-draft';
import type { PanelEnvironment } from './state/panel-client';

const previewSnapshot: PanelSnapshot = {
  generatedAt: Date.now(),
  tab: {
    id: 7,
    title: '示例 · 活动报名表',
    url: 'https://example.com/registration',
    origin: 'https://example.com',
    supported: true,
    hasPermission: true,
    debuggerAttached: true,
  },
  conversation: {
    id: 'conversation_preview',
    title: '填写活动报名表',
    tabId: 7,
    createdAt: Date.now() - 120_000,
    updatedAt: Date.now(),
    taskStatus: 'planning',
  },
  conversations: [
    {
      id: 'conversation_preview',
      title: '填写活动报名表',
      tabId: 7,
      createdAt: Date.now() - 120_000,
      updatedAt: Date.now(),
      taskStatus: 'planning',
    },
    {
      id: 'conversation_previous',
      title: '整理页面里的日程信息',
      tabId: 7,
      createdAt: Date.now() - 86_400_000,
      updatedAt: Date.now() - 86_000_000,
      taskStatus: 'completed',
    },
  ],
  messages: [
    {
      id: 'message_user',
      role: 'user',
      status: 'complete',
      text: '帮我填写这个报名表，提交前让我确认。',
      attachmentIds: [],
      createdAt: Date.now() - 105_000,
      updatedAt: Date.now() - 105_000,
    },
    {
      id: 'message_assistant',
      role: 'assistant',
      status: 'streaming',
      text: '我已经识别到姓名、邮箱和活动场次字段，正在核对可选时间。',
      attachmentIds: [],
      createdAt: Date.now() - 42_000,
      updatedAt: Date.now() - 3_000,
    },
  ],
  attachments: [],
  task: {
    id: 'task_preview',
    status: 'planning',
    goal: '填写活动报名表，提交前确认',
    tabId: 7,
    createdAt: Date.now() - 105_000,
    updatedAt: Date.now() - 2_000,
    sequence: 5,
    browserActionsUsed: 2,
    browserActionsLimit: 50,
    lastError: null,
    pendingConfirmation: null,
    events: [
      {
        sequence: 1,
        type: 'observation.started',
        reason: '已读取当前表单',
        at: Date.now() - 90_000,
      },
      {
        sequence: 2,
        type: 'planning.started',
        reason: '已规划表单填写顺序',
        at: Date.now() - 78_000,
      },
      {
        sequence: 3,
        type: 'action.verified',
        reason: '姓名字段填写完成并验证',
        at: Date.now() - 54_000,
      },
      {
        sequence: 4,
        type: 'action.verified',
        reason: '邮箱字段填写完成并验证',
        at: Date.now() - 31_000,
      },
      { sequence: 5, type: 'planning.started', reason: '正在选择活动场次', at: Date.now() - 2_000 },
    ],
  },
  settings: {
    model: 'gpt-5.6-terra',
    reasoningEffort: 'medium',
    systemPrompt: '',
    language: 'zh-CN',
    hasCodexToken: true,
    hasTavilyKey: true,
  },
};

/** Creates deterministic local-browser collaborators used only by Vite development preview. */
export function createDevPreviewProps(): {
  readonly runtimePort: RuntimePort;
  readonly environment: PanelEnvironment;
  readonly attachmentClient: AttachmentDraftClient;
} {
  return {
    runtimePort: {
      async send(message) {
        return {
          version: 1,
          requestId: message.requestId,
          ok: true,
          data:
            message.type === 'panel.getSnapshot'
              ? previewSnapshot
              : message.type === 'chat.submit'
                ? { task: { conversationId: 'conversation_preview' } }
                : { connected: true },
        };
      },
    },
    environment: {
      getActiveTab: async () => ({ id: 7 }),
      requestOriginPermission: async () => true,
    },
    attachmentClient: {
      addFiles: async () => [],
      get: async () => undefined,
    },
  };
}
