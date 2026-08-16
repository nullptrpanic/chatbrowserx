import type { TaskId } from '../shared/ids';
import type { TaskStatus } from './task-types';

export interface CompletedToolResult {
  readonly callId: string;
  readonly toolName: string;
  readonly argumentsJson: string;
  readonly output: string;
  readonly resultRef: string;
}

export interface Checkpoint {
  readonly id: string;
  readonly taskId: TaskId;
  readonly sequence: number;
  readonly taskStatus: TaskStatus;
  readonly completedToolResults: readonly CompletedToolResult[];
  readonly createdAt: number;
}
