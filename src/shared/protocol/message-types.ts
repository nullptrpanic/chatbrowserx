export const PROTOCOL_VERSION = 1 as const;

export interface Message<TType extends string, TPayload> {
  version: typeof PROTOCOL_VERSION;
  requestId: string;
  type: TType;
  payload: TPayload;
}

export type ExtensionMessage =
  | Message<'system.ping', Record<string, never>>
  | Message<'panel.getSnapshot', { tabId: number; conversationId?: string | undefined }>
  | Message<'panel.getTaskDetails', { taskId: string }>
  | Message<
      'chat.submit',
      {
        tabId: number;
        conversationId?: string | undefined;
        text: string;
        attachmentIds: readonly string[];
      }
    >
  | Message<'chat.supplement', { taskId: string; text: string; attachmentIds: readonly string[] }>
  | Message<'conversation.clear', { conversationId: string }>
  | Message<'settings.get', Record<string, never>>
  | Message<
      'settings.save',
      {
        reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
        systemPrompt: string;
        language: 'system' | 'zh-CN' | 'en' | 'ja';
        historyMessageLimit?: number | undefined;
        codexAccessToken?: string | undefined;
        tavilyKey?: string | undefined;
        sandboxServer?: string | undefined;
        sandboxToken?: string | undefined;
      }
    >
  | Message<'task.create', { tabId: number; conversationId: string; goal: string }>
  | Message<'task.getSnapshot', { taskId: string }>
  | Message<'task.pause', { taskId: string }>
  | Message<'task.resume', { taskId: string }>
  | Message<'task.retry', { taskId: string }>
  | Message<'task.cancel', { taskId: string }>
  | Message<'task.clearContext', { taskId: string }>
  | Message<'screenshot.capture', { tabId: number; mode: 'viewport' | 'region' }>
  | Message<'image.preview.open', { tabId: number; attachmentId: string }>
  | Message<'page.features.ensure', { tabId: number }>;

export type PageCommand =
  | Message<'page.ping', Record<string, never>>
  | Message<'page.content.read', Record<string, never>>
  | Message<
      'page.action.perform',
      | { action: 'click'; ref: string; button: 'left' | 'right' | 'middle'; count: 1 | 2 }
      | { action: 'type'; ref: string; text: string; replace: boolean; submit: boolean }
      | { action: 'scroll'; target: string; deltaX: number; deltaY: number }
      | { action: 'select'; ref: string; value: string }
    >
  | Message<
      'page.pointer.show',
      {
        x: number;
        y: number;
        fromX: number;
        fromY: number;
        effect: 'move' | 'click' | 'double_click' | 'drag';
      }
    >
  | Message<'page.screenshot.select', Record<string, never>>
  | Message<'page.overlays.setHidden', { hidden: boolean }>
  | Message<'page.imagePreview.open', { src: string; alt: string }>;

export interface ExtensionError {
  code: string;
  message: string;
}

export type ExtensionResponse<TData = unknown> =
  | {
      version: typeof PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      data: TData;
    }
  | {
      version: typeof PROTOCOL_VERSION;
      requestId: string;
      ok: false;
      error: ExtensionError;
    };
