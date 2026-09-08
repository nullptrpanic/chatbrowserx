import type { ConversationId, TaskId } from '../shared/ids';
import type { Task, TaskEvent } from './task-types';

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

/** Orders a complete task event log and rejects missing, duplicate, or foreign sequences. */
export function orderedTaskEvents(
  task: Task,
  events: readonly TaskEvent[],
  errorMessage = 'Task event records are inconsistent.',
): TaskEvent[] {
  const ordered = [...events].sort(
    (left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
  if (
    ordered.length !== task.lastEventSequence ||
    ordered.some((event, index) => event.taskId !== task.id || event.sequence !== index + 1)
  ) {
    throw new Error(errorMessage);
  }
  return ordered;
}
