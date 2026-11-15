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
  ToolCallKey,
} from '../shared/ids';
import type { Checkpoint } from '../tasks/checkpoint-types';
import type { Conversation } from '../tasks/conversation-types';
import type { MessageRecord } from '../tasks/message-types';
import type { Task, TaskEvent, TaskRun } from '../tasks/task-types';
import type { ToolResult } from '../tasks/tool-result-types';
import type { AgentSession } from '../tasks/agent-session-types';

export const DATABASE_VERSION = 6;
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
  agentSessions: 'agent-sessions',
} as const;

/** The single-element key keeps one pre-task window beside the active conversation window. */
export interface AgentSessionBackup {
  readonly conversationId: [ConversationId];
  readonly taskId: TaskId;
  readonly session: AgentSession;
}

export interface ChatBrowserDatabase extends DBSchema {
  'agent-sessions': {
    key: ConversationId | [ConversationId];
    value: AgentSession | AgentSessionBackup;
  };
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
    key: ToolCallKey;
    value: ToolResult;
    indexes: {
      'by-task': TaskId;
      'by-run': TaskRunId;
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
    key: [AttachmentId, AttachmentReference['referenceId']];
    value: AttachmentReference;
    indexes: {
      'by-attachment': AttachmentId;
      'by-reference': AttachmentReference['referenceId'];
    };
  };
}
