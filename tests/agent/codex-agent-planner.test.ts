import { describe, expect, it, vi } from 'vitest';
import {
  ModelTurnPlanner,
  type ModelTurnPlannerDependencies,
} from '../../src/agent/model/model-turn-planner';
import type { AgentPlanInput } from '../../src/agent/execution-types';
import type { AttachmentRepository } from '../../src/persistence/attachment-repository';
import type { ConversationRepository } from '../../src/persistence/conversation-repository';
import type { CredentialStore } from '../../src/persistence/credential-store';
import type { SettingsStore } from '../../src/persistence/settings-store';
import type { TaskRepository } from '../../src/persistence/task-repository';
import { CodexProvider } from '../../src/providers/codex/codex-provider';
import { CODEX_MODEL } from '../../src/providers/codex/codex-constants';
import { providerErrorFromCode } from '../../src/agent/model/model-provider-error';
import type { ModelProviderPort, ModelRequest } from '../../src/agent/model/model-provider';
import type { ModelStreamEvent } from '../../src/agent/model/model-stream-event';
import type { Checkpoint } from '../../src/tasks/checkpoint-types';
import type { MessageRecord } from '../../src/tasks/message-types';
import type { Task, TaskEvent } from '../../src/tasks/task-types';
import type { MaterializedToolResult } from '../../src/tasks/tool-result-types';
import { bindToolRuntime } from '../../src/tools/registry';
import { discoverTools } from '../../src/tools/discover';
import { ToolServiceResolver } from '../../src/tools/service-resolver';
import { tavilyService } from '../../src/tools/tavily/service';
import { createSandboxToolService, sandboxService } from '../../src/tools/sandbox/service';
import { historyService } from '../../src/tools/history/service';
import type { SandboxExecutionPort } from '../../src/sandbox/sandbox-tool-executor';

const TASK: Task = {
  id: 'task_1',
  conversationId: 'conversation_1',
  ordinal: 1,
  tabId: 7,
  goal: 'Continue checkout',
  status: 'planning',
  latestRunId: 'run_1',
  lastEventSequence: 1,
  createdAt: 100,
  updatedAt: 200,
};

const HISTORICAL_TASK: Task = {
  id: 'task_0',
  conversationId: TASK.conversationId,
  ordinal: 0,
  tabId: 7,
  goal: 'Inspect the previous page',
  status: 'completed',
  latestRunId: 'run_0',
  lastEventSequence: 0,
  createdAt: 50,
  updatedAt: 75,
};

const CHECKPOINT: Checkpoint = {
  id: 'checkpoint_1',
  taskId: 'task_1',
  runId: 'run_1',
  continuationItems: [{ type: 'message_ref', messageId: 'message_user' }],
  pendingToolCall: null,
  browserToolCallsInAttempt: 0,
  browserTargetTabId: 7,
  createdAt: 200,
};

const TASK_BROWSER_BINDING_TEXT =
  'Task browser binding (trusted runtime context): this task has a current tab binding. For task-page tools, use tabId 0.';

const PLAN_INPUT: AgentPlanInput = {
  task: TASK,
  events: [
    {
      id: 'event_message_user',
      taskId: TASK.id,
      runId: 'run_1',
      sequence: 1,
      at: 100,
      type: 'message.recorded',
      messageId: 'message_user',
    },
  ],
  checkpoint: CHECKPOINT,
  toolResults: [],
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

/** Injects the fixed test model while exercising the provider-neutral planner implementation. */
type TestPlannerDependencies = Omit<ModelTurnPlannerDependencies, 'model' | 'tools'> & {
  readonly tavilyAvailability: { isConfigured(): Promise<boolean> };
  readonly sandbox?: SandboxExecutionPort;
};

class CodexAgentPlanner extends ModelTurnPlanner {
  constructor(dependencies: TestPlannerDependencies) {
    const { tavilyAvailability, sandbox, ...plannerDependencies } = dependencies;
    const services = new ToolServiceResolver();
    services.bind(tavilyService, {
      isConfigured: () => tavilyAvailability.isConfigured(),
      search: async () => ({ results: [], truncated: false }),
      extract: async () => ({ results: [], truncated: false }),
      crawl: async () => ({ results: [], truncated: false }),
    });
    if (sandbox !== undefined) {
      services.bind(sandboxService, createSandboxToolService(sandbox));
    }
    services.bind(historyService, {
      readHistory: async () => ({
        ok: false,
        code: 'HISTORY_NOT_FOUND',
        message: 'not used',
        retryable: false,
      }),
      readDetail: async () => ({
        ok: false,
        code: 'DETAIL_NOT_FOUND',
        message: 'not used',
        retryable: false,
      }),
      readResult: async () => ({
        ok: false,
        code: 'RESULT_NOT_FOUND',
        message: 'not used',
        retryable: false,
      }),
    });
    super({
      ...plannerDependencies,
      model: CODEX_MODEL,
      tools: bindToolRuntime(discoverTools(), services),
    });
  }
}

/** Builds the permanent process order expected by a direct planner invocation. */
function planInputFor(messages: readonly MessageRecord[]): AgentPlanInput {
  const taskMessages = messages.filter(
    (message) => message.taskId === TASK.id && message.kind === 'conversation',
  );
  const events = taskMessages.map((message, index): TaskEvent => ({
    id: `event_${message.id}`,
    taskId: TASK.id,
    runId: 'run_1',
    sequence: index + 1,
    at: message.createdAt,
    type: 'message.recorded',
    messageId: message.id,
  }));
  return {
    ...PLAN_INPUT,
    task: { ...TASK, lastEventSequence: events.length },
    events,
  };
}

/** Creates one canonical completed tool result for planner replay tests. */
function completedResult(
  input: Pick<MaterializedToolResult, 'callId' | 'toolName' | 'argumentsJson' | 'output'> & {
    readonly resultId: string;
  },
): MaterializedToolResult {
  return {
    id: input.resultId,
    taskId: TASK.id,
    runId: 'run_1',
    callId: input.callId,
    toolName: input.toolName,
    argumentsJson: input.argumentsJson,
    output: input.output,
    attachmentIds: [],
    createdAt: 150,
  };
}

/** Creates an injected Provider stream and captures its normalized request. */
function provider(events: () => AsyncGenerator<ModelStreamEvent>): {
  readonly instance: ModelProviderPort;
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

/** Returns the Sandbox discovery envelope consumed by the hidden Skill loader. */
function sandboxWithSkills(
  entries: readonly Readonly<{ name: string; description: string; path: string }>[],
): SandboxExecutionPort & { readonly execute: ReturnType<typeof vi.fn> } {
  const stdout = [
    ...entries.flatMap(({ name, description, path }) => [
      path,
      `name: ${name}\ndescription: ${JSON.stringify(description)}`,
    ]),
    '__CHATBROWSERX_SCAN_END__',
    '0',
    '',
  ].join('\0');
  return {
    execute: vi.fn(async () => JSON.stringify({ code: 0, stdout, stderr: '', truncated: false })),
    recover: async () => ({ status: 'not_found' }),
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
): ModelProviderPort {
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
function repositories(
  existingMessages: readonly MessageRecord[] = [],
  historicalTasks: readonly Task[] = [],
): {
  readonly conversations: ConversationRepository;
  readonly attachments: AttachmentRepository;
  readonly tasks: Pick<
    TaskRepository,
    'listByConversation' | 'readTaskMessageEvents' | 'appendTaskMessage'
  >;
  readonly messages: MessageRecord[];
  readonly listMessages: ReturnType<typeof vi.fn>;
  readonly listTasks: ReturnType<typeof vi.fn>;
  readonly appendTaskMessage: ReturnType<typeof vi.fn>;
  readonly updateMessage: ReturnType<typeof vi.fn>;
} {
  const messages = [USER_MESSAGE, ...existingMessages];
  const listMessages = vi.fn(async () => [...messages]);
  const listTasks = vi.fn(async () => [...historicalTasks, TASK]);
  const readTaskMessageEvents = vi.fn(async () => [] as TaskEvent[]);
  const appendTaskMessage = vi.fn(async ({ message }: { message: MessageRecord }) => {
    messages.push(message);
    return {
      id: `event_${message.id}`,
      taskId: TASK.id,
      runId: 'run_1',
      sequence: TASK.lastEventSequence + 1,
      type: 'message.recorded',
      messageId: message.id,
      at: message.createdAt,
    } satisfies TaskEvent;
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
    appendTaskMessage,
    updateMessage,
    conversations: {
      get: vi.fn(async () => undefined),
      listAll: vi.fn(async () => []),
      listMessages,
      listRecentMessages: vi.fn(async (_conversationId: string, limit: number) =>
        messages.slice(-limit),
      ),
      listTaskMessages: vi.fn(async (taskId: string) =>
        messages.filter((message) => message.taskId === taskId),
      ),
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
      readTaskMessageEvents,
      appendTaskMessage,
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

const FIRST_TURN_BROWSER_TOOL_NAMES = [
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
] as const;

const CONFIGURED_TAVILY = { isConfigured: async () => true } as const;

describe('CodexAgentPlanner', () => {
  it('prepares the tool contract and message context concurrently', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_parallel_prepare' };
      yield { type: 'text.delta', delta: 'Ready.' };
      yield { type: 'response.completed', responseId: 'resp_parallel_prepare', usage: null };
    });
    const storage = repositories();
    storage.messages[0] = { ...USER_MESSAGE, attachmentIds: ['attachment_parallel'] };
    let resolveDiscovery: ((output: string) => void) | undefined;
    const discovery = new Promise<string>((resolve) => {
      resolveDiscovery = resolve;
    });
    const sandbox: SandboxExecutionPort = {
      execute: vi.fn(() => discovery),
      recover: async () => ({ status: 'not_found' }),
    };
    const attachmentGet = vi.fn(async () => ({
      id: 'attachment_parallel',
      blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      mimeType: 'image/png',
      byteSize: 1,
      width: 1,
      height: 1,
      source: 'file' as const,
      createdAt: 100,
    }));
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: CONFIGURED_TAVILY,
      sandbox,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: { ...storage.attachments, get: attachmentGet },
      ids: { create: (prefix) => `${prefix}_parallel` },
      clock: { now: () => 500 },
    });

    const running = collect(planner);
    await vi.waitFor(() => expect(sandbox.execute).toHaveBeenCalledOnce());
    await Promise.resolve();
    const contextStartedBeforeContractSettled = attachmentGet.mock.calls.length > 0;
    resolveDiscovery?.(
      JSON.stringify({
        code: 0,
        stdout: '__CHATBROWSERX_SCAN_END__\0\0',
        stderr: '',
        truncated: false,
      }),
    );
    await running;

    expect(contextStartedBeforeContractSettled).toBe(true);
  });

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
    expect(storage.appendTaskMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          id: 'message_1',
          status: 'streaming',
          text: '',
        }),
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
          content: [
            { type: 'input_text', text: 'Continue checkout' },
            { type: 'input_text', text: TASK_BROWSER_BINDING_TEXT },
          ],
        },
      ],
    });
    expect(model.requests[0]).not.toHaveProperty('continuation');
    expect(model.requests[0]?.tools.map(({ name }) => name)).toEqual([
      ...FIRST_TURN_BROWSER_TOOL_NAMES,
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
    await collect(planner, new AbortController().signal, planInputFor(storage.messages));

    expect(tavilyAvailability.isConfigured).toHaveBeenCalledTimes(2);
    expect(model.requests[0]?.tools.map(({ name }) => name)).toEqual([
      ...FIRST_TURN_BROWSER_TOOL_NAMES,
    ]);
    expect(model.requests[1]?.tools.map(({ name }) => name)).toEqual([
      ...FIRST_TURN_BROWSER_TOOL_NAMES,
      'tavily_search',
      'tavily_extract',
      'tavily_crawl',
    ]);
  });

  it('registers bounded history tools only when a readable historical task exists', async () => {
    const model = provider(async function* () {
      yield {
        type: 'response.started',
        responseId: 'resp_without_history_tools',
      };
      yield { type: 'text.delta', delta: 'No historical evidence.' };
      yield {
        type: 'response.completed',
        responseId: 'resp_without_history_tools',
        usage: null,
      };
    });
    const storage = repositories([], [HISTORICAL_TASK]);
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: { isConfigured: vi.fn(async () => false) },
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_without_history` },
      clock: { now: () => 500 },
    });

    await collect(planner);

    expect(model.requests[0]?.tools.map(({ name }) => name).slice(-3)).toEqual([
      'history_read',
      'history_detail_read',
      'result_read',
    ]);
  });

  it('parses exact task history selectors using a stable task identifier', async () => {
    const arguments_ = {
      taskId: 'task_historical',
      offset: null,
      cursor: '',
      limit: 50,
    };
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_task_history' };
      yield {
        type: 'tool.started',
        callId: 'call_task_history',
        name: 'history_read',
      };
      yield {
        type: 'tool.completed',
        callId: 'call_task_history',
        name: 'history_read',
        argumentsJson: JSON.stringify(arguments_),
      };
      yield {
        type: 'response.completed',
        responseId: 'resp_task_history',
        usage: null,
      };
    });
    const storage = repositories([], [HISTORICAL_TASK]);
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: { isConfigured: vi.fn(async () => false) },
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_task_history` },
      clock: { now: () => 500 },
    });

    await expect(collect(planner)).resolves.toMatchObject([
      {
        type: 'tool.call',
        call: {
          name: 'history_read',
          arguments: arguments_,
        },
      },
    ]);
  });

  it('parses result history calls using a stable result identifier', async () => {
    const arguments_ = { resultId: 'toolResult_1', offset: 0, limit: 20_000 };
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_history_read' };
      yield {
        type: 'tool.started',
        callId: 'call_history_read',
        name: 'result_read',
      };
      yield {
        type: 'tool.completed',
        callId: 'call_history_read',
        name: 'result_read',
        argumentsJson: JSON.stringify(arguments_),
      };
      yield {
        type: 'response.completed',
        responseId: 'resp_history_read',
        usage: null,
      };
    });
    const storage = repositories([], [HISTORICAL_TASK]);
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: { isConfigured: vi.fn(async () => false) },
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_history` },
      clock: { now: () => 500 },
    });

    await expect(collect(planner)).resolves.toMatchObject([
      {
        type: 'tool.call',
        call: {
          callId: 'call_history_read',
          name: 'result_read',
          arguments: arguments_,
        },
      },
    ]);
    expect(model.requests[0]?.tools.map(({ name }) => name).slice(-3)).toEqual([
      'history_read',
      'history_detail_read',
      'result_read',
    ]);
  });

  it('sends only the custom prompt when Sandbox Skills are unavailable', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_without_sandbox' };
      yield { type: 'text.delta', delta: 'No Sandbox.' };
      yield {
        type: 'response.completed',
        responseId: 'resp_without_sandbox',
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
      ids: { create: (prefix) => `${prefix}_without_sandbox` },
      clock: { now: () => 500 },
    });

    await collect(planner);

    expect(model.requests[0]?.systemPrompt).toBe('Custom safe preference.');
    expect(model.requests[0]?.tools.map(({ name }) => name)).toEqual([
      ...FIRST_TURN_BROWSER_TOOL_NAMES,
      'tavily_search',
      'tavily_extract',
      'tavily_crawl',
    ]);
  });

  it('adds all available Sandbox Skills to the custom prompt', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_sandbox' };
      yield {
        type: 'tool.started',
        callId: 'call_sandbox',
        name: 'sandbox_exec',
      };
      yield {
        type: 'tool.completed',
        callId: 'call_sandbox',
        name: 'sandbox_exec',
        argumentsJson: JSON.stringify({
          command: 'bash scripts/run.sh',
          cwd: '/skills/example',
        }),
      };
      yield {
        type: 'response.completed',
        responseId: 'resp_sandbox',
        usage: null,
      };
    });
    const storage = repositories();
    const sandbox = sandboxWithSkills([
      {
        name: 'example',
        description: 'Run the example workflow.',
        path: '/home/test/.codex/skills/example/SKILL.md',
      },
      {
        name: 'other',
        description: 'Run an unrelated workflow.',
        path: '/home/test/.codex/skills/other/SKILL.md',
      },
    ]);
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: CONFIGURED_TAVILY,
      sandbox,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_sandbox` },
      clock: { now: () => 500 },
    });

    await expect(collect(planner)).resolves.toMatchObject([
      {
        type: 'tool.call',
        call: {
          family: 'sandbox',
          operation: 'exec',
          replay: 'mutation',
          name: 'sandbox_exec',
        },
      },
    ]);
    expect(model.requests[0]?.tools.map(({ name }) => name)).toEqual([
      ...FIRST_TURN_BROWSER_TOOL_NAMES,
      'tavily_search',
      'tavily_extract',
      'tavily_crawl',
      'sandbox_read',
      'sandbox_exec',
    ]);
    expect(model.requests[0]?.systemPrompt).toMatch(/^Custom safe preference\.\n\nSandbox Skills/);
    expect(model.requests[0]?.systemPrompt).toContain('Run the example workflow.');
    expect(model.requests[0]?.systemPrompt).toContain('/home/test/.codex/skills/example/SKILL.md');
    expect(model.requests[0]?.systemPrompt).toContain('Run an unrelated workflow.');
    expect(model.requests[0]?.systemPrompt).not.toContain('Browser evidence scope');

    await collect(planner, new AbortController().signal, {
      ...PLAN_INPUT,
      toolResults: [
        completedResult({
          resultId: 'toolResult_skill',
          callId: 'call_skill',
          toolName: 'sandbox_read',
          argumentsJson: JSON.stringify({
            path: '/home/test/.codex/skills/example/SKILL.md',
            startLine: 1,
            maxLines: 400,
          }),
          output: JSON.stringify({ code: 0, stdout: '# Example', stderr: '' }),
        }),
      ],
    });

    expect(model.requests[1]?.systemPrompt).toContain('Run the example workflow.');
    expect(model.requests[1]?.systemPrompt).toContain('Run an unrelated workflow.');
  });

  it('replays the complete local task on every model turn', async () => {
    const continuationItems = [
      { type: 'message_ref' as const, messageId: USER_MESSAGE.id },
      {
        type: 'function_call' as const,
        callId: 'call_previous',
        name: 'browser_click',
        argumentsJson: '{"tabId":7,"ref":"page_1_1","button":"left","count":1}',
      },
      {
        type: 'function_call_output_ref' as const,
        callId: 'call_previous',
        resultId: 'result_previous',
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
      toolResults: [
        completedResult({
          callId: 'call_previous',
          toolName: 'browser_click',
          argumentsJson: '{"tabId":7,"ref":"page_1_1","button":"left","count":1}',
          output: '{"ok":true}',
          resultId: 'result_previous',
        }),
      ],
    });

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]).toMatchObject({
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Continue checkout' },
            { type: 'input_text', text: TASK_BROWSER_BINDING_TEXT },
          ],
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

  it('does not expose the internal context commit tool in ordinary model requests', async () => {
    const model = provider(async function* () {
      yield {
        type: 'response.started',
        responseId: 'resp_without_internal_commit',
      };
      yield {
        type: 'text.delta',
        delta: 'Continue without the internal tool.',
      };
      yield {
        type: 'response.completed',
        responseId: 'resp_without_internal_commit',
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
      ids: { create: (prefix) => `${prefix}_without_internal_commit` },
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
            type: 'function_call_output_ref' as const,
            callId,
            resultId: `result_${String(index + 1)}`,
            attachmentIds: [],
          },
        ];
      }).flat(),
    ];

    await collect(planner, new AbortController().signal, {
      ...PLAN_INPUT,
      checkpoint: { ...CHECKPOINT, continuationItems },
      toolResults: Array.from({ length: 48 }, (_, index) => {
        const callId = `call_browser_${String(index + 1)}`;
        return completedResult({
          callId,
          toolName: 'browser_click',
          argumentsJson: JSON.stringify({ ref: `ref_${String(index + 1)}` }),
          output: 'x'.repeat(2_048),
          resultId: `result_${String(index + 1)}`,
        });
      }),
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
        type: 'tool.call',
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
        type: 'tool.call',
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
    ['tavily_search', SEARCH_ARGUMENTS],
    [
      'tavily_extract',
      {
        urls: ['https://example.com/a'],
        query: 'authentication',
        extractDepth: 'basic',
      },
    ],
    [
      'tavily_crawl',
      {
        url: 'https://docs.example.com/',
        instructions: 'Find authentication docs.',
        maxDepth: 2,
        maxPages: 5,
      },
    ],
  ] as const)(
    'returns one validated %s call without creating an empty assistant message',
    async (name, arguments_) => {
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
          type: 'tool.call',
          call: {
            callId: 'call_1',
            name,
            argumentsJson,
            arguments: arguments_,
          },
        },
      ]);
      expect(storage.appendTaskMessage).not.toHaveBeenCalled();
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
        continuationItems: [
          { type: 'message_ref', messageId: USER_MESSAGE.id },
          {
            type: 'function_call',
            callId: 'call_previous',
            name: 'tavily_search',
            argumentsJson,
          },
          {
            type: 'function_call_output_ref',
            callId: 'call_previous',
            resultId: 'result_previous',
          },
        ],
      },
      toolResults: [
        completedResult({
          callId: 'call_previous',
          toolName: 'tavily_search',
          argumentsJson,
          output: '{"ok":true,"results":[]}',
          resultId: 'result_previous',
        }),
      ],
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
    expect(storage.appendTaskMessage).not.toHaveBeenCalled();
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
    expect(invalidStorage.appendTaskMessage).not.toHaveBeenCalled();
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
    expect(storage.appendTaskMessage).not.toHaveBeenCalled();
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
    expect(storage.appendTaskMessage).not.toHaveBeenCalled();
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
        type: 'tool.call',
        call: {
          callId: 'call_1',
          name: 'tavily_search',
          argumentsJson,
          arguments: SEARCH_ARGUMENTS,
        },
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
        type: 'tool.call',
        call: {
          callId: 'call_tool_then_text',
          name: 'tavily_search',
          argumentsJson,
          arguments: SEARCH_ARGUMENTS,
        },
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

    await collect(planner, new AbortController().signal, planInputFor(storage.messages));

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
    expect(storage.appendTaskMessage).not.toHaveBeenCalled();
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

    await collect(planner, new AbortController().signal, planInputFor(storage.messages));

    expect(storage.appendTaskMessage).not.toHaveBeenCalled();
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

    await collect(planner, new AbortController().signal, planInputFor(storage.messages));

    expect(storage.appendTaskMessage).not.toHaveBeenCalled();
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

  it('continues with the existing context without a second provider request', async () => {
    const stream = vi.fn<ModelProviderPort['stream']>(async function* () {
      yield { type: 'response.started', responseId: 'resp_without_compaction' };
      yield { type: 'text.delta', delta: 'Continued without compaction.' };
      yield {
        type: 'response.completed',
        responseId: 'resp_without_compaction',
        usage: null,
      };
    });
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: { stream },
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
      events: PLAN_INPUT.events,
      checkpoint: {
        ...CHECKPOINT,
        lastModelInputTokens: 220_000,
        continuationItems: [
          { type: 'message_ref', messageId: USER_MESSAGE.id },
          {
            type: 'function_call',
            callId: 'call_inspect',
            name: 'browser_inspect',
            argumentsJson: '{"tabId":7,"mode":"interactive"}',
          },
          {
            type: 'function_call_output_ref',
            callId: 'call_inspect',
            resultId: 'result_inspect',
          },
        ],
      },
      toolResults: [
        completedResult({
          callId: 'call_inspect',
          toolName: 'browser_inspect',
          argumentsJson: '{"tabId":7,"mode":"interactive"}',
          output: '{"ok":true}',
          resultId: 'result_inspect',
        }),
      ],
    };

    await expect(collect(planner, new AbortController().signal, input)).resolves.toMatchObject([
      { type: 'task.completed', reason: 'model_response_completed' },
    ]);
    expect(stream).toHaveBeenCalledOnce();
    expect(stream.mock.calls[0]?.[0].input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Continue checkout' },
          { type: 'input_text', text: TASK_BROWSER_BINDING_TEXT },
        ],
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

  it('forces inspection before final text while a virtualized scroll is incomplete', async () => {
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
    const storage = repositories();
    const sandbox = sandboxWithSkills([]);
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      tavilyAvailability: CONFIGURED_TAVILY,
      sandbox,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_forced_inspect` },
      clock: { now: () => 500 },
    });
    const input: AgentPlanInput = {
      task: TASK,
      events: PLAN_INPUT.events,
      toolResults: [
        completedResult({
          callId: 'call_incomplete_scroll',
          toolName: 'browser_scroll',
          argumentsJson: JSON.stringify({
            tabId: 0,
            target: 'ref_history',
            deltaX: 0,
            deltaY: -10_000,
          }),
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
          resultId: 'result_incomplete_scroll',
        }),
      ],
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
            type: 'function_call_output_ref',
            callId: 'call_incomplete_scroll',
            resultId: 'result_incomplete_scroll',
          },
        ],
      },
    };

    await expect(collect(planner, new AbortController().signal, input)).resolves.toMatchObject([
      {
        type: 'tool.call',
        call: { name: 'browser_inspect', operation: 'inspect' },
      },
    ]);

    expect(sandbox.execute).not.toHaveBeenCalled();
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
