import { observeDocument } from '../browser/observe/dom-observer';
import { ActionExecutionError } from '../browser/act/action-errors';
import { parsePageActionCommand, type PageActionCommand } from '../browser/act/page-action-message';
import {
  PROTOCOL_VERSION,
  type ExtensionResponse,
  type PageActionFeedback,
  type PageCommand,
} from '../shared/protocol/message-types';
import { parsePageCommand } from '../shared/protocol/parse-message';
import { getActionFeedbackOverlay } from './action-feedback/action-feedback-overlay';
import { executeDomAction } from './dom-action-handler';
import { setPageOverlaysHidden } from './page-overlay-registry';
import { selectScreenshotRegion } from './screenshot/mount-screenshot-overlay';

export interface PageCommandEnvironment {
  readonly document: Document;
  readonly window: Window;
  readonly feedback?: { show(feedback: PageActionFeedback): void };
}

/**
 * Returns a sanitized page-boundary error without echoing untrusted command payload values.
 */
function invalidPageCommandResponse(requestId = 'invalid'): ExtensionResponse {
  return {
    version: PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code: 'INVALID_PAGE_COMMAND', message: 'Page command format is invalid.' },
  };
}

/**
 * Validates and handles the credential-free commands available inside an isolated page world.
 */
export async function handlePageCommand(
  value: unknown,
  environment: PageCommandEnvironment = { document, window },
): Promise<ExtensionResponse> {
  let command: PageCommand | null;
  try {
    command = parsePageCommand(value);
  } catch {
    command = null;
  }

  if (command?.type === 'page.ping') {
    return {
      version: PROTOCOL_VERSION,
      requestId: command.requestId,
      ok: true,
      data: { installed: true },
    };
  }

  if (command?.type === 'page.observe') {
    const view = environment.window;
    return {
      version: PROTOCOL_VERSION,
      requestId: command.requestId,
      ok: true,
      data: observeDocument(environment.document, {
        id: command.payload.observationId,
        tabId: command.payload.tabId,
        capturedAt: command.payload.capturedAt,
        url: view.location.href,
        viewport: {
          width: view.innerWidth,
          height: view.innerHeight,
          scrollX: view.scrollX,
          scrollY: view.scrollY,
        },
      }),
    };
  }

  if (command?.type === 'page.screenshot.select') {
    return {
      version: PROTOCOL_VERSION,
      requestId: command.requestId,
      ok: true,
      data: await selectScreenshotRegion(environment.document, environment.window),
    };
  }

  if (command?.type === 'page.overlays.setHidden') {
    setPageOverlaysHidden(command.payload.hidden);
    return {
      version: PROTOCOL_VERSION,
      requestId: command.requestId,
      ok: true,
      data: { hidden: command.payload.hidden },
    };
  }

  if (command?.type === 'page.actionFeedback') {
    const feedback = environment.feedback ?? getActionFeedbackOverlay(environment.document);
    let displayed = false;
    try {
      feedback?.show(command.payload);
      displayed = feedback !== undefined;
    } catch {
      // Visual feedback is best-effort and must not affect browser execution.
    }
    return {
      version: PROTOCOL_VERSION,
      requestId: command.requestId,
      ok: true,
      data: { displayed },
    };
  }

  let actionCommand: PageActionCommand;
  try {
    actionCommand = parsePageActionCommand(value);
  } catch {
    return invalidPageCommandResponse();
  }
  try {
    const feedback = environment.feedback ?? getActionFeedbackOverlay(environment.document);
    return {
      version: PROTOCOL_VERSION,
      requestId: actionCommand.requestId,
      ok: true,
      data: await executeDomAction(environment.document, actionCommand.payload.action, {
        clock: { now: () => Date.now() },
        window: environment.window,
        ...(feedback === undefined ? {} : { feedback }),
      }),
    };
  } catch (error) {
    if (error instanceof ActionExecutionError) {
      return {
        version: PROTOCOL_VERSION,
        requestId: actionCommand.requestId,
        ok: false,
        error: { code: error.code, message: error.message },
      };
    }
    return invalidPageCommandResponse(actionCommand.requestId);
  }
}
