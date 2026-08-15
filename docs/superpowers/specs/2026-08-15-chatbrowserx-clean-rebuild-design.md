# ChatBrowserX 从零重构设计规格

- 文档类型：产品与架构设计规格
- 适用范围：`refactor/clean-rebuild` 分支的首个可用版本
- 约束级别：当前实现的强制边界
- 状态：实现候选；确定性实现与生产审计已具备，真实扩展 E2E 环境和 60 次 Codex 基准尚未满足发布门槛
- 批准日期：2026-08-15
- 日期：2026-08-15

## 1. 背景与设计结论

ChatBrowserX 将在无历史内容的 orphan 分支上从零实现。旧仓库代码、测试、配置、依赖和构建产物不进入新实现；旧产品仅作为用户可见功能清单的来源。

本次重构不是迁移或渐进式修补，核心结论如下：

1. 产品形态使用 Chrome 原生 Side Panel，不再向每个网页注入完整侧边栏。
2. UI 采用“专注对话”方案：聊天是主界面，任务状态、恢复入口和浏览器操作证据嵌入消息流。
3. 浏览 Agent 使用持久化状态机，每个动作都经过观察、执行、验证和检查点保存。
4. 页面控制使用 DOM 与 Chrome DevTools Protocol 的混合驱动，路由策略由场景能力和重复基准测试决定。
5. `debugger` 是必需安装权限。运行时仅在需要时附加目标标签页，空闲或任务结束后断开。
6. 模型侧只保留现有 Codex Access Token 接入，不提供 OpenAI-compatible Provider。
7. 完整删除语音、字幕、录音、音频捕获、Volcengine、打印和保存 PDF。
8. 首版必须保留图片、截图、选中文本、Tavily 和现有浏览器操作能力。
9. 最低支持 Chrome 125；跨域 iframe 依赖该版本开始提供的 `chrome.debugger` 扁平子会话。

## 2. 产品目标与成功标准

### 2.1 产品目标

- 提高受支持网页任务的实际完成率，而不是单纯增加可调用工具数量。
- 在 Side Panel 关闭、页面刷新、标签页导航或 Service Worker 重启后继续安全任务。
- 让每次失败都能看到失败步骤、原因和恢复入口。
- 保持模块职责清晰，使 Provider、浏览器驱动、任务调度和 UI 可以独立替换或测试。
- 控制权限、上下文、存储写入、模型 token 和重试成本。

### 2.2 可验证成功标准

- 确定性的浏览器驱动、任务状态机与故障恢复测试必须 100% 通过。
- 真实 Codex 端到端基准中的每个任务至少重复运行 3 次；支持范围内总体完成率不得低于 90%。
- 高风险操作误执行数量必须为 0。
- Service Worker 在任意安全步骤边界被终止后，任务能够恢复且不重复已确认成功的动作。
- 所有终止状态必须包含机器可读错误类别和用户可理解说明，不允许静默失败。

## 3. 当前版本范围

### 3.1 必须实现

#### 对话与任务

- 基础对话、流式输出、停止、重试和清空。
- 按标签页隔离的会话与任务历史。
- 任务暂停、继续、取消、恢复、执行状态、最近活动和失败原因。
- Side Panel 关闭、页面刷新、标签页导航和 Service Worker 重启后的自动恢复。
- Chrome 整体重启后从安全检查点自动恢复；等待态仍需对应用户动作。
- 用户系统提示、固定模型展示、Reasoning Effort 和界面语言设置。
- 简体中文、英文、日文和跟随系统语言。

#### 浏览器 Agent

- 读取页面标题、URL、可见文本、表单状态和语义化交互元素。
- 点击、输入、清空、选择、勾选、悬停、键盘操作、滚动、拖拽和等待。
- 处理 SPA 更新、页面导航、新标签页、弹窗、延迟加载、Shadow DOM 和 iframe。
- 每次动作后的结果验证、受限重试、重新观察和重新规划。
- 对提交、发送、删除、付款等高风险动作进行显式确认。

#### 图片与截图

- 从剪贴板粘贴图片和通过文件选择器添加图片。
- 截取当前可见视口或用户框选区域。
- 一条消息包含多张图片或截图。
- 图片缩略图、删除、放大预览和随消息发送。
- 图片以 Blob 形式存储，消息和任务仅保存附件引用。

#### 页面选中文本

- 用户选择网页文本后显示小型页面气泡。
- 提供“翻译”和“Ask AI”。
- 结果可以复制或继续发送到当前标签页会话；若该会话已有未终止任务，Ask AI 必须新建同标签页对话，不能覆盖旧任务的恢复入口。

#### 外部能力

- Codex Access Token 接入、流式响应、工具调用和图片输入。
- Tavily 搜索、提取和受控抓取。

### 3.2 明确不实现

- OpenAI-compatible Provider、可配置 Base URL、通用 API Key 或任意自定义模型服务。
- 打印、保存 PDF、滚动截图拼接或 PDF 解析。
- 语音识别、语音合成、字幕、录音、标签页音频捕获、offscreen audio 和 Volcengine。
- 任意 JavaScript 执行、通用网络流量录制、桌面级自动化和浏览器外操作。
- 云端任务同步、多人协作、插件市场、多 Agent 编排和外接本地 Playwright 服务。
- 无动作、时间和重试预算的无限工具循环。

## 4. 用户体验设计

### 4.1 Side Panel

主界面使用 Chrome 原生 `sidePanel`，最低目标平台为 Chrome 125 的 MV3 环境。

界面从上到下包含：

1. 顶栏：产品标识、新建任务、历史入口、设置入口和当前运行状态。
2. 页面上下文：当前标签页标题、域名、连接和权限状态。
3. 消息流：用户消息、模型回复、错误、恢复卡片和内嵌任务卡。
4. 输入区：文本输入、图片、截图和发送/停止按钮。

任务卡默认折叠，只展示本地化状态、已验证动作数量和最近活动；用户可以展开查看每次观察、规划、动作、验证和失败边界。普通聊天不显示空任务面板，也不把内部 reason code 直接展示给用户。

### 4.2 页面内 UI

网页内只允许出现以下按需界面：

- 选中文本气泡及其结果浮层。
- 区域截图选择层和截图控制条。

这些界面不得承担聊天、设置、历史或任务编排，也不得永久改变宿主页面布局。

### 4.3 恢复体验

- Side Panel 关闭、页面刷新或 Service Worker 重启：安全任务自动恢复，UI 再次打开时显示恢复后的当前步骤。
- Chrome 整体重启：与普通 MV3 Worker 重启使用同一过期 lease 扫描；仅自动状态从安全检查点继续，等待态不自动越过用户条件。
- 目标标签页不存在：任务进入 `waiting_for_tab`，允许用户绑定新的标签页后继续。
- Access Token 失效：任务进入 `waiting_for_auth`，更新 Token 后从模型回合边界继续。
- 高风险动作状态不确定：任务进入 `waiting_for_confirmation`，不得自动重放。

## 5. 总体架构

```text
src/
  entries/       Chrome 入口、manifest 装配与依赖组合
  side-panel/    Side Panel React 应用
  page/          选中文本、截图和操作提示等页面内 UI
  tasks/         任务实体、状态转换、检查点与恢复
  agent/         规划、执行循环、预算、重试与安全策略
  browser/       页面观察、目标定位、动作执行与结果验证
  providers/     Codex 与 Tavily Adapter
  attachments/   图片、截图、Blob 与附件生命周期
  persistence/   IndexedDB、Chrome Storage 与 schema migration
  platform/      Chrome API、消息通道和 Debugger Adapter
  shared/        无业务倾向的类型与纯函数
```

依赖方向必须保持为：

```text
entries / side-panel / page
            ↓
        tasks / agent
            ↓
   browser / providers / attachments
            ↓
      platform / persistence
            ↓
           shared
```

约束如下：

- `entries` 只负责入口和依赖装配。
- React 只存在于 `side-panel` 与 `page`。
- `tasks` 和 `agent` 不直接调用 Chrome API、IndexedDB 或网络。
- `browser` 依赖明确的页面与 CDP 端口接口，不依赖 UI。
- `providers` 不依赖 React、DOM 或 Chrome 标签页对象。
- `platform` 不包含 Agent 决策和业务状态转换。
- `shared` 不承载任务编排，也不建立万能工具模块。
- 不引入 Redux、XState、通用工作流框架、动态插件系统或全局事件总线。

## 6. 持久化数据模型

### 6.1 核心记录

- `Conversation`：与一个标签页上下文关联的对话元数据。
- `Message`：用户、助手或系统消息；图片只保存 `Attachment` ID。
- `TaskRun`：用户目标、当前状态、目标标签页、预算和最新检查点。
- `Checkpoint`：恢复所需的最后安全状态、已完成工具结果和 Provider 回合边界。
- `TaskEvent`：任务生命周期中的追加式审计事件。
- `Attachment`：Blob、媒体类型、尺寸、来源、创建时间和引用关系。

### 6.2 存储位置

- IndexedDB 保存会话、消息、任务、步骤、检查点、事件和附件 Blob。
- `chrome.storage.local` 保存界面设置、Codex 设置、Tavily 设置和凭证。
- 不使用 `chrome.storage.sync` 保存任何凭证或任务内容。
- Codex Access Token 与 Tavily Key 仅允许扩展受信上下文访问，不发送给 content script。
- 日志、错误、测试快照和遥测不得包含完整 Token、Key、Cookie 或用户页面敏感字段。

### 6.3 写入策略

- 状态转换、工具调用意图、工具结果和检查点必须事务化写入。
- 流式文本不得按 token 写入；最多每 1 秒或每累计 8 KiB 批量落盘一次，并在正常结束时强制提交。
- 附件不得复制到每条消息或每个事件中。
- IndexedDB schema 必须显式版本化，升级失败时保留原数据并进入可恢复错误状态。
- 首次重写不迁移旧实现的聊天或设置数据；旧 key 和旧数据库均被忽略，新版本首次启动重新要求 Access Token。

## 7. 任务状态机与恢复

### 7.1 状态

`TaskRun` 使用以下显式状态：

```text
queued
observing
planning
acting
verifying
checkpointed
waiting_for_tab
waiting_for_auth
waiting_for_confirmation
paused
completed
failed
cancelled
```

只有纯 transition 函数能够改变状态。每次转换必须记录原因、时间和触发事件。

### 7.2 正常运行链路

1. 用户发送目标后创建 `TaskRun` 和初始 `Checkpoint`。
2. Runner 获取带过期时间的任务 lease，防止两个 Service Worker 实例重复执行。
3. Browser Observer 读取当前页面并产生受限语义快照。
4. Agent Planner 根据目标、已完成步骤、快照和预算只决定下一批有界动作。
5. Runner 在写入动作意图后执行浏览器动作。
6. Verifier 检查动作声明的预期结果。
7. 成功结果与新检查点在同一事务中保存；失败进入受限重试或重新规划。
8. 满足目标后进行最终验证并进入 `completed`。

动作副作用边界使用以下追加事件：`action.intent-recorded` 在每次实际尝试前保存，`action.evidence-recorded` 保存驱动返回或结果未知状态，`action.verified` 将验证成功、动作预算和新检查点原子写入，`action.verification-failed` 将失败结果带入重新观察。`PendingActionCheckpoint` 保存完整结构化动作、规范化 SHA-256 摘要、结构化预期条件、意图时间、尝试次数、证据、验证结果和确认信息，不依赖 Service Worker 内存恢复。

### 7.3 中断恢复

- `runtime.onStartup`、周期性 `alarms`、Side Panel 连接和标签页状态事件都会触发未完成任务扫描。
- 过期 lease 可以被新 Runner 接管；有效 lease 不得被并发执行。
- 已写入成功结果的动作不再执行。
- 只有“意图已写入但结果未知”的动作需要重新观察页面判断是否已生效。
- LLM 流中断时重新发起当前未完成的模型回合；检查点中的已完成浏览器结果作为输入，不从整个用户任务重新开始。
- 提交、发送、删除和付款等非幂等动作在结果未知时禁止自动重放。
- 高风险确认绑定规范化动作摘要和明确的下一次尝试编号；一次确认不得被后续重试复用。普通 `task.resume` 不能替代高风险确认。
- 绑定标签页消失时不得选择当前活动页；只有用户显式提供替代 `tabId` 后才能从 `waiting_for_tab` 恢复。

## 8. 浏览器执行核心

### 8.1 观察

页面快照按需包含：

- URL、标题、导航状态和视口信息。
- 可见文本的分区摘要，而不是无界完整页面文本。
- 交互元素的 role、accessible name、label、value、checked、selected、disabled 和 visibility。
- 表单、对话框、菜单、表格和列表的必要结构。
- frame 层级、开放 Shadow Root 和可用的跨域 frame 观察结果。
- 与上次检查点相比的关键变化。

观察不得为了读取内容自动滚动整个页面。超长页面必须通过区域、语义节点或后续动作渐进读取。
动态 content script 仅注入顶层 frame，并从该 realm 遍历可访问的同源 iframe；元素判断必须使用标签名、结构能力和元素所属 window 的事件构造器，不能依赖顶层 realm 的 `instanceof`。跨域及 OOPIF 由 CDP `Target.setAutoAttach` 递归附加 iframe 子会话后分别观察，观察元素必须携带仅在当前快照内有效的 `cdpSessionId` 与 `backendNodeId`。

### 8.2 目标定位

模型使用结构化 `ElementTarget`，其候选信息可以包含：

- frame 路径和 Shadow Root 路径。
- role、accessible name、label、placeholder 和稳定属性。
- 精确或归一化文本。
- 附近语义、表单归属和列表位置。
- DOM 路径提示与最近一次几何位置。
- Debugger 会话中的 `backendNodeId`。

临时元素编号、CSS 路径、XPath、坐标或 `backendNodeId` 均不得单独作为跨检查点定位依据。执行前必须重新解析候选并检查唯一性、可见性、可交互性和遮挡状态。

### 8.3 混合驱动

Browser Driver 提供统一动作接口，下层由 DOM Adapter 和 CDP Adapter 实现。

- DOM Adapter 适合可直接访问的语义 DOM、表单属性读取和低成本操作。
- CDP Adapter 适合真实键鼠事件、跨 frame 目标、复杂焦点、导航生命周期和 DOM 方式无法可靠完成的场景。
- CDP Adapter 对每层 OOPIF 子会话继续设置 iframe auto-attach；动作必须发送到新鲜观察所得的子会话，禁止跨检查点复用会话 ID。
- 拖拽的起点或终点任一属于 CDP 子会话时，路由必须强制使用 CDP；不同 CDP 子会话之间的拖拽必须拒绝并重新规划。
- CDP 文本替换使用协议编辑命令 `SelectAll`，不假设 Ctrl/Command 平台修饰键；原生选择框使用内部固定、不可由模型提供源码的受限函数精确设置值并派发 `input`/`change`，拖拽使用真实 mouse press/move/release 序列。
- 路由不使用固定的“DOM 永远优先”规则；每种场景通过能力检测与基准结果选择成功率更高的 Adapter。
- 两种路径成功率相同时，选择权限暴露更少、状态更简单、成本更低的路径。
- `waitFor` 的验证必须使用动作声明且受全局上限约束的 `timeoutMs`；验证满足时应记为成功路由样本，即使 Driver 本身无需产生页面副作用。
- CDP 可以在任务开始时预先附加，也可以按动作附加；由场景策略决定。任务暂停、完成、取消或长时间空闲时必须断开。
- 若 Chrome 在任务运行中外部断开 debugger，下一次观察必须以传输层真实连接状态为准重新附加，不能只相信控制器的内存所有权缓存。
- Side Panel 必须明确显示当前是否连接 Debugger。
- 驱动成功样本只能在预期页面效果验证成功后写入；命令已发送不等于成功。样本使用稳定的尝试 ID 幂等覆盖，样本存储失败不得中断已经验证成功的用户动作。

### 8.4 动作与验证

每个动作必须包含目标、输入、预期结果和风险级别。首版动作集合为：

- `click`
- `type`
- `clear`
- `select`
- `check`
- `hover`
- `pressKey`
- `scroll`
- `drag`
- `waitFor`

验证可以组合以下证据：

- URL、标题或标签页变化。
- 元素状态、值、焦点、可见性或消失。
- 对话框、提示、列表、表格或计数变化。
- DOM/Accessibility tree 的局部差异。
- 导航和页面生命周期稳定状态。

固定 sleep 只能作为带上限的最后兜底。正常等待应由事件、MutationObserver、导航事件和条件轮询驱动。

### 8.5 重试与预算

默认硬限制如下：

- 同一动作最多进行 3 次目标解析或执行尝试。
- 验证失败后最多进行 2 次完整重新观察与重新规划。
- 单任务默认最多执行 50 个浏览器动作。
- 单任务默认墙钟时间上限为 20 分钟。
- 达到限制后进入 `paused`，由用户明确继续并扩展预算。
- 高风险动作没有自动执行重试次数。

视觉截图仅在没有可见语义交互元素且可读正文不足 200 字符时尝试，不默认对每一步截图。自动截图只允许不超过 6 MiB 的 PNG/JPEG/WebP，作为当前 Provider 回合的临时视口输入，不写入附件、消息或任务记录；标签页不可见或捕获失败时继续使用原语义路径。

## 9. Provider 设计

### 9.1 Codex

- 设置页仅提供 Access Token、固定模型只读展示、Reasoning Effort 和系统提示。
- Codex 服务地址与协议由 `providers/codex` 内部固定管理，用户不可配置。
- 不读取 Codex CLI 或桌面应用的凭证文件。
- 不提供 API Key、Base URL 或 OpenAI-compatible 回退路径。
- Provider 输出统一转换为文本增量、工具调用、工具参数增量、完成和结构化错误事件。
- `401`/`403` 进入 `waiting_for_auth`；限流读取服务端等待信息；网络和 `5xx` 使用有上限的指数退避。
- Access Token 协议的兼容风险限制在 Codex Adapter 内，不得泄漏到任务、浏览器或 UI 模块。

### 9.2 Tavily

- 设置页只保存 Tavily Key。
- 搜索、提取和抓取分别使用显式请求类型和结果上限。
- 返回内容在进入模型上下文前进行长度限制、来源标记和失败归一化。
- Tavily 失败不得破坏浏览器任务检查点。

## 10. 消息协议、权限与安全

### 10.1 消息协议

Side Panel、Service Worker 和 content script 之间使用带 `version`、`requestId`、`taskId` 与可判别 `type` 的消息联合类型。所有外部边界都必须进行运行时校验。

当前协议按信任边界拆分：`ExtensionMessage` 包含连接与完整面板快照、聊天提交、终止会话清理、设置读写、任务 create/snapshot/pause/resume/confirm/cancel、截图、页面功能安装和选中文本 Translate/Ask AI。`task.resume` 只在任务处于 `waiting_for_tab` 时接受可选替代 `tabId`；`task.confirm` 必须携带与待执行动作完全匹配的 `sha256:` 摘要。`selection.ask` 的标签页只使用 Chrome runtime sender，而不信任页面 payload。基础 `PageCommand` 只包含无凭据的 `page.ping`、`page.observe`、`page.screenshot.select` 与 `page.overlays.setHidden`；browser 层另有严格校验的 `PageActionCommand`，只承载批准的十类结构化动作。content script 不接受任务仓库、设置、凭据或任意 JavaScript 命令，Service Worker 的任务路由也不接受页面命令。

长任务状态通过每 750 ms 查询一次经过校验的完整快照同步，并使用 generation 丢弃过期响应。该取舍不依赖会随 MV3 Worker 消失的长连接；UI 断开后不影响 Runner。

### 10.2 Chrome 权限

首版需要的固定权限为：

- `sidePanel`
- `storage`
- `scripting`
- `activeTab`
- `tabs`
- `alarms`
- `debugger`

`debugger` 会触发高权限安装警告，这是为提高浏览器操作成功率而接受的产品取舍。扩展不得利用该权限记录通用网络流量或执行范围外能力。

网页 host access 使用 `optional_host_permissions`。用户开始任务或启用选中文本功能时申请当前 origin；跨 origin 导航需要新增授权。Codex 与 Tavily 的固定服务 origin 仅声明满足请求所需的最小范围。

### 10.3 安全规则

- content script 无法访问 Access Token、Tavily Key 或完整任务仓库。
- 不使用 `eval`、动态远程脚本或远程 UI 代码。
- 网页文本始终视为不可信数据，不能覆盖系统策略、权限边界和高风险确认规则。
- 调试日志默认关闭敏感 payload；可导出的诊断包必须先脱敏。
- `chrome://`、Chrome Web Store、浏览器内部页面和其他 Chrome 禁止注入的页面明确标记为不支持。
- CAPTCHA、二次验证和需要人工判断的安全挑战必须交还用户。

## 11. 错误处理

错误至少归一化为以下类别：

- `AuthError`
- `RateLimitError`
- `TransientProviderError`
- `InvalidProviderResponse`
- `PermissionDenied`
- `TabUnavailable`
- `UnsupportedPage`
- `TargetNotFound`
- `TargetAmbiguous`
- `ActionBlocked`
- `ActionNoEffect`
- `NavigationInterrupted`
- `BudgetExceeded`
- `PolicyConfirmationRequired`

每个错误包含可重试性、建议恢复动作、用户说明和内部证据引用。原始 Token、网页敏感内容和大型模型响应不得直接写入错误对象。

## 12. 测试与浏览成功率基准

### 12.1 测试层级

- 单元测试：状态转换、预算、风险策略、目标评分、消息校验和错误归一化。
- 存储集成测试：事务、lease、检查点、schema migration、Blob 生命周期和中断恢复。
- Provider 合约测试：流式事件解析、工具调用、认证失败、限流、断流和非法响应。
- 浏览器集成测试：DOM Adapter、CDP Adapter、定位、动作和验证。
- 扩展端到端测试：加载真实 MV3 扩展并通过 Side Panel 完成任务。

### 12.2 确定性测试站点（发布门槛，尚未完成）

发布前必须提供仅用于测试的本地站点，覆盖：

- 原生表单和表单校验。
- React 风格 SPA 导航和异步重渲染。
- 模态框、菜单、下拉框、复选框和日期控件。
- 虚拟列表、无限滚动和延迟加载。
- 开放 Shadow DOM。
- 同源与跨源 iframe。
- 新标签页、重定向和返回导航。
- 拖拽、悬停、键盘交互和被遮挡元素。

测试站点不得为某个定位算法硬编码专用后门。

### 12.3 故障注入（发布门槛，当前以存储边界单元测试为主）

测试 Runner 必须能够在每个持久化状态后终止 Service Worker，并覆盖：

- 流式响应中断。
- 动作执行前、执行后但写入结果前、写入检查点后的终止。
- 页面刷新、标签页关闭和标签页 ID 变化。
- 元素被替换、移动、遮挡或变为不可用。
- 网络离线、超时、`429` 和 `5xx`。
- Debugger 被用户或 DevTools 断开。

### 12.4 真实 Codex 基准（尚未执行）

- 建立至少 20 个稳定、可重复、无破坏性的真实浏览任务。
- 每个任务至少连续执行 3 次。
- 记录完成率、平均动作数、重新观察次数、Adapter 路由、耗时、token、失败类别和人工接管次数。
- 支持范围内总体完成率低于 90% 时不得宣称重构完成。
- 不以单次演示成功代替重复基准。

## 13. 主要取舍与风险

### 13.1 Debugger 权限

`debugger` 无法声明为可选权限，会产生明显安装警告。用户已接受以成功率为优先的取舍。实现仍需缩短附加时间、展示状态并限制用途。

### 13.2 MV3 生命周期

Service Worker 无法被设计成永久运行。系统保证的是从检查点恢复，而不是依赖 keep-alive 绕过 Chrome 生命周期。

### 13.3 Codex Access Token 协议

Access Token 接入不是通用 Provider。协议变化可能导致认证或响应解析失效，因此必须通过单一 Adapter、合约测试和明确的 `waiting_for_auth` 状态隔离影响。

### 13.4 模型非确定性

动作验证、重试预算和真实任务重复运行用于控制非确定性，但不能保证所有网站和所有任务 100% 成功。产品只对明确支持范围和可测基准负责。

### 13.5 破坏性重写

新版本不迁移旧聊天、设置或凭证。该取舍减少兼容层和隐藏状态，但升级后用户必须重新填写 Codex Access Token 与 Tavily Key。

## 14. 完成定义

只有同时满足以下条件，重构才可视为可发布；当前 3、4 中的真实环境部分尚未满足，因此不得宣称已达到发布成功率门槛：

1. 当前范围内的功能全部存在，明确删除项均无代码、权限或 UI 残留。
2. 架构边界与本文一致，没有超级入口文件、跨层 Chrome API 或 UI 内任务编排。
3. 确定性测试全部通过，真实 Codex 基准达到 90% 完成率目标。
4. 故障恢复测试证明已完成动作不会被重复执行。
5. 高风险动作误执行为 0。
6. 构建、类型检查、格式检查和测试无新增错误或警告。
7. Manifest 权限均能对应到当前功能，不包含音频、PDF 或范围外权限。
8. README、架构说明、用户设置说明和故障排查与实现保持一致。

## 15. 未来设计

以下能力不属于当前实现计划，只有新的产品决策和独立规格批准后才能进入：

- 本地原生伴随进程或 Playwright 服务。
- 云端任务同步与跨设备恢复。
- 多 Agent、插件系统和第三方工具市场。
- 浏览器外桌面控制。
- 更广泛的文档、PDF、音频或视频处理。
