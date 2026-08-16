# ChatBrowserX

ChatBrowserX 是一个运行在 Chrome Side Panel 中的 Codex 对话客户端。当前阶段只打通可靠的文本与图片流式请求；仓库不注册、声明或执行任何浏览器或搜索工具。

## 当前能力

- 使用 Codex Access Token 调用固定 Codex endpoint，模型固定为 `gpt-5.6-terra`。
- 流式显示回复，并持久化对话、任务状态和中断恢复边界。
- 发送用户当前输入，以及用户明确添加的文件图片、剪贴板图片、视口截图或区域截图。
- 网页选中文本翻译与 Ask AI。
- Access Token、推理强度、系统提示和界面语言设置。
- 简体中文、英文、日文和跟随系统的界面。

当前明确不包含：浏览器观察/操作工具、网页搜索/抓取工具、语音、录音、打印/PDF、整页滚动截图、OpenAI-compatible、可配置 Base URL、任意 JavaScript 执行和网络录制。

通用 Provider 工具接口仍保留，便于以后重新设计；生产 Planner 当前始终传入空工具列表。空列表时请求体完全省略 `tools`、`tool_choice` 和 `parallel_tool_calls`。

## 安装与运行

要求 Chrome 125+、Node.js 24.18.x 和 npm 11.x。

```bash
npm ci
npm run build
```

打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，加载仓库中的 `dist/`。点击扩展图标打开 Side Panel，然后在设置中填写 Codex Access Token。

`npm run dev` 只提供 Vite 资源，不会让普通 `http://127.0.0.1` 页面获得扩展后台。真实请求必须从 Chrome 已加载扩展的 Side Panel 发起。

## 请求数据边界

- `instructions` 严格等于设置里的系统提示，不追加隐藏前缀。
- 每个聊天任务的 `input` 只包含该任务对应的用户消息，以及该消息明确引用的图片。
- 不自动加入页面 DOM、页面快照、iframe、旧对话、任务预算、检查点、风险策略或截图。
- 当前生产请求不携带任何工具定义，也没有工具执行回路。

所有网站访问权限仅用于用户主动触发的区域截图、页面选中文本等页面功能；拥有权限不会自动读取或发送网页。

## 开发检查

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:run
npm run build
npm run audit:bundle
```

可选真实 Codex 合约检查：

```bash
CHATBROWSERX_CODEX_ACCESS_TOKEN='…' npm run check:codex
```

它只验证 Provider 合约，不代表浏览任务成功率。当前版本没有浏览器任务能力，也不会展示虚假的动作数量或成功率。

## 文档

- [架构](docs/architecture.md)
- [开发说明](docs/development.md)
- [用户指南](docs/user-guide.md)
- [故障排查](docs/troubleshooting.md)
- [安全策略](SECURITY.md)
- [隐私说明](PRIVACY.md)
