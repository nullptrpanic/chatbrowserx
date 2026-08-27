import {
  PROTOCOL_VERSION,
  type ExtensionMessage,
  type ExtensionResponse,
} from '../../shared/protocol/message-types';
import { parseExtensionMessage } from '../../shared/protocol/parse-message';
import type { SandboxConsoleClientPort } from '../../sandbox/sandbox-client';
import { TaskCommandError, type TaskCommandPort } from '../../tasks/task-command-service';
import type { PanelService } from '../../tasks/panel-service';

export interface RuntimeMessageContext {
  readonly senderTabId: number | null;
}

export type MessageRouter = (
  value: unknown,
  context?: RuntimeMessageContext,
) => Promise<ExtensionResponse>;

export interface MessageRouterDependencies {
  readonly commands: Omit<TaskCommandPort, 'create'>;
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
  readonly requestRecoveryScan: () => Promise<void>;
  readonly scheduleTask: (taskId: string) => Promise<void>;
  readonly sandboxConsole?: SandboxConsoleClientPort;
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
    case 'system.ping':
      await dependencies.requestRecoveryScan();
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
        await dependencies.commands.getSnapshot(message.payload.taskId),
      );
    case 'task.pause':
      return successResponse(
        message.requestId,
        await dependencies.commands.pause(message.payload.taskId),
      );
    case 'task.resume': {
      const snapshot = await dependencies.commands.resume(message.payload.taskId);
      await dependencies.scheduleTask(snapshot.task.id);
      return successResponse(message.requestId, snapshot);
    }
    case 'task.retry': {
      const snapshot = await dependencies.commands.retry(message.payload.taskId);
      await dependencies.scheduleTask(snapshot.task.id);
      return successResponse(message.requestId, snapshot);
    }
    case 'task.cancel':
      return successResponse(
        message.requestId,
        await dependencies.commands.cancel(message.payload.taskId),
      );
    case 'task.clearContext':
      return successResponse(
        message.requestId,
        await dependencies.commands.clearContext(message.payload.taskId),
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
      if (error instanceof TaskCommandError) {
        return errorResponse(message.requestId, error.code, error.message);
      }
      return errorResponse(
        message.requestId,
        'COMMAND_FAILED',
        'Task command could not be completed.',
      );
    }
  };
}
