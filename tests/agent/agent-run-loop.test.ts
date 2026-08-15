import { describe, expect, it, vi } from 'vitest';
import { AgentRunLoop } from '../../src/agent/agent-run-loop';
import type { AgentPlanInput, AgentPlanner } from '../../src/agent/execution-types';
import { providerErrorFromCode } from '../../src/providers/provider-errors';

const INPUT = {
  task: { id: 'task_1' },
  checkpoint: { id: 'checkpoint_1' },
  observation: { id: 'observation_1' },
} as unknown as AgentPlanInput;

/** Collects one resilient planner turn. */
async function collect(planner: AgentPlanner) {
  const events = [];
  for await (const event of planner.plan(INPUT, new AbortController().signal)) events.push(event);
  return events;
}

describe('AgentRunLoop', () => {
  it('restarts only the incomplete planner turn after a transient failure', async () => {
    let attempts = 0;
    const delegate: AgentPlanner = {
      async *plan() {
        attempts += 1;
        if (attempts === 1) throw providerErrorFromCode('TRANSIENT');
        yield { type: 'task.completed', reason: 'verified' };
      },
    };
    const sleep = vi.fn(async () => undefined);
    const loop = new AgentRunLoop(delegate, { random: () => 0.5, sleep });

    await expect(collect(loop)).resolves.toEqual([{ type: 'task.completed', reason: 'verified' }]);
    expect(attempts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(1_000, expect.any(AbortSignal));
  });

  it('rejects an empty or multi-decision planner turn', async () => {
    const empty: AgentPlanner = { async *plan() {} };
    await expect(collect(new AgentRunLoop(empty))).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });

    const multiple: AgentPlanner = {
      async *plan() {
        yield { type: 'task.completed', reason: 'first' };
        yield { type: 'task.completed', reason: 'second' };
      },
    };
    await expect(collect(new AgentRunLoop(multiple))).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });
});
