import { extensionTest, expect } from './fixtures/extension-test';
import { sendExtensionMessage } from './helpers/extension-runtime';
import type { PanelSnapshot } from '../../../src/shared/protocol/panel-types';

function syntheticAccessToken(): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_reply_e2e' },
  })}.`;
}

function sse(events: readonly { readonly event: string; readonly data: unknown }[]): string {
  return `${events
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('')}data: [DONE]\n\n`;
}

function finalTextResponse(responseId: string, text: string): string {
  return sse([
    {
      event: 'response.created',
      data: { type: 'response.created', response: { id: responseId } },
    },
    {
      event: 'response.output_text.delta',
      data: { type: 'response.output_text.delta', delta: text },
    },
    {
      event: 'response.completed',
      data: { type: 'response.completed', response: { id: responseId } },
    },
  ]);
}

function invalidResponse(responseId: string, partialText = ''): string {
  return sse([
    {
      event: 'response.created',
      data: { type: 'response.created', response: { id: responseId } },
    },
    ...(partialText.length === 0
      ? []
      : [
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: partialText },
          },
        ]),
    {
      event: 'response.completed',
      data: {
        type: 'response.completed',
        response: { id: `${responseId}_mismatched` },
      },
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
    type: 'function_call',
    call_id: callId,
    name,
    arguments: JSON.stringify(arguments_),
  };
  return sse([
    {
      event: 'response.created',
      data: { type: 'response.created', response: { id: responseId } },
    },
    {
      event: 'response.output_item.done',
      data: { type: 'response.output_item.done', item },
    },
    {
      event: 'response.completed',
      data: { type: 'response.completed', response: { id: responseId } },
    },
  ]);
}

function functionOutputs(body: unknown): readonly string[] {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('input' in body) ||
    !Array.isArray(body.input)
  ) {
    return [];
  }
  return body.input.flatMap((item) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      item.type !== 'function_call_output' ||
      typeof item.output !== 'string'
    ) {
      return [];
    }
    return [item.output];
  });
}

function inputTexts(body: unknown): readonly string[] {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('input' in body) ||
    !Array.isArray(body.input)
  ) {
    return [];
  }
  return body.input.flatMap((item) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      item.type !== 'message' ||
      !('content' in item) ||
      !Array.isArray(item.content)
    ) {
      return [];
    }
    const contents = item.content as readonly unknown[];
    return contents.flatMap((content: unknown) => {
      if (
        typeof content !== 'object' ||
        content === null ||
        !('type' in content) ||
        content.type !== 'input_text' ||
        !('text' in content) ||
        typeof content.text !== 'string'
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
          type: 'task.getSnapshot',
          payload: { taskId },
        });
        return snapshot.task.status;
      },
      { timeout: 30_000 },
    )
    .toBe('completed');
}

async function waitForTaskStatus(
  page: Parameters<typeof sendExtensionMessage>[0],
  taskId: string,
  status: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
  await expect
    .poll(
      async () => {
        const snapshot = await sendExtensionMessage<{
          readonly task: { readonly status: string };
        }>(page, {
          version: 1,
          requestId: `reply_e2e_task_${taskId}_${String(Date.now())}`,
          type: 'task.getSnapshot',
          payload: { taskId },
        });
        return snapshot.task.status;
      },
      { timeout: 30_000 },
    )
    .toBe(status);
}

extensionTest(
  'replies to an answer outside the automatic 50-message history and reads its exact task',
  async ({ extensionSession }) => {
    extensionTest.setTimeout(120_000);
    const fixturePage = await extensionSession.context.newPage();
    await fixturePage.goto('https://example.com/reply-history');
    const tabs = await extensionSession.sidePanelPage.evaluate(
      async (url) => chrome.tabs.query({ url }),
      fixturePage.url(),
    );
    const tabId = tabs[0]?.id;
    if (typeof tabId !== 'number') throw new Error('Reply fixture tab ID unavailable.');

    const completedTaskCount = 26;
    const targetQuestion = 'Question 0 with a deliberately old history marker.';
    const targetAnswer = 'Historical answer 0 with exact-task marker ALPHA-OLDEST.';
    let providerTurn = 0;
    let targetTaskId = '';
    let replyRequestBody: unknown;
    let exactHistoryOutput: unknown;
    await extensionSession.context.route(
      'https://chatgpt.com/backend-api/codex/responses',
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
            'resp_exact_history',
            'item_exact_history',
            'call_exact_history',
            'history_read',
            { taskId: targetTaskId, offset: null, cursor: '', limit: 100 },
          );
        } else {
          const output = functionOutputs(body).at(-1);
          exactHistoryOutput = output === undefined ? undefined : JSON.parse(output);
          responseBody = finalTextResponse(
            'resp_reply_done',
            'The exact historical task was read successfully.',
          );
        }
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
          body: responseBody,
        });
      },
    );

    await sendExtensionMessage(extensionSession.sidePanelPage, {
      version: 1,
      requestId: 'reply_e2e_settings',
      type: 'settings.save',
      payload: {
        reasoningEffort: 'low',
        systemPrompt: 'Answer the user and use exact history tools when a stable task ID is given.',
        language: 'en',
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
        type: 'chat.submit',
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
        const snapshot = await sendExtensionMessage<PanelSnapshot>(extensionSession.sidePanelPage, {
          version: 1,
          requestId: 'reply_e2e_initial_snapshot',
          type: 'panel.getSnapshot',
          payload: { tabId },
        });
        conversationId = snapshot.conversation?.id;
        if (conversationId === undefined) throw new Error('Reply conversation is unavailable.');
      }
    }

    const beforeReply = await sendExtensionMessage<PanelSnapshot>(extensionSession.sidePanelPage, {
      version: 1,
      requestId: 'reply_e2e_before_reply',
      type: 'panel.getSnapshot',
      payload: { tabId, conversationId },
    });
    expect(beforeReply.messages).toHaveLength(completedTaskCount * 2);
    const targetMessage = beforeReply.messages.find(
      (message) => message.taskId === targetTaskId && message.role === 'assistant',
    );
    if (targetMessage === undefined) throw new Error('Old reply target is unavailable.');

    const targetArticle = extensionSession.sidePanelPage
      .locator('article.message-assistant')
      .filter({ hasText: targetAnswer });
    await expect(targetArticle).toHaveCount(1);
    await targetArticle.getByRole('button', { name: 'Reply' }).click();
    await expect(
      extensionSession.sidePanelPage.getByText('Replying to ChatBrowserX'),
    ).toBeVisible();
    await extensionSession.sidePanelPage
      .getByRole('textbox')
      .fill('Explain the exact old answer and inspect its original task history.');
    await extensionSession.sidePanelPage.getByRole('button', { name: 'Send' }).click();

    await expect
      .poll(async () => {
        const snapshot = await sendExtensionMessage<PanelSnapshot>(extensionSession.sidePanelPage, {
          version: 1,
          requestId: `reply_e2e_final_snapshot_${String(Date.now())}`,
          type: 'panel.getSnapshot',
          payload: { tabId, conversationId },
        });
        return snapshot.task?.status;
      })
      .toBe('completed');

    expect(providerTurn).toBe(completedTaskCount + 2);
    const serializedReplyRequest = JSON.stringify(replyRequestBody);
    const replyInputText = inputTexts(replyRequestBody).join('\n');
    expect(replyInputText).toContain(`"targetTaskId":"${targetTaskId}"`);
    expect(replyInputText).toContain(`"targetMessageId":"${targetMessage.id}"`);
    expect(replyInputText).toContain(targetAnswer);
    expect(replyInputText).not.toContain(targetQuestion);
    expect(serializedReplyRequest).not.toContain('historyTaskOffset');
    expect(serializedReplyRequest).not.toContain('availableHistoryTaskCount');
    expect(serializedReplyRequest).toContain('"history_read"');
    expect(serializedReplyRequest).not.toContain('history_read_task');
    expect(exactHistoryOutput).toMatchObject({
      ok: true,
      task: { id: targetTaskId },
      hasMore: false,
    });
    expect(JSON.stringify(exactHistoryOutput)).toContain(targetQuestion);
    expect(JSON.stringify(exactHistoryOutput)).toContain(targetAnswer);

    const afterReply = await sendExtensionMessage<PanelSnapshot>(extensionSession.sidePanelPage, {
      version: 1,
      requestId: 'reply_e2e_after_reply',
      type: 'panel.getSnapshot',
      payload: { tabId, conversationId },
    });
    const replyMessage = afterReply.messages.find(
      (message) =>
        message.role === 'user' &&
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

extensionTest(
  'keeps a failed run answer in order when the next question continues the task',
  async ({ extensionSession }) => {
    extensionTest.setTimeout(120_000);
    const fixturePage = await extensionSession.context.newPage();
    await fixturePage.goto('https://example.com/failed-run-history');
    const tabs = await extensionSession.sidePanelPage.evaluate(
      async (url) => chrome.tabs.query({ url }),
      fixturePage.url(),
    );
    const tabId = tabs[0]?.id;
    if (typeof tabId !== 'number') throw new Error('Failed-run fixture tab ID unavailable.');

    const firstQuestion = 'Question 1 should retain its failed answer card.';
    const partialAnswer = 'Partial answer from the failed run.';
    const secondQuestion = 'Question 2 should continue after the failed run.';
    const finalAnswer = 'Final answer from the second run.';
    let providerTurn = 0;
    let secondRunRequest: unknown;
    await extensionSession.context.route(
      'https://chatgpt.com/backend-api/codex/responses',
      async (route) => {
        providerTurn += 1;
        const body = route.request().postDataJSON() as unknown;
        const responseBody =
          providerTurn <= 4
            ? invalidResponse(
                `resp_failed_run_${String(providerTurn)}`,
                providerTurn === 1 ? partialAnswer : '',
              )
            : finalTextResponse('resp_failed_run_recovered', finalAnswer);
        if (providerTurn === 5) secondRunRequest = body;
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
          body: responseBody,
        });
      },
    );

    await sendExtensionMessage(extensionSession.sidePanelPage, {
      version: 1,
      requestId: 'failed_run_e2e_settings',
      type: 'settings.save',
      payload: {
        reasoningEffort: 'low',
        systemPrompt: 'Answer the user directly.',
        language: 'en',
        historyMessageLimit: 50,
        codexAccessToken: syntheticAccessToken(),
      },
    });

    const first = await sendExtensionMessage<{
      readonly task: { readonly id: string; readonly conversationId: string };
    }>(extensionSession.sidePanelPage, {
      version: 1,
      requestId: 'failed_run_e2e_submit_1',
      type: 'chat.submit',
      payload: { tabId, text: firstQuestion, attachmentIds: [] },
    });
    await waitForTaskStatus(extensionSession.sidePanelPage, first.task.id, 'failed');

    const second = await sendExtensionMessage<{
      readonly task: { readonly id: string };
    }>(extensionSession.sidePanelPage, {
      version: 1,
      requestId: 'failed_run_e2e_submit_2',
      type: 'chat.submit',
      payload: {
        tabId,
        conversationId: first.task.conversationId,
        text: secondQuestion,
        attachmentIds: [],
      },
    });
    expect(second.task.id).toBe(first.task.id);
    await waitForTask(extensionSession.sidePanelPage, second.task.id);

    const snapshot = await sendExtensionMessage<PanelSnapshot>(extensionSession.sidePanelPage, {
      version: 1,
      requestId: 'failed_run_e2e_snapshot',
      type: 'panel.getSnapshot',
      payload: { tabId, conversationId: first.task.conversationId },
    });
    expect(snapshot.task?.runs.map(({ status }) => status)).toEqual(['failed', 'completed']);
    expect(snapshot.messages.map(({ role, status, text }) => ({ role, status, text }))).toEqual([
      { role: 'user', status: 'complete', text: firstQuestion },
      { role: 'assistant', status: 'interrupted', text: partialAnswer },
      { role: 'user', status: 'complete', text: secondQuestion },
      { role: 'assistant', status: 'complete', text: finalAnswer },
    ]);
    expect(inputTexts(secondRunRequest).join('\n')).not.toContain(partialAnswer);
    expect(providerTurn).toBe(5);

    await extensionSession.sidePanelPage.reload();
    const articles = extensionSession.sidePanelPage.locator('article.message-item');
    await expect(articles).toHaveCount(4);
    await expect(articles.nth(0)).toContainText(firstQuestion);
    await expect(articles.nth(1)).toContainText(partialAnswer);
    await expect(articles.nth(1)).toContainText('Task failed');
    await expect(articles.nth(1)).toContainText(
      'The provider returned an invalid response (stage: sse_protocol).',
    );
    await expect(articles.nth(2)).toContainText(secondQuestion);
    await expect(articles.nth(3)).toContainText(finalAnswer);
    await expect(articles.nth(3)).toContainText('Task completed');
  },
);

extensionTest(
  'keeps an empty cancelled run card in order when the next question continues the task',
  async ({ extensionSession }) => {
    extensionTest.setTimeout(120_000);
    const fixturePage = await extensionSession.context.newPage();
    await fixturePage.goto('https://example.com/cancelled-run-history');
    const tabs = await extensionSession.sidePanelPage.evaluate(
      async (url) => chrome.tabs.query({ url }),
      fixturePage.url(),
    );
    const tabId = tabs[0]?.id;
    if (typeof tabId !== 'number') throw new Error('Cancelled-run fixture tab ID unavailable.');

    const firstQuestion = 'Question 1 will be cancelled without an answer.';
    const secondQuestion = 'Question 2 should continue after cancellation.';
    const finalAnswer = 'Final answer after the cancelled run.';
    let providerTurn = 0;
    await extensionSession.context.route(
      'https://chatgpt.com/backend-api/codex/responses',
      async (route) => {
        providerTurn += 1;
        const responseBody =
          providerTurn === 1
            ? toolResponse(
                'resp_cancelled_run_wait',
                'item_cancelled_run_wait',
                'call_cancelled_run_wait',
                'browser_wait',
                { tabId, condition: 'delay', timeoutMs: 10_000 },
              )
            : finalTextResponse('resp_cancelled_run_recovered', finalAnswer);
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
          body: responseBody,
        });
      },
    );

    await sendExtensionMessage(extensionSession.sidePanelPage, {
      version: 1,
      requestId: 'cancelled_run_e2e_settings',
      type: 'settings.save',
      payload: {
        reasoningEffort: 'low',
        systemPrompt: 'Answer the user directly.',
        language: 'en',
        historyMessageLimit: 50,
        codexAccessToken: syntheticAccessToken(),
      },
    });

    const first = await sendExtensionMessage<{
      readonly task: { readonly id: string; readonly conversationId: string };
    }>(extensionSession.sidePanelPage, {
      version: 1,
      requestId: 'cancelled_run_e2e_submit_1',
      type: 'chat.submit',
      payload: { tabId, text: firstQuestion, attachmentIds: [] },
    });
    await expect
      .poll(async () => {
        const running = await sendExtensionMessage<{
          readonly events: readonly { readonly type: string; readonly name?: string }[];
        }>(extensionSession.sidePanelPage, {
          version: 1,
          requestId: `cancelled_run_e2e_running_${String(Date.now())}`,
          type: 'task.getSnapshot',
          payload: { taskId: first.task.id },
        });
        return running.events.some(
          (event) => event.type === 'tool.call' && event.name === 'browser_wait',
        );
      })
      .toBe(true);
    await sendExtensionMessage(extensionSession.sidePanelPage, {
      version: 1,
      requestId: 'cancelled_run_e2e_cancel',
      type: 'task.cancel',
      payload: { taskId: first.task.id },
    });
    await waitForTaskStatus(extensionSession.sidePanelPage, first.task.id, 'cancelled');

    const second = await sendExtensionMessage<{
      readonly task: { readonly id: string };
    }>(extensionSession.sidePanelPage, {
      version: 1,
      requestId: 'cancelled_run_e2e_submit_2',
      type: 'chat.submit',
      payload: {
        tabId,
        conversationId: first.task.conversationId,
        text: secondQuestion,
        attachmentIds: [],
      },
    });
    expect(second.task.id).toBe(first.task.id);
    await waitForTask(extensionSession.sidePanelPage, second.task.id);

    const snapshot = await sendExtensionMessage<PanelSnapshot>(extensionSession.sidePanelPage, {
      version: 1,
      requestId: 'cancelled_run_e2e_snapshot',
      type: 'panel.getSnapshot',
      payload: { tabId, conversationId: first.task.conversationId },
    });
    expect(snapshot.task?.runs.map(({ status }) => status)).toEqual(['cancelled', 'completed']);
    expect(snapshot.messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: firstQuestion },
      { role: 'user', text: secondQuestion },
      { role: 'assistant', text: finalAnswer },
    ]);

    await extensionSession.sidePanelPage.reload();
    const articles = extensionSession.sidePanelPage.locator('article.message-item');
    await expect(articles).toHaveCount(4);
    await expect(articles.nth(0)).toContainText(firstQuestion);
    await expect(articles.nth(1)).toContainText(
      'The task was cancelled before a reply was generated.',
    );
    await expect(articles.nth(1)).toContainText('Task cancelled');
    await expect(articles.nth(2)).toContainText(secondQuestion);
    await expect(articles.nth(3)).toContainText(finalAnswer);
    await expect(articles.nth(3)).toContainText('Task completed');
  },
);
