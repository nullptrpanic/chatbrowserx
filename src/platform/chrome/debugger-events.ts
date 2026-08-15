export interface ChromeDebuggerTarget {
  readonly tabId: number;
  readonly sessionId?: string;
}

export interface DebuggerSessionDescriptor {
  readonly sessionId: string;
  readonly targetId: string;
  readonly type: string;
  readonly url: string;
  readonly title: string;
  readonly parentSessionId: string | null;
}

export type ChromeDebuggerEventListener = (
  source: ChromeDebuggerTarget,
  method: string,
  params?: object,
) => void;

export type ChromeDebuggerDetachListener = (source: ChromeDebuggerTarget, reason: string) => void;

export type DebuggerEvent =
  | {
      readonly kind: 'protocol_event';
      readonly tabId: number;
      readonly sessionId: string | null;
      readonly method: string;
      readonly params: object;
    }
  | {
      readonly kind: 'detached';
      readonly tabId: number;
      readonly reason: string;
    };

export type DebuggerEventListener = (event: DebuggerEvent) => void;
