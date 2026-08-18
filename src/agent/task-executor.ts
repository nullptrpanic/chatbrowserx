import type { ConversationRepository } from '../persistence/conversation-repository';
import type { AttachmentRepository } from '../persistence/attachment-repository';
import type { BrowserExecutionPort } from '../browser/browser-execution-types';
import { TaskRepositoryConflictError, type TaskRepository } from '../persistence/task-repository';
import { isProviderError, type ProviderError } from '../providers/provider-errors';
import type { TavilyExecutionPort, TavilyResultSet } from '../providers/tavily/tavily-types';
import type { IdGenerator, TaskId } from '../shared/ids';
import type { Clock } from '../shared/time';
import type { Checkpoint, CompletedToolResult } from '../tasks/checkpoint-types';
import type { ContinuationItem, PendingToolCall } from '../tasks/continuation-types';
import type { TaskSnapshot } from '../tasks/task-command-service';
import type { TaskError } from '../tasks/task-errors';
import { TaskLeaseManager } from '../tasks/task-lease';
import { retainTaskReply } from '../tasks/task-reply-retention';
import { transitionTask } from '../tasks/task-transition';
import type { TaskEvent, TaskEventType, TaskRun } from '../tasks/task-types';
import type { AgentEvent, AgentPlanner } from './execution-types';
import { parseBrowserToolCall } from './tools/browser-tool-schema';
import { parseTavilyToolCall } from './tools/tavily-tool-schema';

export type TaskExecutorErrorCode =
  | 'TASK_NOT_FOUND'
  | 'CHECKPOINT_NOT_FOUND'
  | 'TASK_BUSY'
  | 'TASK_STATE_STALE'
  | 'PLANNER_RESULT_INVALID';

export class TaskExecutorError extends Error {
  readonly code: TaskExecutorErrorCode;

  constructor(code: TaskExecutorErrorCode, message: string) {
    super(message);
    this.name = 'TaskExecutorError';
    this.code = code;
  }
}

export interface TaskExecutorDependencies {
  readonly repository: TaskRepository;
  readonly conversations: Pick<
    ConversationRepository,
    'listMessages' | 'appendMessage' | 'updateMessage'
  >;
  readonly planner: AgentPlanner;
  readonly tavily: TavilyExecutionPort;
  readonly browser: BrowserExecutionPort;
  readonly attachments?: Pick<AttachmentRepository, 'addReference' | 'removeReference'>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

interface BoundaryInput {
  readonly type: TaskEventType;
  readonly reason: string;
  readonly error?: TaskError;
  readonly completedToolResults?: readonly CompletedToolResult[];
  readonly continuationItems?: readonly ContinuationItem[];
  readonly pendingToolCall?: PendingToolCall | null;
  readonly reasoningSummary?: string;
}

type AgentOutcome = Exclude<AgentEvent, { readonly type: 'reasoning.summary' }>;

const runnableStatuses = new Set<TaskRun['status']>(['queued', 'planning']);
const TAVILY_TOOL_CALL_LIMIT = 8;
const BROWSER_TOOL_CALL_LIMIT = 64;
const tavilyToolNames = new Set(['tavily_search', 'tavily_extract', 'tavily_crawl']);

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Task execution was aborted.', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function invalidPlannerResultError(): TaskError {
  return {
    code: 'InvalidProviderResponse',
    retryable: false,
    recoveryAction: 'review_provider_status',
    userMessage: 'The provider returned an invalid response.',
    evidenceRef: null,
  };
}

function taskInputError(): TaskError {
  return {
    code: 'TaskInputError',
    retryable: false,
    recoveryAction: 'review_task_input',
    userMessage: 'Task input could not be prepared.',
    evidenceRef: null,
  };
}

function toolCallLimitError(family: 'Tavily' | 'browser'): TaskError {
  return {
    code: 'ToolCallLimitError',
    retryable: false,
    recoveryAction: 'review_task_input',
    userMessage: `The task exceeded the ${family} tool-call limit.`,
    evidenceRef: null,
  };
}

function taskErrorFromProvider(error: ProviderError, source: 'model' | 'tavily'): TaskError {
  switch (error.code) {
    case 'AUTH':
      return {
        code: 'AuthError',
        retryable: false,
        recoveryAction: 'update_credentials',
        userMessage:
          source === 'tavily'
            ? 'Tavily authentication is required. Update the Tavily API Key in Settings.'
            : 'Provider authentication is required.',
        evidenceRef: null,
      };
    case 'RATE_LIMIT':
      return {
        code: 'RateLimitError',
        retryable: true,
        recoveryAction: 'resume_later',
        userMessage: 'The provider rate limit was reached.',
        evidenceRef: null,
      };
    case 'TRANSIENT':
      return {
        code: 'TransientProviderError',
        retryable: true,
        recoveryAction: 'resume_task',
        userMessage: 'The provider is temporarily unavailable.',
        evidenceRef: null,
      };
    case 'INVALID_RESPONSE':
      return {
        code: 'InvalidProviderResponse',
        retryable: false,
        recoveryAction: 'review_provider_status',
        userMessage: 'The provider returned an invalid response.',
        evidenceRef: null,
      };
    case 'ABORTED':
      return {
        code: 'TaskInterrupted',
        retryable: true,
        recoveryAction: 'resume_task',
        userMessage: 'The task was interrupted.',
        evidenceRef: null,
      };
  }
}

/** Runs a durable sequential Tavily/model loop with checkpointed results. */
export class TaskExecutor {
  readonly #dependencies: TaskExecutorDependencies;
  readonly #leases: TaskLeaseManager;

  constructor(dependencies: TaskExecutorDependencies) {
    this.#dependencies = dependencies;
    this.#leases = new TaskLeaseManager(dependencies.repository);
  }

  async run(taskId: TaskId, signal: AbortSignal): Promise<TaskSnapshot> {
    throwIfAborted(signal);
    const ownerId = this.#createId('runner');
    const acquired = await this.#leases.acquire(taskId, ownerId, this.#dependencies.clock.now());
    if (!acquired) throw new TaskExecutorError('TASK_BUSY', 'Task is already running.');

    try {
      let snapshot = await this.#loadSnapshot(taskId);
      if (!runnableStatuses.has(snapshot.task.status)) return snapshot;
      if (snapshot.task.status !== 'planning') {
        snapshot = await this.#saveBoundary(snapshot, ownerId, signal, {
          type: 'planning.started',
          reason: 'model_request_started',
        });
      }

      while (true) {
        throwIfAborted(signal);
        if (snapshot.checkpoint.pendingToolCall !== null) {
          snapshot = await this.#executePendingTool(snapshot, ownerId, signal);
          if (!runnableStatuses.has(snapshot.task.status)) return snapshot;
          continue;
        }
        snapshot = await this.#applySupplements(snapshot, ownerId, signal);
        let result: AgentOutcome;
        try {
          result = await this.#planOne(snapshot, signal, async (reasoningSummary) => {
            snapshot = await this.#saveBoundary(snapshot, ownerId, signal, {
              type: 'reasoning.summary-recorded',
              reason: 'model_reasoning_summary_recorded',
              reasoningSummary,
            });
          });
        } catch (error) {
          return await this.#handleFailure(snapshot, ownerId, signal, error, 'model');
        }

        if (result.type === 'task.completed') {
          const continuationItems = snapshot.checkpoint.continuationItems.some(
            (item) => item.type === 'message_ref' && item.messageId === result.messageId,
          )
            ? snapshot.checkpoint.continuationItems
            : [
                ...snapshot.checkpoint.continuationItems,
                { type: 'message_ref' as const, messageId: result.messageId },
              ];
          try {
            return await this.#saveBoundary(snapshot, ownerId, signal, {
              type: 'task.completed',
              reason: result.reason,
              continuationItems,
              pendingToolCall: null,
            });
          } catch (error) {
            if (!(error instanceof TaskRepositoryConflictError)) throw error;
            await this.#interruptReply(snapshot.task, result.messageId);
            continue;
          }
        }

        const call = result.type === 'browser.call' ? result.call : result;
        if (
          snapshot.checkpoint.completedToolResults.some(
            (completed) => completed.callId === call.callId,
          )
        ) {
          return this.#saveBoundary(snapshot, ownerId, signal, {
            type: 'task.failed',
            reason: 'duplicate_tool_call_id',
            error: invalidPlannerResultError(),
          });
        }
        const isBrowserCall = result.type === 'browser.call';
        const completedFamilyCalls = snapshot.checkpoint.completedToolResults.filter((completed) =>
          isBrowserCall
            ? completed.toolName.startsWith('browser_')
            : tavilyToolNames.has(completed.toolName),
        ).length;
        const familyLimit = isBrowserCall ? BROWSER_TOOL_CALL_LIMIT : TAVILY_TOOL_CALL_LIMIT;
        if (completedFamilyCalls >= familyLimit) {
          return this.#saveBoundary(snapshot, ownerId, signal, {
            type: 'task.failed',
            reason: `${isBrowserCall ? 'browser' : 'tavily'}_tool_call_limit_reached`,
            error: toolCallLimitError(isBrowserCall ? 'browser' : 'Tavily'),
          });
        }

        const toolName =
          result.type === 'browser.call' ? result.call.name : `tavily_${result.operation}`;

        snapshot = await this.#saveBoundary(snapshot, ownerId, signal, {
          type: 'tool.call-recorded',
          reason: `${toolName}_call_recorded`,
          continuationItems: [
            ...snapshot.checkpoint.continuationItems,
            {
              type: 'function_call',
              callId: call.callId,
              name: toolName,
              argumentsJson: call.argumentsJson,
            },
          ],
          pendingToolCall: {
            callId: call.callId,
            name: toolName,
            argumentsJson: call.argumentsJson,
            executionState: 'recorded',
          },
        });
      }
    } finally {
      await this.#leases.release(taskId, ownerId);
    }
  }

  /** Executes a durably recorded tool and prevents ambiguous browser mutations from replaying. */
  async #executePendingTool(
    snapshot: TaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<TaskSnapshot> {
    const pending = snapshot.checkpoint.pendingToolCall;
    if (pending === null) return snapshot;

    if (pending.name.startsWith('browser_')) {
      return this.#executePendingBrowserTool(snapshot, ownerId, signal, pending);
    }

    let call: Extract<AgentEvent, { readonly type: 'tavily.call' }>;
    let toolResult: TavilyResultSet;
    try {
      const parsed = parseTavilyToolCall(pending);
      call = { type: 'tavily.call', ...parsed };
      toolResult = await this.#executeTavily(call, signal);
    } catch (error) {
      return this.#handleFailure(snapshot, ownerId, signal, error, 'tavily');
    }

    return this.#recordToolResult(
      snapshot,
      ownerId,
      signal,
      pending,
      JSON.stringify({
        ok: true,
        results: toolResult.results,
        truncated: toolResult.truncated,
      }),
    );
  }

  async #executePendingBrowserTool(
    snapshot: TaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    pending: PendingToolCall,
  ): Promise<TaskSnapshot> {
    let call: ReturnType<typeof parseBrowserToolCall>;
    try {
      call = parseBrowserToolCall(pending);
    } catch (error) {
      return this.#handleFailure(snapshot, ownerId, signal, error, 'browser');
    }

    if (pending.executionState === 'may_have_dispatched') {
      return this.#recordToolResult(
        snapshot,
        ownerId,
        signal,
        pending,
        JSON.stringify({
          ok: false,
          code: 'AMBIGUOUS_MUTATION',
          message:
            'The previous browser action may already have run. Inspect the current page before choosing the next action.',
          retryable: false,
          needsInspect: true,
        }),
      );
    }

    if (call.replay === 'mutation') {
      snapshot = await this.#saveBoundary(snapshot, ownerId, signal, {
        type: 'tool.execution-started',
        reason: `${call.name}_execution_started`,
        pendingToolCall: { ...pending, executionState: 'may_have_dispatched' },
      });
    }

    try {
      const toolResult = await this.#dependencies.browser.execute(call, signal);
      return this.#recordToolResult(
        snapshot,
        ownerId,
        signal,
        pending,
        toolResult.output,
        toolResult.attachmentIds,
      );
    } catch (error) {
      return this.#handleFailure(snapshot, ownerId, signal, error, 'browser');
    }
  }

  async #recordToolResult(
    snapshot: TaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    pending: PendingToolCall,
    output: string,
    attachmentIds: readonly string[] = [],
  ): Promise<TaskSnapshot> {
    const durableAttachmentIds = [...new Set(attachmentIds)];
    if (
      durableAttachmentIds.length > 8 ||
      durableAttachmentIds.some((id) => id.length === 0 || id.length > 256)
    ) {
      throw new Error('Browser tool attachment references are invalid.');
    }
    const resultRef = this.#createId('toolResult');
    const referencedAttachmentIds: string[] = [];
    try {
      if (durableAttachmentIds.length > 0) {
        const attachments = this.#dependencies.attachments;
        if (!attachments) {
          throw new Error('Browser tool attachment persistence is unavailable.');
        }
        for (const id of durableAttachmentIds) {
          await attachments.addReference(id, resultRef);
          referencedAttachmentIds.push(id);
        }
      }
      const completedResult: CompletedToolResult = {
        callId: pending.callId,
        toolName: pending.name,
        argumentsJson: pending.argumentsJson,
        output,
        resultRef,
        attachmentIds: durableAttachmentIds,
      };
      return await this.#saveBoundary(snapshot, ownerId, signal, {
        type: 'tool.result-recorded',
        reason: `${pending.name}_result_recorded`,
        completedToolResults: [...snapshot.checkpoint.completedToolResults, completedResult],
        continuationItems: [
          ...snapshot.checkpoint.continuationItems,
          {
            type: 'function_call_output',
            callId: pending.callId,
            output,
            resultRef: completedResult.resultRef,
            attachmentIds: durableAttachmentIds,
          },
        ],
        pendingToolCall: null,
      });
    } catch (error) {
      const attachments = this.#dependencies.attachments;
      if (attachments && referencedAttachmentIds.length > 0) {
        await Promise.allSettled(
          referencedAttachmentIds.map((id) => attachments.removeReference(id, resultRef)),
        );
      }
      throw error;
    }
  }

  /** Commits every unconsumed WorkSession supplement before the next model request. */
  async #applySupplements(
    snapshot: TaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<TaskSnapshot> {
    const [messages, tasks] = await Promise.all([
      this.#dependencies.conversations.listMessages(snapshot.task.conversationId),
      this.#dependencies.repository.listByConversation(snapshot.task.conversationId),
    ]);
    const workSessionTaskIds = new Set(
      tasks
        .filter((task) => task.workSessionId === snapshot.task.workSessionId)
        .map((task) => task.id),
    );
    const referencedMessageIds = new Set(
      snapshot.checkpoint.continuationItems.flatMap((item) =>
        item.type === 'message_ref' ? [item.messageId] : [],
      ),
    );
    const supplements = messages
      .filter(
        (message) =>
          message.kind === 'supplement' &&
          message.taskId !== null &&
          workSessionTaskIds.has(message.taskId) &&
          !referencedMessageIds.has(message.id),
      )
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.updatedAt - right.updatedAt ||
          left.id.localeCompare(right.id),
      );
    if (supplements.length === 0) return snapshot;

    return this.#saveBoundary(snapshot, ownerId, signal, {
      type: 'task.supplements-applied',
      reason: 'user_supplements_applied',
      continuationItems: [
        ...snapshot.checkpoint.continuationItems,
        ...supplements.map((message): ContinuationItem => ({
          type: 'message_ref',
          messageId: message.id,
        })),
      ],
    });
  }

  /** Returns a just-completed reply to the reusable interrupted state without changing its text. */
  async #interruptReply(task: TaskRun, messageId: string): Promise<void> {
    const messages = await this.#dependencies.conversations.listMessages(task.conversationId);
    const message = messages.find(
      (candidate) =>
        candidate.id === messageId &&
        candidate.taskId === task.id &&
        candidate.kind === 'conversation' &&
        candidate.role === 'assistant',
    );
    if (message === undefined) {
      throw new TaskExecutorError('TASK_STATE_STALE', 'Completed reply message is missing.');
    }
    if (message.status === 'interrupted') return;
    if (message.status !== 'complete') {
      throw new TaskExecutorError('TASK_STATE_STALE', 'Completed reply message is invalid.');
    }
    await this.#dependencies.conversations.updateMessage({
      ...message,
      status: 'interrupted',
      updatedAt: Math.max(message.updatedAt, this.#dependencies.clock.now()),
    });
  }

  /** Persists progress events while collecting exactly one outcome for one model response. */
  async #planOne(
    snapshot: TaskSnapshot,
    signal: AbortSignal,
    onReasoningSummary: (summary: string) => Promise<void>,
  ): Promise<AgentOutcome> {
    let result: AgentOutcome | null = null;
    for await (const event of this.#dependencies.planner.plan(
      { task: snapshot.task, checkpoint: snapshot.checkpoint },
      signal,
    )) {
      throwIfAborted(signal);
      if (event.type === 'reasoning.summary') {
        if (result !== null) {
          throw new TaskExecutorError(
            'PLANNER_RESULT_INVALID',
            'Planner returned progress after its outcome.',
          );
        }
        await onReasoningSummary(event.text);
        continue;
      }
      if (result !== null) {
        throw new TaskExecutorError(
          'PLANNER_RESULT_INVALID',
          'Planner returned more than one result.',
        );
      }
      result = event;
    }
    if (result === null) {
      throw new TaskExecutorError('PLANNER_RESULT_INVALID', 'Planner returned no result.');
    }
    return result;
  }

  /** Dispatches one already validated Tavily call without parallel execution. */
  #executeTavily(
    event: Extract<AgentEvent, { readonly type: 'tavily.call' }>,
    signal: AbortSignal,
  ): Promise<TavilyResultSet> {
    switch (event.operation) {
      case 'search':
        return this.#dependencies.tavily.search(event.arguments, signal);
      case 'extract':
        return this.#dependencies.tavily.extract(event.arguments, signal);
      case 'crawl':
        return this.#dependencies.tavily.crawl(event.arguments, signal);
    }
  }

  /** Converts one safe model or Tavily failure into its durable task boundary. */
  async #handleFailure(
    snapshot: TaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    error: unknown,
    source: 'model' | 'tavily' | 'browser',
  ): Promise<TaskSnapshot> {
    if (signal.aborted || isAbortError(error)) throw error;
    if (error instanceof TaskExecutorError && error.code === 'PLANNER_RESULT_INVALID') {
      return this.#saveBoundary(snapshot, ownerId, signal, {
        type: 'task.failed',
        reason: 'invalid_planner_result',
        error: invalidPlannerResultError(),
      });
    }
    if (!isProviderError(error)) {
      return this.#saveBoundary(snapshot, ownerId, signal, {
        type: 'task.failed',
        reason:
          source === 'tavily'
            ? 'tavily_execution_failed'
            : source === 'browser'
              ? 'browser_execution_failed'
              : 'task_input_preparation_failed',
        error: taskInputError(),
      });
    }
    if (error.code === 'ABORTED') throw error;
    const taskError = taskErrorFromProvider(error, source === 'browser' ? 'model' : source);
    return this.#saveBoundary(snapshot, ownerId, signal, {
      type:
        error.code === 'AUTH'
          ? 'task.auth-required'
          : error.code === 'INVALID_RESPONSE'
            ? 'task.failed'
            : 'task.paused',
      reason:
        error.code === 'AUTH'
          ? `${source}_authentication_required`
          : error.code === 'INVALID_RESPONSE'
            ? `invalid_${source}_response`
            : `${source}_retry_required`,
      error: taskError,
    });
  }

  async #loadSnapshot(taskId: TaskId): Promise<TaskSnapshot> {
    const task = await this.#dependencies.repository.get(taskId);
    if (task === undefined) throw new TaskExecutorError('TASK_NOT_FOUND', 'Task does not exist.');
    if (task.checkpointId === null) {
      throw new TaskExecutorError('CHECKPOINT_NOT_FOUND', 'Task checkpoint is missing.');
    }
    const [checkpoint, events] = await Promise.all([
      this.#dependencies.repository.getCheckpoint(task.checkpointId),
      this.#dependencies.repository.listEvents(taskId),
    ]);
    if (checkpoint === undefined) {
      throw new TaskExecutorError('CHECKPOINT_NOT_FOUND', 'Task checkpoint is missing.');
    }
    return { task, checkpoint, events };
  }

  async #saveBoundary(
    snapshot: TaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    input: BoundaryInput,
  ): Promise<TaskSnapshot> {
    throwIfAborted(signal);
    const now = this.#dependencies.clock.now();
    const renewed = await this.#leases.renew(snapshot.task.id, ownerId, now);
    if (!renewed) throw new TaskExecutorError('TASK_BUSY', 'Task lease was lost.');
    const current = await this.#dependencies.repository.get(snapshot.task.id);
    if (current?.checkpointId !== snapshot.checkpoint.id) {
      throw new TaskExecutorError('TASK_STATE_STALE', 'Task changed during execution.');
    }

    const transitioned = transitionTask(
      { ...snapshot.task, lease: current.lease },
      {
        type: input.type,
        at: now,
        reason: input.reason,
        ...(input.error === undefined ? {} : { error: input.error }),
      },
    );
    const checkpointId = this.#createId('checkpoint');
    const task: TaskRun = { ...transitioned, checkpointId };
    const sequence = (snapshot.events.at(-1)?.sequence ?? 0) + 1;
    const event: TaskEvent = {
      id: this.#createId('event'),
      taskId: task.id,
      sequence,
      type: input.type,
      reason: input.reason,
      at: now,
      error: input.error ?? null,
      ...(input.reasoningSummary === undefined ? {} : { reasoningSummary: input.reasoningSummary }),
    };
    const checkpoint: Checkpoint = {
      ...snapshot.checkpoint,
      id: checkpointId,
      sequence,
      taskStatus: task.status,
      completedToolResults: input.completedToolResults ?? snapshot.checkpoint.completedToolResults,
      continuationItems: input.continuationItems ?? snapshot.checkpoint.continuationItems,
      pendingToolCall:
        input.pendingToolCall === undefined
          ? snapshot.checkpoint.pendingToolCall
          : input.pendingToolCall,
      createdAt: now,
    };
    await this.#dependencies.repository.saveTransition({ task, event, checkpoint });
    if (input.type === 'task.failed') {
      await retainTaskReply(task, 'error', this.#dependencies);
    }
    return { task, checkpoint, events: [...snapshot.events, event] };
  }

  #createId(prefix: string): string {
    const id = this.#dependencies.ids.create(prefix).trim();
    if (id.length === 0) {
      throw new TaskExecutorError('TASK_STATE_STALE', 'Identifier generation failed.');
    }
    return id;
  }
}
