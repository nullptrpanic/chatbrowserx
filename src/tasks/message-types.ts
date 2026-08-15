import type { AttachmentId, ConversationId, MessageId, TaskId } from '../shared/ids';

export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageStatus = 'complete' | 'streaming' | 'interrupted' | 'error';

export interface MessageRecord {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly taskId: TaskId | null;
  readonly role: MessageRole;
  readonly status: MessageStatus;
  readonly text: string;
  readonly attachmentIds: readonly AttachmentId[];
  readonly createdAt: number;
  readonly updatedAt: number;
}
