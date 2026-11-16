import {
  Agent as FrameworkAgent,
  Runner,
  toolNamespace,
  type FunctionTool,
  type Model,
  type ModelRequest,
  type ResponseStreamEvent,
  type AgentInputItem,
  type AgentOutputItem,
} from '@openai/agents-core';
import type { ProviderRegistry } from '../providers/registry';
import type {
  AgentModelTurn,
  AgentPlanInput,
  AgentRunHooks,
  AgentRuntimePort,
  AssistantCommentary,
} from './execution-types';
import type { TaskRepository } from '../persistence/task-repository';
import type { ConversationRepository } from '../persistence/conversation-repository';
import type { AttachmentRepository } from '../persistence/attachment-repository';
import type { ToolRuntimePort, ModelToolContract, ValidatedToolCall } from '../tools/types';
import { qualifiedToolName, toolNameParts } from '../tools/model-tool';
import type { Clock } from '../shared/time';
import type { IdGenerator } from '../shared/ids';
import type { MessageRecord } from '../tasks/message-types';
import {
  admitSessionMessages,
  renderSessionItems,
  retiredToolOutput,
  restoreAgentSession,
  sessionToolResult,
} from './context/agent-session';
import { StreamPersistenceBuffer } from './stream-persistence-buffer';
import { isProviderError, providerErrorFromCode } from '../providers/provider-error';
import type { ModelActivity, ModelUsage } from '../providers/model-events';
import type { ModelRequest as GenerationRequest } from './model/model-provider';
import type { ModelStreamEvent } from '../providers/model-events';
import { prepareModelInput } from './model/model-input-preparation-error';

export interface AgentRuntimeDependencies {
  readonly providers: Pick<ProviderRegistry, 'resolve'>;
  readonly tools: ToolRuntimePort;
  readonly tasks: TaskRepository;
  readonly conversations: ConversationRepository;
  readonly attachments: Pick<AttachmentRepository, 'get'>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

function reportedUsage(raw: unknown): ModelUsage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as ModelUsage;
  return typeof value.inputTokens === 'number' &&
    typeof value.outputTokens === 'number' &&
    typeof value.totalTokens === 'number'
    ? value
    : null;
}

function assistantText(item: Extract<AgentOutputItem, { role: 'assistant' }>): string {
  return item.content
    .flatMap((part) =>
      part.type === 'output_text' ? [part.text] : part.type === 'refusal' ? [part.refusal] : [],
    )
    .join('\n');
}

function replyFromModelOutput(output: readonly AgentOutputItem[]) {
  const calls = output.flatMap((item, index) => {
    const callId =
      item.type === 'function_call'
        ? item.callId
        : item.type === 'hosted_tool_call'
          ? item.id
          : null;
    return callId ? [{ callId, index }] : [];
  });
  const continues = output.some((item) => item.type === 'function_call');
  const messages: string[] = [];
  const commentary: Extract<AssistantCommentary, { text: string }>[] = [];
  const answer: string[] = [];
  for (const [index, item] of output.entries()) {
    if (item.type !== 'message' || item.role !== 'assistant') continue;
    const text = assistantText(item);
    if (!text.trim()) continue;
    messages.push(text);
    if (continues || item.phase === 'commentary') {
      const callId = calls.find((call) => call.index > index)?.callId;
      commentary.push({
        text,
        ...(callId ? { callId } : {}),
        ...(item.id ? { itemId: item.id } : {}),
      });
    } else {
      answer.push(text);
    }
  }
  return {
    continues,
    text: messages.join('\n\n'),
    finalAnswer: answer.join('\n\n'),
    commentary,
  };
}

/** Framework iteration with host-owned checkpoints; no second model/tool loop. */
export class AgentRuntime implements AgentRuntimePort {
  constructor(private readonly dependencies: AgentRuntimeDependencies) {}

  /** Tool-free generation uses the same backend transport without creating a task or history. */
  async *stream(request: GenerationRequest, signal: AbortSignal): AsyncGenerator<ModelStreamEvent> {
    if (request.tools.length) throw new Error('Use the task runtime for tool execution.');
    const input: AgentInputItem[] = request.input.map((item) => {
      if (item.type !== 'message') throw new Error('Single generation accepts messages only.');
      if (item.role === 'assistant')
        return {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: item.content.flatMap((part) =>
            part.type === 'output_text' ? [{ type: 'output_text' as const, text: part.text }] : [],
          ),
        };
      return {
        type: 'message',
        role: 'user',
        content: item.content
          .filter((part) => part.type !== 'output_text')
          .map((part) =>
            part.type === 'input_image'
              ? { type: 'input_image' as const, image: part.imageUrl, detail: part.detail }
              : part,
          ),
      };
    });
    const { provider, settings } = await this.dependencies.providers.resolve();
    const model = await provider.getModel({
      model: request.model || settings.model,
      reasoningEffort: request.reasoningEffort || settings.reasoningEffort,
    });
    let textReceived = false;
    let completed = false;
    for await (const event of model.getStreamedResponse({
      input,
      systemInstructions: request.systemPrompt,
      tools: [],
      handoffs: [],
      outputType: 'text',
      tracing: false,
      signal,
      modelSettings: { store: false, preserveRawUsage: true, toolChoice: 'none' },
    })) {
      if (event.type === 'output_text_delta') {
        textReceived = true;
        yield { type: 'text.delta', delta: event.delta };
      }
      if (event.type === 'response_done') {
        for (const item of event.response.output) {
          if (item.type === 'function_call')
            yield { type: 'tool.started', callId: item.callId, name: item.name };
          if (!textReceived && item.type === 'message')
            for (const part of item.content)
              if (part.type === 'output_text') yield { type: 'text.delta', delta: part.text };
        }
        completed = true;
        yield {
          type: 'response.completed',
          responseId: event.response.id,
          usage: reportedUsage(event.response.rawUsage),
        };
      }
    }
    if (!completed)
      throw providerErrorFromCode('TRANSIENT', { transientStage: 'stream_interrupted' });
  }

  async run(hooks: AgentRunHooks, signal: AbortSignal): Promise<void> {
    const d = this.dependencies;
    let snapshot = await prepareModelInput('agent_context', hooks.prepare());
    const { provider, settings, providerId } = await prepareModelInput(
      'settings',
      d.providers.resolve(),
    );
    const [tasks, savedSession] = await prepareModelInput(
      'conversation_history',
      Promise.all([
        d.tasks.listByConversation(snapshot.task.conversationId),
        d.tasks.getAgentSession(snapshot.task.conversationId),
      ]),
    );
    const loadedTasks = new Set(
      savedSession ? [snapshot.task.id, savedSession.taskId] : tasks.map((task) => task.id),
    );
    const messages = await prepareModelInput(
      'conversation_history',
      savedSession
        ? Promise.all([...loadedTasks].map((id) => d.conversations.listTaskMessages(id))).then(
            (messages) => messages.flat(),
          )
        : d.conversations.listMessages(snapshot.task.conversationId),
    );
    const loadReplyTargets = async (inputs: readonly MessageRecord[]): Promise<void> => {
      const missing = new Set(
        inputs.flatMap((message) => {
          const id = message.replyTo?.taskId;
          return id && !loadedTasks.has(id) && tasks.some((task) => task.id === id) ? [id] : [];
        }),
      );
      const replies = await prepareModelInput(
        'conversation_history',
        Promise.all([...missing].map((id) => d.conversations.listTaskMessages(id))),
      );
      messages.push(...replies.flat());
      for (const id of missing) loadedTasks.add(id);
    };
    await loadReplyTargets(messages);
    messages.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let session = await prepareModelInput(
      'conversation_history',
      restoreAgentSession(snapshot.task, tasks, messages, d.tasks, savedSession),
    );
    if (session.providerId && session.providerId !== providerId)
      throw providerErrorFromCode('PROVIDER_MISMATCH');
    session = { ...session, providerId };
    // Discovery failure never makes an otherwise valid configured model unusable.
    let contextWindow: number | undefined;
    void provider
      .listModels(AbortSignal.any([signal, AbortSignal.timeout(5_000)]))
      .then((models) => {
        contextWindow = models.find((model) => model.id === settings.model)?.contextWindow;
      })
      .catch(() => undefined);
    const providerModel = await provider.getModel(settings, snapshot.task.conversationId);
    let contract: ModelToolContract;
    type PendingTurn = {
      metrics: AgentModelTurn;
      messageId: string | null;
      commentary: readonly AssistantCommentary[];
    };
    let pendingTurn: PendingTurn | null = null;
    let reply: { message: MessageRecord; buffer: StreamPersistenceBuffer } | null = null;
    let compactRequired = false;
    let compactedAfterLimit = false;
    let retryNeedsPreparation = false;

    const appendToolResult = (
      outcome: Pick<AgentPlanInput, 'toolResults' | 'checkpoint'>,
      callId: string,
    ) => {
      const result = outcome.toolResults.find((value) => value.callId === callId);
      if (!result) throw new Error('Executed tool has no durable result.');
      const reference = outcome.checkpoint.continuationItems.find(
        (value) => value.type === 'function_call_output_ref' && value.callId === callId,
      );
      const item = sessionToolResult({
        ...result,
        attachmentIds:
          reference?.type === 'function_call_output_ref' ? (reference.attachmentIds ?? []) : [],
      });
      session = { ...session, items: [...session.items, item] };
      return item.type === 'function_call_result' ? item.output : '';
    };

    const invokeTool = async (call: ValidatedToolCall) => {
      const outcome = await hooks.observe({
        type: 'tool.call',
        call,
        session,
        ...(pendingTurn?.commentary.length ? { commentary: pendingTurn.commentary } : {}),
        ...(pendingTurn ? { modelTurn: pendingTurn.metrics } : {}),
        ...(pendingTurn?.messageId
          ? {
              modelOutputItems: [
                { type: 'assistant_message_ref' as const, messageId: pendingTurn.messageId },
              ],
            }
          : {}),
      });
      pendingTurn = null;
      if (outcome.task.status !== 'planning' || !outcome.checkpoint)
        throw new Error('Task stopped at a tool boundary.');
      return appendToolResult({ ...outcome, checkpoint: outcome.checkpoint }, call.callId);
    };

    const prepare = async (): Promise<FunctionTool[]> => {
      snapshot = await prepareModelInput('agent_context', hooks.prepare());
      const currentMessages = await prepareModelInput(
        'conversation_history',
        d.conversations.listTaskMessages(snapshot.task.id),
      );
      await loadReplyTargets(currentMessages);
      const byId = new Map(
        [...messages, ...currentMessages].map((message) => [message.id, message]),
      );
      const inputMessages = snapshot.checkpoint.continuationItems.flatMap((item) => {
        const message = item.type === 'message_ref' ? byId.get(item.messageId) : undefined;
        return message ? [message] : [];
      });
      session = admitSessionMessages(
        session,
        snapshot.task,
        inputMessages,
        [...byId.values()],
        tasks,
      );
      contract = await prepareModelInput(
        'tool_contract',
        d.tools.contract({ ...snapshot, conversationTasks: tasks }, signal),
      );
      agent.instructions = [settings.systemPrompt, contract.systemPrompt]
        .filter(Boolean)
        .join('\n\n');
      agent.modelSettings.toolChoice =
        typeof contract.toolChoice === 'object'
          ? contract.toolChoice.name
          : (contract.toolChoice ?? 'auto');
      return contract.definitions.flatMap((definition) => {
        const { name, namespace } = toolNameParts(definition.name);
        const tool: FunctionTool = {
          ...definition,
          name,
          parameters: definition.parameters as FunctionTool['parameters'],
          needsApproval: async () => false,
          isEnabled: async () => true,
          invoke: async (_context, input, details) => {
            const callId = details?.toolCall?.callId;
            if (!callId) throw new Error('Framework tool call has no identity.');
            return invokeTool(
              contract.parse({ callId, name: definition.name, argumentsJson: input }),
            );
          },
        };
        return namespace
          ? toolNamespace({ name: namespace, description: `${namespace} tools`, tools: [tool] })
          : [tool];
      });
    };

    const ensureReply = async (): Promise<StreamPersistenceBuffer> => {
      if (reply) return reply.buffer;
      const at = d.clock.now();
      const committedIds = new Set(
        snapshot.checkpoint.continuationItems.flatMap((item) =>
          item.type === 'message_ref'
            ? [item.messageId]
            : item.type === 'function_call'
              ? (item.modelOutputItems ?? []).flatMap((output) =>
                  output.type === 'assistant_message_ref' ? [output.messageId] : [],
                )
              : [],
        ),
      );
      const boundary =
        snapshot.events.findLast(
          (event) =>
            event.type === 'supplement.applied' && event.runId === snapshot.checkpoint.runId,
        )?.sequence ?? 0;
      const reusableIds = new Set(
        snapshot.events.flatMap((event) =>
          event.type === 'message.recorded' &&
          event.runId === snapshot.checkpoint.runId &&
          event.sequence > boundary
            ? [event.messageId]
            : [],
        ),
      );
      const taskMessages = new Map(
        (await d.conversations.listTaskMessages(snapshot.task.id)).map((message) => [
          message.id,
          message,
        ]),
      );
      const previous = [...reusableIds]
        .reverse()
        .map((id) => taskMessages.get(id))
        .find((message) => message?.role === 'assistant' && !committedIds.has(message.id));
      const message: MessageRecord = {
        id: previous?.id ?? d.ids.create('message'),
        kind: 'conversation',
        conversationId: snapshot.task.conversationId,
        taskId: snapshot.task.id,
        role: 'assistant',
        status: 'streaming',
        text: '',
        attachmentIds: [],
        createdAt: at,
        updatedAt: at,
      };
      if (previous)
        await d.conversations.updateMessage({ ...message, createdAt: previous.createdAt });
      else await d.tasks.appendTaskMessage({ message, eventId: d.ids.create('event'), at });
      reply = { message, buffer: new StreamPersistenceBuffer(d.conversations, message, d.clock) };
      return reply.buffer;
    };

    const observedModel: Model = {
      getResponse: (request) => providerModel.getResponse(request),
      ...(providerModel.getRetryAdvice
        ? { getRetryAdvice: (request) => providerModel.getRetryAdvice?.(request) }
        : {}),
      getStreamedResponse: async function* (
        request: ModelRequest,
      ): AsyncGenerator<ResponseStreamEvent> {
        if (retryNeedsPreparation) {
          await prepare();
          retryNeedsPreparation = false;
        }
        if (
          compactRequired ||
          (contextWindow !== undefined &&
            session.lastInputTokens !== null &&
            session.lastInputTokens >= contextWindow * 0.85)
        ) {
          const started = d.clock.now();
          const inputItemCount = session.items.length;
          await hooks.observe({ type: 'context.compaction', phase: 'started', session });
          try {
            const compacted = await provider.compact(
              settings,
              {
                ...request,
                input: await prepareModelInput(
                  'agent_context',
                  renderSessionItems(session.items, d.attachments),
                ),
              },
              snapshot.task.conversationId,
            );
            signal.throwIfAborted();
            if (compacted.items.length === 0)
              throw providerErrorFromCode('INVALID_RESPONSE', {
                invalidResponseStage: 'compaction_schema',
              });
            const next = { ...session, items: compacted.items, lastInputTokens: null };
            await hooks.observe({
              type: 'context.compaction',
              phase: 'completed',
              session: next,
              modelTurn: {
                kind: 'compaction',
                inputItemCount,
                elapsedMs: Math.max(0, d.clock.now() - started),
                firstEventMs: 0,
                usage: compacted.usage,
              },
            });
            session = next;
            if (compactRequired) compactedAfterLimit = true;
            compactRequired = false;
          } catch (error) {
            if (!signal.aborted)
              await hooks.observe({
                type: 'context.compaction',
                phase: 'failed',
                session,
                modelTurn: {
                  kind: 'compaction',
                  inputItemCount,
                  elapsedMs: Math.max(0, d.clock.now() - started),
                  firstEventMs: 0,
                  usage: isProviderError(error) ? error.usage : null,
                },
              });
            throw error;
          }
        }
        const started = d.clock.now();
        let firstEvent: number | undefined;
        let firstText: number | undefined;
        let lastTextItem: string | undefined;
        let hasDraftText = false;
        let finalAnswerStarted = false;
        let usage: ModelUsage | null = null;
        let completed = false;
        const summary = new Map<string, string>();
        const displayedItems = new Set<string>();
        const finalAnswerItems = new Set<string>();
        const streamedCommentary = new Map<string, { index: number; callId?: string }>();
        const streamedHostedCalls = new Set<string>();
        let summarySaved = '';
        let summarySavedAt = 0;
        const appendText = async (text: string, itemId?: string) => {
          const isFinalAnswer = itemId !== undefined && finalAnswerItems.has(itemId);
          if (!text || (finalAnswerStarted && !isFinalAnswer)) return;
          firstText ??= d.clock.now();
          const buffer = await ensureReply();
          if (isFinalAnswer && !finalAnswerStarted) {
            await buffer.startFinalAnswer(text);
            finalAnswerStarted = true;
          } else {
            const newItem = hasDraftText && itemId !== lastTextItem;
            await buffer.append(newItem ? `\n\n${text}` : text);
          }
          if (itemId !== undefined) displayedItems.add(itemId);
          lastTextItem = itemId;
          hasDraftText = true;
        };
        const observeActivity = async (activity: ModelActivity) => {
          if (
            activity.type === 'reasoning_summary_delta' ||
            activity.type === 'reasoning_summary_done'
          ) {
            const text =
              activity.type === 'reasoning_summary_delta'
                ? `${summary.get(activity.key) ?? ''}${activity.delta}`
                : activity.text;
            summary.set(activity.key, text.slice(0, 20_000));
            if (
              activity.type === 'reasoning_summary_done' ||
              !summarySaved ||
              d.clock.now() - summarySavedAt >= 1000
            )
              await flushSummary();
          } else if (activity.type === 'assistant_final_answer') {
            finalAnswerItems.add(activity.itemId);
            if (
              activity.text !== undefined &&
              (!finalAnswerStarted || !displayedItems.has(activity.itemId))
            )
              await appendText(activity.text, activity.itemId);
          } else if (activity.type === 'assistant_commentary') {
            const { itemId, index, text } = activity;
            if (streamedCommentary.has(itemId)) return;
            streamedCommentary.set(itemId, { index });
            if (!displayedItems.has(itemId)) await appendText(text, itemId);
            await hooks.observe({ type: 'assistant.commentary', item: { itemId, text } });
          } else if (activity.type === 'hosted_tool_done') {
            const { item, index } = activity;
            const callId = item.id;
            if (!callId || streamedHostedCalls.has(callId)) return;
            streamedHostedCalls.add(callId);
            const commentary: AssistantCommentary[] = [];
            for (const [itemId, entry] of streamedCommentary) {
              if (entry.callId !== undefined || entry.index >= index) continue;
              entry.callId = callId;
              commentary.push({ itemId, callId });
            }
            await hooks.observe({ type: 'tool.hosted', item, commentary });
          }
        };
        const flushSummary = async () => {
          const text = [...summary.values()].join('\n\n').slice(-20_000);
          if (text && text !== summarySaved) {
            await hooks.observe({ type: 'reasoning.summary', text });
            summarySaved = text;
            summarySavedAt = d.clock.now();
          }
        };
        const metrics = (): AgentModelTurn => ({
          inputItemCount: Array.isArray(request.input) ? request.input.length : 1,
          elapsedMs: Math.max(0, d.clock.now() - started),
          firstEventMs: firstEvent === undefined ? 0 : firstEvent - started,
          ...(firstText === undefined ? {} : { firstTextMs: firstText - started }),
          usage,
        });
        try {
          const rendered = await prepareModelInput(
            'agent_context',
            renderSessionItems(session.items, d.attachments),
          );
          for await (const event of providerModel.getStreamedResponse({
            ...request,
            input: rendered,
          })) {
            firstEvent ??= d.clock.now();
            if (event.type === 'output_text_delta') {
              await appendText(event.delta, event.itemId);
            } else if (
              event.type === 'model' &&
              typeof event.event === 'object' &&
              event.event !== null
            ) {
              await observeActivity(event.event as ModelActivity);
            } else if (event.type === 'response_done') {
              const { output } = event.response;
              for (const item of output) {
                if (item.type !== 'reasoning') continue;
                for (const [index, part] of item.content.entries()) {
                  if (part.text.trim())
                    summary.set(`${item.id}:${index}`, part.text.slice(0, 20_000));
                }
              }
              await flushSummary();
              usage = reportedUsage(event.response.rawUsage);
              session = {
                ...session,
                items: [...session.items, ...output],
                lastInputTokens: usage?.inputTokens ?? session.lastInputTokens,
              };
              const presentation = replyFromModelOutput(output);
              const remainingCommentary: AssistantCommentary[] = presentation.commentary.flatMap(
                (item): AssistantCommentary[] => {
                  const previous = item.itemId && streamedCommentary.get(item.itemId);
                  if (!previous) return [item];
                  return item.itemId && item.callId && previous.callId !== item.callId
                    ? [{ itemId: item.itemId, callId: item.callId }]
                    : [];
                },
              );
              const hostedCalls = output.filter((item) => item.type === 'hosted_tool_call');
              const reportedAtEnd = new Set<string>();
              for (const item of hostedCalls) {
                if (!item.id || streamedHostedCalls.has(item.id)) continue;
                reportedAtEnd.add(item.id);
                await hooks.observe({
                  type: 'tool.hosted',
                  item,
                  session,
                  commentary: remainingCommentary.filter(({ callId }) => callId === item.id),
                });
              }
              const commentary = remainingCommentary.filter(
                ({ callId }) => callId === undefined || !reportedAtEnd.has(callId),
              );
              if (!reply && presentation.text)
                await (await ensureReply()).append(presentation.text);
              const messageId = reply?.message.id ?? null;
              if (messageId)
                session = {
                  ...session,
                  admittedMessageIds: [...new Set([...session.admittedMessageIds, messageId])],
                };
              if (reply !== null) {
                if (presentation.continues) await reply.buffer.interrupt();
                else
                  await reply.buffer.complete(
                    presentation.text ? presentation.finalAnswer : undefined,
                  );
              }
              pendingTurn = {
                metrics: metrics(),
                messageId,
                commentary,
              };
              reply = null;
              completed = true;
            }
            // UI persistence consumes deltas above. Only a completed response is committed to
            // Runner, so its retry policy can replace an interrupted draft before tool dispatch.
            if (event.type === 'response_done') yield event;
          }
          if (!completed)
            throw providerErrorFromCode('TRANSIENT', { transientStage: 'stream_interrupted' });
        } catch (error) {
          if (isProviderError(error)) usage = error.usage;
          retryNeedsPreparation = true;
          if (isProviderError(error) && error.code === 'CONTEXT_LIMIT' && !compactedAfterLimit)
            compactRequired = true;
          if (reply) {
            await reply.buffer.interrupt();
            reply = null;
          }
          if (!signal.aborted) {
            const outcome = await hooks.observe({
              type: 'session.updated',
              session,
              reason: 'model_request_failed',
              modelTurn: metrics(),
            });
            if (outcome.checkpoint) snapshot = { ...outcome, checkpoint: outcome.checkpoint };
          }
          throw error;
        }
      },
    };
    const agent = new FrameworkAgent({
      name: 'ChatBrowserX',
      model: observedModel,
      tools: [],
      // prepare() refreshes the choice every turn; the SDK must not clear that new constraint.
      resetToolChoice: false,
      modelSettings: {
        store: false,
        preserveRawUsage: true,
        parallelToolCalls: false,
        retry: {
          maxRetries: 3,
          backoff: { initialDelayMs: 500, maxDelayMs: 3000 },
          policy: ({ error, normalized }) => {
            if (isProviderError(error))
              return {
                retry:
                  error.retryable ||
                  (error.code === 'INVALID_RESPONSE' &&
                    error.invalidResponseStage !== 'request_contract' &&
                    error.invalidResponseStage !== 'compaction_schema') ||
                  (error.code === 'CONTEXT_LIMIT' && compactRequired),
                approveUnsafeReplay: true,
              };
            return (
              !normalized.isAbort &&
              (normalized.isNetworkError ||
                normalized.statusCode === 429 ||
                (normalized.statusCode ?? 0) >= 500)
            );
          },
        },
      },
    });
    agent.getAllTools = prepare;
    // A completed model response may contain several calls. The host recovers any dispatched
    // call first; only the still-unrecorded suffix can be admitted as new work after a restart.
    const resolved = new Set(
      session.items
        .filter((item) => item.type === 'function_call_result')
        .map((item) => item.callId),
    );
    for (const call of session.items.filter(
      (item) => item.type === 'function_call' && !resolved.has(item.callId),
    )) {
      if (call.type !== 'function_call') continue;
      await prepare();
      const name = qualifiedToolName(call.name, call.namespace);
      const receipt = snapshot.toolResults.find((result) => result.callId === call.callId);
      if (receipt) {
        if (receipt.toolName !== name || receipt.argumentsJson !== call.arguments)
          throw new Error('Recorded tool call differs from its durable receipt.');
        appendToolResult(snapshot, call.callId);
        continue;
      }
      const retiredOutput = retiredToolOutput(name);
      if (retiredOutput !== undefined) {
        session = {
          ...session,
          items: [
            ...session.items,
            {
              type: 'function_call_result',
              name: call.name,
              callId: call.callId,
              status: 'completed',
              output: retiredOutput,
            },
          ],
        };
        continue;
      }
      await invokeTool(
        d.tools.parseRecorded({ callId: call.callId, name, argumentsJson: call.arguments }),
      );
    }
    const runner = new Runner({
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
      // Dynamic availability can retire a tool the model saw earlier; let it recover
      // from the SDK's error result without dispatching the unavailable call.
      toolNotFoundBehavior: 'return_error_to_model',
      toolExecution: { maxFunctionToolConcurrency: 1 },
      callModelInputFilter: async ({ modelData }) => {
        // SDK-generated validation results have no external effects but remain part of the transcript.
        // The SDK may still hold pre-compaction outputs; only current calls can admit a result.
        const calls = new Set(
          session.items.filter((item) => item.type === 'function_call').map((item) => item.callId),
        );
        const known = new Set(
          session.items
            .filter((item) => item.type === 'function_call_result')
            .map((item) => item.callId),
        );
        const additional = modelData.input.filter(
          (item) =>
            item.type === 'function_call_result' &&
            calls.has(item.callId) &&
            !known.has(item.callId),
        );
        if (additional.length) session = { ...session, items: [...session.items, ...additional] };
        await hooks.observe({ type: 'session.updated', session, reason: 'model_request_started' });
        return { input: [...session.items], instructions: agent.instructions as string };
      },
    });
    // Only completion review / newly accepted user input starts another framework run.
    while (!signal.aborted) {
      const stream = await runner.run(agent, [...session.items], {
        stream: true,
        signal,
        maxTurns: 512,
      });
      for await (const event of stream) {
        void event; // UI and durable writes are awaited at the backend/tool boundaries.
      }
      await stream.completed;
      signal.throwIfAborted();
      const turn = pendingTurn as PendingTurn | null;
      if (!turn?.messageId)
        throw providerErrorFromCode('INVALID_RESPONSE', { invalidResponseStage: 'model_turn' });
      const outcome = await hooks.observe({
        type: 'task.completed',
        reason: 'model_response_completed',
        messageId: turn.messageId,
        modelTurn: turn.metrics,
        commentary: turn.commentary,
        session,
      });
      if (outcome.task.status !== 'planning') return;
      if (!outcome.checkpoint) return;
      snapshot = { ...outcome, checkpoint: outcome.checkpoint };
      const review = await d.tools.reviewCompletion?.({ ...snapshot });
      if (review?.type === 'continue')
        session = {
          ...session,
          items: [
            ...session.items,
            {
              role: 'user',
              content: JSON.stringify({
                type: 'runtime_completion_review',
                source: review.toolName,
                feedback: review.feedback,
              }),
            },
          ],
        };
      pendingTurn = null;
    }
    signal.throwIfAborted();
  }
}
