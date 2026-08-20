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
    };

export interface PendingToolCall {
  readonly callId: string;
  readonly name: string;
  readonly argumentsJson: string;
  readonly executionState: 'recorded' | 'may_have_dispatched';
}
