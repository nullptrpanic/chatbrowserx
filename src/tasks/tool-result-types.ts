import type { AttachmentId, TaskId, TaskRunId } from '../shared/ids';

/** The only permanent copy of one completed tool's exact output. */
export interface ToolResult {
  /** Executed by the backend and retained in native model history, never redispatched locally. */
  readonly providerHosted?: boolean;
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
