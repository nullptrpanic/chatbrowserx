import { browserService } from './service';
import { SAFE_TO_REPLAY_BROWSER_TOOLS } from './contract';
import type { ModelToolDefinition } from '../model-tool';
import type { ToolCompletionReview, ToolDeclaration, ToolRuntimeContext } from '../types';
import {
  browserScrollContinuationForCheckpoint,
  browserToolContractForCheckpoint,
  type BrowserToolContract,
  type BrowserToolState,
} from './availability';
import { browserCheckpointAfterExecution } from './lifecycle';
import { browserEngineCall, type BrowserCommand, type BrowserPublicTool } from './public-contract';

const contractCache = new WeakMap<
  object,
  {
    toolResults: unknown;
    definitions: ReadonlyMap<string, ModelToolDefinition>;
    choice: BrowserToolContract['toolChoice'];
  }
>();

function browserState(context: ToolRuntimeContext): BrowserToolState | null {
  if (context.checkpoint === undefined || context.toolResults === undefined) return null;
  return { checkpoint: context.checkpoint, toolResults: context.toolResults };
}

function browserContract(context: ToolRuntimeContext) {
  const state = browserState(context);
  if (state === null) return null;
  const cached = contractCache.get(state.checkpoint);
  if (cached?.toolResults === state.toolResults) return cached;
  const contract = browserToolContractForCheckpoint(state);
  const next = {
    toolResults: state.toolResults,
    definitions: new Map(contract.tools.map((definition) => [definition.name, definition])),
    choice: contract.toolChoice,
  };
  contractCache.set(state.checkpoint, next);
  return next;
}

/** Builds one independently registered browser call over the shared browser state machine. */
export function browserTool(
  spec: BrowserPublicTool,
  order: number,
): ToolDeclaration<BrowserCommand> {
  return {
    name: spec.definition.name,
    definition: spec.definition,
    schema: spec.schema,
    recordedSchemas: spec.recordedSchemas,
    order,
    policy: {
      budgetGroup: 'browser',
      maxCalls: 256,
      errorSource: 'browser',
      ambiguousMessage:
        'The previous browser action may already have run. Inspect the current page before choosing the next action.',
    },
    mutates: (call) => !SAFE_TO_REPLAY_BROWSER_TOOLS.has(call.arguments.name),
    model(context) {
      const contract = browserContract(context);
      const definition = contract && spec.model(contract.definitions);
      if (!definition) return null;
      const choice = contract.choice;
      return {
        definition,
        ...(typeof choice === 'object' && spec.recordedSchemas.has(choice.name)
          ? { force: true }
          : {}),
      };
    },
    ...(order === 0
      ? {
          reviewCompletion(context: ToolRuntimeContext): ToolCompletionReview | null {
            const state = browserState(context);
            const continuation = state && browserScrollContinuationForCheckpoint(state);
            if (!continuation) return null;
            return {
              type: 'continue',
              toolName: 'browser.scroll',
              feedback: JSON.stringify({
                completion: 'continue',
                reason: 'unfinished_scroll',
                next: { ...continuation, action: `browser.${continuation.next}` },
              }),
            };
          },
        }
      : {}),
    callsUsed(context) {
      return context.checkpoint?.browserToolCallsInAttempt ?? 0;
    },
    async execute(call, context, services, signal) {
      const currentTabId = context.currentTabId ?? null;
      const parsed = browserEngineCall(call);
      const result = await services.get(browserService).execute(parsed, signal, {
        currentTabId,
        ...(context.sessionOwnerId === undefined ? {} : { sessionOwnerId: context.sessionOwnerId }),
        ...(context.availableAssetIds === undefined
          ? {}
          : { availableAssetIds: context.availableAssetIds }),
      });
      return {
        ...result,
        checkpoint: browserCheckpointAfterExecution(parsed, context, result.output),
      };
    },
  };
}
