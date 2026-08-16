import { describe, expect, it } from "vitest";
import { ChromeActionFeedbackPort } from "../../../src/platform/chrome/action-feedback-port";
import type { PageCommand } from "../../../src/shared/protocol/message-types";
import { parsePageCommand } from "../../../src/shared/protocol/parse-message";

describe("ChromeActionFeedbackPort", () => {
  it("sends a strict correlated page command without waiting for its response", async () => {
    const sent: Array<{
      readonly tabId: number;
      readonly command: PageCommand;
    }> = [];
    const port = new ChromeActionFeedbackPort({
      sendMessage: (tabId, command) => {
        sent.push({ tabId, command });
        return Promise.reject(new Error("No content-script receiver"));
      },
    });

    expect(port.notify(7, { kind: "click", x: 30, y: 40 })).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.tabId).toBe(7);
    expect(sent[0]?.command.requestId).toMatch(/^action_feedback_/);
    expect(parsePageCommand(sent[0]?.command)).toMatchObject({
      version: 1,
      type: "page.actionFeedback",
      payload: { kind: "click", x: 30, y: 40 },
    });

    await Promise.resolve();
  });
});
