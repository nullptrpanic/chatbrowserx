import { describe, expect, it, vi } from 'vitest';
import { TaskCoordinator } from '../../src/tasks/task-coordinator';
import type { TaskSnapshot } from '../../src/tasks/task-command-service';

/** Builds coordinator collaborators whose runner remains active until aborted or resolved. */
function buildFixture() {
  let resolveRun: (() => void) | undefined;
  const run = vi.fn(
    (_taskId: string, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        resolveRun = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      }),
  );
  const snapshot = { task: { id: 'task_1' } } as TaskSnapshot;
  const commands = {
    pause: vi.fn(async () => snapshot),
    resume: vi.fn(async () => snapshot),
    retry: vi.fn(async () => snapshot),
    cancel: vi.fn(async () => snapshot),
  };
  const coordinator = new TaskCoordinator({ executor: { run }, commands });
  return { coordinator, commands, run, snapshot, resolve: () => resolveRun?.() };
}

describe('TaskCoordinator', () => {
  it('deduplicates concurrent starts for one task', async () => {
    const fixture = buildFixture();

    const first = fixture.coordinator.start('task_1');
    const second = fixture.coordinator.start('task_1');
    expect(fixture.run).toHaveBeenCalledTimes(1);
    fixture.resolve();
    await Promise.all([first, second]);
  });

  it('aborts active execution before persisting pause or cancellation', async () => {
    const fixture = buildFixture();
    const running = fixture.coordinator.start('task_1');

    await fixture.coordinator.pause('task_1');
    await running;

    expect(fixture.run.mock.calls[0]?.[1].aborted).toBe(true);
    expect(fixture.commands.pause).toHaveBeenCalledWith('task_1');

    const secondRun = fixture.coordinator.start('task_2');
    await fixture.coordinator.cancel('task_2');
    await secondRun;
    expect(fixture.commands.cancel).toHaveBeenCalledWith('task_2');
  });

  it('returns resume after the durable command while fresh work runs in background', async () => {
    const fixture = buildFixture();

    await expect(fixture.coordinator.resume('task_1')).resolves.toEqual(fixture.snapshot);
    await vi.waitFor(() => expect(fixture.run).toHaveBeenCalledTimes(1));
    expect(fixture.commands.resume).toHaveBeenCalledWith('task_1');
    fixture.resolve();
  });

  it('returns retry after the durable command while rerunning the same task in background', async () => {
    const fixture = buildFixture();

    await expect(fixture.coordinator.retry('task_1')).resolves.toEqual(fixture.snapshot);
    await vi.waitFor(() => expect(fixture.run).toHaveBeenCalledWith('task_1', expect.anything()));
    expect(fixture.commands.retry).toHaveBeenCalledWith('task_1');
    fixture.resolve();
  });

  it('persists pause without waiting for an executor that ignores abort', async () => {
    let finish: (() => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const commands = {
      pause: vi.fn(async () => ({ task: { id: 'task_1' } }) as TaskSnapshot),
      resume: vi.fn(),
      retry: vi.fn(),
      cancel: vi.fn(),
    };
    const coordinator = new TaskCoordinator({ executor: { run }, commands });
    const running = coordinator.start('task_1');

    const pausing = coordinator.pause('task_1');
    await Promise.resolve();
    await Promise.resolve();

    expect(commands.pause).toHaveBeenCalledWith('task_1');
    await expect(pausing).resolves.toMatchObject({ task: { id: 'task_1' } });
    finish?.();
    await running;
  });

  it('waits for an aborted runner to settle before persisting deletion-safe cancellation', async () => {
    let finish: (() => void) | undefined;
    const run = vi.fn(
      (_taskId: string, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          finish = resolve;
          signal.addEventListener('abort', () => undefined, { once: true });
        }),
    );
    const snapshot = { task: { id: 'task_1' } } as TaskSnapshot;
    const commands = {
      pause: vi.fn(),
      resume: vi.fn(),
      retry: vi.fn(),
      cancel: vi.fn(async () => snapshot),
    };
    const coordinator = new TaskCoordinator({ executor: { run }, commands });
    const running = coordinator.start('task_1');

    const cancellation = coordinator.cancel('task_1');
    await Promise.resolve();
    expect(run.mock.calls[0]?.[1].aborted).toBe(true);
    expect(commands.cancel).not.toHaveBeenCalled();

    finish?.();
    await running;
    await expect(cancellation).resolves.toBe(snapshot);
    expect(commands.cancel).toHaveBeenCalledWith('task_1');
  });
});
