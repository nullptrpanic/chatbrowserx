import type { ConversationId, TaskId } from '../shared/ids';
import type { Task } from './task-types';

export interface HistoricalTaskContext {
  readonly conversationId: ConversationId;
  readonly currentTaskId: TaskId;
}

/** Returns whether one task is stable enough to expose through historical-task offsets. */
export function isHistoricalTask(task: Task, context: HistoricalTaskContext): boolean {
  return (
    task.conversationId === context.conversationId &&
    task.id !== context.currentTaskId &&
    (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled')
  );
}

/** Orders previous logical tasks exactly as history_read interprets its one-based offset. */
export function orderedHistoricalTasks(
  tasks: readonly Task[],
  context: HistoricalTaskContext,
): readonly Task[] {
  return tasks
    .filter((task) => isHistoricalTask(task, context))
    .sort(
      (left, right) =>
        right.ordinal - left.ordinal ||
        right.createdAt - left.createdAt ||
        right.id.localeCompare(left.id),
    );
}
