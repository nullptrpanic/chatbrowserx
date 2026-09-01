import { describe, expect, it, vi } from 'vitest';
import { AgentFacade } from '../../src/agent/agent';
import type { MessageRecord } from '../../src/tasks/message-types';
import type { TaskSnapshot } from '../../src/tasks/task-command-service';

/** Builds the narrow lifecycle collaborators owned by the public Agent boundary. */
function buildFixture() {
  const snapshot = { task: { id: 'task_1' } } as TaskSnapshot;
  const order: string[] = [];
  const submissions = {
    createSubmission: vi.fn(async () => {
      order.push('persist.create');
      return snapshot;
    }),
    continueCancelledSubmission: vi.fn(async () => {
      order.push('persist.continue');
      return snapshot;
    }),
    appendSupplement: vi.fn(async () => undefined),
  };
  const commands = {
    getSnapshot: vi.fn(async () => snapshot),
    clearContext: vi.fn(async () => snapshot),
  };
  const coordinator = {
    schedule: vi.fn((taskId: string) => {
      void taskId;
      order.push('schedule');
    }),
    pause: vi.fn(async () => snapshot),
    resume: vi.fn(async () => snapshot),
    retry: vi.fn(async () => snapshot),
    cancel: vi.fn(async () => snapshot),
    dispose: vi.fn(async () => undefined),
  };
  const recovery = {
    requestRecoveryScan: vi.fn(async () => undefined),
    handleBrowserStartup: vi.fn(async () => undefined),
  };
  const agent = new AgentFacade({ submissions, commands, coordinator, recovery });
  return { agent, commands, coordinator, order, recovery, snapshot, submissions };
}

describe('AgentFacade', () => {
  it('persists a new task before scheduling its detached execution', async () => {
    const fixture = buildFixture();

    await expect(fixture.agent.start({ kind: 'create', submission: {} as never })).resolves.toBe(
      fixture.snapshot,
    );

    expect(fixture.order).toEqual(['persist.create', 'schedule']);
    expect(fixture.coordinator.schedule).toHaveBeenCalledOnce();
    expect(fixture.coordinator.schedule).toHaveBeenCalledWith('task_1');
  });

  it('uses the same start boundary for a cancelled-task continuation', async () => {
    const fixture = buildFixture();

    await fixture.agent.start({ kind: 'continue', submission: {} as never });

    expect(fixture.submissions.continueCancelledSubmission).toHaveBeenCalledOnce();
    expect(fixture.submissions.createSubmission).not.toHaveBeenCalled();
    expect(fixture.order).toEqual(['persist.continue', 'schedule']);
  });

  it('delegates lifecycle commands without adding a second resume or retry schedule', async () => {
    const fixture = buildFixture();

    await fixture.agent.pause('task_1');
    await fixture.agent.resume('task_1');
    await fixture.agent.retry('task_1');
    await fixture.agent.cancel('task_1');
    await fixture.agent.getSnapshot('task_1');
    await fixture.agent.clearContext('task_1');

    expect(fixture.coordinator.pause).toHaveBeenCalledWith('task_1');
    expect(fixture.coordinator.resume).toHaveBeenCalledWith('task_1');
    expect(fixture.coordinator.retry).toHaveBeenCalledWith('task_1');
    expect(fixture.coordinator.cancel).toHaveBeenCalledWith('task_1');
    expect(fixture.commands.getSnapshot).toHaveBeenCalledWith('task_1');
    expect(fixture.commands.clearContext).toHaveBeenCalledWith('task_1');
    expect(fixture.coordinator.schedule).not.toHaveBeenCalled();
  });

  it('keeps supplement, recovery, startup, and disposal behind the same facade', async () => {
    const fixture = buildFixture();
    const supplement = { id: 'message_1' } as MessageRecord;

    await fixture.agent.supplement(supplement);
    await fixture.agent.recover();
    await fixture.agent.handleBrowserStartup();
    await fixture.agent.dispose();

    expect(fixture.submissions.appendSupplement).toHaveBeenCalledWith(supplement);
    expect(fixture.recovery.requestRecoveryScan).toHaveBeenCalledOnce();
    expect(fixture.recovery.handleBrowserStartup).toHaveBeenCalledOnce();
    expect(fixture.coordinator.dispose).toHaveBeenCalledOnce();
  });
});
