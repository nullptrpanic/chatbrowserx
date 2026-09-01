import type { AttachmentRepository } from '../../persistence/attachment-repository';
import type { ConversationRepository } from '../../persistence/conversation-repository';
import type { SettingsStore } from '../../persistence/settings-store';
import type { TaskRepository } from '../../persistence/task-repository';
import {
  isProviderError,
  providerErrorFromCode,
  throwWithInvalidResponseStage,
} from './model-provider-error';
import type { ModelProviderPort } from './model-provider';
import type { ModelStreamEvent, ModelUsage } from './model-stream-event';
import type { IdGenerator } from '../../shared/ids';
import type { Clock } from '../../shared/time';
import type { MessageRecord } from '../../tasks/message-types';
import { orderTaskMessagesByEvent } from '../../tasks/task-message-order';
import type { ModelOutputContinuationItem } from '../../tasks/continuation-types';
import { buildAgentContext } from '../context/agent-context';
import type { AgentEvent, AgentModelTurn, AgentPlanInput, AgentPlanner } from '../execution-types';
import { StreamPersistenceBuffer } from '../stream-persistence-buffer';
import { loadConversationView, type ConversationView } from '../conversation-view';
import type { ModelToolContract, ToolRuntimePort } from '../../tools/types';

export interface ModelTurnPlannerDependencies {
  readonly provider: ModelProviderPort;
  readonly model: string;
  readonly tools: ToolRuntimePort;
  readonly settings: Pick<SettingsStore, 'get'>;
  readonly conversations: Pick<ConversationRepository, 'listMessages' | 'updateMessage'>;
  readonly tasks: Pick<
    TaskRepository,
    'listByConversation' | 'readTaskMessageEvents' | 'appendTaskMessage'
  >;
  readonly attachments: Pick<AttachmentRepository, 'get'>;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

interface ToolTurnState {
  readonly callId: string;
  readonly name: string;
  completed: boolean;
  argumentsJson: string | null;
}

interface ModelTurnState {
  responseId: string | null;
  completed: boolean;
  usage: ModelUsage | null;
  hasText: boolean;
  tool: ToolTurnState | null;
}

const MAX_REASONING_SUMMARY_CHARS = 20_000;

/** Requires a complete and internally consistent normalized Provider response envelope. */
function inspectEnvelopeEvent(event: ModelStreamEvent, state: ModelTurnState): void {
  if (event.type === 'response.started') {
    if (state.responseId !== null || state.completed) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    state.responseId = event.responseId;
  } else if (event.type === 'response.completed') {
    if (
      state.responseId === null ||
      state.completed ||
      event.responseId !== state.responseId ||
      (state.tool !== null && !state.tool.completed)
    ) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    state.completed = true;
    state.usage = event.usage;
  } else if (state.responseId === null || state.completed) {
    throw providerErrorFromCode('INVALID_RESPONSE');
  }
}

/** Accepts one and only one internally consistent function-call sequence. */
function inspectToolEvent(event: ModelStreamEvent, state: ModelTurnState): void {
  if (event.type === 'tool.started') {
    if (state.responseId === null || state.tool !== null) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    state.tool = {
      callId: event.callId,
      name: event.name,
      completed: false,
      argumentsJson: null,
    };
  } else if (event.type === 'tool.arguments.delta') {
    if (state.tool === null || state.tool.completed || state.tool.callId !== event.callId) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
  } else if (event.type === 'tool.completed') {
    if (
      state.tool === null ||
      state.tool.completed ||
      state.tool.callId !== event.callId ||
      state.tool.name !== event.name
    ) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    state.tool.completed = true;
    state.tool.argumentsJson = event.argumentsJson;
  }
}

export class ModelTurnPlanner implements AgentPlanner {
  readonly #dependencies: ModelTurnPlannerDependencies;

  /** Creates one text/image model-turn planner around bounded context and message persistence. */
  constructor(dependencies: ModelTurnPlannerDependencies) {
    this.#dependencies = dependencies;
  }

  /** Runs one model turn that yields either one validated Tavily call or final text. */
  async *plan(input: AgentPlanInput, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const toolContext = {
      task: input.task,
      checkpoint: input.checkpoint,
      toolResults: input.toolResults,
    };
    const settingsPromise = this.#dependencies.settings.get();
    const conversationViewPromise = loadConversationView(
      input.task.conversationId,
      this.#dependencies,
    );
    const [settings, conversationView] = await Promise.all([
      settingsPromise,
      conversationViewPromise,
    ]);
    const contractPromise = this.#dependencies.tools.contract(
      { ...toolContext, conversationTasks: conversationView.tasks },
      signal,
    );
    const contextPromise = buildAgentContext(
      {
        task: input.task,
        checkpoint: input.checkpoint,
        toolResults: input.toolResults,
        customSystemPrompt: settings.systemPrompt,
        historyMessageLimit: settings.historyMessageLimit,
      },
      {
        conversationView,
        attachments: this.#dependencies.attachments,
      },
    );
    const reusableMessagePromise = this.#prepareReusableMessage(input, conversationView);
    const [registeredContract, context, reusableMessage] = await Promise.all([
      contractPromise,
      contextPromise,
      reusableMessagePromise,
    ]);
    const tools = registeredContract.definitions;
    const availableToolNames = new Set(tools.map(({ name }) => name));
    if (availableToolNames.size !== tools.length) {
      throw new Error('Model tool definitions contain duplicate names.');
    }
    const systemPrompt = [context.systemPrompt, registeredContract.systemPrompt]
      .filter((section) => section.length > 0)
      .join('\n\n');
    const state: ModelTurnState = {
      responseId: null,
      completed: false,
      usage: null,
      hasText: false,
      tool: null,
    };
    let pendingText = '';
    let buffer: StreamPersistenceBuffer | null = null;
    let bufferFinalized = false;
    let assistantMessageId: string | null = null;
    const modelOutputItems: ModelOutputContinuationItem[] = [];
    const turnStartedAt = this.#dependencies.clock.now();
    let firstEventAt: number | null = null;
    let firstTextAt: number | null = null;

    try {
      for await (const event of this.#dependencies.provider.stream(
        {
          model: this.#dependencies.model,
          reasoningEffort: settings.reasoningEffort,
          systemPrompt,
          input: context.input,
          tools,
          ...(registeredContract.toolChoice === undefined
            ? {}
            : { toolChoice: registeredContract.toolChoice }),
        },
        signal,
      )) {
        const eventAt = this.#dependencies.clock.now();
        firstEventAt ??= eventAt;
        if (event.type === 'text.delta') firstTextAt ??= eventAt;
        inspectEnvelopeEvent(event, state);
        inspectToolEvent(event, state);
        if (event.type === 'reasoning.encrypted') {
          modelOutputItems.push({
            type: 'reasoning',
            itemId: event.itemId,
            encryptedContent: event.encryptedContent,
            summary: event.summary,
          });
        } else if (event.type === 'reasoning.summary') {
          if (state.responseId === null) {
            throw providerErrorFromCode('INVALID_RESPONSE');
          }
          const summary = event.text.trim().slice(0, MAX_REASONING_SUMMARY_CHARS);
          if (summary.length > 0) {
            yield { type: 'reasoning.summary', text: summary };
          }
        } else if (event.type === 'text.delta') {
          if (buffer !== null) {
            await buffer.append(event.delta);
          } else {
            pendingText += event.delta;
            if (/\S/.test(pendingText)) {
              state.hasText = true;
              const now = this.#dependencies.clock.now();
              const message: MessageRecord =
                reusableMessage === null
                  ? {
                      id: this.#dependencies.ids.create('message'),
                      kind: 'conversation',
                      conversationId: input.task.conversationId,
                      taskId: input.task.id,
                      role: 'assistant',
                      status: 'streaming',
                      text: '',
                      attachmentIds: [],
                      createdAt: now,
                      updatedAt: now,
                    }
                  : {
                      ...reusableMessage,
                      status: 'streaming',
                      text: '',
                      attachmentIds: [],
                      updatedAt: Math.max(reusableMessage.updatedAt, now),
                    };
              if (reusableMessage === null) {
                await this.#dependencies.tasks.appendTaskMessage({
                  message,
                  eventId: this.#dependencies.ids.create('event'),
                  at: now,
                });
              } else {
                await this.#dependencies.conversations.updateMessage(message);
              }
              assistantMessageId = message.id;
              buffer = new StreamPersistenceBuffer(
                this.#dependencies.conversations,
                message,
                this.#dependencies.clock,
              );
              await buffer.append(pendingText);
              pendingText = '';
            }
          }
        }
      }
      if (!state.completed) {
        throw providerErrorFromCode('INVALID_RESPONSE');
      }
      if (state.responseId === null || firstEventAt === null) {
        throw providerErrorFromCode('INVALID_RESPONSE');
      }
      const completedAt = this.#dependencies.clock.now();
      const modelTurn: AgentModelTurn = {
        inputItemCount: context.input.length,
        elapsedMs: Math.max(0, completedAt - turnStartedAt),
        firstEventMs: Math.max(0, firstEventAt - turnStartedAt),
        ...(firstTextAt === null ? {} : { firstTextMs: Math.max(0, firstTextAt - turnStartedAt) }),
        usage: state.usage,
      };

      if (state.tool !== null) {
        if (!state.tool.completed || state.tool.argumentsJson === null) {
          throw providerErrorFromCode('INVALID_RESPONSE');
        }
        if (state.hasText && (buffer === null || assistantMessageId === null)) {
          throw providerErrorFromCode('INVALID_RESPONSE');
        }
        if (!availableToolNames.has(state.tool.name)) {
          throw providerErrorFromCode('INVALID_RESPONSE', {
            invalidResponseStage: 'tool_call',
          });
        }
        const source = {
          callId: state.tool.callId,
          name: state.tool.name,
          argumentsJson: state.tool.argumentsJson,
        };
        if (buffer !== null) {
          await buffer.interrupt();
          bufferFinalized = true;
          if (assistantMessageId === null) {
            throw providerErrorFromCode('INVALID_RESPONSE');
          }
          modelOutputItems.push({
            type: 'assistant_message_ref',
            messageId: assistantMessageId,
          });
        }
        if (registeredContract.definitions.some(({ name }) => name === state.tool?.name)) {
          let call: ReturnType<ModelToolContract['parse']>;
          try {
            call = registeredContract.parse(source);
          } catch {
            throw providerErrorFromCode('INVALID_RESPONSE', {
              invalidResponseStage: 'tool_call',
            });
          }
          yield { type: 'tool.call', call, modelTurn, modelOutputItems };
          return;
        }
        throw providerErrorFromCode('INVALID_RESPONSE', {
          invalidResponseStage: 'tool_call',
        });
      }
      if (!state.hasText || buffer === null || assistantMessageId === null) {
        throw providerErrorFromCode('INVALID_RESPONSE');
      }
      await buffer.complete();
      bufferFinalized = true;
      yield {
        type: 'task.completed',
        reason: 'model_response_completed',
        messageId: assistantMessageId,
        modelTurn,
      };
    } catch (error) {
      if (buffer !== null && !bufferFinalized) {
        if (
          signal.aborted ||
          (isProviderError(error) &&
            ['ABORTED', 'TRANSIENT', 'RATE_LIMIT', 'INVALID_RESPONSE'].includes(error.code))
        ) {
          await buffer.interrupt();
        } else {
          await buffer.fail();
        }
      }
      throwWithInvalidResponseStage(error, 'model_turn');
    }
  }

  /** Normalizes stale or uncommitted replies and returns the latest one for in-place regeneration. */
  async #prepareReusableMessage(
    input: AgentPlanInput,
    conversationView: ConversationView,
  ): Promise<MessageRecord | null> {
    const { messages } = conversationView;
    const now = this.#dependencies.clock.now();
    const checkpointMessageIds = new Set(
      input.checkpoint.continuationItems.flatMap((item) => {
        if (item.type === 'message_ref') return [item.messageId];
        if (item.type !== 'function_call') return [];
        return (item.modelOutputItems ?? []).flatMap((output) =>
          output.type === 'assistant_message_ref' ? [output.messageId] : [],
        );
      }),
    );
    const taskReplies = orderTaskMessagesByEvent(
      messages,
      input.events,
      input.task.id,
      'conversation',
    ).filter((message) => message.kind === 'conversation' && message.role === 'assistant');
    const reusableReplies = taskReplies.filter(
      (message) =>
        message.status === 'streaming' ||
        message.status === 'interrupted' ||
        (message.status === 'complete' && !checkpointMessageIds.has(message.id)),
    );
    const reusable = reusableReplies.at(-1);
    await Promise.all(
      reusableReplies
        .filter((message) => message.status !== 'interrupted')
        .map((message) =>
          this.#dependencies.conversations.updateMessage({
            ...message,
            status: 'interrupted',
            updatedAt: Math.max(message.updatedAt, now),
          }),
        ),
    );
    return reusable === undefined
      ? null
      : {
          ...reusable,
          status: 'interrupted',
          updatedAt:
            reusable.status === 'streaming' || reusable.status === 'complete'
              ? Math.max(reusable.updatedAt, now)
              : reusable.updatedAt,
        };
  }
}
