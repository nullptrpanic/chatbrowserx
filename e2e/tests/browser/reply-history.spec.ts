import { extensionTest, expect } from "./fixtures/extension-test";
import { sendExtensionMessage } from "./helpers/extension-runtime";
import type { PanelSnapshot } from "../../../src/shared/protocol/panel-types";

function syntheticAccessToken(): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_reply_e2e" },
  })}.`;
}

function sse(
  events: readonly { readonly event: string; readonly data: unknown }[],
): string {
  return `${events
    .map(
      ({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join("")}data: [DONE]\n\n`;
}

function finalTextResponse(responseId: string, text: string): string {
  return sse([
    {
      event: "response.created",
      data: { type: "response.created", response: { id: responseId } },
    },
    {
      event: "response.output_text.delta",
      data: { type: "response.output_text.delta", delta: text },
    },
    {
      event: "response.completed",
      data: { type: "response.completed", response: { id: responseId } },
    },
  ]);
}

function toolResponse(
  responseId: string,
  itemId: string,
  callId: string,
  name: string,
  arguments_: Readonly<Record<string, unknown>>,
): string {
  const item = {
    id: itemId,
    type: "function_call",
    call_id: callId,
    name,
    arguments: JSON.stringify(arguments_),
  };
  return sse([
    {
      event: "response.created",
      data: { type: "response.created", response: { id: responseId } },
    },
    {
      event: "response.output_item.done",
      data: { type: "response.output_item.done", item },
    },
    {
      event: "response.completed",
      data: { type: "response.completed", response: { id: responseId } },
    },
  ]);
}

function functionOutputs(body: unknown): readonly string[] {
  if (
    typeof body !== "object" ||
    body === null ||
    !("input" in body) ||
    !Array.isArray(body.input)
  ) {
    return [];
  }
  return body.input.flatMap((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      item.type !== "function_call_output" ||
      typeof item.output !== "string"
    ) {
      return [];
    }
    return [item.output];
  });
}

function inputTexts(body: unknown): readonly string[] {
  if (
    typeof body !== "object" ||
    body === null ||
    !("input" in body) ||
    !Array.isArray(body.input)
  ) {
    return [];
  }
  return body.input.flatMap((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      item.type !== "message" ||
      !("content" in item) ||
      !Array.isArray(item.content)
    ) {
      return [];
    }
    const contents = item.content as readonly unknown[];
    return contents.flatMap((content: unknown) => {
      if (
        typeof content !== "object" ||
        content === null ||
        !("type" in content) ||
        content.type !== "input_text" ||
        !("text" in content) ||
        typeof content.text !== "string"
      ) {
        return [];
      }
      return [content.text];
    });
  });
}

async function waitForTask(
  page: Parameters<typeof sendExtensionMessage>[0],
  taskId: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const snapshot = await sendExtensionMessage<{
          readonly task: { readonly status: string };
        }>(page, {
          version: 1,
          requestId: `reply_e2e_task_${taskId}_${String(Date.now())}`,
          type: "task.getSnapshot",
          payload: { taskId },
        });
        return snapshot.task.status;
      },
      { timeout: 30_000 },
    )
    .toBe("completed");
}

extensionTest(
  "replies to an answer outside the automatic 50-message history and reads its exact task",
  async ({ extensionSession }) => {
    extensionTest.setTimeout(120_000);
    const fixturePage = await extensionSession.context.newPage();
    await fixturePage.goto("https://example.com/reply-history");
    const tabs = await extensionSession.sidePanelPage.evaluate(
      async (url) => chrome.tabs.query({ url }),
      fixturePage.url(),
    );
    const tabId = tabs[0]?.id;
    if (typeof tabId !== "number")
      throw new Error("Reply fixture tab ID unavailable.");

    const completedTaskCount = 26;
    const targetQuestion = "Question 0 with a deliberately old history marker.";
    const targetAnswer =
      "Historical answer 0 with exact-task marker ALPHA-OLDEST.";
    let providerTurn = 0;
    let targetTaskId = "";
    let replyRequestBody: unknown;
    let exactHistoryOutput: unknown;
    await extensionSession.context.route(
      "https://chatgpt.com/backend-api/codex/responses",
      async (route) => {
        providerTurn += 1;
        const body = route.request().postDataJSON() as unknown;
        let responseBody: string;
        if (providerTurn <= completedTaskCount) {
          const answerIndex = providerTurn - 1;
          responseBody = finalTextResponse(
            `resp_history_${String(answerIndex)}`,
            answerIndex === 0
              ? targetAnswer
              : `Historical answer ${String(answerIndex)} with marker RECENT-${String(answerIndex)}.`,
          );
        } else if (providerTurn === completedTaskCount + 1) {
          replyRequestBody = body;
          responseBody = toolResponse(
            "resp_exact_history",
            "item_exact_history",
            "call_exact_history",
            "history_read_task",
            { taskId: targetTaskId, cursor: "", limit: 100 },
          );
        } else {
          const output = functionOutputs(body).at(-1);
          exactHistoryOutput =
            output === undefined ? undefined : JSON.parse(output);
          responseBody = finalTextResponse(
            "resp_reply_done",
            "The exact historical task was read successfully.",
          );
        }
        await route.fulfill({
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
          body: responseBody,
        });
      },
    );

    await sendExtensionMessage(extensionSession.sidePanelPage, {
      version: 1,
      requestId: "reply_e2e_settings",
      type: "settings.save",
      payload: {
        reasoningEffort: "low",
        systemPrompt:
          "Answer the user and use exact history tools when a stable task ID is given.",
        language: "en",
        historyMessageLimit: 50,
        codexAccessToken: syntheticAccessToken(),
      },
    });

    let conversationId: string | undefined;
    for (let index = 0; index < completedTaskCount; index += 1) {
      const submitted = await sendExtensionMessage<{
        readonly task: { readonly id: string };
      }>(extensionSession.sidePanelPage, {
        version: 1,
        requestId: `reply_e2e_submit_${String(index)}`,
        type: "chat.submit",
        payload: {
          tabId,
          ...(conversationId === undefined ? {} : { conversationId }),
          text:
            index === 0
              ? targetQuestion
              : `Question ${String(index)} with marker RECENT-${String(index)}.`,
          attachmentIds: [],
        },
      });
      if (index === 0) targetTaskId = submitted.task.id;
      await waitForTask(extensionSession.sidePanelPage, submitted.task.id);
      if (conversationId === undefined) {
        const snapshot = await sendExtensionMessage<PanelSnapshot>(
          extensionSession.sidePanelPage,
          {
            version: 1,
            requestId: "reply_e2e_initial_snapshot",
            type: "panel.getSnapshot",
            payload: { tabId },
          },
        );
        conversationId = snapshot.conversation?.id;
        if (conversationId === undefined)
          throw new Error("Reply conversation is unavailable.");
      }
    }

    const beforeReply = await sendExtensionMessage<PanelSnapshot>(
      extensionSession.sidePanelPage,
      {
        version: 1,
        requestId: "reply_e2e_before_reply",
        type: "panel.getSnapshot",
        payload: { tabId, conversationId },
      },
    );
    expect(beforeReply.messages).toHaveLength(completedTaskCount * 2);
    const targetMessage = beforeReply.messages.find(
      (message) =>
        message.taskId === targetTaskId && message.role === "assistant",
    );
    if (targetMessage === undefined)
      throw new Error("Old reply target is unavailable.");

    const targetArticle = extensionSession.sidePanelPage
      .locator("article.message-assistant")
      .filter({ hasText: targetAnswer });
    await expect(targetArticle).toHaveCount(1);
    await targetArticle.getByRole("button", { name: "Reply" }).click();
    await expect(
      extensionSession.sidePanelPage.getByText("Replying to ChatBrowserX"),
    ).toBeVisible();
    await extensionSession.sidePanelPage
      .getByRole("textbox")
      .fill(
        "Explain the exact old answer and inspect its original task history.",
      );
    await extensionSession.sidePanelPage
      .getByRole("button", { name: "Send" })
      .click();

    await expect
      .poll(async () => {
        const snapshot = await sendExtensionMessage<PanelSnapshot>(
          extensionSession.sidePanelPage,
          {
            version: 1,
            requestId: `reply_e2e_final_snapshot_${String(Date.now())}`,
            type: "panel.getSnapshot",
            payload: { tabId, conversationId },
          },
        );
        return snapshot.task?.status;
      })
      .toBe("completed");

    expect(providerTurn).toBe(completedTaskCount + 2);
    const serializedReplyRequest = JSON.stringify(replyRequestBody);
    const replyInputText = inputTexts(replyRequestBody).join("\n");
    expect(replyInputText).toContain(`"targetTaskId":"${targetTaskId}"`);
    expect(replyInputText).toContain(`"targetMessageId":"${targetMessage.id}"`);
    expect(replyInputText).toContain(targetAnswer);
    expect(replyInputText).not.toContain(targetQuestion);
    expect(serializedReplyRequest).not.toContain("historyTaskOffset");
    expect(serializedReplyRequest).not.toContain("availableHistoryTaskCount");
    expect(serializedReplyRequest).toContain("history_read_task");
    expect(exactHistoryOutput).toMatchObject({
      ok: true,
      task: { id: targetTaskId },
      hasMore: false,
    });
    expect(JSON.stringify(exactHistoryOutput)).toContain(targetQuestion);
    expect(JSON.stringify(exactHistoryOutput)).toContain(targetAnswer);

    const afterReply = await sendExtensionMessage<PanelSnapshot>(
      extensionSession.sidePanelPage,
      {
        version: 1,
        requestId: "reply_e2e_after_reply",
        type: "panel.getSnapshot",
        payload: { tabId, conversationId },
      },
    );
    const replyMessage = afterReply.messages.find(
      (message) =>
        message.role === "user" &&
        message.replyTo?.messageId === targetMessage.id &&
        message.replyTo.taskId === targetTaskId,
    );
    expect(replyMessage?.replyTo).toMatchObject({
      messageId: targetMessage.id,
      taskId: targetTaskId,
      excerpt: targetAnswer,
    });
  },
);
