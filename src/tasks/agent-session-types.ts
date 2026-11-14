import type { AgentInputItem } from '@openai/agents-core';
import type { ConversationId, MessageId, TaskId } from '../shared/ids';

/** Model window, independent of the visible transcript and a task's recovery checkpoint. */
export interface AgentSession {
  readonly providerId?: string;
  readonly conversationId: ConversationId;
  readonly taskId: TaskId;
  readonly items: readonly AgentInputItem[];
  /** Inputs admitted from the current task, including supplements, exactly once. */
  readonly admittedMessageIds: readonly MessageId[];
  readonly lastInputTokens: number | null;
}
