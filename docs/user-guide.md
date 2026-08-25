# 用户指南

## 设置

- `Codex Access Token`：必填。进入设置时加载已保存值，默认隐藏，可点击眼睛查看；保存后仍会展示。
- `Tavily API Key`：使用搜索、网页提取或站内抓取时必填；只保存在可信扩展上下文。
- 模型：固定为 `gpt-5.6-terra`。
- Reasoning Effort：`low`、`medium`、`high`、`xhigh`。
- 系统提示：原样成为 Codex `instructions`，不会追加隐藏前缀。
- 界面语言：跟随系统、简体中文、English、日本語。
- 历史消息条数：每次请求最多携带的已完成历史消息，默认 50，可配置 1–50；不会删除本地记录。

## 对话

输入文字后发送，或按 `Ctrl/Cmd + Enter`。新的逻辑工作会创建一个 WorkSession；模型收到本次输入、最多 50 条来自已成功完成 WorkSession 的最近历史，以及用户明确添加的图片。当前页面、DOM、内部任务状态和未附加截图不会自动加入。

任务运行时，输入框仍支持文字、上传/粘贴图片、区域截图和视口截图。主按钮会变成“补充”，`Ctrl/Cmd + Enter` 也会提交补充；旁边的“停止”按钮独立存在。补充不会打断正在进行的模型或工具请求，而会在下一次 Agent Loop 生效。已接受的补充会显示在所属回答的折叠执行详情中，不会额外生成用户气泡；如果任务恰好先完成，补充会失败并保留草稿。

“暂停”保留当前 TaskRun，点击“继续”会从 durable checkpoint 恢复。认证失效或临时 Provider 错误也会提供“继续”或“重试”。“取消任务”结束当前 TaskRun，但保留已经生成的回复、工具调用、工具结果和补充；之后发送任意新消息都会在同一 WorkSession 创建新的 TaskRun，重复取消和继续也不会丢失此前状态。任务成功完成后，这个 WorkSession 才作为完整历史参与后续请求。

当前版本提供三个 Tavily 工具：公共网页搜索、指定 URL 内容提取和同站点有界抓取。模型每个回合最多选择一个工具，单个任务最多完成 8 次调用。工具结果会跟随具体回答显示在折叠的“执行详情”中；刷新或切换标签页后仍从持久化 checkpoint 恢复。

Tavily 不等于浏览器控制：类似“总结当前页面”的请求不会自动获得活动页面 DOM，也不会捕获网页网络请求。请提供公共 URL、粘贴内容或主动添加截图。浏览器观察、点击、输入等动作工具仍不可用。

## 图片与截图

- 支持 PNG/JPEG/WebP/GIF 文件和剪贴板图片。
- 每条草稿最多 8 张；单张最多 10 MiB，总计最多 30 MiB。
- “截图 → 当前视口”捕获活动标签页。
- “截图 → 区域截图”在网页上拖拽选择。
- 截图先进入草稿，只有用户发送或在运行中点击“补充”后才交给模型。

当前版本不做整页滚动拼接、打印、保存 PDF 或 PDF 解析。

## 网站访问权限

所有网站访问权限用于区域截图和浏览器操作等用户发起的页面功能。拥有权限不会自动读取或发送网页。Chrome 内部页面和扩展商店页面不支持注入，但仍可使用纯聊天和文件图片。

## 历史和清理

历史和当前对话在所有标签页之间共享并实时轮询同步。同一对话只允许一个未结束任务。清空当前对话或从历史删除会话时，会先终止未完成工作，再删除其消息、任务事件、checkpoint 和执行详情；失去引用且超过宽限期的附件会在清理时回收。

## Sandbox 服务与审计

独立的 Rust 服务读取严格 JSON 配置。`address` 是插件调用 `/exec` 的完整监听地址，`web_address` 是审计页面的完整监听地址；两者都直接填写 `IP:端口`，不再拆分 `host` 和 `port`：

```json
{
  "address": "127.0.0.1:43129",
  "web_address": "127.0.0.1:43130",
  "secret": "replace-with-at-least-32-random-characters",
  "log_file": "runtime/logs/sandbox.log",
  "timeout_seconds": 120,
  "sandbox": {
    "workspace": "runtime/sandbox",
    "log_file": "logs/audit.jsonl",
    "filesystem": { "mode": "plain" },
    "tls": "off"
  }
}
```

`sandbox` 可省略：省略时直接执行 Bash，并在审计页面记录命令的开始、结束、状态与退出码；macOS 配置该对象时使用固定版本的 Agora Sandbox，并额外记录进程、文件和网络元数据。其他系统即使保留该对象，也只使用 Direct runtime 和命令级审计。Agora 启动或执行失败不会在宿主机上重跑命令。

相对的顶层 `log_file` 和 `sandbox.workspace` 从配置文件目录解析；Sandbox 内部相对的 `log_file` 从 workspace 解析。`filesystem.mode` 可为 `plain`，或使用 `{"mode":"encrypted","key":"…"}`。`tls` 可为 `off` 或 `auto`。

```bash
cargo run --manifest-path sandbox/Cargo.toml -- daemon -c sandbox/config.json
cargo run --manifest-path sandbox/Cargo.toml -- key -c sandbox/config.json -g plugin-id
```

Daemon 启动时会在标准输出打印一次带临时 fragment Token 的审计页面地址；Token 不写入日志，重启后失效。页面可查看完整命令、受执行上限约束的 stdout/stderr，以及 macOS Sandbox 的 exec、文件和网络事件。常见命令行凭据会脱敏，但命令输出不会二次脱敏，因此命令不应主动输出密钥。页面可以在一次确认后持久化清除当前执行的详细事件；执行记录和 COMMAND 行会保留，运行中的后续新事件仍会继续出现。环境变量值、文件内容和网络请求头/正文不会进入审计记录。
