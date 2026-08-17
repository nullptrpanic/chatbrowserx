import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Checkpoint } from '../../src/tasks/checkpoint-types';
import type { MessageRecord } from '../../src/tasks/message-types';
import { createTask } from '../../src/tasks/task-factory';
import { hasStrictlyIncreasingTaskEventSequence, type TaskEvent } from '../../src/tasks/task-types';

describe('durable task records', () => {
  it('creates a stable WorkSession identifier for a new task', () => {
    const task = createTask(
      { conversationId: 'conversation_1', tabId: 7, goal: 'Research this topic' },
      {
        clock: { now: () => 1 },
        ids: { create: (prefix) => `${prefix}_1` },
      },
    );

    expect(task.workSessionId).toBe('workSession_1');
  });

  it('stores attachment references rather than image payloads in messages', () => {
    expectTypeOf<MessageRecord['role']>().toEqualTypeOf<'user' | 'assistant' | 'system'>();
    const message: MessageRecord = {
      id: 'message_1',
      kind: 'conversation',
      conversationId: 'conversation_1',
      taskId: null,
      role: 'user',
      status: 'complete',
      text: 'Use these images.',
      attachmentIds: ['attachment_1', 'attachment_2'],
      createdAt: 1,
      updatedAt: 1,
    };

    expect(JSON.stringify(message)).not.toMatch(/data:image|blob:/i);
  });

  it('stores bounded Tavily results in the generic checkpoint interface', () => {
    const checkpoint: Checkpoint = {
      id: 'checkpoint_1',
      taskId: 'task_1',
      sequence: 1,
      taskStatus: 'planning',
      completedToolResults: [
        {
          callId: 'call_1',
          toolName: 'tavily_search',
          argumentsJson: '{"query":"browser reliability"}',
          output: '{"ok":true,"results":[]}',
          resultRef: 'result_1',
        },
      ],
      continuationItems: [
        {
          type: 'function_call',
          callId: 'call_1',
          name: 'tavily_search',
          argumentsJson: '{"query":"browser reliability"}',
        },
        {
          type: 'function_call_output',
          callId: 'call_1',
          output: '{"ok":true,"results":[]}',
          resultRef: 'result_1',
        },
      ],
      pendingToolCall: null,
      createdAt: 3,
    };

    expect(checkpoint.completedToolResults[0]).toMatchObject({
      toolName: 'tavily_search',
      resultRef: 'result_1',
    });
  });

  it('accepts only strictly increasing task-event sequences', () => {
    const events: readonly [TaskEvent, TaskEvent] = [
      {
        id: 'event_1',
        taskId: 'task_1',
        sequence: 1,
        type: 'planning.started',
        reason: 'Plan.',
        at: 1,
        error: null,
      },
      {
        id: 'event_2',
        taskId: 'task_1',
        sequence: 2,
        type: 'task.completed',
        reason: 'Done.',
        at: 2,
        error: null,
      },
    ];

    expect(hasStrictlyIncreasingTaskEventSequence(events)).toBe(true);
    expect(hasStrictlyIncreasingTaskEventSequence([{ ...events[1], sequence: 1 }, events[0]])).toBe(
      false,
    );
  });
});
