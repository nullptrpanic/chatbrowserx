import { validateImageBatch } from '../../attachments/attachment-policy';
import type {
  HistoryDetailReadInput,
  HistoryReadInput,
  ResultReadInput,
} from '../../tasks/task-history-reader';
import { register } from '../register';
import type { ToolDeclaration, ToolRuntimeContext, ToolRuntimeHooks } from '../types';
import {
  attachmentReadDefinition,
  attachmentReadSchema,
  historyDetailReadDefinition,
  historyDetailReadSchema,
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
  order: 302,
  policy: historyPolicy,
  available: historyAvailable,
  async execute(call, context, services) {
    const result = await services
      .get(historyService)
      .readResult(taskIdentity(context), call.arguments);
    return { output: JSON.stringify(result) };
  },
};

export const historyDetailReadTool: ToolDeclaration<HistoryDetailReadInput> = {
  name: 'history_detail_read',
  definition: historyDetailReadDefinition,
  schema: historyDetailReadSchema,
  order: 301,
  policy: historyPolicy,
  available: historyAvailable,
  async execute(call, context, services) {
    const result = await services
      .get(historyService)
      .readDetail(taskIdentity(context), call.arguments);
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

export const attachmentReadTool: ToolDeclaration<{ readonly attachmentIds: readonly string[] }> = {
  name: 'attachment_read',
  definition: attachmentReadDefinition,
  schema: attachmentReadSchema,
  order: 303,
  policy: historyPolicy,
  available: historyAvailable,
  async execute(call, context, services) {
    const images = await services
      .get(historyService)
      .readAttachments(taskIdentity(context), call.arguments.attachmentIds);
    if (images === null)
      return {
        output: JSON.stringify({
          ok: false,
          code: 'ATTACHMENT_NOT_FOUND',
          message: 'An image is unavailable in this conversation.',
          retryable: false,
        }),
      };
    const validation = validateImageBatch(images.map((image) => image.blob));
    if (!validation.ok)
      return {
        output: JSON.stringify({
          ok: false,
          code: validation.code,
          message: 'The requested images exceed the supported image limits or format.',
          retryable: false,
        }),
      };
    const attachmentIds = images.map((image) => image.id);
    return { output: JSON.stringify({ attachmentIds }), attachmentIds };
  },
};

register(historyReadTool, historyRuntime);
register(historyDetailReadTool, historyRuntime);
register(resultReadTool, historyRuntime);
register(attachmentReadTool, historyRuntime);
