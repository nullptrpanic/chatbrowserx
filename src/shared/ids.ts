export type TaskId = string;
export type ConversationId = string;
export type MessageId = string;
export type AttachmentId = string;

export interface IdGenerator {
  create(prefix: string): string;
}
