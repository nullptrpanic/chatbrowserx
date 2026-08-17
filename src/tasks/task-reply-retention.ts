import type { ConversationRepository } from '../persistence/conversation-repository';
import type { IdGenerator } from '../shared/ids';
import type { MessageStatus } from './message-types';
import type { TaskRun } from './task-types';

export interface TaskReplyRetentionDependencies {
  readonly conversations: Pick<ConversationRepository, 'listMessages' | 'appendMessage'>;
  readonly ids: IdGenerator;
}

/** Ensures a terminal task remains anchored in history without replacing generated assistant text. */
export async function retainTaskReply(
  task: TaskRun,
  status: Extract<MessageStatus, 'error' | 'interrupted'>,
  dependencies: TaskReplyRetentionDependencies,
): Promise<void> {
  const messages = await dependencies.conversations.listMessages(task.conversationId);
  if (messages.some((message) => message.taskId === task.id && message.role === 'assistant')) {
    return;
  }
  const messageId = dependencies.ids.create('message').trim();
  if (messageId.length === 0) throw new Error('Reply identifier generation failed.');
  await dependencies.conversations.appendMessage({
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
  });
}
