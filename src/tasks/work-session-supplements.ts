import type { MessageRecord } from './message-types';
import type { TaskRun } from './task-types';

/** Selects unconsumed supplements for one WorkSession in deterministic creation order. */
export function selectPendingWorkSessionSupplements(
  messages: readonly MessageRecord[],
  tasks: readonly TaskRun[],
  workSessionId: string,
  referencedMessageIds: ReadonlySet<string>,
): readonly MessageRecord[] {
  const workSessionTaskIds = new Set(
    tasks.filter((task) => task.workSessionId === workSessionId).map((task) => task.id),
  );
  return messages
    .filter(
      (message) =>
        message.kind === 'supplement' &&
        message.taskId !== null &&
        workSessionTaskIds.has(message.taskId) &&
        !referencedMessageIds.has(message.id),
    )
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt ||
        left.updatedAt - right.updatedAt ||
        left.id.localeCompare(right.id),
    );
}
