export const PROTOCOL_VERSION = 1 as const;

export interface Message<TType extends string, TPayload> {
  version: typeof PROTOCOL_VERSION;
  requestId: string;
  type: TType;
  payload: TPayload;
}

export type PageActionFeedback =
  | { readonly kind: 'move'; readonly x: number; readonly y: number }
  | { readonly kind: 'click'; readonly x: number; readonly y: number }
  | {
      readonly kind: 'drag';
      readonly fromX: number;
      readonly fromY: number;
      readonly toX: number;
      readonly toY: number;
    }
  | { readonly kind: 'hide' };

export type ExtensionMessage =
  | Message<'system.ping', Record<string, never>>
  | Message<'panel.getSnapshot', { tabId: number; conversationId?: string | undefined }>
  | Message<
      'chat.submit',
      {
        tabId: number;
        conversationId?: string | undefined;
        text: string;
        attachmentIds: readonly string[];
      }
    >
  | Message<'conversation.clear', { conversationId: string }>
  | Message<'settings.get', Record<string, never>>
  | Message<
      'settings.save',
      {
        reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
        systemPrompt: string;
        language: 'system' | 'zh-CN' | 'en' | 'ja';
        codexAccessToken?: string | undefined;
        tavilyKey?: string | undefined;
      }
    >
  | Message<'task.create', { tabId: number; conversationId: string; goal: string }>
  | Message<'task.getSnapshot', { taskId: string }>
  | Message<'task.pause', { taskId: string }>
  | Message<'task.resume', { taskId: string; tabId?: number | undefined }>
  | Message<'task.confirm', { taskId: string; actionDigest: string }>
  | Message<'task.cancel', { taskId: string }>
  | Message<'screenshot.capture', { tabId: number; mode: 'viewport' | 'region' }>
  | Message<'page.features.ensure', { tabId: number }>
  | Message<'selection.translate', { text: string; pageUrl: string; pageTitle: string }>
  | Message<
      'selection.ask',
      { text: string; question: string; pageUrl: string; pageTitle: string }
    >;

export type PageCommand =
  | Message<'page.ping', Record<string, never>>
  | Message<'page.observe', { observationId: string; tabId: number; capturedAt: number }>
  | Message<'page.screenshot.select', Record<string, never>>
  | Message<'page.overlays.setHidden', { hidden: boolean }>
  | Message<'page.actionFeedback', PageActionFeedback>;

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
