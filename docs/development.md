# 开发说明

- 文档类型：维护者操作手册
- 适用范围：当前仓库
- 约束级别：操作说明
- 日期：2026-08-15

## 环境

- Node.js：`>=24.18.0 <25`
- npm：建议 11.x
- Chrome：125+

本机默认 Node 不是 24 时，可以用临时运行时执行：

```bash
npx --yes --package=node@24.18.0 --package=npm@11.17.0 npm ci
```

不要把真实 Token、Key、网页内容、截图或 Playwright profile 加入仓库。`dist/`、`artifacts/`、测试报告和日志均已忽略。

## 常用命令

```bash
npm run dev
npm run format
npm run format:check
npm run lint
npm run typecheck
npm run test:run
npm run build
npm run audit:bundle
```

`audit:bundle` 校验固定权限/host、排除功能、E2E 残留、Node 环境变量、动态代码执行、source map 和凭据形状，并把脱敏结果写入 `artifacts/release/bundle-audit.json`。

## 加载构建

执行 `npm run build` 后，在 `chrome://extensions` 以“加载已解压”选择 `dist/`。每次源码变更后重新构建并点击扩展的刷新按钮；涉及 content script 的变更还要刷新目标网页。

## 测试分层

- `tests/tasks`：状态转换、lease、恢复、效果边界与命令。
- `tests/browser`：DOM/CDP 观察、定位、动作、路由和验证。
- `tests/providers`：SSE、合约、错误和重试。
- `tests/persistence`：IndexedDB/Storage/Blob。
- `tests/side-panel`、`tests/page`：UI、附件、截图和选区。
- `tests/release`：生产产物与范围审计。
- `tests/e2e`：真实打包扩展壳。

真实扩展测试要求 Playwright Chromium；品牌版 Chrome 新版本可能忽略命令行加载未打包扩展：

```bash
npx playwright install chromium
npm run test:e2e
```

可以用 `PLAYWRIGHT_CHANNEL` 显式覆盖 channel，但只有支持 `--load-extension` 的浏览器才可运行。测试 profile 只创建在操作系统临时目录并在结束时删除。

## Provider 合约检查

下面命令会产生真实 Codex 网络请求，但不会输出 Token 或完整回复：

```bash
CHATBROWSERX_CODEX_ACCESS_TOKEN='…' npm run check:codex
```

缺少环境变量时命令必须直接失败。它不是 20 任务浏览成功率基准；在建立完整可重复站点和 60 次报告前，不得把该检查解释为成功率证明。

## 代码约定

- 组件使用 `PascalCase.tsx`，其他文件使用 `kebab-case.ts`。
- Chrome/DOM/网络都放在显式 Adapter 后面，核心逻辑依赖端口。
- 新副作用必须先定义持久化意图和验证条件。
- 新页面消息必须加入判别联合与 Zod schema。
- 新权限、endpoint、目录职责、设置或恢复语义必须同步规范和用户文档。
- 默认不提交、不推送；凭据永远不进入 fixture、trace、快照或错误文本。
