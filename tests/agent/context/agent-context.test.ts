import { describe, expect, it, vi } from 'vitest';
import { buildAgentContext } from '../../../src/agent/context/agent-context';
import { IMAGE_POLICY } from '../../../src/attachments/attachment-policy';
import type { AttachmentRepository } from '../../../src/persistence/attachment-repository';
import type { ConversationRepository } from '../../../src/persistence/conversation-repository';
import type { Checkpoint } from '../../../src/tasks/checkpoint-types';
import type { MessageRecord } from '../../../src/tasks/message-types';
import type { TaskRun } from '../../../src/tasks/task-types';

const TASK: TaskRun = {
  id: 'task_1',
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
  createdAt: 200,
};

/** Creates a complete message fixture. */
function message(
  input: Partial<MessageRecord> & Pick<MessageRecord, 'id' | 'role' | 'text'>,
): MessageRecord {
  return {
    id: input.id,
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
    listByTab: vi.fn(async () => []),
    listMessages: vi.fn(async () => messages),
    appendMessage: vi.fn(async () => undefined),
    updateMessage: vi.fn(async () => undefined),
    clearConversation: vi.fn(async () => undefined),
  };
}

describe('buildAgentContext', () => {
  it('sends only the current user input, explicit attachments, and completed tool results', async () => {
    const messages = [
      message({
        id: 'old',
        taskId: 'task_old',
        role: 'user',
        text: `OLD USER INPUT ${'o'.repeat(33_000)}`,
      }),
      message({
        id: 'interrupted',
        taskId: 'task_1',
        role: 'assistant',
        text: 'PARTIAL COMPETING ANSWER',
        status: 'interrupted',
      }),
      message({
        id: 'recent',
        taskId: 'task_1',
        role: 'assistant',
        text: 'The cart is ready.',
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
      },
      { conversations: conversationRepository(messages), attachments },
    );

    expect(context.systemPrompt).toBe('Prefer primary sources.');
    expect(context.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Use this screenshot.' },
          { type: 'input_image', imageUrl: 'data:image/png;base64,AAEC', detail: 'high' },
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
      /CURRENT OBSERVATION|Find the safest checkout option|Risk and recovery|Remaining budget|The cart is ready|OLD USER INPUT|PARTIAL COMPETING ANSWER|AQID/,
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
      },
      {
        conversations: conversationRepository([
          message({ id: 'current', taskId: 'task_1', role: 'user', text: 'Hello model.' }),
        ]),
        attachments: { get: attachmentGet },
      },
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
        },
        {
          conversations: conversationRepository([
            message({ id: 'old', taskId: 'task_old', role: 'user', text: 'Old task input' }),
          ]),
          attachments: { get: vi.fn(async () => undefined) },
        },
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
        },
        { conversations: conversationRepository(messages), attachments },
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
      },
      { conversations: conversationRepository(messages), attachments },
    );
    const imageParts = context.input.flatMap((item) =>
      item.type === 'message' ? item.content.filter((part) => part.type === 'input_image') : [],
    );

    expect(context.systemPrompt).toBe('');
    expect(imageParts).toHaveLength(IMAGE_POLICY.maxCount);
    expect(imageParts.at(-1)).toMatchObject({ imageUrl: 'data:image/gif;base64,CA==' });
  });
});
