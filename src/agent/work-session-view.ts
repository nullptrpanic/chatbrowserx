import type { ConversationRepository } from '../persistence/conversation-repository';
import type { TaskRepository } from '../persistence/task-repository';
import type { ConversationId } from '../shared/ids';
import type { MessageRecord } from '../tasks/message-types';
import type { TaskRun } from '../tasks/task-types';

export interface WorkSessionView {
  readonly messages: readonly MessageRecord[];
  readonly tasks: readonly TaskRun[];
  readonly messagesById: ReadonlyMap<string, MessageRecord>;
  readonly tasksById: ReadonlyMap<string, TaskRun>;
}

export interface WorkSessionViewDependencies {
  readonly conversations: Pick<ConversationRepository, 'listMessages'>;
  readonly tasks: Pick<TaskRepository, 'listByConversation'>;
}

/** Builds one read-only per-turn view so context consumers share the same durable snapshot. */
export function createWorkSessionView(
  messages: readonly MessageRecord[],
  tasks: readonly TaskRun[],
): WorkSessionView {
  const stableMessages = Object.freeze([...messages]);
  const stableTasks = Object.freeze([...tasks]);
  return {
    messages: stableMessages,
    tasks: stableTasks,
    messagesById: new Map(stableMessages.map((message) => [message.id, message])),
    tasksById: new Map(stableTasks.map((task) => [task.id, task])),
  };
}

/** Loads messages and tasks exactly once for one model turn. */
export async function loadWorkSessionView(
  conversationId: ConversationId,
  dependencies: WorkSessionViewDependencies,
): Promise<WorkSessionView> {
  const [messages, tasks] = await Promise.all([
    dependencies.conversations.listMessages(conversationId),
    dependencies.tasks.listByConversation(conversationId),
  ]);
  return createWorkSessionView(messages, tasks);
}
