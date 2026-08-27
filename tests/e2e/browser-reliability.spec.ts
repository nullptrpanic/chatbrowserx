import { createServer, type Server } from 'node:http';
import { extensionTest, expect } from './fixtures/extension-test';
import { sendExtensionMessage } from './helpers/extension-runtime';

function syntheticAccessToken(): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_e2e' },
  })}.`;
}

function sse(events: readonly { readonly event: string; readonly data: unknown }[]): string {
  return `${events
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('')}data: [DONE]\n\n`;
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

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Fixture server unavailable.');
  return address.port;
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

extensionTest(
  'completes a long reactive form through deep AX inspection after the selected node is replaced',
  async ({ extensionSession }) => {
    const fixtureServer = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html><body>
          <main id="app"></main>
          <script>
            const app = document.querySelector('#app');
            let selected = false;
            const context = Array.from({ length: 510 }, (_, index) =>
              '<p>Question context ' + index + '</p>'
            ).join('');
            function render() {
              app.innerHTML = context +
                '<fieldset><legend>Choose the first answer</legend>' +
                '<label><input id="answer-a" type="radio" name="answer" ' +
                (selected ? 'checked ' : '') + '>A. First answer</label>' +
                '<label><input id="answer-b" type="radio" name="answer">B. Second answer</label>' +
                '</fieldset>';
              document.querySelector('#answer-a').addEventListener('click', () => {
                selected = true;
                render();
              });
            }
            render();
          </script>
        </body></html>`);
    });
    const port = await listen(fixtureServer);
    const fixtureUrl = `http://127.0.0.1:${String(port)}/exam`;
    const page = await extensionSession.context.newPage();
    await page.goto(fixtureUrl);
    const foregroundPage = await extensionSession.context.newPage();
    await foregroundPage.goto('about:blank');
    await foregroundPage.bringToFront();

    let providerTurn = 0;
    let inspectedRef = '';
    let actionOutput: Readonly<Record<string, unknown>> | null = null;
    await extensionSession.context.route(
      'https://chatgpt.com/backend-api/codex/responses',
      async (route) => {
        providerTurn += 1;
        const body = route.request().postDataJSON() as unknown;
        const outputs = functionOutputs(body);
        let responseBody: string;
        if (providerTurn === 1) {
          responseBody = toolResponse(
            'resp_inspect',
            'item_inspect',
            'call_inspect',
            'browser_inspect',
            { tabId: 0, mode: 'interactive_deep', since: 'x'.repeat(64) },
          );
        } else if (providerTurn === 2) {
          const inspection = JSON.parse(outputs.at(-1) ?? '{}') as {
            readonly data?: { readonly elements?: readonly Record<string, unknown>[] };
          };
          const answer = inspection.data?.elements?.find(
            (element) => element.n === 'A. First answer' && typeof element.ref === 'string',
          );
          inspectedRef = typeof answer?.ref === 'string' ? answer.ref : '';
          if (inspectedRef.length === 0) throw new Error('Deep inspection omitted the answer ref.');
          responseBody = toolResponse(
            'resp_select',
            'item_select',
            'call_select',
            'browser_set_checked',
            { tabId: 0, ref: inspectedRef, checked: true },
          );
        } else {
          actionOutput = JSON.parse(outputs.at(-1) ?? '{}') as Readonly<Record<string, unknown>>;
          responseBody = finalTextResponse('resp_done', 'The first answer is selected.');
        }
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
          body: responseBody,
        });
      },
    );

    try {
      const tabs = await extensionSession.sidePanelPage.evaluate(
        async (url) => chrome.tabs.query({ url }),
        fixtureUrl,
      );
      const tabId = tabs[0]?.id;
      if (typeof tabId !== 'number') throw new Error('Fixture tab ID unavailable.');
      await sendExtensionMessage(extensionSession.sidePanelPage, {
        version: 1,
        requestId: 'e2e_settings',
        type: 'settings.save',
        payload: {
          reasoningEffort: 'low',
          systemPrompt: 'Use the available browser tools to complete the requested page action.',
          language: 'en',
          historyMessageLimit: 50,
          codexAccessToken: syntheticAccessToken(),
        },
      });
      const submitted = await sendExtensionMessage<{ readonly task: { readonly id: string } }>(
        extensionSession.sidePanelPage,
        {
          version: 1,
          requestId: 'e2e_submit',
          type: 'chat.submit',
          payload: {
            tabId,
            text: 'Select the first answer on this page.',
            attachmentIds: [],
          },
        },
      );

      await expect
        .poll(
          async () => {
            const snapshot = await sendExtensionMessage<{
              readonly task: { readonly status: string };
            }>(extensionSession.sidePanelPage, {
              version: 1,
              requestId: `e2e_snapshot_${String(Date.now())}`,
              type: 'task.getSnapshot',
              payload: { taskId: submitted.task.id },
            });
            return snapshot.task.status;
          },
          { timeout: 30_000 },
        )
        .toBe('completed');

      await expect(page.locator('#answer-a')).toBeChecked();
      expect(providerTurn).toBe(3);
      expect(inspectedRef).not.toBe('');
      expect(actionOutput).toMatchObject({
        ok: true,
        data: { action: 'set_checked', requested: true, verified: true },
      });

      await extensionSession.sidePanelPage.setViewportSize({ width: 320, height: 900 });
      const taskToggle = extensionSession.sidePanelPage
        .getByRole('button', { name: /Task completed/ })
        .last();
      await expect(taskToggle).toBeVisible();
      await taskToggle.click();
      const inspectResultToggle = extensionSession.sidePanelPage.getByRole('button', {
        name: 'Expand Inspect page result',
      });
      await expect(inspectResultToggle).toBeVisible();
      await inspectResultToggle.click();
      const copyArguments = extensionSession.sidePanelPage.getByRole('button', {
        name: 'Copy call arguments',
      });
      const copyResult = extensionSession.sidePanelPage.getByRole('button', {
        name: 'Copy tool result',
      });
      await expect(copyArguments).toBeVisible();
      await expect(copyResult).toBeVisible();
      const inspectCard = extensionSession.sidePanelPage.getByLabel('Inspect page: Completed');
      const payloads = inspectCard.locator('.tool-result-content pre');
      await expect(payloads).toHaveCount(2);
      await expect
        .poll(() =>
          copyArguments.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              borderStyle: style.borderStyle,
              backgroundColor: style.backgroundColor,
              opacity: style.opacity,
              visibility: style.visibility,
              width: style.width,
            };
          }),
        )
        .toEqual({
          borderStyle: 'none',
          backgroundColor: 'rgba(0, 0, 0, 0)',
          opacity: '1',
          visibility: 'visible',
          width: '24px',
        });
      const layout = await inspectCard.evaluate((element) => {
        const card = element.getBoundingClientRect();
        const buttons = [...element.querySelectorAll<HTMLElement>('.tool-copy-action')];
        const blocks = [...element.querySelectorAll<HTMLElement>('.tool-result-content pre')];
        return {
          buttonsInsideCard: buttons.every((button) => {
            const bounds = button.getBoundingClientRect();
            return bounds.left >= card.left && bounds.right <= card.right;
          }),
          payloads: blocks.map((block) => {
            const bounds = block.getBoundingClientRect();
            const style = getComputedStyle(block);
            block.scrollLeft = block.scrollWidth;
            return {
              insideCard: bounds.left >= card.left && bounds.right <= card.right,
              overflowX: style.overflowX,
              whiteSpace: style.whiteSpace,
              horizontallyScrollable: block.scrollWidth > block.clientWidth && block.scrollLeft > 0,
            };
          }),
        };
      });
      expect(layout).toEqual({
        buttonsInsideCard: true,
        payloads: [
          {
            insideCard: true,
            overflowX: 'auto',
            whiteSpace: 'pre',
            horizontallyScrollable: true,
          },
          {
            insideCard: true,
            overflowX: 'auto',
            whiteSpace: 'pre',
            horizontallyScrollable: true,
          },
        ],
      });
    } finally {
      await foregroundPage.close();
      await page.close();
      await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
    }
  },
);

extensionTest(
  'searches and sends through custom editors while scrolling a nested conversation',
  async ({ extensionSession }) => {
    const fixtureServer = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head>
            <style>
              body { font: 16px sans-serif; margin: 24px; }
              #open-search, .person-card { cursor: pointer; }
              .editor-shell { align-items: center; border: 1px solid #ccc; display: flex;
                min-height: 44px; padding: 0 12px; width: 420px; }
              [contenteditable] { flex: 1; min-height: 30px; outline: none; }
              .placeholder { color: #777; pointer-events: none; }
              #history { border: 1px solid #ccc; height: 140px; overflow-y: auto; width: 520px; }
              #history-content { height: 1200px; padding-top: 1000px; }
              .person-card { border: 1px solid #ddd; margin-top: 12px; padding: 12px; width: 420px; }
            </style>
          </head>
          <body>
            <p id="open-search">Search</p>
            <section id="search-panel" hidden>
              <div class="editor-shell">
                <div id="people-search" contenteditable="true"></div>
                <span class="placeholder">Search people</span>
              </div>
              <div id="results"></div>
            </section>
            <section id="conversation" hidden>
              <div id="history" aria-label="Message history">
                <div id="history-content">Oldest visible message</div>
              </div>
              <div class="editor-shell">
                <div id="composer" contenteditable="true" data-placeholder="Message Alex"></div>
              </div>
              <div id="sent"></div>
            </section>
            <script>
              const openSearch = document.querySelector('#open-search');
              const searchPanel = document.querySelector('#search-panel');
              const peopleSearch = document.querySelector('#people-search');
              const results = document.querySelector('#results');
              const conversation = document.querySelector('#conversation');
              const composer = document.querySelector('#composer');
              const sent = document.querySelector('#sent');

              openSearch.addEventListener('click', () => {
                searchPanel.hidden = false;
              });
              peopleSearch.addEventListener('input', () => {
                results.innerHTML = peopleSearch.textContent.includes('Alex')
                  ? '<div class="person-card"><span>Alex Chen</span><span>Engineering</span></div>'
                  : '';
                results.querySelector('.person-card')?.addEventListener('click', () => {
                  searchPanel.hidden = true;
                  conversation.hidden = false;
                });
              });
              composer.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                const text = composer.textContent.trim();
                if (!text) return;
                const message = document.createElement('p');
                message.textContent = text;
                sent.append(message);
                composer.textContent = '';
              });
            </script>
          </body>
        </html>`);
    });
    const port = await listen(fixtureServer);
    const fixtureUrl = `http://127.0.0.1:${String(port)}/messenger`;
    const page = await extensionSession.context.newPage();
    await page.goto(fixtureUrl);
    const foregroundPage = await extensionSession.context.newPage();
    await foregroundPage.goto('about:blank');
    await foregroundPage.bringToFront();

    let providerTurn = 0;
    let nestedScrollOutput: Readonly<Record<string, unknown>> | null = null;
    let replayedSubmitOutput: Readonly<Record<string, unknown>> | null = null;
    let composerRef = '';
    await extensionSession.context.route(
      'https://chatgpt.com/backend-api/codex/responses',
      async (route) => {
        providerTurn += 1;
        const body = route.request().postDataJSON() as unknown;
        const outputs = functionOutputs(body);
        const latest = JSON.parse(outputs.at(-1) ?? '{}') as {
          readonly data?: {
            readonly elements?: readonly Record<string, unknown>[];
          };
        };
        const elements = latest.data?.elements ?? [];
        const refNamed = (name: string): string => {
          const target = elements.find(
            (element) =>
              typeof element.n === 'string' &&
              element.n.includes(name) &&
              typeof element.ref === 'string',
          );
          return typeof target?.ref === 'string' ? target.ref : '';
        };
        let responseBody: string;
        switch (providerTurn) {
          case 1:
            responseBody = toolResponse(
              'resp_search_entry',
              'item_search_entry',
              'call_search_entry',
              'browser_inspect',
              { tabId: 0, mode: 'interactive', since: '' },
            );
            break;
          case 2: {
            const ref = refNamed('Search');
            if (!ref) throw new Error('Search entry ref unavailable.');
            responseBody = toolResponse(
              'resp_open_search',
              'item_open_search',
              'call_open_search',
              'browser_click',
              { tabId: 0, ref, button: 'left', count: 1 },
            );
            break;
          }
          case 3:
            responseBody = toolResponse(
              'resp_search_editor',
              'item_search_editor',
              'call_search_editor',
              'browser_inspect',
              { tabId: 0, mode: 'interactive', since: '' },
            );
            break;
          case 4: {
            const ref = refNamed('Search people');
            if (!ref) throw new Error('Custom search editor ref unavailable.');
            responseBody = toolResponse(
              'resp_type_search',
              'item_type_search',
              'call_type_search',
              'browser_type',
              { tabId: 0, ref, text: 'Alex', replace: true, submit: false },
            );
            break;
          }
          case 5:
            responseBody = toolResponse(
              'resp_person_result',
              'item_person_result',
              'call_person_result',
              'browser_inspect',
              { tabId: 0, mode: 'interactive', since: '' },
            );
            break;
          case 6: {
            const ref = refNamed('Alex Chen');
            if (!ref) throw new Error('Person card ref unavailable.');
            responseBody = toolResponse(
              'resp_open_person',
              'item_open_person',
              'call_open_person',
              'browser_click',
              { tabId: 0, ref, button: 'left', count: 1 },
            );
            break;
          }
          case 7:
            responseBody = toolResponse(
              'resp_conversation',
              'item_conversation',
              'call_conversation',
              'browser_inspect',
              { tabId: 0, mode: 'interactive', since: '' },
            );
            break;
          case 8: {
            const ref = refNamed('Message history');
            composerRef = refNamed('Message Alex');
            if (!ref || !composerRef) throw new Error('Conversation targets unavailable.');
            responseBody = toolResponse(
              'resp_scroll',
              'item_scroll',
              'call_scroll',
              'browser_scroll',
              {
                tabId: 0,
                target: ref,
                deltaX: 0,
                deltaY: 200,
                maxSegments: 1,
                stopText: '',
              },
            );
            break;
          }
          case 9:
            nestedScrollOutput = JSON.parse(outputs.at(-1) ?? '{}') as Readonly<
              Record<string, unknown>
            >;
            responseBody = toolResponse('resp_send', 'item_send', 'call_send', 'browser_type', {
              tabId: 0,
              ref: composerRef,
              text: 'Hello Alex',
              replace: true,
              submit: true,
            });
            break;
          case 10:
            responseBody = toolResponse(
              'resp_repeat_send',
              'item_repeat_send',
              'call_repeat_send',
              'browser_type',
              { tabId: 0, ref: composerRef, text: 'Hello Alex', replace: true, submit: true },
            );
            break;
          default:
            replayedSubmitOutput = JSON.parse(outputs.at(-1) ?? '{}') as Readonly<
              Record<string, unknown>
            >;
            responseBody = finalTextResponse('resp_messenger_done', 'Message sent once.');
        }
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
          body: responseBody,
        });
      },
    );

    try {
      const tabs = await extensionSession.sidePanelPage.evaluate(
        async (url) => chrome.tabs.query({ url }),
        fixtureUrl,
      );
      const tabId = tabs[0]?.id;
      if (typeof tabId !== 'number') throw new Error('Fixture tab ID unavailable.');
      await sendExtensionMessage(extensionSession.sidePanelPage, {
        version: 1,
        requestId: 'messenger_e2e_settings',
        type: 'settings.save',
        payload: {
          reasoningEffort: 'low',
          systemPrompt: 'Use the available browser tools to complete the requested page action.',
          language: 'en',
          historyMessageLimit: 50,
          codexAccessToken: syntheticAccessToken(),
        },
      });
      const submitted = await sendExtensionMessage<{ readonly task: { readonly id: string } }>(
        extensionSession.sidePanelPage,
        {
          version: 1,
          requestId: 'messenger_e2e_submit',
          type: 'chat.submit',
          payload: {
            tabId,
            text: 'Find Alex, review older messages, and send one greeting.',
            attachmentIds: [],
          },
        },
      );

      await expect
        .poll(
          async () => {
            const snapshot = await sendExtensionMessage<{
              readonly task: { readonly status: string };
            }>(extensionSession.sidePanelPage, {
              version: 1,
              requestId: `messenger_e2e_snapshot_${String(Date.now())}`,
              type: 'task.getSnapshot',
              payload: { taskId: submitted.task.id },
            });
            return snapshot.task.status;
          },
          { timeout: 30_000 },
        )
        .toBe('completed');

      expect(providerTurn).toBe(11);
      expect(nestedScrollOutput).toMatchObject({
        ok: true,
        data: {
          action: 'scroll',
          strategy: 'element',
          moved: true,
          actualDeltaY: 200,
        },
      });
      expect(replayedSubmitOutput).toMatchObject({
        ok: true,
        data: { action: 'type', submitted: true, replayed: true },
      });
      await expect(page.locator('#history')).toHaveJSProperty('scrollTop', 200);
      await expect(page.locator('#sent > p')).toHaveCount(1);
      await expect(page.locator('#sent > p')).toHaveText('Hello Alex');
    } finally {
      await foregroundPage.close();
      await page.close();
      await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
    }
  },
);
