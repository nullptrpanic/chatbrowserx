import type { AttachmentId, TaskId, TaskRunId, ToolResultId } from '../shared/ids';

/** The only permanent copy of one completed tool's exact output. */
export interface ToolResult {
  readonly id: ToolResultId;
  readonly taskId: TaskId;
  readonly runId: TaskRunId;
  readonly callId: string;
  readonly toolName: string;
  readonly output: string;
  readonly modelOutput?: string;
  readonly attachmentIds: readonly AttachmentId[];
  readonly createdAt: number;
}

/** Runtime view joining a tool.call event with its permanent ToolResult. */
export interface MaterializedToolResult extends ToolResult {
  readonly argumentsJson: string;
}
