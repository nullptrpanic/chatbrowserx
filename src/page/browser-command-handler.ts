import {
  PROTOCOL_VERSION,
  type ExtensionResponse,
  type PageCommand,
} from '../shared/protocol/message-types';
import { parsePageCommand } from '../shared/protocol/parse-message';
import { extractReadableContent } from '../browser/observation/content-extractor';
import { setPageOverlaysHidden } from './page-overlay-registry';
import { openPageImagePreview } from './image-preview/mount-image-preview';
import { selectScreenshotRegion } from './screenshot/mount-screenshot-overlay';
import { showVirtualPointer } from './browser/mount-virtual-pointer';
import { performPageAction } from './browser/page-action-performer';
import { toggleTranslationLens, getTranslationSession } from './translation/mount-translation-lens';

export interface PageCommandEnvironment {
  readonly document: Document;
  readonly window: Window;
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

  if (command?.type === 'page.translation.toggle') {
    return {
      version: PROTOCOL_VERSION,
      requestId: command.requestId,
      ok: true,
      data: {
        active: toggleTranslationLens(command.payload, environment.document, environment.window),
      },
    };
  }

  if (command?.type === 'page.translation.getState') {
    return {
      version: PROTOCOL_VERSION,
      requestId: command.requestId,
      ok: true,
      data: { sessionId: getTranslationSession(environment.document) },
    };
  }

  if (command?.type === 'page.content.read') {
    return {
      version: PROTOCOL_VERSION,
      requestId: command.requestId,
      ok: true,
      data: extractReadableContent(environment.document, environment.window),
    };
  }

  if (command?.type === 'page.action.perform') {
    return {
      version: PROTOCOL_VERSION,
      requestId: command.requestId,
      ok: true,
      data: await performPageAction(command.payload, environment.document, environment.window),
    };
  }

  if (command?.type === 'page.pointer.show') {
    await showVirtualPointer(command.payload, environment.document, environment.window);
    return {
      version: PROTOCOL_VERSION,
      requestId: command.requestId,
      ok: true,
      data: { shown: true },
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

  if (command?.type === 'page.imagePreview.open') {
    openPageImagePreview(command.payload, environment.document, environment.window);
    return {
      version: PROTOCOL_VERSION,
      requestId: command.requestId,
      ok: true,
      data: { opened: true },
    };
  }

  if (command?.type === 'page.overlays.setHidden') {
    try {
      await setPageOverlaysHidden(command.payload.hidden, environment.window);
    } catch {
      return {
        version: PROTOCOL_VERSION,
        requestId: command.requestId,
        ok: false,
        error: { code: 'PAGE_RENDER_UNAVAILABLE', message: 'Page rendering is unavailable.' },
      };
    }
    return {
      version: PROTOCOL_VERSION,
      requestId: command.requestId,
      ok: true,
      data: {
        hidden: command.payload.hidden,
        viewportWidth: environment.window.innerWidth,
        viewportHeight: environment.window.innerHeight,
      },
    };
  }

  return invalidPageCommandResponse();
}
