import type { DBSchema } from 'idb';
import type { AttachmentRecord, AttachmentReference } from '../attachments/attachment-types';
import type { AttachmentId, ConversationId, MessageId, TaskId } from '../shared/ids';
import type { Checkpoint } from '../tasks/checkpoint-types';
import type { Conversation } from '../tasks/conversation-types';
import type { MessageRecord } from '../tasks/message-types';
import type { TaskEvent, TaskRun } from '../tasks/task-types';

export const DATABASE_VERSION = 1;
export const DEFAULT_DATABASE_NAME = 'chatbrowserx-v1';

export const STORE_NAMES = {
  conversations: 'conversations',
  messages: 'messages',
  tasks: 'tasks',
  taskEvents: 'task-events',
  checkpoints: 'checkpoints',
  attachments: 'attachments',
  attachmentReferences: 'attachment-references',
} as const;

export interface ChatBrowserDatabase extends DBSchema {
  conversations: {
    key: ConversationId;
    value: Conversation;
    indexes: { 'by-tab-updated-at': [number, number] };
  };
  messages: {
    key: MessageId;
    value: MessageRecord;
    indexes: { 'by-conversation-created-at': [ConversationId, number] };
  };
  tasks: {
    key: TaskId;
    value: TaskRun;
    indexes: {
      'by-status': string;
      'by-updated-at': number;
      'by-conversation': ConversationId;
    };
  };
  'task-events': {
    key: string;
    value: TaskEvent;
    indexes: { 'by-task-sequence': [TaskId, number] };
  };
  checkpoints: {
    key: string;
    value: Checkpoint;
    indexes: { 'by-task': TaskId };
  };
  attachments: {
    key: AttachmentId;
    value: AttachmentRecord;
    indexes: { 'by-created-at': number };
  };
  'attachment-references': {
    key: [AttachmentId, string];
    value: AttachmentReference;
    indexes: {
      'by-attachment': AttachmentId;
      'by-reference': string;
    };
  };
}
