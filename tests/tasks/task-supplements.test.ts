import { describe, expect, it } from 'vitest';
import type { MessageRecord } from '../../src/tasks/message-types';
import { selectPendingTaskSupplements } from '../../src/tasks/task-supplements';
import type { TaskEvent } from '../../src/tasks/task-types';

function supplement(id: string, createdAt: number): MessageRecord {
  return {
    id,
    kind: 'supplement',
    conversationId: 'conversation_1',
    taskId: 'task_1',
    role: 'user',
    status: 'complete',
    text: id,
    attachmentIds: [],
    createdAt,
    updatedAt: createdAt,
  };
}

function queued(id: string, sequence: number): TaskEvent {
  return {
    id: `event_queued_${id}`,
    taskId: 'task_1',
    runId: 'run_1',
    sequence,
    at: sequence,
    type: 'supplement.queued',
    messageId: id,
  };
}

describe('selectPendingTaskSupplements', () => {
  it('uses TaskEvent order and never requeues an applied supplement', () => {
    const first = supplement('supplement_first', 20);
    const second = supplement('supplement_second', 10);
    const events: TaskEvent[] = [
      queued(first.id, 3),
      queued(second.id, 4),
      {
        id: 'event_applied_first',
        taskId: 'task_1',
        runId: 'run_1',
        sequence: 5,
        at: 5,
        type: 'supplement.applied',
        messageId: first.id,
      },
    ];

    expect(selectPendingTaskSupplements([second, first], events, 'task_1')).toEqual([second]);
  });

  it('rejects a supplement message without its permanent queue event', () => {
    expect(() =>
      selectPendingTaskSupplements([supplement('supplement_orphan', 1)], [], 'task_1'),
    ).toThrow('Task supplement event association is invalid.');
  });
});
