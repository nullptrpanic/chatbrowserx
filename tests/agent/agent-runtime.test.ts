// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import type { Model, ModelRequest, ResponseStreamEvent } from '@openai/agents-core';
import { AgentRuntime } from '../../src/agent/agent-runtime';
import { TaskExecutor } from '../../src/agent/task-executor';
import { TaskCommandService } from '../../src/tasks/task-command-service';
import { openChatBrowserDatabase } from '../../src/persistence/open-database';
import { IndexedDbTaskRepository } from '../../src/persistence/task-repository';
import { IndexedDbConversationRepository } from '../../src/persistence/conversation-repository';
import { DEFAULT_APP_SETTINGS } from '../../src/persistence/settings-store';
import type { ToolRuntimePort } from '../../src/tools/types';
import { strictFunctionTool } from '../../src/tools/model-tool';
import { providerErrorFromCode } from '../../src/providers/provider-error';
import type { Provider } from '../../src/providers/provider';
import { discoverTools } from '../../src/tools/discover';
import { bindToolRuntime } from '../../src/tools/registry';
import { ToolServiceResolver } from '../../src/tools/service-resolver';
import { admitSessionMessages, restoreAgentSession } from '../../src/agent/context/agent-session';
import { TaskHistoryReader } from '../../src/tasks/task-history-reader';
import { historyService } from '../../src/tools/history/service';
import { historyRuntime } from '../../src/tools/history/tool';
import { browserService } from '../../src/tools/browser/service';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected fixture value.');
  return value;
}

type OutputItem = Extract<
  ResponseStreamEvent,
  { type: 'response_done' }
>['response']['output'][number];
const text = (value: string, phase?: 'commentary' | 'final_answer'): OutputItem => ({
  type: 'message',
  role: 'assistant',
  status: 'completed',
  ...(phase === undefined ? {} : { phase }),
  content: [{ type: 'output_text', text: value }],
});
const call = (id: string): Extract<OutputItem, { type: 'function_call' }> => ({
  type: 'function_call',
  callId: id,
  name: 'inspect_fixture',
  arguments: '{}',
  status: 'completed',
});
async function fixture(
  outputs: Array<OutputItem[] | Error>,
  options: {
    emitText?: boolean;
    providerId?: () => string;
    backend?: Partial<Provider>;
    partialError?: string;
    activities?: readonly ResponseStreamEvent[];
    onAttempt?: (index: number, request: ModelRequest) => Promise<void>;
    tools?: ToolRuntimePort;
  } = {},
) {
  const db = await openChatBrowserDatabase(`runtime-${crypto.randomUUID()}`);
  const tasks = new IndexedDbTaskRepository(db);
  const conversations = new IndexedDbConversationRepository(db);
  let now = 100;
  const clock = { now: () => ++now };
  const ids = { create: (prefix: string) => `${prefix}_${crypto.randomUUID()}` };
  const requests: ModelRequest[] = [];
  const model: Model = {
    getResponse: async () => {
      throw new Error('Unexpected non-streaming request');
    },
    async *getStreamedResponse(request): AsyncGenerator<ResponseStreamEvent> {
      requests.push(request);
      const output = outputs.shift();
      if (output instanceof Error && options.partialError)
        yield { type: 'output_text_delta', delta: options.partialError };
      await options.onAttempt?.(requests.length, request);
      if (output instanceof Error) throw output;
      if (!output) throw new Error('Unexpected model turn');
      yield { type: 'response_started' };
      if (requests.length === 1) for (const activity of options.activities ?? []) yield activity;
      if (options.emitText !== false)
        for (const item of output)
          if (item.type === 'message')
            for (const part of item.content)
              if (part.type === 'output_text')
                yield { type: 'output_text_delta', delta: part.text };
      yield {
        type: 'response_done',
        response: {
          id: `response_${requests.length}`,
          output,
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
            inputTokensDetails: {},
            outputTokensDetails: {},
          },
          rawUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        },
      };
    },
  };
  const tools: ToolRuntimePort = options.tools ?? {
    contract: async () => ({
      definitions: [strictFunctionTool('inspect_fixture', 'Inspect the synthetic fixture', {})],
      systemPrompt: '',
      parse: (source) => ({ ...source, arguments: JSON.parse(source.argumentsJson) }),
    }),
    parseRecorded: (source) => ({ ...source, arguments: JSON.parse(source.argumentsJson) }),
    policyFor: () => ({ budgetGroup: 'fixture', maxCalls: 10, mutation: true }),
    callsUsed: (_name, context) => context.toolResults?.length ?? 0,
    preflight: async () => null,
    canRecover: () => false,
    recover: async () => ({ status: 'not_found' }),
    failureFor: () => null,
    contextCompacted: async () => {},
    release: async () => {},
    execute: vi.fn(async (_call, context) => {
      const stored = await tasks.readActiveRuntimeSnapshot(required(context.task).id);
      expect(stored?.checkpoint?.pendingToolCall?.executionState).toBe('may_have_dispatched');
      const session = await tasks.getAgentSession(required(context.task).conversationId);
      expect(session?.items).toContainEqual(
        expect.objectContaining({ type: 'function_call', callId: _call.callId }),
      );
      return { output: JSON.stringify({ ok: true, fact: 'The fixture value is blue.' }) };
    }),
  };
  const getModel = vi.fn(async () => model);
  const runtime = new AgentRuntime({
    providers: {
      resolve: async () => ({
        providerId: options.providerId?.() ?? 'fixture',
        settings: DEFAULT_APP_SETTINGS,
        provider: {
          getModel,
          listModels: async () => [],
          compact: async () => ({ items: [], usage: null }),
          ...options.backend,
        },
      }),
    },
    tools,
    tasks,
    conversations,
    attachments: { get: async () => undefined },
    clock,
    ids,
  });
  const executor = new TaskExecutor({
    repository: tasks,
    conversations,
    runtime,
    tools,
    clock,
    ids,
  });
  const commands = new TaskCommandService(tasks, clock, ids, conversations);
  const conversation = {
    id: 'conversation',
    tabId: 7,
    title: 'Fixture',
    createdAt: 1,
    updatedAt: 1,
  };
  let first = true;
  const submit = async (input: string) => {
    const result = await commands.createSubmission({
      conversation,
      createConversation: first,
      conversationId: conversation.id,
      tabId: 7,
      goal: input,
      message: {
        id: ids.create('message'),
        conversationId: conversation.id,
        kind: 'conversation',
        role: 'user',
        status: 'complete',
        text: input,
        attachmentIds: [],
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
    first = false;
    return result;
  };
  return {
    db,
    tasks,
    conversations,
    requests,
    executor,
    commands,
    submit,
    tools,
    runtime,
    clock,
    getModel,
  };
}

describe('framework-backed agent runtime', () => {
  it('returns a disabled tool error to the model and continues with an available tool', async () => {
    const f = await fixture([
      [call('first')],
      [call('hidden')],
      [{ ...call('recovered'), name: 'click_fixture' }],
      [text('Done without submitting.')],
    ]);
    const original = f.tools.contract.bind(f.tools);
    vi.spyOn(f.tools, 'contract').mockImplementation(async (context, signal) => ({
      ...(await original(context, signal)),
      definitions: [
        strictFunctionTool(
          context.toolResults?.length ? 'click_fixture' : 'inspect_fixture',
          'Interact with the fixture',
          {},
        ),
      ],
    }));
    try {
      const { task } = await f.submit('Fill the form without submitting.');
      const result = await f.executor.run(task.id, new AbortController().signal);
      expect(result.task.status).toBe('completed');
      expect(f.tools.execute).toHaveBeenCalledTimes(2);
      expect(vi.mocked(f.tools.execute).mock.calls.map(([tool]) => tool.callId)).toEqual([
        'first',
        'recovered',
      ]);
      const unavailable = expect.objectContaining({
        type: 'function_call_result',
        callId: 'hidden',
        output: { type: 'text', text: expect.stringContaining('not found') },
      });
      expect(f.requests[2]?.input).toContainEqual(unavailable);
      const session = await f.tasks.getAgentSession(task.conversationId);
      expect(session?.items).toContainEqual(unavailable);
    } finally {
      f.db.close();
    }
  });

  it('honors each refreshed tool choice after a tool call and returns to automatic choice', async () => {
    const f = await fixture([[call('first')], [call('forced')], [text('Done.')]]);
    const original = f.tools.contract.bind(f.tools);
    vi.spyOn(f.tools, 'contract').mockImplementation(async (context, signal) => ({
      ...(await original(context, signal)),
      toolChoice:
        context.toolResults?.length === 1 ? { type: 'function', name: 'inspect_fixture' } : 'auto',
    }));
    try {
      const { task } = await f.submit('Inspect again when the page requires it.');
      const result = await f.executor.run(task.id, new AbortController().signal);
      expect(result.task.status).toBe('completed');
      expect(f.requests.map((request) => request.modelSettings.toolChoice)).toEqual([
        'auto',
        'inspect_fixture',
        'auto',
      ]);
    } finally {
      f.db.close();
    }
  });

  it('escapes failed forced inspections and rechecks the page when the old task is retried', async () => {
    const services = new ToolServiceResolver();
    let connected = false;
    const execute = vi.fn(async (tool: { operation: string }) => ({
      output: JSON.stringify(
        tool.operation === 'scroll'
          ? {
              ok: true,
              data: {
                action: 'scroll',
                moved: false,
                requestedDeltaApplied: false,
                remainingDeltaX: 0,
                remainingDeltaY: 600,
              },
            }
          : connected
            ? { ok: true, data: { mode: 'interactive', elements: [], snapshot: 'reconnected' } }
            : {
                ok: false,
                code: 'DEBUGGER_UNAVAILABLE',
                message: 'The browser debugger is unavailable for this tab.',
                retryable: true,
                needsInspect: false,
              },
      ),
      attachmentIds: [],
    }));
    services.bind(browserService, {
      execute,
      resetObservationBaselines: vi.fn(),
      release: vi.fn(async () => {}),
    });
    const inspect = (id: string): OutputItem => ({
      ...call(id),
      name: 'inspect',
      namespace: 'browser',
      arguments: JSON.stringify({
        tabId: 0,
        mode: 'interactive',
        since: '',
        ref: '',
        visualReason: '',
      }),
    });
    const f = await fixture(
      [
        [
          {
            ...call('scroll'),
            name: 'scroll',
            namespace: 'browser',
            arguments: JSON.stringify({
              tabId: 0,
              target: 'viewport',
              deltaX: 0,
              deltaY: 600,
              maxSegments: 1,
              stopText: '',
            }),
          },
        ],
        [inspect('unavailable_1')],
        [inspect('unavailable_2')],
        providerErrorFromCode('INVALID_RESPONSE', { invalidResponseStage: 'request_contract' }),
        [inspect('reconnected')],
        [text('The page is available again.')],
      ],
      { tools: bindToolRuntime(discoverTools(), services) },
    );
    try {
      const { task } = await f.submit('Inspect the page without submitting.');
      const failed = await f.executor.run(task.id, new AbortController().signal);
      expect(failed.task.status).toBe('failed');
      expect(failed.toolResults.slice(-2).map((result) => JSON.parse(result.output).code)).toEqual([
        'DEBUGGER_UNAVAILABLE',
        'DEBUGGER_UNAVAILABLE',
      ]);
      expect(f.requests.map((request) => request.modelSettings.toolChoice)).toEqual([
        'auto',
        'browser.inspect',
        'browser.inspect',
        'auto',
      ]);

      connected = true;
      await f.commands.retry(task.id);
      const completed = await f.executor.run(task.id, new AbortController().signal);
      expect(completed.task.status).toBe('completed');
      expect(execute).toHaveBeenCalledTimes(4);
      expect(JSON.parse(completed.toolResults.at(-1)?.output ?? '{}')).toMatchObject({ ok: true });
      expect(f.requests).toHaveLength(6);
      expect(f.requests.slice(4).map((request) => request.modelSettings.toolChoice)).toEqual([
        'auto',
        'auto',
      ]);
    } finally {
      f.db.close();
    }
  });

  it.each(['conversation_history', 'tool_contract'] as const)(
    'retains the failing %s preparation stage without persisting private error details',
    async (stage) => {
      const f = await fixture([]);
      try {
        const { task } = await f.submit('Fill the form without submitting.');
        const error = new Error('Private upstream diagnostic');
        if (stage === 'conversation_history')
          vi.spyOn(f.conversations, 'listMessages').mockRejectedValue(error);
        else vi.spyOn(f.tools, 'contract').mockRejectedValue(error);
        const result = await f.executor.run(task.id, new AbortController().signal);
        expect(result.task.status).toBe('failed');
        expect(result.run.error).toMatchObject({
          code: 'TaskInputError',
          userMessage: `Task input could not be prepared (stage: ${stage}).`,
          evidenceRef: `input_preparation:${stage}`,
        });
        expect(JSON.stringify(result.events)).not.toContain(error.message);
        expect(f.requests).toHaveLength(0);
      } finally {
        f.db.close();
      }
    },
  );

  it('preserves provider authentication failures during tool preparation', async () => {
    const f = await fixture([]);
    try {
      const { task } = await f.submit('Inspect the page.');
      vi.spyOn(f.tools, 'contract').mockRejectedValue(providerErrorFromCode('AUTH'));
      const result = await f.executor.run(task.id, new AbortController().signal);
      expect(result.task.status).toBe('waiting_for_auth');
      expect(result.run.error?.code).toBe('AuthError');
    } finally {
      f.db.close();
    }
  });

  it.each(['saved window', 'durable history'] as const)(
    'preserves the answer and forwards the supplement once using %s',
    async (context) => {
      const note = { ...text('I will check the source.', 'commentary'), id: 'msg_progress' };
      const f = await fixture(
        [[note, text('Original answer.', 'final_answer')], [text('Updated answer.')]],
        {
          activities: [
            {
              type: 'model',
              event: {
                type: 'assistant_commentary',
                index: 0,
                itemId: note.id,
                text: 'I will check the source.',
              },
            },
          ],
        },
      );
      try {
        const { task } = await f.submit('Read the source.');
        const save = f.tasks.saveTransition.bind(f.tasks);
        let queued = false;
        vi.spyOn(f.tasks, 'saveTransition').mockImplementation(async (boundary) => {
          if (!queued && boundary.events.some(({ type }) => type === 'assistant.commentary')) {
            queued = true;
            const at = f.clock.now();
            await f.commands.appendSupplement({
              id: 'during_commentary',
              taskId: task.id,
              conversationId: task.conversationId,
              kind: 'supplement',
              role: 'user',
              status: 'complete',
              text: 'Include the second source.',
              attachmentIds: [],
              createdAt: at,
              updatedAt: at,
            });
          }
          await save(boundary);
        });
        const result = await f.executor.run(task.id, new AbortController().signal);
        expect(result.task.status).toBe('completed');
        expect(result.events.filter(({ type }) => type === 'assistant.commentary')).toHaveLength(1);
        expect(f.requests).toHaveLength(1);
        expect(await f.conversations.listTaskMessages(task.id)).toContainEqual(
          expect.objectContaining({
            role: 'assistant',
            status: 'complete',
            text: 'Original answer.',
          }),
        );
        const followUp = required((await f.tasks.listByConversation(task.conversationId))[1]);
        expect(followUp).toMatchObject({ goal: 'Include the second source.', status: 'queued' });
        expect(await f.conversations.listTaskMessages(followUp.id)).toMatchObject([
          { role: 'user', kind: 'conversation', text: 'Include the second source.' },
        ]);
        if (context === 'durable history') {
          await f.db.delete('agent-sessions', task.conversationId);
        }
        await f.executor.run(followUp.id, new AbortController().signal);
        expect(f.requests).toHaveLength(2);
        const input = JSON.stringify(required(f.requests[1]).input);
        expect(input).toMatch(/Original answer\..*Include the second source\./s);
        expect(input.match(/Include the second source\./g)).toHaveLength(1);
        expect(await f.conversations.listTaskMessages(followUp.id)).toContainEqual(
          expect.objectContaining({
            role: 'assistant',
            status: 'complete',
            text: 'Updated answer.',
          }),
        );
      } finally {
        f.db.close();
      }
    },
  );

  it('keeps a hosted-tool preamble in execution history and saves only the final answer', async () => {
    const preamble = text('I will check the official editions.', 'commentary');
    const search = (id: string): OutputItem => ({
      type: 'hosted_tool_call',
      id,
      name: 'web_search_call',
      status: 'completed',
    });
    const answer = text('The standard edition is available.', 'final_answer');
    const f = await fixture([[preamble, search('ws_1'), search('ws_2'), answer]]);
    try {
      const { task } = await f.submit('Find the available edition.');
      await f.executor.run(task.id, new AbortController().signal);
      const archive = required((await f.tasks.readTaskTimelines([task.id]))[0]);
      expect(archive.task.status).toBe('completed');
      const replies = (await f.conversations.listTaskMessages(task.id)).filter(
        ({ role }) => role === 'assistant',
      );
      expect(replies.map(({ text }) => text)).toEqual(['The standard edition is available.']);
      expect(archive.events.filter(({ type }) => type === 'assistant.commentary')).toEqual([
        expect.objectContaining({ callId: 'ws_1', text: 'I will check the official editions.' }),
      ]);
      expect((await f.tasks.getAgentSession(task.conversationId))?.items).toContainEqual(preamble);
    } finally {
      f.db.close();
    }
  });

  it('retrieves an original answer through registered history tools after restoring a compacted window', async () => {
    const outputs: OutputItem[][] = [[text('The original receipt is QX-7391.')]];
    const services = new ToolServiceResolver();
    const tools = bindToolRuntime(
      discoverTools().filter(({ runtime }) => runtime === historyRuntime),
      services,
    );
    const f = await fixture(outputs, { tools });
    services.bind(
      historyService,
      new TaskHistoryReader({
        tasks: f.tasks,
        conversations: f.conversations,
        attachments: { get: async () => undefined },
      }),
    );
    try {
      const old = await f.submit('Save the receipt number.');
      await f.executor.run(old.task.id, new AbortController().signal);
      const answer = required(
        (await f.conversations.listTaskMessages(old.task.id)).find(
          (message) => message.role === 'assistant',
        ),
      );
      const saved = required(await f.tasks.getAgentSession('conversation'));
      await f.db.put('agent-sessions', {
        ...saved,
        items: [{ type: 'compaction', id: 'saved', encrypted_content: 'opaque-window' }],
      });
      outputs.push(
        [
          {
            type: 'function_call',
            callId: 'find-old-answer',
            name: 'search',
            namespace: 'history',
            arguments: JSON.stringify({ query: 'receipt', cursor: '', limit: 5 }),
            status: 'completed',
          },
        ],
        [
          {
            type: 'function_call',
            callId: 'read-old-answer',
            name: 'read',
            namespace: 'history',
            arguments: JSON.stringify({
              target: { taskId: old.task.id, messageId: answer.id, offset: 0, limit: 100 },
            }),
            status: 'completed',
          },
        ],
        [text('Your earlier answer said QX-7391.')],
      );
      const followup = await f.submit('What was your earlier answer?');
      const completed = required(
        await f.executor.run(followup.task.id, new AbortController().signal),
      );
      expect(completed.task.status).toBe('completed');
      const beforeSearch = required(f.requests[1]);
      expect(JSON.stringify(beforeSearch.input)).not.toContain('QX-7391');
      expect(beforeSearch.tools).toContainEqual(
        expect.objectContaining({ name: 'search', namespace: 'history' }),
      );
      expect(beforeSearch.systemInstructions).toBe(DEFAULT_APP_SETTINGS.systemPrompt);
      expect(JSON.stringify(required(f.requests[2]).input)).toContain(
        'The original receipt is QX-7391.',
      );
      const result = required(
        completed.toolResults.find((item) => item.toolName === 'history.read'),
      );
      expect(JSON.parse(result.output)).toMatchObject({
        ok: true,
        messageId: answer.id,
        role: 'assistant',
        content: 'The original receipt is QX-7391.',
        nextOffset: null,
      });
      expect(f.requests).toHaveLength(4);
    } finally {
      f.db.close();
    }
  });

  it('records provider-hosted search without a local search tool', async () => {
    const hit: OutputItem = {
      type: 'hosted_tool_call',
      id: 'first-turn-search',
      name: 'web_search_call',
      status: 'completed',
      providerData: { action: { type: 'search', query: 'fixture release notes' } },
    };
    const f = await fixture([[text('Four.')], [hit, text('Found the release notes.')]]);
    try {
      const question = await f.submit('What is two plus two?');
      const direct = await f.executor.run(question.task.id, new AbortController().signal);
      expect(direct.task.status).toBe('completed');
      expect(direct.toolResults).toEqual([]);

      const lookup = await f.submit('Search the web for the release notes.');
      const found = await f.executor.run(lookup.task.id, new AbortController().signal);
      expect(found.task.status).toBe('completed');
      expect(found.toolResults).toMatchObject([
        { callId: hit.id, toolName: 'web_search_call', providerHosted: true },
      ]);
      expect(f.requests).toHaveLength(2);
      for (const request of f.requests) {
        expect(request.tools.map(({ name }) => name)).toEqual(['inspect_fixture']);
        expect(request.modelSettings.toolChoice).toBe('auto');
      }
      expect(f.tools.execute).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });

  it.each([
    ['checkpoint', 'load_tools', '{"names":["web_search"]}'],
    ['session', 'load_tools', '{"names":["web_search"]}'],
    ['checkpoint', 'browser_get_current_tab', '{}'],
    ['session', 'browser_get_current_tab', '{}'],
  ] as const)(
    'resumes from a %s containing a retired %s call',
    async (boundary, name, argumentsJson) => {
      const tools = bindToolRuntime([], new ToolServiceResolver());
      const f = await fixture([[text('Task resumed.')]], {
        tools,
      });
      try {
        const { task, run, checkpoint } = await f.submit('Continue the task.');
        const activation = {
          type: 'function_call' as const,
          callId: 'previous-tool-call',
          name,
          arguments: argumentsJson,
          status: 'completed' as const,
        };
        const session = {
          conversationId: task.conversationId,
          taskId: task.id,
          items: [activation],
          admittedMessageIds: [],
          lastInputTokens: null,
        };
        if (boundary === 'checkpoint') {
          const checkpointBeforeCall = required(checkpoint ?? undefined);
          const sequence = task.lastEventSequence + 1;
          const call = {
            name: activation.name,
            callId: activation.callId,
            argumentsJson: activation.arguments,
          };
          await f.tasks.saveTransition({
            task: { ...task, status: 'planning', lastEventSequence: sequence },
            run: { ...run, status: 'planning' },
            checkpoint: {
              ...checkpointBeforeCall,
              pendingToolCall: { ...call, executionState: 'recorded' },
              continuationItems: [
                ...checkpointBeforeCall.continuationItems,
                { type: 'function_call', ...call },
              ],
            },
            events: [
              {
                type: 'tool.call',
                id: 'previous-load-event',
                taskId: task.id,
                runId: run.id,
                sequence,
                at: f.clock.now(),
                ...call,
              },
            ],
            session,
          });
        } else {
          await f.db.put('agent-sessions', session);
        }

        const result = await f.executor.run(task.id, new AbortController().signal);
        expect(result.task.status).toBe('completed');
        expect(f.requests).toHaveLength(1);
        const request = required(f.requests[0]);
        expect(request.tools).toEqual([]);
        expect(request.input).toContainEqual(activation);
        expect(request.input).toContainEqual(
          expect.objectContaining({
            type: 'function_call_result',
            callId: activation.callId,
            output: expect.stringContaining('TOOL_RETIRED'),
          }),
        );
      } finally {
        f.db.close();
      }
    },
  );

  it('runs the same tool loop through a provider that translates a different wire format', async () => {
    const wireInputs: string[] = [];
    const wireReplies = [
      { action: 'invoke', transaction: 'foreign-call', function: 'inspect_fixture', payload: {} },
      { action: 'answer', body: 'The fixture value is blue.' },
    ];
    const model: Model = {
      getResponse: async () => {
        throw new Error('Unexpected non-streaming request');
      },
      async *getStreamedResponse(request): AsyncGenerator<ResponseStreamEvent> {
        wireInputs.push(JSON.stringify({ dialogue: request.input, functions: request.tools }));
        const reply = required(wireReplies.shift());
        const output: OutputItem[] =
          reply.action === 'invoke'
            ? [
                {
                  type: 'function_call',
                  callId: required(reply.transaction),
                  name: required(reply.function),
                  arguments: JSON.stringify(reply.payload),
                  status: 'completed',
                },
              ]
            : [text(required(reply.body))];
        yield {
          type: 'response_done',
          response: {
            id: `foreign-response-${wireInputs.length}`,
            output,
            usage: {
              inputTokens: 3,
              outputTokens: 2,
              totalTokens: 5,
              inputTokensDetails: {},
              outputTokensDetails: {},
            },
            rawUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
          },
        };
      },
    };
    const f = await fixture([], {
      providerId: () => 'foreign',
      backend: { getModel: async () => model },
    });
    try {
      const submitted = await f.submit('Read the fixture.');
      const result = await f.executor.run(submitted.task.id, new AbortController().signal);
      expect(result.task.status).toBe('completed');
      expect(f.tools.execute).toHaveBeenCalledOnce();
      expect(wireInputs).toHaveLength(2);
      expect(wireInputs[1]).toContain('The fixture value is blue.');
      expect((await f.tasks.getAgentSession(submitted.task.conversationId))?.providerId).toBe(
        'foreign',
      );
    } finally {
      f.db.close();
    }
  });

  it('does not replay a conversation native window to another provider', async () => {
    let providerId = 'first';
    const f = await fixture([[text('Saved fact.')]], { providerId: () => providerId });
    try {
      const first = await f.submit('Remember this fact.');
      await f.executor.run(first.task.id, new AbortController().signal);
      providerId = 'second';
      const next = await f.submit('Continue.');
      const result = await f.executor.run(next.task.id, new AbortController().signal);
      expect(result.task.status).toBe('paused');
      expect(result.run.error?.userMessage).toContain('another model provider');
      expect(f.requests).toHaveLength(1);
      expect((await f.tasks.getAgentSession(first.task.conversationId))?.providerId).toBe('first');
    } finally {
      f.db.close();
    }
  });

  it.each([false, true])(
    'replays the prior compacted window after clearing a cancelled task (executed: %s)',
    async (executed) => {
      const cancelledRequest = 'Question to discard from context.';
      const oldAnswer = 'An archived answer that should remain compacted.';
      const controller = new AbortController();
      let cancelledTaskId = '';
      const f = await fixture(
        [
          [text(oldAnswer)],
          ...(executed ? [[call('effect_before_clear')], providerErrorFromCode('ABORTED')] : []),
          [text('Follow-up answer.')],
        ],
        {
          onAttempt: async (index) => {
            if (index === 3 && executed) {
              await f.commands.cancel(cancelledTaskId);
              controller.abort();
            }
          },
        },
      );
      try {
        const first = await f.submit('Save the earlier answer.');
        await f.executor.run(first.task.id, new AbortController().signal);
        const previous = required(await f.tasks.getAgentSession(first.task.conversationId));
        const opaque = {
          type: 'compaction' as const,
          id: 'saved-window',
          encrypted_content: 'opaque',
        };
        await f.db.put('agent-sessions', { ...previous, items: [opaque] });

        const cancelled = await f.submit(cancelledRequest);
        cancelledTaskId = cancelled.task.id;
        if (executed) {
          await f.executor.run(cancelledTaskId, controller.signal).catch((error) => {
            expect(error.code === 'ABORTED' || error.name === 'AbortError').toBe(true);
          });
        } else await f.commands.cancel(cancelledTaskId);
        const cleared = await f.commands.clearContext(cancelledTaskId);
        expect(cleared.checkpoint).toBeNull();
        expect(cleared.events.at(-1)?.type).toBe('context.cleared');

        const next = await f.submit('Use the earlier context.');
        const result = await f.executor.run(next.task.id, new AbortController().signal);
        expect(result.task.status).toBe('completed');
        const input = required(f.requests.at(-1)).input;
        expect(input).toContainEqual(opaque);
        expect(JSON.stringify(input)).not.toContain(oldAnswer);
        expect(JSON.stringify(input)).not.toContain(cancelledRequest);
        expect(JSON.stringify(input)).not.toContain('effect_before_clear');
        expect(cleared.toolResults).toHaveLength(executed ? 1 : 0);
        expect(f.tools.execute).toHaveBeenCalledTimes(executed ? 1 : 0);
        expect(await f.conversations.listTaskMessages(cancelledTaskId)).toContainEqual(
          expect.objectContaining({ text: cancelledRequest }),
        );
      } finally {
        f.db.close();
      }
    },
  );

  it('rebuilds a damaged legacy model window from messages and recorded tool receipts on retry', async () => {
    const f = await fixture([
      [call('confirmed_before_upgrade')],
      [text('Earlier confirmed answer.')],
      providerErrorFromCode('INVALID_RESPONSE', { invalidResponseStage: 'request_contract' }),
      [text('The old conversation works again.')],
    ]);
    try {
      const first = await f.submit('Remember the confirmed result.');
      await f.executor.run(first.task.id, new AbortController().signal);
      const next = await f.submit('Continue this conversation.');
      const failed = await f.executor.run(next.task.id, new AbortController().signal);
      expect(failed.task.status).toBe('failed');
      const badCompaction = {
        type: 'compaction' as const,
        id: 'legacy-invalid-window',
        encrypted_content: '',
      };
      Reflect.deleteProperty(badCompaction, 'encrypted_content');
      const stored = required(await f.tasks.getAgentSession(next.task.conversationId));
      await f.db.put('agent-sessions', { ...stored, items: [badCompaction] });

      await f.commands.retry(next.task.id);
      const recovered = await f.executor.run(next.task.id, new AbortController().signal);
      expect(recovered.task.status).toBe('completed');
      const input = JSON.stringify(required(f.requests.at(-1)).input);
      expect(input).not.toContain(badCompaction.id);
      expect(input).toContain('Earlier confirmed answer.');
      expect(input.match(/Continue this conversation\./g)).toHaveLength(1);
      expect(required(f.requests.at(-1)).input).toContainEqual(
        expect.objectContaining({
          type: 'function_call_result',
          callId: 'confirmed_before_upgrade',
          output: expect.stringContaining('The fixture value is blue.'),
        }),
      );
      expect(f.tools.execute).toHaveBeenCalledOnce();
      expect(await f.tasks.listToolResults(first.task.id)).toHaveLength(1);
      expect(JSON.stringify(await f.tasks.getAgentSession(next.task.conversationId))).not.toContain(
        badCompaction.id,
      );
    } finally {
      f.db.close();
    }
  });

  it('preserves confirmed effects and queued supplements across cancellation and a new question', async () => {
    const controller = new AbortController();
    let taskId = '';
    const f = await fixture(
      [
        [call('done_before_cancel')],
        providerErrorFromCode('ABORTED'),
        [text('Continued from saved evidence.')],
      ],
      {
        onAttempt: async (index) => {
          if (index !== 2) return;
          const at = f.clock.now();
          await f.commands.appendSupplement({
            id: 'cancelled_supplement',
            taskId,
            conversationId: 'conversation',
            kind: 'supplement',
            role: 'user',
            status: 'complete',
            text: 'Keep this user detail.',
            attachmentIds: [],
            createdAt: at,
            updatedAt: at,
          });
          await f.commands.cancel(taskId);
          controller.abort();
        },
      },
    );
    try {
      taskId = (await f.submit('Read then answer.')).task.id;
      await f.executor.run(taskId, controller.signal).catch((error) => {
        expect(error.code === 'ABORTED' || error.name === 'AbortError').toBe(true);
      });
      expect((await f.commands.getSnapshot(taskId)).task.status).toBe('cancelled');
      const next = await f.submit('Use the saved evidence.');
      expect((await f.executor.run(next.task.id, new AbortController().signal)).task.status).toBe(
        'completed',
      );
      const input = JSON.stringify(required(f.requests.at(-1)).input);
      expect(input).toContain('The fixture value is blue.');
      expect(input.match(/Keep this user detail\./g)).toHaveLength(1);
      expect(f.tools.execute).toHaveBeenCalledOnce();
    } finally {
      f.db.close();
    }
  });

  it.each(['cancelled', 'failed', 'paused'] as const)(
    'reconsiders an undispatched mutation when new input follows a %s attempt',
    async (status) => {
      const controller = new AbortController();
      let taskId = '';
      let effectsBeforeCorrection = -1;
      const correction = 'Stop changing the page. Only inspect the existing values.';
      const f = await fixture([[call('old_pending_mutation')], [text('I will only inspect.')]], {
        onAttempt: async (index) => {
          if (index === 2) effectsBeforeCorrection = vi.mocked(f.tools.execute).mock.calls.length;
        },
      });
      try {
        taskId = (await f.submit('Change the field value.')).task.id;
        vi.spyOn(f.tools, 'preflight').mockImplementationOnce(async () => {
          if (status === 'failed') throw providerErrorFromCode('INVALID_RESPONSE');
          if (status === 'cancelled') await f.commands.cancel(taskId);
          else await f.commands.pause(taskId);
          controller.abort();
          throw new DOMException('Stopped before dispatch', 'AbortError');
        });
        await f.executor.run(taskId, controller.signal).catch((error) => {
          expect(error.code === 'ABORTED' || error.name === 'AbortError').toBe(true);
        });
        const stopped = await f.commands.getSnapshot(taskId);
        expect(stopped.task.status).toBe(status);
        expect(stopped.checkpoint?.pendingToolCall?.executionState).toBe('recorded');
        expect(f.tools.execute).not.toHaveBeenCalled();

        const at = f.clock.now();
        const message = {
          id: 'new-correction',
          taskId,
          conversationId: 'conversation',
          role: 'user' as const,
          status: 'complete' as const,
          text: correction,
          attachmentIds: [],
          createdAt: at,
          updatedAt: at,
        };
        if (status === 'paused') {
          await f.commands.resume(taskId);
          await f.commands.appendSupplement({ ...message, kind: 'supplement' });
        } else {
          await f.commands.continueSubmission({
            sourceTaskId: taskId,
            tabId: 7,
            conversation: required(await f.conversations.get('conversation')),
            message: { ...message, kind: 'conversation' },
          });
        }
        const result = await f.executor.run(taskId, new AbortController().signal);
        expect(result.task.status).toBe('completed');
        expect(effectsBeforeCorrection).toBe(0);
        expect(f.tools.execute).not.toHaveBeenCalled();
        const input = required(f.requests.at(-1)).input;
        expect(JSON.stringify(input)).toContain(correction);
        expect(input).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: 'function_call', callId: 'old_pending_mutation' }),
            expect.objectContaining({
              type: 'function_call_result',
              callId: 'old_pending_mutation',
              output: expect.stringContaining('SUPERSEDED_BY_USER_INPUT'),
            }),
          ]),
        );
        expect(await f.tasks.listToolResults(taskId)).toHaveLength(1);
      } finally {
        f.db.close();
      }
    },
  );

  it.each(['not_found', 'finished'] as const)(
    'preserves %s recovery evidence without redispatching a mutation after new input',
    async (recoveryStatus) => {
      const controller = new AbortController();
      const f = await fixture([[call('interrupted_mutation')], [text('Following the new input.')]]);
      try {
        vi.spyOn(f.tools, 'policyFor').mockReturnValue({
          budgetGroup: 'fixture',
          maxCalls: 10,
          mutation: true,
          executionIdPrefix: 'fixture',
        });
        const taskId = (await f.submit('Change the field value.')).task.id;
        vi.mocked(f.tools.execute).mockImplementationOnce(async () => {
          await f.commands.cancel(taskId);
          controller.abort();
          throw new DOMException('Lost execution response', 'AbortError');
        });
        vi.spyOn(f.tools, 'canRecover').mockReturnValue(true);
        const recover = vi
          .spyOn(f.tools, 'recover')
          .mockResolvedValue(
            recoveryStatus === 'not_found'
              ? { status: 'not_found' }
              : { status: 'finished', result: { output: '{"ok":true,"confirmed":true}' } },
          );
        await f.executor.run(taskId, controller.signal).catch((error) => {
          expect(error.code === 'ABORTED' || error.name === 'AbortError').toBe(true);
        });
        expect(
          (await f.commands.getSnapshot(taskId)).checkpoint?.pendingToolCall?.executionState,
        ).toBe('may_have_dispatched');
        const at = f.clock.now();
        await f.commands.continueSubmission({
          sourceTaskId: taskId,
          tabId: 7,
          conversation: required(await f.conversations.get('conversation')),
          message: {
            id: 'new-correction',
            conversationId: 'conversation',
            kind: 'conversation',
            role: 'user',
            status: 'complete',
            text: 'Only inspect the page now.',
            attachmentIds: [],
            createdAt: at,
            updatedAt: at,
          },
        });
        expect((await f.executor.run(taskId, new AbortController().signal)).task.status).toBe(
          'completed',
        );
        expect(recover).toHaveBeenCalledOnce();
        expect(f.tools.execute).toHaveBeenCalledOnce();
        const receipts = await f.tasks.listToolResults(taskId);
        expect(receipts).toHaveLength(1);
        expect(JSON.parse(required(receipts[0]).output)).toMatchObject(
          recoveryStatus === 'not_found'
            ? { ok: false, code: 'SUPERSEDED_BY_USER_INPUT' }
            : { ok: true, confirmed: true },
        );
        expect(JSON.stringify(required(f.requests.at(-1)).input)).toContain(
          'Only inspect the page now.',
        );
      } finally {
        f.db.close();
      }
    },
  );

  it('reconciles a tool receipt after a worker restart without dispatching the effect twice', async () => {
    const f = await fixture([
      [call('durable_call')],
      new Error('Worker interruption'),
      [text('Recovered without repeating the effect.')],
    ]);
    try {
      const submitted = await f.submit('Read once.');
      expect(
        (await f.executor.run(submitted.task.id, new AbortController().signal)).task.status,
      ).toBe('failed');
      const session = required(await f.tasks.getAgentSession(submitted.task.conversationId));
      // Simulate a stop after the durable receipt but before the next model-window checkpoint.
      await f.db.put('agent-sessions', {
        ...session,
        items: session.items.filter((item) => item.type !== 'function_call_result'),
      });
      await f.commands.retry(submitted.task.id);
      expect(
        (await f.executor.run(submitted.task.id, new AbortController().signal)).task.status,
      ).toBe('completed');
      expect(f.tools.execute).toHaveBeenCalledOnce();
      expect(JSON.stringify(required(f.requests.at(-1)).input)).toContain(
        'The fixture value is blue.',
      );
    } finally {
      f.db.close();
    }
  });

  it('does not dispatch a returned tool call after cancellation', async () => {
    const controller = new AbortController();
    let taskId = '';
    const f = await fixture([[call('cancelled_before_dispatch')], [text('Next answer.')]], {
      onAttempt: async (index) => {
        if (index !== 1) return;
        await f.commands.cancel(taskId);
        controller.abort();
      },
    });
    try {
      taskId = (await f.submit('Read the fixture.')).task.id;
      await f.executor.run(taskId, controller.signal).catch((error) => {
        expect(error).toMatchObject({ name: 'AbortError' });
      });
      expect((await f.commands.getSnapshot(taskId)).task.status).toBe('cancelled');
      expect(f.tools.execute).not.toHaveBeenCalled();
      const next = await f.submit('Answer a new question.');
      expect((await f.executor.run(next.task.id, new AbortController().signal)).task.status).toBe(
        'completed',
      );
      expect(f.tools.execute).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });

  it('retains the original window and a queued supplement when cancelled during compaction', async () => {
    const controller = new AbortController();
    let taskId = '';
    const f = await fixture([[call('confirmed_before_compaction')], [text('Next answer.')]], {
      backend: {
        listModels: async () => [
          {
            id: DEFAULT_APP_SETTINGS.model,
            name: 'Fixture',
            contextWindow: controller.signal.aborted ? 272_000 : 11,
            defaultReasoningEffort: 'medium',
            reasoningEfforts: ['medium'],
          },
        ],
        compact: async () => {
          await f.commands.appendSupplement({
            id: 'queued_during_compaction',
            taskId,
            conversationId: 'conversation',
            kind: 'supplement',
            role: 'user',
            status: 'complete',
            text: 'Keep the compaction-time note.',
            attachmentIds: [],
            createdAt: f.clock.now(),
            updatedAt: f.clock.now(),
          });
          await f.commands.cancel(taskId);
          controller.abort();
          return {
            items: [{ type: 'compaction', id: 'discarded', encrypted_content: 'discarded' }],
            usage: null,
          };
        },
      },
    });
    const invalidate = vi.spyOn(f.tools, 'contextCompacted');
    try {
      taskId = (await f.submit('Read the fixture.')).task.id;
      await f.executor.run(taskId, controller.signal).catch((error) => {
        expect(error).toMatchObject({ name: 'AbortError' });
      });
      expect((await f.commands.getSnapshot(taskId)).task.status).toBe('cancelled');
      expect(invalidate).not.toHaveBeenCalled();
      const next = await f.submit('Use the earlier evidence and note.');
      expect((await f.executor.run(next.task.id, new AbortController().signal)).task.status).toBe(
        'completed',
      );
      const input = JSON.stringify(required(f.requests.at(-1)).input);
      expect(input).toContain('The fixture value is blue.');
      expect(input.match(/Keep the compaction-time note\./g)).toHaveLength(1);
      expect(input).not.toContain('discarded');
      expect(f.tools.execute).toHaveBeenCalledOnce();
      expect(required(f.requests.at(-1)).input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'function_call', callId: 'confirmed_before_compaction' }),
          expect.objectContaining({
            type: 'function_call_result',
            callId: 'confirmed_before_compaction',
          }),
        ]),
      );
    } finally {
      f.db.close();
    }
  });

  it('runs multiple tool rounds and carries tools and final encrypted reasoning into the next question', async () => {
    const encrypted: OutputItem = {
      type: 'reasoning',
      id: 'rs_final',
      content: [],
      providerData: { encrypted_content: 'opaque-final' },
    };
    const f = await fixture([
      [call('call_one')],
      [call('call_two')],
      [encrypted, text('It is blue.')],
      [text('The earlier result was blue.')],
    ]);
    try {
      const first = await f.submit('Read the fixture twice.');
      const result = await f.executor.run(first.task.id, new AbortController().signal);
      expect(result.task.status).toBe('completed');
      expect(result.toolResults).toHaveLength(2);
      expect(result.events.filter((event) => event.type === 'model.turn')).toHaveLength(3);
      const second = await f.submit('What did you read?');
      expect((await f.executor.run(second.task.id, new AbortController().signal)).task.status).toBe(
        'completed',
      );
      const input = required(f.requests.at(-1)).input;
      expect(
        Array.isArray(input) && input.filter((item) => item.type === 'function_call_result'),
      ).toHaveLength(2);
      expect(JSON.stringify(input)).toContain('opaque-final');
      expect(JSON.stringify(input)).toContain('The fixture value is blue.');
      expect(f.tools.execute).toHaveBeenCalledTimes(2);
      expect(f.getModel).toHaveBeenCalledTimes(2);
      expect(f.getModel).toHaveBeenNthCalledWith(
        1,
        DEFAULT_APP_SETTINGS,
        first.task.conversationId,
      );
      expect(f.getModel).toHaveBeenNthCalledWith(
        2,
        DEFAULT_APP_SETTINGS,
        first.task.conversationId,
      );
    } finally {
      f.db.close();
    }
  });

  it('restores a saved window and old reply references without scanning unrelated messages', async () => {
    const f = await fixture([
      [text('Earlier image answer.')],
      [text('Recent answer.')],
      [text('Done.')],
    ]);
    try {
      const old = await f.submit('Remember an image.');
      await f.executor.run(old.task.id, new AbortController().signal);
      const target = required(
        (await f.conversations.listTaskMessages(old.task.id)).find(
          (message) => message.role === 'assistant',
        ),
      );
      const imageTarget = { ...target, attachmentIds: ['historical-image'] };
      await f.db.put('messages', imageTarget);
      const previous = await f.submit('A later question.');
      await f.executor.run(previous.task.id, new AbortController().signal);
      const saved = required(await f.tasks.getAgentSession('conversation'));
      const compacted = {
        ...saved,
        items: [{ type: 'compaction' as const, id: 'saved', encrypted_content: 'opaque-window' }],
      };
      await f.db.put('agent-sessions', compacted);
      await f.db.put('messages', {
        ...imageTarget,
        id: 'z-pending-supplement',
        taskId: previous.task.id,
        role: 'user',
        kind: 'supplement',
        text: 'Unconsumed user detail.',
        attachmentIds: [],
        createdAt: 300,
      });
      await f.db.put('messages', {
        ...imageTarget,
        id: 'a-pending-supplement',
        taskId: previous.task.id,
        role: 'user',
        kind: 'supplement',
        text: 'Later user detail.',
        attachmentIds: [],
        createdAt: 301,
      });
      // An unrelated historical task must remain available to history tools, but its messages
      // are not needed to restore a saved model window or the explicit older reply.
      const unrelated = { ...old.task, id: 'unrelated', ordinal: 0, status: 'completed' as const };
      await f.db.put('tasks', unrelated);
      const tx = f.db.transaction('messages', 'readwrite');
      for (let index = 0; index < 1_000; index++)
        await tx.store.put({
          ...target,
          id: `unrelated-${index}`,
          taskId: unrelated.id,
          text: 'Unrelated history.',
        });
      await tx.done;
      const next = await f.submit('Explain the earlier image answer.');
      const current = required((await f.conversations.listTaskMessages(next.task.id))[0]);
      await f.conversations.updateMessage({
        ...current,
        replyTo: {
          taskId: target.taskId,
          messageId: target.id,
          excerpt: target.text.slice(0, 1_000),
          attachmentCount: 1,
          createdAt: target.createdAt,
        },
      });
      const all = await f.conversations.listMessages('conversation');
      const tasks = await f.tasks.listByConversation('conversation');
      const restored = await restoreAgentSession(next.task, tasks, all, f.tasks);
      const expected = admitSessionMessages(
        restored,
        next.task,
        all.filter((message) => message.taskId === next.task.id),
        all,
        tasks,
      );
      const fullRead = vi.spyOn(f.conversations, 'listMessages');
      const taskRead = vi.spyOn(f.conversations, 'listTaskMessages');
      const contract = vi.spyOn(f.tools, 'contract');
      const result = await f.executor.run(next.task.id, new AbortController().signal);
      expect(result.task.status).toBe('completed');
      expect(required(f.requests.at(-1)).input).toEqual(expected.items);
      expect(JSON.stringify(expected.items).match(/Unconsumed user detail\./g)).toHaveLength(1);
      expect(JSON.stringify(expected.items)).toContain('Earlier image answer.');
      expect(fullRead).not.toHaveBeenCalled();
      expect(taskRead.mock.calls.map(([taskId]) => taskId)).not.toContain(unrelated.id);
      expect(taskRead.mock.calls.map(([taskId]) => taskId)).toContain(old.task.id);
      expect(contract.mock.calls[0]?.[0].conversationTasks).toContainEqual(unrelated);
    } finally {
      f.db.close();
    }
  });

  it('preserves a confirmed tool result when the model fails and the user starts another task', async () => {
    const f = await fixture([
      [call('call_done')],
      new Error('Synthetic provider failure'),
      [text('The saved value is blue.')],
    ]);
    try {
      const first = await f.submit('Read the fixture.');
      expect((await f.executor.run(first.task.id, new AbortController().signal)).task.status).toBe(
        'failed',
      );
      const second = await f.submit('Use the earlier observation.');
      expect((await f.executor.run(second.task.id, new AbortController().signal)).task.status).toBe(
        'completed',
      );
      expect(JSON.stringify(required(f.requests.at(-1)).input)).toContain(
        'The fixture value is blue.',
      );
      expect(f.tools.execute).toHaveBeenCalledOnce();
    } finally {
      f.db.close();
    }
  });

  it('retries a transient rejection and records both attempts without repeating the tool', async () => {
    const f = await fixture([
      [call('call_once')],
      providerErrorFromCode('TRANSIENT', { status: 503 }),
      [text('Recovered.')],
    ]);
    try {
      const task = await f.submit('Read once.');
      const result = await f.executor.run(task.task.id, new AbortController().signal);
      expect(result.task.status).toBe('completed');
      expect(f.requests).toHaveLength(3);
      expect(result.events.filter((event) => event.type === 'model.turn')).toHaveLength(3);
      expect(f.tools.execute).toHaveBeenCalledOnce();
    } finally {
      f.db.close();
    }
  });

  it('renders a completed answer even when the backend omits text deltas', async () => {
    const f = await fixture([[text('Final envelope answer.')]], { emitText: false });
    try {
      const task = await f.submit('Answer.');
      expect((await f.executor.run(task.task.id, new AbortController().signal)).task.status).toBe(
        'completed',
      );
    } finally {
      f.db.close();
    }
  });

  it('compacts at the discovered context budget and replays the returned native window', async () => {
    const compact = vi.fn(async () => ({
      items: [{ type: 'compaction' as const, id: 'compact_1', encrypted_content: 'opaque-window' }],
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    }));
    const f = await fixture([[call('call_before_compaction')], [text('Finished.')]], {
      backend: {
        listModels: async () => [
          {
            id: DEFAULT_APP_SETTINGS.model,
            name: 'Fixture',
            contextWindow: 11,
            defaultReasoningEffort: 'medium',
            reasoningEfforts: ['medium'],
          },
        ],
        compact,
      },
    });
    const invalidate = vi.spyOn(f.tools, 'contextCompacted');
    try {
      const task = await f.submit('Read once.');
      const result = await f.executor.run(task.task.id, new AbortController().signal);
      expect(result.task.status).toBe('completed');
      expect(compact).toHaveBeenCalledOnce();
      expect(invalidate).toHaveBeenCalledOnce();
      expect(compact).toHaveBeenCalledWith(
        DEFAULT_APP_SETTINGS,
        expect.any(Object),
        task.task.conversationId,
      );
      expect(required(f.requests[1]).input).toEqual([
        { type: 'compaction', id: 'compact_1', encrypted_content: 'opaque-window' },
      ]);
      expect(result.events.some((event) => event.type === 'context.compacted')).toBe(true);
      expect(result.events.filter((event) => event.type === 'model.turn')).toHaveLength(3);
      expect(f.tools.execute).toHaveBeenCalledOnce();
    } finally {
      f.db.close();
    }
  });

  it('retains the previous window and explicit failure evidence when compaction fails', async () => {
    const f = await fixture([[call('call_before_failure')]], {
      backend: {
        listModels: async () => [
          {
            id: DEFAULT_APP_SETTINGS.model,
            name: 'Fixture',
            contextWindow: 11,
            defaultReasoningEffort: 'medium',
            reasoningEfforts: ['medium'],
          },
        ],
        compact: async () => {
          throw providerErrorFromCode('INVALID_RESPONSE', {
            invalidResponseStage: 'compaction_schema',
          });
        },
      },
    });
    try {
      const task = await f.submit('Read once.');
      const result = await f.executor.run(task.task.id, new AbortController().signal);
      expect(result.task.status).toBe('failed');
      expect(
        JSON.stringify((await f.tasks.getAgentSession(task.task.conversationId))?.items),
      ).toContain('The fixture value is blue.');
      expect(
        result.events.some(
          (event) =>
            event.type === 'status.changed' && event.reason === 'context_compaction_failed',
        ),
      ).toBe(true);
    } finally {
      f.db.close();
    }
  });

  it('does not resurrect compacted tool results after another tool executes', async () => {
    const compactedInputs: ModelRequest['input'][] = [];
    const f = await fixture(
      [[call('before_compaction')], [call('after_compaction')], [text('Done.')]],
      {
        backend: {
          listModels: async () => [
            {
              id: DEFAULT_APP_SETTINGS.model,
              name: 'Fixture',
              contextWindow: 11,
              defaultReasoningEffort: 'medium',
              reasoningEfforts: ['medium'],
            },
          ],
          compact: async (_selection, request) => {
            compactedInputs.push(request.input);
            return {
              items: [
                {
                  type: 'compaction',
                  id: `compact_${compactedInputs.length}`,
                  encrypted_content: 'opaque',
                },
              ],
              usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
            };
          },
        },
      },
    );
    try {
      const task = await f.submit('Read, compact, read again, and finish.');
      const result = await f.executor.run(task.task.id, new AbortController().signal);
      expect(result.task.status).toBe('completed');
      expect(compactedInputs).toHaveLength(2);
      const second = required(compactedInputs[1]);
      if (!Array.isArray(second)) throw new Error('Compaction must receive structured items.');
      expect(second.map((item) => item.type)).toEqual([
        'compaction',
        'function_call',
        'function_call_result',
      ]);
      expect(
        second.filter((item) => item.type === 'function_call_result').map((item) => item.callId),
      ).toEqual(['after_compaction']);
      expect(f.tools.execute).toHaveBeenCalledTimes(2);
      expect(result.toolResults).toHaveLength(2);
    } finally {
      f.db.close();
    }
  });

  it('admits a supplement at a retry boundary once and preserves the interrupted draft as context', async () => {
    let taskId = '';
    const f = await fixture(
      [providerErrorFromCode('TRANSIENT'), [text('Answer with the new detail.')]],
      {
        partialError: 'First partial answer.',
        onAttempt: async (index) => {
          const at = f.clock.now();
          if (index === 1)
            await f.commands.appendSupplement({
              id: 'supplement_during_error',
              taskId,
              conversationId: 'conversation',
              kind: 'supplement',
              role: 'user',
              status: 'complete',
              text: 'Add the new detail.',
              attachmentIds: [],
              createdAt: at,
              updatedAt: at,
            });
        },
      },
    );
    try {
      taskId = (await f.submit('Answer.')).task.id;
      expect((await f.executor.run(taskId, new AbortController().signal)).task.status).toBe(
        'completed',
      );
      expect(f.requests).toHaveLength(2);
      const input = JSON.stringify(required(f.requests[1]).input);
      expect(input).toContain('First partial answer.');
      expect(input.match(/Add the new detail\./g)).toHaveLength(1);
      const replies = (await f.conversations.listTaskMessages(taskId))
        .filter((message) => message.role === 'assistant')
        .sort((a, b) => a.createdAt - b.createdAt);
      expect(replies.map((message) => message.status)).toEqual(['interrupted', 'complete']);
    } finally {
      f.db.close();
    }
  });

  it('preserves the original reply creation time when retrying a partial stream', async () => {
    const f = await fixture([providerErrorFromCode('TRANSIENT'), [text('Recovered')]], {
      partialError: 'Partial',
    });
    try {
      const { task } = await f.submit('Answer');
      const result = await f.executor.run(task.id, new AbortController().signal);
      expect(result.task.status).toBe('completed');
      const replies = (await f.conversations.listTaskMessages(task.id)).filter(
        (m) => m.role === 'assistant',
      );
      expect(replies).toHaveLength(1);
      const reply = required(replies[0]);
      const recorded = required(
        result.events.find((e) => e.type === 'message.recorded' && e.messageId === reply.id),
      );
      expect(reply).toMatchObject({ text: 'Recovered', createdAt: recorded.at });
      expect(reply.updatedAt).toBeGreaterThan(reply.createdAt);
    } finally {
      f.db.close();
    }
  });

  it.each(['TRANSIENT', 'INVALID_RESPONSE'] as const)(
    'stops after three %s retries, retaining failed-attempt metrics',
    async (code) => {
      const f = await fixture(
        Array.from({ length: 4 }, () =>
          providerErrorFromCode(code, {
            transientStage: 'stream_interrupted',
            invalidResponseStage: 'model_turn',
          }),
        ),
      );
      try {
        const task = await f.submit('Answer.');
        const result = await f.executor.run(task.task.id, new AbortController().signal);
        expect(result.task.status).toBe(code === 'TRANSIENT' ? 'paused' : 'failed');
        expect(f.requests).toHaveLength(4);
        expect(result.events.filter((event) => event.type === 'model.turn')).toHaveLength(4);
        expect(f.tools.execute).not.toHaveBeenCalled();
      } finally {
        f.db.close();
      }
    },
    10000,
  );

  it('archives native hosted search without converting it into a local function call', async () => {
    const hosted: OutputItem = {
      type: 'hosted_tool_call',
      id: 'web_call_1',
      name: 'web_search_call',
      status: 'completed',
      providerData: { action: { type: 'search', query: 'fixture' } },
    };
    const f = await fixture([[hosted, text('Found the fixture.')], [text('The same source.')]]);
    try {
      const first = await f.submit('Search.');
      const result = await f.executor.run(first.task.id, new AbortController().signal);
      expect(result.task.status).toBe('completed');
      expect(result.toolResults).toHaveLength(1);
      expect(result.toolResults[0]).toMatchObject({
        providerHosted: true,
        toolName: 'web_search_call',
      });
      expect(f.tools.execute).not.toHaveBeenCalled();
      const next = await f.submit('Recall the search.');
      await f.executor.run(next.task.id, new AbortController().signal);
      expect(required(f.requests[1]).input).toContainEqual(hosted);
    } finally {
      f.db.close();
    }
  });
});
