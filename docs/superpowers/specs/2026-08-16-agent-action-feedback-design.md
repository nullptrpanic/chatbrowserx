# ChatBrowserX Agent 页面操作反馈设计

- 文档类型：增量产品与架构设计规格
- 适用范围：`refactor/clean-rebuild` 分支
- 约束级别：实现约束
- 状态：已实现，待完整发布门槛验证
- 批准方式：用户授权实现方决定交互细节
- 日期：2026-08-16

## 1. 目标

在 Agent 操作网页时提供清晰但克制的页面内反馈，让用户能够看到 Agent 正在指向、点击或拖拽的位置。反馈只用于可观察性，不参与目标定位、动作执行或结果验证，也不能改变动作成功率、安全策略和持久化状态。

成功标准：

- DOM 与可可靠投影到顶层视口的 CDP 指针动作都能显示一致反馈。
- 点击和勾选显示光标与一次水波纹；悬停显示光标停留；拖拽显示从起点到终点的移动过程。
- 反馈层不接收指针事件，不改变页面布局，不进入截图、模型视觉输入或持久化任务记录。
- 页面反馈发送、渲染或动画失败时，浏览器动作仍按原逻辑继续。
- 支持 `prefers-reduced-motion`，且不会产生持续闪烁或常驻遮挡。

## 2. 方案比较与结论

### 方案 A：content script 独立反馈层（采用）

使用与选中文本、截图选择相同的 closed Shadow Root 页面 overlay。DOM 动作在 content script 内直接触发反馈；CDP 动作通过严格的 `page.actionFeedback` 消息发送坐标。该方案复用现有 overlay registry，能够在截图前统一隐藏，且不要求浏览器核心依赖 React 或页面 DOM。

### 方案 B：CDP Runtime/Overlay 注入

通过 `Runtime.evaluate` 或 DevTools `Overlay` 域绘制反馈。它可覆盖没有 content script 的页面，但会把 UI 注入职责放入 CDP 驱动，扩大 Debugger 使用范围，并增加跨 session 清理、截图隐藏和固定脚本审计成本，因此不采用。

### 方案 C：只在 Side Panel 显示操作动画

实现成本最低，也不会触碰网页，但无法展示实际目标位置，不满足“虚拟鼠标和水波纹”的核心诉求，因此不采用。

## 3. 视觉与交互

- 光标为 18px 的白色箭头，使用蓝色描边与轻微阴影，在浅色和深色网页上均可见。
- 光标移动使用约 140ms 的 ease-out 过渡；首次出现直接定位，避免从视口原点划过页面。
- 点击与勾选在目标中心产生一个蓝色圆环，约 420ms 内从 8px 扩散至 34px 并淡出。
- 悬停将光标移动到目标中心，停留约 700ms 后淡出，不产生点击波纹。
- 拖拽先定位到起点，再在约 260ms 内移动到终点；按下期间显示较小的实心蓝点，释放时在终点显示一次柔和波纹。
- 同一时刻只显示一个光标；连续动作复用当前光标并重新计时，避免叠加多个常驻元素。
- overlay 使用 `pointer-events: none`、最高但不覆盖浏览器 UI 的页面层级，不改变宿主页面尺寸或滚动。
- `prefers-reduced-motion: reduce` 时取消位移动画，光标直接跳到目标，只保留不超过 120ms 的低透明度状态提示。

首版不展示文字标签、动作名称、键盘按键、滚轮方向、长拖拽轨迹或声音。这些信息已存在于 Side Panel，加入页面会增加遮挡和维护成本。

## 4. 组件与职责

### `page/action-feedback`

- 挂载唯一的 closed Shadow Root overlay，并注册到 `page-overlay-registry`。
- 接收经过验证的 `move`、`click`、`drag`、`hide` 指令。
- 对坐标进行有限值与视口边界约束，渲染光标和短生命周期动画。
- 页面卸载时清理计时器、动画、反馈 DOM 节点和 overlay registry 条目。

### DOM 动作路径

`executeDomAction` 使用实时元素 `getBoundingClientRect()` 得到中心点，同源 frame 内的坐标逐层投影到顶层视口，再在执行 `click`、`check`、`hover`、`drag` 前后调用可注入的反馈端口。默认端口连接页面反馈控制器；测试可传入 stub。反馈调用必须 best-effort，不能将视觉失败转换为动作失败。

### CDP 动作路径

`CdpActionDriver` 在已经通过 `DOM.getBoxModel` 得到实际动作坐标后调用可注入的反馈端口。Chrome 平台适配器将反馈转换为严格的 `page.actionFeedback` 命令并发送给顶层 content script。发送失败被吞掉并记录为无诊断内容的非致命失败，不改变动作 evidence。

对于当前无法可靠投影到顶层视口的子 CDP session，首版不绘制可能错位的光标；实际 CDP 输入仍照常执行。后续只有在 frame 坐标转换具备确定性测试后才扩展该范围。

## 5. 协议与数据流

新增凭据无关的页面命令：

```ts
type ActionFeedbackCommand = Message<
  "page.actionFeedback",
  | { kind: "move"; x: number; y: number }
  | { kind: "click"; x: number; y: number }
  | { kind: "drag"; fromX: number; fromY: number; toX: number; toY: number }
  | { kind: "hide" }
>;
```

运行时校验必须拒绝非有限坐标、额外字段、未知 kind 和超长 request ID。页面端再次把坐标限制到当前视口。协议不包含 task、目标文本、元素属性、页面内容、凭据或任意可执行代码。

数据流：

1. Browser Controller 解析目标并选择 DOM/CDP 驱动。
2. 驱动从实时元素或 CDP box model 得到动作坐标。
3. 驱动以 best-effort 方式发出短生命周期反馈。
4. 页面 overlay 渲染动画；真实动作独立执行。
5. Verifier 按原逻辑判断页面效果，完全忽略视觉反馈。
6. 截图控制器通过现有 `page.overlays.setHidden` 隐藏反馈层，捕获结束后恢复。

## 6. 安全、隐私与失败处理

- 反馈层运行在 isolated world 的 closed Shadow Root 中，不暴露控制 API 给宿主页面。
- 页面命令只包含动作类型和有限坐标，不包含敏感输入值或模型上下文。
- overlay 不响应用户输入，不执行导航、不修改页面表单、不调用浏览器动作。
- 反馈是瞬态内存状态，不写 IndexedDB、Chrome storage、事件日志或 benchmark artifact。
- content script 缺失、标签页关闭、导航、消息超时或动画异常都不得阻塞动作。
- 页面导航后旧 overlay 随文档销毁；新文档由 content script 重新挂载。

## 7. 测试设计

- 页面反馈单元测试：幂等挂载、坐标约束、点击波纹、拖拽状态、自动淡出、reduced motion、dispose。
- 协议测试：接受四种合法指令；拒绝 NaN、Infinity、额外字段与未知 kind。
- DOM 驱动测试：点击、悬停、勾选、拖拽发送正确的实时中心坐标；反馈失败不影响动作 evidence。
- CDP 驱动测试：反馈坐标与实际 `dispatchMouseEvent` 坐标一致；子 session 跳过反馈；反馈端口失败不影响 CDP 命令。
- 页面命令测试：合法反馈命令到达控制器，非法命令返回稳定错误。
- 截图回归测试：反馈 overlay 由 registry 隐藏并恢复。
- 完整检查：format、lint、typecheck、unit tests、build、bundle audit；不以本功能修复现存 Playwright fixture 或浏览成功率 benchmark。

## 8. 文档与范围同步

实现时同步更新：

- 主设计规格的页面内 UI 允许项与页面协议列表；
- `docs/architecture.md` 的 overlay 和页面命令说明；
- 必要的开发或用户说明。

本功能不改变浏览器动作协议、任务状态机、风险确认、权限模型、DOM/CDP 路由或成功判定。
