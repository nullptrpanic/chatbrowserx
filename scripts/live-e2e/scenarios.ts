import type { LiveScenario } from './live-types';

const LARK_MESSENGER_READ = Object.freeze<LiveScenario>({
  name: 'lark-messenger-read',
  description: 'Reads five distinct Feishu group chats and summarizes the last 24 hours.',
  startUrl: 'https://bytedance.larkoffice.com/next/messenger',
  expectedOrigin: 'https://bytedance.larkoffice.com',
  taskText:
    '只使用结构化浏览器工具，不要请求或使用截图、坐标点击、图片附件或任何网络抓包。请从最近会话中选择并打开 5 个不同的真实群聊；排除单聊、机器人和重复会话。每个群聊都要先从会话标题或群聊信息确认名称，再读取最近 24 小时内实际可见的消息；必要时在消息区域向上滚动，直到覆盖 24 小时边界或确认该时段没有消息。不要发送消息、不要修改任何页面数据，也不要虚构未读到的内容。完成 5 个群聊后，用一个 Markdown 表格回复，必须恰好包含 5 个不同群聊的数据行，列为“群聊｜最近24小时内容｜时间依据”；内容摘要需忠实反映实际读取到的消息，时间依据写明看到的最近时间范围或“最近24小时无消息”。如果无法完成任一群聊，立即说明具体阻塞点，不要用猜测补足表格。',
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
  requiredTypedTextIncludes: Object.freeze(['ChatBrowserX live self-check {{RUN_ID}}']),
  requiredToolOutputIncludes: Object.freeze(['ChatBrowserX live self-check {{RUN_ID}}']),
  finalTextIncludes: Object.freeze(['ChatBrowserX live self-check {{RUN_ID}}']),
  minFinalTextLength: 50,
  allowRemoteMutation: true,
});

const LIVE_SCENARIOS = Object.freeze([LARK_MESSENGER_READ, LARK_SELF_SEND]);

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
