# 故障排查

- 文档类型：用户与维护者排障说明
- 适用范围：当前实现
- 日期：2026-08-15

## Side Panel 显示后台不可用

点击“重新连接”。如果仍失败，在 `chrome://extensions` 查看扩展 Service Worker 错误，然后重新加载扩展。对话和任务保存在 IndexedDB，普通 Worker 重启不会清空。

## Access Token 失效

任务会进入 `waiting_for_auth`。在设置中填写新的 Codex Access Token，保存后返回任务继续。Token 必须包含可解析的 ChatGPT account claim；错误只显示标准认证类别，不回显 Token。

## 网站无法授权或操作

- 确认当前页面是 `http://` 或 `https://`。
- 在授权卡片点击“授权此网站”；拒绝后 Chrome 不会让后台静默重试请求。
- 导航到另一个 origin 后需要重新授权。
- `chrome://`、扩展商店、浏览器内部页面和受保护页面不支持。

## Debugger 冲突或断开

打开 DevTools 或其他调试扩展可能占用同一标签页的调试连接。关闭冲突工具后继续任务。ChatBrowserX 会尝试重新观察；任务完成、暂停/取消的 runner 退出时会释放所有持有的调试会话。

## 任务中断、停住或原标签页消失

- `queued/observing/planning/acting/verifying/checkpointed`：等待自动恢复扫描；也可重新打开 Side Panel 触发扫描。
- `waiting_for_tab`：切到替代网页并点击继续，系统不会自行选择一个无关标签页。
- `waiting_for_confirmation`：检查展示的动作和目标，再确认或取消。
- `paused`：Provider 重试或预算耗尽时需要手动继续。
- `failed`：展开事件查看标准失败类别；聊天内容仍保留。

## 截图失败

保持目标标签页为当前窗口的活动标签页，并确认当前 origin 已授权。区域截图时按 Escape 会取消，不会创建空附件。自动视觉兜底捕获失败只会回退语义观察，不会中断任务。

## 选中文本气泡不出现

先在 Side Panel 授权当前网站。选区不能位于密码框、`contenteditable` 区域或扩展 overlay 中，且不能超过 8,000 字符。授权后若页面很早已打开，可刷新页面或重新打开 Side Panel 触发注入。

## 本地开发检查失败

- Node 必须是 24.18.x；系统 Node 25 可能与当前工具链不兼容。
- `test:e2e` 需要先执行 `npx playwright install chromium`。
- 品牌版 Google Chrome 可能忽略 `--load-extension`；使用 Playwright Chromium。
- `check:codex` 缺少环境变量时退出码 2 是预期行为。

日志和错误不得粘贴真实 Token、Key、Cookie、完整网页内容或图片。当前版本没有“导出诊断包”；可分享测试命令、标准错误码、Chrome 版本和不含敏感信息的事件类型。
