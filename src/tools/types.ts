import type { z } from 'zod';
import type { Checkpoint } from '../tasks/checkpoint-types';
import type { ContinuationItem, PendingToolCall } from '../tasks/continuation-types';
import type { MaterializedToolResult } from '../tasks/tool-result-types';
import type { Task } from '../tasks/task-types';
import type { ModelToolChoice, ModelToolDefinition } from './model-tool';
import type { ModelToolCallSource } from './tool-call-envelope';
import type { ToolServiceResolver } from './service-resolver';

export interface ToolExecutionPolicy {
  readonly budgetGroup: string;
  readonly budgetLabel?: string;
  readonly maxCalls: number;
  readonly mutation?: boolean;
  readonly executionIdPrefix?: string;
  readonly errorSource?: string;
  readonly ambiguousMessage?: string;
}

export interface ToolRuntimeContext {
  readonly task?: Task;
  readonly checkpoint?: Checkpoint;
  readonly toolResults?: readonly MaterializedToolResult[];
  readonly conversationTasks?: readonly Task[];
  readonly executionState?: PendingToolCall['executionState'];
  readonly resultId?: string;
  readonly currentTabId?: number | null;
  readonly sessionOwnerId?: string;
  readonly availableAssetIds?: readonly string[];
  readonly executionId?: string;
  readonly [name: string]: unknown;
}

export interface ValidatedToolCall<TArguments = unknown> extends ModelToolCallSource {
  readonly arguments: TArguments;
}

export interface ToolModelExposure {
  readonly definition: ModelToolDefinition;
  readonly force?: boolean;
}

export interface ToolExecutionResult {
  readonly output: string;
  readonly attachmentIds?: readonly string[];
  readonly modelAttachmentIds?: readonly string[];
  readonly modelOutput?: string;
  readonly checkpoint?: {
    readonly browserTargetTabId?: number | null;
    readonly browserToolCallsInAttemptDelta?: number;
  };
  readonly continuationItems?: readonly ContinuationItem[];
  readonly contextCompacted?: boolean;
}

export type ToolRecoveryResult =
  | { readonly status: 'finished'; readonly result: ToolExecutionResult }
  | { readonly status: 'not_found' }
  | {
      readonly status: 'running';
      readonly reason: string;
      readonly userMessage: string;
    };

export type ToolFailureAction =
  | { readonly type: 'record'; readonly output: string }
  | {
      readonly type: 'auth';
      readonly reason: string;
      readonly userMessage: string;
    }
  | {
      readonly type: 'pause';
      readonly reason: string;
      readonly userMessage: string;
      readonly code?: 'RateLimitError' | 'TransientProviderError';
      readonly recoveryAction?: string;
    }
  | {
      readonly type: 'fail';
      readonly reason: string;
      readonly code: 'InvalidProviderResponse' | 'TaskInputError';
      readonly recoveryAction: string;
      readonly userMessage: string;
    };

export interface ToolFailureContext {
  readonly phase: 'execute' | 'recover';
  readonly executionState: 'recorded' | 'may_have_dispatched';
}

export interface ToolDeclaration<TArguments = unknown> {
  readonly name: string;
  readonly definition: ModelToolDefinition;
  readonly schema: z.ZodType<TArguments>;
  readonly order?: number;
  readonly policy: ToolExecutionPolicy;
  available?(context: ToolRuntimeContext): boolean | Promise<boolean>;
  model?(context: ToolRuntimeContext): ToolModelExposure | null | Promise<ToolModelExposure | null>;
  blocksCompletion?(context: ToolRuntimeContext): boolean | Promise<boolean>;
  callsUsed?(context: ToolRuntimeContext): number;
  createCall?(call: ValidatedToolCall<TArguments>): ValidatedToolCall<TArguments>;
  execute(
    call: ValidatedToolCall<TArguments>,
    context: ToolRuntimeContext,
    services: ToolServiceResolver,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult>;
  recover?(
    call: ValidatedToolCall<TArguments>,
    context: ToolRuntimeContext,
    services: ToolServiceResolver,
    signal: AbortSignal,
  ): Promise<ToolRecoveryResult>;
  failure?(
    error: unknown,
    call: ValidatedToolCall<TArguments>,
    context: ToolFailureContext,
  ): ToolFailureAction | null;
}

export interface ToolPreparation {
  readonly context?: ToolRuntimeContext;
}

/** Shared lifecycle for independently registered tools from the same directory. */
export interface ToolRuntimeHooks {
  system_prompt?(
    context: ToolRuntimeContext,
    services: ToolServiceResolver,
    signal: AbortSignal,
  ): string | null | Promise<string | null>;
  prepare?(
    context: ToolRuntimeContext,
    services: ToolServiceResolver,
    signal: AbortSignal,
  ): ToolPreparation | Promise<ToolPreparation>;
  blocksCompletion?(
    context: ToolRuntimeContext,
    services: ToolServiceResolver,
  ): boolean | Promise<boolean>;
  preflight?(
    call: ValidatedToolCall,
    context: ToolRuntimeContext,
    services: ToolServiceResolver,
    signal: AbortSignal,
  ): ToolExecutionResult | null | Promise<ToolExecutionResult | null>;
  contextCompacted?(services: ToolServiceResolver): void | Promise<void>;
  release?(ownerId: string, services: ToolServiceResolver): void | Promise<void>;
}

/** One model-callable tool and its optional shared directory runtime. */
export interface RegisteredTool {
  readonly declaration: ToolDeclaration;
  readonly runtime?: ToolRuntimeHooks;
}

export interface ModelToolContract {
  readonly definitions: readonly ModelToolDefinition[];
  readonly toolChoice?: ModelToolChoice;
  readonly systemPrompt: string;
  parse(source: ModelToolCallSource): ValidatedToolCall;
}

export interface ToolRuntimePort {
  contract(context: ToolRuntimeContext, signal?: AbortSignal): Promise<ModelToolContract>;
  blocksCompletion(context: ToolRuntimeContext): Promise<boolean>;
  preflight(
    call: ValidatedToolCall,
    context: ToolRuntimeContext,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult | null>;
  contextCompacted(): Promise<void>;
  release(ownerId: string): Promise<void>;
  policyFor(name: string): ToolExecutionPolicy | null;
  canRecover(name: string): boolean;
  callsUsed(name: string, context: ToolRuntimeContext): number;
  parseRecorded(source: ModelToolCallSource): ValidatedToolCall;
  execute(
    call: ValidatedToolCall,
    context: ToolRuntimeContext,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult>;
  recover(
    call: ValidatedToolCall,
    context: ToolRuntimeContext,
    signal: AbortSignal,
  ): Promise<ToolRecoveryResult>;
  failureFor(
    call: ValidatedToolCall,
    error: unknown,
    context: ToolFailureContext,
  ): ToolFailureAction | null;
}
