import {
  PROTOCOL_VERSION,
  type ExtensionMessage,
  type ExtensionResponse,
} from '../../shared/protocol/message-types';
import { parseExtensionMessage } from '../../shared/protocol/parse-message';
import type { SandboxConsoleClientPort } from '../../sandbox/sandbox-client';
import type { Agent } from '../../agent/agent';
import { TaskCommandError } from '../../tasks/task-command-service';
import { ScreenshotError } from '../../attachments/screenshot-error';
import type { PanelService } from '../../tasks/panel-service';
import type { TranslationController } from '../../translation/translation-controller';
import { TranslationResponseError } from '../../translation/region-translation';
import { isProviderError } from '../../agent/model/model-provider-error';
import { TranslationStateError } from '../../translation/translation-state-error';

export interface RuntimeMessageContext {
  readonly senderTabId: number | null;
  readonly senderFrameId?: number | null;
}

export type MessageRouter = (
  value: unknown,
  context?: RuntimeMessageContext,
) => Promise<ExtensionResponse>;

export interface MessageRouterDependencies {
  readonly agent: Pick<
    Agent,
    'getSnapshot' | 'pause' | 'resume' | 'retry' | 'cancel' | 'clearContext' | 'recover'
  >;
  readonly panel: Pick<
    PanelService,
    | 'getSnapshot'
    | 'getStateVersion'
    | 'getTaskDetails'
    | 'submit'
    | 'supplement'
    | 'openImagePreview'
    | 'clearConversation'
    | 'getSettings'
    | 'saveSettings'
  >;
  readonly screenshots: {
    captureViewport(tabId: number): Promise<{ readonly id: string }>;
    captureRegion(tabId: number): Promise<{ readonly id: string } | null>;
  };
  readonly sandboxConsole?: SandboxConsoleClientPort;
  readonly translation?: Pick<
    TranslationController,
    'toggle' | 'getState' | 'read' | 'image' | 'cancel'
  >;
  readonly pageFeatures?: {
    ensure(tabId: number): Promise<unknown>;
  };
}

/**
 * Extracts only a bounded safe request identifier from malformed input for response correlation.
 */
function readSafeRequestId(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('requestId' in value)) {
    return 'invalid';
  }

  const requestId = value.requestId;
  if (
    typeof requestId !== 'string' ||
    requestId.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(requestId)
  ) {
    return 'invalid';
  }
  return requestId;
}

/**
 * Wraps successful command data in the versioned runtime response envelope.
 */
function successResponse(
  requestId: string,
  data: unknown,
): Extract<ExtensionResponse, { ok: true }> {
  return { version: PROTOCOL_VERSION, requestId, ok: true, data };
}

/**
 * Wraps a stable public failure without exposing the original exception or message payload.
 */
function errorResponse(
  requestId: string,
  code: string,
  message: string,
): Extract<ExtensionResponse, { ok: false }> {
  return { version: PROTOCOL_VERSION, requestId, ok: false, error: { code, message } };
}

/**
 * Delegates one validated task message while keeping state transitions outside the Chrome layer.
 */
async function routeMessage(
  message: ExtensionMessage,
  dependencies: MessageRouterDependencies,
  context: RuntimeMessageContext,
): Promise<ExtensionResponse> {
  switch (message.type) {
    case 'translation.getState': {
      const tabId =
        'tabId' in message.payload
          ? context.senderTabId === null
            ? message.payload.tabId
            : null
          : context.senderFrameId === 0
            ? context.senderTabId
            : null;
      if (tabId === null)
        return errorResponse(
          message.requestId,
          'INVALID_CONTEXT',
          'Translation requires its owning page or extension UI.',
        );
      if (!dependencies.translation) throw new Error('Translation unavailable.');
      return successResponse(
        message.requestId,
        await dependencies.translation.getState(
          tabId,
          'sessionId' in message.payload ? message.payload.sessionId : undefined,
        ),
      );
    }
    case 'translation.toggle':
      if (context.senderTabId !== null)
        return errorResponse(
          message.requestId,
          'INVALID_CONTEXT',
          'Translation requires the extension UI.',
        );
      if (!dependencies.translation) throw new Error('Translation unavailable.');
      return successResponse(
        message.requestId,
        await dependencies.translation.toggle(message.payload.tabId),
      );
    case 'translation.read':
    case 'translation.image':
    case 'translation.cancel':
      if (context.senderTabId === null || context.senderFrameId !== 0)
        return errorResponse(
          message.requestId,
          'INVALID_CONTEXT',
          'Translation requires the enabled page.',
        );
      if (!dependencies.translation) throw new Error('Translation unavailable.');
      if (message.type === 'translation.image')
        return successResponse(
          message.requestId,
          await dependencies.translation.image(context.senderTabId, message.payload),
        );
      if (message.type === 'translation.read')
        return successResponse(
          message.requestId,
          await dependencies.translation.read(
            context.senderTabId,
            message.payload,
            message.requestId,
          ),
        );
      dependencies.translation.cancel(
        context.senderTabId,
        message.payload.sessionId,
        message.payload.close,
        message.payload.kind,
      );
      return successResponse(message.requestId, {});
    case 'system.ping':
      await dependencies.agent.recover();
      return successResponse(message.requestId, { connected: true });
    case 'panel.getSnapshot':
      return successResponse(
        message.requestId,
        await dependencies.panel.getSnapshot(message.payload.tabId, message.payload.conversationId),
      );
    case 'panel.getStateVersion':
      return successResponse(message.requestId, dependencies.panel.getStateVersion());
    case 'panel.getTaskDetails':
      return successResponse(
        message.requestId,
        await dependencies.panel.getTaskDetails(message.payload.taskId),
      );
    case 'chat.submit':
      return successResponse(message.requestId, await dependencies.panel.submit(message.payload));
    case 'chat.supplement':
      return successResponse(
        message.requestId,
        await dependencies.panel.supplement(message.payload),
      );
    case 'conversation.clear':
      return successResponse(
        message.requestId,
        await dependencies.panel.clearConversation(message.payload.conversationId),
      );
    case 'sandbox.getConsole':
      if (context.senderTabId !== null) {
        return errorResponse(message.requestId, 'INVALID_CONTEXT', 'Sandbox context is invalid.');
      }
      if (dependencies.sandboxConsole === undefined) {
        throw new Error('Sandbox console unavailable.');
      }
      return successResponse(message.requestId, {
        url: await dependencies.sandboxConsole.getConsoleUrl(AbortSignal.timeout(5_000)),
      });
    case 'settings.get':
      if (context.senderTabId !== null) {
        return errorResponse(message.requestId, 'INVALID_CONTEXT', 'Settings context is invalid.');
      }
      return successResponse(message.requestId, await dependencies.panel.getSettings());
    case 'settings.save':
      if (context.senderTabId !== null) {
        return errorResponse(message.requestId, 'INVALID_CONTEXT', 'Settings context is invalid.');
      }
      return successResponse(
        message.requestId,
        await dependencies.panel.saveSettings(message.payload),
      );
    case 'task.getSnapshot':
      return successResponse(
        message.requestId,
        await dependencies.agent.getSnapshot(message.payload.taskId),
      );
    case 'task.pause':
      return successResponse(
        message.requestId,
        await dependencies.agent.pause(message.payload.taskId),
      );
    case 'task.resume':
      return successResponse(
        message.requestId,
        await dependencies.agent.resume(message.payload.taskId),
      );
    case 'task.retry':
      return successResponse(
        message.requestId,
        await dependencies.agent.retry(message.payload.taskId),
      );
    case 'task.cancel':
      return successResponse(
        message.requestId,
        await dependencies.agent.cancel(message.payload.taskId),
      );
    case 'task.clearContext':
      return successResponse(
        message.requestId,
        await dependencies.agent.clearContext(message.payload.taskId),
      );
    case 'screenshot.capture':
      return successResponse(
        message.requestId,
        message.payload.mode === 'viewport'
          ? await dependencies.screenshots.captureViewport(message.payload.tabId)
          : await dependencies.screenshots.captureRegion(message.payload.tabId),
      );
    case 'image.preview.open':
      if (context.senderTabId !== null) {
        return errorResponse(message.requestId, 'INVALID_CONTEXT', 'Preview context is invalid.');
      }
      return successResponse(
        message.requestId,
        await dependencies.panel.openImagePreview(
          message.payload.tabId,
          message.payload.attachmentId,
        ),
      );
    case 'page.features.ensure':
      if (dependencies.pageFeatures === undefined) throw new Error('Page features unavailable.');
      return successResponse(
        message.requestId,
        await dependencies.pageFeatures.ensure(message.payload.tabId),
      );
  }
}

/**
 * Creates a total runtime-message handler that always resolves to a sanitized response envelope.
 */
export function createMessageRouter(dependencies: MessageRouterDependencies): MessageRouter {
  return async (
    value: unknown,
    context: RuntimeMessageContext = { senderTabId: null },
  ): Promise<ExtensionResponse> => {
    const requestId = readSafeRequestId(value);
    let message: ExtensionMessage;

    try {
      message = parseExtensionMessage(value);
    } catch {
      return errorResponse(requestId, 'INVALID_MESSAGE', 'Message format is invalid.');
    }

    try {
      return await routeMessage(message, dependencies, context);
    } catch (error) {
      if (
        error instanceof TaskCommandError ||
        error instanceof ScreenshotError ||
        error instanceof TranslationResponseError ||
        error instanceof TranslationStateError
      ) {
        return errorResponse(message.requestId, error.code, error.message);
      }
      if (message.type === 'translation.read') {
        if (isProviderError(error)) {
          const stage = error.invalidResponseStage?.toUpperCase();
          return errorResponse(
            message.requestId,
            `MODEL_${error.code}${stage ? `_${stage}` : ''}`,
            error.message,
          );
        }
        if (error instanceof DOMException && error.name === 'TimeoutError')
          return errorResponse(message.requestId, 'TRANSLATION_TIMEOUT', 'Translation timed out.');
      }
      return errorResponse(
        message.requestId,
        'COMMAND_FAILED',
        'Task command could not be completed.',
      );
    }
  };
}
