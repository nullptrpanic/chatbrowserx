import { describe, expect, it } from 'vitest';
import type { BrowserActionKind } from '../../../src/tasks/task-types';
import {
  ChromeDriverOutcomeRepository,
  InMemoryDriverOutcomeRepository,
  type DriverOutcomeKind,
} from '../../../src/browser/route/driver-outcomes';
import { DriverRouter } from '../../../src/browser/route/driver-router';

/** Records a deterministic sample set for one driver and scenario key. */
async function recordSamples(
  repository: InMemoryDriverOutcomeRepository,
  driver: 'dom' | 'cdp',
  outcomes: readonly DriverOutcomeKind[],
  actionKind: BrowserActionKind = 'click',
): Promise<void> {
  for (const [index, outcome] of outcomes.entries()) {
    await repository.record({
      id: `${driver}_${String(index)}`,
      origin: 'https://example.test',
      actionKind,
      driver,
      outcome,
      durationMs: 100 + index,
      recordedAt: 1_000 + index,
    });
  }
}

describe('DriverRouter', () => {
  it('eliminates DOM when a cross-origin frame requires CDP capability', async () => {
    const router = new DriverRouter(new InMemoryDriverOutcomeRepository());

    await expect(
      router.select({
        origin: 'https://example.test',
        actionKind: 'click',
        requiredCapabilities: ['cross_origin_frame', 'real_pointer'],
      }),
    ).resolves.toMatchObject({ driver: 'cdp', reason: 'capability_required' });
  });

  it('lowers DOM confidence after enough no-effect outcomes', async () => {
    const repository = new InMemoryDriverOutcomeRepository();
    await recordSamples(repository, 'dom', [
      'success',
      'no_effect',
      'no_effect',
      'no_effect',
      'no_effect',
    ]);
    const router = new DriverRouter(repository);

    await expect(
      router.select({
        origin: 'https://example.test',
        actionKind: 'click',
        requiredCapabilities: [],
      }),
    ).resolves.toMatchObject({ driver: 'cdp', reason: 'higher_expected_success' });
  });

  it('switches drivers after one explicit failure so bounded retries explore another route', async () => {
    const repository = new InMemoryDriverOutcomeRepository();
    await recordSamples(repository, 'dom', ['transport_failure']);
    const router = new DriverRouter(repository);

    await expect(
      router.select({
        origin: 'https://example.test',
        actionKind: 'click',
        requiredCapabilities: [],
      }),
    ).resolves.toMatchObject({ driver: 'cdp', reason: 'higher_expected_success' });
  });

  it('lowers CDP confidence after repeated transport detach failures', async () => {
    const repository = new InMemoryDriverOutcomeRepository();
    await recordSamples(repository, 'cdp', [
      'transport_failure',
      'transport_failure',
      'transport_failure',
      'transport_failure',
      'transport_failure',
    ]);
    const router = new DriverRouter(repository);

    await expect(
      router.select({
        origin: 'https://example.test',
        actionKind: 'click',
        requiredCapabilities: [],
      }),
    ).resolves.toMatchObject({ driver: 'dom' });
  });

  it('chooses DOM when both drivers have equal proven success', async () => {
    const repository = new InMemoryDriverOutcomeRepository();
    const equal = ['success', 'success', 'success', 'success', 'no_effect'] as const;
    await recordSamples(repository, 'dom', equal);
    await recordSamples(repository, 'cdp', equal);
    const router = new DriverRouter(repository);

    await expect(
      router.select({
        origin: 'https://example.test',
        actionKind: 'click',
        requiredCapabilities: [],
      }),
    ).resolves.toMatchObject({ driver: 'dom', reason: 'near_equal_prefer_dom' });
  });

  it('retains only the latest 100 outcomes per origin and action', async () => {
    const repository = new InMemoryDriverOutcomeRepository();
    await recordSamples(
      repository,
      'dom',
      Array.from({ length: 105 }, () => 'success'),
    );

    const outcomes = await repository.list('https://example.test', 'click');

    expect(outcomes).toHaveLength(100);
    expect(outcomes[0]?.recordedAt).toBe(1_005);
  });

  it('replaces a repeated effect-boundary outcome instead of biasing learned rates', async () => {
    const repository = new InMemoryDriverOutcomeRepository();
    const base = {
      id: 'task_1:action_1:1',
      origin: 'https://example.test',
      actionKind: 'click' as const,
      driver: 'dom' as const,
      durationMs: 100,
      recordedAt: 1_000,
    };

    await repository.record({ ...base, outcome: 'success' });
    await repository.record({ ...base, outcome: 'no_effect', recordedAt: 1_100 });

    await expect(repository.list(base.origin, base.actionKind)).resolves.toEqual([
      expect.objectContaining({ id: base.id, outcome: 'no_effect', recordedAt: 1_100 }),
    ]);
  });

  it('falls back to scenario priors when adaptive history is temporarily unavailable', async () => {
    const router = new DriverRouter({
      list: async () => {
        throw new Error('storage unavailable');
      },
      record: async () => undefined,
    });

    await expect(
      router.select({
        origin: 'https://example.test',
        actionKind: 'click',
        requiredCapabilities: [],
      }),
    ).resolves.toMatchObject({ driver: 'dom', reason: 'near_equal_prefer_dom' });
  });

  it('recovers the durable write queue after one transient storage failure', async () => {
    const values: Record<string, unknown> = {};
    let writes = 0;
    const repository = new ChromeDriverOutcomeRepository({
      get: async (key) => ({ [key]: values[key] }),
      set: async (items) => {
        writes += 1;
        if (writes === 1) throw new Error('storage unavailable');
        Object.assign(values, items);
      },
    });
    const base = {
      origin: 'https://example.test',
      actionKind: 'click' as const,
      driver: 'dom' as const,
      outcome: 'success' as const,
      durationMs: 100,
      recordedAt: 1_000,
    };

    await expect(repository.record({ ...base, id: 'attempt_1' })).rejects.toThrow(
      /storage unavailable/,
    );
    await expect(
      repository.record({ ...base, id: 'attempt_2', recordedAt: 1_100 }),
    ).resolves.toBeUndefined();
    await expect(repository.list(base.origin, base.actionKind)).resolves.toEqual([
      expect.objectContaining({ id: 'attempt_2' }),
    ]);
  });
});
