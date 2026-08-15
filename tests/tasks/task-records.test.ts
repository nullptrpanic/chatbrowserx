import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Checkpoint } from '../../src/tasks/checkpoint-types';
import type { MessageRecord } from '../../src/tasks/message-types';
import { hasStrictlyIncreasingTaskEventSequence, type TaskEvent } from '../../src/tasks/task-types';

describe('durable task records', () => {
  it('uses closed message role and status unions with attachment references', () => {
    expectTypeOf<MessageRecord['role']>().toEqualTypeOf<'user' | 'assistant' | 'system'>();
    expectTypeOf<MessageRecord['status']>().toEqualTypeOf<
      'complete' | 'streaming' | 'interrupted' | 'error'
    >();

    const message: MessageRecord = {
      id: 'message_1',
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
    expect(message.attachmentIds).toEqual(['attachment_1', 'attachment_2']);
  });

  it('binds the current checkpoint and pending action to one durable task', () => {
    const checkpoint: Checkpoint = {
      id: 'checkpoint_1',
      taskId: 'task_1',
      sequence: 1,
      taskStatus: 'checkpointed',
      completedToolResults: [],
      observationRef: 'observation_1',
      pendingAction: {
        actionId: 'action_1',
        digest: 'sha256:abc',
        kind: 'waitFor',
        risk: 'low',
        action: {
          actionId: 'action_1',
          tabId: 7,
          type: 'waitFor',
          timeoutMs: 300,
          risk: 'low',
          expected: { type: 'page.stable', quietMs: 300 },
        },
        expected: { type: 'page.stable', quietMs: 300 },
        intentAt: 2,
        attemptCount: 1,
        effectState: 'reported',
        outcome: 'verified',
        confirmation: null,
        evidence: null,
        evidenceRef: 'evidence_1',
        verified: true,
        modelCall: null,
      },
      createdAt: 3,
    };

    expect(checkpoint.taskId).toBe('task_1');
    expect(checkpoint.pendingAction?.digest).toBe('sha256:abc');
  });

  it('accepts only strictly increasing task-event sequences', () => {
    const events: readonly [TaskEvent, TaskEvent] = [
      {
        id: 'event_1',
        taskId: 'task_1',
        sequence: 1,
        type: 'observation.started',
        reason: 'Observe.',
        at: 1,
        error: null,
      },
      {
        id: 'event_2',
        taskId: 'task_1',
        sequence: 2,
        type: 'planning.started',
        reason: 'Plan.',
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
