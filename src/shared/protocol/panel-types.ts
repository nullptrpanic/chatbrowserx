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

export interface PanelMessageReplyReference {
  readonly messageId: string;
  readonly taskId: string;
  readonly excerpt: string;
  readonly attachmentCount: number;
  readonly createdAt: number;
}

export interface PanelMessage {
  readonly id: string;
  readonly taskId: string;
  /** Owning execution attempt, projected from the permanent message event. */
  readonly runId?: string | undefined;
  readonly role: 'user' | 'assistant' | 'system';
  readonly status: 'complete' | 'streaming' | 'interrupted' | 'error';
  readonly text: string;
  readonly attachmentIds: readonly string[];
  readonly sourcePage?: PanelMessageSourcePage | undefined;
  readonly replyTo?: PanelMessageReplyReference | undefined;
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
  readonly supplementIds?: readonly string[] | undefined;
  readonly resultId?: string | undefined;
}

export interface PanelToolResult {
  readonly callId: string;
  readonly toolName: string;
  readonly argumentsJson: string;
  readonly output: string;
  readonly resultId: string;
  readonly attachmentIds: readonly string[];
  /** One-based position among every user-visible execution-detail item. */
  readonly detailIndex: number;
}

export interface PanelTaskSupplement {
  readonly id: string;
  readonly text: string;
  readonly attachmentIds: readonly string[];
  readonly createdAt: number;
  /** Whether this supplement is already part of the active task continuation. */
  readonly applicationState: 'applied' | 'pending';
  /** One-based position among every user-visible execution-detail item. */
  readonly detailIndex: number;
}

export interface PanelTaskError {
  readonly code: string;
  readonly retryable: boolean;
  readonly userMessage: string;
}

/** Permanent lifecycle state for one execution attempt of a logical task. */
export interface PanelTaskRun {
  readonly id: string;
  readonly attempt: number;
  readonly status: PanelTaskStatus;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly lastError: PanelTaskError | null;
}

export interface PanelTask {
  readonly id: string;
  /** Latest execution attempt; used to attach live state to only that attempt's answer. */
  readonly latestRunId: string | null;
  /** Every attempt is retained so earlier failed or cancelled answers keep their own status. */
  readonly runs: readonly PanelTaskRun[];
  /** Summary projections are lightweight; full projections are loaded only after expansion. */
  readonly detailLevel: 'summary' | 'full';
  readonly status: PanelTaskStatus;
  readonly goal: string;
  readonly tabId: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly sequence: number;
  /** Total completed tool calls in permanent task history. */
  readonly completedToolCallCount: number;
  /** Total tool results and user supplements shown by the execution-detail timeline. */
  readonly detailItemCount: number;
  /** True after the cancelled task continuation was explicitly discarded. */
  readonly contextCleared: boolean;
  readonly lastError: PanelTaskError | null;
  readonly events: readonly PanelTaskEvent[];
  readonly toolResults: readonly PanelToolResult[];
  readonly supplements: readonly PanelTaskSupplement[];
}

export interface PanelSettingsSnapshot {
  readonly model: string;
  readonly reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
  readonly systemPrompt: string;
  readonly language: 'system' | 'zh-CN' | 'en' | 'ja';
  readonly historyMessageLimit: number;
  readonly sandboxServer?: string;
  readonly hasCodexToken: boolean;
  readonly hasTavilyKey: boolean;
  readonly hasSandboxToken?: boolean;
}

/** Settings returned only to the trusted settings screen after an explicit request. */
export interface PanelEditableSettings {
  readonly model: string;
  readonly reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
  readonly systemPrompt: string;
  readonly language: 'system' | 'zh-CN' | 'en' | 'ja';
  readonly historyMessageLimit: number;
  readonly sandboxServer?: string;
  readonly codexAccessToken: string;
  readonly tavilyKey: string;
  readonly sandboxToken?: string;
}

export interface PanelSnapshot {
  readonly stateVersion: number;
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
