import { describe, expect, it, vi } from 'vitest';
import type { TaskRun } from '../../src/tasks/task-types';
import { RecoveryScanner } from '../../src/tasks/recovery-scanner';
import { createTask } from '../../src/tasks/task-factory';

/**
 * Builds a task record with a deterministic status for recovery tests.
 */
function buildTask(id: string, status: TaskRun['status']): TaskRun {
  return {
    ...createTask(
      { conversationId: 'conv_1', tabId: 7, goal: id },
      { clock: { now: () => 1_000 }, ids: { create: () => id } },
    ),
    status,
  };
}

describe('RecoveryScanner', () => {
  it('starts each safe recoverable task once and ignores paused records defensively', async () => {
    const planning = buildTask('task_planning', 'planning');
    const paused = buildTask('task_paused', 'paused');
    const repository = {
      listRecoverable: vi.fn(async () => [planning, planning, paused]),
    };
    const startTask = vi.fn(async () => undefined);
    const scanner = new RecoveryScanner({
      repository,
      clock: { now: () => 2_000 },
      startTask,
    });

    await scanner.requestRecoveryScan();

    expect(startTask).toHaveBeenCalledTimes(1);
    expect(startTask).toHaveBeenCalledWith(planning.id);
  });

  it('coalesces concurrent scans so one task cannot be scheduled twice', async () => {
    const queued = buildTask('task_queued', 'queued');
    let resolveTasks: ((tasks: TaskRun[]) => void) | undefined;
    const pendingTasks = new Promise<TaskRun[]>((resolve) => {
      resolveTasks = resolve;
    });
    const repository = {
      listRecoverable: vi.fn(() => pendingTasks),
    };
    const startTask = vi.fn(async () => undefined);
    const scanner = new RecoveryScanner({
      repository,
      clock: { now: () => 2_000 },
      startTask,
    });

    const first = scanner.requestRecoveryScan();
    const second = scanner.requestRecoveryScan();
    resolveTasks?.([queued]);
    await Promise.all([first, second]);

    expect(repository.listRecoverable).toHaveBeenCalledTimes(1);
    expect(startTask).toHaveBeenCalledTimes(1);
  });

  it('resumes safe recoverable work automatically on browser startup', async () => {
    const queued = buildTask('task_queued', 'queued');
    const waiting = buildTask('task_waiting', 'waiting_for_auth');
    const paused = buildTask('task_paused', 'paused');
    const repository = {
      listRecoverable: vi.fn(async () => [queued, waiting, paused]),
    };
    const startTask = vi.fn(async () => undefined);
    const scanner = new RecoveryScanner({
      repository,
      clock: { now: () => 2_000 },
      startTask,
    });

    await scanner.handleBrowserStartup();

    expect(repository.listRecoverable).toHaveBeenCalledWith(2_000);
    expect(startTask).toHaveBeenCalledTimes(1);
    expect(startTask).toHaveBeenCalledWith(queued.id);
  });
});
