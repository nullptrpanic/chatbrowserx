import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamPersistenceBuffer } from '../../src/agent/stream-persistence-buffer';
import type { ConversationRepository } from '../../src/persistence/conversation-repository';
import type { MessageRecord } from '../../src/tasks/message-types';

const MESSAGE: MessageRecord = {
  id: 'message_1',
  conversationId: 'conversation_1',
  taskId: 'task_1',
  role: 'assistant',
  status: 'streaming',
  text: '',
  attachmentIds: [],
  createdAt: 1_000,
  updatedAt: 1_000,
};

/** Creates a repository spy that records durable message snapshots. */
function repository(): ConversationRepository {
  return {
    create: vi.fn(async () => undefined),
    get: vi.fn(async () => undefined),
    listAll: vi.fn(async () => []),
    listByTab: vi.fn(async () => []),
    listMessages: vi.fn(async () => []),
    appendMessage: vi.fn(async () => undefined),
    updateMessage: vi.fn(async () => undefined),
    clearConversation: vi.fn(async () => undefined),
  };
}

describe('StreamPersistenceBuffer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('batches many small deltas into one write at one second', async () => {
    const messages = repository();
    const buffer = new StreamPersistenceBuffer(messages, MESSAGE, { now: () => Date.now() });

    for (let index = 0; index < 100; index += 1) {
      await buffer.append('x');
    }
    expect(messages.updateMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(messages.updateMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(messages.updateMessage).toHaveBeenCalledTimes(1);
    expect(messages.updateMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'streaming', text: 'x'.repeat(100) }),
    );
  });

  it('flushes immediately at eight KiB and forces the terminal write', async () => {
    const messages = repository();
    const buffer = new StreamPersistenceBuffer(messages, MESSAGE, { now: () => 2_000 });

    await buffer.append('x'.repeat(8 * 1024));
    expect(messages.updateMessage).toHaveBeenCalledTimes(1);
    await buffer.append('done');
    await buffer.complete();

    expect(messages.updateMessage).toHaveBeenCalledTimes(2);
    expect(messages.updateMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'complete', text: `${'x'.repeat(8 * 1024)}done` }),
    );
  });

  it('marks interrupted output without discarding accumulated text', async () => {
    const messages = repository();
    const buffer = new StreamPersistenceBuffer(messages, MESSAGE, { now: () => 3_000 });

    await buffer.append('partial answer');
    await buffer.interrupt();
    await vi.runAllTimersAsync();

    expect(messages.updateMessage).toHaveBeenCalledTimes(1);
    expect(messages.updateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'interrupted', text: 'partial answer' }),
    );
  });
});
