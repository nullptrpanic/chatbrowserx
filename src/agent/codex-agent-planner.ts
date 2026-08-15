import type { AttachmentRepository } from '../persistence/attachment-repository';
import type { ConversationRepository } from '../persistence/conversation-repository';
import type { SettingsStore } from '../persistence/settings-store';
import { CODEX_MODEL } from '../providers/codex/codex-constants';
import { isProviderError, providerErrorFromCode } from '../providers/provider-errors';
import type { ModelProvider } from '../providers/provider-types';
import type { ModelStreamEvent } from '../providers/stream-events';
import type { IdGenerator } from '../shared/ids';
import type { Clock } from '../shared/time';
import type { MessageRecord } from '../tasks/message-types';
import { buildAgentContext } from './context/agent-context';
import type { AgentEvent, AgentPlanInput, AgentPlanner } from './execution-types';
import { StreamPersistenceBuffer } from './stream-persistence-buffer';
import { bindBrowserToolAction, BROWSER_TOOL_DEFINITION } from './tools/browser-tool-schema';
import { TAVILY_TOOL_DEFINITIONS } from './tools/tavily-tool-schema';
import { parseToolCall, ToolCallError, type ParsedToolCall } from './tools/tool-parser';

export interface CodexAgentPlannerDependencies {
  readonly provider: ModelProvider;
  readonly settings: Pick<SettingsStore, 'get'>;
  readonly conversations: Pick<
    ConversationRepository,
    'listMessages' | 'appendMessage' | 'updateMessage'
  >;
  readonly attachments: Pick<AttachmentRepository, 'get'>;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

interface CompletedCall {
  readonly callId: string;
  readonly name: string;
  readonly argumentsJson: string;
}

/** Requires a complete and internally consistent normalized Provider response. */
function inspectStreamEvent(
  event: ModelStreamEvent,
  state: {
    responseId: string | null;
    completed: boolean;
    call: CompletedCall | null;
  },
): void {
  if (event.type === 'response.started') {
    if (state.responseId !== null || state.completed) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    state.responseId = event.responseId;
  } else if (event.type === 'tool.completed') {
    if (state.call !== null || state.completed) {
      throw new ToolCallError('INVALID_ARGUMENTS');
    }
    state.call = {
      callId: event.callId,
      name: event.name,
      argumentsJson: event.argumentsJson,
    };
  } else if (event.type === 'response.completed') {
    if (state.responseId === null || state.completed || event.responseId !== state.responseId) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    state.completed = true;
  } else if (state.completed) {
    throw providerErrorFromCode('INVALID_RESPONSE');
  }
}

export class CodexAgentPlanner implements AgentPlanner {
  readonly #dependencies: CodexAgentPlannerDependencies;

  /** Creates one model-turn planner around bounded context, tools, and message persistence. */
  constructor(dependencies: CodexAgentPlannerDependencies) {
    this.#dependencies = dependencies;
  }

  /** Runs one model turn and yields exactly one browser/Tavily call or final completion. */
  async *plan(input: AgentPlanInput, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    await this.#interruptStaleMessages(input);
    const settings = await this.#dependencies.settings.get();
    const context = await buildAgentContext(
      {
        task: input.task,
        checkpoint: input.checkpoint,
        observation: input.observation,
        customSystemPrompt: settings.systemPrompt,
        visualImageUrl: input.visualImageUrl ?? null,
      },
      {
        conversations: this.#dependencies.conversations,
        attachments: this.#dependencies.attachments,
      },
    );
    const now = this.#dependencies.clock.now();
    const message: MessageRecord = {
      id: this.#dependencies.ids.create('message'),
      conversationId: input.task.conversationId,
      taskId: input.task.id,
      role: 'assistant',
      status: 'streaming',
      text: '',
      attachmentIds: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.#dependencies.conversations.appendMessage(message);
    const buffer = new StreamPersistenceBuffer(
      this.#dependencies.conversations,
      message,
      this.#dependencies.clock,
    );
    const state: {
      responseId: string | null;
      completed: boolean;
      call: CompletedCall | null;
    } = { responseId: null, completed: false, call: null };
    let hasText = false;

    try {
      for await (const event of this.#dependencies.provider.stream(
        {
          model: CODEX_MODEL,
          reasoningEffort: settings.reasoningEffort,
          systemPrompt: context.systemPrompt,
          input: context.input,
          tools: [BROWSER_TOOL_DEFINITION, ...TAVILY_TOOL_DEFINITIONS],
        },
        signal,
      )) {
        inspectStreamEvent(event, state);
        if (event.type === 'text.delta') {
          hasText ||= /\S/.test(event.delta);
          await buffer.append(event.delta);
        }
      }
      if (!state.completed) {
        throw providerErrorFromCode('INVALID_RESPONSE');
      }

      const parsed = state.call === null ? null : parseToolCall(state.call);
      if (parsed === null && !hasText) {
        throw providerErrorFromCode('INVALID_RESPONSE');
      }
      const result = this.#toAgentEvent(parsed, state.call, input);
      await buffer.complete();
      yield result;
    } catch (error) {
      if (
        signal.aborted ||
        (isProviderError(error) && ['ABORTED', 'TRANSIENT', 'RATE_LIMIT'].includes(error.code))
      ) {
        await buffer.interrupt();
      } else {
        await buffer.fail();
      }
      throw error;
    }
  }

  /** Marks messages abandoned by a previous worker instance before starting a replacement turn. */
  async #interruptStaleMessages(input: AgentPlanInput): Promise<void> {
    const messages = await this.#dependencies.conversations.listMessages(input.task.conversationId);
    const now = this.#dependencies.clock.now();
    await Promise.all(
      messages
        .filter(
          (message) =>
            message.taskId === input.task.id &&
            message.role === 'assistant' &&
            message.status === 'streaming',
        )
        .map((message) =>
          this.#dependencies.conversations.updateMessage({
            ...message,
            status: 'interrupted',
            updatedAt: Math.max(message.updatedAt, now),
          }),
        ),
    );
  }

  /** Converts one validated model tool into the stable planner event union. */
  #toAgentEvent(
    parsed: ParsedToolCall | null,
    completed: CompletedCall | null,
    input: AgentPlanInput,
  ): AgentEvent {
    if (parsed === null || completed === null) {
      return { type: 'task.completed', reason: 'model_response_completed' };
    }
    if (parsed.name === 'browser.act') {
      if (input.task.tabId === null) {
        throw new ToolCallError('INVALID_ARGUMENTS');
      }
      return {
        type: 'browser.action',
        callId: completed.callId,
        argumentsJson: completed.argumentsJson,
        action: bindBrowserToolAction(parsed.arguments, {
          actionId: this.#dependencies.ids.create('action'),
          tabId: input.task.tabId,
        }),
      };
    }
    if (parsed.name === 'tavily.search') {
      return {
        type: 'tavily.call',
        callId: completed.callId,
        argumentsJson: completed.argumentsJson,
        operation: 'search',
        arguments: parsed.arguments,
      };
    }
    if (parsed.name === 'tavily.extract') {
      return {
        type: 'tavily.call',
        callId: completed.callId,
        argumentsJson: completed.argumentsJson,
        operation: 'extract',
        arguments: parsed.arguments,
      };
    }
    return {
      type: 'tavily.call',
      callId: completed.callId,
      argumentsJson: completed.argumentsJson,
      operation: 'crawl',
      arguments: parsed.arguments,
    };
  }
}
