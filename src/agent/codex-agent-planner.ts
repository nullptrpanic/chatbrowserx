import type { AttachmentRepository } from '../persistence/attachment-repository';
import type { ConversationRepository } from '../persistence/conversation-repository';
import type { SettingsStore } from '../persistence/settings-store';
import type { TaskRepository } from '../persistence/task-repository';
import { CODEX_MODEL } from '../providers/codex/codex-constants';
import { isProviderError, providerErrorFromCode } from '../providers/provider-errors';
import type { ModelProvider } from '../providers/provider-types';
import type { ModelStreamEvent, ModelUsage } from '../providers/stream-events';
import type { IdGenerator } from '../shared/ids';
import type { Clock } from '../shared/time';
import type { MessageRecord } from '../tasks/message-types';
import { buildAgentContext } from './context/agent-context';
import { hasContextCommitCandidate } from './context/context-commit';
import type { AgentEvent, AgentModelTurn, AgentPlanInput, AgentPlanner } from './execution-types';
import { StreamPersistenceBuffer } from './stream-persistence-buffer';
import { BROWSER_TOOL_DEFINITIONS, parseBrowserToolCall } from './tools/browser-tool-schema';
import {
  CONTEXT_COMMIT_TOOL_DEFINITION,
  CONTEXT_COMMIT_TOOL_NAME,
  parseContextCommitToolCall,
} from './tools/context-commit-tool-schema';
import { TAVILY_TOOL_DEFINITIONS, parseTavilyToolCall } from './tools/tavily-tool-schema';

export interface TavilyAvailabilityPort {
  isConfigured(): Promise<boolean>;
}

export interface CodexAgentPlannerDependencies {
  readonly provider: ModelProvider;
  readonly tavilyAvailability: TavilyAvailabilityPort;
  readonly settings: Pick<SettingsStore, 'get'>;
  readonly conversations: Pick<
    ConversationRepository,
    'listMessages' | 'appendMessage' | 'updateMessage'
  >;
  readonly tasks: Pick<TaskRepository, 'listByConversation'>;
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

export class CodexAgentPlanner implements AgentPlanner {
  readonly #dependencies: CodexAgentPlannerDependencies;

  /** Creates one text/image model-turn planner around bounded context and message persistence. */
  constructor(dependencies: CodexAgentPlannerDependencies) {
    this.#dependencies = dependencies;
  }

  /** Runs one model turn that yields either one validated Tavily call or final text. */
  async *plan(input: AgentPlanInput, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const reusableMessage = await this.#prepareReusableMessage(input);
    const settings = await this.#dependencies.settings.get();
    let tavilyConfigured: boolean;
    try {
      tavilyConfigured = await this.#dependencies.tavilyAvailability.isConfigured();
    } catch {
      tavilyConfigured = false;
    }
    const tools = [
      ...BROWSER_TOOL_DEFINITIONS,
      ...(tavilyConfigured ? TAVILY_TOOL_DEFINITIONS : []),
      ...(hasContextCommitCandidate(input.checkpoint.continuationItems)
        ? [CONTEXT_COMMIT_TOOL_DEFINITION]
        : []),
    ];
    const availableToolNames = new Set(tools.map(({ name }) => name));
    const context = await buildAgentContext(
      {
        task: input.task,
        checkpoint: input.checkpoint,
        customSystemPrompt: settings.systemPrompt,
        historyMessageLimit: settings.historyMessageLimit,
      },
      {
        conversations: this.#dependencies.conversations,
        tasks: this.#dependencies.tasks,
        attachments: this.#dependencies.attachments,
      },
    );
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
    const turnStartedAt = this.#dependencies.clock.now();
    let firstEventAt: number | null = null;
    let firstTextAt: number | null = null;

    try {
      for await (const event of this.#dependencies.provider.stream(
        {
          model: CODEX_MODEL,
          reasoningEffort: settings.reasoningEffort,
          systemPrompt: context.systemPrompt,
          input: context.input,
          tools,
        },
        signal,
      )) {
        const eventAt = this.#dependencies.clock.now();
        firstEventAt ??= eventAt;
        if (event.type === 'text.delta') firstTextAt ??= eventAt;
        inspectEnvelopeEvent(event, state);
        inspectToolEvent(event, state);
        if (event.type === 'reasoning.summary') {
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
                await this.#dependencies.conversations.appendMessage(message);
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
          throw providerErrorFromCode('INVALID_RESPONSE');
        }
        const source = {
          callId: state.tool.callId,
          name: state.tool.name,
          argumentsJson: state.tool.argumentsJson,
        };
        if (state.tool.name === CONTEXT_COMMIT_TOOL_NAME) {
          const call = parseContextCommitToolCall(source);
          if (buffer !== null) {
            await buffer.interrupt();
            bufferFinalized = true;
          }
          yield { type: 'context.commit', call, modelTurn };
          return;
        }
        if (state.tool.name.startsWith('browser_')) {
          const call = parseBrowserToolCall(source);
          if (buffer !== null) {
            await buffer.interrupt();
            bufferFinalized = true;
          }
          yield { type: 'browser.call', call, modelTurn };
          return;
        }
        const call = parseTavilyToolCall(source);
        if (buffer !== null) {
          await buffer.interrupt();
          bufferFinalized = true;
        }
        yield { type: 'tavily.call', ...call, modelTurn };
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
          (isProviderError(error) && ['ABORTED', 'TRANSIENT', 'RATE_LIMIT'].includes(error.code))
        ) {
          await buffer.interrupt();
        } else {
          await buffer.fail();
        }
      }
      throw error;
    }
  }

  /** Normalizes stale or uncommitted replies and returns the latest one for in-place regeneration. */
  async #prepareReusableMessage(input: AgentPlanInput): Promise<MessageRecord | null> {
    const messages = await this.#dependencies.conversations.listMessages(input.task.conversationId);
    const now = this.#dependencies.clock.now();
    const checkpointMessageIds = new Set(
      input.checkpoint.continuationItems.flatMap((item) =>
        item.type === 'message_ref' ? [item.messageId] : [],
      ),
    );
    const taskReplies = messages.filter(
      (message) =>
        message.kind === 'conversation' &&
        message.taskId === input.task.id &&
        message.role === 'assistant',
    );
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
