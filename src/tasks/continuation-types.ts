import type { MessageId } from '../shared/ids';

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
    }
  | {
      readonly type: 'function_call_output';
      readonly callId: string;
      readonly output: string;
      readonly resultRef: string;
    };

export interface PendingToolCall {
  readonly callId: string;
  readonly name: string;
  readonly argumentsJson: string;
}
