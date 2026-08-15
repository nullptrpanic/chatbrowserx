# ChatBrowserX

ChatBrowserX 是一个 Chrome Side Panel 浏览器 Agent。它把对话、任务状态、失败恢复和操作确认放在原生侧栏中，并通过“观察 → 规划 → 操作 → 验证 → 检查点”执行网页任务。

当前版本是从零重写，不迁移旧仓库的聊天、设置或凭证。

## 当前能力

- 固定 Codex Access Token 接入与流式回复；模型固定为 `gpt-5.6-terra`。
- DOM + Chrome DevTools Protocol 双观察、双驱动与基于验证结果的自适应路由。
- 点击、输入、清空、选择、勾选、悬停、按键、滚动、拖拽和条件等待。
- 持久化任务、lease、动作意图、证据、验证结果与检查点；Side Panel 或 MV3 Service Worker 中断后自动恢复。
- 高风险动作摘要绑定确认，结果未知时先验证，不盲目重放。
- Tavily 搜索、提取和受控抓取。
- 文件/剪贴板图片、当前视口截图和区域截图；附件以 Blob 保存。
- 网页选中文本翻译与 Ask AI。
- 语义信息极少时的临时视口视觉兜底，不保存自动截图。
- 简体中文、英文、日文和跟随系统的侧栏界面。

明确不包含：语音、录音、字幕、音频捕获、Volcengine、打印/PDF、整页滚动截图、OpenAI-compatible、可配置 Base URL、任意 JavaScript 执行和网络录制。

## 安装与运行

要求 Chrome 125+、Node.js 24.18.x 和 npm 11.x。

```bash
npm ci
npm run build
```

然后打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，加载仓库中的 `dist/`。

首次使用：

1. 点击工具栏图标打开 Side Panel。
2. 在“设置”中填写 Codex Access Token；需要联网检索时再填写 Tavily Key。
3. 在目标网页授权当前网站。
4. 输入目标并发送。

扩展声明 `debugger` 权限以提高跨 iframe、真实键鼠事件和复杂页面的成功率，因此安装时 Chrome 会显示对应权限警告。Debugger 按需连接，并在任务结束或释放时断开。

## 开发检查

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:run
npm run build
npm run audit:bundle
```

真实扩展壳测试还需要：

```bash
npx playwright install chromium
npm run test:e2e
```

可选 Codex 合约检查仅在显式提供进程环境变量时访问网络：

```bash
CHATBROWSERX_CODEX_ACCESS_TOKEN='…' npm run check:codex
```

它只验证 Provider 合约，不代表浏览任务成功率。当前仓库不会在没有完整重复基准报告时宣称达到 90% 成功率。

## 文档

- [架构](docs/architecture.md)
- [开发说明](docs/development.md)
- [用户指南](docs/user-guide.md)
- [故障排查](docs/troubleshooting.md)
- [安全策略](SECURITY.md)
- [隐私说明](PRIVACY.md)
