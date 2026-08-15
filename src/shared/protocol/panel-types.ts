export type PanelTaskStatus =
  | 'queued'
  | 'observing'
  | 'planning'
  | 'acting'
  | 'verifying'
  | 'checkpointed'
  | 'waiting_for_tab'
  | 'waiting_for_auth'
  | 'waiting_for_confirmation'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface PanelTabContext {
  readonly id: number;
  readonly title: string;
  readonly url: string;
  readonly origin: string;
  readonly supported: boolean;
  readonly hasPermission: boolean;
  readonly debuggerAttached: boolean;
}

export interface PanelConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly tabId: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly taskStatus: PanelTaskStatus | null;
}

export interface PanelMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly status: 'complete' | 'streaming' | 'interrupted' | 'error';
  readonly text: string;
  readonly attachmentIds: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PanelAttachment {
  readonly id: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly source: string;
  readonly fileName: string | null;
}

export interface PanelTaskEvent {
  readonly sequence: number;
  readonly type: string;
  readonly reason: string;
  readonly at: number;
}

export interface PanelPendingConfirmation {
  readonly digest: string;
  readonly actionKind: string;
  readonly targetLabel: string | null;
}

export interface PanelTask {
  readonly id: string;
  readonly status: PanelTaskStatus;
  readonly goal: string;
  readonly tabId: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly sequence: number;
  readonly browserActionsUsed: number;
  readonly browserActionsLimit: number;
  readonly lastError: {
    readonly code: string;
    readonly retryable: boolean;
    readonly userMessage: string;
  } | null;
  readonly pendingConfirmation: PanelPendingConfirmation | null;
  readonly events: readonly PanelTaskEvent[];
}

export interface PanelSettingsSnapshot {
  readonly model: string;
  readonly reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
  readonly systemPrompt: string;
  readonly language: 'system' | 'zh-CN' | 'en' | 'ja';
  readonly hasCodexToken: boolean;
  readonly hasTavilyKey: boolean;
}

export interface PanelSnapshot {
  readonly generatedAt: number;
  readonly tab: PanelTabContext;
  readonly conversation: PanelConversationSummary | null;
  readonly conversations: readonly PanelConversationSummary[];
  readonly messages: readonly PanelMessage[];
  readonly attachments: readonly PanelAttachment[];
  readonly task: PanelTask | null;
  readonly settings: PanelSettingsSnapshot;
}
