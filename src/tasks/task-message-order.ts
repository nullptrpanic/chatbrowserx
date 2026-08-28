import type { TaskId } from '../shared/ids';
import type { MessageRecord } from './message-types';
import type { TaskEvent } from './task-types';

/** Joins canonical messages to their permanent task events and returns exact process order. */
export function orderTaskMessagesByEvent(
  messages: readonly MessageRecord[],
  events: readonly TaskEvent[],
  taskId: TaskId,
  kind: MessageRecord['kind'],
): readonly MessageRecord[] {
  const taskMessages = messages.filter(
    (message) => message.taskId === taskId && message.kind === kind,
  );
  const messagesById = new Map(taskMessages.map((message) => [message.id, message]));
  if (messagesById.size !== taskMessages.length) {
    throw new Error('Task message event association is invalid.');
  }
  const seen = new Set<string>();
  const ordered: MessageRecord[] = [];
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.taskId !== taskId) {
      continue;
    }
    const matchesKind =
      (kind === 'conversation' && event.type === 'message.recorded') ||
      (kind === 'supplement' && event.type === 'supplement.queued');
    if (!matchesKind || !('messageId' in event)) continue;
    const message = messagesById.get(event.messageId);
    if (message === undefined || seen.has(message.id)) {
      throw new Error('Task message event association is invalid.');
    }
    seen.add(message.id);
    ordered.push(message);
  }
  if (seen.size !== taskMessages.length) {
    throw new Error('Task message event association is invalid.');
  }
  return ordered;
}
