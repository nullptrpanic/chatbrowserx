import type { HistoryReadInput, ResultReadInput } from '../../tasks/task-history-reader';
import { register } from '../register';
import type { ToolDeclaration, ToolRuntimeContext, ToolRuntimeHooks } from '../types';
import {
  historyReadDefinition,
  historyReadSchema,
  resultReadDefinition,
  resultReadSchema,
} from './contract';
import { historyService } from './service';

const historyPolicy = {
  budgetGroup: 'history',
  maxCalls: Number.MAX_SAFE_INTEGER,
} as const;
const historyAvailable = (context: ToolRuntimeContext): boolean =>
  context.historyAvailable === true;

function taskIdentity(context: ToolRuntimeContext): {
  readonly currentTaskId: string;
  readonly conversationId: string;
} {
  const task = context.task;
  if (task === undefined) throw new Error('History tool task context is unavailable.');
  return { currentTaskId: task.id, conversationId: task.conversationId };
}

export const historyReadTool: ToolDeclaration<HistoryReadInput> = {
  name: 'history_read',
  definition: historyReadDefinition,
  schema: historyReadSchema,
  order: 300,
  policy: historyPolicy,
  available: historyAvailable,
  async execute(call, context, services) {
    const result = await services
      .get(historyService)
      .readHistory(taskIdentity(context), call.arguments);
    return { output: JSON.stringify(result) };
  },
};

export const resultReadTool: ToolDeclaration<ResultReadInput> = {
  name: 'result_read',
  definition: resultReadDefinition,
  schema: resultReadSchema,
  order: 301,
  policy: historyPolicy,
  available: historyAvailable,
  async execute(call, context, services) {
    const result = await services
      .get(historyService)
      .readResult(taskIdentity(context), call.arguments);
    return { output: JSON.stringify(result) };
  },
};

export const historyRuntime = {
  prepare(context, services) {
    if (typeof context.historyAvailable === 'boolean') return {};
    const currentTaskId = context.task?.id ?? null;
    const tasks = context.conversationTasks ?? [];
    const historyAvailable =
      currentTaskId !== null &&
      services.has(historyService) &&
      tasks.some(
        (candidate) =>
          candidate.id !== currentTaskId &&
          (candidate.status === 'completed' ||
            candidate.status === 'failed' ||
            candidate.status === 'cancelled'),
      );
    return { context: { historyAvailable } };
  },
} satisfies ToolRuntimeHooks;

register(historyReadTool, historyRuntime);
register(resultReadTool, historyRuntime);
