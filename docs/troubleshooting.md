# 故障排查

## 没有看到网络请求

确认使用的是 Chrome 已加载扩展的 Side Panel，而不是 `npm run dev` 打开的普通 Vite 页面。普通 `http://127.0.0.1` 页面没有扩展 Service Worker，不能发起真实任务。

在 `chrome://extensions` 重新加载扩展后，再打开扩展的 Service Worker DevTools 和 Network。请求目标固定为 Codex Responses endpoint。

## Access Token 失效

任务会进入 `waiting_for_auth`。在设置里保存新的 Codex Access Token，返回对话后点击继续。设置页会加载并展示已保存值；错误不会回显 Token。

## 任务暂停或输出中断

- `queued` / `planning`：Worker 重启后会自动恢复。
- `waiting_for_auth`：更新 Token 后继续。
- `paused`：临时 Provider 错误重试耗尽，点击继续重新请求。
- `failed`：Provider 返回无效流或其他不可恢复响应。

当前版本没有浏览器动作、50 次预算、页面读取或工具调用。界面若仍显示这些旧文案，说明 Chrome 加载的还是旧 `dist/`；重新构建并在扩展页刷新。

## 截图或划词失败

保持目标标签页为活动页，并确认扩展拥有网站访问权限。区域截图按 Escape 会取消。Chrome 内部页面、扩展商店、密码框和可编辑区域不支持页面功能。

## 本地检查失败

- Node 必须满足 `>=24.18.0 <25`。
- `test:e2e` 需要 `npx playwright install chromium`。
- 品牌版 Chrome 可能忽略 `--load-extension`；真实壳测试使用 Playwright Chromium。
- `check:codex` 未设置环境变量时退出码 2 是预期行为。

不要在日志、Issue 或截图中公开真实 Token、Cookie、请求头、网页内容或附件。
