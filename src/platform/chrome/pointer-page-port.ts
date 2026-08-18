import type { PointerPagePort } from '../../browser/actions/browser-action-executor';
import type { IdGenerator } from '../../shared/ids';
import { PROTOCOL_VERSION, type PageCommand } from '../../shared/protocol/message-types';
import type { ContentScriptInstaller } from './content-script-installer';

export class PointerPagePortError extends Error {
  readonly code = 'POINTER_UNAVAILABLE' as const;

  constructor() {
    super('Virtual pointer feedback is unavailable.');
    this.name = 'PointerPagePortError';
  }
}

export interface ChromePointerPageDependencies {
  readonly installer: Pick<ContentScriptInstaller, 'ensureInstalled'>;
  readonly tabs: {
    get(tabId: number): Promise<{ readonly url?: string | undefined }>;
    sendMessage(
      tabId: number,
      message: PageCommand,
      options: { readonly frameId: number },
    ): Promise<unknown>;
  };
  readonly ids: Pick<IdGenerator, 'create'>;
}

/** Sends best-effort virtual pointer feedback to the guarded top-frame page bundle. */
export class ChromePointerPagePort implements PointerPagePort {
  readonly #dependencies: ChromePointerPageDependencies;

  constructor(dependencies: ChromePointerPageDependencies) {
    this.#dependencies = dependencies;
  }

  async show(tabId: number, effect: Parameters<PointerPagePort['show']>[1]): Promise<void> {
    const requestId = this.#dependencies.ids.create('pointer').trim();
    if (requestId.length === 0 || requestId.length > 128) throw new PointerPagePortError();
    try {
      const tab = await this.#dependencies.tabs.get(tabId);
      const installation = await this.#dependencies.installer.ensureInstalled(tabId, tab.url ?? '');
      if (
        installation.status === 'permission_required' ||
        installation.status === 'unsupported_origin'
      ) {
        throw new PointerPagePortError();
      }
      const command: PageCommand = {
        version: PROTOCOL_VERSION,
        requestId,
        type: 'page.pointer.show',
        payload: effect,
      };
      const response = await this.#dependencies.tabs.sendMessage(tabId, command, { frameId: 0 });
      if (
        typeof response !== 'object' ||
        response === null ||
        !('version' in response) ||
        response.version !== PROTOCOL_VERSION ||
        !('requestId' in response) ||
        response.requestId !== requestId ||
        !('ok' in response) ||
        response.ok !== true ||
        !('data' in response) ||
        typeof response.data !== 'object' ||
        response.data === null ||
        !('shown' in response.data) ||
        response.data.shown !== true
      ) {
        throw new PointerPagePortError();
      }
    } catch (error) {
      if (error instanceof PointerPagePortError) throw error;
      throw new PointerPagePortError();
    }
  }
}
