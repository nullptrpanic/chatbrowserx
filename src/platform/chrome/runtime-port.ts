import {
  PROTOCOL_VERSION,
  type ExtensionMessage,
  type ExtensionResponse,
} from '../../shared/protocol/message-types';

export type RuntimeNotificationListener = (value: unknown) => void;

export interface RuntimePort {
  send(message: ExtensionMessage): Promise<ExtensionResponse>;
  subscribe?(listener: RuntimeNotificationListener): () => void;
}

export interface RuntimeMessenger {
  sendMessage(message: ExtensionMessage): Promise<unknown>;
}

export interface RuntimeNotificationSource {
  readonly onMessage: {
    addListener(listener: (message: unknown) => void): void;
    removeListener(listener: (message: unknown) => void): void;
  };
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
  readonly #notifications: RuntimeNotificationSource;

  /**
   * Creates a protocol port over the real or injected Chrome runtime messenger.
   */
  constructor(
    messenger: RuntimeMessenger = chrome.runtime,
    notifications: RuntimeNotificationSource = chrome.runtime,
  ) {
    this.#messenger = messenger;
    this.#notifications = notifications;
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

  /** Subscribes to validated-by-consumer one-way background notifications. */
  subscribe(listener: RuntimeNotificationListener): () => void {
    const runtimeListener = (message: unknown): void => listener(message);
    this.#notifications.onMessage.addListener(runtimeListener);
    return () => this.#notifications.onMessage.removeListener(runtimeListener);
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
