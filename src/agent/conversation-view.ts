import type { ConversationRepository } from '../persistence/conversation-repository';
import type { TaskRepository } from '../persistence/task-repository';
import type { ConversationId } from '../shared/ids';
import type { MessageRecord } from '../tasks/message-types';
import type { Task, TaskEvent } from '../tasks/task-types';

export interface HistoryMessageOrder {
  readonly taskOrdinal: number;
  readonly eventSequence: number;
}

export interface ConversationView {
  readonly messages: readonly MessageRecord[];
  readonly tasks: readonly Task[];
  readonly messagesById: ReadonlyMap<string, MessageRecord>;
  readonly tasksById: ReadonlyMap<string, Task>;
  readonly historyMessageOrderById: ReadonlyMap<string, HistoryMessageOrder>;
}

export interface ConversationViewDependencies {
  readonly conversations: Pick<ConversationRepository, 'listMessages'>;
  readonly tasks: Pick<TaskRepository, 'listByConversation' | 'readTaskMessageEvents'>;
}

const MAX_HISTORY_MESSAGES = 50;

function isModelHistoryMessage(message: MessageRecord): boolean {
  return (
    message.kind === 'conversation' &&
    message.status === 'complete' &&
    (message.role === 'user' || message.role === 'assistant')
  );
}

/** Selects only the newest completed Tasks that can contribute the bounded model history. */
function historyTaskIds(
  messages: readonly MessageRecord[],
  tasks: readonly Task[],
): readonly string[] {
  const messageCountByTask = new Map<string, number>();
  for (const message of messages) {
    if (!isModelHistoryMessage(message)) continue;
    messageCountByTask.set(message.taskId, (messageCountByTask.get(message.taskId) ?? 0) + 1);
  }
  const ids: string[] = [];
  let messageCount = 0;
  for (const task of [...tasks].sort((left, right) => right.ordinal - left.ordinal)) {
    if (task.status !== 'completed') continue;
    const count = messageCountByTask.get(task.id) ?? 0;
    if (count === 0) continue;
    ids.push(task.id);
    messageCount += count;
    if (messageCount >= MAX_HISTORY_MESSAGES) break;
  }
  return ids;
}

function historyMessageOrder(
  messages: readonly MessageRecord[],
  tasks: readonly Task[],
  events: readonly TaskEvent[],
  selectedTaskIds: ReadonlySet<string>,
): ReadonlyMap<string, HistoryMessageOrder> {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const order = new Map<string, HistoryMessageOrder>();
  for (const event of events) {
    if (event.type !== 'message.recorded' || !selectedTaskIds.has(event.taskId)) continue;
    const task = tasksById.get(event.taskId);
    const message = messagesById.get(event.messageId);
    if (
      task === undefined ||
      message === undefined ||
      message.taskId !== event.taskId ||
      order.has(message.id)
    ) {
      throw new Error('Conversation message event association is invalid.');
    }
    order.set(message.id, {
      taskOrdinal: task.ordinal,
      eventSequence: event.sequence,
    });
  }
  if (
    messages.some(
      (message) =>
        selectedTaskIds.has(message.taskId) &&
        isModelHistoryMessage(message) &&
        !order.has(message.id),
    )
  ) {
    throw new Error('Conversation message event association is invalid.');
  }
  return order;
}

/** Builds one immutable per-turn view shared by all context consumers. */
export function createConversationView(
  messages: readonly MessageRecord[],
  tasks: readonly Task[],
  events: readonly TaskEvent[],
  selectedHistoryTaskIds: ReadonlySet<string>,
): ConversationView {
  const stableMessages = Object.freeze([...messages]);
  const stableTasks = Object.freeze([...tasks]);
  return {
    messages: stableMessages,
    tasks: stableTasks,
    messagesById: new Map(stableMessages.map((message) => [message.id, message])),
    tasksById: new Map(stableTasks.map((task) => [task.id, task])),
    historyMessageOrderById: historyMessageOrder(
      stableMessages,
      stableTasks,
      events,
      selectedHistoryTaskIds,
    ),
  };
}

/** Loads messages and logical tasks exactly once for one model turn. */
export async function loadConversationView(
  conversationId: ConversationId,
  dependencies: ConversationViewDependencies,
): Promise<ConversationView> {
  const [messages, tasks] = await Promise.all([
    dependencies.conversations.listMessages(conversationId),
    dependencies.tasks.listByConversation(conversationId),
  ]);
  const selectedTaskIds = historyTaskIds(messages, tasks);
  const events = await dependencies.tasks.readTaskMessageEvents(selectedTaskIds);
  return createConversationView(messages, tasks, events, new Set(selectedTaskIds));
}
