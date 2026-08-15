import type { ConversationId } from '../shared/ids';

export interface Conversation {
  readonly id: ConversationId;
  readonly tabId: number | null;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}
