import type { ConversationRepository } from '../persistence/conversation-repository';
import type { TaskRepository } from '../persistence/task-repository';
import type { IdGenerator } from '../shared/ids';
import type { MessageStatus } from './message-types';
import type { Task } from './task-types';

export interface TaskReplyRetentionDependencies {
  readonly conversations: Pick<ConversationRepository, 'listMessages'>;
  readonly repository: Pick<TaskRepository, 'appendTaskMessage'>;
  readonly ids: IdGenerator;
}

/** Ensures a terminal task remains anchored in history without replacing generated assistant text. */
export async function retainTaskReply(
  task: Task,
  status: Extract<MessageStatus, 'error' | 'interrupted'>,
  dependencies: TaskReplyRetentionDependencies,
): Promise<void> {
  const messages = await dependencies.conversations.listMessages(task.conversationId);
  if (messages.some((message) => message.taskId === task.id && message.role === 'assistant')) {
    return;
  }
  const messageId = dependencies.ids.create('message').trim();
  if (messageId.length === 0) throw new Error('Reply identifier generation failed.');
  const message = {
    id: messageId,
    kind: 'conversation',
    conversationId: task.conversationId,
    taskId: task.id,
    role: 'assistant',
    status,
    text: '',
    attachmentIds: [],
    createdAt: task.updatedAt,
    updatedAt: task.updatedAt,
  } as const;
  await dependencies.repository.appendTaskMessage({
    message,
    eventId: dependencies.ids.create('event'),
    at: task.updatedAt,
  });
}
