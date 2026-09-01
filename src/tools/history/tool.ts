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

function taskIdentity(context: ToolRuntimeContext): {
  readonly currentTaskId: string;
  readonly conversationId: string;
} {
  const task = context.task;
  if (typeof task !== 'object' || task === null || !('id' in task) || !('conversationId' in task)) {
    throw new Error('History tool task context is unavailable.');
  }
  return {
    currentTaskId: String(task.id),
    conversationId: String(task.conversationId),
  };
}

export const historyReadTool: ToolDeclaration<HistoryReadInput> = {
  name: 'history_read',
  definition: historyReadDefinition,
  schema: historyReadSchema,
  order: 300,
  policy: {
    budgetGroup: 'history',
    maxCalls: Number.MAX_SAFE_INTEGER,
  },
  available: (context) => context.historyAvailable === true,
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
  policy: {
    budgetGroup: 'history',
    maxCalls: Number.MAX_SAFE_INTEGER,
  },
  available: (context) => context.historyAvailable === true,
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
    const task = context.task;
    const currentTaskId =
      typeof task === 'object' && task !== null && 'id' in task ? String(task.id) : null;
    const tasks = Array.isArray(context.conversationTasks) ? context.conversationTasks : [];
    const historyAvailable =
      currentTaskId !== null &&
      services.has(historyService) &&
      tasks.some(
        (candidate) =>
          typeof candidate === 'object' &&
          candidate !== null &&
          'id' in candidate &&
          String(candidate.id) !== currentTaskId &&
          'status' in candidate &&
          (candidate.status === 'completed' ||
            candidate.status === 'failed' ||
            candidate.status === 'cancelled'),
      );
    return { context: { historyAvailable } };
  },
} satisfies ToolRuntimeHooks;

register(historyReadTool, historyRuntime);
register(resultReadTool, historyRuntime);
