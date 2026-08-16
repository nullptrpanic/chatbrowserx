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

/** Resolves only image IDs explicitly attached to the current user message. */
async function resolveImages(
  attachmentIds: readonly string[],
  attachments: Pick<AttachmentRepository, 'get'>,
): Promise<readonly string[]> {
  const ids = [...new Set(attachmentIds)].slice(0, MAX_MODEL_IMAGE_COUNT + 1);
  if (ids.length > MAX_MODEL_IMAGE_COUNT) {
    throw new Error('Referenced image attachment is invalid.');
  }

  const records: AttachmentRecord[] = [];
  let totalBytes = 0;
  for (const id of ids) {
    const attachment = await attachments.get(id);
    if (!attachment) {
      throw new Error('Referenced image attachment is invalid.');
    }
    totalBytes += attachment.byteSize;
    if (totalBytes > MAX_MODEL_IMAGE_TOTAL_BYTES) {
      throw new Error('Referenced image attachment is invalid.');
    }
    records.push(attachment);
  }
  return Promise.all(records.map(attachmentDataUrl));
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

/** Builds Provider input from only the current user message and completed tool exchanges. */
export async function buildAgentContext(
  context: AgentContextInput,
  dependencies: AgentContextDependencies,
): Promise<AgentContext> {
  const messages = await dependencies.conversations.listMessages(context.task.conversationId);
  const userMessage = currentUserMessage(messages, context.task.id);
  if (userMessage === undefined) {
    throw new Error('Current task user message is missing.');
  }
  const images = await resolveImages(userMessage.attachmentIds, dependencies.attachments);
  const content: ModelMessageContent[] = [];
  const text = userMessage.text;
  if (text.length > 0) content.push({ type: 'input_text', text });
  content.push(
    ...images.map((imageUrl) => ({ type: 'input_image', imageUrl, detail: 'high' }) as const),
  );

  const input: ModelInputItem[] = [];
  if (content.length > 0) {
    input.push({
      type: 'message',
      role: 'user',
      content,
    });
  }
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
