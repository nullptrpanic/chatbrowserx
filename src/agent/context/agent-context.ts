import type { AttachmentRecord } from '../../attachments/attachment-types';
import type { AttachmentRepository } from '../../persistence/attachment-repository';
import type { ConversationRepository } from '../../persistence/conversation-repository';
import type { ModelInputItem, ModelMessageContent } from '../../providers/provider-types';
import type { Checkpoint, CompletedToolResult } from '../../tasks/checkpoint-types';
import type { MessageRecord } from '../../tasks/message-types';
import type { TaskRun } from '../../tasks/task-types';
import {
  MAX_COMPLETED_TOOL_OUTPUT_CHARACTERS,
  MAX_MODEL_IMAGE_BYTES,
  MAX_MODEL_IMAGE_COUNT,
  MAX_MODEL_IMAGE_TOTAL_BYTES,
} from './context-budget';

const APPROVED_IMAGE_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);

export interface AgentContextInput {
  readonly task: TaskRun;
  readonly checkpoint: Checkpoint;
  readonly customSystemPrompt: string;
  readonly historyMessageLimit: number;
}

export interface AgentContextDependencies {
  readonly conversations: Pick<ConversationRepository, 'listMessages'>;
  readonly attachments: Pick<AttachmentRepository, 'get'>;
}

export interface AgentContext {
  readonly systemPrompt: string;
  readonly input: readonly ModelInputItem[];
}

/** Selects the persisted user message that created the current task. */
function currentUserMessage(
  messages: readonly MessageRecord[],
  taskId: string,
): MessageRecord | undefined {
  return messages.findLast(
    (message) =>
      message.taskId === taskId && message.role === 'user' && message.status === 'complete',
  );
}

/** Selects the newest completed conversational turns without replaying the current task. */
function selectedHistoryMessages(
  messages: readonly MessageRecord[],
  taskId: string,
  limit: number,
): readonly MessageRecord[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('History message limit is invalid.');
  }
  const selected = messages
    .filter(
      (message) =>
        message.taskId !== taskId &&
        message.status === 'complete' &&
        (message.role === 'user' || message.role === 'assistant'),
    )
    .slice(-limit);

  // Avoid starting Provider context with an assistant reply whose user turn was trimmed away.
  return selected[0]?.role === 'assistant' ? selected.slice(1) : selected;
}

/** Converts bytes to base64 without exceeding function argument limits for large images. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 8 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/** Revalidates one stored image before materializing a transient Provider data URL. */
async function attachmentDataUrl(attachment: AttachmentRecord): Promise<string> {
  const mimeType = attachment.mimeType.toLowerCase();
  if (
    !APPROVED_IMAGE_TYPES.has(mimeType) ||
    attachment.byteSize <= 0 ||
    attachment.byteSize > MAX_MODEL_IMAGE_BYTES ||
    attachment.byteSize !== attachment.blob.size ||
    attachment.blob.type.toLowerCase() !== mimeType
  ) {
    throw new Error('Referenced image attachment is invalid.');
  }
  const bytes = new Uint8Array(await attachment.blob.arrayBuffer());
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

interface LoadedImageBatch {
  readonly records: readonly AttachmentRecord[];
  readonly bytes: number;
}

/** Loads and revalidates one deduplicated persisted image batch. */
async function loadImageBatch(
  attachmentIds: readonly string[],
  attachments: Pick<AttachmentRepository, 'get'>,
): Promise<LoadedImageBatch> {
  const ids = [...new Set(attachmentIds)];
  const records: AttachmentRecord[] = [];
  let totalBytes = 0;
  for (const id of ids) {
    const attachment = await attachments.get(id);
    if (
      !attachment ||
      !APPROVED_IMAGE_TYPES.has(attachment.mimeType.toLowerCase()) ||
      attachment.byteSize <= 0 ||
      attachment.byteSize > MAX_MODEL_IMAGE_BYTES ||
      attachment.byteSize !== attachment.blob.size ||
      attachment.blob.type.toLowerCase() !== attachment.mimeType.toLowerCase()
    ) {
      throw new Error('Referenced image attachment is invalid.');
    }
    totalBytes += attachment.byteSize;
    records.push(attachment);
  }
  return { records, bytes: totalBytes };
}

/** Materializes current images first, then complete historical batches from newest to oldest. */
async function resolveConversationImages(
  current: MessageRecord,
  history: readonly MessageRecord[],
  attachments: Pick<AttachmentRepository, 'get'>,
): Promise<{
  readonly current: readonly string[];
  readonly history: ReadonlyMap<string, readonly string[]>;
}> {
  const currentIds = [...new Set(current.attachmentIds)];
  if (currentIds.length > MAX_MODEL_IMAGE_COUNT) {
    throw new Error('Referenced image attachment is invalid.');
  }
  const currentBatch = await loadImageBatch(currentIds, attachments);
  if (currentBatch.bytes > MAX_MODEL_IMAGE_TOTAL_BYTES) {
    throw new Error('Referenced image attachment is invalid.');
  }
  const currentImages = await Promise.all(currentBatch.records.map(attachmentDataUrl));

  let remainingCount = MAX_MODEL_IMAGE_COUNT - currentBatch.records.length;
  let remainingBytes = MAX_MODEL_IMAGE_TOTAL_BYTES - currentBatch.bytes;
  const historicalImages = new Map<string, readonly string[]>();
  for (let index = history.length - 1; index >= 0 && remainingCount > 0; index -= 1) {
    const message = history[index];
    if (!message || message.role !== 'user' || message.attachmentIds.length === 0) continue;
    const ids = [...new Set(message.attachmentIds)];
    if (ids.length > remainingCount) continue;

    const batch = await loadImageBatch(ids, attachments);
    if (batch.bytes > remainingBytes) continue;
    historicalImages.set(message.id, await Promise.all(batch.records.map(attachmentDataUrl)));
    remainingCount -= batch.records.length;
    remainingBytes -= batch.bytes;
  }

  return { current: currentImages, history: historicalImages };
}

/** Converts one stored conversational message to normalized Provider input. */
function modelMessage(
  message: MessageRecord,
  images: readonly string[] = [],
): ModelInputItem | undefined {
  const content: ModelMessageContent[] = [];
  if (message.text.length > 0) {
    content.push({
      type: message.role === 'assistant' ? 'output_text' : 'input_text',
      text: message.text,
    });
  }
  if (message.role === 'user') {
    content.push(
      ...images.map((imageUrl) => ({ type: 'input_image', imageUrl, detail: 'high' }) as const),
    );
  }
  if (content.length === 0 || (message.role !== 'user' && message.role !== 'assistant')) {
    return undefined;
  }
  return { type: 'message', role: message.role, content };
}

/** Keeps the newest completed tool details under a bounded recovery context. */
function boundedToolResults(
  results: readonly CompletedToolResult[],
): readonly CompletedToolResult[] {
  const selected: CompletedToolResult[] = [];
  let remaining = MAX_COMPLETED_TOOL_OUTPUT_CHARACTERS;
  for (let index = results.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const result = results[index];
    if (!result) continue;
    const size = result.argumentsJson.length + result.output.length;
    if (size > remaining) continue;
    selected.push(result);
    remaining -= size;
  }
  return selected.reverse();
}

/** Builds Provider input from bounded persisted history, the current user turn, and recovery tools. */
export async function buildAgentContext(
  context: AgentContextInput,
  dependencies: AgentContextDependencies,
): Promise<AgentContext> {
  const messages = await dependencies.conversations.listMessages(context.task.conversationId);
  const userMessage = currentUserMessage(messages, context.task.id);
  if (userMessage === undefined) {
    throw new Error('Current task user message is missing.');
  }
  const history = selectedHistoryMessages(messages, context.task.id, context.historyMessageLimit);
  const images = await resolveConversationImages(userMessage, history, dependencies.attachments);

  const input: ModelInputItem[] = [];
  for (const message of history) {
    const item = modelMessage(message, images.history.get(message.id));
    if (item) input.push(item);
  }
  const currentItem = modelMessage(userMessage, images.current);
  if (currentItem) input.push(currentItem);
  for (const result of boundedToolResults(context.checkpoint.completedToolResults)) {
    input.push(
      {
        type: 'function_call',
        callId: result.callId,
        name: result.toolName,
        argumentsJson: result.argumentsJson,
      },
      {
        type: 'function_call_output',
        callId: result.callId,
        output: result.output,
      },
    );
  }

  return {
    systemPrompt: context.customSystemPrompt,
    input,
  };
}
