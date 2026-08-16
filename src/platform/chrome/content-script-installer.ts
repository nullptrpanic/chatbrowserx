import pageContentScript from '../../entries/page-content.iife.ts?script';
import {
  PROTOCOL_VERSION,
  type ExtensionResponse,
  type PageCommand,
} from '../../shared/protocol/message-types';

export interface ContentScriptInstallerDependencies {
  readonly permissions: {
    contains(permissions: { readonly origins: readonly string[] }): Promise<boolean>;
  };
  readonly tabs: {
    sendMessage(tabId: number, message: PageCommand): Promise<unknown>;
  };
  readonly scripting: {
    executeScript(options: {
      readonly target: { readonly tabId: number; readonly allFrames: boolean };
      readonly files: readonly string[];
    }): Promise<unknown>;
  };
  readonly scriptFile: string;
}

export type ContentScriptInstallation =
  | {
      readonly status: 'installed' | 'already_installed' | 'permission_required';
      readonly originPattern: string;
    }
  | { readonly status: 'unsupported_origin'; readonly originPattern: null };

/**
 * Normalizes a web URL to the host-permission pattern accepted by Chrome.
 */
function toOriginPattern(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.origin}/*`;
  } catch {
    return null;
  }
}

/**
 * Checks whether a tab response proves the page command listener is already active.
 */
function isInstalledResponse(value: unknown, requestId: string): value is ExtensionResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version === PROTOCOL_VERSION &&
    'requestId' in value &&
    value.requestId === requestId &&
    'ok' in value &&
    value.ok === true &&
    'data' in value &&
    typeof value.data === 'object' &&
    value.data !== null &&
    'installed' in value.data &&
    value.data.installed === true
  );
}

export class ContentScriptInstaller {
  readonly #dependencies: ContentScriptInstallerDependencies;

  /**
   * Creates an on-demand installer over injected ports or the real Chrome extension APIs.
   */
  constructor(dependencies?: ContentScriptInstallerDependencies) {
    this.#dependencies =
      dependencies ??
      ({
        permissions: chrome.permissions,
        tabs: chrome.tabs,
        scripting: chrome.scripting,
        scriptFile: pageContentScript,
      } as ContentScriptInstallerDependencies);
  }

  /**
   * Reuses or injects the isolated page bundle only after required host access is available.
   */
  async ensureInstalled(tabId: number, origin: string): Promise<ContentScriptInstallation> {
    const originPattern = toOriginPattern(origin);
    if (originPattern === null) {
      return { status: 'unsupported_origin', originPattern: null };
    }
    const hasPermission = await this.#dependencies.permissions.contains({
      origins: [originPattern],
    });
    if (!hasPermission) {
      return { status: 'permission_required', originPattern };
    }

    const requestId = `page_ping_${crypto.randomUUID()}`;
    const ping: PageCommand = {
      version: PROTOCOL_VERSION,
      requestId,
      type: 'page.ping',
      payload: {},
    };
    try {
      const response = await this.#dependencies.tabs.sendMessage(tabId, ping);
      if (isInstalledResponse(response, requestId)) {
        return { status: 'already_installed', originPattern };
      }
    } catch {
      // An absent receiver is the expected signal to install the bundle.
    }

    await this.#dependencies.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: [this.#dependencies.scriptFile],
    });
    return { status: 'installed', originPattern };
  }
}
