import type { MessageId } from '../shared/ids';

export type ModelOutputContinuationItem =
  | {
      readonly type: 'reasoning';
      readonly itemId: string;
      readonly encryptedContent: string;
      readonly summary: readonly {
        readonly type: 'summary_text';
        readonly text: string;
      }[];
    }
  | {
      readonly type: 'assistant_message_ref';
      readonly messageId: MessageId;
    };

export type ContinuationItem =
  | {
      readonly type: 'message_ref';
      readonly messageId: MessageId;
    }
  | {
      readonly type: 'function_call';
      readonly callId: string;
      readonly name: string;
      readonly argumentsJson: string;
      readonly modelOutputItems?: readonly ModelOutputContinuationItem[];
    }
  | {
      readonly type: 'function_call_output';
      readonly callId: string;
      readonly output: string;
      readonly resultRef: string;
      readonly attachmentIds?: readonly string[];
    }
  | {
      readonly type: 'function_call_output_ref';
      readonly callId: string;
      readonly resultRef: string;
      readonly attachmentIds?: readonly string[];
    }
  | {
      readonly type: 'compaction';
      readonly itemId: string;
      readonly encryptedContent: string;
    };

export type MaterializedContinuationItem = Exclude<
  ContinuationItem,
  { readonly type: 'function_call_output_ref' }
>;

export interface PendingToolCall {
  readonly callId: string;
  readonly name: string;
  readonly argumentsJson: string;
  readonly executionState: 'recorded' | 'may_have_dispatched';
  /** Stable trusted identifier used only to recover an idempotent Sandbox command dispatch. */
  readonly executionId?: string;
}
