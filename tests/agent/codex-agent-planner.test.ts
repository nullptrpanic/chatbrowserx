import { describe, expect, it, vi } from 'vitest';
import { CodexAgentPlanner } from '../../src/agent/codex-agent-planner';
import type { AgentPlanInput } from '../../src/agent/execution-types';
import type { AttachmentRepository } from '../../src/persistence/attachment-repository';
import type { ConversationRepository } from '../../src/persistence/conversation-repository';
import type { CredentialStore } from '../../src/persistence/credential-store';
import type { SettingsStore } from '../../src/persistence/settings-store';
import type { TaskRepository } from '../../src/persistence/task-repository';
import { CodexProvider } from '../../src/providers/codex/codex-provider';
import { providerErrorFromCode } from '../../src/providers/provider-errors';
import type { ModelProvider, ModelRequest } from '../../src/providers/provider-types';
import type { ModelStreamEvent } from '../../src/providers/stream-events';
import type { Checkpoint } from '../../src/tasks/checkpoint-types';
import type { MessageRecord } from '../../src/tasks/message-types';
import type { TaskRun } from '../../src/tasks/task-types';

const TASK: TaskRun = {
  id: 'task_1',
  workSessionId: 'workSession_1',
  conversationId: 'conversation_1',
  tabId: 7,
  goal: 'Continue checkout',
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
  sequence: 1,
  taskStatus: 'planning',
  completedToolResults: [],
  continuationItems: [],
  pendingToolCall: null,
  createdAt: 200,
};

const PLAN_INPUT: AgentPlanInput = {
  task: TASK,
  checkpoint: CHECKPOINT,
};

const USER_MESSAGE: MessageRecord = {
  id: 'message_user',
  kind: 'conversation',
  conversationId: 'conversation_1',
  taskId: 'task_1',
  role: 'user',
  status: 'complete',
  text: 'Continue checkout',
  attachmentIds: [],
  createdAt: 100,
  updatedAt: 100,
};

/** Creates an injected Provider stream and captures its normalized request. */
function provider(events: () => AsyncGenerator<ModelStreamEvent>): {
  readonly instance: ModelProvider;
  readonly requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  return {
    requests,
    instance: {
      stream(request) {
        requests.push(request);
        return events();
      },
    },
  };
}

/** Builds an inert token accepted by the real Codex Provider boundary. */
function syntheticAccessToken(): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_planner_test' },
  })}.`;
}

/** Creates the real Provider adapter around a deterministic Responses SSE stream. */
function responsesProvider(
  events: readonly { readonly event: string; readonly data: unknown }[],
): ModelProvider {
  const credentials: CredentialStore = {
    initialize: vi.fn(async () => undefined),
    getCodexAccessToken: vi.fn(async () => syntheticAccessToken()),
    setCodexAccessToken: vi.fn(async () => undefined),
    getTavilyKey: vi.fn(async () => undefined),
    setTavilyKey: vi.fn(async () => undefined),
    getSandboxToken: vi.fn(async () => undefined),
    setSandboxToken: vi.fn(async () => undefined),
  };
  const body = `${events
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('')}data: [DONE]\n\n`;
  return new CodexProvider(
    credentials,
    vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    ),
  );
}

/** Creates storage ports and returns the message writes for assertions. */
function repositories(existingMessages: readonly MessageRecord[] = []): {
  readonly conversations: ConversationRepository;
  readonly attachments: AttachmentRepository;
  readonly tasks: Pick<TaskRepository, 'listByConversation'>;
  readonly messages: MessageRecord[];
  readonly listMessages: ReturnType<typeof vi.fn>;
  readonly listTasks: ReturnType<typeof vi.fn>;
  readonly appendMessage: ReturnType<typeof vi.fn>;
  readonly updateMessage: ReturnType<typeof vi.fn>;
} {
  const messages = [USER_MESSAGE, ...existingMessages];
  const listMessages = vi.fn(async () => [...messages]);
  const listTasks = vi.fn(async () => [TASK]);
  const appendMessage = vi.fn(async (message: MessageRecord) => {
    messages.push(message);
  });
  const updateMessage = vi.fn(async (message: MessageRecord) => {
    const index = messages.findIndex(({ id }) => id === message.id);
    if (index < 0) throw new Error('Message does not exist.');
    messages[index] = message;
  });
  return {
    messages,
    listMessages,
    listTasks,
    appendMessage,
    updateMessage,
    conversations: {
      get: vi.fn(async () => undefined),
      listAll: vi.fn(async () => []),
      listMessages,
      appendMessage,
      appendSupplement: vi.fn(async () => undefined),
      updateMessage,
      clearConversation: vi.fn(async () => undefined),
    },
    attachments: {
      put: vi.fn(),
      get: vi.fn(async () => undefined),
      addReference: vi.fn(async () => undefined),
      removeReference: vi.fn(async () => undefined),
      deleteUnreferenced: vi.fn(async () => 0),
    },
    tasks: {
      listByConversation: listTasks,
    },
  };
}

/** Creates fixed settings without exposing configurable Provider endpoints. */
function settings(): SettingsStore {
  return {
    get: vi.fn(async () => ({
      model: 'ignored-model-setting',
      reasoningEffort: 'medium' as const,
      systemPrompt: 'Custom safe preference.',
      language: 'system' as const,
      historyMessageLimit: 50,
    })),
    save: vi.fn(async () => undefined),
    reset: vi.fn(async () => ({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium' as const,
      systemPrompt: '',
      language: 'system' as const,
      historyMessageLimit: 50,
    })),
  };
}

/** Collects planner events from one model turn. */
async function collect(
  planner: CodexAgentPlanner,
  signal = new AbortController().signal,
  input = PLAN_INPUT,
) {
  const events = [];
  for await (const event of planner.plan(input, signal)) events.push(event);
  return events;
}

const SEARCH_ARGUMENTS = {
  query: 'browser reliability',
  searchDepth: 'advanced',
  topic: 'general',
  timeRange: 'month',
  maxResults: 5,
  includeDomains: [],
  excludeDomains: [],
} as const;

const BROWSER_TOOL_NAMES = [
  'browser_list_tabs',
  'browser_open_tab',
  'browser_switch_tab',
  'browser_close_tab',
  'browser_navigate',
  'browser_reload',
  'browser_inspect',
  'browser_capture_screenshot',
  'browser_click',
  'browser_set_checked',
  'browser_type',
  'browser_keypress',
  'browser_scroll',
  'browser_hover',
  'browser_select',
  'browser_drag',
  'browser_wait',
  'browser_network_start',
  'browser_network_list',
  'browser_network_get',
  'browser_network_stop',
] as const;

const CONFIGURED_TAVILY = { isConfigured: async () => true } as const;

describe('CodexAgentPlanner', () => {
  it('persists streamed text and completes a text-only turn', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_1' };
      yield { type: 'text.delta', delta: 'Checkout ' };
      yield { type: 'text.delta', delta: 'is ready.' };
      yield { type: 'response.completed', responseId: 'resp_1', usage: null };
    });
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: CONFIGURED_TAVILY,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });

    await expect(collect(planner)).resolves.toMatchObject([
      {
        type: 'task.completed',
        reason: 'model_response_completed',
        messageId: 'message_1',
        modelTurn: {
          inputItemCount: 1,
          elapsedMs: 0,
          firstEventMs: 0,
          firstTextMs: 0,
          usage: null,
        },
      },
    ]);
    expect(storage.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'message_1',
        status: 'streaming',
        text: '',
      }),
    );
    expect(storage.updateMessage).toHaveBeenCalledTimes(1);
    expect(storage.updateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'complete',
        text: 'Checkout is ready.',
      }),
    );
    expect(storage.listMessages).toHaveBeenCalledTimes(1);
    expect(storage.listTasks).toHaveBeenCalledTimes(1);
    expect(model.requests[0]).toMatchObject({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      systemPrompt: 'Custom safe preference.',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Continue checkout' }],
        },
      ],
    });
    expect(model.requests[0]).not.toHaveProperty('continuation');
    expect(model.requests[0]?.tools.map(({ name }) => name)).toEqual([
      ...BROWSER_TOOL_NAMES,
      'tavily_search',
      'tavily_extract',
      'tavily_crawl',
    ]);
  });

  it('checks Tavily availability before every request and omits Tavily tools when unavailable', async () => {
    let turn = 0;
    const model = provider(async function* () {
      turn += 1;
      const responseId = `resp_${turn}`;
      yield { type: 'response.started', responseId };
      yield { type: 'text.delta', delta: `Answer ${turn}` };
      yield { type: 'response.completed', responseId, usage: null };
    });
    const storage = repositories();
    const tavilyAvailability = {
      isConfigured: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
    };
    let id = 0;
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_${++id}` },
      clock: { now: () => 500 + id },
    });

    await collect(planner);
    await collect(planner);

    expect(tavilyAvailability.isConfigured).toHaveBeenCalledTimes(2);
    expect(model.requests[0]?.tools.map(({ name }) => name)).toEqual(BROWSER_TOOL_NAMES);
    expect(model.requests[1]?.tools.map(({ name }) => name)).toEqual([
      ...BROWSER_TOOL_NAMES,
      'tavily_search',
      'tavily_extract',
      'tavily_crawl',
    ]);
  });

  it('omits historical result tools when the current conversation has no terminal evidence', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_without_history_tools' };
      yield { type: 'text.delta', delta: 'No historical evidence.' };
      yield {
        type: 'response.completed',
        responseId: 'resp_without_history_tools',
        usage: null,
      };
    });
    const storage = repositories();
    const historicalResults = { hasEvidence: vi.fn(async () => false) };
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: { isConfigured: vi.fn(async () => false) },
      historicalResults,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_without_history` },
      clock: { now: () => 500 },
    });

    await collect(planner);

    expect(historicalResults.hasEvidence).toHaveBeenCalledWith({
      conversationId: 'conversation_1',
      currentTaskId: 'task_1',
    });
    expect(model.requests[0]?.tools.some(({ name }) => name.startsWith('task_result_'))).toBe(
      false,
    );
  });

  it('registers and parses historical result tools only when terminal evidence exists', async () => {
    const arguments_ = { evidenceId: 'toolResult_1', offset: 0, limit: 20_000 };
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_history_read' };
      yield { type: 'tool.started', callId: 'call_history_read', name: 'task_result_read' };
      yield {
        type: 'tool.completed',
        callId: 'call_history_read',
        name: 'task_result_read',
        argumentsJson: JSON.stringify(arguments_),
      };
      yield { type: 'response.completed', responseId: 'resp_history_read', usage: null };
    });
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: { isConfigured: vi.fn(async () => false) },
      historicalResults: { hasEvidence: vi.fn(async () => true) },
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_history` },
      clock: { now: () => 500 },
    });

    await expect(collect(planner)).resolves.toMatchObject([
      {
        type: 'task-result.call',
        call: {
          family: 'task_result',
          operation: 'read',
          replay: 'safe',
          callId: 'call_history_read',
          name: 'task_result_read',
          arguments: arguments_,
        },
      },
    ]);
    expect(model.requests[0]?.tools.map(({ name }) => name).slice(-2)).toEqual([
      'task_result_search',
      'task_result_read',
    ]);
  });

  it('keeps the exact current prompt and tools when Sandbox is not configured', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_without_sandbox' };
      yield { type: 'text.delta', delta: 'No Sandbox.' };
      yield { type: 'response.completed', responseId: 'resp_without_sandbox', usage: null };
    });
    const storage = repositories();
    const skillCatalog = { get: vi.fn(async () => null), invalidate: vi.fn(async () => undefined) };
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: CONFIGURED_TAVILY,
      skillCatalog,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_without_sandbox` },
      clock: { now: () => 500 },
    });

    await collect(planner);

    expect(skillCatalog.get).toHaveBeenCalledOnce();
    expect(model.requests[0]?.systemPrompt).toBe('Custom safe preference.');
    expect(model.requests[0]?.tools.map(({ name }) => name)).toEqual([
      ...BROWSER_TOOL_NAMES,
      'tavily_search',
      'tavily_extract',
      'tavily_crawl',
    ]);
  });

  it('appends a configured catalog, registers fixed tools, and parses Sandbox calls', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_sandbox' };
      yield { type: 'tool.started', callId: 'call_sandbox', name: 'sandbox_exec' };
      yield {
        type: 'tool.completed',
        callId: 'call_sandbox',
        name: 'sandbox_exec',
        argumentsJson: JSON.stringify({ command: 'bash scripts/run.sh', cwd: '/skills/example' }),
      };
      yield { type: 'response.completed', responseId: 'resp_sandbox', usage: null };
    });
    const storage = repositories();
    const skillCatalog = {
      get: vi.fn(async () => ({
        entries: [
          {
            name: 'example',
            description: 'Run the example workflow.',
            path: '/skills/example/SKILL.md',
          },
        ],
        truncated: false,
        refreshedAt: 500,
      })),
      invalidate: vi.fn(async () => undefined),
    };
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: CONFIGURED_TAVILY,
      skillCatalog,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_sandbox` },
      clock: { now: () => 500 },
    });

    await expect(collect(planner)).resolves.toMatchObject([
      {
        type: 'sandbox.call',
        call: {
          family: 'sandbox',
          operation: 'exec',
          replay: 'mutation',
          name: 'sandbox_exec',
        },
      },
    ]);
    expect(model.requests[0]?.tools.map(({ name }) => name).slice(-2)).toEqual([
      'sandbox_read',
      'sandbox_exec',
    ]);
    expect(model.requests[0]?.systemPrompt.startsWith('Custom safe preference.\n\n')).toBe(true);
    expect(model.requests[0]?.systemPrompt).toContain('Run the example workflow.');
  });

  it('replays the complete local WorkSession on every model turn', async () => {
    const continuationItems = [
      { type: 'message_ref' as const, messageId: USER_MESSAGE.id },
      {
        type: 'function_call' as const,
        callId: 'call_previous',
        name: 'browser_click',
        argumentsJson: '{"tabId":7,"ref":"page_1_1","button":"left","count":1}',
      },
      {
        type: 'function_call_output' as const,
        callId: 'call_previous',
        output: '{"ok":true}',
        resultRef: 'result_previous',
      },
    ];
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_next' };
      yield { type: 'text.delta', delta: 'Done.' };
      yield {
        type: 'response.completed',
        responseId: 'resp_next',
        usage: null,
      };
    });
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: { isConfigured: vi.fn(async () => false) },
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });

    await collect(planner, new AbortController().signal, {
      ...PLAN_INPUT,
      checkpoint: {
        ...CHECKPOINT,
        continuationItems,
      },
    });

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]).toMatchObject({
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Continue checkout' }],
        },
        {
          type: 'function_call',
          callId: 'call_previous',
          name: 'browser_click',
          argumentsJson: '{"tabId":7,"ref":"page_1_1","button":"left","count":1}',
        },
        {
          type: 'function_call_output',
          callId: 'call_previous',
          output: '{"ok":true}',
        },
      ],
    });
    expect(model.requests[0]).not.toHaveProperty('continuation');
  });

  it('never exposes the legacy context commit tool in new model requests', async () => {
    const model = provider(async function* () {
      yield {
        type: 'response.started',
        responseId: 'resp_without_legacy_commit',
      };
      yield { type: 'text.delta', delta: 'Continue without the legacy tool.' };
      yield {
        type: 'response.completed',
        responseId: 'resp_without_legacy_commit',
        usage: null,
      };
    });
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: { isConfigured: vi.fn(async () => false) },
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_without_legacy_commit` },
      clock: { now: () => 600 },
    });
    const continuationItems = [
      { type: 'message_ref' as const, messageId: USER_MESSAGE.id },
      ...Array.from({ length: 48 }, (_, index) => {
        const callId = `call_browser_${String(index + 1)}`;
        return [
          {
            type: 'function_call' as const,
            callId,
            name: 'browser_click',
            argumentsJson: JSON.stringify({ ref: `ref_${String(index + 1)}` }),
          },
          {
            type: 'function_call_output' as const,
            callId,
            output: 'x'.repeat(2_048),
            resultRef: `result_${String(index + 1)}`,
            attachmentIds: [],
          },
        ];
      }).flat(),
    ];

    await collect(planner, new AbortController().signal, {
      ...PLAN_INPUT,
      checkpoint: { ...CHECKPOINT, continuationItems },
    });

    expect(model.requests[0]?.toolChoice).toBeUndefined();
    expect(model.requests[0]?.tools.some(({ name }) => name === 'commit_context')).toBe(false);
  });

  it('emits one validated browser call in the common Agent loop', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_browser' };
      yield {
        type: 'tool.started',
        callId: 'call_browser',
        name: 'browser_list_tabs',
      };
      yield {
        type: 'tool.completed',
        callId: 'call_browser',
        name: 'browser_list_tabs',
        argumentsJson: '{}',
      };
      yield {
        type: 'response.completed',
        responseId: 'resp_browser',
        usage: null,
      };
    });
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: { isConfigured: vi.fn(async () => false) },
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });

    await expect(collect(planner)).resolves.toMatchObject([
      {
        type: 'browser.call',
        call: {
          family: 'browser',
          operation: 'list_tabs',
          replay: 'safe',
          callId: 'call_browser',
          name: 'browser_list_tabs',
          argumentsJson: '{}',
          arguments: {},
        },
      },
    ]);
  });

  it('attaches encrypted reasoning and same-turn assistant text to a tool continuation', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_continuation' };
      yield {
        type: 'reasoning.encrypted',
        itemId: 'reasoning_continuation',
        encryptedContent: 'opaque-encrypted-content',
        summary: [{ type: 'summary_text', text: 'Inspect the active page.' }],
      };
      yield { type: 'text.delta', delta: 'I will inspect the page.' };
      yield {
        type: 'tool.started',
        callId: 'call_inspect',
        name: 'browser_inspect',
      };
      yield {
        type: 'tool.completed',
        callId: 'call_inspect',
        name: 'browser_inspect',
        argumentsJson: '{"tabId":0,"mode":"interactive"}',
      };
      yield {
        type: 'response.completed',
        responseId: 'resp_continuation',
        usage: null,
      };
    });
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: { isConfigured: vi.fn(async () => false) },
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_continuation` },
      clock: { now: () => 500 },
    });

    await expect(collect(planner)).resolves.toMatchObject([
      {
        type: 'browser.call',
        modelOutputItems: [
          {
            type: 'reasoning',
            itemId: 'reasoning_continuation',
            encryptedContent: 'opaque-encrypted-content',
            summary: [{ type: 'summary_text', text: 'Inspect the active page.' }],
          },
          {
            type: 'assistant_message_ref',
            messageId: 'message_continuation',
          },
        ],
      },
    ]);
    expect(storage.updateMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'message_continuation',
        role: 'assistant',
        status: 'interrupted',
        text: 'I will inspect the page.',
      }),
    );
  });

  it('emits a bounded provider-authored reasoning summary before the turn outcome', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_reasoning' };
      yield {
        type: 'reasoning.summary',
        itemId: 'reasoning_1',
        summaryIndex: 0,
        text: `  ${'evidence '.repeat(3_000)}  `,
      };
      yield { type: 'text.delta', delta: 'Done.' };
      yield {
        type: 'response.completed',
        responseId: 'resp_reasoning',
        usage: null,
      };
    });
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: CONFIGURED_TAVILY,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });

    const events = await collect(planner);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'reasoning.summary' });
    expect(events[0]?.type === 'reasoning.summary' ? events[0].text : '').toHaveLength(20_000);
    expect(events[1]).toMatchObject({
      type: 'task.completed',
      reason: 'model_response_completed',
      messageId: 'message_1',
    });
  });

  it.each([
    ['tavily_search', SEARCH_ARGUMENTS, 'search'],
    [
      'tavily_extract',
      {
        urls: ['https://example.com/a'],
        query: 'authentication',
        extractDepth: 'basic',
      },
      'extract',
    ],
    [
      'tavily_crawl',
      {
        url: 'https://docs.example.com/',
        instructions: 'Find authentication docs.',
        maxDepth: 2,
        maxPages: 5,
      },
      'crawl',
    ],
  ] as const)(
    'returns one validated %s call without creating an empty assistant message',
    async (name, arguments_, operation) => {
      const argumentsJson = JSON.stringify(arguments_);
      const model = provider(async function* () {
        yield { type: 'response.started', responseId: 'resp_tool' };
        yield { type: 'tool.started', callId: 'call_1', name };
        yield {
          type: 'tool.arguments.delta',
          callId: 'call_1',
          delta: argumentsJson,
        };
        yield { type: 'tool.completed', callId: 'call_1', name, argumentsJson };
        yield {
          type: 'response.completed',
          responseId: 'resp_tool',
          usage: null,
        };
      });
      const storage = repositories();
      const planner = new CodexAgentPlanner({
        provider: model.instance,
        tavilyAvailability: CONFIGURED_TAVILY,
        settings: settings(),
        conversations: storage.conversations,
        tasks: storage.tasks,
        attachments: storage.attachments,
        ids: { create: (prefix) => `${prefix}_1` },
        clock: { now: () => 500 },
      });

      await expect(collect(planner)).resolves.toMatchObject([
        {
          type: 'tavily.call',
          operation,
          callId: 'call_1',
          argumentsJson,
          arguments: arguments_,
        },
      ]);
      expect(storage.appendMessage).not.toHaveBeenCalled();
      expect(storage.updateMessage).not.toHaveBeenCalled();
    },
  );

  it('replays completed Tavily results before persisting a later final response', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_final' };
      yield { type: 'text.delta', delta: 'The research is complete.' };
      yield {
        type: 'response.completed',
        responseId: 'resp_final',
        usage: null,
      };
    });
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: CONFIGURED_TAVILY,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });
    const argumentsJson = JSON.stringify(SEARCH_ARGUMENTS);

    await collect(planner, new AbortController().signal, {
      ...PLAN_INPUT,
      checkpoint: {
        ...CHECKPOINT,
        completedToolResults: [
          {
            callId: 'call_previous',
            toolName: 'tavily_search',
            argumentsJson,
            output: '{"ok":true,"results":[]}',
            resultRef: 'result_previous',
          },
        ],
      },
    });

    expect(model.requests[0]?.input.slice(-2)).toEqual([
      {
        type: 'function_call',
        callId: 'call_previous',
        name: 'tavily_search',
        argumentsJson,
      },
      {
        type: 'function_call_output',
        callId: 'call_previous',
        output: '{"ok":true,"results":[]}',
      },
    ]);
    expect(storage.updateMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'complete',
        text: 'The research is complete.',
      }),
    );
  });

  it('rejects visible content before the normalized response starts', async () => {
    const model = provider(async function* () {
      yield { type: 'text.delta', delta: 'Too early' };
      yield { type: 'response.started', responseId: 'resp_late_start' };
      yield {
        type: 'response.completed',
        responseId: 'resp_late_start',
        usage: null,
      };
    });
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: CONFIGURED_TAVILY,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });

    await expect(collect(planner)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      invalidResponseStage: 'model_turn',
    });
    expect(storage.appendMessage).not.toHaveBeenCalled();
  });

  it('rejects unsupported tool output without creating an empty assistant message', async () => {
    const invalidModel = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_invalid' };
      yield { type: 'tool.started', callId: 'call_bad', name: 'browser_eval' };
      yield {
        type: 'tool.completed',
        callId: 'call_bad',
        name: 'browser_eval',
        argumentsJson: '{"code":"document.cookie"}',
      };
      yield {
        type: 'response.completed',
        responseId: 'resp_invalid',
        usage: null,
      };
    });
    const invalidStorage = repositories();
    const invalidPlanner = new CodexAgentPlanner({
      provider: invalidModel.instance,
      tavilyAvailability: CONFIGURED_TAVILY,
      settings: settings(),
      conversations: invalidStorage.conversations,
      tasks: invalidStorage.tasks,
      attachments: invalidStorage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });

    await expect(collect(invalidPlanner)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      invalidResponseStage: 'tool_call',
    });
    expect(invalidStorage.appendMessage).not.toHaveBeenCalled();
    expect(invalidStorage.updateMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{secret-value'],
    ['invalid bounds', JSON.stringify({ ...SEARCH_ARGUMENTS, maxResults: 9 })],
  ])('rejects %s without echoing tool arguments', async (_label, argumentsJson) => {
    const model = provider(async function* () {
      yield {
        type: 'response.started',
        responseId: 'resp_invalid_arguments',
      };
      yield {
        type: 'tool.started',
        callId: 'call_bad',
        name: 'tavily_search',
      };
      yield {
        type: 'tool.completed',
        callId: 'call_bad',
        name: 'tavily_search',
        argumentsJson,
      };
      yield {
        type: 'response.completed',
        responseId: 'resp_invalid_arguments',
        usage: null,
      };
    });
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: CONFIGURED_TAVILY,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });

    let thrown: unknown;
    try {
      await collect(planner);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: 'INVALID_RESPONSE',
      invalidResponseStage: 'tool_call',
    });
    expect(String(thrown)).not.toContain('secret-value');
    expect(storage.appendMessage).not.toHaveBeenCalled();
  });

  it('rejects multiple calls in one model response', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_multiple' };
      for (const callId of ['call_1', 'call_2']) {
        yield { type: 'tool.started', callId, name: 'tavily_search' } as const;
        yield {
          type: 'tool.completed',
          callId,
          name: 'tavily_search',
          argumentsJson: JSON.stringify(SEARCH_ARGUMENTS),
        } as const;
      }
      yield {
        type: 'response.completed',
        responseId: 'resp_multiple',
        usage: null,
      };
    });
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: CONFIGURED_TAVILY,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });

    await expect(collect(planner)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      invalidResponseStage: 'model_turn',
    });
    expect(storage.appendMessage).not.toHaveBeenCalled();
  });

  it('keeps provisional text and accepts a following tool call from the real Provider', async () => {
    const argumentsJson = JSON.stringify(SEARCH_ARGUMENTS);
    const model = responsesProvider([
      {
        event: 'response.created',
        data: { type: 'response.created', response: { id: 'resp_mixed' } },
      },
      {
        event: 'response.output_text.delta',
        data: { type: 'response.output_text.delta', delta: 'I will search.' },
      },
      {
        event: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          item: {
            id: 'item_1',
            type: 'function_call',
            call_id: 'call_1',
            name: 'tavily_search',
            arguments: argumentsJson,
          },
        },
      },
      {
        event: 'response.completed',
        data: { type: 'response.completed', response: { id: 'resp_mixed' } },
      },
    ]);
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: model,
      tavilyAvailability: CONFIGURED_TAVILY,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });

    await expect(collect(planner)).resolves.toMatchObject([
      {
        type: 'tavily.call',
        operation: 'search',
        callId: 'call_1',
        argumentsJson,
        arguments: SEARCH_ARGUMENTS,
      },
    ]);
    expect(storage.updateMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'interrupted',
        text: 'I will search.',
      }),
    );
  });

  it('keeps text that follows a tool call from the real Provider', async () => {
    const argumentsJson = JSON.stringify(SEARCH_ARGUMENTS);
    const model = responsesProvider([
      {
        event: 'response.created',
        data: {
          type: 'response.created',
          response: { id: 'resp_tool_then_text' },
        },
      },
      {
        event: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          item: {
            id: 'item_tool_then_text',
            type: 'function_call',
            call_id: 'call_tool_then_text',
            name: 'tavily_search',
            arguments: argumentsJson,
          },
        },
      },
      {
        event: 'response.output_text.delta',
        data: {
          type: 'response.output_text.delta',
          delta: 'I will use the search result next.',
        },
      },
      {
        event: 'response.completed',
        data: {
          type: 'response.completed',
          response: { id: 'resp_tool_then_text' },
        },
      },
    ]);
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: model,
      tavilyAvailability: CONFIGURED_TAVILY,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });

    await expect(collect(planner)).resolves.toMatchObject([
      {
        type: 'tavily.call',
        operation: 'search',
        callId: 'call_tool_then_text',
        argumentsJson,
        arguments: SEARCH_ARGUMENTS,
      },
    ]);
    expect(storage.updateMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'interrupted',
        text: 'I will use the search result next.',
      }),
    );
  });

  it('persists a streamed refusal from the real Provider as a completed reply', async () => {
    const model = responsesProvider([
      {
        event: 'response.created',
        data: { type: 'response.created', response: { id: 'resp_refusal' } },
      },
      {
        event: 'response.refusal.delta',
        data: {
          type: 'response.refusal.delta',
          item_id: 'message_refusal',
          output_index: 0,
          content_index: 0,
          delta: 'I cannot help with that request.',
        },
      },
      {
        event: 'response.refusal.done',
        data: {
          type: 'response.refusal.done',
          item_id: 'message_refusal',
          output_index: 0,
          content_index: 0,
          refusal: 'I cannot help with that request.',
        },
      },
      {
        event: 'response.completed',
        data: { type: 'response.completed', response: { id: 'resp_refusal' } },
      },
    ]);
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: model,
      tavilyAvailability: CONFIGURED_TAVILY,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });

    await expect(collect(planner)).resolves.toMatchObject([
      {
        type: 'task.completed',
        reason: 'model_response_completed',
        messageId: 'message_1',
      },
    ]);
    expect(storage.updateMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'complete',
        text: 'I cannot help with that request.',
      }),
    );
  });

  it('keeps partial text retryable when the real Provider response is incomplete', async () => {
    const model = responsesProvider([
      {
        event: 'response.created',
        data: { type: 'response.created', response: { id: 'resp_incomplete' } },
      },
      {
        event: 'response.output_text.delta',
        data: { type: 'response.output_text.delta', delta: 'Partial answer' },
      },
      {
        event: 'response.incomplete',
        data: {
          type: 'response.incomplete',
          response: {
            id: 'resp_incomplete',
            status: 'incomplete',
            incomplete_details: { reason: 'max_tokens' },
          },
        },
      },
    ]);
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: model,
      tavilyAvailability: CONFIGURED_TAVILY,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });

    await expect(collect(planner)).rejects.toMatchObject({
      code: 'TRANSIENT',
      retryable: true,
    });
    expect(storage.updateMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'interrupted',
        text: 'Partial answer',
      }),
    );
  });

  it('marks aborted output interrupted', async () => {
    const abortedModel = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_aborted' };
      yield { type: 'text.delta', delta: 'partial' };
      throw providerErrorFromCode('ABORTED');
    });
    const abortedStorage = repositories();
    const abortedPlanner = new CodexAgentPlanner({
      provider: abortedModel.instance,
      tavilyAvailability: CONFIGURED_TAVILY,
      settings: settings(),
      conversations: abortedStorage.conversations,
      tasks: abortedStorage.tasks,
      attachments: abortedStorage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });

    await expect(collect(abortedPlanner)).rejects.toMatchObject({
      code: 'ABORTED',
    });
    expect(abortedStorage.updateMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'interrupted', text: 'partial' }),
    );
  });

  it("reuses a prior worker's stale streaming message for the replacement turn", async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_recovery' };
      yield { type: 'text.delta', delta: 'Recovered' };
      yield {
        type: 'response.completed',
        responseId: 'resp_recovery',
        usage: null,
      };
    });
    const storage = repositories([
      {
        id: 'message_abandoned',
        kind: 'conversation',
        conversationId: 'conversation_1',
        taskId: 'task_1',
        role: 'assistant',
        status: 'streaming',
        text: 'partial from old worker',
        attachmentIds: [],
        createdAt: 300,
        updatedAt: 300,
      },
    ]);
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: CONFIGURED_TAVILY,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_replacement` },
      clock: { now: () => 500 },
    });

    await collect(planner);

    expect(storage.updateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'message_abandoned',
        status: 'interrupted',
        text: 'partial from old worker',
      }),
    );
    expect(storage.updateMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'message_abandoned',
        status: 'complete',
        text: 'Recovered',
      }),
    );
    expect(storage.appendMessage).not.toHaveBeenCalled();
    expect(storage.messages.filter(({ role }) => role === 'assistant')).toEqual([
      expect.objectContaining({
        id: 'message_abandoned',
        status: 'complete',
        text: 'Recovered',
      }),
    ]);
  });

  it('reuses the interrupted reply when a paused task continues', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_resumed' };
      yield { type: 'text.delta', delta: 'Fresh answer after resume.' };
      yield {
        type: 'response.completed',
        responseId: 'resp_resumed',
        usage: null,
      };
    });
    const storage = repositories([
      {
        id: 'message_paused',
        kind: 'conversation',
        conversationId: 'conversation_1',
        taskId: 'task_1',
        role: 'assistant',
        status: 'interrupted',
        text: 'Partial answer before pause.',
        attachmentIds: [],
        createdAt: 300,
        updatedAt: 400,
      },
    ]);
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: CONFIGURED_TAVILY,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_replacement` },
      clock: { now: () => 500 },
    });

    await collect(planner);

    expect(storage.appendMessage).not.toHaveBeenCalled();
    expect(storage.messages.filter(({ role }) => role === 'assistant')).toEqual([
      expect.objectContaining({
        id: 'message_paused',
        status: 'complete',
        text: 'Fresh answer after resume.',
      }),
    ]);
  });

  it('reuses an uncheckpointed complete reply when pause wins the completion race', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_pause_race' };
      yield { type: 'text.delta', delta: 'Replacement after pause.' };
      yield {
        type: 'response.completed',
        responseId: 'resp_pause_race',
        usage: null,
      };
    });
    const storage = repositories([
      {
        id: 'message_pause_race',
        kind: 'conversation',
        conversationId: 'conversation_1',
        taskId: 'task_1',
        role: 'assistant',
        status: 'complete',
        text: 'Completed locally before the pause checkpoint.',
        attachmentIds: [],
        createdAt: 300,
        updatedAt: 400,
      },
    ]);
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: CONFIGURED_TAVILY,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_replacement` },
      clock: { now: () => 500 },
    });

    await collect(planner);

    expect(storage.appendMessage).not.toHaveBeenCalled();
    expect(storage.messages.filter(({ role }) => role === 'assistant')).toEqual([
      expect.objectContaining({
        id: 'message_pause_race',
        status: 'complete',
        text: 'Replacement after pause.',
      }),
    ]);
  });

  it('marks retryable partial Provider output interrupted instead of a terminal message error', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_retryable' };
      yield { type: 'text.delta', delta: 'Partial answer' };
      throw providerErrorFromCode('TRANSIENT');
    });
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: CONFIGURED_TAVILY,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_retryable` },
      clock: { now: () => 500 },
    });

    await expect(collect(planner)).rejects.toMatchObject({ code: 'TRANSIENT' });
    expect(storage.updateMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'interrupted',
        text: 'Partial answer',
      }),
    );
  });

  it('uses native compaction before another model stream at the token high-water mark', async () => {
    const compact = vi.fn<NonNullable<ModelProvider['compact']>>(async () => ({
      itemId: 'cmp_native',
      encryptedContent: 'opaque-native-context',
    }));
    const stream = vi.fn<ModelProvider['stream']>(() => {
      throw new Error('stream must not run before compaction is persisted');
    });
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: { compact, stream },
      tavilyAvailability: CONFIGURED_TAVILY,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_compact` },
      clock: { now: () => 500 },
    });
    const input: AgentPlanInput = {
      task: TASK,
      checkpoint: {
        ...CHECKPOINT,
        lastModelInputTokens: 220_000,
        completedToolResults: [
          {
            callId: 'call_inspect',
            toolName: 'browser_inspect',
            argumentsJson: '{"tabId":7,"mode":"interactive"}',
            output: '{"ok":true}',
            resultRef: 'result_inspect',
          },
        ],
        continuationItems: [
          { type: 'message_ref', messageId: USER_MESSAGE.id },
          {
            type: 'function_call',
            callId: 'call_inspect',
            name: 'browser_inspect',
            argumentsJson: '{"tabId":7,"mode":"interactive"}',
          },
          {
            type: 'function_call_output',
            callId: 'call_inspect',
            output: '{"ok":true}',
            resultRef: 'result_inspect',
          },
        ],
      },
    };

    await expect(collect(planner, new AbortController().signal, input)).resolves.toEqual([
      {
        type: 'context.compacted',
        continuationItems: [
          { type: 'message_ref', messageId: USER_MESSAGE.id },
          {
            type: 'compaction',
            itemId: 'cmp_native',
            encryptedContent: 'opaque-native-context',
          },
        ],
      },
    ]);
    expect(stream).not.toHaveBeenCalled();
    expect(compact).toHaveBeenCalledOnce();
    expect(compact.mock.calls[0]?.[0].input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Continue checkout' }],
      },
      expect.objectContaining({
        type: 'function_call',
        callId: 'call_inspect',
      }),
      expect.objectContaining({
        type: 'function_call_output',
        callId: 'call_inspect',
      }),
    ]);
  });

  it('forces inspection before compaction or final text while a virtualized scroll is incomplete', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_forced_inspect' };
      yield {
        type: 'tool.started',
        callId: 'call_forced_inspect',
        name: 'browser_inspect',
      };
      yield {
        type: 'tool.completed',
        callId: 'call_forced_inspect',
        name: 'browser_inspect',
        argumentsJson: JSON.stringify({
          tabId: 0,
          mode: 'interactive',
          since: 'snapshot_before_scroll',
        }),
      };
      yield {
        type: 'response.completed',
        responseId: 'resp_forced_inspect',
        usage: null,
      };
    });
    const compact = vi.fn<NonNullable<ModelProvider['compact']>>(async () => ({
      itemId: 'cmp_unfinished_scroll',
      encryptedContent: 'opaque-unfinished-scroll',
    }));
    const storage = repositories();
    const skillCatalog = {
      get: vi.fn(async () => ({ entries: [], truncated: false, refreshedAt: 500 })),
      invalidate: vi.fn(async () => undefined),
    };
    const planner = new CodexAgentPlanner({
      provider: { ...model.instance, compact },
      tavilyAvailability: CONFIGURED_TAVILY,
      skillCatalog,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_forced_inspect` },
      clock: { now: () => 500 },
    });
    const input: AgentPlanInput = {
      task: TASK,
      checkpoint: {
        ...CHECKPOINT,
        lastModelInputTokens: 220_000,
        continuationItems: [
          { type: 'message_ref', messageId: USER_MESSAGE.id },
          {
            type: 'function_call',
            callId: 'call_incomplete_scroll',
            name: 'browser_scroll',
            argumentsJson: JSON.stringify({
              tabId: 0,
              target: 'ref_history',
              deltaX: 0,
              deltaY: -10_000,
            }),
          },
          {
            type: 'function_call_output',
            callId: 'call_incomplete_scroll',
            output: JSON.stringify({
              ok: true,
              tabId: 7,
              data: {
                action: 'scroll',
                requestedDeltaApplied: false,
                remainingDeltaX: 0,
                remainingDeltaY: -9_035,
                loadedMore: true,
                boundaryVerified: false,
              },
            }),
            resultRef: 'result_incomplete_scroll',
          },
        ],
      },
    };

    await expect(collect(planner, new AbortController().signal, input)).resolves.toMatchObject([
      {
        type: 'browser.call',
        call: { name: 'browser_inspect', operation: 'inspect' },
      },
    ]);

    expect(compact).not.toHaveBeenCalled();
    expect(skillCatalog.get).not.toHaveBeenCalled();
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.toolChoice).toEqual({
      type: 'function',
      name: 'browser_inspect',
    });
    expect(model.requests[0]?.tools.map(({ name }) => name)).toEqual(['browser_inspect']);
    expect(model.requests[0]?.tools[0]?.parameters).toMatchObject({
      properties: {
        tabId: { enum: [0] },
        mode: { enum: ['interactive'] },
      },
    });
  });
});
