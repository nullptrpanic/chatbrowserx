import type { DBSchema } from 'idb';
import type { AttachmentRecord, AttachmentReference } from '../attachments/attachment-types';
import type {
  AttachmentId,
  CheckpointId,
  ConversationId,
  MessageId,
  TaskEventId,
  TaskId,
  TaskRunId,
  ToolResultId,
} from '../shared/ids';
import type { Checkpoint } from '../tasks/checkpoint-types';
import type { Conversation } from '../tasks/conversation-types';
import type { MessageRecord } from '../tasks/message-types';
import type { Task, TaskEvent, TaskRun } from '../tasks/task-types';
import type { ToolResult } from '../tasks/tool-result-types';

// Never lower this value: existing extension profiles may already have completed version 2.
export const DATABASE_VERSION = 4;
export const DEFAULT_DATABASE_NAME = 'chatbrowserx-v1';

export const STORE_NAMES = {
  conversations: 'conversations',
  messages: 'messages',
  tasks: 'tasks',
  taskRuns: 'task-runs',
  taskEvents: 'task-events',
  toolResults: 'tool-results',
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
    indexes: {
      'by-conversation-created-at': [ConversationId, number];
      'by-task': TaskId;
    };
  };
  tasks: {
    key: TaskId;
    value: Task;
    indexes: {
      'by-status': string;
      'by-updated-at': number;
      'by-conversation': ConversationId;
      'by-conversation-ordinal': [ConversationId, number];
    };
  };
  'task-runs': {
    key: TaskRunId;
    value: TaskRun;
    indexes: {
      'by-task-attempt': [TaskId, number];
      'by-status': string;
    };
  };
  'task-events': {
    key: TaskEventId;
    value: TaskEvent;
    indexes: {
      'by-task-sequence': [TaskId, number];
      'by-task-type-sequence': [TaskId, string, number];
    };
  };
  'tool-results': {
    key: ToolResultId;
    value: ToolResult;
    indexes: {
      'by-task': TaskId;
      'by-run': TaskRunId;
      'by-task-call': [TaskId, string];
    };
  };
  checkpoints: {
    key: CheckpointId;
    value: Checkpoint;
    indexes: {
      'by-task': TaskId;
      'by-run': TaskRunId;
    };
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
