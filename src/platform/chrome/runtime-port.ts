import {
  PROTOCOL_VERSION,
  type ExtensionMessage,
  type ExtensionResponse,
} from '../../shared/protocol/message-types';

export interface RuntimePort {
  send(message: ExtensionMessage): Promise<ExtensionResponse>;
}

export interface RuntimeMessenger {
  sendMessage(message: ExtensionMessage): Promise<unknown>;
}

/**
 * Checks the minimal trusted response envelope and rejects mismatched or malformed replies.
 */
function isMatchingResponse(value: unknown, requestId: string): value is ExtensionResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return (
    'version' in value &&
    value.version === PROTOCOL_VERSION &&
    'requestId' in value &&
    value.requestId === requestId &&
    'ok' in value &&
    typeof value.ok === 'boolean' &&
    (value.ok ? 'data' in value : 'error' in value)
  );
}

export class ChromeRuntimePort implements RuntimePort {
  readonly #messenger: RuntimeMessenger;

  /**
   * Creates a protocol port over the real or injected Chrome runtime messenger.
   */
  constructor(messenger: RuntimeMessenger = chrome.runtime) {
    this.#messenger = messenger;
  }

  /**
   * Sends one typed request and rejects replies that cannot be correlated safely.
   */
  async send(message: ExtensionMessage): Promise<ExtensionResponse> {
    const response = await this.#messenger.sendMessage(message);
    if (!isMatchingResponse(response, message.requestId)) {
      throw new Error('Background returned an invalid protocol response.');
    }
    return response;
  }
}

/**
 * Creates the lightweight health request used when the Side Panel mounts.
 */
export function createSystemPingMessage(): Extract<ExtensionMessage, { type: 'system.ping' }> {
  return {
    version: PROTOCOL_VERSION,
    requestId: `ping_${crypto.randomUUID()}`,
    type: 'system.ping',
    payload: {},
  };
}
