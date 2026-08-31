import type { AttachmentRepository } from '../persistence/attachment-repository';
import type { ConversationRepository } from '../persistence/conversation-repository';
import type { SettingsStore } from '../persistence/settings-store';
import type { TaskRepository } from '../persistence/task-repository';
import { CODEX_MODEL } from '../providers/codex/codex-constants';
import {
  isProviderError,
  providerErrorFromCode,
  throwWithInvalidResponseStage,
} from '../providers/provider-errors';
import type { ModelProvider } from '../providers/provider-types';
import type { ModelStreamEvent, ModelUsage } from '../providers/stream-events';
import type { IdGenerator } from '../shared/ids';
import type { Clock } from '../shared/time';
import {
  sandboxCatalogForToolResults,
  sandboxCatalogInstructions,
  type SkillCatalogPort,
} from '../sandbox/skill-catalog';
import type { MessageRecord } from '../tasks/message-types';
import { orderTaskMessagesByEvent } from '../tasks/task-message-order';
import type { ModelOutputContinuationItem } from '../tasks/continuation-types';
import { buildAgentContext } from './context/agent-context';
import type { AgentEvent, AgentModelTurn, AgentPlanInput, AgentPlanner } from './execution-types';
import { StreamPersistenceBuffer } from './stream-persistence-buffer';
import { browserToolContractForCheckpoint } from './tools/browser-tool-availability';
import { parseBrowserToolCall } from './tools/browser-tool-schema';
import { SANDBOX_TOOL_DEFINITIONS, parseSandboxToolCall } from './tools/sandbox-tool-schema';
import { HISTORY_TOOL_DEFINITIONS, parseHistoryToolCall } from './tools/history-tool-schema';
import { TAVILY_TOOL_DEFINITIONS, parseTavilyToolCall } from './tools/tavily-tool-schema';
import { loadConversationView, type ConversationView } from './conversation-view';

export interface TavilyAvailabilityPort {
  isConfigured(): Promise<boolean>;
}

export interface CodexAgentPlannerDependencies {
  readonly provider: ModelProvider;
  readonly tavilyAvailability: TavilyAvailabilityPort;
  readonly skillCatalog?: SkillCatalogPort;
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
const readableHistoryStatuses = new Set(['completed', 'failed', 'cancelled']);

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

export class CodexAgentPlanner implements AgentPlanner {
  readonly #dependencies: CodexAgentPlannerDependencies;

  /** Creates one text/image model-turn planner around bounded context and message persistence. */
  constructor(dependencies: CodexAgentPlannerDependencies) {
    this.#dependencies = dependencies;
  }

  /** Runs one model turn that yields either one validated Tavily call or final text. */
  async *plan(input: AgentPlanInput, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const browserContract = browserToolContractForCheckpoint({
      checkpoint: input.checkpoint,
      toolResults: input.toolResults,
    });
    const optionalToolsAvailable = browserContract.toolChoice === undefined;
    const [settings, conversationView, tavilyConfigured, skillCatalog] = await Promise.all([
      this.#dependencies.settings.get(),
      loadConversationView(input.task.conversationId, this.#dependencies),
      optionalToolsAvailable
        ? this.#dependencies.tavilyAvailability.isConfigured().catch(() => false)
        : Promise.resolve(false),
      optionalToolsAvailable
        ? (this.#dependencies.skillCatalog?.get(signal).catch(() => null) ?? Promise.resolve(null))
        : Promise.resolve(null),
    ]);
    const tools = [
      ...browserContract.tools,
      ...(tavilyConfigured ? TAVILY_TOOL_DEFINITIONS : []),
      ...(skillCatalog === null ? [] : SANDBOX_TOOL_DEFINITIONS),
      ...(optionalToolsAvailable &&
      conversationView.tasks.some(
        (task) => task.id !== input.task.id && readableHistoryStatuses.has(task.status),
      )
        ? HISTORY_TOOL_DEFINITIONS
        : []),
    ];
    const availableToolNames = new Set(tools.map(({ name }) => name));
    if (availableToolNames.size !== tools.length) {
      throw new Error('Model tool definitions contain duplicate names.');
    }
    const context = await buildAgentContext(
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
    const catalogInstructions =
      skillCatalog === null
        ? ''
        : sandboxCatalogInstructions(sandboxCatalogForToolResults(skillCatalog, input.toolResults));
    const systemPrompt =
      catalogInstructions.length === 0
        ? context.systemPrompt
        : `${context.systemPrompt}\n\n${catalogInstructions}`;
    const reusableMessage = await this.#prepareReusableMessage(input, conversationView);
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
          model: CODEX_MODEL,
          reasoningEffort: settings.reasoningEffort,
          systemPrompt,
          input: context.input,
          tools,
          ...(browserContract.toolChoice === undefined
            ? {}
            : { toolChoice: browserContract.toolChoice }),
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
        if (state.tool.name.startsWith('browser_')) {
          let call: ReturnType<typeof parseBrowserToolCall>;
          try {
            call = parseBrowserToolCall(source);
          } catch (error) {
            throwWithInvalidResponseStage(error, 'tool_call');
          }
          yield { type: 'browser.call', call, modelTurn, modelOutputItems };
          return;
        }
        if (state.tool.name.startsWith('sandbox_')) {
          let call: ReturnType<typeof parseSandboxToolCall>;
          try {
            call = parseSandboxToolCall(source);
          } catch (error) {
            throwWithInvalidResponseStage(error, 'tool_call');
          }
          yield { type: 'sandbox.call', call, modelTurn, modelOutputItems };
          return;
        }
        if (
          state.tool.name === 'history_read' ||
          state.tool.name === 'result_read'
        ) {
          let call: ReturnType<typeof parseHistoryToolCall>;
          try {
            call = parseHistoryToolCall(source);
          } catch (error) {
            throwWithInvalidResponseStage(error, 'tool_call');
          }
          yield { type: 'history.call', call, modelTurn, modelOutputItems };
          return;
        }
        let call: ReturnType<typeof parseTavilyToolCall>;
        try {
          call = parseTavilyToolCall(source);
        } catch (error) {
          throwWithInvalidResponseStage(error, 'tool_call');
        }
        yield { type: 'tavily.call', ...call, modelTurn, modelOutputItems };
        return;
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
