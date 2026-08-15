import { providerErrorFromCode } from '../providers/provider-errors';
import {
  retryProviderOperation,
  type ProviderRetryDependencies,
} from '../providers/provider-retry';
import type { AgentEvent, AgentPlanInput, AgentPlanner } from './execution-types';

export class AgentRunLoop implements AgentPlanner {
  readonly #delegate: AgentPlanner;
  readonly #retry: ProviderRetryDependencies;

  /** Creates a resilient one-turn wrapper without owning the durable browser task state machine. */
  constructor(delegate: AgentPlanner, retry: ProviderRetryDependencies = {}) {
    this.#delegate = delegate;
    this.#retry = retry;
  }

  /** Restarts only an incomplete model turn and yields exactly one validated decision. */
  async *plan(input: AgentPlanInput, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const event = await retryProviderOperation(
      () => this.#runOnce(input, signal),
      signal,
      this.#retry,
    );
    yield event;
  }

  /** Collects one delegate turn so no partial decision escapes before retry eligibility is known. */
  async #runOnce(input: AgentPlanInput, signal: AbortSignal): Promise<AgentEvent> {
    let result: AgentEvent | null = null;
    for await (const event of this.#delegate.plan(input, signal)) {
      if (result !== null) throw providerErrorFromCode('INVALID_RESPONSE');
      result = event;
    }
    if (result === null) throw providerErrorFromCode('INVALID_RESPONSE');
    return result;
  }
}
