import { describe, expect, it } from 'vitest';
import { discoverTools } from '../../../src/tools/discover';
import { bindToolRuntime } from '../../../src/tools/registry';
import { ToolServiceResolver } from '../../../src/tools/service-resolver';
import type { ToolRuntimeContext } from '../../../src/tools/types';
import type { MaterializedToolResult } from '../../../src/tasks/tool-result-types';
import type { TaskEvent } from '../../../src/tasks/task-types';

function runtime() {
  return bindToolRuntime(
    discoverTools().filter(({ declaration }) => declaration.name === 'task_progress'),
    new ToolServiceResolver(),
  );
}

function fixture() {
  const results: MaterializedToolResult[] = [];
  const events: TaskEvent[] = [];
  const context = {
    task: {
      id: 'task',
      conversationId: 'conversation',
      ordinal: 1,
      tabId: 1,
      goal: 'Move all permitted items; exclude Hold',
      status: 'planning',
      latestRunId: 'run',
      lastEventSequence: 0,
      createdAt: 1,
      updatedAt: 1,
    },
    checkpoint: {
      id: 'checkpoint',
      taskId: 'task',
      runId: 'run',
      continuationItems: [],
      pendingToolCall: null,
      browserToolCallsInAttempt: 0,
      browserTargetTabId: 1,
      createdAt: 1,
    },
    toolResults: results,
    events,
  } satisfies ToolRuntimeContext;
  function receipt(toolName = 'browser_inspect', output = '{"ok":true}', argumentsJson = '{}') {
    const callId = `call_${results.length}`;
    const result = {
      id: `result_${results.length}`,
      callId,
      taskId: 'task',
      runId: 'run',
      toolName,
      output,
      argumentsJson,
      attachmentIds: [],
      createdAt: results.length + 1,
    };
    results.push(result);
    events.push({
      type: 'tool.result',
      id: `event_${events.length}`,
      taskId: 'task',
      runId: 'run',
      sequence: events.length + 1,
      at: results.length,
      callId,
      resultId: result.id,
    });
    return callId;
  }
  async function update(input: unknown) {
    const tools = runtime();
    const call = (await tools.contract(context)).parse({
      callId: `call_${results.length}`,
      name: 'task_progress',
      argumentsJson: JSON.stringify({ update: input }),
    });
    const result = await tools.execute(call, context, AbortSignal.timeout(1000));
    receipt('task_progress', result.output, call.argumentsJson);
    return JSON.parse(result.output);
  }
  return { context, results, events, receipt, update };
}

const plan = {
  scope: 'Move Alpha and Beta; Hold is excluded',
  inventoryComplete: true,
  inventoryEvidence: 'All three items are explicitly enumerated in the user request',
  blocker: '',
  items: [
    {
      id: 'alpha',
      description: 'Alpha',
      status: 'pending',
      evidence: '',
      evidenceCallId: '',
    },
    {
      id: 'beta',
      description: 'Beta',
      status: 'pending',
      evidence: '',
      evidenceCallId: '',
    },
    {
      id: 'hold',
      description: 'Hold',
      status: 'excluded',
      evidence: 'User exclusion',
      evidenceCallId: '',
    },
  ],
};

describe('durable task progress', () => {
  it.each([
    ['browser_inspect', '{"ok":false,"code":"PAGE_UNAVAILABLE","message":"Page closed"}'],
    ['browser_inspect', ''],
    ['browser_inspect', '{broken'],
    ['browser_inspect', '{}'],
    ['sandbox_exec', '{"code":1,"stdout":"","stderr":"permission denied","truncated":false}'],
    ['sandbox_exec', '{"code":0,"stdout":"","stderr":"","executionStatus":"running"}'],
  ])('rejects unusable %s evidence: %s', async (toolName, output) => {
    const f = fixture();
    await f.update(plan);
    const evidenceCallId = f.receipt(toolName, output);
    const result = await f.update({
      ...plan,
      items: plan.items.slice(0, 2).map((item) => ({
        ...item,
        status: 'verified',
        evidence: 'Observed destination',
        evidenceCallId,
      })),
    });
    expect(result).toMatchObject({ ok: false, state: plan, availableEvidence: [] });
    expect((await f.update(null)).state).toEqual(plan);
    expect(await runtime().reviewCompletion?.(f.context)).toMatchObject({ type: 'continue' });
  });

  it.each([
    ['browser_inspect', '{"ok":true,"data":{"items":[]}}'],
    [
      'sandbox_exec',
      '{"code":0,"stdout":"HTTP 404: document absent","stderr":"","truncated":false}',
    ],
    ['sandbox_read', '{"code":0,"content":"","startLine":1,"endLine":0,"truncated":false}'],
  ])('retains successful negative observations from %s', async (toolName, output) => {
    const f = fixture();
    const evidenceCallId = f.receipt(toolName, output);
    expect(
      await f.update({
        ...plan,
        items: plan.items.slice(0, 2).map((item) => ({
          ...item,
          status: 'verified',
          evidence: 'Readback confirms absence',
          evidenceCallId,
        })),
      }),
    ).toMatchObject({ ok: true, review: { completion: 'ready' } });
  });

  it('reconciles legacy verified items backed only by failed observations', async () => {
    const f = fixture();
    const evidenceCallId = f.receipt('browser_inspect', '{"ok":false,"code":"PAGE_UNAVAILABLE"}');
    f.receipt(
      'task_progress',
      JSON.stringify({
        ok: true,
        updated: true,
        state: {
          ...plan,
          items: [{ ...plan.items[0], status: 'verified', evidence: 'Done', evidenceCallId }],
        },
      }),
    );
    expect(await f.update(null)).toMatchObject({
      state: { items: [{ id: 'alpha', status: 'uncertain' }] },
      review: { completion: 'continue', reason: 'unverified_outcomes' },
    });
    expect(await runtime().reviewCompletion?.(f.context)).toMatchObject({ type: 'continue' });
  });

  it('returns current verification facts before pending actions after a rejected final', async () => {
    const f = fixture();
    await f.update({
      ...plan,
      items: [
        {
          ...plan.items[0],
          status: 'uncertain',
          evidence: 'Move dispatched; target list is partial',
        },
        ...plan.items.slice(1),
      ],
    });
    f.events.push({
      type: 'status.changed',
      id: 'rejected',
      taskId: 'task',
      runId: 'run',
      sequence: f.events.length + 1,
      at: 20,
      taskStatus: 'planning',
      runStatus: 'planning',
      reason: 'completion_review:task_progress',
      error: null,
    });
    const read = await f.update(null);
    const expectedReview = {
      completion: 'continue',
      reason: 'unverified_outcomes',
      counts: { pending: 1, uncertain: 1, verified: 0, excluded: 1 },
      next: { action: 'observe_outcomes', itemIds: ['alpha'] },
    };
    expect(read.review).toEqual(expectedReview);
    const completionReview = await runtime().reviewCompletion?.(f.context);
    expect(completionReview?.type).toBe('continue');
    expect(
      JSON.parse(completionReview?.type === 'continue' ? completionReview.feedback : '{}'),
    ).toEqual(expectedReview);
    expect(read.state.items).toHaveLength(3);
    const evidenceCallId = f.receipt();
    const verified = await f.update({
      ...plan,
      items: [
        {
          ...plan.items[0],
          status: 'verified',
          evidence: 'Destination observed',
          evidenceCallId,
        },
      ],
    });
    expect(verified.review).toMatchObject({
      completion: 'continue',
      reason: 'pending_items',
      next: { action: 'execute_pending', itemIds: ['beta'] },
    });
  });

  it('reports the same completion decision in the receipt and the terminal guard', async () => {
    const f = fixture();
    expect((await f.update(null)).review).toMatchObject({
      completion: 'not_tracked',
    });
    const incomplete = await f.update({ ...plan, inventoryComplete: false });
    expect(incomplete.review).toMatchObject({
      completion: 'continue',
      reason: 'incomplete_inventory',
    });
    const blocked = await f.update({
      ...plan,
      blocker: 'Target permission denied',
    });
    expect(blocked.review).toMatchObject({
      completion: 'blocked',
      reason: 'external_blocker',
    });
    expect(await runtime().reviewCompletion?.(f.context)).toMatchObject({
      type: 'blocked',
    });
    const evidenceCallId = f.receipt();
    const ready = await f.update({
      ...plan,
      items: plan.items.slice(0, 2).map((item) => ({
        ...item,
        status: 'verified',
        evidence: 'Observed under target',
        evidenceCallId,
      })),
    });
    expect(ready.review).toMatchObject({ completion: 'ready', next: null });
    expect(await runtime().reviewCompletion?.(f.context)).toBeNull();
    f.context.checkpoint.runId = 'resumed';
    expect((await f.update(null)).review).toMatchObject({
      completion: 'continue',
      reason: 'stale_progress',
      next: { action: 'reconcile_progress' },
    });
    expect(await runtime().reviewCompletion?.(f.context)).toMatchObject({
      type: 'continue',
    });
  });

  it('keeps correction feedback and the last durable state on an invalid update', async () => {
    const f = fixture();
    await f.update(plan);
    const invalid = await f.update({
      ...plan,
      items: [
        {
          ...plan.items[0],
          status: 'verified',
          evidence: 'Clicked',
          evidenceCallId: 'missing',
        },
      ],
    });
    expect(invalid).toMatchObject({
      ok: false,
      state: plan,
      review: { completion: 'continue', reason: 'pending_items' },
    });
    expect((await f.update(null)).state).toEqual(plan);
  });

  it('reconciles new user input before suggesting writes from the previous scope', async () => {
    const f = fixture();
    await f.update(plan);
    f.events.push({
      type: 'supplement.queued',
      id: 'changed-scope',
      taskId: 'task',
      runId: 'run',
      sequence: f.events.length + 1,
      at: 30,
      messageId: 'exclude-alpha-now',
    });
    expect((await f.update(null)).review).toMatchObject({
      completion: 'continue',
      reason: 'stale_progress',
      next: { action: 'reconcile_progress', itemIds: [] },
    });
  });

  it('exposes structured progress without adding instructions', async () => {
    const contract = await runtime().contract({});
    expect(contract.definitions.map(({ name }) => name)).toEqual(['task_progress']);
    expect(contract.systemPrompt).toBe('');
  });

  it('blocks a partial final and retains omitted pending items after runtime reconstruction', async () => {
    const f = fixture();
    await f.update(plan);
    const evidenceCallId = f.receipt();
    const result = await f.update({
      ...plan,
      items: [
        {
          id: 'alpha',
          description: 'Alpha',
          status: 'verified',
          evidence: 'Alpha is under target',
          evidenceCallId,
        },
      ],
    });
    expect(result.state.items.map((item: { id: string }) => item.id)).toEqual([
      'alpha',
      'beta',
      'hold',
    ]);
    expect(await runtime().reviewCompletion?.(f.context)).toMatchObject({
      type: 'continue',
      toolName: 'task_progress',
    });
  });

  it('allows completion only after every authorized item has a real evidence reference', async () => {
    const f = fixture();
    await f.update(plan);
    const bad = await f.update({
      ...plan,
      items: plan.items.slice(0, 2).map((item) => ({
        ...item,
        status: 'verified',
        evidence: 'done',
        evidenceCallId: 'invented',
      })),
    });
    expect(bad.ok).toBe(false);
    const evidenceCallId = f.receipt();
    await f.update({
      ...plan,
      items: plan.items.slice(0, 2).map((item) => ({
        ...item,
        status: 'verified',
        evidence: 'Reloaded target contains this item',
        evidenceCallId,
      })),
    });
    expect(await runtime().reviewCompletion?.(f.context)).toBeNull();
  });

  it('does not allow an incomplete inventory or uncertain outcome to pass', async () => {
    const f = fixture();
    await f.update({
      ...plan,
      inventoryComplete: false,
      items: [
        {
          ...plan.items[0],
          status: 'uncertain',
          evidence: 'Drop sent but no readback',
        },
      ],
    });
    expect(await runtime().reviewCompletion?.(f.context)).toMatchObject({
      type: 'continue',
    });
  });

  it('pauses for a recorded blocker but invalidates it on a resumed run', async () => {
    const f = fixture();
    await f.update({
      ...plan,
      blocker: 'Permission denied; user must grant access to Beta',
    });
    expect(await runtime().reviewCompletion?.(f.context)).toMatchObject({
      type: 'blocked',
    });
    expect(
      await runtime().reviewCompletion?.({
        ...f.context,
        checkpoint: { ...f.context.checkpoint, runId: 'run_2' },
      }),
    ).toMatchObject({ type: 'continue' });
  });

  it('reports the rejected completion without forcing a ledger-only model turn', async () => {
    const f = fixture();
    await f.update(plan);
    f.events.push({
      type: 'status.changed',
      id: 'rejected',
      taskId: 'task',
      runId: 'run',
      sequence: f.events.length + 1,
      at: 20,
      taskStatus: 'planning',
      runStatus: 'planning',
      reason: 'completion_review:task_progress',
      error: null,
    });
    expect((await runtime().contract(f.context)).toolChoice).toBeUndefined();
    const review = await runtime().reviewCompletion?.(f.context);
    expect(review?.type).toBe('continue');
    expect(JSON.parse(review?.type === 'continue' ? review.feedback : '{}')).toMatchObject({
      completion: 'continue',
      reason: 'pending_items',
      counts: { pending: 2 },
      next: { action: 'execute_pending', itemIds: ['alpha', 'beta'] },
    });
    await f.update(plan);
    expect((await runtime().contract(f.context)).toolChoice).toBeUndefined();
  });

  it('does not impose a progress workflow on legacy tasks that never started one', async () => {
    const f = fixture();
    f.receipt();
    expect(await runtime().reviewCompletion?.(f.context)).toBeNull();
  });

  it('does not start a progress workflow by reading an empty ledger', async () => {
    const f = fixture();
    expect(await f.update(null)).toMatchObject({ updated: false, state: null });
    expect(await runtime().reviewCompletion?.(f.context)).toBeNull();
  });

  it('still requires correction after an invalid initial progress update', async () => {
    const f = fixture();
    expect(await f.update({ ...plan, inventoryEvidence: '' })).toMatchObject({
      ok: false,
    });
    await f.update(null);
    expect(await runtime().reviewCompletion?.(f.context)).toMatchObject({
      type: 'continue',
    });
  });

  it('can read after compaction without resetting a blocker or inventory', async () => {
    const f = fixture();
    await f.update({ ...plan, blocker: 'Access denied' });
    expect(f.context.checkpoint.continuationItems).toHaveLength(0);
    const read = await f.update(null);
    expect(read).toMatchObject({
      ok: true,
      updated: false,
      state: { blocker: 'Access denied', items: plan.items },
    });
    expect(await runtime().reviewCompletion?.(f.context)).toMatchObject({
      type: 'blocked',
    });
  });

  it.each(['supplement.applied', 'supplement.queued', 'tool.call'] as const)(
    'invalidates completion after %s',
    async (type) => {
      const f = fixture();
      const evidenceCallId = f.receipt();
      await f.update({
        ...plan,
        items: plan.items.map((item) => ({
          ...item,
          status: 'verified',
          evidence: 'Observed destination',
          evidenceCallId,
        })),
      });
      expect(await runtime().reviewCompletion?.(f.context)).toBeNull();
      const base = {
        id: 'later',
        taskId: 'task',
        runId: 'run',
        sequence: f.events.length + 1,
        at: 30,
      };
      f.events.push(
        type !== 'tool.call'
          ? { ...base, type, messageId: 'new-request' }
          : {
              ...base,
              type,
              callId: 'next',
              name: 'browser_click',
              argumentsJson: '{}',
            },
      );
      await f.update(null);
      expect(await runtime().reviewCompletion?.(f.context)).toMatchObject({
        type: 'continue',
      });
      await f.update({
        ...plan,
        items: [],
        blocker: 'Awaiting new authorization',
      });
      expect(await runtime().reviewCompletion?.(f.context)).toMatchObject({
        type: 'blocked',
      });
    },
  );

  it('rejects duplicate IDs, unjustified exclusions, and excessive cumulative inventory atomically', async () => {
    const f = fixture();
    await f.update(plan);
    expect(await f.update({ ...plan, items: [plan.items[0], plan.items[0]] })).toMatchObject({
      ok: false,
    });
    expect(
      await f.update({
        ...plan,
        items: [{ ...plan.items[0], status: 'excluded' }],
      }),
    ).toMatchObject({ ok: false });
    expect(await f.update({ ...plan, inventoryEvidence: '' })).toMatchObject({
      ok: false,
    });
    expect(
      await f.update({
        ...plan,
        items: Array.from({ length: 100 }, (_, i) => ({
          ...plan.items[0],
          id: String(i),
        })),
      }),
    ).toMatchObject({ ok: false });
    expect((await f.update(null)).state.items).toEqual(plan.items);
  });

  it('returns copyable evidence call IDs when the model supplied an observation snapshot ID', async () => {
    const f = fixture();
    await f.update(plan);
    const callId = f.receipt('browser_inspect', '{"ok":true,"data":{"snapshot":"snapshot_1"}}');
    const item = {
      ...plan.items[0],
      status: 'verified',
      evidence: 'Observed destination',
      evidenceCallId: 'snapshot_1',
    };
    const rejected = await f.update({ ...plan, items: [item] });
    expect(rejected).toMatchObject({
      ok: false,
      availableEvidence: [{ callId, toolName: 'browser_inspect' }],
    });
    const read = await f.update(null);
    expect(read.availableEvidence).toEqual(rejected.availableEvidence);
    expect(
      await f.update({
        ...plan,
        items: [{ ...item, evidenceCallId: read.availableEvidence[0].callId }],
      }),
    ).toMatchObject({ ok: true });
  });

  it('allows a verified empty inventory without fabricating a work item', async () => {
    const f = fixture();
    await f.update({
      ...plan,
      inventoryEvidence: 'All pages inspected; no eligible items',
      items: [],
    });
    expect(await runtime().reviewCompletion?.(f.context)).toBeNull();
  });
});
