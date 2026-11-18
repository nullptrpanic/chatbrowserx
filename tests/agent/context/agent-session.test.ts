import { describe, expect, it, vi } from 'vitest';
import {
  admitSessionMessages,
  finishInterruptedCalls,
  restoreAgentSession,
  sessionToolResult,
  renderSessionItems,
} from '../../../src/agent/context/agent-session';
import type { AgentSession } from '../../../src/tasks/agent-session-types';
import type { MessageRecord } from '../../../src/tasks/message-types';
import type { Task } from '../../../src/tasks/task-types';

const task: Task = {
  id: 'task',
  conversationId: 'conversation',
  ordinal: 1,
  tabId: 7,
  goal: 'Read',
  status: 'planning',
  latestRunId: 'run',
  lastEventSequence: 1,
  createdAt: 1,
  updatedAt: 1,
};
const message = (
  id: string,
  kind: 'conversation' | 'supplement' = 'conversation',
): MessageRecord => ({
  id,
  kind,
  conversationId: task.conversationId,
  taskId: task.id,
  role: 'user',
  status: 'complete',
  text: id,
  attachmentIds: [],
  createdAt: 1,
  updatedAt: 1,
});
const empty: AgentSession = {
  conversationId: task.conversationId,
  taskId: task.id,
  items: [],
  admittedMessageIds: [],
  lastInputTokens: null,
};

describe('conversation model window', () => {
  it('reconstructs legacy messages with a linear number of message ID reads', async () => {
    let idReads = 0;
    const messages = Array.from({ length: 100 }, (_, index) => {
      const id = 'message_' + String(index);
      return {
        ...message(id),
        get id() {
          idReads++;
          return id;
        },
      };
    });
    const events = messages.map((m, index) => ({
      id: 'event_' + String(index),
      taskId: task.id,
      runId: 'run',
      at: 1,
      sequence: index + 1,
      type: 'message.recorded' as const,
      messageId: m.id,
      role: 'user' as const,
    }));
    idReads = 0;
    const restored = await restoreAgentSession(task, [task], messages, {
      getAgentSession: async () => undefined,
      listEvents: async () => events,
      listToolResults: async () => [],
    });
    expect(restored.items).toHaveLength(messages.length);
    expect(idReads).toBeLessThan(messages.length * 10);
  });

  it('preserves the exact user text and source tab separately from attachment metadata', () => {
    const input = {
      ...message('user'),
      text: '  original\ninput  ',
      attachmentIds: ['image'],
      sourceTabId: 12,
      sourcePage: { title: 'Fixture', url: 'https://example.com', favIconUrl: null },
    };
    const session = admitSessionMessages(empty, task, [input]);
    expect(session.items[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'input_text', text: input.text },
        { type: 'input_text', text: expect.stringContaining('"sourceTabId":12') },
        { type: 'input_image', image: 'attachment://image' },
        { type: 'input_text', text: '{"attachmentIds":["image"]}' },
      ],
    });
  });

  it('loads active images only at request time and leaves historical images as discoverable references', async () => {
    const session = admitSessionMessages(empty, task, [
      { ...message('user'), attachmentIds: ['image'] },
    ]);
    const blob = new Blob(['image'], { type: 'image/png' });
    const get = vi.fn(async () => ({
      id: 'image',
      blob,
      byteSize: blob.size,
      mimeType: blob.type,
      width: 1,
      height: 1,
      source: 'file' as const,
      createdAt: 1,
    }));
    expect(JSON.stringify(await renderSessionItems(session.items, { get }))).toContain(
      'data:image/png;base64,',
    );
    expect(JSON.stringify(session.items)).not.toContain('base64');
    get.mockClear();
    const next = { ...task, id: 'next', ordinal: 2 };
    const restored = await restoreAgentSession(next, [task, next], [], {
      getAgentSession: async () => session,
      listEvents: async () => [],
      listToolResults: async () => [],
    });
    const rendered = await renderSessionItems(restored.items, { get });
    expect(get).not.toHaveBeenCalled();
    expect(JSON.stringify(rendered)).toContain('attachmentId');
    expect(JSON.stringify(rendered)).not.toContain('input_image');
  });

  it('rejects image metadata that disagrees with the stored bytes', async () => {
    const session = admitSessionMessages(empty, task, [
      { ...message('user'), attachmentIds: ['image'] },
    ]);
    const blob = new Blob(['image'], { type: 'image/png' });
    await expect(
      renderSessionItems(session.items, {
        get: async () => ({
          id: 'image',
          blob,
          byteSize: 1,
          mimeType: blob.type,
          width: 1,
          height: 1,
          source: 'file',
          createdAt: 1,
        }),
      }),
    ).rejects.toThrow('Referenced image attachment is invalid');
  });

  it('retains more than fifty messages and admits a supplement only once', () => {
    const messages = Array.from({ length: 60 }, (_, index) => message(`input_${index}`));
    const supplement = message('Use the second option', 'supplement');
    const first = admitSessionMessages(empty, task, messages);
    const second = admitSessionMessages(first, task, [...messages, supplement]);
    const third = admitSessionMessages(second, task, [supplement]);
    expect(third.items).toHaveLength(61);
    expect(JSON.stringify(third.items[0])).toContain('input_0');
    expect(third.items).toEqual(second.items);
  });

  it('pairs an interrupted call with an explicit unknown outcome instead of inventing success', () => {
    const items = finishInterruptedCalls([
      {
        type: 'function_call',
        callId: 'call',
        name: 'write',
        arguments: '{}',
        status: 'completed',
      },
    ]);
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({
      type: 'function_call_result',
      callId: 'call',
      status: 'incomplete',
    });
    expect(JSON.stringify(items[1])).toContain('EXECUTION_OUTCOME_UNKNOWN');
    expect(finishInterruptedCalls(items)).toEqual(items);
  });

  it('keeps the model-visible result and attachment references without storing image bytes', () => {
    const result = sessionToolResult({
      taskId: 'task',
      runId: 'run',
      callId: 'call',
      toolName: 'inspect',
      output: 'large audit payload',
      modelOutput: 'bounded evidence',
      attachmentIds: ['attachment_one'],
      createdAt: 1,
    });
    expect(result).toMatchObject({
      type: 'function_call_result',
      output: [
        { type: 'input_text', text: 'bounded evidence' },
        { type: 'input_image', image: 'attachment://attachment_one' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('large audit payload');
  });

  it('retains an unconsumed supplement and interrupted answer when a new task follows cancellation', async () => {
    const next = { ...task, id: 'next', ordinal: 2 };
    const initial = message('initial');
    const saved = admitSessionMessages(empty, task, [initial]);
    const supplement = message('unconsumed preference', 'supplement');
    const partial = {
      ...message('partial'),
      role: 'assistant' as const,
      status: 'interrupted' as const,
      text: 'Incomplete answer.',
    };
    const restored = await restoreAgentSession(next, [task, next], [initial, supplement, partial], {
      getAgentSession: async () => saved,
      listEvents: async () => [],
      listToolResults: async () => [],
    });
    expect(restored.items).toHaveLength(3);
    expect(JSON.stringify(restored.items)).toContain('unconsumed preference');
    expect(restored.items[2]).toMatchObject({ role: 'assistant', status: 'incomplete' });
  });
});
