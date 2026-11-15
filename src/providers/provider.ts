import type { AgentInputItem, Model, ModelRequest, Tool } from '@openai/agents-core';
import type { ModelUsage } from './model-events';

export interface ProviderModel {
  readonly id: string;
  readonly name: string;
  /** Omit from suggestions while retaining capabilities for an explicitly configured model. */
  readonly hidden?: boolean | undefined;
  readonly defaultReasoningEffort: string;
  readonly reasoningEfforts: readonly string[];
  readonly contextWindow: number;
}

export interface ModelSelection {
  readonly model: string;
  readonly reasoningEffort: string;
}

export type CredentialSyncStatus = 'idle' | 'synced' | 'failed';

export interface CredentialSyncSelection {
  readonly providerId?: string | undefined;
  readonly authPath: string;
}

export interface ProviderCredentialSync {
  getStatus(): Promise<CredentialSyncStatus>;
  refresh(): Promise<CredentialSyncStatus>;
}

/** The host depends on capabilities; wire formats and authentication belong to the backend. */
export interface Provider {
  readonly credentialSync?: ProviderCredentialSync | undefined;
  readonly hostedTools?: readonly Tool[];
  /** Model streams expose public summary deltas and canonical ModelUsage in rawUsage when reported. */
  getModel(selection: ModelSelection, sessionId?: string): Promise<Model>;
  listModels(signal: AbortSignal): Promise<readonly ProviderModel[]>;
  compact(
    selection: ModelSelection,
    request: ModelRequest,
    sessionId?: string,
  ): Promise<{
    readonly items: AgentInputItem[];
    readonly usage: ModelUsage | null;
  }>;
}
