import { describe, expect, it, vi } from 'vitest';
import {
  buildAgentContext as buildAgentContextCore,
  type AgentContextDependencies,
  type AgentContextInput,
} from '../../../src/agent/context/agent-context';
import { IMAGE_POLICY } from '../../../src/attachments/attachment-policy';
import type { AttachmentRepository } from '../../../src/persistence/attachment-repository';
import type { ConversationRepository } from '../../../src/persistence/conversation-repository';
import type { TaskRepository } from '../../../src/persistence/task-repository';
import type { Checkpoint } from '../../../src/tasks/checkpoint-types';
import type { MessageRecord } from '../../../src/tasks/message-types';
import type { Task, TaskEvent } from '../../../src/tasks/task-types';
import type { MaterializedToolResult } from '../../../src/tasks/tool-result-types';

const TASK: Task = {
  id: 'task_1',
  conversationId: 'conversation_1',
  ordinal: 1,
  tabId: 7,
  goal: 'Find the safest checkout option',
  status: 'planning',
  latestRunId: 'run_1',
  lastEventSequence: 1,
  createdAt: 100,
  updatedAt: 200,
};

const CHECKPOINT: Checkpoint = {
  id: 'checkpoint_1',
  taskId: 'task_1',
  runId: 'run_1',
  continuationItems: [],
  pendingToolCall: null,
  browserToolCallsInAttempt: 0,
  browserTargetTabId: 7,
  createdAt: 200,
};

const COMPLETED_TOOL_RESULTS: readonly MaterializedToolResult[] = [
  {
    id: 'evidence_1',
    taskId: TASK.id,
    runId: 'run_1',
    callId: 'call_done',
    toolName: 'lookup_record',
    argumentsJson: '{"type":"click"}',
    output: '{"verified":true,"url":"https://shop.test/checkout"}',
    attachmentIds: [],
    createdAt: 150,
  },
];

type ContextResultFixture = Pick<
  MaterializedToolResult,
  'callId' | 'toolName' | 'argumentsJson' | 'output'
> & { readonly resultId: string } & Partial<
    Pick<MaterializedToolResult, 'id' | 'modelOutput' | 'attachmentIds' | 'createdAt'>
  >;

type ContextInputFixture = Omit<AgentContextInput, 'toolResults'> & {
  readonly toolResults?: readonly ContextResultFixture[];
};

/** Normalizes concise result fixtures into the canonical result store view. */
function canonicalResults(results: readonly ContextResultFixture[]): MaterializedToolResult[] {
  return results.map((result) => ({
    id: result.id ?? result.resultId,
    taskId: TASK.id,
    runId: 'run_1',
    callId: result.callId,
    toolName: result.toolName,
    argumentsJson: result.argumentsJson,
    output: result.output,
    ...(result.modelOutput === undefined ? {} : { modelOutput: result.modelOutput }),
    attachmentIds: result.attachmentIds ?? [],
    createdAt: result.createdAt ?? 150,
  }));
}

/** Keeps test fixtures concise while exercising the production context boundary. */
function buildAgentContext(input: ContextInputFixture, dependencies: AgentContextDependencies) {
  return buildAgentContextCore(
    {
      task: input.task,
      checkpoint: input.checkpoint,
      toolResults:
        input.toolResults === undefined
          ? COMPLETED_TOOL_RESULTS
          : canonicalResults(input.toolResults),
      customSystemPrompt: input.customSystemPrompt,
      historyMessageLimit: input.historyMessageLimit,
    },
    dependencies,
  );
}

/** Creates a complete message fixture. */
function message(
  input: Partial<MessageRecord> & Pick<MessageRecord, 'id' | 'role' | 'text'>,
): MessageRecord {
  return {
    id: input.id,
    kind: input.kind ?? 'conversation',
    conversationId: 'conversation_1',
    taskId: input.taskId ?? TASK.id,
    role: input.role,
    status: input.status ?? 'complete',
    text: input.text,
    attachmentIds: input.attachmentIds ?? [],
    ...(input.sourcePage === undefined ? {} : { sourcePage: input.sourcePage }),
    createdAt: input.createdAt ?? 100,
    updatedAt: input.updatedAt ?? 100,
  };
}

/** Creates a repository stub with only context-building methods active. */
function conversationRepository(messages: MessageRecord[]): ConversationRepository {
  return {
    get: vi.fn(async () => undefined),
    listAll: vi.fn(async () => []),
    listMessages: vi.fn(async () => messages),
    listRecentMessages: vi.fn(async (_conversationId, limit) => messages.slice(-limit)),
    listTaskMessages: vi.fn(async (taskId) =>
      messages.filter((message) => message.taskId === taskId),
    ),
    updateMessage: vi.fn(async () => undefined),
    clearConversation: vi.fn(async () => undefined),
  };
}

/** Builds the canonical message-event order used by completed-task model history. */
function taskEvents(messages: readonly MessageRecord[], taskIds: readonly string[]): TaskEvent[] {
  const selectedTaskIds = new Set(taskIds);
  const nextSequenceByTask = new Map<string, number>();
  return messages.flatMap((item): TaskEvent[] => {
    if (
      item.kind !== 'conversation' ||
      item.status !== 'complete' ||
      !selectedTaskIds.has(item.taskId)
    ) {
      return [];
    }
    const sequence = (nextSequenceByTask.get(item.taskId) ?? 0) + 1;
    nextSequenceByTask.set(item.taskId, sequence);
    return [
      {
        id: `event_${item.id}`,
        taskId: item.taskId,
        runId: `run_${item.taskId}`,
        sequence,
        type: 'message.recorded',
        messageId: item.id,
        at: item.createdAt,
      },
    ];
  });
}

/** Infers successful historical tasks while keeping the current task active. */
function taskRepository(
  messages: readonly MessageRecord[],
  overrides: readonly Task[] = [],
): Pick<TaskRepository, 'listByConversation' | 'readTaskMessageEvents'> {
  const overriddenIds = new Set(overrides.map(({ id }) => id));
  const inferred = [...new Set(messages.map((item) => item.taskId))]
    .filter((taskId) => taskId !== TASK.id && !overriddenIds.has(taskId))
    .map((taskId, index): Task => ({
      ...TASK,
      id: taskId,
      ordinal: index + 1,
      status: 'completed',
      createdAt: 10 + index,
      updatedAt: 20 + index,
      latestRunId: `run_${taskId}`,
    }));
  return {
    listByConversation: vi.fn(async () => [...inferred, ...overrides, TASK]),
    readTaskMessageEvents: vi.fn(async (taskIds) => taskEvents(messages, taskIds)),
  };
}

/** Builds all ports required by active-task context materialization. */
function contextDependencies(
  messages: MessageRecord[],
  attachments: Pick<AttachmentRepository, 'get'>,
  tasks: Pick<TaskRepository, 'listByConversation' | 'readTaskMessageEvents'> = taskRepository(
    messages,
  ),
) {
  return {
    conversations: conversationRepository(messages),
    attachments,
    tasks,
  };
}

describe('buildAgentContext', () => {
  it('does not carry a completed task supplement into later history', async () => {
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
          continuationItems: [{ type: 'message_ref', messageId: 'current_user' }],
        },
        toolResults: [],
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

  it('orders completed history by TaskEvent sequence instead of message timestamps', async () => {
    const historyTask: Task = {
      ...TASK,
      id: 'task_history',
      ordinal: 1,
      status: 'completed',
      latestRunId: 'run_history',
    };
    const historicalAssistant = message({
      id: 'history_assistant',
      taskId: historyTask.id,
      role: 'assistant',
      text: 'Historical answer',
      createdAt: 10,
    });
    const historicalUser = message({
      id: 'history_user',
      taskId: historyTask.id,
      role: 'user',
      text: 'Historical request',
      createdAt: 20,
    });
    const currentUser = message({
      id: 'current_user',
      taskId: TASK.id,
      role: 'user',
      text: 'Current request',
      createdAt: 30,
    });
    const messages = [historicalAssistant, historicalUser, currentUser];
    const context = await buildAgentContext(
      {
        task: TASK,
        checkpoint: {
          ...CHECKPOINT,
          continuationItems: [{ type: 'message_ref', messageId: currentUser.id }],
        },
        toolResults: [],
        customSystemPrompt: '',
        historyMessageLimit: 50,
      },
      contextDependencies(
        messages,
        { get: vi.fn(async () => undefined) },
        {
          listByConversation: vi.fn(async () => [historyTask, TASK]),
          readTaskMessageEvents: vi.fn(async (): Promise<TaskEvent[]> => [
            {
              id: 'event_history_user',
              taskId: historyTask.id,
              runId: 'run_history',
              sequence: 1,
              type: 'message.recorded',
              messageId: historicalUser.id,
              at: 20,
            },
            {
              id: 'event_history_assistant',
              taskId: historyTask.id,
              runId: 'run_history',
              sequence: 2,
              type: 'message.recorded',
              messageId: historicalAssistant.id,
              at: 10,
            },
          ]),
        },
      ),
    );

    expect(context.input.slice(0, 2)).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Historical request' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Historical answer' }],
      },
    ]);
  });

  it('passes the configured system prompt without injecting browser instructions', async () => {
    const context = await buildAgentContext(
      {
        task: TASK,
        checkpoint: {
          ...CHECKPOINT,
          browserTargetTabId: 23,
          continuationItems: [{ type: 'message_ref', messageId: 'current' }],
        },
        toolResults: [],
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

  it('keeps task-page metadata out of provider user input', async () => {
    const active = message({
      id: 'current_with_page',
      taskId: TASK.id,
      role: 'user',
      text: 'Analyze this page.',
      sourcePage: {
        title: 'Messenger - Feishu',
        url: 'https://bytedance.larkoffice.com/next/messenger',
        favIconUrl: null,
      },
    });
    const context = await buildAgentContext(
      {
        task: TASK,
        checkpoint: {
          ...CHECKPOINT,
          continuationItems: [{ type: 'message_ref', messageId: active.id }],
        },
        toolResults: [],
        customSystemPrompt: '你是一个浏览器助手',
        historyMessageLimit: 50,
      },
      contextDependencies([active], { get: vi.fn(async () => undefined) }),
    );

    expect(context.systemPrompt).toBe('你是一个浏览器助手');
    expect(context.activeInput).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Analyze this page.' }],
      },
    ]);
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
          continuationItems: [
            { type: 'message_ref', messageId: 'current' },
            {
              type: 'function_call',
              callId: 'call_screenshot',
              name: 'browser_inspect',
              argumentsJson: '{"tabId":7,"mode":"screenshot"}',
            },
            {
              type: 'function_call_output_ref',
              callId: 'call_screenshot',
              resultId: 'result_screenshot',
              attachmentIds: ['attachment_screenshot'],
            },
          ],
        },
        toolResults: [
          {
            callId: 'call_screenshot',
            toolName: 'browser_inspect',
            argumentsJson: '{"tabId":7,"mode":"screenshot"}',
            output: '{"ok":true,"data":{"mode":"screenshot"}}',
            resultId: 'result_screenshot',
            attachmentIds: ['attachment_screenshot'],
          },
        ],
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
          continuationItems: [
            { type: 'message_ref', messageId: 'current' },
            {
              type: 'function_call',
              callId: 'call_commit',
              name: 'commit_context',
              argumentsJson: commitArguments,
            },
            {
              type: 'function_call_output_ref',
              callId: 'call_commit',
              resultId: 'result_commit',
              attachmentIds: [],
            },
          ],
        },
        toolResults: [
          {
            callId: 'call_old_inspect',
            toolName: 'browser_inspect',
            argumentsJson: '{"mode":"screenshot"}',
            output: largeInspectPayload,
            resultId: 'result_old_inspect',
            attachmentIds: ['old_screenshot'],
          },
          {
            callId: 'call_commit',
            toolName: 'commit_context',
            argumentsJson: commitArguments,
            output: commitOutput,
            resultId: 'result_commit',
            attachmentIds: [],
          },
        ],
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

  it('replays same-turn model output before its function call', async () => {
    const messages = [
      message({
        id: 'current',
        taskId: TASK.id,
        role: 'user',
        text: 'Inspect the page.',
      }),
      message({
        id: 'assistant_before_tool',
        taskId: TASK.id,
        role: 'assistant',
        status: 'interrupted',
        text: 'I found the target and will inspect it.',
      }),
    ];
    const context = await buildAgentContext(
      {
        task: TASK,
        checkpoint: {
          ...CHECKPOINT,
          continuationItems: [
            { type: 'message_ref', messageId: 'current' },
            {
              type: 'function_call',
              callId: 'call_inspect',
              name: 'browser_inspect',
              argumentsJson: '{"tabId":0,"mode":"interactive"}',
              modelOutputItems: [
                {
                  type: 'reasoning',
                  itemId: 'reasoning_inspect',
                  encryptedContent: 'opaque-encrypted-content',
                  summary: [{ type: 'summary_text', text: 'Inspect the active page.' }],
                },
                {
                  type: 'assistant_message_ref',
                  messageId: 'assistant_before_tool',
                },
              ],
            },
            {
              type: 'function_call_output_ref',
              callId: 'call_inspect',
              resultId: 'result_inspect',
            },
          ],
        },
        toolResults: [
          {
            callId: 'call_inspect',
            toolName: 'browser_inspect',
            argumentsJson: '{"tabId":0,"mode":"interactive"}',
            output: '{"ok":true}',
            resultId: 'result_inspect',
          },
        ],
        customSystemPrompt: '',
        historyMessageLimit: 50,
      },
      contextDependencies(messages, { get: vi.fn(async () => undefined) }),
    );

    expect(context.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Inspect the page.' }],
      },
      {
        type: 'reasoning',
        itemId: 'reasoning_inspect',
        encryptedContent: 'opaque-encrypted-content',
        summary: [{ type: 'summary_text', text: 'Inspect the active page.' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'I found the target and will inspect it.',
          },
        ],
      },
      {
        type: 'function_call',
        callId: 'call_inspect',
        name: 'browser_inspect',
        argumentsJson: '{"tabId":0,"mode":"interactive"}',
      },
      {
        type: 'function_call_output',
        callId: 'call_inspect',
        output: '{"ok":true}',
      },
    ]);
  });

  it('materializes a lightweight tool-result reference with its compact model output', async () => {
    const messages = [
      message({
        id: 'current',
        taskId: TASK.id,
        role: 'user',
        text: 'Inspect the page.',
      }),
    ];
    const context = await buildAgentContext(
      {
        task: TASK,
        checkpoint: {
          ...CHECKPOINT,
          continuationItems: [
            { type: 'message_ref', messageId: 'current' },
            {
              type: 'function_call',
              callId: 'call_inspect',
              name: 'browser_inspect',
              argumentsJson: '{"tabId":0,"mode":"interactive"}',
            },
            {
              type: 'function_call_output_ref',
              callId: 'call_inspect',
              resultId: 'result_inspect',
            },
          ],
        },
        toolResults: [
          {
            callId: 'call_inspect',
            toolName: 'browser_inspect',
            argumentsJson: '{"tabId":0,"mode":"interactive"}',
            output: '{"ok":true,"audit":"full"}',
            modelOutput: '{"ok":true}',
            resultId: 'result_inspect',
          },
        ],
        customSystemPrompt: '',
        historyMessageLimit: 50,
      },
      contextDependencies(messages, { get: vi.fn(async () => undefined) }),
    );

    expect(context.input.at(-1)).toEqual({
      type: 'function_call_output',
      callId: 'call_inspect',
      output: '{"ok":true}',
    });
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
              type: 'function_call_output_ref',
              callId: 'call_commit',
              resultId: 'result_commit',
              attachmentIds: [],
            },
            {
              type: 'function_call',
              callId: 'call_new_inspect',
              name: 'browser_inspect',
              argumentsJson: '{"mode":"screenshot"}',
            },
            {
              type: 'function_call_output_ref',
              callId: 'call_new_inspect',
              resultId: 'result_new_inspect',
              attachmentIds: ['new_screenshot'],
            },
          ],
        },
        toolResults: [
          {
            callId: 'call_old_inspect',
            toolName: 'browser_inspect',
            argumentsJson: '{}',
            output: 'old output',
            resultId: 'result_old_inspect',
            attachmentIds: ['old_screenshot'],
          },
          {
            callId: 'call_commit',
            toolName: 'commit_context',
            argumentsJson: commitArguments,
            output: commitOutput,
            resultId: 'result_commit',
            attachmentIds: [],
          },
          {
            callId: 'call_new_inspect',
            toolName: 'browser_inspect',
            argumentsJson: '{"mode":"screenshot"}',
            output: 'new output',
            resultId: 'result_new_inspect',
            attachmentIds: ['new_screenshot'],
          },
        ],
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
        checkpoint: {
          ...CHECKPOINT,
          continuationItems: [
            { type: 'message_ref', messageId: 'current' },
            {
              type: 'function_call',
              callId: 'call_done',
              name: 'lookup_record',
              argumentsJson: '{"type":"click"}',
            },
            {
              type: 'function_call_output_ref',
              callId: 'call_done',
              resultId: 'evidence_1',
            },
          ],
        },
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
        checkpoint: {
          ...CHECKPOINT,
          continuationItems: [{ type: 'message_ref', messageId: 'current' }],
        },
        toolResults: [],
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
          checkpoint: CHECKPOINT,
          toolResults: [],
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
          checkpoint: {
            ...CHECKPOINT,
            continuationItems: [{ type: 'message_ref', messageId: 'bad' }],
          },
          toolResults: [],
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
        checkpoint: {
          ...CHECKPOINT,
          continuationItems: [{ type: 'message_ref', messageId: 'full-batch' }],
        },
        toolResults: [],
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
        checkpoint: {
          ...CHECKPOINT,
          continuationItems: [{ type: 'message_ref', messageId: 'current' }],
        },
        toolResults: [],
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
        checkpoint: {
          ...CHECKPOINT,
          continuationItems: [{ type: 'message_ref', messageId: 'current' }],
        },
        toolResults: [],
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

  it('keeps 50 successful-history messages and replays one active task in exact order', async () => {
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
        taskId: TASK.id,
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
    const historicalTasks = historicalMessages.map((item, index): Task => ({
      ...TASK,
      id: item.taskId as string,
      ordinal: index + 1,
      status: 'completed',
      createdAt: index + 1,
      updatedAt: index + 1,
    }));
    const tasks: Task[] = [
      ...historicalTasks,
      {
        ...TASK,
        id: 'task_cancelled_only',
        status: 'cancelled',
      },
      TASK,
    ];
    const context = await buildAgentContext(
      {
        task: TASK,
        checkpoint: {
          ...CHECKPOINT,
          continuationItems: [
            { type: 'message_ref', messageId: 'active_initial' },
            {
              type: 'function_call',
              callId: 'call_1',
              name: 'tavily_search',
              argumentsJson: '{"query":"official"}',
            },
            {
              type: 'function_call_output_ref',
              callId: 'call_1',
              resultId: 'result_1',
            },
            { type: 'message_ref', messageId: 'supplement_1' },
            { type: 'message_ref', messageId: 'active_latest' },
          ],
        },
        toolResults: [
          {
            callId: 'call_1',
            toolName: 'tavily_search',
            argumentsJson: '{"query":"official"}',
            output: '{"ok":true}',
            resultId: 'result_1',
          },
        ],
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
        {
          listByConversation: vi.fn(async () => tasks),
          readTaskMessageEvents: vi.fn(async (taskIds) => taskEvents(messages, taskIds)),
        },
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

  it('separates completed history from active opaque compacted task input', async () => {
    const messages = [
      message({
        id: 'history_user',
        taskId: 'task_history',
        role: 'user',
        text: 'Earlier request',
      }),
      message({
        id: 'history_assistant',
        taskId: 'task_history',
        role: 'assistant',
        text: 'Earlier answer',
      }),
      message({
        id: 'active_user',
        taskId: TASK.id,
        role: 'user',
        text: 'Continue current work',
      }),
    ];
    const historyTask: Task = {
      ...TASK,
      id: 'task_history',
      status: 'completed',
    };
    const context = await buildAgentContext(
      {
        task: TASK,
        checkpoint: {
          ...CHECKPOINT,
          continuationItems: [
            { type: 'message_ref', messageId: 'active_user' },
            {
              type: 'compaction',
              itemId: 'cmp_1',
              encryptedContent: 'opaque-compacted-context',
            },
          ],
        },
        toolResults: [],
        customSystemPrompt: 'Stay bounded.',
        historyMessageLimit: 50,
      },
      contextDependencies(
        messages,
        { get: vi.fn(async () => undefined) },
        {
          listByConversation: vi.fn(async () => [historyTask, TASK]),
          readTaskMessageEvents: vi.fn(async (taskIds) => taskEvents(messages, taskIds)),
        },
      ),
    );

    expect(context.input).toHaveLength(4);
    expect(context.activeInput).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Continue current work' }],
      },
      {
        type: 'compaction',
        itemId: 'cmp_1',
        encryptedContent: 'opaque-compacted-context',
      },
    ]);
  });

  it('projects the full reply target outside the ordinary history limit with stable identifiers', async () => {
    const targetTask: Task = {
      ...TASK,
      id: 'task_reply_target',
      ordinal: 1,
      status: 'completed',
      latestRunId: 'run_reply_target',
    };
    const recentTask: Task = {
      ...TASK,
      id: 'task_recent',
      ordinal: 2,
      status: 'completed',
      latestRunId: 'run_recent',
    };
    const activeTask: Task = { ...TASK, ordinal: 3 };
    const targetAnswer = 'FULL TARGET ANSWER OUTSIDE THE TWO-MESSAGE HISTORY WINDOW';
    const target = message({
      id: 'reply_target',
      taskId: targetTask.id,
      role: 'assistant',
      text: targetAnswer,
      createdAt: 20,
    });
    const current = {
      ...message({
        id: 'current_reply',
        taskId: activeTask.id,
        role: 'user',
        text: 'Why is the second point necessary?',
        createdAt: 60,
      }),
      replyTo: {
        messageId: target.id,
        taskId: target.taskId,
        excerpt: target.text,
        attachmentCount: 0,
        createdAt: target.createdAt,
      },
    } as MessageRecord;
    const messages = [
      message({
        id: 'target_question',
        taskId: targetTask.id,
        role: 'user',
        text: 'Old question',
        createdAt: 10,
      }),
      target,
      message({
        id: 'recent_question',
        taskId: recentTask.id,
        role: 'user',
        text: 'Recent question',
        createdAt: 30,
      }),
      message({
        id: 'recent_answer',
        taskId: recentTask.id,
        role: 'assistant',
        text: 'Recent answer',
        createdAt: 40,
      }),
      current,
    ];
    const context = await buildAgentContext(
      {
        task: activeTask,
        checkpoint: {
          ...CHECKPOINT,
          continuationItems: [{ type: 'message_ref', messageId: current.id }],
        },
        toolResults: [],
        customSystemPrompt: '',
        historyMessageLimit: 2,
      },
      contextDependencies(
        messages,
        { get: vi.fn(async () => undefined) },
        {
          listByConversation: vi.fn(async () => [targetTask, recentTask, activeTask]),
          readTaskMessageEvents: vi.fn(async (taskIds) => taskEvents(messages, taskIds)),
        },
      ),
    );

    const activeMessage = context.activeInput[0];
    expect(activeMessage).toMatchObject({ type: 'message', role: 'user' });
    if (activeMessage?.type !== 'message') throw new Error('Active reply message is missing.');
    const projectedText = activeMessage.content
      .filter((item) => item.type === 'input_text')
      .map((item) => item.text)
      .join('\n');
    expect(projectedText).toContain(targetAnswer);
    expect(projectedText).toContain(`"targetTaskId":"${targetTask.id}"`);
    expect(projectedText).toContain(`"targetMessageId":"${target.id}"`);
    expect(projectedText).not.toContain('historyTaskOffset');
    expect(projectedText).not.toContain('availableHistoryTaskCount');
    expect(projectedText).toContain('Why is the second point necessary?');
    expect(JSON.stringify(context.input).match(new RegExp(targetAnswer, 'g'))).toHaveLength(1);
  });
});
