import type { ConversationId } from '../shared/ids';
import type { IdGenerator } from '../shared/ids';
import type { Clock } from '../shared/time';
import { DEFAULT_TASK_BUDGET } from './task-budget';
import type { TaskRun } from './task-types';

export interface CreateTaskInput {
  readonly conversationId: ConversationId;
  readonly tabId: number;
  readonly goal: string;
}

export interface TaskFactoryDependencies {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * Creates a validated queued task whose time and identifier sources are explicitly injected.
 */
export function createTask(input: CreateTaskInput, dependencies: TaskFactoryDependencies): TaskRun {
  const conversationId = input.conversationId.trim();
  const goal = input.goal.trim();

  if (conversationId.length === 0) {
    throw new Error('Conversation ID is required.');
  }

  if (!Number.isInteger(input.tabId) || input.tabId < 0) {
    throw new Error('Tab ID must be a non-negative integer.');
  }

  if (goal.length === 0 || goal.length > 20_000) {
    throw new Error('Task goal must contain between 1 and 20,000 characters.');
  }

  const id = dependencies.ids.create('task').trim();
  if (id.length === 0) {
    throw new Error('Task ID generator returned an empty identifier.');
  }

  const now = dependencies.clock.now();

  return {
    id,
    conversationId,
    tabId: input.tabId,
    goal,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    checkpointId: null,
    lease: null,
    budget: { ...DEFAULT_TASK_BUDGET },
    lastError: null,
  };
}
