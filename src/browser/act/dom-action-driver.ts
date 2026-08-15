import { PROTOCOL_VERSION, type ExtensionResponse } from '../../shared/protocol/message-types';
import type { BrowserActionRequest } from '../contracts/action';
import type { BrowserActionEvidence } from '../contracts/evidence';
import type { ActionDriver, ActionDriverContext } from './action-driver';
import { ActionExecutionError, type ActionExecutionErrorCode } from './action-errors';
import type { PageActionCommand } from './page-action-message';

export interface DomActionPort {
  execute(request: BrowserActionRequest): Promise<BrowserActionEvidence>;
}

export interface PageActionMessagePort {
  sendMessage(tabId: number, message: PageActionCommand): Promise<unknown>;
}

/** Checks the trusted minimum evidence envelope returned by an isolated content script. */
function isActionEvidence(value: unknown, actionId: string): value is BrowserActionEvidence {
  return (
    typeof value === 'object' &&
    value !== null &&
    'actionId' in value &&
    value.actionId === actionId &&
    'driver' in value &&
    value.driver === 'dom' &&
    'status' in value &&
    typeof value.status === 'string'
  );
}

const actionErrorCodes = new Set<ActionExecutionErrorCode>([
  'TARGET_NOT_FOUND',
  'TARGET_AMBIGUOUS',
  'ACTION_BLOCKED',
  'ACTION_UNSUPPORTED',
  'ACTION_FAILED',
]);

/** Narrows one page response code to the stable browser action error vocabulary. */
function isActionErrorCode(value: string): value is ActionExecutionErrorCode {
  return actionErrorCodes.has(value as ActionExecutionErrorCode);
}

export class ChromeDomActionPort implements DomActionPort {
  readonly #messages: PageActionMessagePort;

  /** Creates a DOM action port over tab-scoped Chrome runtime messaging. */
  constructor(messages: PageActionMessagePort = chrome.tabs) {
    this.#messages = messages;
  }

  /** Sends one validated action command and extracts only matching DOM evidence. */
  async execute(request: BrowserActionRequest): Promise<BrowserActionEvidence> {
    const requestId = `dom_action_${crypto.randomUUID()}`;
    const command: PageActionCommand = {
      version: PROTOCOL_VERSION,
      requestId,
      type: 'page.domAction',
      payload: { action: request },
    };
    const response = (await this.#messages.sendMessage(
      request.tabId,
      command,
    )) as ExtensionResponse;
    if (typeof response !== 'object' || response === null || response.requestId !== requestId) {
      throw new ActionExecutionError('ACTION_FAILED', 'DOM action channel returned no evidence.');
    }
    if (!response.ok) {
      throw new ActionExecutionError(
        isActionErrorCode(response.error.code) ? response.error.code : 'ACTION_FAILED',
        response.error.message,
      );
    }
    if (
      typeof response !== 'object' ||
      response === null ||
      !isActionEvidence(response.data, request.actionId)
    ) {
      throw new ActionExecutionError('ACTION_FAILED', 'DOM action channel returned no evidence.');
    }
    return response.data;
  }
}

export class DomActionDriver implements ActionDriver {
  readonly kind = 'dom' as const;
  readonly #port: DomActionPort;

  /** Creates a DOM driver that delegates effects to the isolated page action boundary. */
  constructor(port: DomActionPort = new ChromeDomActionPort()) {
    this.#port = port;
  }

  /** Executes a structured DOM action; live resolution remains inside the page handler. */
  execute(
    request: BrowserActionRequest,
    context?: ActionDriverContext,
  ): Promise<BrowserActionEvidence> {
    void context;
    return this.#port.execute(request);
  }
}
