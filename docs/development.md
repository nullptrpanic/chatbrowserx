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

`npm run dev` 只启动 Vite 资源服务；真实任务必须从加载了扩展的 Side Panel 发起。源码变更后重新构建，并在 `chrome://extensions` 刷新 `dist/`。

## 测试分层

- `tests/agent`：纯模型 Planner、执行器、重试和流持久化。
- `tests/providers`：Codex 请求、SSE、错误与通用工具接口。
- `tests/persistence`：IndexedDB、旧任务归一、Storage 和 Blob。
- `tests/side-panel`、`tests/page`：UI、附件、截图与选区。
- `tests/release`：生产权限和产物残留审计。
- `tests/e2e`：真实打包扩展壳。

生产审计会拒绝 concrete browser/search tool 名称、旧动作进度字段、Debugger、运行时逐站授权、开发 fixture、动态代码、source map 和凭据形状。

## Provider 合约检查

```bash
CHATBROWSERX_CODEX_ACCESS_TOKEN='…' npm run check:codex
```

该命令会产生真实网络请求，但不会打印 Token 或完整回复。它只验证文本 Provider 合约，不是浏览器成功率基准。

## 代码约定

- 组件使用 `PascalCase.tsx`，其他文件使用 `kebab-case.ts`。
- Chrome、DOM 与网络依赖留在 Adapter 边界。
- 新页面消息必须加入判别联合与严格 Zod schema。
- 通用工具接口不等于具体工具授权；新增任何具体工具前必须先设计、测试并更新生产审计。
- 凭据永远不进入 fixture、trace、快照或错误文本。
