# 开发说明

## 环境与命令

- Node.js：`>=24.18.0 <25`
- npm：建议 11.x
- Chrome：125+

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run test:run
npm run build
npm run audit:bundle
```

Rust Sandbox 的独立检查：

```bash
cargo fmt --manifest-path sandbox/Cargo.toml -- --check
cargo test --manifest-path sandbox/Cargo.toml --all-targets
cargo clippy --manifest-path sandbox/Cargo.toml --all-targets --all-features -- -D warnings
node --check sandbox/src/web/assets/app.js
```

`sandbox/config.example.json` 使用完整的 `address` 与 `web_address`。macOS 上配置 `sandbox` 对象会加载固定 revision 的 Agora runtime；不配置时保持 Direct runtime。HTTP `/exec` 的请求与响应协议不因 runtime 改变。

`npm run dev` 只启动 Vite 资源服务；真实任务必须从加载了扩展的 Side Panel 发起。源码变更后重新构建，并在 `chrome://extensions` 刷新 `dist/`。

## 测试分层

- `tests/agent`：纯模型 Planner、执行器、重试和流持久化。
- `tests/providers`：Codex 请求、SSE、错误与通用工具接口。
- `tests/persistence`：IndexedDB、旧任务归一、Storage 和 Blob。
- `tests/side-panel`、`tests/page`：UI、附件、截图与选区。
- `tests/browser`：标签页、CDP/OOPIF 会话、页面观察、动作、虚拟鼠标和网络采集。
- `tests/release`：生产权限和产物残留审计。
- `tests/e2e`：真实打包扩展壳。

生产审计只允许已审核的 21 个 browser tools、3 个动态 Tavily tools、`debugger` 权限和
`<all_urls>` host 权限；继续拒绝 raw-CDP/任意执行工具、旧动作字段、运行时逐站授权、开发
fixture、动态代码、source map 和凭据形状。

## Provider 合约检查

```bash
CHATBROWSERX_CODEX_ACCESS_TOKEN='…' npm run check:codex
```

该命令会产生真实网络请求，但不会打印 Token 或完整回复。它只验证文本 Provider 合约，不是浏览器成功率基准。

## 实机浏览器 E2E

实机链路是显式运行的本地验收，不进入默认 `test:e2e` 或 CI。它使用生产构建、真实
ChatBrowserX Agent Loop 和 Browser Tools，并把登录态保存在仓库内已被 Git 忽略的
`.chatbrowserx-live-e2e/profile`。该 Profile 与日常 Chrome 完全隔离；删除
`.chatbrowserx-live-e2e` 会清除这套验收环境的登录态和插件设置。

首次配置：

```bash
pnpm e2e:live:setup
```

在打开的专用 Chrome 中，通过 ChatBrowserX 正常设置界面配置 Token，并完成飞书登录；
终端只检查是否已配置和是否处于目标域名，不读取或输出凭据。准备完成后运行只读场景：

```bash
pnpm e2e:live:run -- lark-messenger-read
```

当前场景只允许读取，会验证未使用截图、坐标操作、网络抓包、图片附件或提交式输入。
脱敏报告写入 `test-results/live-e2e/<run-id>/report.json`；失败不会自动重跑，也不会删除
Profile 中保留的任务详情。若需要换位置，可用绝对路径环境变量
`CHATBROWSERX_LIVE_E2E_PROFILE` 覆盖默认 Profile。

## 代码约定

- 组件使用 `PascalCase.tsx`，其他文件使用 `kebab-case.ts`。
- Chrome、DOM 与网络依赖留在 Adapter 边界。
- 模型只能调用严格、扁平且已审核的 browser schema；不得暴露任意 JavaScript、任意 CDP
  方法或页面提供的脚本。
- 浏览器 mutation 在 dispatch 前必须写 `may_have_dispatched` checkpoint；恢复时不得重复执行
  可能已经生效的动作。
- 网络采集只保留有界内存元数据，请求体永不返回，响应正文只允许显式按 ID 获取并先脱敏。
- 新页面消息必须加入判别联合与严格 Zod schema。
- 通用工具接口不等于具体工具授权；新增任何具体工具前必须先设计、测试并更新生产审计。
- 凭据永远不进入 fixture、trace、快照或错误文本。
