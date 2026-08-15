import type { TaskId } from '../shared/ids';
import type { BrowserActionRequest } from '../browser/contracts/action';
import type { BrowserActionEvidence } from '../browser/contracts/evidence';
import type { ExpectedCondition } from '../browser/verify/expected-condition';
import type { BrowserActionKind, TaskStatus } from './task-types';

export interface CompletedToolResult {
  readonly callId: string;
  readonly toolName: string;
  readonly argumentsJson: string;
  readonly output: string;
  readonly resultRef: string;
}

export interface ModelToolCallCheckpoint {
  readonly callId: string;
  readonly toolName: string;
  readonly argumentsJson: string;
}

export interface PendingActionCheckpoint {
  readonly actionId: string;
  readonly digest: string;
  readonly kind: BrowserActionKind;
  readonly risk: 'low' | 'high';
  readonly action: BrowserActionRequest;
  readonly expected: ExpectedCondition;
  readonly intentAt: number | null;
  readonly attemptCount: number;
  readonly effectState: 'not_attempted' | 'unknown' | 'reported';
  readonly outcome: 'pending' | 'verified' | 'failed';
  readonly confirmation: {
    readonly digest: string;
    readonly forAttempt: number;
    readonly confirmedAt: number;
  } | null;
  readonly evidence: BrowserActionEvidence | null;
  readonly evidenceRef: string | null;
  readonly verified: boolean;
  readonly modelCall: ModelToolCallCheckpoint | null;
}

export interface Checkpoint {
  readonly id: string;
  readonly taskId: TaskId;
  readonly sequence: number;
  readonly taskStatus: TaskStatus;
  readonly completedToolResults: readonly CompletedToolResult[];
  readonly observationRef: string | null;
  readonly pendingAction: PendingActionCheckpoint | null;
  readonly createdAt: number;
}
