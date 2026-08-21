import type { LiveScenario } from './live-types';

const LARK_MESSENGER_READ = Object.freeze<LiveScenario>({
  name: 'lark-messenger-read',
  description: 'Reads five distinct Feishu group chats and summarizes the last 24 hours.',
  startUrl: 'https://bytedance.larkoffice.com/next/messenger',
  expectedOrigin: 'https://bytedance.larkoffice.com',
  taskText:
    '只使用结构化浏览器工具，不要请求或使用截图、坐标点击、图片附件或任何网络抓包。请从最近会话中选择并打开 5 个不同的真实群聊；排除单聊、机器人和重复会话。每个群聊都要先从会话标题或群聊信息确认名称，再读取最近 24 小时内实际可见的消息；必要时在消息区域向上滚动，直到覆盖 24 小时边界或确认该时段没有消息。不要发送消息、不要修改任何页面数据，也不要虚构未读到的内容。完成 5 个群聊后，用一个标准 Markdown 表格回复，必须恰好包含 5 个不同群聊的数据行。必须使用 ASCII 竖线 | 分隔每一列，禁止使用全角 ｜；表头必须是“| 群聊 | 最近24小时内容 | 时间依据 |”，下一行必须是“| --- | --- | --- |”。内容摘要需忠实反映实际读取到的消息，时间依据写明看到的最近时间范围或“最近24小时无消息”。如果无法完成任一群聊，立即说明具体阻塞点，不要用猜测补足表格。',
  readinessTimeoutMs: 30_000,
  taskTimeoutMs: 420_000,
  maxToolCalls: 100,
  requiredTools: Object.freeze(['browser_inspect']),
  forbiddenTools: Object.freeze([
    'browser_click_point',
    'browser_drag_point',
    'browser_network_start',
    'browser_network_list',
    'browser_network_get',
    'browser_network_stop',
    'tavily_search',
    'tavily_extract',
    'tavily_crawl',
  ]),
  forbidScreenshotInspect: true,
  forbidSubmittedType: true,
  finalTextIncludes: Object.freeze(['群聊', '最近24小时']),
  minFinalTextLength: 160,
  minimumMarkdownTableRows: 5,
  allowRemoteMutation: false,
});

const LARK_SELF_SEND = Object.freeze<LiveScenario>({
  name: 'lark-self-send',
  description: 'Searches the authenticated user and sends one uniquely identifiable self-message.',
  startUrl: 'https://bytedance.larkoffice.com/next/messenger',
  expectedOrigin: 'https://bytedance.larkoffice.com',
  taskText:
    '只使用结构化浏览器工具，不要请求或使用截图、坐标点击、图片附件或网络抓包。搜索精确用户 caoyang.001，确认打开的是该用户的私聊后，向自己发送且只发送一次以下完整消息：ChatBrowserX live self-check {{RUN_ID}}。搜索框输入必须使用 submit=false。目标私聊和消息输入框确认无误后，必须用一次 browser_type 调用同时写入并提交完整消息（replace=true、submit=true），不要先写草稿或另发 Enter。该工具会先验证写入再提交；若它失败，不要重复发送。发送成功后必须重新检查页面，确认该完整消息在当前会话可见且输入框已清空。若写入、提交或回读失败，立即说明失败阶段和阻塞点。最终回复必须逐字包含完整消息和验证结果。',
  readinessTimeoutMs: 30_000,
  taskTimeoutMs: 180_000,
  maxToolCalls: 30,
  requiredTools: Object.freeze(['browser_inspect', 'browser_type']),
  forbiddenTools: Object.freeze([
    'browser_click_point',
    'browser_drag_point',
    'browser_network_start',
    'browser_network_list',
    'browser_network_get',
    'browser_network_stop',
    'tavily_search',
    'tavily_extract',
    'tavily_crawl',
  ]),
  forbidScreenshotInspect: true,
  forbidSubmittedType: false,
  expectedSubmittedTypeCount: 1,
  requiredVerifiedTools: Object.freeze(['browser_type']),
  requiredTypedTextIncludes: Object.freeze(['ChatBrowserX live self-check {{RUN_ID}}']),
  requiredToolOutputIncludes: Object.freeze(['ChatBrowserX live self-check {{RUN_ID}}']),
  finalTextIncludes: Object.freeze(['ChatBrowserX live self-check {{RUN_ID}}']),
  minFinalTextLength: 50,
  allowRemoteMutation: true,
});

const LARK_SELF_SEND_SCREENSHOT = Object.freeze<LiveScenario>({
  name: 'lark-self-send-screenshot',
  description: 'Captures one browser viewport and sends it through Feishu Web to the user.',
  startUrl: 'https://bytedance.larkoffice.com/next/messenger',
  expectedOrigin: 'https://bytedance.larkoffice.com',
  taskText:
    '只使用结构化浏览器工具，不要使用截图模式检查、坐标操作或网络抓包。搜索精确用户 caoyang.001，并确认打开的是该用户的私聊。找到当前私聊的消息编辑框后，调用且只调用一次 browser_capture_screenshot 截取当前网页视窗；使用其返回的 assetId 调用且只调用一次 browser_paste_image，把图片粘贴到已确认的消息编辑框。browser_paste_image 返回 verified=true 表示工具已在本地确认编辑器消费了图片且待发送区发生了附件预览变化；此时即使后续无障碍树增量为 unchanged 也要继续，绝不能再次粘贴。若 verified 不为 true 则立即停止。在同一个编辑框追加完整文字 ChatBrowserX screenshot self-check {{RUN_ID}}，并用一次 browser_type（replace=false、submit=true）将图片和该文字一起发送；不要单独发送图片或文字，也不要重复发送。发送后重新检查页面，确认该完整文字作为新消息可见且编辑框已清空；图片已发送以粘贴工具 verified=true、提交成功和待发送区清空三项为证据。任何粘贴、发送或回读步骤失败时立即停止并说明阻塞点。最终回复必须逐字包含 ChatBrowserX screenshot self-check {{RUN_ID}}，并说明图片与文字均已发送和回读验证。',
  readinessTimeoutMs: 30_000,
  taskTimeoutMs: 240_000,
  maxToolCalls: 45,
  requiredTools: Object.freeze([
    'browser_inspect',
    'browser_capture_screenshot',
    'browser_paste_image',
    'browser_type',
  ]),
  forbiddenTools: Object.freeze([
    'browser_click_point',
    'browser_drag_point',
    'browser_network_start',
    'browser_network_list',
    'browser_network_get',
    'browser_network_stop',
    'tavily_search',
    'tavily_extract',
    'tavily_crawl',
  ]),
  forbidScreenshotInspect: true,
  forbidSubmittedType: false,
  expectedSubmittedTypeCount: 1,
  expectedToolCounts: Object.freeze({
    browser_capture_screenshot: 1,
    browser_paste_image: 1,
  }),
  requiredVerifiedTools: Object.freeze(['browser_paste_image', 'browser_type']),
  maxAttachmentCount: 1,
  requiredTypedTextIncludes: Object.freeze(['ChatBrowserX screenshot self-check {{RUN_ID}}']),
  requiredToolOutputIncludes: Object.freeze(['ChatBrowserX screenshot self-check {{RUN_ID}}']),
  finalTextIncludes: Object.freeze(['ChatBrowserX screenshot self-check {{RUN_ID}}', '图片']),
  minFinalTextLength: 80,
  allowRemoteMutation: true,
});

const LARK_FIVE_GROUPS_SUMMARY_SCREENSHOT_SEND = Object.freeze<LiveScenario>({
  name: 'lark-five-groups-summary-screenshot-send',
  description:
    'Reads five recent Feishu groups, sends the summary to self, then sends a screenshot of it.',
  startUrl: 'https://bytedance.larkoffice.com/next/messenger',
  expectedOrigin: 'https://bytedance.larkoffice.com',
  taskText:
    '只使用结构化浏览器工具，不要使用截图模式检查、坐标操作或任何网络抓包。先从最近会话中选择并打开 5 个不同的真实群聊；排除单聊、机器人和重复会话。每个群聊都要从会话标题或群聊信息确认名称，并忠实概括当前实际可见的最近消息；不要虚构未读到的内容。整理成一个简洁的标准 Markdown 表格，表头必须是“| 群聊 | 最近内容 |”，下一行必须是“| --- | --- |”，并且恰好包含 5 个不同群聊的数据行。随后搜索精确用户 caoyang.001，确认打开的是该用户的私聊。向该私聊发送且只发送一次完整文本“ChatBrowserX 五群摘要 {{RUN_ID}}”加上述完整表格；搜索框输入必须 submit=false，摘要必须用一次 browser_type（replace=true、submit=true）写入并提交。提交后重新检查页面，确认唯一标记和五个群名均在当前会话可见且编辑框已清空。确认摘要消息在当前视窗可见后，调用且只调用一次 browser_capture_screenshot 截取当前飞书网页视窗；再使用返回的 assetId 调用且只调用一次 browser_paste_image，将图片粘贴到同一个已确认的消息编辑框。browser_paste_image 必须返回 verified=true；成功后绝不能重复粘贴。然后在同一编辑框追加且只追加文字“ChatBrowserX 五群摘要截图 {{RUN_ID}}”，用一次 browser_type（replace=false、submit=true）将图片和文字一起发送。最后重新检查页面，确认截图标记作为新消息可见、编辑框已清空；图片已发送以粘贴 verified=true、提交成功和待发送区清空三项为证据。任何读取、首次发送、截图、粘贴、第二次发送或回读失败时立即停止并说明阻塞点。最终回复必须重复同一个 5 行摘要表格，并逐字包含“ChatBrowserX 五群摘要截图 {{RUN_ID}}”以及图片发送验证结果。',
  readinessTimeoutMs: 30_000,
  taskTimeoutMs: 540_000,
  maxToolCalls: 100,
  requiredTools: Object.freeze([
    'browser_inspect',
    'browser_capture_screenshot',
    'browser_paste_image',
    'browser_type',
  ]),
  forbiddenTools: Object.freeze([
    'browser_click_point',
    'browser_drag_point',
    'browser_network_start',
    'browser_network_list',
    'browser_network_get',
    'browser_network_stop',
    'tavily_search',
    'tavily_extract',
    'tavily_crawl',
  ]),
  forbidScreenshotInspect: true,
  forbidSubmittedType: false,
  expectedSubmittedTypeCount: 2,
  expectedToolCounts: Object.freeze({
    browser_capture_screenshot: 1,
    browser_paste_image: 1,
  }),
  requiredVerifiedTools: Object.freeze(['browser_paste_image', 'browser_type']),
  maxAttachmentCount: 1,
  requiredTypedTextIncludes: Object.freeze([
    'ChatBrowserX 五群摘要 {{RUN_ID}}',
    '| 群聊 | 最近内容 |',
    'ChatBrowserX 五群摘要截图 {{RUN_ID}}',
  ]),
  requiredToolOutputIncludes: Object.freeze([
    'ChatBrowserX 五群摘要 {{RUN_ID}}',
    'ChatBrowserX 五群摘要截图 {{RUN_ID}}',
  ]),
  finalTextIncludes: Object.freeze(['ChatBrowserX 五群摘要截图 {{RUN_ID}}', '群聊', '图片']),
  minFinalTextLength: 200,
  minimumMarkdownTableRows: 5,
  allowRemoteMutation: true,
});

const LIVE_SCENARIOS = Object.freeze([
  LARK_MESSENGER_READ,
  LARK_SELF_SEND,
  LARK_SELF_SEND_SCREENSHOT,
  LARK_FIVE_GROUPS_SUMMARY_SCREENSHOT_SEND,
]);

/** Returns the immutable registry used by the opt-in live runner. */
export function listLiveScenarios(): readonly LiveScenario[] {
  return LIVE_SCENARIOS;
}

/** Normalizes the optional separator forwarded by pnpm before validating one scenario name. */
export function parseLiveScenarioName(arguments_: readonly string[]): string {
  const normalized = arguments_[0] === '--' ? arguments_.slice(1) : [...arguments_];
  const name = normalized[0]?.trim();
  if (normalized.length !== 1 || name === undefined || name.length === 0) {
    throw new Error(
      `Usage: pnpm e2e:live:run -- <scenario>. Available: ${LIVE_SCENARIOS.map(({ name: candidate }) => candidate).join(', ')}.`,
    );
  }
  return name;
}

/** Resolves only code-owned scenarios so arbitrary prompts cannot enter the live runner. */
export function getLiveScenario(name: string): LiveScenario {
  const scenario = LIVE_SCENARIOS.find((candidate) => candidate.name === name.trim());
  if (scenario === undefined) {
    throw new Error(
      `Unknown live E2E scenario "${name}". Available: ${LIVE_SCENARIOS.map(({ name: candidate }) => candidate).join(', ')}.`,
    );
  }
  return scenario;
}

/** Keeps the initial command incapable of running any declared remote mutation. */
export function validateReadOnlyScenario(scenario: LiveScenario): void {
  if (scenario.allowRemoteMutation) {
    throw new Error(`Live E2E scenario "${scenario.name}" is not read-only.`);
  }
}

/** Requires an explicit process-local opt-in before a code-owned live scenario may mutate data. */
export function validateLiveScenarioAuthorization(
  scenario: LiveScenario,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  if (scenario.allowRemoteMutation && environment.CHATBROWSERX_LIVE_ALLOW_MUTATION !== '1') {
    throw new Error(
      `Live E2E scenario "${scenario.name}" mutates remote data and requires explicit opt-in via CHATBROWSERX_LIVE_ALLOW_MUTATION=1.`,
    );
  }
}
