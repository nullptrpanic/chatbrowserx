import type { AttachmentId, ConversationId, MessageId, TaskId } from '../shared/ids';

export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageStatus = 'complete' | 'streaming' | 'interrupted' | 'error';
export type MessageKind = 'conversation' | 'supplement';

export interface MessageSourcePage {
  readonly title: string;
  readonly url: string;
  readonly favIconUrl: string | null;
}

export interface MessageReplyReference {
  readonly messageId: MessageId;
  readonly taskId: TaskId;
  readonly excerpt: string;
  readonly attachmentCount: number;
  readonly createdAt: number;
}

export interface MessageRecord {
  readonly id: MessageId;
  readonly kind: MessageKind;
  readonly conversationId: ConversationId;
  readonly taskId: TaskId;
  readonly role: MessageRole;
  readonly status: MessageStatus;
  readonly text: string;
  readonly attachmentIds: readonly AttachmentId[];
  readonly sourceTabId?: number | undefined;
  readonly sourcePage?: MessageSourcePage | undefined;
  readonly replyTo?: MessageReplyReference | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** User input before the command service assigns it to a durable Task. */
export type TaskMessageDraft = Omit<MessageRecord, 'taskId'>;
