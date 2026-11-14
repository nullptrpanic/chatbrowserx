import { codexFixtureEvents } from './helpers/codex-fixture';
import { extensionTest, expect } from './fixtures/extension-test';
import { sendExtensionMessage } from './helpers/extension-runtime';
import { DEFAULT_DATABASE_NAME } from '../../../src/persistence/database-schema';
import type { TaskSnapshot } from '../../../src/tasks/task-command-service';
import type { PanelSnapshot } from '../../../src/shared/protocol/panel-types';

extensionTest.beforeEach(async ({ extensionSession }) => {
  // These history tests need an ordinary tab, not a response from the public Internet.
  await extensionSession.context.route(
    /^https:\/\/example\.com\/(?:reply-history|failed-run-history|cancelled-run-history)$/,
    (route) => route.fulfill({ contentType: 'text/html', body: '<title>History fixture</title>' }),
  );
});

function syntheticAccessToken(): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_reply_e2e' },
  })}.`;
}

function sse(events: readonly { readonly event: string; readonly data: unknown }[]): string {
  return `${codexFixtureEvents(
    events.map(({ data }) => data as { type: string; [key: string]: unknown }),
  )
    .map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
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
        response: { id: responseId, output: 'invalid-array' },
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
      (item.type !== 'message' && !(item.type === undefined && typeof item.role === 'string')) ||
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
  'keeps historical image references across tasks and rereads original bytes on demand',
  async ({ extensionSession }) => {
    const { context, sidePanelPage: panel } = extensionSession;
    await context.route('https://image-history.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Image history fixture</title><h1>Image history fixture</h1>',
      }),
    );
    const page = await context.newPage();
    await page.goto('https://image-history.test/');
    const tabs = await panel.evaluate(async (url) => chrome.tabs.query({ url }), page.url());
    const tabId = tabs[0]?.id;
    if (typeof tabId !== 'number') throw new Error('Image history tab unavailable.');
    type Part = { type: string; image_url?: string };
    type RequestBody = { input: { type: string; content?: Part[]; output?: string | Part[] }[] };
    const requests: RequestBody[] = [];
    const images = (body: RequestBody | undefined) => {
      if (body === undefined) throw new Error('Expected Provider request was not captured.');
      return body.input.flatMap((item) =>
        [...(item.content ?? []), ...(Array.isArray(item.output) ? item.output : [])]
          .filter((part) => part.type === 'input_image')
          .map((part) => part.image_url),
      );
    };
    let originalTaskId = '';
    let attachmentId = '';
    let historyOutput: unknown;
    await context.route('https://chatgpt.com/backend-api/codex/responses', async (route) => {
      const body = route.request().postDataJSON() as RequestBody;
      const turn = requests.push(body);
      let response = finalTextResponse(`image_response_${turn}`, `Image fixture answer ${turn}.`);
      if (turn === 7) {
        response = toolResponse('image_history', 'item_history', 'call_history', 'history_read', {
          taskId: originalTaskId,
          offset: null,
          cursor: '',
          limit: 100,
        });
      } else if (turn === 8) {
        historyOutput = JSON.parse(functionOutputs(body).at(-1) ?? 'null');
        response = toolResponse('image_read', 'item_image', 'call_image', 'attachment_read', {
          attachmentIds: [attachmentId],
        });
      }
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: response,
      });
    });
    await sendExtensionMessage(panel, {
      version: 1,
      requestId: 'image_settings',
      type: 'settings.save',
      payload: {
        reasoningEffort: 'low',
        systemPrompt: 'Answer the user.',
        language: 'en',
        historyMessageLimit: 50,
        accessToken: syntheticAccessToken(),
      },
    });
    await panel.locator('input[type="file"]').setInputFiles({
      name: 'reference.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=',
        'base64',
      ),
    });
    await expect(panel.locator('.attachment-thumbnail')).toHaveCount(1);
    await panel.getByRole('textbox').fill('Remember the uploaded reference image.');
    await panel.getByRole('button', { name: 'Send' }).click();
    const snapshot = () =>
      sendExtensionMessage<PanelSnapshot>(panel, {
        version: 1,
        requestId: `image_snapshot_${Date.now()}`,
        type: 'panel.getSnapshot',
        payload: { tabId },
      });
    await expect.poll(async () => (await snapshot()).task?.status).toBe('completed');
    const initial = await snapshot();
    if (!initial.task || !initial.conversation) throw new Error('Initial image task unavailable.');
    originalTaskId = initial.task.id;
    const conversationId = initial.conversation.id;
    const originalMessage = initial.messages.find((message) => message.role === 'user');
    attachmentId = originalMessage?.attachmentIds[0] ?? '';
    expect(attachmentId).not.toBe('');
    expect(requests).toHaveLength(1);
    expect(images(requests[0])).toHaveLength(1);
    const originalImages = images(requests[0]);
    // Reopening the UI must retain the image and its stable reference, not only a draft cache.
    await panel.reload();
    await expect(panel.locator('.connection-dot.is-ready')).toBeVisible();
    const submit = async (text: string) => {
      const task = await sendExtensionMessage<{ task: { id: string } }>(panel, {
        version: 1,
        requestId: `image_submit_${requests.length}`,
        type: 'chat.submit',
        payload: { tabId, conversationId, text, attachmentIds: [] },
      });
      await waitForTask(panel, task.task.id);
      return task.task.id;
    };
    for (let index = 0; index < 5; index += 1) {
      await submit(`Unrelated text-only question ${index}.`);
      expect(requests).toHaveLength(index + 2);
      expect(images(requests.at(-1))).toEqual([]);
      expect(inputTexts(requests.at(-1)).join('\n')).toContain(attachmentId);
    }
    const rereadTaskId = await submit('Inspect a detail in the original image.');
    expect(requests).toHaveLength(9);
    expect(images(requests[6])).toEqual([]);
    expect(images(requests[7])).toEqual([]);
    expect(historyOutput).toMatchObject({
      ok: true,
      items: expect.arrayContaining([
        expect.objectContaining({ type: 'message', attachmentIds: [attachmentId] }),
      ]),
    });
    expect(images(requests[8])).toEqual(originalImages);
    const details = await sendExtensionMessage<{
      toolResults: { toolName: string; attachmentIds: string[] }[];
    }>(panel, {
      version: 1,
      requestId: 'image_reread_details',
      type: 'task.getSnapshot',
      payload: { taskId: rereadTaskId },
    });
    expect(details.toolResults.map(({ toolName }) => toolName)).toEqual([
      'history_read',
      'attachment_read',
    ]);
    expect(details.toolResults.at(-1)?.attachmentIds).toEqual([attachmentId]);
    await submit('Another unrelated text-only question after rereading.');
    expect(requests).toHaveLength(10);
    expect(images(requests[9])).toEqual([]);
    expect(
      (await snapshot()).messages.find(({ id }) => id === originalMessage?.id)?.attachmentIds,
    ).toEqual([attachmentId]);
  },
);

extensionTest(
  'retains more than fifty messages and can read an earlier answer by its exact task',
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
        accessToken: syntheticAccessToken(),
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
    expect(replyInputText).toContain(targetQuestion);
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
        accessToken: syntheticAccessToken(),
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
    expect(JSON.stringify(secondRunRequest)).toContain(partialAnswer);
    expect(providerTurn).toBe(5);

    await extensionSession.sidePanelPage.reload();
    const articles = extensionSession.sidePanelPage.locator('article.message-item');
    await expect(articles).toHaveCount(4);
    await expect(articles.nth(0)).toContainText(firstQuestion);
    await expect(articles.nth(1)).toContainText(partialAnswer);
    await expect(articles.nth(1)).toContainText('Task failed');
    await expect(articles.nth(1)).toContainText(
      'The provider returned an invalid response (stage: response_transport).',
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
        accessToken: syntheticAccessToken(),
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

extensionTest(
  'retains receipts and supplements through compaction cancellation and worker restart',
  async ({ extensionSession }) => {
    const { context, sidePanelPage: panel } = extensionSession;
    const page = await context.newPage();
    await page.goto('https://example.com/cancelled-run-history');
    const tabId = (await panel.evaluate(async (url) => chrome.tabs.query({ url }), page.url()))[0]
      ?.id;
    if (typeof tabId !== 'number') throw new Error('Lifecycle fixture tab unavailable.');
    const send = <T>(type: Parameters<typeof sendExtensionMessage>[1]['type'], payload: unknown) =>
      sendExtensionMessage<T>(panel, {
        version: 1,
        requestId: crypto.randomUUID(),
        type,
        payload,
      } as Parameters<typeof sendExtensionMessage>[1]);
    const requests: { input: { type: string; call_id?: string }[] }[] = [];
    let compactions = 0;
    let releaseCancelled: (() => void) | undefined;
    await context.route('https://chatgpt.com/backend-api/codex/responses', async (route) => {
      const body = route.request().postDataJSON() as (typeof requests)[number];
      requests.push(body);
      let response: string;
      if (body.input.some((item) => item.type === 'compaction_trigger')) {
        compactions++;
        if (compactions === 1) {
          await new Promise<void>((resolve) => {
            releaseCancelled = resolve;
          });
          await route.abort().catch(() => undefined);
          return;
        }
        response = sse([
          {
            event: 'response.created',
            data: { type: 'response.created', response: { id: 'compact' } },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                id: 'compact',
                output: [
                  {
                    type: 'compaction',
                    id: 'native-window',
                    encrypted_content: 'synthetic-window',
                  },
                ],
              },
            },
          },
        ]);
      } else if (requests.length === 1) {
        response = toolResponse('observe', 'observe-item', 'observe-once', 'browser_inspect', {
          tabId,
          mode: 'interactive',
          ref: '',
          since: '',
        })
          .replace('"input_tokens":12', '"input_tokens":232000')
          .replace('"total_tokens":15', '"total_tokens":232003');
      } else response = finalTextResponse('recovered', 'Lifecycle recovery completed.');
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: response });
    });
    await send('settings.save', {
      reasoningEffort: 'low',
      systemPrompt: '',
      language: 'en',
      accessToken: syntheticAccessToken(),
    });
    const first = await send<{ task: { id: string; conversationId: string } }>('chat.submit', {
      tabId,
      text: 'Inspect the page and remember LIFECYCLE_ANCHOR.',
      attachmentIds: [],
    });
    await expect.poll(() => compactions).toBe(1);
    const details = await send<{ contextCompaction: string }>('panel.getTaskDetails', {
      taskId: first.task.id,
    });
    expect(details.contextCompaction).toBe('started');
    await send('chat.supplement', {
      taskId: first.task.id,
      text: 'Retain QUEUED_DURING_COMPACTION.',
      attachmentIds: [],
    });
    await send('task.cancel', { taskId: first.task.id });
    releaseCancelled?.();
    await waitForTaskStatus(panel, first.task.id, 'cancelled');

    const cdp = await context.newCDPSession(panel);
    let versionId: string | undefined;
    let stopped = false;
    cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
      stopped ||= versions.some(
        (version) => version.versionId === versionId && version.runningStatus === 'stopped',
      );
      versionId =
        versions.find((version) => version.scriptURL === extensionSession.serviceWorker.url())
          ?.versionId ?? versionId;
    });
    await cdp.send('ServiceWorker.enable');
    await expect.poll(() => versionId).toBeTruthy();
    if (!versionId) throw new Error('Extension worker version unavailable.');
    await cdp.send('ServiceWorker.stopWorker', { versionId });
    await expect.poll(() => stopped).toBe(true);
    await cdp.detach();
    const next = await send<{ task: { id: string } }>('chat.submit', {
      tabId,
      conversationId: first.task.conversationId,
      text: 'Continue from the saved receipt.',
      attachmentIds: [],
    });
    await waitForTask(panel, next.task.id);
    expect(compactions).toBe(2);
    const compactInput = JSON.stringify(requests[2]);
    expect(compactInput).toContain('observe-once');
    expect(compactInput).toContain('function_call_output');
    expect(compactInput.match(/QUEUED_DURING_COMPACTION/g)).toHaveLength(1);
    expect(requests.at(-1)?.input).toEqual([
      { type: 'compaction', id: 'native-window', encrypted_content: 'synthetic-window' },
    ]);
    const final = await send<{ toolResults: unknown[]; task: { status: string } }>(
      'task.getSnapshot',
      { taskId: next.task.id },
    );
    expect(final.task.status).toBe('completed');
    expect(final.toolResults).toHaveLength(1);
  },
);

extensionTest(
  'recovers a legacy broken window and preserves the earlier compacted window when clearing a started task',
  async ({ extensionSession }) => {
    const { context, sidePanelPage: panel } = extensionSession;
    const page = await context.newPage();
    await page.goto('https://example.com/cancelled-run-history');
    const tabId = (await panel.evaluate(async (url) => chrome.tabs.query({ url }), page.url()))[0]
      ?.id;
    if (typeof tabId !== 'number') throw new Error('Lifecycle fixture tab unavailable.');
    const send = <T>(type: Parameters<typeof sendExtensionMessage>[1]['type'], payload: unknown) =>
      sendExtensionMessage<T>(panel, {
        version: 1,
        requestId: crypto.randomUUID(),
        type,
        payload,
      } as Parameters<typeof sendExtensionMessage>[1]);
    const requests: { input: unknown[] }[] = [];
    const earlierAnswer = 'The exact earlier answer is ORCHID-82.';
    const discardedQuestion = 'Question to remove from the model context.';
    const compacted = {
      type: 'compaction',
      id: 'fixture-window',
      encrypted_content: 'synthetic-opaque-window',
    };
    let releaseRequest: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    await context.route('https://chatgpt.com/backend-api/codex/responses', async (route) => {
      const body = route.request().postDataJSON() as { input: Array<{ type?: string }> };
      requests.push(body);
      if (JSON.stringify(body.input).includes(discardedQuestion)) {
        await release;
        await route.abort().catch(() => undefined);
        return;
      }
      const output = body.input.some((item) => item.type === 'compaction_trigger')
        ? sse([
            {
              event: 'response.completed',
              data: {
                type: 'response.completed',
                response: { id: 'real-window', output: [compacted] },
              },
            },
          ])
        : requests.length === 1
          ? finalTextResponse('earlier-answer', earlierAnswer)
          : requests.length === 2
            ? finalTextResponse('recovered-answer', 'Recovered conversation.')
                .replace('"input_tokens":12', '"input_tokens":232000')
                .replace('"total_tokens":15', '"total_tokens":232003')
            : finalTextResponse(`answer-${requests.length}`, 'Continued successfully.');
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: output });
    });
    try {
      await send('settings.save', {
        reasoningEffort: 'low',
        systemPrompt: '',
        language: 'en',
        accessToken: syntheticAccessToken(),
      });
      const first = await send<TaskSnapshot>('chat.submit', {
        tabId,
        text: 'Remember the earlier answer.',
        attachmentIds: [],
      });
      await waitForTask(panel, first.task.id);
      await panel.evaluate(
        async ({ databaseName, conversationId, taskId }) => {
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(databaseName);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          try {
            await new Promise<void>((resolve, reject) => {
              const transaction = database.transaction('agent-sessions', 'readwrite');
              transaction.oncomplete = () => resolve();
              transaction.onabort = () => reject(transaction.error);
              transaction.objectStore('agent-sessions').put({
                conversationId,
                taskId,
                providerId: 'codex',
                items: [{ type: 'compaction', id: 'legacy-window-without-payload' }],
                admittedMessageIds: [],
                lastInputTokens: null,
              });
            });
          } finally {
            database.close();
          }
        },
        {
          databaseName: DEFAULT_DATABASE_NAME,
          conversationId: first.task.conversationId,
          taskId: first.task.id,
        },
      );
      const submit = (text: string) =>
        send<TaskSnapshot>('chat.submit', {
          tabId,
          conversationId: first.task.conversationId,
          text,
          attachmentIds: [],
        });
      const recovered = await submit('Read the earlier answer after upgrading.');
      await waitForTask(panel, recovered.task.id);
      expect(JSON.stringify(requests[1]?.input)).toContain(earlierAnswer);
      expect(JSON.stringify(requests[1]?.input)).not.toContain('legacy-window-without-payload');

      const afterCompaction = await submit('Continue using the compacted conversation.');
      await waitForTask(panel, afterCompaction.task.id);
      expect(requests[3]?.input).toEqual([compacted]);

      const cancelled = await submit(discardedQuestion);
      await expect.poll(() => requests.length).toBe(5);
      await send('task.cancel', { taskId: cancelled.task.id });
      releaseRequest();
      await waitForTaskStatus(panel, cancelled.task.id, 'cancelled');
      const cleared = await send<TaskSnapshot>('task.clearContext', { taskId: cancelled.task.id });
      expect(cleared.checkpoint).toBeNull();
      expect(cleared.events.at(-1)?.type).toBe('context.cleared');

      const last = await submit('Continue from before the cleared task.');
      await waitForTask(panel, last.task.id);
      const input = requests[5]?.input;
      expect(input).toContainEqual(compacted);
      expect(JSON.stringify(input)).not.toContain(discardedQuestion);
      expect(JSON.stringify(input)).not.toContain(earlierAnswer);
      expect(
        (
          await send<PanelSnapshot>('panel.getSnapshot', {
            tabId,
            conversationId: first.task.conversationId,
          })
        ).messages,
      ).toContainEqual(expect.objectContaining({ text: discardedQuestion }));
    } finally {
      releaseRequest();
    }
  },
);
