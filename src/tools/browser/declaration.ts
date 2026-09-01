import { browserService } from './service';
import {
  BROWSER_OPERATIONS,
  BROWSER_SCHEMAS,
  BROWSER_TOOL_DEFINITION_BY_NAME,
  BROWSER_TOOL_DEFINITIONS,
  SAFE_TO_REPLAY_BROWSER_TOOLS,
  type BrowserToolInput,
  type BrowserToolName,
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
  const checkpoint = context.checkpoint;
  if (
    typeof checkpoint !== 'object' ||
    checkpoint === null ||
    !('continuationItems' in checkpoint) ||
    !Array.isArray(checkpoint.continuationItems) ||
    !Array.isArray(context.toolResults)
  ) {
    return null;
  }
  return {
    checkpoint: checkpoint as BrowserToolState['checkpoint'],
    toolResults: context.toolResults as BrowserToolState['toolResults'],
  };
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
export function browserTool(name: BrowserToolName): ToolDeclaration<BrowserToolInput> {
  const replay = SAFE_TO_REPLAY_BROWSER_TOOLS.has(name) ? 'safe' : 'forbidden';
  return {
    name,
    definition: BROWSER_TOOL_DEFINITION_BY_NAME[name],
    schema: BROWSER_SCHEMAS[name],
    order: BROWSER_TOOL_DEFINITIONS.findIndex((definition) => definition.name === name),
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
    ...(name === BROWSER_TOOL_DEFINITIONS[0]?.name
      ? {
          blocksCompletion(context: ToolRuntimeContext) {
            const state = browserState(context);
            return state !== null && browserScrollContinuationForCheckpoint(state) !== null;
          },
        }
      : {}),
    callsUsed(context) {
      const checkpoint = context.checkpoint;
      return typeof checkpoint === 'object' &&
        checkpoint !== null &&
        'browserToolCallsInAttempt' in checkpoint &&
        typeof checkpoint.browserToolCallsInAttempt === 'number'
        ? checkpoint.browserToolCallsInAttempt
        : 0;
    },
    createCall: (call) => ({
      ...call,
      family: 'browser' as const,
      operation: BROWSER_OPERATIONS[name],
      replay: replay === 'safe' ? ('safe' as const) : ('mutation' as const),
    }),
    async execute(call, context, services, signal) {
      const currentTabId =
        typeof context.currentTabId === 'number' || context.currentTabId === null
          ? context.currentTabId
          : null;
      const sessionOwnerId =
        typeof context.sessionOwnerId === 'string' ? context.sessionOwnerId : undefined;
      const availableAssetIds = Array.isArray(context.availableAssetIds)
        ? context.availableAssetIds.filter((value): value is string => typeof value === 'string')
        : undefined;
      const result = await services
        .get(browserService)
        .execute(call as ParsedBrowserToolCall, signal, {
          currentTabId,
          ...(sessionOwnerId === undefined ? {} : { sessionOwnerId }),
          ...(availableAssetIds === undefined ? {} : { availableAssetIds }),
        });
      return {
        ...result,
        checkpoint: browserCheckpointAfterExecution(call, context, result.output),
      };
    },
  };
}
