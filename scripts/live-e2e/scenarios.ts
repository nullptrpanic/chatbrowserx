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

const LARK_MESSENGER_AUGUST_HISTORY = Object.freeze<LiveScenario>({
  name: 'lark-messenger-august-history',
  description:
    'Reads one Feishu group through the complete visible August history and verifies the traversal boundary.',
  startUrl: 'https://bytedance.larkoffice.com/next/messenger',
  expectedOrigin: 'https://bytedance.larkoffice.com',
  taskText:
    '只使用结构化浏览器工具，不要请求或使用截图、坐标操作、图片附件或任何网络抓包。搜索并打开名称匹配“豆包*飞书C360管”的真实群聊，先从会话标题或群聊信息确认目标。读取当前账号可见的 2026 年 8 月完整聊天内容并做忠实总结。必须滚动群聊的消息历史容器，不得滚动整页或侧边会话列表；从最新 interactive 检查中找到明确 advertises scroll 的消息历史 ref 后，必须使用 browser_scroll 沿负 deltaY 分段读取，并设置 maxSegments>1；stopText 只作为发现 8 月以前日期文本的候选停止标记，不得退化成连续多次 maxSegments=1 的调用。每次 browser_scroll 返回后，先按顺序读取 observations，它们就是每个已执行分段新暴露的页面状态；stopReason=text_seen 只表示看到了候选文本，必须从 observations 确认它确实是 8 月前日期；continuationRequired=true 时根据 stopReason 和最新证据继续结构化检查或再次调用 browser_scroll，不能直接结束。去重保留消息和日期证据。只有满足以下任一覆盖条件才允许结束：返回的观察证据已经出现 2026 年 8 月 1 日之前的消息；或者同方向边界探测明确返回 boundaryVerified=true，且同次返回的观察证据确认没有加载出更早内容。仅看到 8 月 1 日当天、滚动位置为 0、内容 unchanged、stopReason=text_seen 或模型主观认为到顶，都不能单独证明覆盖完整。如果真实边界晚于 8 月 1 日，必须如实写明当前账号可见的最早时间和边界证据，不得虚构缺失内容。不要发送消息、不要修改任何远端数据。最终回复必须包含群名、实际读取到的 8 月时间范围、内容总结，并用“覆盖边界：”明确写出看到的 8 月前日期或 boundaryVerified=true 的工具证据。任何一步无法验证时立即说明唯一阻塞点，不要声称已完成。',
  readinessTimeoutMs: 30_000,
  taskTimeoutMs: 480_000,
  maxToolCalls: 120,
  requiredTools: Object.freeze(['browser_inspect', 'browser_scroll']),
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
  finalTextIncludes: Object.freeze(['豆包*飞书C360管', '8 月', '覆盖边界']),
  finalTextExcludes: Object.freeze([
    '唯一阻塞点',
    '无法验证',
    '未能验证',
    '未完成',
    'blocked',
    'could not verify',
    'unable to verify',
    'not verified',
  ]),
  minFinalTextLength: 120,
  allowRemoteMutation: false,
});

const LARK_MESSENGER_MULTI_GROUP_SCROLL = Object.freeze<LiveScenario>({
  name: 'lark-messenger-multi-group-scroll',
  description:
    'Verifies structured backward history scrolling in three distinct Feishu group chats.',
  startUrl: 'https://bytedance.larkoffice.com/next/messenger',
  expectedOrigin: 'https://bytedance.larkoffice.com',
  taskText:
    '只使用结构化浏览器工具，不要请求或使用截图、坐标操作、图片附件或任何网络抓包。请从最近会话中选择并依次打开 3 个不同的真实群聊，排除单聊、机器人和重复会话。每个群聊都必须从会话标题或群聊信息确认名称，并完成一次独立的历史滚动验证：先检查当前消息区，记录最早可见消息的日期或时间作为起点；从最新检查结果中找到当前群聊消息历史容器的可滚动 ref；每个群聊至少调用一次 browser_scroll，target 必须是该消息历史容器，deltaY 必须为明显向上的负值；滚动后先按顺序读取工具结果中的 verification 或 observations，它们就是新状态，只有 verificationUnavailable=true 或 continuationFailure 存在时才额外调用 browser_inspect。只有这些观察证据出现比起点严格更早的真实消息，或同方向探测返回 boundaryVerified=true 且同次观察证据没有加载出更早内容，才算该群验证成功。滚动整页、滚动侧边会话列表、仅看到位置为 0、仅看到 unchanged、复用上一个群的旧 ref 或模型主观认为到顶，都不算成功。完成一个群后记录证据，再从会话列表选择下一个不同群聊并使用新检查得到的 ref。不要发送消息，也不要修改任何远端数据。如果任一群无法获得上述证据，立即说明该群和唯一阻塞点，不要继续凑数。最终用标准 Markdown 表格回复，表头必须是“| 群聊 | 滚动前最早可见时间 | 滚动后最早可见时间 | 工具证据 |”，下一行必须是“| --- | --- | --- | --- |”，并且恰好包含 3 个不同群聊的数据行。',
  readinessTimeoutMs: 30_000,
  taskTimeoutMs: 480_000,
  maxToolCalls: 100,
  requiredTools: Object.freeze(['browser_inspect', 'browser_click', 'browser_scroll']),
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
  finalTextIncludes: Object.freeze(['群聊', '滚动前最早可见时间', '滚动后最早可见时间']),
  finalTextExcludes: Object.freeze([
    '唯一阻塞点',
    '无法验证',
    '未能验证',
    '未完成',
    'blocked',
    'could not verify',
    'unable to verify',
    'not verified',
  ]),
  minFinalTextLength: 160,
  minimumMarkdownTableRows: 3,
  allowRemoteMutation: false,
});

const LARK_DOC_NAMED_SECTION = Object.freeze<LiveScenario>({
  name: 'lark-doc-named-section',
  description: 'Reads one named Feishu document section with incremental best-effort traversal.',
  startUrl: 'https://bytedance.larkoffice.com/docx/XQmodBxg9oqiQKxq31OcuRMGnBg',
  expectedOrigin: 'https://bytedance.larkoffice.com',
  taskText: '完整阅读并总结“关键问题”章节。',
  readinessTimeoutMs: 30_000,
  taskTimeoutMs: 180_000,
  maxToolCalls: 12,
  requiredTools: Object.freeze(['browser_inspect', 'browser_click', 'browser_scroll']),
  forbiddenTools: Object.freeze([
    'browser_capture_screenshot',
    'browser_paste_image',
    'browser_type',
    'browser_keypress',
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
  expectedToolCounts: Object.freeze({ browser_click: 1 }),
  maxScrollSegmentsPerCall: 1,
  finalTextIncludes: Object.freeze([
    '关键问题',
    '切点过于下沉',
    '31 个租户',
    '消费端',
    'AuthZ',
    '渲染类接口',
    'Local Cache',
    'LogID',
    '拦截有效性',
    '预热',
  ]),
  forbiddenActiveElementNamesAfterScroll: Object.freeze(['Bad Case', 'Ref（进行中）']),
  requireFreshProviderContext: true,
  finalTextExcludes: Object.freeze([
    '唯一阻塞点',
    '无法确认',
    '未能确认',
    '未完成',
    'blocked',
    'could not verify',
    'unable to verify',
    'not verified',
  ]),
  minFinalTextLength: 500,
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

const LARK_CALENDAR_MAIL_SCREENSHOT = Object.freeze<LiveScenario>({
  name: 'lark-calendar-mail-screenshot',
  description:
    'Creates one standalone Feishu event, captures its verified detail, and emails the screenshot to self.',
  startUrl: 'https://bytedance.larkoffice.com/next/messenger',
  expectedOrigin: 'https://bytedance.larkoffice.com',
  taskText:
    '只通过当前 ChatBrowserX 提供的浏览器工具操作飞书网页；禁止网络抓包、飞书 API、CLI 或其他连接器。先从当前飞书页面进入日历；如果页面在新标签页打开，只使用浏览器标签页工具跟踪新页面。必须先用 interactive 检查，并优先使用可操作 ref；如果没有暴露“新建日程”或空白时间格的可操作 ref，再用 interactive_deep 完整检查一次。只要任一次结构化检查提供所需 ref，就必须用 browser_click。日历创建全程禁止截图模式检查和坐标操作；如果 interactive_deep 仍没有所需可操作 ref，立即停止并说明该唯一阻塞点。创建且只创建一个独立日程：日期为今天 2026-08-21，开始时间 16:00，结束时间 16:30，标题必须恰好为 test，不添加任何参与人，描述必须完整填写 ChatBrowserX calendar self-check {{RUN_ID}}。保存动作只允许执行一次；如果结果不明确，先检查页面，绝不能再次保存。保存后重新检查日历页面，打开刚创建的日程详情并确认标题、日期、起止时间、无参与人以及完整描述均可见；任一字段不符就立即停止。保持已验证的日程详情在当前网页视窗内，调用且只调用一次 browser_capture_screenshot，保留返回的 assetId，不要把该截图用于模型视觉检查。随后通过飞书页面进入邮箱并新建邮件；收件人必须确认是 caoyang.001 对应的当前登录用户本人，主题必须恰好为 test，正文必须完整包含 ChatBrowserX mail self-check {{RUN_ID}}。找到邮件正文编辑器后，使用刚才的 assetId 调用且只调用一次 browser_paste_image；只有返回 ok=true 且 verified=true 才能继续，成功后绝不能再次粘贴。重新检查写信页面，确认收件人、主题、正文标记和一张待发送图片均存在，然后点击发送且只发送一次；不要用 browser_type 的 submit=true 发送邮件。如果发送结果不明确，只检查已发送列表，绝不能再次发送。最后打开“已发送”，找到本次邮件并确认收件人是自己、主题为 test、完整正文标记可见且邮件中存在图片。任何创建、回读、截图、粘贴、发送或已发送回读失败时立即停止并说明唯一阻塞点。最终回复必须逐字包含 ChatBrowserX calendar self-check {{RUN_ID}} 和 ChatBrowserX mail self-check {{RUN_ID}}，并明确列出已回读验证的日程时间、无参与人、收件人、主题和图片。',
  readinessTimeoutMs: 30_000,
  taskTimeoutMs: 420_000,
  maxToolCalls: 80,
  requiredTools: Object.freeze([
    'browser_inspect',
    'browser_click',
    'browser_type',
    'browser_capture_screenshot',
    'browser_paste_image',
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
  forbidSubmittedType: true,
  expectedToolCounts: Object.freeze({
    browser_capture_screenshot: 1,
    browser_paste_image: 1,
  }),
  requiredVerifiedTools: Object.freeze(['browser_paste_image']),
  maxAttachmentCount: 1,
  requiredTypedTextIncludes: Object.freeze([
    'test',
    'ChatBrowserX calendar self-check {{RUN_ID}}',
    'ChatBrowserX mail self-check {{RUN_ID}}',
  ]),
  finalTextIncludes: Object.freeze([
    'ChatBrowserX calendar self-check {{RUN_ID}}',
    'ChatBrowserX mail self-check {{RUN_ID}}',
    '16:00',
    '16:30',
    'caoyang.001',
    '图片',
  ]),
  finalTextExcludes: Object.freeze([
    '唯一阻塞点',
    '仍有阻塞',
    '无法确认',
    '未能确认',
    '未验证',
    '未发送',
    'blocked',
    'could not verify',
    'unable to verify',
    'not verified',
    'not sent',
  ]),
  minFinalTextLength: 140,
  allowRemoteMutation: true,
});

const LARK_EXISTING_CALENDAR_MAIL_SCREENSHOT = Object.freeze<LiveScenario>({
  name: 'lark-existing-calendar-mail-screenshot',
  description:
    'Captures one previously verified Feishu event and emails its screenshot to self without mutating calendar data.',
  startUrl: 'https://bytedance.larkoffice.com/next/messenger',
  expectedOrigin: 'https://bytedance.larkoffice.com',
  taskText:
    '只通过当前 ChatBrowserX 提供的浏览器工具操作飞书网页；禁止网络抓包、飞书 API、CLI 或其他连接器。先从当前飞书页面进入日历，只使用 interactive/interactive_deep 和可操作 ref；整个任务禁止截图模式检查和坐标操作。不得新建、编辑、保存或删除日程。请在今天 2026-08-21 的日历中找到一个标题恰好为 test、时间恰好为 16:00–16:30 的已有日程，打开详情并确认完整描述以 ChatBrowserX calendar self-check live_ 开头、没有参与人；如果候选不匹配，只关闭详情并检查其他候选，不能修改页面数据。找到匹配日程后保持已验证的详情可见，调用且只调用一次 browser_capture_screenshot，保存返回的 assetId，不把截图用于模型视觉检查。随后通过飞书页面进入邮箱并新建邮件；收件人必须确认是 caoyang.001 对应的当前登录用户本人，主题必须恰好为 test，正文必须完整包含 ChatBrowserX mail self-check {{RUN_ID}}。找到邮件正文编辑器后，使用刚才的 assetId 调用且只调用一次 browser_paste_image；只有返回 ok=true 且 verified=true 才能继续，成功后绝不能再次粘贴。重新检查写信页面，确认收件人、主题、正文标记和一张待发送图片均存在，然后点击发送且只发送一次；不要使用 browser_type 的 submit=true 发送邮件。如果发送结果不明确，只检查已发送列表，绝不能再次发送。最后打开“已发送”，找到本次邮件并确认收件人是自己、主题为 test、完整正文标记可见且邮件中存在图片。任何日程回读、截图、粘贴、发送或已发送回读失败时立即停止并说明唯一阻塞点。最终回复必须逐字包含所选日程的完整 ChatBrowserX calendar self-check live_... 描述和 ChatBrowserX mail self-check {{RUN_ID}}，并明确列出已回读验证的日程时间、无参与人、收件人、主题和图片。',
  readinessTimeoutMs: 30_000,
  taskTimeoutMs: 420_000,
  maxToolCalls: 70,
  requiredTools: Object.freeze([
    'browser_inspect',
    'browser_click',
    'browser_type',
    'browser_capture_screenshot',
    'browser_paste_image',
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
  forbidSubmittedType: true,
  expectedToolCounts: Object.freeze({
    browser_capture_screenshot: 1,
    browser_paste_image: 1,
  }),
  requiredVerifiedTools: Object.freeze(['browser_paste_image']),
  maxAttachmentCount: 1,
  requiredTypedTextIncludes: Object.freeze(['test', 'ChatBrowserX mail self-check {{RUN_ID}}']),
  requiredToolOutputIncludes: Object.freeze(['ChatBrowserX mail self-check {{RUN_ID}}']),
  finalTextIncludes: Object.freeze([
    'ChatBrowserX calendar self-check live_',
    'ChatBrowserX mail self-check {{RUN_ID}}',
    '16:00',
    '16:30',
    'caoyang.001',
    '图片',
  ]),
  finalTextExcludes: Object.freeze([
    '唯一阻塞点',
    '仍有阻塞',
    '无法确认',
    '未能确认',
    '未验证',
    '未发送',
    'blocked',
    'could not verify',
    'unable to verify',
    'not verified',
    'not sent',
  ]),
  minFinalTextLength: 140,
  allowRemoteMutation: true,
});

const LARK_SENT_MAIL_IMAGE_READBACK = Object.freeze<LiveScenario>({
  name: 'lark-sent-mail-image-readback',
  description:
    'Reads back the newest ChatBrowserX screenshot test email and verifies its inline image without changing remote data.',
  startUrl: 'https://bytedance.larkoffice.com/next/messenger',
  expectedOrigin: 'https://bytedance.larkoffice.com',
  taskText:
    '只通过当前 ChatBrowserX 提供的结构化浏览器工具读取飞书网页；禁止网络抓包、飞书 API、CLI、其他连接器、截图检查和坐标操作。不得新建、编辑、发送、回复、转发、移动或删除任何邮件，也不得修改任何页面数据。通过飞书页面进入邮箱和“已发送”，按时间从新到旧检查主题恰好为 test 的候选邮件，找到正文完整包含 ChatBrowserX mail self-check live_ 前缀标记的最新一封。打开邮件详情，用 interactive 检查；只有所需正文或图片因截断缺失时才补一次 interactive_deep。必须回读并确认收件人是当前登录用户本人（caoyang.001 或 To: Me）、主题 test、完整 ChatBrowserX mail self-check live_... 正文标记，以及邮件正文中至少一个语义角色 role=image（压缩输出 r=image）的内容图片。不得把头像、应用图标或工具栏图标算作正文图片。若任一项无法从结构化结果确认，立即停止并说明唯一阻塞点，不得用截图猜测。最终回复必须逐字写出找到的完整 ChatBrowserX mail self-check live_... 标记，并明确列出收件人、主题和正文图片的结构化回读结果。',
  readinessTimeoutMs: 30_000,
  taskTimeoutMs: 240_000,
  maxToolCalls: 35,
  requiredTools: Object.freeze(['browser_inspect', 'browser_click']),
  forbiddenTools: Object.freeze([
    'browser_type',
    'browser_keypress',
    'browser_capture_screenshot',
    'browser_paste_image',
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
  finalTextIncludes: Object.freeze([
    'ChatBrowserX mail self-check live_',
    'caoyang.001',
    'test',
    '图片',
  ]),
  finalTextExcludes: Object.freeze([
    '唯一阻塞点',
    '仍有阻塞',
    '无法确认',
    '未能确认',
    '未验证',
    'blocked',
    'could not verify',
    'unable to verify',
    'not verified',
  ]),
  minFinalTextLength: 100,
  allowRemoteMutation: false,
});

const LIVE_SCENARIOS = Object.freeze([
  LARK_MESSENGER_READ,
  LARK_MESSENGER_AUGUST_HISTORY,
  LARK_MESSENGER_MULTI_GROUP_SCROLL,
  LARK_DOC_NAMED_SECTION,
  LARK_SELF_SEND,
  LARK_SELF_SEND_SCREENSHOT,
  LARK_FIVE_GROUPS_SUMMARY_SCREENSHOT_SEND,
  LARK_CALENDAR_MAIL_SCREENSHOT,
  LARK_EXISTING_CALENDAR_MAIL_SCREENSHOT,
  LARK_SENT_MAIL_IMAGE_READBACK,
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
