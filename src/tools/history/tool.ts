import { validateImageBatch } from '../../attachments/attachment-policy';
import type { HistorySearchInput } from '../../tasks/task-history-reader';
import { register } from '../register';
import type { ToolDeclaration, ToolRuntimeContext, ToolRuntimeHooks } from '../types';
import {
  attachmentReadDefinition,
  attachmentReadSchema,
  historyReadDefinition,
  historyReadSchema,
  historySearchDefinition,
  historySearchSchema,
  historyReadRecordedSchemas,
  type HistoryReadTarget,
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
  readonly currentTaskLastEventSequence: number;
} {
  const task = context.task;
  if (task === undefined) throw new Error('History tool task context is unavailable.');
  return {
    currentTaskId: task.id,
    conversationId: task.conversationId,
    currentTaskLastEventSequence: task.lastEventSequence,
  };
}

export const historySearchTool: ToolDeclaration<HistorySearchInput> = {
  name: 'history.search',
  definition: historySearchDefinition,
  schema: historySearchSchema,
  recordedSchemas: new Map([['history_search', historySearchSchema]]),
  order: 299,
  policy: historyPolicy,
  available: historyAvailable,
  async execute(call, context, services) {
    const result = await services
      .get(historyService)
      .searchHistory(taskIdentity(context), call.arguments);
    return { output: JSON.stringify(result) };
  },
};

export const historyReadTool: ToolDeclaration<HistoryReadTarget> = {
  name: 'history.read',
  definition: historyReadDefinition,
  schema: historyReadSchema,
  recordedSchemas: historyReadRecordedSchemas,
  order: 300,
  policy: historyPolicy,
  available: historyAvailable,
  async execute(call, context, services) {
    const history = services.get(historyService);
    const identity = taskIdentity(context);
    const target = call.arguments;
    switch (target.kind) {
      case 'timeline':
        return { output: JSON.stringify(await history.readHistory(identity, target.input)) };
      case 'message':
        return { output: JSON.stringify(await history.readMessage(identity, target.input)) };
      case 'result':
        return { output: JSON.stringify(await history.readResult(identity, target.input)) };
    }
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
      (tasks.some(
        (candidate) =>
          candidate.id !== currentTaskId &&
          (candidate.status === 'completed' ||
            candidate.status === 'failed' ||
            candidate.status === 'cancelled'),
      ) ||
        (context.events ?? []).some(
          (event) =>
            event.type === 'model.turn' ||
            event.type === 'tool.result' ||
            event.type === 'context.compacted',
        ) ||
        (context.events ?? []).filter((event) => event.type === 'message.recorded').length > 1);
    return { context: { historyAvailable } };
  },
} satisfies ToolRuntimeHooks;

export const attachmentReadTool: ToolDeclaration<{ readonly attachmentIds: readonly string[] }> = {
  name: 'attachment.read',
  definition: attachmentReadDefinition,
  schema: attachmentReadSchema,
  recordedSchemas: new Map([['attachment_read', attachmentReadSchema]]),
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

register(historySearchTool, historyRuntime);
register(historyReadTool, historyRuntime);
register(attachmentReadTool, historyRuntime);
