import { describe, expect, it, vi } from 'vitest';
import { buildAgentContext } from '../../../src/agent/context/agent-context';
import { MAX_OBSERVATION_CHARACTERS } from '../../../src/agent/context/context-budget';
import { IMAGE_POLICY } from '../../../src/attachments/attachment-policy';
import type { PageObservation } from '../../../src/browser/contracts/observation';
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
  budget: {
    browserActionsLimit: 50,
    browserActionsUsed: 2,
    actionAttemptsLimit: 3,
    replansLimit: 2,
    replansUsed: 1,
    wallClockLimitMs: 1_200_000,
  },
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
      toolName: 'browser.act',
      argumentsJson: '{"type":"click"}',
      output: '{"verified":true,"url":"https://shop.test/checkout"}',
      resultRef: 'evidence_1',
    },
  ],
  observationRef: 'observation_current',
  pendingAction: null,
  createdAt: 200,
};

const OBSERVATION: PageObservation = {
  id: 'observation_current',
  capturedAt: 200,
  tabId: 7,
  url: 'https://shop.test/checkout',
  title: 'Checkout',
  viewport: { width: 1200, height: 800, scrollX: 0, scrollY: 0 },
  textRegions: [
    {
      kind: 'main',
      text: `CURRENT OBSERVATION ${'x'.repeat(MAX_OBSERVATION_CHARACTERS)}`,
      framePath: [],
      rect: { x: 0, y: 0, width: 800, height: 600 },
    },
  ],
  elements: [
    {
      observationRef: 'element_1',
      framePath: [],
      shadowPath: [],
      role: 'button',
      name: 'Place order',
      label: null,
      text: 'Place order',
      value: null,
      stableAttributes: { 'data-testid': 'place-order' },
      ancestorHint: 'Order summary',
      state: { disabled: false, checked: null, selected: null, expanded: null },
      rect: { x: 20, y: 30, width: 120, height: 32 },
      visible: true,
      obscured: false,
      backendNodeId: 10,
      cdpSessionId: null,
    },
  ],
  frames: [],
  truncated: true,
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
  it('keeps task evidence, the current bounded observation, recent chat, and referenced images', async () => {
    const messages = [
      message({ id: 'old', role: 'user', text: `OLD OBSERVATION ${'o'.repeat(33_000)}` }),
      message({
        id: 'interrupted',
        role: 'assistant',
        text: 'PARTIAL COMPETING ANSWER',
        status: 'interrupted',
      }),
      message({ id: 'recent', role: 'assistant', text: 'The cart is ready.', createdAt: 150 }),
      message({
        id: 'current',
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
        observation: OBSERVATION,
        customSystemPrompt: 'Prefer primary sources.',
        visualImageUrl: 'data:image/png;base64,AQID',
      },
      { conversations: conversationRepository(messages), attachments },
    );

    expect(context.systemPrompt).toContain('untrusted');
    expect(context.systemPrompt).toContain('Prefer primary sources.');
    const serialized = JSON.stringify(context.input);
    expect(serialized).toContain('Find the safest checkout option');
    expect(serialized).toContain('CURRENT OBSERVATION');
    expect(serialized).toContain('The cart is ready.');
    expect(serialized).toContain('Use this screenshot.');
    expect(serialized).not.toContain('OLD OBSERVATION');
    expect(serialized).not.toContain('PARTIAL COMPETING ANSWER');
    expect(context.input).toContainEqual({
      type: 'function_call',
      callId: 'call_done',
      name: 'browser.act',
      argumentsJson: '{"type":"click"}',
    });
    expect(context.input).toContainEqual({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Visual fallback for the current viewport:' },
        { type: 'input_image', imageUrl: 'data:image/png;base64,AQID', detail: 'high' },
      ],
    });
    expect(context.input).toContainEqual({
      type: 'function_call_output',
      callId: 'call_done',
      output: '{"verified":true,"url":"https://shop.test/checkout"}',
    });
    expect(serialized).toContain('data:image/png;base64,AAEC');
    expect(attachmentGet).toHaveBeenCalledTimes(1);
    expect(attachmentGet).toHaveBeenCalledWith('attachment_1');

    const contextText = context.input[0];
    expect(contextText).toMatchObject({ type: 'message', role: 'user' });
    if (contextText?.type !== 'message') throw new Error('Expected context message.');
    const firstPart = contextText.content[0];
    if (firstPart?.type !== 'input_text') throw new Error('Expected context text.');
    const observationSection = firstPart.text.split('## Current page')[1]?.split('## Recent')[0];
    expect(observationSection?.length).toBeLessThanOrEqual(MAX_OBSERVATION_CHARACTERS + 200);
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
          observation: OBSERVATION,
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
        role: 'user',
        text: 'Use every attached image.',
        attachmentIds,
      }),
    ];

    const context = await buildAgentContext(
      {
        task: TASK,
        checkpoint: CHECKPOINT,
        observation: OBSERVATION,
        customSystemPrompt: '',
      },
      { conversations: conversationRepository(messages), attachments },
    );
    const imageParts = context.input.flatMap((item) =>
      item.type === 'message' ? item.content.filter((part) => part.type === 'input_image') : [],
    );

    expect(imageParts).toHaveLength(IMAGE_POLICY.maxCount);
    expect(imageParts.at(-1)).toMatchObject({ imageUrl: 'data:image/gif;base64,CA==' });
  });
});
