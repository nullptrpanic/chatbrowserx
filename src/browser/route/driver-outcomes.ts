import type { BrowserActionKind } from '../../tasks/task-types';
import type { DriverKind } from './driver-capabilities';

export type DriverOutcomeKind = 'success' | 'no_effect' | 'target_failure' | 'transport_failure';

export interface DriverOutcome {
  readonly id: string;
  readonly origin: string;
  readonly actionKind: BrowserActionKind;
  readonly driver: DriverKind;
  readonly outcome: DriverOutcomeKind;
  readonly durationMs: number;
  readonly recordedAt: number;
}

export interface DriverOutcomeRepository {
  list(origin: string, actionKind: BrowserActionKind): Promise<readonly DriverOutcome[]>;
  record(outcome: DriverOutcome): Promise<void>;
}

export const DRIVER_OUTCOME_LIMIT = 100;

/** Creates an unambiguous in-memory bucket key for one origin and action kind. */
function outcomeKey(origin: string, actionKind: BrowserActionKind): string {
  return `${origin.length}:${origin}${actionKind}`;
}

/** Replaces one repeated effect-boundary result and retains newest samples in stable order. */
function upsertOutcome(
  current: readonly DriverOutcome[],
  outcome: DriverOutcome,
): readonly DriverOutcome[] {
  return [...current.filter((item) => item.id !== outcome.id), outcome].slice(
    -DRIVER_OUTCOME_LIMIT,
  );
}

export class InMemoryDriverOutcomeRepository implements DriverOutcomeRepository {
  readonly #outcomes = new Map<string, readonly DriverOutcome[]>();

  /** Lists a snapshot of recent outcomes in oldest-to-newest order. */
  async list(origin: string, actionKind: BrowserActionKind): Promise<readonly DriverOutcome[]> {
    return [...(this.#outcomes.get(outcomeKey(origin, actionKind)) ?? [])];
  }

  /** Upserts one effect-boundary outcome and retains the latest 100 scenario records. */
  async record(outcome: DriverOutcome): Promise<void> {
    const key = outcomeKey(outcome.origin, outcome.actionKind);
    const current = this.#outcomes.get(key) ?? [];
    this.#outcomes.set(key, upsertOutcome(current, outcome));
  }
}

export interface DriverOutcomeStoragePort {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** Checks one persisted outcome record before it influences routing decisions. */
function isDriverOutcome(value: unknown): value is DriverOutcome {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    'origin' in value &&
    typeof value.origin === 'string' &&
    'actionKind' in value &&
    typeof value.actionKind === 'string' &&
    'driver' in value &&
    (value.driver === 'dom' || value.driver === 'cdp') &&
    'outcome' in value &&
    ['success', 'no_effect', 'target_failure', 'transport_failure'].includes(
      String(value.outcome),
    ) &&
    'durationMs' in value &&
    typeof value.durationMs === 'number' &&
    'recordedAt' in value &&
    typeof value.recordedAt === 'number'
  );
}

export class ChromeDriverOutcomeRepository implements DriverOutcomeRepository {
  readonly #storage: DriverOutcomeStoragePort;
  #writeQueue: Promise<void> = Promise.resolve();

  /** Creates a durable rolling outcome repository in trusted Chrome local storage. */
  constructor(storage: DriverOutcomeStoragePort = chrome.storage.local) {
    this.#storage = storage;
  }

  /** Reads and validates the bounded persisted samples for one origin and action. */
  async list(origin: string, actionKind: BrowserActionKind): Promise<readonly DriverOutcome[]> {
    const key = this.#storageKey(origin, actionKind);
    const value = (await this.#storage.get(key))[key];
    return Array.isArray(value) ? value.filter(isDriverOutcome).slice(-DRIVER_OUTCOME_LIMIT) : [];
  }

  /** Serializes idempotent updates so concurrent effect results cannot overwrite each other. */
  async record(outcome: DriverOutcome): Promise<void> {
    const write = this.#writeQueue
      .catch(() => undefined)
      .then(async () => {
        const key = this.#storageKey(outcome.origin, outcome.actionKind);
        const current = await this.list(outcome.origin, outcome.actionKind);
        await this.#storage.set({ [key]: upsertOutcome(current, outcome) });
      });
    this.#writeQueue = write.catch(() => undefined);
    await write;
  }

  /** Produces a scoped storage key without exposing origin values in diagnostics. */
  #storageKey(origin: string, actionKind: BrowserActionKind): string {
    return `browser.driverOutcomes.${encodeURIComponent(origin)}.${actionKind}`;
  }
}
