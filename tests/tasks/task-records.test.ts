import { describe, expect, expectTypeOf, it } from 'vitest';
import { materializeContinuationItems } from '../../src/tasks/continuation-materialization';
import type { Checkpoint } from '../../src/tasks/checkpoint-types';
import type { ContinuationItem } from '../../src/tasks/continuation-types';
import type { MessageRecord } from '../../src/tasks/message-types';
import type { Task, TaskEvent, TaskRun } from '../../src/tasks/task-types';
import type { ToolResult } from '../../src/tasks/tool-result-types';

describe('durable task records', () => {
  it('keeps a logical task distinct from one execution attempt', () => {
    expectTypeOf<Task['id']>().toEqualTypeOf<string>();
    expectTypeOf<TaskRun['taskId']>().toEqualTypeOf<string>();
    expectTypeOf<TaskEvent['runId']>().toEqualTypeOf<string>();
  });

  it('stores attachment references rather than image payloads in messages', () => {
    expectTypeOf<MessageRecord['role']>().toEqualTypeOf<'user' | 'assistant' | 'system'>();
    const message: MessageRecord = {
      id: 'message_1',
      kind: 'conversation',
      conversationId: 'conversation_1',
      taskId: 'task_1',
      role: 'user',
      status: 'complete',
      text: 'Use these images.',
      attachmentIds: ['attachment_1', 'attachment_2'],
      createdAt: 1,
      updatedAt: 1,
    };

    expect(JSON.stringify(message)).not.toMatch(/data:image|blob:/i);
  });

  it('keeps exact tool output outside the runtime checkpoint', () => {
    const result: ToolResult = {
      id: 'result_1',
      taskId: 'task_1',
      runId: 'run_1',
      callId: 'call_1',
      toolName: 'tavily_search',
      output: '{"ok":true,"results":[]}',
      attachmentIds: [],
      createdAt: 2,
    };
    const checkpoint: Checkpoint = {
      id: 'checkpoint_1',
      taskId: 'task_1',
      runId: 'run_1',
      continuationItems: [
        {
          type: 'function_call',
          callId: 'call_1',
          name: 'tavily_search',
          argumentsJson: '{"query":"browser reliability"}',
        },
        { type: 'function_call_output_ref', callId: 'call_1', resultId: 'result_1' },
      ],
      pendingToolCall: null,
      browserToolCallsInAttempt: 0,
      browserTargetTabId: 7,
      createdAt: 3,
    };

    expect(result.output).toContain('results');
    expect(JSON.stringify(checkpoint)).not.toContain(result.output);
    expectTypeOf<
      Extract<ContinuationItem, { readonly type: 'function_call_output' }>
    >().toEqualTypeOf<never>();
  });

  it('rejects the removed inline tool-output checkpoint shape at runtime', () => {
    const removedShape = {
      type: 'function_call_output',
      callId: 'call_legacy',
      resultId: 'result_legacy',
      output: '{"ok":true}',
    } as unknown as ContinuationItem;

    expect(() =>
      materializeContinuationItems({
        continuationItems: [removedShape],
        toolResults: [],
      }),
    ).toThrow('Task continuation item is invalid.');
  });
});
