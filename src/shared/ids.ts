export type TaskId = string;
export type TaskRunId = string;
export type TaskEventId = string;
export type ToolResultId = string;
export type CheckpointId = string;
export type ConversationId = string;
export type MessageId = string;
export type AttachmentId = string;

export interface IdGenerator {
  create(prefix: string): string;
}
