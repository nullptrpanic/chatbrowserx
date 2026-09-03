import type { ConversationRepository } from '../persistence/conversation-repository';
import { TaskRepositoryConflictError, type TaskRepository } from '../persistence/task-repository';
import {
  isProviderError,
  providerErrorFromCode,
  type ProviderError,
} from './model/model-provider-error';
import type { IdGenerator, TaskId, TaskRunId } from '../shared/ids';
import type { Clock } from '../shared/time';
import type { Checkpoint } from '../tasks/checkpoint-types';
import type { ContinuationItem, PendingToolCall } from '../tasks/continuation-types';
import type { TaskSnapshot } from '../tasks/task-command-service';
import type { TaskError } from '../tasks/task-errors';
import { TaskLeaseManager } from '../tasks/task-lease';
import { transitionTask, type TaskTransitionType } from '../tasks/task-transition';
import type { Task, TaskEvent, TaskModelTurnMetrics, TaskRun } from '../tasks/task-types';
import type { MaterializedToolResult, ToolResult } from '../tasks/tool-result-types';
import { selectPendingTaskSupplements } from '../tasks/task-supplements';
import type { AgentEvent, AgentModelTurn, AgentPlanner } from './execution-types';
import type { ToolExecutionPolicy, ToolRuntimePort, ValidatedToolCall } from '../tools/types';
import { isModelInputPreparationError } from './model/model-input-preparation-error';

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
  readonly conversations: Pick<ConversationRepository, 'listMessages' | 'updateMessage'>;
  readonly planner: AgentPlanner;
  readonly tools: ToolRuntimePort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface BoundaryInput {
  readonly type: TaskTransitionType;
  readonly reason: string;
  readonly error?: TaskError;
  readonly toolResults?: readonly MaterializedToolResult[];
  readonly continuationItems?: readonly ContinuationItem[];
  readonly pendingToolCall?: PendingToolCall | null;
  readonly reasoningSummary?: string;
  readonly modelTurn?: TaskModelTurnMetrics;
  readonly browserToolCallsInAttempt?: number;
  readonly browserTargetTabId?: number | null;
  readonly supplementIds?: readonly string[];
  readonly lastModelInputTokens?: number | null;
}

interface ActiveTaskSnapshot extends TaskSnapshot {
  readonly checkpoint: Checkpoint;
}

type AgentOutcome = Exclude<AgentEvent, { readonly type: 'reasoning.summary' }>;

const runnableStatuses = new Set<TaskRun['status']>(['queued', 'planning']);
/** Number of retries after the initial request for transient Provider failures. */
const MODEL_TRANSIENT_RETRY_LIMIT = 3;
const MODEL_TRANSIENT_RETRY_DELAYS_MS = Object.freeze([500, 1_500, 3_000] as const);
/** Number of retries after invalid model responses within one planning attempt. */
const MODEL_INVALID_RESPONSE_RETRY_LIMIT = 3;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Task execution was aborted.', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function sleepWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      globalThis.clearTimeout(timer);
      reject(new DOMException('Task execution was aborted.', 'AbortError'));
    };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
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

function modelInputPreparationStage(error: unknown): string | null {
  return isModelInputPreparationError(error) ? error.stage : null;
}

function taskInputError(error: unknown): TaskError {
  const stage = modelInputPreparationStage(error);
  return {
    code: 'TaskInputError',
    retryable: false,
    recoveryAction: 'review_task_input',
    userMessage:
      stage === null
        ? 'Task input could not be prepared.'
        : `Task input could not be prepared (stage: ${stage}).`,
    evidenceRef: stage === null ? null : `input_preparation:${stage}`,
  };
}

function toolCallLimitError(family: string): TaskError {
  return {
    code: 'ToolCallLimitError',
    retryable: false,
    recoveryAction: 'review_task_input',
    userMessage: `The task exceeded the ${family} tool-call limit.`,
    evidenceRef: null,
  };
}

function taskErrorFromProvider(error: ProviderError): TaskError {
  switch (error.code) {
    case 'AUTH':
      return {
        code: 'AuthError',
        retryable: false,
        recoveryAction: 'update_credentials',
        userMessage: 'Provider authentication is required.',
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
        userMessage:
          error.invalidResponseStage === null
            ? 'The provider returned an invalid response.'
            : `The provider returned an invalid response (stage: ${error.invalidResponseStage}).`,
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

/** Counts consecutive automatic invalid-response retries since the latest valid model turn. */
function invalidModelResponseRetryCount(events: readonly TaskEvent[]): number {
  let count = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'model.turn') break;
    if (event?.type === 'status.changed') {
      if (event.reason === 'model_request_started') break;
      if (event.reason.startsWith('invalid_model_response_retry:')) count += 1;
    }
  }
  return count;
}

/** Projects one completed provider turn onto bounded numeric task telemetry. */
function taskModelTurnMetrics(turn: AgentModelTurn): TaskModelTurnMetrics {
  const usage = turn.usage;
  return {
    inputItemCount: turn.inputItemCount,
    elapsedMs: turn.elapsedMs,
    firstEventMs: turn.firstEventMs,
    ...(turn.firstTextMs === undefined ? {} : { firstTextMs: turn.firstTextMs }),
    ...(usage === null
      ? {}
      : {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          ...(usage.cachedInputTokens === undefined
            ? {}
            : { cachedInputTokens: usage.cachedInputTokens }),
          ...(usage.cacheWriteInputTokens === undefined
            ? {}
            : { cacheWriteInputTokens: usage.cacheWriteInputTokens }),
          ...(usage.reasoningOutputTokens === undefined
            ? {}
            : { reasoningOutputTokens: usage.reasoningOutputTokens }),
        }),
  };
}

/** Runs a durable sequential Tavily/model loop with checkpointed results. */
export class TaskExecutor {
  readonly #dependencies: TaskExecutorDependencies;
  readonly #leases: TaskLeaseManager;

  constructor(dependencies: TaskExecutorDependencies) {
    this.#dependencies = dependencies;
    this.#leases = new TaskLeaseManager(dependencies.repository);
  }

  async run(taskId: TaskId, signal: AbortSignal, expectedRunId?: TaskRunId): Promise<TaskSnapshot> {
    throwIfAborted(signal);
    const ownerId = this.#createId('runner');
    const acquired = await this.#leases.acquire(taskId, ownerId, this.#dependencies.clock.now());
    if (!acquired) throw new TaskExecutorError('TASK_BUSY', 'Task is already running.');

    try {
      let snapshot = await this.#loadSnapshot(taskId);
      if (expectedRunId !== undefined && snapshot.run.id !== expectedRunId) return snapshot;
      if (!runnableStatuses.has(snapshot.task.status)) return snapshot;
      if (snapshot.task.status !== 'planning') {
        snapshot = await this.#saveBoundary(snapshot, ownerId, signal, {
          type: 'planning.started',
          reason: 'model_request_started',
        });
      }

      let transientModelRetryCount = 0;
      while (true) {
        throwIfAborted(signal);
        if (snapshot.checkpoint.pendingToolCall !== null) {
          snapshot = await this.#executePendingTool(snapshot, ownerId, signal);
          if (!runnableStatuses.has(snapshot.task.status)) return snapshot;
          continue;
        }
        snapshot = await this.#applySupplements(snapshot, ownerId, signal);
        if (!runnableStatuses.has(snapshot.task.status)) return snapshot;
        let result: AgentOutcome;
        try {
          result = await this.#planOne(snapshot, signal, async (reasoningSummary) => {
            snapshot = await this.#refreshCurrentAttempt(snapshot);
            if (!runnableStatuses.has(snapshot.task.status)) return;
            snapshot = await this.#saveBoundary(snapshot, ownerId, signal, {
              type: 'reasoning.summary-recorded',
              reason: 'model_reasoning_summary_recorded',
              reasoningSummary,
            });
          });
        } catch (error) {
          if (
            isProviderError(error) &&
            error.code === 'TRANSIENT' &&
            transientModelRetryCount < MODEL_TRANSIENT_RETRY_LIMIT
          ) {
            const retryDelay =
              MODEL_TRANSIENT_RETRY_DELAYS_MS[transientModelRetryCount] ??
              MODEL_TRANSIENT_RETRY_DELAYS_MS.at(-1) ??
              3_000;
            transientModelRetryCount += 1;
            snapshot = await this.#saveBoundary(snapshot, ownerId, signal, {
              type: 'planning.retrying',
              reason: 'transient_model_retry:upstream_failure',
            });
            await (this.#dependencies.sleep ?? sleepWithAbort)(retryDelay, signal);
            continue;
          }
          if (
            isProviderError(error) &&
            error.code === 'INVALID_RESPONSE' &&
            invalidModelResponseRetryCount(snapshot.events) < MODEL_INVALID_RESPONSE_RETRY_LIMIT
          ) {
            snapshot = await this.#saveBoundary(snapshot, ownerId, signal, {
              type: 'planning.retrying',
              reason: `invalid_model_response_retry:${error.invalidResponseStage ?? 'unknown'}`,
            });
            continue;
          }
          return await this.#handleFailure(snapshot, ownerId, signal, error, 'model');
        }
        snapshot = await this.#refreshCurrentAttempt(snapshot);
        if (!runnableStatuses.has(snapshot.task.status)) return snapshot;
        transientModelRetryCount = 0;

        if (result.type === 'task.completed') {
          if (
            await this.#dependencies.tools.blocksCompletion({
              task: snapshot.task,
              checkpoint: snapshot.checkpoint,
              toolResults: snapshot.toolResults,
            })
          ) {
            await this.#interruptReply(snapshot.task, result.messageId);
            continue;
          }
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
              ...(result.modelTurn === undefined
                ? {}
                : { modelTurn: taskModelTurnMetrics(result.modelTurn) }),
            });
          } catch (error) {
            if (!(error instanceof TaskRepositoryConflictError)) throw error;
            await this.#interruptReply(snapshot.task, result.messageId);
            continue;
          }
        }

        // Planner-provided native compaction uses the same durable boundary as automatic compaction.
        if (result.type === 'context.compacted') {
          await this.#dependencies.tools.contextCompacted();
          snapshot = await this.#saveBoundary(snapshot, ownerId, signal, {
            type: 'task.context-compacted',
            reason: 'native_context_compacted',
            continuationItems: result.continuationItems,
            pendingToolCall: null,
            lastModelInputTokens: null,
          });
          continue;
        }

        const call = result.call;
        if (snapshot.toolResults.some((completed) => completed.callId === call.callId)) {
          return this.#saveBoundary(snapshot, ownerId, signal, {
            type: 'task.failed',
            reason: 'duplicate_tool_call_id',
            error: invalidPlannerResultError(),
          });
        }
        if (result.type === 'tool.call') {
          const policy = this.#dependencies.tools.policyFor(result.call.name);
          if (policy === null) {
            return this.#saveBoundary(snapshot, ownerId, signal, {
              type: 'task.failed',
              reason: 'unregistered_tool_call',
              error: invalidPlannerResultError(),
            });
          }
          const completedGroupCalls = this.#dependencies.tools.callsUsed(result.call.name, {
            checkpoint: snapshot.checkpoint,
            toolResults: snapshot.toolResults,
          });
          if (completedGroupCalls >= policy.maxCalls) {
            return this.#saveBoundary(snapshot, ownerId, signal, {
              type: 'task.failed',
              reason: `${policy.budgetGroup}_tool_call_limit_reached`,
              error: toolCallLimitError(policy.budgetLabel ?? policy.budgetGroup),
            });
          }
        }

        const toolName = result.call.name;

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
              ...(result.modelOutputItems === undefined || result.modelOutputItems.length === 0
                ? {}
                : { modelOutputItems: result.modelOutputItems }),
            },
          ],
          pendingToolCall: {
            callId: call.callId,
            name: toolName,
            argumentsJson: call.argumentsJson,
            executionState: 'recorded',
            ...(this.#dependencies.tools.policyFor(toolName)?.executionIdPrefix === undefined
              ? {}
              : {
                  executionId: this.#createId(
                    this.#dependencies.tools.policyFor(toolName)?.executionIdPrefix ?? 'execution',
                  ),
                }),
          },
          ...(result.modelTurn === undefined
            ? {}
            : { modelTurn: taskModelTurnMetrics(result.modelTurn) }),
        });
      }
    } finally {
      try {
        await this.#dependencies.tools.release(ownerId);
      } finally {
        await this.#leases.release(taskId, ownerId);
      }
    }
  }

  /** Executes a durably recorded tool and prevents ambiguous browser mutations from replaying. */
  async #executePendingTool(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<ActiveTaskSnapshot> {
    const pending = snapshot.checkpoint.pendingToolCall;
    if (pending === null) return snapshot;

    if (this.#dependencies.tools.policyFor(pending.name) !== null) {
      return this.#executePendingRegisteredTool(snapshot, ownerId, signal, pending);
    }
    return this.#handleFailure(
      snapshot,
      ownerId,
      signal,
      providerErrorFromCode('INVALID_RESPONSE', {
        invalidResponseStage: 'tool_call',
      }),
      'model',
    );
  }

  async #executePendingRegisteredTool(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    pending: PendingToolCall,
  ): Promise<ActiveTaskSnapshot> {
    const policy = this.#dependencies.tools.policyFor(pending.name);
    if (policy === null) {
      return this.#handleFailure(
        snapshot,
        ownerId,
        signal,
        providerErrorFromCode('INVALID_RESPONSE', {
          invalidResponseStage: 'tool_call',
        }),
        'model',
      );
    }
    const source = policy.errorSource ?? 'model';
    const resultId = this.#createId('toolResult');
    let call;
    try {
      call = this.#dependencies.tools.parseRecorded(pending);
    } catch {
      return this.#handleFailure(
        snapshot,
        ownerId,
        signal,
        providerErrorFromCode('INVALID_RESPONSE', {
          invalidResponseStage: 'tool_call',
        }),
        source,
      );
    }
    const executionContext = {
      task: snapshot.task,
      checkpoint: snapshot.checkpoint,
      toolResults: snapshot.toolResults,
      executionState: pending.executionState,
      resultId,
      currentTabId: snapshot.checkpoint.browserTargetTabId,
      sessionOwnerId: ownerId,
      availableAssetIds: [
        ...new Set(snapshot.toolResults.flatMap((result) => [...(result.attachmentIds ?? [])])),
      ],
      ...(pending.executionId === undefined ? {} : { executionId: pending.executionId }),
    };
    try {
      const preflight = await this.#dependencies.tools.preflight(call, executionContext, signal);
      if (preflight !== null) {
        return this.#recordRegisteredToolResult(
          snapshot,
          ownerId,
          signal,
          pending,
          preflight,
          resultId,
        );
      }
    } catch (error) {
      return this.#handleRegisteredToolFailure(
        snapshot,
        ownerId,
        signal,
        pending,
        call,
        policy,
        error,
        'execute',
      );
    }
    if (policy.mutation && pending.executionState === 'may_have_dispatched') {
      if (pending.executionId === undefined) {
        return this.#recordToolResult(
          snapshot,
          ownerId,
          signal,
          pending,
          JSON.stringify({
            ok: false,
            code: 'AMBIGUOUS_EXECUTION',
            message:
              policy.ambiguousMessage ??
              'The previous tool action may already have run. Inspect its effects before choosing the next action.',
            retryable: false,
          }),
        );
      }
      if (!this.#dependencies.tools.canRecover(call.name)) {
        return this.#recordToolResult(
          snapshot,
          ownerId,
          signal,
          pending,
          JSON.stringify({
            ok: false,
            code: 'AMBIGUOUS_EXECUTION',
            message:
              policy.ambiguousMessage ??
              'The previous tool action may already have run. Inspect its effects before choosing the next action.',
            retryable: false,
          }),
        );
      }
      try {
        const recovery = await this.#dependencies.tools.recover(call, executionContext, signal);
        if (recovery.status === 'finished') {
          return this.#recordRegisteredToolResult(
            snapshot,
            ownerId,
            signal,
            pending,
            recovery.result,
            resultId,
          );
        }
        if (recovery.status === 'running') {
          return this.#pauseRegisteredToolRecovery(
            snapshot,
            ownerId,
            signal,
            pending,
            recovery.reason,
            recovery.userMessage,
          );
        }
      } catch (error) {
        return this.#handleRegisteredToolFailure(
          snapshot,
          ownerId,
          signal,
          pending,
          call,
          policy,
          error,
          'recover',
        );
      }
    }

    if (policy.mutation && pending.executionState === 'recorded') {
      snapshot = await this.#saveBoundary(snapshot, ownerId, signal, {
        type: 'tool.execution-started',
        reason: `${call.name}_execution_started`,
        pendingToolCall: { ...pending, executionState: 'may_have_dispatched' },
      });
    }
    try {
      const result = await this.#dependencies.tools.execute(call, executionContext, signal);
      return this.#recordRegisteredToolResult(snapshot, ownerId, signal, pending, result, resultId);
    } catch (error) {
      return this.#handleRegisteredToolFailure(
        snapshot,
        ownerId,
        signal,
        pending,
        call,
        policy,
        error,
        'execute',
      );
    }
  }

  async #recordRegisteredToolResult(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    pending: PendingToolCall,
    result: Awaited<ReturnType<ToolRuntimePort['execute']>>,
    resultId: string,
  ): Promise<ActiveTaskSnapshot> {
    if (result.contextCompacted === true) {
      await this.#dependencies.tools.contextCompacted();
    }
    return this.#recordToolResult(
      snapshot,
      ownerId,
      signal,
      pending,
      result.output,
      result.attachmentIds,
      result.modelAttachmentIds,
      result.modelOutput,
      result.checkpoint,
      result.continuationItems,
      resultId,
    );
  }

  #pauseRegisteredToolRecovery(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    pending: PendingToolCall,
    reason: string,
    userMessage: string,
  ): Promise<ActiveTaskSnapshot> {
    return this.#saveBoundary(snapshot, ownerId, signal, {
      type: 'task.paused',
      reason,
      error: {
        code: 'TransientProviderError',
        retryable: true,
        recoveryAction: 'retry',
        userMessage,
        evidenceRef: null,
      },
      pendingToolCall: { ...pending, executionState: 'may_have_dispatched' },
    });
  }

  #handleRegisteredToolFailure(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    pending: PendingToolCall,
    call: ValidatedToolCall,
    policy: ToolExecutionPolicy,
    error: unknown,
    phase: 'execute' | 'recover',
  ): Promise<ActiveTaskSnapshot> {
    if (signal.aborted || isAbortError(error)) throw error;
    const executionState =
      snapshot.checkpoint.pendingToolCall?.executionState ?? pending.executionState;
    const action = this.#dependencies.tools.failureFor(call, error, {
      phase,
      executionState,
    });
    if (action === null) {
      return this.#handleFailure(snapshot, ownerId, signal, error, policy.errorSource ?? 'model');
    }
    if (action.type === 'record') {
      return this.#recordToolResult(snapshot, ownerId, signal, pending, action.output);
    }
    if (action.type === 'auth') {
      return this.#saveBoundary(snapshot, ownerId, signal, {
        type: 'task.auth-required',
        reason: action.reason,
        error: {
          code: 'AuthError',
          retryable: false,
          recoveryAction: 'update_credentials',
          userMessage: action.userMessage,
          evidenceRef: null,
        },
        pendingToolCall: phase === 'recover' ? pending : { ...pending, executionState: 'recorded' },
      });
    }
    if (action.type === 'fail') {
      return this.#saveBoundary(snapshot, ownerId, signal, {
        type: 'task.failed',
        reason: action.reason,
        error: {
          code: action.code,
          retryable: false,
          recoveryAction: action.recoveryAction,
          userMessage: action.userMessage,
          evidenceRef: null,
        },
      });
    }
    return this.#saveBoundary(snapshot, ownerId, signal, {
      type: 'task.paused',
      reason: action.reason,
      error: {
        code: action.code ?? 'TransientProviderError',
        retryable: true,
        recoveryAction: action.recoveryAction ?? 'retry',
        userMessage: action.userMessage,
        evidenceRef: null,
      },
      pendingToolCall: { ...pending, executionState: 'may_have_dispatched' },
    });
  }

  async #recordToolResult(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    pending: PendingToolCall,
    output: string,
    attachmentIds: readonly string[] = [],
    modelAttachmentIds: readonly string[] | undefined = undefined,
    modelOutput: string | undefined = undefined,
    checkpointEffect: Awaited<ReturnType<ToolRuntimePort['execute']>>['checkpoint'] = undefined,
    replacementContinuationItems: readonly ContinuationItem[] | undefined = undefined,
    requestedResultId: string | undefined = undefined,
  ): Promise<ActiveTaskSnapshot> {
    const durableAttachmentIds = [...new Set(attachmentIds)];
    const continuationAttachmentIds = [...new Set(modelAttachmentIds ?? durableAttachmentIds)];
    if (
      durableAttachmentIds.length > 8 ||
      durableAttachmentIds.some((id) => id.length === 0 || id.length > 256) ||
      continuationAttachmentIds.length > 8 ||
      continuationAttachmentIds.some(
        (id) => id.length === 0 || id.length > 256 || !durableAttachmentIds.includes(id),
      )
    ) {
      throw new Error('Browser tool attachment references are invalid.');
    }
    const resultId = requestedResultId ?? this.#createId('toolResult');
    const completedResult: MaterializedToolResult = {
      id: resultId,
      taskId: snapshot.task.id,
      runId: snapshot.run.id,
      callId: pending.callId,
      toolName: pending.name,
      argumentsJson: pending.argumentsJson,
      output,
      ...(modelOutput === undefined || modelOutput.length >= output.length ? {} : { modelOutput }),
      attachmentIds: durableAttachmentIds,
      createdAt: this.#dependencies.clock.now(),
    };
    return this.#saveBoundary(snapshot, ownerId, signal, {
      type: 'tool.result-recorded',
      reason: `${pending.name}_result_recorded`,
      toolResults: [...snapshot.toolResults, completedResult],
      continuationItems: replacementContinuationItems ?? [
        ...snapshot.checkpoint.continuationItems,
        {
          type: 'function_call_output_ref',
          callId: pending.callId,
          resultId: completedResult.id,
          attachmentIds: continuationAttachmentIds,
        },
      ],
      pendingToolCall: null,
      browserToolCallsInAttempt:
        (snapshot.checkpoint.browserToolCallsInAttempt ?? 0) +
        (checkpointEffect?.browserToolCallsInAttemptDelta ?? 0),
      ...(checkpointEffect?.browserTargetTabId === undefined
        ? {}
        : { browserTargetTabId: checkpointEffect.browserTargetTabId }),
    });
  }

  /** Commits every accepted but unconsumed task supplement before the next model request. */
  async #applySupplements(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<ActiveTaskSnapshot> {
    snapshot = await this.#refreshCurrentAttempt(snapshot);
    if (!runnableStatuses.has(snapshot.task.status)) return snapshot;
    const messages = await this.#dependencies.conversations.listMessages(
      snapshot.task.conversationId,
    );
    const supplements = selectPendingTaskSupplements(messages, snapshot.events, snapshot.task.id);
    if (supplements.length === 0) return snapshot;

    return this.#saveBoundary(snapshot, ownerId, signal, {
      type: 'task.supplements-applied',
      reason: 'user_supplements_applied',
      supplementIds: supplements.map(({ id }) => id).slice(-100),
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
  async #interruptReply(task: Task, messageId: string): Promise<void> {
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
    snapshot: ActiveTaskSnapshot,
    signal: AbortSignal,
    onReasoningSummary: (summary: string) => Promise<void>,
  ): Promise<AgentOutcome> {
    let result: AgentOutcome | null = null;
    for await (const event of this.#dependencies.planner.plan(
      {
        task: snapshot.task,
        events: snapshot.events,
        checkpoint: snapshot.checkpoint,
        toolResults: snapshot.toolResults,
      },
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

  /** Converts one safe model or Tavily failure into its durable task boundary. */
  async #handleFailure(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    error: unknown,
    source: string,
  ): Promise<ActiveTaskSnapshot> {
    if (signal.aborted || isAbortError(error)) throw error;
    if (error instanceof TaskExecutorError && error.code === 'PLANNER_RESULT_INVALID') {
      return this.#saveBoundary(snapshot, ownerId, signal, {
        type: 'task.failed',
        reason: 'invalid_planner_result',
        error: invalidPlannerResultError(),
      });
    }
    if (!isProviderError(error)) {
      const inputError = taskInputError(error);
      const inputStage = modelInputPreparationStage(error);
      return this.#saveBoundary(snapshot, ownerId, signal, {
        type: 'task.failed',
        reason:
          source === 'model'
            ? `task_input_preparation_failed${inputStage === null ? '' : `:${inputStage}`}`
            : `${source}_execution_failed`,
        error: inputError,
      });
    }
    if (error.code === 'ABORTED') throw error;
    const taskError = taskErrorFromProvider(error);
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
            ? `invalid_${source}_response${
                error.invalidResponseStage === null ? '' : `:${error.invalidResponseStage}`
              }`
            : `${source}_retry_required`,
      error: taskError,
    });
  }

  async #loadSnapshot(taskId: TaskId): Promise<ActiveTaskSnapshot> {
    const snapshot = await this.#dependencies.repository.readActiveRuntimeSnapshot(taskId);
    if (snapshot === undefined) {
      throw new TaskExecutorError('TASK_NOT_FOUND', 'Task does not exist.');
    }
    if (snapshot.run.checkpointId === null) {
      throw new TaskExecutorError('CHECKPOINT_NOT_FOUND', 'Task checkpoint is missing.');
    }
    if (snapshot.checkpoint === undefined) {
      throw new TaskExecutorError('CHECKPOINT_NOT_FOUND', 'Task checkpoint is missing.');
    }
    return {
      task: snapshot.task,
      run: snapshot.run,
      checkpoint: snapshot.checkpoint,
      events: snapshot.events,
      toolResults: snapshot.toolResults,
    };
  }

  /** Reloads durable events written during a model turn without crossing attempt boundaries. */
  async #refreshCurrentAttempt(snapshot: ActiveTaskSnapshot): Promise<ActiveTaskSnapshot> {
    const delta = await this.#dependencies.repository.readActiveRuntimeDelta(
      snapshot.task.id,
      snapshot.task.lastEventSequence,
    );
    if (
      delta === undefined ||
      delta.run.id !== snapshot.run.id ||
      delta.checkpoint?.id !== snapshot.checkpoint.id
    ) {
      throw new TaskExecutorError(
        'TASK_STATE_STALE',
        'Task attempt changed while preparing the next model request.',
      );
    }
    return {
      task: delta.task,
      run: delta.run,
      checkpoint: delta.checkpoint,
      events: [...snapshot.events, ...delta.events],
      toolResults: snapshot.toolResults,
    };
  }

  async #saveBoundary(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    input: BoundaryInput & { readonly type: 'task.completed' },
  ): Promise<TaskSnapshot>;
  async #saveBoundary(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    input: BoundaryInput,
  ): Promise<ActiveTaskSnapshot>;
  async #saveBoundary(
    snapshot: ActiveTaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    input: BoundaryInput,
  ): Promise<TaskSnapshot> {
    throwIfAborted(signal);
    const now = this.#dependencies.clock.now();
    const renewed = await this.#leases.renew(snapshot.task.id, ownerId, now);
    if (!renewed) throw new TaskExecutorError('TASK_BUSY', 'Task lease was lost.');
    const current = await this.#refreshCurrentAttempt(snapshot);
    const currentTask = current.task;
    const currentRun = current.run;
    const currentCheckpoint = current.checkpoint;
    if (
      currentTask.latestRunId !== snapshot.run.id ||
      currentRun.checkpointId !== snapshot.checkpoint.id ||
      currentCheckpoint.id !== snapshot.checkpoint.id
    ) {
      throw new TaskExecutorError('TASK_STATE_STALE', 'Task changed during execution.');
    }

    const transitioned = transitionTask(currentTask, currentRun, {
      type: input.type,
      at: now,
      reason: input.reason,
      ...(input.error === undefined ? {} : { error: input.error }),
    });
    const nextToolResults = input.toolResults ?? current.toolResults;
    const previousResultIds = new Set(current.toolResults.map((result) => result.id));
    const newResults = nextToolResults.filter((result) => !previousResultIds.has(result.id));
    const canonicalResults: ToolResult[] = newResults.map((result) => ({
      id: result.id,
      taskId: result.taskId,
      runId: result.runId,
      callId: result.callId,
      toolName: result.toolName,
      output: result.output,
      ...(result.modelOutput === undefined ? {} : { modelOutput: result.modelOutput }),
      attachmentIds: result.attachmentIds,
      createdAt: result.createdAt,
    }));

    let sequence = currentTask.lastEventSequence;
    const eventBase = () => ({
      id: this.#createId('event'),
      taskId: currentTask.id,
      runId: currentRun.id,
      sequence: (sequence += 1),
      at: now,
    });
    const events: TaskEvent[] = [];
    if (input.modelTurn !== undefined) {
      events.push({
        ...eventBase(),
        type: 'model.turn',
        metrics: input.modelTurn,
      });
    }
    if (input.type === 'reasoning.summary-recorded') {
      if (input.reasoningSummary === undefined) {
        throw new TaskExecutorError('TASK_STATE_STALE', 'Reasoning summary is missing.');
      }
      events.push({
        ...eventBase(),
        type: 'reasoning.summary',
        summary: input.reasoningSummary,
      });
    } else if (input.type === 'tool.call-recorded') {
      const pending = input.pendingToolCall;
      if (pending === undefined || pending === null) {
        throw new TaskExecutorError('TASK_STATE_STALE', 'Recorded tool call is missing.');
      }
      events.push({
        ...eventBase(),
        type: 'tool.call',
        callId: pending.callId,
        name: pending.name,
        argumentsJson: pending.argumentsJson,
      });
    } else if (input.type === 'tool.execution-started') {
      const pending = input.pendingToolCall ?? currentCheckpoint.pendingToolCall;
      if (pending === null || pending === undefined) {
        throw new TaskExecutorError('TASK_STATE_STALE', 'Dispatched tool call is missing.');
      }
      events.push({
        ...eventBase(),
        type: 'tool.dispatched',
        callId: pending.callId,
      });
    } else if (input.type === 'tool.result-recorded') {
      const result = newResults.at(-1);
      if (result === undefined) {
        throw new TaskExecutorError('TASK_STATE_STALE', 'Recorded tool result is missing.');
      }
      events.push({
        ...eventBase(),
        type: 'tool.result',
        callId: result.callId,
        resultId: result.id,
      });
    } else if (input.type === 'task.supplements-applied') {
      for (const messageId of input.supplementIds ?? []) {
        events.push({ ...eventBase(), type: 'supplement.applied', messageId });
      }
    } else if (input.type === 'task.context-compacted') {
      events.push({
        ...eventBase(),
        type: 'context.compacted',
        releasedTextCharacters: 0,
        releasedImages: 0,
      });
    } else {
      events.push({
        ...eventBase(),
        type: 'status.changed',
        taskStatus: transitioned.task.status,
        runStatus: transitioned.run.status,
        reason: input.reason,
        error: input.error ?? transitioned.run.error,
      });
    }
    if (events.length === 0) {
      throw new TaskExecutorError('TASK_STATE_STALE', 'Task boundary produced no event.');
    }

    const { lastModelInputTokens: previousLastModelInputTokens, ...previousCheckpoint } =
      currentCheckpoint;
    const lastModelInputTokens =
      input.lastModelInputTokens === null
        ? undefined
        : (input.lastModelInputTokens ??
          input.modelTurn?.inputTokens ??
          previousLastModelInputTokens);
    const checkpoint: Checkpoint = {
      ...previousCheckpoint,
      continuationItems: input.continuationItems ?? currentCheckpoint.continuationItems,
      pendingToolCall:
        input.pendingToolCall === undefined
          ? currentCheckpoint.pendingToolCall
          : input.pendingToolCall,
      ...(lastModelInputTokens === undefined ? {} : { lastModelInputTokens }),
      browserToolCallsInAttempt:
        input.browserToolCallsInAttempt ?? currentCheckpoint.browserToolCallsInAttempt ?? 0,
      ...(input.browserTargetTabId === undefined
        ? {}
        : { browserTargetTabId: input.browserTargetTabId }),
    };
    const completed = input.type === 'task.completed';
    const task: Task = { ...transitioned.task, lastEventSequence: sequence };
    const run: TaskRun = {
      ...transitioned.run,
      checkpointId: completed ? null : checkpoint.id,
    };
    await this.#dependencies.repository.saveTransition({
      task,
      run,
      events,
      checkpoint,
      ...(completed
        ? {
            deleteCheckpoint: true,
          }
        : {}),
      ...(canonicalResults.length === 0 ? {} : { toolResults: canonicalResults }),
    });
    return {
      task,
      run,
      checkpoint: completed ? null : checkpoint,
      events: [...current.events, ...events],
      toolResults: nextToolResults,
    };
  }

  #createId(prefix: string): string {
    const id = this.#dependencies.ids.create(prefix).trim();
    if (id.length === 0) {
      throw new TaskExecutorError('TASK_STATE_STALE', 'Identifier generation failed.');
    }
    return id;
  }
}
