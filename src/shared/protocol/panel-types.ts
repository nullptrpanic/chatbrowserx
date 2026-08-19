export type PanelTaskStatus =
  'queued' | 'planning' | 'waiting_for_auth' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface PanelTabContext {
  readonly id: number;
  readonly title: string;
  readonly url: string;
  readonly origin: string;
  readonly supported: boolean;
  readonly hasPermission: boolean;
}

export interface PanelConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly tabId: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly taskStatus: PanelTaskStatus | null;
}

export interface PanelMessageSourcePage {
  readonly title: string;
  readonly url: string;
  readonly favIconUrl: string | null;
}

export interface PanelMessage {
  readonly id: string;
  readonly taskId: string | null;
  readonly role: 'user' | 'assistant' | 'system';
  readonly status: 'complete' | 'streaming' | 'interrupted' | 'error';
  readonly text: string;
  readonly attachmentIds: readonly string[];
  readonly sourcePage?: PanelMessageSourcePage | undefined;
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
  readonly reasoningSummary?: string | undefined;
  readonly supplementIds?: readonly string[] | undefined;
}

export interface PanelCompletedToolResult {
  readonly callId: string;
  readonly toolName: string;
  readonly argumentsJson: string;
  readonly output: string;
  readonly resultRef: string;
  readonly attachmentIds?: readonly string[];
}

export interface PanelTaskSupplement {
  readonly id: string;
  readonly text: string;
  readonly attachmentIds: readonly string[];
  readonly createdAt: number;
}

export interface PanelTask {
  readonly id: string;
  /** Summary projections are lightweight; full projections are loaded only after expansion. */
  readonly detailLevel?: 'summary' | 'full';
  readonly status: PanelTaskStatus;
  readonly goal: string;
  readonly tabId: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly sequence: number;
  /** Total completed tool calls; optional only for compatibility with an older live panel. */
  readonly completedToolCallCount?: number | undefined;
  readonly lastError: {
    readonly code: string;
    readonly retryable: boolean;
    readonly userMessage: string;
  } | null;
  readonly events: readonly PanelTaskEvent[];
  readonly completedToolResults: readonly PanelCompletedToolResult[];
  readonly supplements: readonly PanelTaskSupplement[];
}

export interface PanelSettingsSnapshot {
  readonly model: string;
  readonly reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
  readonly systemPrompt: string;
  readonly language: 'system' | 'zh-CN' | 'en' | 'ja';
  readonly historyMessageLimit: number;
  readonly hasCodexToken: boolean;
  readonly hasTavilyKey: boolean;
}

/** Settings returned only to the trusted settings screen after an explicit request. */
export interface PanelEditableSettings {
  readonly model: string;
  readonly reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
  readonly systemPrompt: string;
  readonly language: 'system' | 'zh-CN' | 'en' | 'ja';
  readonly historyMessageLimit: number;
  readonly codexAccessToken: string;
  readonly tavilyKey: string;
}

export interface PanelSnapshot {
  readonly generatedAt: number;
  readonly tab: PanelTabContext;
  readonly conversation: PanelConversationSummary | null;
  readonly conversations: readonly PanelConversationSummary[];
  readonly messages: readonly PanelMessage[];
  readonly attachments: readonly PanelAttachment[];
  readonly tasks: readonly PanelTask[];
  readonly task: PanelTask | null;
  readonly settings: PanelSettingsSnapshot;
}
