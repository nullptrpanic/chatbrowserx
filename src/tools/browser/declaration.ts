import { browserService } from './service';
import {
  SAFE_TO_REPLAY_BROWSER_TOOLS,
  browserOperationForName,
  type BrowserToolInput,
  type BrowserToolName,
  type BrowserToolSpec,
  type ParsedBrowserToolCall,
} from './contract';
import type { ModelToolDefinition } from '../model-tool';
import type { ToolDeclaration, ToolRuntimeContext } from '../types';
import {
  browserScrollContinuationForCheckpoint,
  browserToolContractForCheckpoint,
  type BrowserToolContract,
  type BrowserToolState,
} from './availability';
import { browserCheckpointAfterExecution } from './lifecycle';

const contractCache = new WeakMap<
  object,
  { toolResults: unknown; contract: BrowserToolContract }
>();

function browserState(context: ToolRuntimeContext): BrowserToolState | null {
  if (context.checkpoint === undefined || context.toolResults === undefined) return null;
  return { checkpoint: context.checkpoint, toolResults: context.toolResults };
}

function browserContract(context: ToolRuntimeContext): BrowserToolContract | null {
  const state = browserState(context);
  if (state === null) return null;
  const cached = contractCache.get(state.checkpoint);
  if (cached?.toolResults === state.toolResults) return cached.contract;
  const contract = browserToolContractForCheckpoint(state);
  contractCache.set(state.checkpoint, {
    toolResults: state.toolResults,
    contract,
  });
  return contract;
}

function browserDefinition(
  context: ToolRuntimeContext,
  name: BrowserToolName,
): ModelToolDefinition | null {
  const definitions = browserContract(context)?.tools;
  if (definitions === undefined) return null;
  return (
    definitions.find(
      (definition): definition is ModelToolDefinition =>
        typeof definition === 'object' &&
        definition !== null &&
        'name' in definition &&
        definition.name === name,
    ) ?? null
  );
}

/** Builds one independently registered browser call over the shared browser state machine. */
export function browserTool(
  spec: BrowserToolSpec,
  order: number,
): ToolDeclaration<BrowserToolInput> {
  const { name } = spec;
  const replay = SAFE_TO_REPLAY_BROWSER_TOOLS.has(name) ? 'safe' : 'forbidden';
  return {
    name,
    definition: spec.definition,
    schema: spec.schema,
    order,
    policy: {
      budgetGroup: 'browser',
      maxCalls: 256,
      mutation: replay !== 'safe',
      errorSource: 'browser',
      ambiguousMessage:
        'The previous browser action may already have run. Inspect the current page before choosing the next action.',
    },
    model(context) {
      const definition = browserDefinition(context, name);
      if (definition === null) return null;
      const choice = browserContract(context)?.toolChoice;
      return {
        definition,
        ...(typeof choice === 'object' && choice.type === 'function' && choice.name === name
          ? { force: true }
          : {}),
      };
    },
    ...(order === 0
      ? {
          blocksCompletion(context: ToolRuntimeContext) {
            const state = browserState(context);
            return state !== null && browserScrollContinuationForCheckpoint(state) !== null;
          },
        }
      : {}),
    callsUsed(context) {
      return context.checkpoint?.browserToolCallsInAttempt ?? 0;
    },
    createCall: (call) => ({
      ...call,
      family: 'browser' as const,
      operation: browserOperationForName(name),
      replay: replay === 'safe' ? ('safe' as const) : ('mutation' as const),
    }),
    async execute(call, context, services, signal) {
      const currentTabId = context.currentTabId ?? null;
      const result = await services
        .get(browserService)
        .execute(call as ParsedBrowserToolCall, signal, {
          currentTabId,
          ...(context.sessionOwnerId === undefined
            ? {}
            : { sessionOwnerId: context.sessionOwnerId }),
          ...(context.availableAssetIds === undefined
            ? {}
            : { availableAssetIds: context.availableAssetIds }),
        });
      return {
        ...result,
        checkpoint: browserCheckpointAfterExecution(call, context, result.output),
      };
    },
  };
}
