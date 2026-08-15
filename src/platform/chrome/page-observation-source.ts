import type { PageObservation } from '../../browser/contracts/observation';
import type { ContentScriptInstallation } from './content-script-installer';
import type { IdGenerator } from '../../shared/ids';
import type { Clock } from '../../shared/time';
import { PROTOCOL_VERSION, type PageCommand } from '../../shared/protocol/message-types';

export interface PageObservationInput {
  readonly tabId: number;
  readonly url: string;
}

export interface PageObservationSource {
  observe(input: PageObservationInput): Promise<PageObservation | null>;
  release(tabId: number): Promise<void>;
}

export interface PageObservationSourceDependencies {
  readonly installer: {
    ensureInstalled(tabId: number, origin: string): Promise<ContentScriptInstallation>;
  };
  readonly messages: {
    sendMessage(tabId: number, message: PageCommand): Promise<unknown>;
  };
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** Checks the minimum immutable shape required before trusting a page observation response. */
function isPageObservation(
  value: unknown,
  tabId: number,
  observationId: string,
): value is PageObservation {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    value.id === observationId &&
    'tabId' in value &&
    value.tabId === tabId &&
    'elements' in value &&
    Array.isArray(value.elements) &&
    'textRegions' in value &&
    Array.isArray(value.textRegions) &&
    'frames' in value &&
    Array.isArray(value.frames)
  );
}

export class ChromePageObservationSource implements PageObservationSource {
  readonly #dependencies: PageObservationSourceDependencies;

  /** Creates an on-demand page observer from explicitly composed Chrome boundary ports. */
  constructor(dependencies: PageObservationSourceDependencies) {
    this.#dependencies = dependencies;
  }

  /** Installs the isolated listener when permitted and returns a correlated semantic snapshot. */
  async observe(input: PageObservationInput): Promise<PageObservation | null> {
    const installation = await this.#dependencies.installer.ensureInstalled(input.tabId, input.url);
    if (
      installation.status === 'permission_required' ||
      installation.status === 'unsupported_origin'
    ) {
      return null;
    }
    const observationId = this.#dependencies.ids.create('observation');
    const requestId = this.#dependencies.ids.create('page_request');
    const command: PageCommand = {
      version: PROTOCOL_VERSION,
      requestId,
      type: 'page.observe',
      payload: {
        observationId,
        tabId: input.tabId,
        capturedAt: this.#dependencies.clock.now(),
      },
    };
    const response = await this.#dependencies.messages.sendMessage(input.tabId, command);
    if (
      typeof response !== 'object' ||
      response === null ||
      !('requestId' in response) ||
      response.requestId !== requestId ||
      !('ok' in response) ||
      response.ok !== true ||
      !('data' in response) ||
      !isPageObservation(response.data, input.tabId, observationId)
    ) {
      throw new Error('Page observation channel returned an invalid response.');
    }
    return response.data;
  }

  /** Releases no persistent page state because content scripts hold only transient listeners. */
  async release(tabId: number): Promise<void> {
    void tabId;
  }
}
