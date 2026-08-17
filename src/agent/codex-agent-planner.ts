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

/** Requires a complete and internally consistent normalized Provider response. */
function inspectStreamEvent(
  event: ModelStreamEvent,
  state: {
    responseId: string | null;
    completed: boolean;
  },
): void {
  if (event.type === 'response.started') {
    if (state.responseId !== null || state.completed) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    state.responseId = event.responseId;
  } else if (
    event.type === 'tool.started' ||
    event.type === 'tool.arguments.delta' ||
    event.type === 'tool.completed'
  ) {
    throw providerErrorFromCode('INVALID_RESPONSE');
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

  /** Creates one text/image model-turn planner around bounded context and message persistence. */
  constructor(dependencies: CodexAgentPlannerDependencies) {
    this.#dependencies = dependencies;
  }

  /** Runs one model turn with no registered concrete tools and yields final completion. */
  async *plan(input: AgentPlanInput, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    await this.#interruptStaleMessages(input);
    const settings = await this.#dependencies.settings.get();
    const context = await buildAgentContext(
      {
        task: input.task,
        checkpoint: input.checkpoint,
        customSystemPrompt: settings.systemPrompt,
        historyMessageLimit: settings.historyMessageLimit,
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
    } = { responseId: null, completed: false };
    let hasText = false;

    try {
      for await (const event of this.#dependencies.provider.stream(
        {
          model: CODEX_MODEL,
          reasoningEffort: settings.reasoningEffort,
          systemPrompt: context.systemPrompt,
          input: context.input,
          tools: [],
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

      if (!hasText) {
        throw providerErrorFromCode('INVALID_RESPONSE');
      }
      await buffer.complete();
      yield { type: 'task.completed', reason: 'model_response_completed' };
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
}
