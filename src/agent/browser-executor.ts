import type { BrowserActionRequest } from '../browser/contracts/action';
import type { VerificationResult } from '../browser/verify/verification-engine';
import type { TaskRepository } from '../persistence/task-repository';
import { isProviderError, type ProviderError } from '../providers/provider-errors';
import {
  retryProviderOperation,
  type ProviderRetryDependencies,
} from '../providers/provider-retry';
import type { IdGenerator, TaskId } from '../shared/ids';
import type { Clock } from '../shared/time';
import {
  consumeBrowserAction,
  consumeReplan,
  isWallClockBudgetExhausted,
} from '../tasks/task-budget';
import type {
  Checkpoint,
  CompletedToolResult,
  PendingActionCheckpoint,
} from '../tasks/checkpoint-types';
import type { TaskSnapshot } from '../tasks/task-command-service';
import type { TaskError } from '../tasks/task-errors';
import { TaskLeaseManager } from '../tasks/task-lease';
import { transitionTask } from '../tasks/task-transition';
import type { TaskEvent, TaskEventType, TaskRun } from '../tasks/task-types';
import { digestAction } from './action-digest';
import { classifyActionRisk } from './action-risk';
import type {
  AgentEvent,
  AgentPlanner,
  BrowserExecutionPort,
  TavilyExecutionPort,
} from './execution-types';
import { decideActionRecovery } from './retry-policy';
import { ToolCallError } from './tools/tool-parser';
import type { TabTrackingPort, TrackedTab } from '../platform/chrome/tab-tracker';
import { shouldCaptureVisualFallback } from './visual-fallback';

const DEFAULT_VERIFICATION_TIMEOUT_MS = 5_000;

export type BrowserExecutorErrorCode =
  | 'TASK_NOT_FOUND'
  | 'CHECKPOINT_NOT_FOUND'
  | 'TASK_BUSY'
  | 'TASK_STATE_STALE'
  | 'PLANNER_RESULT_INVALID';

export class BrowserExecutorError extends Error {
  readonly code: BrowserExecutorErrorCode;

  /** Creates a stable execution failure without embedding page or provider payloads. */
  constructor(code: BrowserExecutorErrorCode, message: string) {
    super(message);
    this.name = 'BrowserExecutorError';
    this.code = code;
  }
}

export interface BrowserExecutorDependencies {
  readonly repository: TaskRepository;
  readonly planner: AgentPlanner;
  readonly browser: BrowserExecutionPort;
  readonly tavily: TavilyExecutionPort;
  readonly tabs: Pick<TabTrackingPort, 'hasTab' | 'findAdoptableTab'>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly verificationTimeoutMs?: number;
  readonly providerRetry?: ProviderRetryDependencies;
  readonly visuals?: { capture(tabId: number): Promise<string> };
}

interface BoundaryInput {
  readonly type: TaskEventType;
  readonly reason: string;
  readonly pendingAction?: PendingActionCheckpoint | null;
  readonly observationRef?: string | null;
  readonly budget?: TaskRun['budget'];
  readonly boundTabId?: number;
  readonly actionId?: string;
  readonly actionDigest?: string;
  readonly evidenceRef?: string;
  readonly completedToolResults?: readonly CompletedToolResult[];
  readonly error?: TaskError;
}

interface VerificationOutcome {
  readonly result: VerificationResult;
  readonly adoptedTab: TrackedTab | null;
}

class PlanningBoundaryFailure extends Error {
  readonly snapshot: TaskSnapshot;
  readonly failure: unknown;

  /** Preserves the latest durable planning boundary while keeping a fixed safe message. */
  constructor(snapshot: TaskSnapshot, failure: unknown) {
    super('Agent planning failed.');
    this.name = 'PlanningBoundaryFailure';
    this.snapshot = snapshot;
    this.failure = failure;
  }
}

const automaticStatuses = new Set<TaskRun['status']>([
  'queued',
  'observing',
  'planning',
  'acting',
  'verifying',
  'checkpointed',
]);

/** Binds one planned action to its task tab and the risk raised by deterministic policy. */
function bindAction(
  action: BrowserActionRequest,
  tabId: number,
  risk: 'low' | 'high',
): BrowserActionRequest {
  return {
    ...action,
    tabId,
    risk,
    expected:
      action.expected.type === 'tab.opened'
        ? { ...action.expected, openerTabId: tabId }
        : action.expected,
  } as BrowserActionRequest;
}

/** Throws a standardized abort exception at explicit side-effect boundaries. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Task execution was aborted.', 'AbortError');
}

/** Produces one stable adaptive-routing outcome identifier per logical action attempt. */
function actionOutcomeId(taskId: TaskId, pending: PendingActionCheckpoint): string {
  return `${taskId.length}:${taskId}:${pending.digest}:${String(pending.attemptCount)}`;
}

/** Appends one immutable tool result and rejects conflicting call-ID reuse. */
function appendToolResult(
  existing: readonly CompletedToolResult[],
  result: CompletedToolResult,
): readonly CompletedToolResult[] {
  const previous = existing.find((candidate) => candidate.callId === result.callId);
  if (previous === undefined) return [...existing, result];
  if (JSON.stringify(previous) === JSON.stringify(result)) return existing;
  throw new BrowserExecutorError('TASK_STATE_STALE', 'Tool call ID was reused inconsistently.');
}

/** Converts a sanitized Provider error to the durable user-facing task taxonomy. */
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
        userMessage: 'The provider returned an invalid response.',
        evidenceRef: null,
      };
    case 'ABORTED':
      return {
        code: 'NavigationInterrupted',
        retryable: true,
        recoveryAction: 'resume_task',
        userMessage: 'The task was interrupted.',
        evidenceRef: null,
      };
  }
}

/** Serializes bounded browser evidence into the next Provider turn's tool output. */
function browserToolOutput(
  pending: PendingActionCheckpoint,
  verified: boolean,
  verification: VerificationResult | null,
): string {
  return JSON.stringify({
    ok: verified,
    verified,
    actionId: pending.actionId,
    actionKind: pending.kind,
    evidence: pending.evidence,
    verification,
  });
}

export class BrowserExecutor {
  readonly #dependencies: BrowserExecutorDependencies;
  readonly #leases: TaskLeaseManager;

  /** Creates a durable single-task runner over planner, browser, tab, and repository ports. */
  constructor(dependencies: BrowserExecutorDependencies) {
    this.#dependencies = dependencies;
    this.#leases = new TaskLeaseManager(dependencies.repository);
  }

  /** Runs bounded plan/action cycles and returns only at a durable terminal or waiting boundary. */
  async run(taskId: TaskId, signal: AbortSignal): Promise<TaskSnapshot> {
    throwIfAborted(signal);
    const ownerId = this.#createId('runner');
    const acquired = await this.#leases.acquire(taskId, ownerId, this.#dependencies.clock.now());
    if (!acquired) throw new BrowserExecutorError('TASK_BUSY', 'Task is already running.');

    const touchedTabs = new Set<number>();
    try {
      let snapshot = await this.#loadSnapshot(taskId);
      while (automaticStatuses.has(snapshot.task.status)) {
        throwIfAborted(signal);
        const tabId = snapshot.task.tabId;
        if (tabId === null || !(await this.#dependencies.tabs.hasTab(tabId))) {
          snapshot = await this.#saveBoundary(snapshot, ownerId, signal, {
            type: 'task.tab-missing',
            reason: 'bound_tab_missing',
          });
          return snapshot;
        }

        const pending = snapshot.checkpoint.pendingAction;
        if (pending?.outcome === 'pending') {
          touchedTabs.add(tabId);
          snapshot = await this.#recoverPending(snapshot, pending, ownerId, signal);
          if (!automaticStatuses.has(snapshot.task.status)) return snapshot;
          continue;
        }

        if (
          snapshot.task.budget.browserActionsUsed >= snapshot.task.budget.browserActionsLimit ||
          isWallClockBudgetExhausted(
            snapshot.task.budget,
            snapshot.task.createdAt,
            this.#dependencies.clock.now(),
          )
        ) {
          snapshot = await this.#saveBoundary(snapshot, ownerId, signal, {
            type: 'task.budget-exhausted',
            reason: 'browser_action_or_time_budget_exhausted',
          });
          return snapshot;
        }

        let planned: { readonly snapshot: TaskSnapshot; readonly event: AgentEvent };
        try {
          planned = await this.#planNext(snapshot, tabId, ownerId, signal, touchedTabs);
        } catch (caught) {
          const error = caught instanceof PlanningBoundaryFailure ? caught.failure : caught;
          if (caught instanceof PlanningBoundaryFailure) snapshot = caught.snapshot;
          if (error instanceof ToolCallError) {
            if (snapshot.task.budget.replansUsed >= snapshot.task.budget.replansLimit) {
              return this.#saveBoundary(snapshot, ownerId, signal, {
                type: 'task.budget-exhausted',
                reason: 'invalid_model_tool_replan_budget_exhausted',
              });
            }
            snapshot = await this.#saveBoundary(snapshot, ownerId, signal, {
              type: 'planning.rejected',
              reason: 'invalid_model_tool_arguments',
              budget: consumeReplan(snapshot.task.budget),
            });
            continue;
          }
          if (isProviderError(error)) {
            if (error.code === 'ABORTED') throw error;
            const taskError = taskErrorFromProvider(error);
            if (error.code === 'AUTH') {
              return this.#saveBoundary(snapshot, ownerId, signal, {
                type: 'task.auth-required',
                reason: 'provider_authentication_required',
                error: taskError,
              });
            }
            return this.#saveBoundary(snapshot, ownerId, signal, {
              type: error.code === 'INVALID_RESPONSE' ? 'task.failed' : 'task.paused',
              reason:
                error.code === 'INVALID_RESPONSE'
                  ? 'invalid_provider_response'
                  : 'provider_retry_exhausted',
              error: taskError,
            });
          }
          throw error;
        }
        snapshot = planned.snapshot;
        if (planned.event.type === 'task.completed') {
          return this.#saveBoundary(snapshot, ownerId, signal, {
            type: 'task.completed',
            reason: planned.event.reason,
          });
        }
        if (planned.event.type === 'tavily.call') {
          const tavilyEvent = planned.event;
          if (
            snapshot.checkpoint.completedToolResults.some(
              (result) => result.callId === tavilyEvent.callId,
            )
          ) {
            if (snapshot.task.budget.replansUsed >= snapshot.task.budget.replansLimit) {
              return this.#saveBoundary(snapshot, ownerId, signal, {
                type: 'task.budget-exhausted',
                reason: 'repeated_tool_call_replan_budget_exhausted',
              });
            }
            snapshot = await this.#saveBoundary(snapshot, ownerId, signal, {
              type: 'planning.rejected',
              reason: 'model_repeated_completed_tool_call',
              budget: consumeReplan(snapshot.task.budget),
            });
            continue;
          }
          snapshot = await this.#executeTavily(snapshot, tavilyEvent, ownerId, signal);
          if (!automaticStatuses.has(snapshot.task.status)) return snapshot;
          continue;
        }

        const policyRisk =
          planned.event.action.risk === 'high' ||
          classifyActionRisk(planned.event.action) === 'high'
            ? 'high'
            : 'low';
        const action = bindAction(planned.event.action, tabId, policyRisk);
        const digest = await digestAction(action);
        const pendingAction: PendingActionCheckpoint = {
          actionId: action.actionId,
          digest,
          kind: action.type,
          risk: policyRisk,
          action,
          expected: action.expected,
          intentAt: null,
          attemptCount: 0,
          effectState: 'not_attempted',
          outcome: 'pending',
          confirmation: null,
          evidence: null,
          evidenceRef: null,
          verified: false,
          modelCall:
            planned.event.callId === undefined || planned.event.argumentsJson === undefined
              ? null
              : {
                  callId: planned.event.callId,
                  toolName: 'browser.act',
                  argumentsJson: planned.event.argumentsJson,
                },
        };

        if (policyRisk === 'high') {
          return this.#saveBoundary(snapshot, ownerId, signal, {
            type: 'task.confirmation-required',
            reason: 'high_risk_action_requires_confirmation',
            pendingAction,
            actionId: action.actionId,
            actionDigest: digest,
          });
        }

        snapshot = await this.#recordIntent(snapshot, pendingAction, ownerId, signal);
        snapshot = await this.#executePending(
          snapshot,
          snapshot.checkpoint.pendingAction as PendingActionCheckpoint,
          ownerId,
          signal,
        );
        if (!automaticStatuses.has(snapshot.task.status)) return snapshot;
      }
      return snapshot;
    } finally {
      await Promise.allSettled(
        [...touchedTabs].map((tabId) => this.#dependencies.browser.release(tabId, ownerId)),
      );
      await this.#leases.release(taskId, ownerId);
    }
  }

  /** Executes one bounded Tavily operation and checkpoints its sanitized output before replanning. */
  async #executeTavily(
    snapshot: TaskSnapshot,
    event: Extract<AgentEvent, { readonly type: 'tavily.call' }>,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<TaskSnapshot> {
    let output: string;
    try {
      const result = await retryProviderOperation(
        async () => {
          if (event.operation === 'search') {
            return this.#dependencies.tavily.search(event.arguments, signal);
          }
          if (event.operation === 'extract') {
            return this.#dependencies.tavily.extract(event.arguments, signal);
          }
          return this.#dependencies.tavily.crawl(event.arguments, signal);
        },
        signal,
        this.#dependencies.providerRetry ?? {},
      );
      output = JSON.stringify({ ok: true, ...result });
    } catch (error) {
      if (!isProviderError(error)) throw error;
      if (error.code === 'ABORTED') throw error;
      if (error.code === 'AUTH') {
        return this.#saveBoundary(snapshot, ownerId, signal, {
          type: 'task.auth-required',
          reason: 'tavily_authentication_required',
          error: taskErrorFromProvider(error),
        });
      }
      output = JSON.stringify({
        ok: false,
        error: { code: error.code, retryable: error.retryable },
      });
    }

    const resultRef = this.#createId('tool-result');
    const completedToolResults = appendToolResult(snapshot.checkpoint.completedToolResults, {
      callId: event.callId,
      toolName: `tavily.${event.operation}`,
      argumentsJson: event.argumentsJson,
      output,
      resultRef,
    });
    return this.#saveBoundary(snapshot, ownerId, signal, {
      type: 'tool.result-recorded',
      reason: `tavily_${event.operation}_result_recorded`,
      completedToolResults,
      evidenceRef: resultRef,
    });
  }

  /** Loads a task, its current checkpoint, and ordered event history. */
  async #loadSnapshot(taskId: TaskId): Promise<TaskSnapshot> {
    const task = await this.#dependencies.repository.get(taskId);
    if (task === undefined) {
      throw new BrowserExecutorError('TASK_NOT_FOUND', 'Task does not exist.');
    }
    if (task.checkpointId === null) {
      throw new BrowserExecutorError('CHECKPOINT_NOT_FOUND', 'Task checkpoint is missing.');
    }
    const [checkpoint, events] = await Promise.all([
      this.#dependencies.repository.getCheckpoint(task.checkpointId),
      this.#dependencies.repository.listEvents(taskId),
    ]);
    if (checkpoint === undefined) {
      throw new BrowserExecutorError('CHECKPOINT_NOT_FOUND', 'Task checkpoint is missing.');
    }
    return { task, checkpoint, events };
  }

  /** Re-observes and asks the planner for exactly one bounded action or completion decision. */
  async #planNext(
    snapshot: TaskSnapshot,
    tabId: number,
    ownerId: string,
    signal: AbortSignal,
    touchedTabs: Set<number>,
  ): Promise<{ readonly snapshot: TaskSnapshot; readonly event: AgentEvent }> {
    let current = snapshot;
    if (current.task.status !== 'observing' && current.task.status !== 'planning') {
      current = await this.#saveBoundary(current, ownerId, signal, {
        type: 'observation.started',
        reason: 'browser_observation_started',
      });
    }
    touchedTabs.add(tabId);
    const observation = await this.#dependencies.browser.observe({ tabId, ownerId });
    if (current.task.status !== 'planning') {
      current = await this.#saveBoundary(current, ownerId, signal, {
        type: 'planning.started',
        reason: 'agent_planning_started',
        observationRef: observation.id,
      });
    }

    const visualImageUrl = shouldCaptureVisualFallback(observation)
      ? ((await this.#dependencies.visuals?.capture(tabId).catch(() => null)) ?? null)
      : null;
    throwIfAborted(signal);

    try {
      for await (const event of this.#dependencies.planner.plan(
        { task: current.task, checkpoint: current.checkpoint, observation, visualImageUrl },
        signal,
      )) {
        throwIfAborted(signal);
        return { snapshot: current, event };
      }
    } catch (error) {
      throw new PlanningBoundaryFailure(current, error);
    }
    throw new BrowserExecutorError(
      'PLANNER_RESULT_INVALID',
      'Planner returned no bounded action or completion.',
    );
  }

  /** Persists an intent immediately before one browser attempt and invalidates old evidence. */
  async #recordIntent(
    snapshot: TaskSnapshot,
    pending: PendingActionCheckpoint,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<TaskSnapshot> {
    const rebound = await this.#bindPendingToTaskTab(snapshot.task, pending);
    const attempt = rebound.attemptCount + 1;
    const next: PendingActionCheckpoint = {
      ...rebound,
      intentAt: null,
      attemptCount: attempt,
      effectState: 'unknown',
      confirmation: null,
      evidence: null,
      evidenceRef: null,
      outcome: 'pending',
      verified: false,
    };
    return this.#saveBoundary(snapshot, ownerId, signal, {
      type: 'action.intent-recorded',
      reason: `browser_action_attempt_${String(attempt)}`,
      pendingAction: next,
      actionId: rebound.actionId,
      actionDigest: rebound.digest,
    });
  }

  /** Executes one already-persisted intent, records bounded evidence, then verifies its effect. */
  async #executePending(
    snapshot: TaskSnapshot,
    pending: PendingActionCheckpoint,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<TaskSnapshot> {
    const evidence = await this.#dependencies.browser
      .execute({
        ownerId,
        outcomeId: actionOutcomeId(snapshot.task.id, pending),
        action: pending.action,
      })
      .catch(() => null);
    const evidenceRef = this.#createId('evidence');
    const withEvidence: PendingActionCheckpoint = {
      ...pending,
      effectState: evidence === null ? 'unknown' : 'reported',
      evidence,
      evidenceRef,
    };
    const verifying = await this.#saveBoundary(snapshot, ownerId, signal, {
      type: 'action.evidence-recorded',
      reason:
        evidence === null ? 'browser_action_result_unknown' : 'browser_action_result_recorded',
      pendingAction: withEvidence,
      actionId: pending.actionId,
      actionDigest: pending.digest,
      evidenceRef,
    });
    return this.#recoverPending(verifying, withEvidence, ownerId, signal);
  }

  /** Verifies unresolved effects before any replay and follows the bounded recovery policy. */
  async #recoverPending(
    snapshot: TaskSnapshot,
    pending: PendingActionCheckpoint,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<TaskSnapshot> {
    if (pending.effectState === 'not_attempted') {
      if (snapshot.task.tabId !== null && pending.action.tabId !== snapshot.task.tabId) {
        const rebound = await this.#bindPendingToTaskTab(snapshot.task, pending);
        return this.#requireConfirmation(snapshot, rebound, ownerId, signal);
      }
      const nextAttempt = pending.attemptCount + 1;
      const confirmed =
        pending.confirmation?.digest === pending.digest &&
        pending.confirmation.forAttempt === nextAttempt;
      if (!confirmed) {
        if (snapshot.task.status === 'waiting_for_confirmation') return snapshot;
        return this.#requireConfirmation(snapshot, pending, ownerId, signal);
      }
      const intent = await this.#recordIntent(snapshot, pending, ownerId, signal);
      return this.#executePending(
        intent,
        intent.checkpoint.pendingAction as PendingActionCheckpoint,
        ownerId,
        signal,
      );
    }

    const verified = await this.#verifyEffect(snapshot.task, pending, signal);
    if (pending.evidence !== null) {
      await this.#dependencies.browser.recordVerification({
        outcomeId: actionOutcomeId(snapshot.task.id, pending),
        evidence: pending.evidence,
        verification: verified.result,
      });
    }
    const conclusive = pending.effectState !== 'unknown' || pending.expected.type !== 'page.stable';
    if (verified.result.satisfied && conclusive) {
      const consumed = consumeBrowserAction(snapshot.task.budget);
      const evidenceRef = pending.evidenceRef ?? this.#createId('verification');
      const completedToolResults = this.#completeBrowserToolCall(
        snapshot,
        pending,
        true,
        verified.result,
        evidenceRef,
      );
      return this.#saveBoundary(snapshot, ownerId, signal, {
        type: 'action.verified',
        reason: 'browser_action_effect_verified',
        pendingAction: {
          ...pending,
          outcome: 'verified',
          verified: true,
          evidenceRef,
        },
        budget: consumed,
        ...(verified.adoptedTab === null ? {} : { boundTabId: verified.adoptedTab.id }),
        actionId: pending.actionId,
        actionDigest: pending.digest,
        evidenceRef,
        completedToolResults,
      });
    }

    const decision = decideActionRecovery({
      risk: pending.risk,
      actionAttempts: pending.attemptCount,
      actionAttemptsLimit: snapshot.task.budget.actionAttemptsLimit,
      replansUsed: snapshot.task.budget.replansUsed,
      replansLimit: snapshot.task.budget.replansLimit,
      resultKnown: pending.effectState === 'reported',
    });
    if (decision === 'retry_action') {
      const intent = await this.#recordIntent(snapshot, pending, ownerId, signal);
      return this.#executePending(
        intent,
        intent.checkpoint.pendingAction as PendingActionCheckpoint,
        ownerId,
        signal,
      );
    }
    if (decision === 'wait_for_confirmation') {
      return this.#requireConfirmation(snapshot, pending, ownerId, signal);
    }
    if (decision === 'replan') {
      const budget = consumeReplan(consumeBrowserAction(snapshot.task.budget));
      const evidenceRef = pending.evidenceRef ?? this.#createId('verification');
      return this.#saveBoundary(snapshot, ownerId, signal, {
        type: 'action.verification-failed',
        reason: 'browser_action_effect_not_verified',
        pendingAction: { ...pending, outcome: 'failed', verified: false },
        budget,
        completedToolResults: this.#completeBrowserToolCall(
          snapshot,
          pending,
          false,
          verified.result,
          evidenceRef,
        ),
        actionId: pending.actionId,
        actionDigest: pending.digest,
        ...(pending.evidenceRef === null ? {} : { evidenceRef: pending.evidenceRef }),
      });
    }
    const evidenceRef = pending.evidenceRef ?? this.#createId('verification');
    return this.#saveBoundary(snapshot, ownerId, signal, {
      type: 'task.budget-exhausted',
      reason: 'browser_action_recovery_budget_exhausted',
      pendingAction: { ...pending, outcome: 'failed', verified: false },
      actionId: pending.actionId,
      actionDigest: pending.digest,
      completedToolResults: this.#completeBrowserToolCall(
        snapshot,
        pending,
        false,
        verified.result,
        evidenceRef,
      ),
    });
  }

  /** Produces an idempotent function-call output for one conclusive browser action result. */
  #completeBrowserToolCall(
    snapshot: TaskSnapshot,
    pending: PendingActionCheckpoint,
    verified: boolean,
    verification: VerificationResult,
    resultRef: string,
  ): readonly CompletedToolResult[] {
    if (pending.modelCall === null) return snapshot.checkpoint.completedToolResults;
    return appendToolResult(snapshot.checkpoint.completedToolResults, {
      callId: pending.modelCall.callId,
      toolName: pending.modelCall.toolName,
      argumentsJson: pending.modelCall.argumentsJson,
      output: browserToolOutput(pending, verified, verification),
      resultRef,
    });
  }

  /** Enters a durable confirmation wait and invalidates confirmation for the prior attempt. */
  async #requireConfirmation(
    snapshot: TaskSnapshot,
    pending: PendingActionCheckpoint,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<TaskSnapshot> {
    const rebound = await this.#bindPendingToTaskTab(snapshot.task, pending);
    return this.#saveBoundary(snapshot, ownerId, signal, {
      type: 'task.confirmation-required',
      reason: 'high_risk_action_requires_confirmation',
      pendingAction: { ...rebound, confirmation: null },
      actionId: rebound.actionId,
      actionDigest: rebound.digest,
    });
  }

  /** Rebinds an unexecuted or retried action to the explicit current task tab and digest. */
  async #bindPendingToTaskTab(
    task: TaskRun,
    pending: PendingActionCheckpoint,
  ): Promise<PendingActionCheckpoint> {
    if (task.tabId === null || pending.action.tabId === task.tabId) return pending;
    const action = bindAction(pending.action, task.tabId, pending.risk);
    return {
      ...pending,
      action,
      expected: action.expected,
      digest: await digestAction(action),
      confirmation: null,
    };
  }

  /** Verifies one effect and constrains new-tab adoption to the persisted intent interval. */
  async #verifyEffect(
    task: TaskRun,
    pending: PendingActionCheckpoint,
    signal: AbortSignal,
  ): Promise<VerificationOutcome> {
    const tabId = task.tabId;
    if (tabId === null) {
      return {
        result: {
          satisfied: false,
          timedOut: false,
          checkedAt: this.#dependencies.clock.now(),
          evidence: { kind: pending.expected.type, details: { tabAvailable: false } },
        },
        adoptedTab: null,
      };
    }
    const result = await this.#dependencies.browser.verify({
      tabId,
      condition: pending.expected,
      timeoutMs:
        pending.action.type === 'waitFor'
          ? pending.action.timeoutMs
          : (this.#dependencies.verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS),
      signal,
    });
    if (pending.expected.type !== 'tab.opened') return { result, adoptedTab: null };
    const adoptedTab =
      pending.intentAt === null || pending.expected.openerTabId !== tabId
        ? null
        : await this.#dependencies.tabs.findAdoptableTab({
            openerTabId: tabId,
            createdAfter: pending.intentAt,
          });
    return {
      result:
        adoptedTab === null && result.satisfied
          ? { ...result, satisfied: false, timedOut: true }
          : result,
      adoptedTab,
    };
  }

  /** Persists one event and checkpoint atomically after renewing and fencing task ownership. */
  async #saveBoundary(
    snapshot: TaskSnapshot,
    ownerId: string,
    signal: AbortSignal,
    input: BoundaryInput,
  ): Promise<TaskSnapshot> {
    throwIfAborted(signal);
    const now = this.#dependencies.clock.now();
    const renewed = await this.#leases.renew(snapshot.task.id, ownerId, now);
    if (!renewed) throw new BrowserExecutorError('TASK_BUSY', 'Task lease was lost.');
    const current = await this.#dependencies.repository.get(snapshot.task.id);
    if (current?.checkpointId !== snapshot.checkpoint.id) {
      throw new BrowserExecutorError('TASK_STATE_STALE', 'Task changed during execution.');
    }
    const transitioned = transitionTask(
      { ...snapshot.task, lease: current.lease },
      {
        type: input.type,
        at: now,
        reason: input.reason,
        ...(input.error === undefined ? {} : { error: input.error }),
        ...(input.boundTabId === undefined ? {} : { boundTabId: input.boundTabId }),
      },
    );
    const checkpointId = this.#createId('checkpoint');
    const task: TaskRun = {
      ...transitioned,
      checkpointId,
      ...(input.budget === undefined ? {} : { budget: input.budget }),
    };
    const sequence = (snapshot.events.at(-1)?.sequence ?? 0) + 1;
    const event: TaskEvent = {
      id: this.#createId('event'),
      taskId: task.id,
      sequence,
      type: input.type,
      reason: input.reason,
      at: now,
      error: input.error ?? null,
      ...(input.actionId === undefined ? {} : { actionId: input.actionId }),
      ...(input.actionDigest === undefined ? {} : { actionDigest: input.actionDigest }),
      ...(input.evidenceRef === undefined ? {} : { evidenceRef: input.evidenceRef }),
      ...(input.boundTabId === undefined ? {} : { boundTabId: input.boundTabId }),
    };
    const pendingAction =
      input.type === 'action.intent-recorded' && input.pendingAction !== undefined
        ? input.pendingAction === null
          ? null
          : { ...input.pendingAction, intentAt: now }
        : input.pendingAction;
    const checkpoint: Checkpoint = {
      ...snapshot.checkpoint,
      id: checkpointId,
      sequence,
      taskStatus: task.status,
      createdAt: now,
      ...(pendingAction === undefined ? {} : { pendingAction }),
      ...(input.observationRef === undefined ? {} : { observationRef: input.observationRef }),
      ...(input.completedToolResults === undefined
        ? {}
        : { completedToolResults: input.completedToolResults }),
    };
    await this.#dependencies.repository.saveTransition({ task, event, checkpoint });
    return { task, checkpoint, events: [...snapshot.events, event] };
  }

  /** Requests one nonblank identifier from the injected source. */
  #createId(prefix: string): string {
    const id = this.#dependencies.ids.create(prefix).trim();
    if (id.length === 0) {
      throw new BrowserExecutorError('TASK_STATE_STALE', 'Identifier generation failed.');
    }
    return id;
  }
}
