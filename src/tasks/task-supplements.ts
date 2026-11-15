import type { TaskId } from '../shared/ids';
import type { MessageRecord } from './message-types';
import type { TaskEvent } from './task-types';
import { orderTaskMessagesByEvent } from './task-message-order';

/** Checks the permanent queue before loading message bodies. */
export function pendingTaskSupplementIds(
  events: readonly TaskEvent[],
  taskId: TaskId,
): ReadonlySet<string> {
  const queuedSequenceById = new Map<string, number>();
  const handled = new Set<string>();
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.taskId !== taskId) continue;
    if (event.type === 'supplement.queued') {
      if (queuedSequenceById.has(event.messageId)) {
        throw new Error('Task supplement event association is invalid.');
      }
      queuedSequenceById.set(event.messageId, event.sequence);
      continue;
    }
    if (event.type === 'supplement.applied' || event.type === 'supplement.forwarded') {
      const queuedSequence = queuedSequenceById.get(event.messageId);
      if (
        queuedSequence === undefined ||
        queuedSequence >= event.sequence ||
        handled.has(event.messageId)
      ) {
        throw new Error('Task supplement event association is invalid.');
      }
      handled.add(event.messageId);
    }
  }
  return new Set([...queuedSequenceById.keys()].filter((id) => !handled.has(id)));
}

/** Selects queued but not-yet-applied supplements in permanent TaskEvent order. */
export function selectPendingTaskSupplements(
  messages: readonly MessageRecord[],
  events: readonly TaskEvent[],
  taskId: TaskId,
): readonly MessageRecord[] {
  const pending = pendingTaskSupplementIds(events, taskId);
  try {
    return orderTaskMessagesByEvent(messages, events, taskId, 'supplement').filter((message) =>
      pending.has(message.id),
    );
  } catch {
    throw new Error('Task supplement event association is invalid.');
  }
}
