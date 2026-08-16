import {
  PROTOCOL_VERSION,
  type PageActionFeedback,
  type PageCommand,
} from "../../shared/protocol/message-types";

export interface ActionFeedbackMessagePort {
  sendMessage(tabId: number, command: PageCommand): Promise<unknown>;
}

/** Sends best-effort pointer feedback to the isolated page overlay. */
export class ChromeActionFeedbackPort {
  readonly #messages: ActionFeedbackMessagePort;

  constructor(messages: ActionFeedbackMessagePort = chrome.tabs) {
    this.#messages = messages;
  }

  /** Starts one credential-free feedback message without delaying the browser action. */
  notify(tabId: number, feedback: PageActionFeedback): void {
    const command: PageCommand = {
      version: PROTOCOL_VERSION,
      requestId: `action_feedback_${crypto.randomUUID()}`,
      type: "page.actionFeedback",
      payload: feedback,
    };
    try {
      void this.#messages.sendMessage(tabId, command).catch(() => undefined);
    } catch {
      // A missing page receiver must never affect the real browser action.
    }
  }
}
