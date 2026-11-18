import type { AgentInputItem } from '@openai/agents-core';
import type { AgentSession } from '../../tasks/agent-session-types';
import type { MessageRecord } from '../../tasks/message-types';
import type { Task } from '../../tasks/task-types';
import type { ToolResult } from '../../tasks/tool-result-types';
import type { TaskRepository } from '../../persistence/task-repository';
import type { AttachmentRepository } from '../../persistence/attachment-repository';
import {
  attachmentDataUrl,
  modelMessage,
  resolveReplyProjection,
  resolveReplyProjections,
  type ReplyProjection,
} from './agent-context';
import { MAX_MODEL_IMAGE_COUNT, MAX_MODEL_IMAGE_TOTAL_BYTES } from './context-budget';
import { toolNameParts } from '../../tools/model-tool';

const ATTACHMENT_PREFIX = 'attachment://';

function messageItem(
  message: MessageRecord,
  task: Task,
  reply: ReplyProjection | undefined,
  historical = false,
): AgentInputItem | null {
  const projected = modelMessage(
    message,
    historical ? [] : message.attachmentIds.map((id) => `${ATTACHMENT_PREFIX}${id}`),
    {
      includeTaskPageContext: !historical && message.kind === 'conversation',
      taskCurrentTabBound: task.tabId !== null,
      ...(reply ? { reply } : {}),
    },
  );
  if (projected?.type !== 'message') return null;
  const content = projected.content.map((part) =>
    part.type === 'input_image'
      ? { type: 'input_image' as const, image: part.imageUrl, detail: part.detail }
      : part,
  );
  if (message.attachmentIds.length > 0)
    content.push({
      type: 'input_text',
      text: JSON.stringify({ attachmentIds: message.attachmentIds }),
    });
  if (projected.role === 'assistant') {
    return {
      type: 'message',
      role: 'assistant',
      status: message.status === 'complete' ? 'completed' : 'incomplete',
      content: projected.content
        .filter((part) => part.type === 'output_text')
        .map((part) => ({ type: 'output_text', text: part.text })),
    };
  }
  return {
    type: 'message',
    role: 'user',
    content: content.filter((part) => part.type !== 'output_text'),
  };
}

export function admitSessionMessages(
  session: AgentSession,
  task: Task,
  inputs: readonly MessageRecord[],
  allMessages: readonly MessageRecord[] = inputs,
  tasks: readonly Task[] = [task],
): AgentSession {
  const seen = new Set(session.taskId === task.id ? session.admittedMessageIds : []);
  const pending: MessageRecord[] = [];
  for (const message of inputs) {
    if (seen.has(message.id)) continue;
    if (message.taskId !== task.id || message.conversationId !== task.conversationId)
      throw new Error('Session input belongs to another task.');
    seen.add(message.id);
    pending.push(message);
  }
  const replies = pending.some((message) => message.replyTo !== undefined)
    ? resolveReplyProjections(pending, new Map(allMessages.map((m) => [m.id, m])), tasks, task)
    : undefined;
  const additions = pending.flatMap(
    (message) => messageItem(message, task, replies?.get(message.id)) ?? [],
  );
  return {
    ...session,
    taskId: task.id,
    items: [...session.items, ...additions],
    admittedMessageIds: [...seen],
  };
}

export function sessionToolResult(result: ToolResult): AgentInputItem {
  const text = result.modelOutput ?? result.output;
  return {
    type: 'function_call_result',
    ...toolNameParts(result.toolName),
    callId: result.callId,
    status: 'completed',
    output:
      result.attachmentIds.length === 0
        ? text
        : [
            { type: 'input_text', text },
            ...result.attachmentIds.map((id) => ({
              type: 'input_image' as const,
              image: `${ATTACHMENT_PREFIX}${id}`,
              detail: 'original',
            })),
          ],
  };
}

const retiredToolMessages = new Map([
  ['load_tools', 'Use the tools already provided in the request.'],
  [
    'browser_get_current_tab',
    'Use browser.tab with action=list to read the task-bound currentTabId.',
  ],
  ['history_detail_read', 'Use history.read to read a saved message or tool output.'],
]);

/** Resolves saved calls whose tool definitions were removed. */
export function retiredToolOutput(name: string): string | undefined {
  const message = retiredToolMessages.get(name);
  if (message === undefined) return undefined;
  return JSON.stringify({
    ok: false,
    code: 'TOOL_RETIRED',
    message,
    retryable: false,
  });
}

/** An interrupted task's unknown side effect must never become a successful historical result. */
export function finishInterruptedCalls(items: readonly AgentInputItem[]): AgentInputItem[] {
  const resolved = new Set(
    items.filter((item) => item.type === 'function_call_result').map((item) => item.callId),
  );
  return items.flatMap((item) =>
    item.type !== 'function_call' || resolved.has(item.callId)
      ? [item]
      : [
          item,
          {
            type: 'function_call_result',
            callId: item.callId,
            name: item.name,
            status: 'incomplete',
            output: JSON.stringify({
              ok: false,
              code: 'EXECUTION_OUTCOME_UNKNOWN',
              message:
                'The previous task ended without a recorded result. Inspect the effects before repeating this action.',
            }),
          },
        ],
  );
}

/** Older records predate native session persistence; restore their recorded facts once. */
export async function restoreAgentSession(
  task: Task,
  tasks: readonly Task[],
  messages: readonly MessageRecord[],
  repository: Pick<TaskRepository, 'getAgentSession' | 'listEvents' | 'listToolResults'>,
  existing?: AgentSession,
): Promise<AgentSession> {
  existing ??= await repository.getAgentSession(task.conversationId);
  if (existing?.taskId === task.id) {
    const interrupted = messages.filter(
      (message) =>
        message.taskId === task.id &&
        message.role === 'assistant' &&
        message.status === 'interrupted' &&
        message.text.length > 0,
    );
    return admitSessionMessages(existing, task, interrupted, messages, tasks);
  }
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const tasksById = new Map(tasks.map((entry) => [entry.id, entry]));
  const restoreMessage = (message: MessageRecord, owner: Task, historical: boolean) =>
    messageItem(
      message,
      owner,
      resolveReplyProjection(message, messagesById, tasksById, owner),
      historical,
    );
  if (existing) {
    const previous = tasksById.get(existing.taskId);
    if (!previous) throw new Error('Session owner is missing.');
    const admitted = new Set(existing.admittedMessageIds);
    const items = finishInterruptedCalls(existing.items);
    const assistantTexts = new Set(
      items.flatMap((item) =>
        'role' in item && item.role === 'assistant' && Array.isArray(item.content)
          ? [
              item.content
                .flatMap((part) => (part.type === 'output_text' ? [part.text] : []))
                .join(''),
            ]
          : [],
      ),
    );
    const forwarded = new Set(
      messages.flatMap((message) =>
        message.forwardedFromSupplementId ? [message.forwardedFromSupplementId] : [],
      ),
    );
    // Tasks can leave durable input outside the last admitted model window.
    for (const message of messages.filter((value) => value.taskId === previous.id)) {
      if (
        (message.role === 'user' && !admitted.has(message.id) && !forwarded.has(message.id)) ||
        (message.role === 'assistant' &&
          message.status === 'interrupted' &&
          message.text &&
          !assistantTexts.has(message.text))
      ) {
        const item = restoreMessage(message, previous, true);
        if (item) items.push(item);
      }
    }
    return { ...existing, items: historicalImages(items), admittedMessageIds: [] };
  }
  const items: AgentInputItem[] = [];
  const admittedMessageIds: string[] = [];
  for (const previous of tasks
    .filter((value) => value.ordinal <= task.ordinal)
    .sort((a, b) => a.ordinal - b.ordinal)) {
    const [events, results] = await Promise.all([
      repository.listEvents(previous.id),
      repository.listToolResults(previous.id),
    ]);
    if (events.some((event) => event.type === 'context.cleared')) continue;
    const resultsByCallId = new Map(results.map((result) => [result.callId, result]));
    const forwarded = new Set(
      events.flatMap((event) => (event.type === 'supplement.forwarded' ? [event.messageId] : [])),
    );
    const hostedCalls = new Set(
      results.filter((result) => result.providerHosted).map((result) => result.callId),
    );
    for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
      const active = previous.id === task.id;
      if (
        event.type === 'message.recorded' ||
        (event.type === (active ? 'supplement.applied' : 'supplement.queued') &&
          !forwarded.has(event.messageId))
      ) {
        const message = messagesById.get(event.messageId);
        if (!message || message.status === 'streaming' || message.status === 'error') continue;
        const item = restoreMessage(message, previous, !active);
        if (item) items.push(item);
        if (active) admittedMessageIds.push(message.id);
      } else if (event.type === 'tool.call') {
        if (hostedCalls.has(event.callId)) continue;
        items.push({
          type: 'function_call',
          callId: event.callId,
          ...toolNameParts(event.name),
          arguments: event.argumentsJson,
          status: 'completed',
        });
      } else if (event.type === 'tool.result') {
        const result = resultsByCallId.get(event.callId);
        if (!result) throw new Error('Historical tool result is missing.');
        items.push(
          result.providerHosted
            ? (JSON.parse(result.output) as AgentInputItem)
            : sessionToolResult(result),
        );
      }
    }
    if (previous.id !== task.id)
      items.splice(0, items.length, ...historicalImages(finishInterruptedCalls(items)));
  }
  return {
    conversationId: task.conversationId,
    taskId: task.id,
    items,
    admittedMessageIds,
    lastInputTokens: null,
  };
}

function imageParts(
  item: AgentInputItem,
): Array<{ type: string; image?: unknown; text?: string; detail?: unknown }> {
  if (
    (item.type === 'message' || 'role' in item) &&
    'content' in item &&
    Array.isArray(item.content)
  )
    return item.content;
  if (item.type === 'function_call_result' && Array.isArray(item.output)) return item.output;
  return [];
}

function historicalImages(items: readonly AgentInputItem[]): AgentInputItem[] {
  const copied = structuredClone([...items]);
  for (const item of copied)
    for (const part of imageParts(item)) {
      if (
        part.type === 'input_image' &&
        typeof part.image === 'string' &&
        part.image.startsWith(ATTACHMENT_PREFIX)
      ) {
        part.type = 'input_text';
        part.text = JSON.stringify({ attachmentId: part.image.slice(ATTACHMENT_PREFIX.length) });
        delete part.image;
        delete part.detail;
      }
    }
  return copied;
}

/** Only request-time rendering resolves attachments; persisted history contains IDs, never bytes. */
export async function renderSessionItems(
  items: readonly AgentInputItem[],
  attachments: Pick<AttachmentRepository, 'get'>,
): Promise<AgentInputItem[]> {
  const copied = structuredClone([...items]);
  let count = 0;
  let bytes = 0;
  for (const item of [...copied].reverse())
    for (const part of [...imageParts(item)].reverse()) {
      if (
        part.type !== 'input_image' ||
        typeof part.image !== 'string' ||
        !part.image.startsWith(ATTACHMENT_PREFIX)
      )
        continue;
      const id = part.image.slice(ATTACHMENT_PREFIX.length);
      const attachment = await attachments.get(id);
      if (!attachment) throw new Error('Referenced session attachment is missing.');
      if (
        count >= MAX_MODEL_IMAGE_COUNT ||
        bytes + attachment.byteSize > MAX_MODEL_IMAGE_TOTAL_BYTES
      ) {
        part.type = 'input_text';
        part.text = JSON.stringify({ attachmentId: id, code: 'IMAGE_BUDGET_EXCEEDED' });
        delete part.image;
        delete part.detail;
      } else {
        part.image = await attachmentDataUrl(attachment);
        count++;
        bytes += attachment.byteSize;
      }
    }
  return copied;
}
