import { describe, expect, it, vi } from 'vitest';
import { buildAgentContext } from '../../../src/agent/context/agent-context';
import { IMAGE_POLICY } from '../../../src/attachments/attachment-policy';
import type { AttachmentRepository } from '../../../src/persistence/attachment-repository';
import type { ConversationRepository } from '../../../src/persistence/conversation-repository';
import type { TaskRepository } from '../../../src/persistence/task-repository';
import type { Checkpoint } from '../../../src/tasks/checkpoint-types';
import type { MessageRecord } from '../../../src/tasks/message-types';
import type { TaskRun } from '../../../src/tasks/task-types';

const TASK: TaskRun = {
  id: 'task_1',
  workSessionId: 'workSession_active',
  conversationId: 'conversation_1',
  tabId: 7,
  goal: 'Find the safest checkout option',
  status: 'planning',
  createdAt: 100,
  updatedAt: 200,
  checkpointId: 'checkpoint_1',
  lease: null,
  lastError: null,
};

const CHECKPOINT: Checkpoint = {
  id: 'checkpoint_1',
  taskId: 'task_1',
  sequence: 4,
  taskStatus: 'planning',
  completedToolResults: [
    {
      callId: 'call_done',
      toolName: 'lookup_record',
      argumentsJson: '{"type":"click"}',
      output: '{"verified":true,"url":"https://shop.test/checkout"}',
      resultRef: 'evidence_1',
    },
  ],
  continuationItems: [],
  pendingToolCall: null,
  createdAt: 200,
};

/** Creates a complete message fixture. */
function message(
  input: Partial<MessageRecord> & Pick<MessageRecord, 'id' | 'role' | 'text'>,
): MessageRecord {
  return {
    id: input.id,
    kind: input.kind ?? 'conversation',
    conversationId: 'conversation_1',
    taskId: input.taskId ?? null,
    role: input.role,
    status: input.status ?? 'complete',
    text: input.text,
    attachmentIds: input.attachmentIds ?? [],
    createdAt: input.createdAt ?? 100,
    updatedAt: input.updatedAt ?? 100,
  };
}

/** Creates a repository stub with only context-building methods active. */
function conversationRepository(messages: MessageRecord[]): ConversationRepository {
  return {
    create: vi.fn(async () => undefined),
    get: vi.fn(async () => undefined),
    listAll: vi.fn(async () => []),
    listByTab: vi.fn(async () => []),
    listMessages: vi.fn(async () => messages),
    appendMessage: vi.fn(async () => undefined),
    appendSupplement: vi.fn(async () => undefined),
    updateMessage: vi.fn(async () => undefined),
    clearConversation: vi.fn(async () => undefined),
  };
}

/** Infers successful historical sessions while keeping the current task active. */
function taskRepository(
  messages: readonly MessageRecord[],
  overrides: readonly TaskRun[] = [],
): Pick<TaskRepository, 'listByConversation'> {
  const overriddenIds = new Set(overrides.map(({ id }) => id));
  const inferred = [
    ...new Set(messages.flatMap((item) => (item.taskId === null ? [] : [item.taskId]))),
  ]
    .filter((taskId) => taskId !== TASK.id && !overriddenIds.has(taskId))
    .map((taskId, index): TaskRun => ({
      ...TASK,
      id: taskId,
      workSessionId: `workSession_${taskId}`,
      status: 'completed',
      createdAt: 10 + index,
      updatedAt: 20 + index,
      checkpointId: `checkpoint_${taskId}`,
    }));
  return {
    listByConversation: vi.fn(async () => [...inferred, ...overrides, TASK]),
  };
}

/** Builds all ports required by WorkSession-aware context materialization. */
function contextDependencies(
  messages: MessageRecord[],
  attachments: Pick<AttachmentRepository, 'get'>,
  tasks: Pick<TaskRepository, 'listByConversation'> = taskRepository(messages),
) {
  return {
    conversations: conversationRepository(messages),
    attachments,
    tasks,
  };
}

describe('buildAgentContext', () => {
  it('does not carry a completed WorkSession supplement into later history', async () => {
    const messages = [
      message({
        id: 'history_user',
        taskId: 'task_history',
        role: 'user',
        text: 'Inspect the checkout flow.',
        createdAt: 10,
      }),
      message({
        id: 'history_supplement',
        kind: 'supplement',
        taskId: 'task_history',
        role: 'user',
        text: 'THIS RUNTIME SUPPLEMENT MUST NOT ENTER LATER HISTORY',
        createdAt: 11,
      }),
      message({
        id: 'history_assistant',
        taskId: 'task_history',
        role: 'assistant',
        text: 'The checkout flow was verified.',
        createdAt: 12,
      }),
      message({
        id: 'current_user',
        taskId: TASK.id,
        role: 'user',
        text: 'Now inspect the account page.',
        createdAt: 20,
      }),
    ];
    const context = await buildAgentContext(
      {
        task: TASK,
        checkpoint: {
          ...CHECKPOINT,
          completedToolResults: [],
          continuationItems: [{ type: 'message_ref', messageId: 'current_user' }],
        },
        customSystemPrompt: '',
        historyMessageLimit: 50,
      },
      contextDependencies(messages, { get: vi.fn(async () => undefined) }),
    );

    expect(JSON.stringify(context.input)).toContain('Inspect the checkout flow.');
    expect(JSON.stringify(context.input)).toContain('The checkout flow was verified.');
    expect(JSON.stringify(context.input)).not.toContain(
      'THIS RUNTIME SUPPLEMENT MUST NOT ENTER LATER HISTORY',
    );
  });

  it('passes the configured system prompt without injecting browser instructions', async () => {
    const context = await buildAgentContext(
      {
        task: TASK,
        checkpoint: {
          ...CHECKPOINT,
          browserTargetTabId: 23,
          completedToolResults: [],
        },
        customSystemPrompt: '你是一个浏览器助手',
        historyMessageLimit: 50,
      },
      contextDependencies(
        [
          message({
            id: 'current',
            taskId: TASK.id,
            role: 'user',
            text: 'Analyze this page.',
          }),
        ],
        { get: vi.fn(async () => undefined) },
      ),
    );

    expect(context.systemPrompt).toBe('你是一个浏览器助手');
  });

  it('rehydrates screenshot attachments only while materializing a function output', async () => {
    const messages = [
      message({
        id: 'current',
        taskId: TASK.id,
        role: 'user',
        text: 'Inspect the page visually.',
      }),
    ];
    const get = vi.fn(async (id: string) =>
      id === 'attachment_screenshot'
        ? {
            id,
            blob: new Blob([new Uint8Array([137, 80, 78, 71])], {
              type: 'image/png',
            }),
            mimeType: 'image/png',
            byteSize: 4,
            width: 800,
            height: 600,
            source: 'visual_fallback' as const,
            createdAt: 200,
          }
        : undefined,
    );

    const context = await buildAgentContext(
      {
        task: TASK,
        checkpoint: {
          ...CHECKPOINT,
          completedToolResults: [
            {
              callId: 'call_screenshot',
              toolName: 'browser_inspect',
              argumentsJson: '{"tabId":7,"mode":"screenshot"}',
              output: '{"ok":true,"data":{"mode":"screenshot"}}',
              resultRef: 'result_screenshot',
              attachmentIds: ['attachment_screenshot'],
            },
          ],
          continuationItems: [
            { type: 'message_ref', messageId: 'current' },
            {
              type: 'function_call',
              callId: 'call_screenshot',
              name: 'browser_inspect',
              argumentsJson: '{"tabId":7,"mode":"screenshot"}',
            },
            {
              type: 'function_call_output',
              callId: 'call_screenshot',
              output: '{"ok":true,"data":{"mode":"screenshot"}}',
              resultRef: 'result_screenshot',
              attachmentIds: ['attachment_screenshot'],
            },
          ],
        },
        customSystemPrompt: '',
        historyMessageLimit: 50,
      },
      contextDependencies(messages, { get }),
    );

    expect(context.input.at(-1)).toEqual({
      type: 'function_call_output',
      callId: 'call_screenshot',
      output: [
        {
          type: 'input_text',
          text: '{"ok":true,"data":{"mode":"screenshot"}}',
        },
        {
          type: 'input_image',
          imageUrl: 'data:image/png;base64,iVBORw==',
          detail: 'original',
        },
      ],
    });
    expect(get).toHaveBeenCalledWith('attachment_screenshot');
  });

  it('uses compact continuation as authoritative and omits older raw text and screenshots', async () => {
    const largeInspectPayload = `OLD_INSPECT_PAYLOAD_${'x'.repeat(20_000)}`;
    const commitArguments = JSON.stringify({
      state: 'Goal: continue from the checkpoint. Verified: inspection completed.',
      throughCallId: 'call_old_inspect',
    });
    const commitOutput =
      '{"ok":true,"compactedCalls":1,"releasedTextChars":20000,"releasedImages":1}';
    const messages = [
      message({
        id: 'current',
        taskId: TASK.id,
        role: 'user',
        text: 'Inspect the page and continue.',
      }),
    ];
    const get = vi.fn(async (id: string) =>
      id === 'old_screenshot'
        ? {
            id,
            blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
            mimeType: 'image/png',
            byteSize: 1,
            width: 1,
            height: 1,
            source: 'visual_fallback' as const,
            createdAt: 150,
          }
        : undefined,
    );

    const context = await buildAgentContext(
      {
        task: TASK,
        checkpoint: {
          ...CHECKPOINT,
          completedToolResults: [
            {
              callId: 'call_old_inspect',
              toolName: 'browser_inspect',
              argumentsJson: '{"mode":"screenshot"}',
              output: largeInspectPayload,
              resultRef: 'result_old_inspect',
              attachmentIds: ['old_screenshot'],
            },
            {
              callId: 'call_commit',
              toolName: 'commit_context',
              argumentsJson: commitArguments,
              output: commitOutput,
              resultRef: 'result_commit',
              attachmentIds: [],
            },
          ],
          continuationItems: [
            { type: 'message_ref', messageId: 'current' },
            {
              type: 'function_call',
              callId: 'call_commit',
              name: 'commit_context',
              argumentsJson: commitArguments,
            },
            {
              type: 'function_call_output',
              callId: 'call_commit',
              output: commitOutput,
              resultRef: 'result_commit',
              attachmentIds: [],
            },
          ],
        },
        customSystemPrompt: '',
        historyMessageLimit: 50,
      },
      contextDependencies(messages, { get }),
    );

    const serialized = JSON.stringify(context.input);
    expect(serialized).toContain('Goal: continue from the checkpoint.');
    expect(serialized).not.toContain(largeInspectPayload);
    expect(serialized).not.toContain('data:image/png;base64');
    expect(get).not.toHaveBeenCalledWith('old_screenshot');
  });

  it('keeps supplements and post-commit results ordered while loading only new screenshots', async () => {
    const commitArguments = JSON.stringify({
      state: 'Goal: continue with the corrected detail.',
      throughCallId: 'call_old_inspect',
    });
    const commitOutput = '{"ok":true,"compactedCalls":1,"releasedTextChars":50,"releasedImages":1}';
    const messages = [
      message({
        id: 'current',
        taskId: TASK.id,
        role: 'user',
        text: 'Inspect the form.',
      }),
      message({
        id: 'supplement',
        kind: 'supplement',
        taskId: TASK.id,
        role: 'user',
        text: 'Use the corrected account.',
      }),
    ];
    const get = vi.fn(async (id: string) =>
      id === 'new_screenshot' || id === 'old_screenshot'
        ? {
            id,
            blob: new Blob([new Uint8Array([id === 'new_screenshot' ? 2 : 1])], {
              type: 'image/png',
            }),
            mimeType: 'image/png',
            byteSize: 1,
            width: 1,
            height: 1,
            source: 'visual_fallback' as const,
            createdAt: 200,
          }
        : undefined,
    );

    const context = await buildAgentContext(
      {
        task: TASK,
        checkpoint: {
          ...CHECKPOINT,
          completedToolResults: [
            {
              callId: 'call_old_inspect',
              toolName: 'browser_inspect',
              argumentsJson: '{}',
              output: 'old output',
              resultRef: 'result_old_inspect',
              attachmentIds: ['old_screenshot'],
            },
            {
              callId: 'call_commit',
              toolName: 'commit_context',
              argumentsJson: commitArguments,
              output: commitOutput,
              resultRef: 'result_commit',
              attachmentIds: [],
            },
            {
              callId: 'call_new_inspect',
              toolName: 'browser_inspect',
              argumentsJson: '{"mode":"screenshot"}',
              output: 'new output',
              resultRef: 'result_new_inspect',
              attachmentIds: ['new_screenshot'],
            },
          ],
          continuationItems: [
            { type: 'message_ref', messageId: 'current' },
            { type: 'message_ref', messageId: 'supplement' },
            {
              type: 'function_call',
              callId: 'call_commit',
              name: 'commit_context',
              argumentsJson: commitArguments,
            },
            {
              type: 'function_call_output',
              callId: 'call_commit',
              output: commitOutput,
              resultRef: 'result_commit',
              attachmentIds: [],
            },
            {
              type: 'function_call',
              callId: 'call_new_inspect',
              name: 'browser_inspect',
              argumentsJson: '{"mode":"screenshot"}',
            },
            {
              type: 'function_call_output',
              callId: 'call_new_inspect',
              output: 'new output',
              resultRef: 'result_new_inspect',
              attachmentIds: ['new_screenshot'],
            },
          ],
        },
        customSystemPrompt: '',
        historyMessageLimit: 50,
      },
      contextDependencies(messages, { get }),
    );

    expect(context.input.map((item) => item.type)).toEqual([
      'message',
      'message',
      'function_call',
      'function_call_output',
      'function_call',
      'function_call_output',
    ]);
    expect(context.input[1]).toMatchObject({
      type: 'message',
      content: [
        {
          type: 'input_text',
          text: expect.stringContaining('Use the corrected account.'),
        },
      ],
    });
    expect(context.input.at(-1)).toMatchObject({
      type: 'function_call_output',
      callId: 'call_new_inspect',
      output: [
        { type: 'input_text', text: 'new output' },
        {
          type: 'input_image',
          imageUrl: 'data:image/png;base64,Ag==',
          detail: 'original',
        },
      ],
    });
    expect(get).toHaveBeenCalledWith('new_screenshot');
    expect(get).not.toHaveBeenCalledWith('old_screenshot');
  });

  it('replays ordered completed history without duplicating the current task', async () => {
    const messages = [
      message({
        id: 'previous-user',
        taskId: 'task_old',
        role: 'user',
        text: 'Previous question',
        createdAt: 100,
      }),
      message({
        id: 'previous-assistant',
        taskId: 'task_old',
        role: 'assistant',
        text: 'Previous answer',
        createdAt: 110,
      }),
      message({
        id: 'interrupted',
        taskId: 'task_interrupted',
        role: 'assistant',
        text: 'PARTIAL COMPETING ANSWER',
        status: 'interrupted',
        createdAt: 120,
      }),
      message({
        id: 'recent',
        taskId: 'task_1',
        role: 'assistant',
        text: 'CURRENT TASK ASSISTANT MUST NOT REPLAY',
        createdAt: 150,
      }),
      message({
        id: 'current',
        taskId: 'task_1',
        role: 'user',
        text: 'Use this screenshot.',
        attachmentIds: ['attachment_1'],
        createdAt: 160,
      }),
    ];
    const attachmentGet = vi.fn(async (id: string) =>
      id === 'attachment_1'
        ? {
            id,
            blob: new Blob([new Uint8Array([0, 1, 2])], { type: 'image/png' }),
            mimeType: 'image/png',
            byteSize: 3,
            width: 1,
            height: 1,
            source: 'viewport_capture' as const,
            createdAt: 160,
          }
        : undefined,
    );
    const attachments: AttachmentRepository = {
      put: vi.fn(),
      get: attachmentGet,
      addReference: vi.fn(async () => undefined),
      removeReference: vi.fn(async () => undefined),
      deleteUnreferenced: vi.fn(async () => 0),
    };

    const context = await buildAgentContext(
      {
        task: TASK,
        checkpoint: CHECKPOINT,
        customSystemPrompt: 'Prefer primary sources.',
        historyMessageLimit: 2,
      },
      contextDependencies(messages, attachments),
    );

    expect(context.systemPrompt).toBe('Prefer primary sources.');
    expect(context.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Previous question' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Previous answer' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Use this screenshot.' },
          {
            type: 'input_image',
            imageUrl: 'data:image/png;base64,AAEC',
            detail: 'high',
          },
        ],
      },
      {
        type: 'function_call',
        callId: 'call_done',
        name: 'lookup_record',
        argumentsJson: '{"type":"click"}',
      },
      {
        type: 'function_call_output',
        callId: 'call_done',
        output: '{"verified":true,"url":"https://shop.test/checkout"}',
      },
    ]);
    const serialized = JSON.stringify(context.input);
    expect(serialized).not.toMatch(
      /CURRENT OBSERVATION|Find the safest checkout option|Risk and recovery|Remaining budget|CURRENT TASK ASSISTANT MUST NOT REPLAY|PARTIAL COMPETING ANSWER|AQID/,
    );
    expect(attachmentGet).toHaveBeenCalledTimes(1);
    expect(attachmentGet).toHaveBeenCalledWith('attachment_1');
  });

  it('sends one exact text item and reads no attachment when the user added none', async () => {
    const attachmentGet = vi.fn(async () => undefined);
    const context = await buildAgentContext(
      {
        task: TASK,
        checkpoint: { ...CHECKPOINT, completedToolResults: [] },
        customSystemPrompt: '',
        historyMessageLimit: 50,
      },
      contextDependencies(
        [
          message({
            id: 'current',
            taskId: 'task_1',
            role: 'user',
            text: 'Hello model.',
          }),
        ],
        { get: attachmentGet },
      ),
    );

    expect(context.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Hello model.' }],
      },
    ]);
    expect(attachmentGet).not.toHaveBeenCalled();
  });

  it('rejects recovery context when no real user message belongs to the current task', async () => {
    await expect(
      buildAgentContext(
        {
          task: TASK,
          checkpoint: { ...CHECKPOINT, completedToolResults: [] },
          customSystemPrompt: '',
          historyMessageLimit: 50,
        },
        contextDependencies(
          [
            message({
              id: 'old',
              taskId: 'task_old',
              role: 'user',
              text: 'Old task input',
            }),
          ],
          { get: vi.fn(async () => undefined) },
        ),
      ),
    ).rejects.toThrow('Current task user message is missing.');
  });

  it('rejects referenced attachments whose stored type or size is no longer approved', async () => {
    const attachments: AttachmentRepository = {
      put: vi.fn(),
      get: vi.fn(async () => ({
        id: 'attachment_bad',
        blob: new Blob(['<svg/>'], { type: 'image/svg+xml' }),
        mimeType: 'image/svg+xml',
        byteSize: 6,
        width: 1,
        height: 1,
        source: 'file' as const,
        createdAt: 100,
      })),
      addReference: vi.fn(async () => undefined),
      removeReference: vi.fn(async () => undefined),
      deleteUnreferenced: vi.fn(async () => 0),
    };
    const messages = [
      message({
        id: 'bad',
        taskId: 'task_1',
        role: 'user',
        text: 'unsafe image',
        attachmentIds: ['attachment_bad'],
      }),
    ];

    await expect(
      buildAgentContext(
        {
          task: TASK,
          checkpoint: CHECKPOINT,
          customSystemPrompt: '',
          historyMessageLimit: 50,
        },
        contextDependencies(messages, attachments),
      ),
    ).rejects.toThrow(/attachment is invalid/i);
  });

  it('materializes the complete UI-approved image batch without a smaller model-only limit', async () => {
    const attachmentIds = Array.from(
      { length: IMAGE_POLICY.maxCount },
      (_, index) => `attachment_${String(index)}`,
    );
    const attachments: AttachmentRepository = {
      put: vi.fn(),
      get: vi.fn(async (id) => {
        const index = attachmentIds.indexOf(id);
        if (index < 0) return undefined;
        const mimeType = index === attachmentIds.length - 1 ? 'image/gif' : 'image/png';
        return {
          id,
          blob: new Blob([new Uint8Array([index + 1])], { type: mimeType }),
          mimeType,
          byteSize: 1,
          width: 1,
          height: 1,
          source: 'file' as const,
          createdAt: 100 + index,
        };
      }),
      addReference: vi.fn(async () => undefined),
      removeReference: vi.fn(async () => undefined),
      deleteUnreferenced: vi.fn(async () => 0),
    };
    const messages = [
      message({
        id: 'full-batch',
        taskId: 'task_1',
        role: 'user',
        text: 'Use every attached image.',
        attachmentIds,
      }),
    ];

    const context = await buildAgentContext(
      {
        task: TASK,
        checkpoint: CHECKPOINT,
        customSystemPrompt: '',
        historyMessageLimit: 50,
      },
      contextDependencies(messages, attachments),
    );
    const imageParts = context.input.flatMap((item) =>
      item.type === 'message' ? item.content.filter((part) => part.type === 'input_image') : [],
    );

    expect(context.systemPrompt).toBe('');
    expect(imageParts).toHaveLength(IMAGE_POLICY.maxCount);
    expect(imageParts.at(-1)).toMatchObject({
      imageUrl: 'data:image/gif;base64,CA==',
    });
  });

  it('does not truncate a selected historical message by character count', async () => {
    const longHistory = `LONG HISTORY ${'长'.repeat(150_000)}`;
    const context = await buildAgentContext(
      {
        task: TASK,
        checkpoint: { ...CHECKPOINT, completedToolResults: [] },
        customSystemPrompt: '',
        historyMessageLimit: 1,
      },
      contextDependencies(
        [
          message({
            id: 'long-history',
            taskId: 'task_old',
            role: 'user',
            text: longHistory,
            createdAt: 100,
          }),
          message({
            id: 'current',
            taskId: 'task_1',
            role: 'user',
            text: 'Current follow-up',
            createdAt: 200,
          }),
        ],
        { get: vi.fn(async () => undefined) },
      ),
    );

    expect(context.input[0]).toMatchObject({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: longHistory }],
    });
  });

  it('prioritizes current images and fills the remaining budget from newest history', async () => {
    const currentIds = Array.from({ length: 6 }, (_, index) => `current_${String(index)}`);
    const recentIds = ['recent_0', 'recent_1'];
    const get = vi.fn(async (id: string) => ({
      id,
      blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      mimeType: 'image/png',
      byteSize: 1,
      width: 1,
      height: 1,
      source: 'file' as const,
      createdAt: 100,
    }));
    const context = await buildAgentContext(
      {
        task: TASK,
        checkpoint: { ...CHECKPOINT, completedToolResults: [] },
        customSystemPrompt: '',
        historyMessageLimit: 10,
      },
      contextDependencies(
        [
          message({
            id: 'older',
            taskId: 'task_older',
            role: 'user',
            text: 'Older image',
            attachmentIds: ['older_0'],
            createdAt: 100,
          }),
          message({
            id: 'recent',
            taskId: 'task_recent',
            role: 'user',
            text: 'Recent images',
            attachmentIds: recentIds,
            createdAt: 120,
          }),
          message({
            id: 'current',
            taskId: 'task_1',
            role: 'user',
            text: 'Current images',
            attachmentIds: currentIds,
            createdAt: 140,
          }),
        ],
        { get },
      ),
    );

    const imageParts = context.input.flatMap((item) =>
      item.type === 'message' ? item.content.filter((part) => part.type === 'input_image') : [],
    );
    expect(imageParts).toHaveLength(IMAGE_POLICY.maxCount);
    expect(get).not.toHaveBeenCalledWith('older_0');
    expect(get.mock.calls.map(([id]) => id)).toEqual([...currentIds, ...recentIds]);
  });

  it('keeps 50 successful-history messages and replays one active WorkSession in exact order', async () => {
    const historicalMessages = Array.from({ length: 52 }, (_, index) =>
      message({
        id: `history_${index}`,
        taskId: `task_history_${index}`,
        role: 'user',
        text: `History ${index}`,
        createdAt: index + 1,
      }),
    );
    const activeMessages = [
      message({
        id: 'active_initial',
        taskId: 'task_active_previous',
        role: 'user',
        text: 'Initial request',
        createdAt: 100,
      }),
      message({
        id: 'cancelled_only',
        taskId: 'task_cancelled_only',
        role: 'user',
        text: 'MUST NOT ENTER HISTORY',
        createdAt: 101,
      }),
      message({
        id: 'supplement_1',
        kind: 'supplement',
        taskId: TASK.id,
        role: 'user',
        text: 'Use official sources',
        attachmentIds: ['attachment_supplement'],
        createdAt: 102,
      }),
      message({
        id: 'active_latest',
        taskId: TASK.id,
        role: 'user',
        text: 'Continue with the new detail',
        createdAt: 103,
      }),
    ];
    const messages = [...historicalMessages, ...activeMessages];
    const historicalTasks = historicalMessages.map((item, index): TaskRun => ({
      ...TASK,
      id: item.taskId as string,
      workSessionId: `workSession_history_${index}`,
      status: 'completed',
      createdAt: index + 1,
      updatedAt: index + 1,
    }));
    const tasks: TaskRun[] = [
      ...historicalTasks,
      {
        ...TASK,
        id: 'task_cancelled_only',
        workSessionId: 'workSession_cancelled_only',
        status: 'cancelled',
      },
      {
        ...TASK,
        id: 'task_active_previous',
        status: 'cancelled',
      },
      TASK,
    ];
    const context = await buildAgentContext(
      {
        task: TASK,
        checkpoint: {
          ...CHECKPOINT,
          completedToolResults: [
            {
              callId: 'call_1',
              toolName: 'tavily_search',
              argumentsJson: '{"query":"official"}',
              output: '{"ok":true}',
              resultRef: 'result_1',
            },
          ],
          continuationItems: [
            { type: 'message_ref', messageId: 'active_initial' },
            {
              type: 'function_call',
              callId: 'call_1',
              name: 'tavily_search',
              argumentsJson: '{"query":"official"}',
            },
            {
              type: 'function_call_output',
              callId: 'call_1',
              output: '{"ok":true}',
              resultRef: 'result_1',
            },
            { type: 'message_ref', messageId: 'supplement_1' },
            { type: 'message_ref', messageId: 'active_latest' },
          ],
        },
        customSystemPrompt: '',
        historyMessageLimit: 50,
      },
      contextDependencies(
        messages,
        {
          get: vi.fn(async (id) =>
            id === 'attachment_supplement'
              ? {
                  id,
                  blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
                  mimeType: 'image/png',
                  byteSize: 1,
                  width: 1,
                  height: 1,
                  source: 'file' as const,
                  createdAt: 102,
                }
              : undefined,
          ),
        },
        { listByConversation: vi.fn(async () => tasks) },
      ),
    );

    expect(context.input).toHaveLength(55);
    expect(context.input[0]).toMatchObject({
      type: 'message',
      content: [{ type: 'input_text', text: 'History 2' }],
    });
    expect(context.input.slice(-5)).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Initial request' }],
      },
      {
        type: 'function_call',
        callId: 'call_1',
        name: 'tavily_search',
        argumentsJson: '{"query":"official"}',
      },
      { type: 'function_call_output', callId: 'call_1', output: '{"ok":true}' },
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Additional information supplied while the task was running:\n\nUse official sources',
          },
          {
            type: 'input_image',
            imageUrl: 'data:image/png;base64,AQ==',
            detail: 'high',
          },
        ],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Continue with the new detail' }],
      },
    ]);
    expect(JSON.stringify(context.input)).not.toContain('MUST NOT ENTER HISTORY');
  });
});
