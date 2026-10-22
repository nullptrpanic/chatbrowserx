import { createServer, type Server } from 'node:http';
import { extensionTest, expect } from './fixtures/extension-test';
import { sendExtensionMessage } from './helpers/extension-runtime';
import { closeHttpFixtureServer } from './helpers/http-server';
import type { ExtensionSession } from './fixtures/extension-context';

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
    if (typeof item !== 'object' || item === null || item.type !== 'function_call_output') {
      return [];
    }
    if (typeof item.output === 'string') return [item.output];
    if (!Array.isArray(item.output)) return [];
    return item.output.flatMap((part: unknown) =>
      typeof part === 'object' &&
      part !== null &&
      'type' in part &&
      part.type === 'input_text' &&
      'text' in part &&
      typeof part.text === 'string'
        ? [part.text]
        : [],
    );
  });
}

async function runFixtureTask(session: ExtensionSession, tabId: number, text: string) {
  await sendExtensionMessage(session.sidePanelPage, {
    version: 1,
    requestId: 'reliability_settings',
    type: 'settings.save',
    payload: {
      reasoningEffort: 'low',
      systemPrompt: 'Use browser tools.',
      language: 'en',
      historyMessageLimit: 50,
      codexAccessToken: syntheticAccessToken(),
    },
  });
  const submitted = await sendExtensionMessage<{ task: { id: string } }>(session.sidePanelPage, {
    version: 1,
    requestId: 'reliability_submit',
    type: 'chat.submit',
    payload: { tabId, text, attachmentIds: [] },
  });
  await expect
    .poll(
      async () => {
        const snapshot = await sendExtensionMessage<{
          task: { status: string };
        }>(session.sidePanelPage, {
          version: 1,
          requestId: `reliability_snapshot_${Date.now()}`,
          type: 'task.getSnapshot',
          payload: { taskId: submitted.task.id },
        });
        return snapshot.task.status;
      },
      { timeout: 30_000 },
    )
    .toBe('completed');
}

extensionTest(
  'continues a premature final through durable progress without injecting instructions',
  async ({ extensionSession }) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(
        `<!doctype html><button onclick="document.querySelector('output').textContent='Alpha done; Beta done'">Finish batch</button><output>Alpha pending; Beta pending</output>`,
      );
    });
    const port = await listen(server);
    const page = await extensionSession.context.newPage();
    try {
      const url = `http://127.0.0.1:${port}/progress`;
      await page.goto(url);
      const tabId = await extensionSession.sidePanelPage.evaluate(
        async (url) => (await chrome.tabs.query({ url }))[0]?.id,
        url,
      );
      if (tabId === undefined) throw new Error('Fixture tab missing');
      const state = {
        scope: 'Finish Alpha and Beta',
        inventoryComplete: true,
        inventoryEvidence: 'Two explicitly requested items',
        blocker: '',
        items: ['Alpha', 'Beta'].map((id) => ({
          id,
          description: id,
          status: 'pending',
          evidence: '',
          evidenceCallId: '',
        })),
      };
      const inspect = {
        tabId: 0,
        mode: 'interactive',
        since: '',
        ref: '',
        visualReason: '',
      };
      let turn = 0;
      await extensionSession.context.route(
        'https://chatgpt.com/backend-api/codex/responses',
        async (route) => {
          const request = route.request().postDataJSON();
          expect(request.instructions).toBe('Use browser tools.');
          const output = JSON.parse(functionOutputs(request).at(-1) ?? '{}');
          let body: string;
          switch (++turn) {
            case 1:
              body = toolResponse('p1', 'i1', 'plan', 'task_progress', {
                update: state,
              });
              break;
            case 2:
              expect(output.state.items).toHaveLength(2);
              body = finalTextResponse('partial', 'Still pending.');
              break;
            case 3:
              expect(request.tool_choice).toBe('auto');
              expect(
                request.tools.some((tool: { name: string }) => tool.name === 'browser_click'),
              ).toBe(true);
              expect(JSON.stringify(request.input.at(-1))).toContain('runtime_completion_review');
              expect(JSON.stringify(request.input.at(-1))).toContain('execute_pending');
              body = toolResponse('p3', 'i3', 'review', 'task_progress', {
                update: null,
              });
              break;
            case 4:
              expect(
                output.state.items.every((item: { status: string }) => item.status === 'pending'),
              ).toBe(true);
              expect(output.review).toMatchObject({
                completion: 'continue',
                reason: 'pending_items',
                next: { action: 'execute_pending', itemIds: ['Alpha', 'Beta'] },
              });
              body = toolResponse('p4', 'i4', 'inspect', 'browser_inspect', inspect);
              break;
            case 5: {
              const button = output.data.elements.find(
                (item: { n: string; r: string }) =>
                  item.r === 'button' && item.n === 'Finish batch',
              );
              expect(button?.ref).toBeTruthy();
              body = toolResponse('p5', 'i5', 'finish', 'browser_click', {
                tabId: 0,
                ref: button.ref,
                button: 'left',
                count: 1,
              });
              break;
            }
            case 6:
              body = toolResponse('p6', 'i6', 'verified', 'browser_inspect', inspect);
              break;
            case 7:
              expect(JSON.stringify(output)).toContain('Alpha done; Beta done');
              body = toolResponse('p7', 'i7', 'recorded', 'task_progress', {
                update: {
                  ...state,
                  items: state.items.map((item) => ({
                    ...item,
                    status: 'verified',
                    evidence: 'Read back done status',
                    evidenceCallId: output.data.snapshot,
                  })),
                },
              });
              break;
            case 8:
              expect(output.ok).toBe(false);
              expect(output.availableEvidence.at(-1)?.callId).toBe('verified');
              body = toolResponse('p8', 'i8', 'corrected', 'task_progress', {
                update: {
                  ...state,
                  items: state.items.map((item) => ({
                    ...item,
                    status: 'verified',
                    evidence: 'Read back done status',
                    evidenceCallId: output.availableEvidence.at(-1).callId,
                  })),
                },
              });
              break;
            case 9:
              expect(output.review).toMatchObject({
                completion: 'ready',
                next: null,
              });
              body = finalTextResponse('complete', 'Both items verified.');
              break;
            default:
              throw new Error('Unexpected extra completion loop');
          }
          await route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body,
          });
        },
      );
      await runFixtureTask(
        extensionSession,
        tabId,
        'Finish both Alpha and Beta and verify the result.',
      );
      expect(turn).toBe(9);
      await expect(page.locator('output')).toHaveText('Alpha done; Beta done');
    } finally {
      await page.close();
      await closeHttpFixtureServer(server);
    }
  },
);

extensionTest.describe('screenshot coordinate units', () => {
  extensionTest.use({
    extensionBrowserArgs: ['--force-device-scale-factor=2'],
  });
  for (const zoom of [1, 1.5]) {
    extensionTest(
      `clicks the screenshot target at DPR 2 and browser zoom ${zoom}`,
      async ({ extensionSession }) => {
        const server = createServer((_request, response) => {
          response.writeHead(200, { 'Content-Type': 'text/html' });
          response.end(`<!doctype html><body style="margin:0;overflow:hidden">
          <canvas style="position:fixed;left:75vw;top:75vh;width:15vw;height:15vh;background:blue"></canvas>
          <output id="hit">waiting</output>
          <script>document.querySelector('canvas').onclick = e => { document.querySelector('output').textContent = e.isTrusted ? 'trusted hit' : 'untrusted'; };</script>
        </body>`);
        });
        const port = await listen(server);
        const page = await extensionSession.context.newPage();
        const url = `http://127.0.0.1:${port}/coordinates`;
        try {
          await page.goto(url);
          const tabId = await extensionSession.sidePanelPage.evaluate(
            async ({ url, zoom }) => {
              const [tab] = await chrome.tabs.query({ url });
              if (tab?.id === undefined) throw new Error('Fixture tab missing');
              await chrome.tabs.setZoom(tab.id, zoom);
              return tab.id;
            },
            { url, zoom },
          );
          const cssViewport = await page.evaluate(() => {
            if (!visualViewport) throw new Error('Visual viewport unavailable');
            return {
              width: visualViewport.width,
              height: visualViewport.height,
            };
          });
          let turn = 0;
          let capture:
            | {
                width: number;
                height: number;
                viewportWidth: number;
                viewportHeight: number;
              }
            | undefined;
          let clickOutput: unknown;
          await extensionSession.context.route(
            'https://chatgpt.com/backend-api/codex/responses',
            async (route) => {
              const output = JSON.parse(
                functionOutputs(route.request().postDataJSON()).at(-1) ?? '{}',
              );
              turn += 1;
              let body: string;
              if (turn === 1)
                body = toolResponse('i', 'ii', 'ic', 'browser_inspect', {
                  tabId: 0,
                  mode: 'interactive',
                  since: '',
                  visualReason: '',
                });
              else if (turn === 2)
                body = toolResponse('s', 'si', 'sc', 'browser_inspect', {
                  tabId: 0,
                  mode: 'screenshot',
                  since: '',
                  visualReason: '',
                });
              else if (turn === 3) {
                expect(output).toMatchObject({
                  ok: true,
                  data: { mode: 'screenshot' },
                });
                capture = output.data;
                if (!capture) throw new Error('Screenshot missing');
                body = toolResponse('c', 'ci', 'cc', 'browser_click_point', {
                  tabId: 0,
                  x: capture.width * 0.825,
                  y: capture.height * 0.825,
                  button: 'left',
                  count: 1,
                });
              } else {
                clickOutput = output;
                body = finalTextResponse('done', 'Coordinates checked.');
              }
              await route.fulfill({
                status: 200,
                contentType: 'text/event-stream',
                body,
              });
            },
          );
          await runFixtureTask(extensionSession, tabId, 'Click the blue visual target.');
          expect(capture?.viewportWidth).toBeCloseTo(cssViewport.width, 1);
          expect(capture?.viewportHeight).toBeCloseTo(cssViewport.height, 1);
          expect(clickOutput).toMatchObject({ ok: true });
          await expect(page.locator('#hit')).toHaveText('trusted hit');
        } finally {
          await page.close();
          await closeHttpFixtureServer(server);
        }
      },
    );
  }
});

extensionTest(
  'moves a synthetic batch by scoped refs, excludes a subtree and verifies each result without screenshots',
  async ({ extensionSession }) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(`<!doctype html><body>
      <nav aria-label="Library"><ul id="source" aria-label="Source" role="tree">
        <li role="treeitem"><button>Alpha</button></li><li role="treeitem"><button>Beta</button></li>
        <li role="treeitem"><button>Excluded</button><ul><li>Keep child</li></ul></li>
      </ul><ul id="destination" aria-label="Destination" role="tree"></ul></nav>
      <main><button>Alpha</button><button>Beta</button></main>
      <div role="menu" hidden><button>Move to</button></div>
      <dialog aria-label="Move document"><button id="target">Destination</button><button id="confirm" disabled>Confirm</button></dialog>
      <output id="completed"></output>
      <script>
        let pending; const done = [];
        document.querySelector('#source').oncontextmenu = e => {
          if (e.target.tagName !== 'BUTTON') return;
          e.preventDefault(); pending = e.target.closest('li'); document.querySelector('[role=menu]').hidden = false;
        };
        document.querySelector('[role=menu] button').onclick = () => {
          document.querySelector('[role=menu]').hidden = true; document.querySelector('#confirm').disabled = true; document.querySelector('dialog').showModal();
        };
        document.querySelector('#target').onclick = () => document.querySelector('#confirm').disabled = false;
        document.querySelector('#confirm').onclick = () => {
          done.push(pending.innerText); document.querySelector('#destination').append(pending); pending = null;
          document.querySelector('dialog').close(); document.querySelector('#completed').textContent = done.join(',');
        };
      </script></body>`);
    });
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}/library`;
    const page = await extensionSession.context.newPage();
    try {
      await page.goto(url);
      const tabId = await extensionSession.sidePanelPage.evaluate(
        async (url) => (await chrome.tabs.query({ url }))[0]?.id,
        url,
      );
      if (tabId === undefined) throw new Error('Fixture tab missing');
      type Entry = {
        n: string;
        r?: string;
        ref?: string;
        c?: [string, string][];
      };
      const entries = new Map<string, Entry>();
      let turn = 0;
      const receipts: unknown[] = [];
      await extensionSession.context.route(
        'https://chatgpt.com/backend-api/codex/responses',
        async (route) => {
          const output = JSON.parse(functionOutputs(route.request().postDataJSON()).at(-1) ?? '{}');
          if (turn > 0) receipts.push(output);
          const data = output.data?.verification ?? output.data;
          if (data?.elements) {
            entries.clear();
            data.elements.forEach((entry: Entry, i: number) =>
              entries.set(entry.ref ?? `passive_${i}`, entry),
            );
          }
          for (const identity of data?.remove ?? []) entries.delete(identity.replace(/^ref:/, ''));
          for (const { k, e } of data?.upsert ?? []) entries.set(e.ref ?? k, e);
          let body: string;
          if (turn === 0)
            body = toolResponse('inspect', 'inspect_i', 'inspect_c', 'browser_inspect', {
              tabId: 0,
              mode: 'interactive_deep',
              since: '',
              visualReason: '',
            });
          else if (turn <= 8) {
            const step = (turn - 1) % 4;
            const name =
              step === 0
                ? turn < 5
                  ? 'Alpha'
                  : 'Beta'
                : ['', 'Move to', 'Destination', 'Confirm'][step];
            const owner = step === 0 ? 'tree' : step === 1 ? 'menu' : 'dialog';
            const entry = [...entries.values()].find(
              (e) =>
                e.ref &&
                e.r === 'button' &&
                e.n === name &&
                e.c?.some(([role, label]) => role === owner && (step !== 0 || label === 'Source')),
            );
            if (!entry?.ref) throw new Error(`Missing scoped ${owner} control: ${name}`);
            body = toolResponse(`r${turn}`, `i${turn}`, `c${turn}`, 'browser_click', {
              tabId: 0,
              ref: entry.ref,
              button: step === 0 ? 'right' : 'left',
              count: 1,
            });
          } else body = finalTextResponse('done', 'Batch checked.');
          turn += 1;
          await route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body,
          });
        },
      );
      await runFixtureTask(
        extensionSession,
        tabId,
        'Move Alpha and Beta from Source to Destination, leaving Excluded and its child unchanged.',
      );
      expect(turn).toBe(10);
      expect(receipts.every((receipt) => (receipt as { ok: boolean }).ok)).toBe(true);
      await expect(page.locator('#source > li')).toHaveCount(1);
      await expect(page.locator('#source')).toHaveText('ExcludedKeep child');
      await expect(page.locator('#destination > li')).toHaveText(['Alpha', 'Beta']);
      await expect(page.locator('#completed')).toHaveText('Alpha,Beta');
      await expect(page.locator('dialog')).not.toBeVisible();
    } finally {
      await page.close();
      await closeHttpFixtureServer(server);
    }
  },
);

extensionTest(
  'expands and collapses an unnamed icon control without opening its neighboring document',
  async ({ extensionSession }) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(`<!doctype html><style>
        #row {display:flex;width:280px;height:36px;align-items:center;cursor:pointer}
        #arrow {display:flex;width:20px;height:20px;align-items:center;justify-content:center}
        #arrow [role=button] {width:10px;height:10px;cursor:pointer;background:#999}
        #title {width:240px;height:36px}
      </style><nav aria-label="Library"><div id="row">
        <span id="arrow" class="branch-expand-arrow"><span role="button"></span></span>
        <div id="title" role="button">Archive</div>
      </div><ul hidden><li>Child document</li></ul></nav><output>waiting</output><script>
        let opens = 0;
        document.querySelector('#row').onclick = () => { opens++; };
        document.querySelector('#arrow').onclick = e => {
          e.stopPropagation(); const list = document.querySelector('ul'); list.hidden = !list.hidden;
          document.querySelector('#arrow').className = list.hidden ? 'branch-expand-arrow' : 'branch-collapse-arrow';
          document.querySelector('output').textContent = (list.hidden ? 'collapsed' : 'expanded') + ':' + opens;
        };
      </script>`);
    });
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}/unnamed-toggle`;
    const page = await extensionSession.context.newPage();
    try {
      await page.goto(url);
      const tabId = await extensionSession.sidePanelPage.evaluate(
        async (url) => (await chrome.tabs.query({ url }))[0]?.id,
        url,
      );
      if (tabId === undefined) throw new Error('Fixture tab missing');
      let turn = 0;
      await extensionSession.context.route(
        'https://chatgpt.com/backend-api/codex/responses',
        async (route) => {
          const output = JSON.parse(functionOutputs(route.request().postDataJSON()).at(-1) ?? '{}');
          if (turn > 0) expect(output.ok).toBe(true);
          let body: string;
          if (turn === 0 || turn === 2) {
            if (turn === 2) await expect(page.locator('output')).toHaveText('expanded:0');
            body = toolResponse(`r${turn}`, `i${turn}`, `c${turn}`, 'browser_inspect', {
              tabId: 0,
              mode: 'interactive',
              since: '',
              visualReason: '',
            });
          } else if (turn === 1 || turn === 3) {
            const name = turn === 1 ? 'Branch expand arrow' : 'Branch collapse arrow';
            const button = output.data.elements.find(
              (e: { n: string; r?: string; ref?: string }) =>
                e.n === name && e.r === 'button' && e.ref,
            );
            if (!button?.ref) throw new Error(`Missing icon control: ${name}`);
            body = toolResponse(`r${turn}`, `i${turn}`, `c${turn}`, 'browser_click', {
              tabId: 0,
              ref: button.ref,
              button: 'left',
              count: 1,
            });
          } else
            body = finalTextResponse('done', 'Expanded and collapsed without opening a document.');
          turn += 1;
          await route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body,
          });
        },
      );
      await runFixtureTask(
        extensionSession,
        tabId,
        'Expand Archive, then collapse it without opening it.',
      );
      expect(turn).toBe(5);
      await expect(page.locator('output')).toHaveText('collapsed:0');
      await expect(page.locator('ul')).toBeHidden();
    } finally {
      await page.close();
      await closeHttpFixtureServer(server);
    }
  },
);

extensionTest(
  "joins flat-list structure to fresh refs and avoids a row's independent menu button",
  async ({ extensionSession }) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><style>
      [role=list] {width:300px;height:240px;overflow:auto}
      [role=item] {height:80px}
      [role=button] {position:relative;width:280px;height:60px;background:#eee}
      .more-button {position:absolute;left:90px;width:100px;height:60px;top:0}
    </style><nav aria-label="Library"><div role="list" aria-label="Documents">
      <div role="item" data-depth="1"><button aria-expanded="true">Excluded</button></div>
      <div role="item" data-depth="2"><div role="button" tabindex="0" aria-label="Report" data-key="child">Report<button class="more-button" data-action="child">⋯</button></div></div>
      <div role="item" data-depth="1"><div role="button" tabindex="0" aria-label="Report" data-key="root">Report<button class="more-button" data-action="root">⋯</button></div></div>
    </div></nav><output></output><script>
      document.addEventListener('click', e => {
        const menu=e.target.closest('[data-action]');
        const row=e.target.closest('[data-key]');
        document.querySelector('output').textContent = menu ? 'Menu '+menu.dataset.action : row ? 'Opened '+row.dataset.key : '';
      });
    </script>`);
    });
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}/flat-list`;
    const page = await extensionSession.context.newPage();
    try {
      await page.goto(url);
      const tabId = await extensionSession.sidePanelPage.evaluate(
        async (url) => (await chrome.tabs.query({ url }))[0]?.id,
        url,
      );
      if (tabId === undefined) throw new Error('Fixture tab missing');
      let turn = 0;
      await extensionSession.context.route(
        'https://chatgpt.com/backend-api/codex/responses',
        async (route) => {
          const output = JSON.parse(functionOutputs(route.request().postDataJSON()).at(-1) ?? '{}');
          let body: string;
          if (turn === 0)
            body = toolResponse('r0', 'i0', 'c0', 'browser_inspect', {
              tabId: 0,
              mode: 'interactive',
              since: '',
              ref: '',
              visualReason: '',
            });
          else if (turn === 1) {
            const report = output.data.elements.find(
              (e: { n: string; r?: string; ref?: string }) =>
                e.r === 'button' && e.n.startsWith('Report') && e.ref,
            );
            expect(report).toBeDefined();
            body = toolResponse('r1', 'i1', 'c1', 'browser_inspect', {
              tabId: 0,
              mode: 'interactive_deep',
              since: '',
              ref: report.ref,
              visualReason: '',
            });
          } else if (turn === 2) {
            expect(output.ok).toBe(true);
            expect(output.data.coverage).toBeUndefined();
            const nodes = output.data.scope.nodes as {
              name: string;
              ref?: string;
              parent?: number;
              attributes: Record<string, string>;
            }[];
            const reports = nodes.filter((n) => n.name === 'Report' && n.ref);
            expect(reports).toHaveLength(2);
            const root = reports.find(
              (n) => n.parent !== undefined && nodes[n.parent]?.attributes['data-depth'] === '1',
            );
            if (!root?.ref) throw new Error('Scoped evidence must identify the root document.');
            body = toolResponse('r2', 'i2', 'c2', 'browser_click', {
              tabId: 0,
              ref: root.ref,
              button: 'left',
              count: 1,
            });
          } else {
            expect(output.ok).toBe(true);
            body = finalTextResponse('done', 'Opened only the root document.');
          }
          turn += 1;
          await route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body,
          });
        },
      );
      await runFixtureTask(
        extensionSession,
        tabId,
        'Open the root Report, not the excluded child or its menu.',
      );
      expect(turn).toBe(4);
      await expect(page.locator('output')).toHaveText('Opened root');
    } finally {
      await page.close();
      await closeHttpFixtureServer(server);
    }
  },
);

for (const delegated of [false, true]) {
  extensionTest(
    `scrolls an embedded document with ${delegated ? 'parent-controlled' : 'independent'} wheel handling`,
    async ({ extensionSession }) => {
      const fixtureServer = createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html><html><body style="margin:0;overflow:hidden">
          <main id="outer" aria-label="Outer course"
            style="height:480px;width:600px;overflow:auto">
            <div style="height:1800px;padding-top:40px">
              <section id="inner" aria-label="Embedded document" role="region"
                style="height:300px;width:550px;overflow:auto">
                <div style="height:1200px">Embedded document content</div>
              </section>
            </div>
          </main>
          <script>
            const outer = document.querySelector('#outer');
            const inner = document.querySelector('#inner');
            inner.scrollTop = 100;
            inner.addEventListener('wheel', event => {
              inner.dataset.trustedWheel = String(event.isTrusted);
              if (${String(delegated)}) {
                event.preventDefault();
                // The host owns paging; DOM writes to the child do not advance it.
                outer.scrollTop += Math.sign(event.deltaY) * 200;
                inner.scrollTop = outer.scrollTop / 2;
              }
            }, { passive: false });
          </script>
        </body></html>`);
      });
      const port = await listen(fixtureServer);
      const fixtureUrl = `http://127.0.0.1:${String(port)}/embedded`;
      const page = await extensionSession.context.newPage();
      await page.goto(fixtureUrl);
      let turn = 0;
      let scrollOutput: unknown;
      await extensionSession.context.route(
        'https://chatgpt.com/backend-api/codex/responses',
        async (route) => {
          const outputs = functionOutputs(route.request().postDataJSON());
          turn += 1;
          let body: string;
          if (turn === 1) {
            body = toolResponse('inspect', 'inspect_item', 'inspect_call', 'browser_inspect', {
              tabId: 0,
              mode: 'interactive',
              since: '',
            });
          } else if (turn === 2) {
            const observation = JSON.parse(outputs.at(-1) ?? '{}') as {
              data?: { elements?: { ref: string; n: string }[] };
            };
            const ref = observation.data?.elements?.find(
              (item) => item.n === 'Embedded document' && typeof item.ref === 'string',
            )?.ref;
            if (!ref) throw new Error('Embedded scroll target unavailable.');
            body = toolResponse('scroll', 'scroll_item', 'scroll_call', 'browser_scroll', {
              tabId: 0,
              target: ref,
              deltaX: 0,
              deltaY: 200,
              maxSegments: 1,
              stopText: '',
            });
          } else {
            scrollOutput = JSON.parse(outputs.at(-1) ?? '{}');
            body = finalTextResponse('done', 'Scroll checked.');
          }
          await route.fulfill({
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
            body,
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
          requestId: 'scroll_settings',
          type: 'settings.save',
          payload: {
            reasoningEffort: 'low',
            systemPrompt: 'Use browser tools.',
            language: 'en',
            historyMessageLimit: 50,
            codexAccessToken: syntheticAccessToken(),
          },
        });
        const submitted = await sendExtensionMessage<{ task: { id: string } }>(
          extensionSession.sidePanelPage,
          {
            version: 1,
            requestId: 'scroll_submit',
            type: 'chat.submit',
            payload: {
              tabId,
              text: 'Scroll the embedded document down by 200 pixels.',
              attachmentIds: [],
            },
          },
        );
        await expect
          .poll(
            async () => {
              const snapshot = await sendExtensionMessage<{
                task: { status: string };
              }>(extensionSession.sidePanelPage, {
                version: 1,
                requestId: `scroll_snapshot_${String(Date.now())}`,
                type: 'task.getSnapshot',
                payload: { taskId: submitted.task.id },
              });
              return snapshot.task.status;
            },
            { timeout: 30_000 },
          )
          .toBe('completed');
        expect(scrollOutput).toMatchObject({
          ok: true,
          data: { moved: true, actualDeltaY: 200, boundaryVerified: false },
        });
        await expect(page.locator('#inner')).toHaveAttribute('data-trusted-wheel', 'true');
        await expect(page.locator('#outer')).toHaveJSProperty('scrollTop', delegated ? 200 : 0);
        await expect(page.locator('#inner')).toHaveJSProperty('scrollTop', delegated ? 100 : 300);
      } finally {
        await page.close();
        await closeHttpFixtureServer(fixtureServer);
      }
    },
  );
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
            readonly data?: {
              readonly elements?: readonly Record<string, unknown>[];
            };
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
      const submitted = await sendExtensionMessage<{
        readonly task: { readonly id: string };
      }>(extensionSession.sidePanelPage, {
        version: 1,
        requestId: 'e2e_submit',
        type: 'chat.submit',
        payload: {
          tabId,
          text: 'Select the first answer on this page.',
          attachmentIds: [],
        },
      });

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

      await extensionSession.sidePanelPage.setViewportSize({
        width: 320,
        height: 900,
      });
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
      await closeHttpFixtureServer(fixtureServer);
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
              {
                tabId: 0,
                ref: composerRef,
                text: 'Hello Alex',
                replace: true,
                submit: true,
              },
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
      const submitted = await sendExtensionMessage<{
        readonly task: { readonly id: string };
      }>(extensionSession.sidePanelPage, {
        version: 1,
        requestId: 'messenger_e2e_submit',
        type: 'chat.submit',
        payload: {
          tabId,
          text: 'Find Alex, review older messages, and send one greeting.',
          attachmentIds: [],
        },
      });

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
      await closeHttpFixtureServer(fixtureServer);
    }
  },
);
