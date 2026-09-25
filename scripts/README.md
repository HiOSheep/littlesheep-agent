# LittleSheep 验收与维护脚本

最后更新：2026-09-25 18:37:00

`scripts/` 保存仓库检查、构建辅助和隔离的真实 Electron 验收入口。面向 UI 的验收脚本使用独立临时数据根、确定性 Provider 和可复现夹具，不读取用户的真实会话或密钥；临时截图与日志默认留在 `%TEMP%`，脚本失败时保留现场以便诊断。

- `verify-*.mjs` 是可直接运行的验收入口；根目录 `package.json` 中的 `verify:*` 命令负责先准备对应构建，再启动门。
- `lib/electron-cdp-harness.mjs` 与 `lib/electron-acceptance-provider.mjs` 提供隔离 Electron、CDP、窗口操作和确定性模型响应的共享夹具。
- `pnpm run verify:code-wrap-control` 核对对话代码块与工作区 Monaco 的共享自动换行偏好、真实滚动/折行变化及按钮状态。
- `pnpm run verify:skills-catalog-states` 使用可控 Local App API 响应验证技能页成功空列表、错误保留、重试和快速详情切换。
- `pnpm run verify:deletion-confirmation` 验证永久删除的取消、失败保留、连点去重，并确认项目删除会清理多个归档对话记录而保留磁盘文件夹。
- `pnpm run verify:keyboard-modal-focus` 只用键盘检查模态层打开、Tab 焦点范围、Escape 分层关闭和焦点返回；在真实 Agent 写入审批中验证说明焦点、背景指针阻断、双 Escape 仅拒绝一次及无文件副作用。
- `pnpm run verify:recovery-states` 核对启动恢复的五类真实状态，并验证 Escape 只收起恢复层、保留待处理现场且把焦点还给入口。
- `pnpm run verify:composer-stop-append` 验证草稿和附件存在时停止入口仍可用、停止只提交一次、补充消息去重且进入当前 run 的 Provider 请求与回答。
- `pnpm run verify:provider-editor-draft` 在真实窗口验证编辑状态、切页草稿、丢弃确认、失败保留和保存中关闭；使用固定假密钥检查丢弃后密码框、浏览器存储、隔离配置与 Electron 日志均不含该值，报告只输出布尔结果。
- `pnpm run verify:conversation-workspace-scenarios` 覆盖对话滚动/输入/工具结果/多附件/工作区双栏，并按会话分别验证文件草稿、目录与浏览器现场；`pnpm run verify:electron-ui-state-continuity` 负责隔离数据根中的真实进程退出、启动恢复与窗口/路由/阅读位置。
- `pnpm run verify:retry-feedback` 注入 429/503/401/400/超时/断流/取消，验证有界重试与中断续接，并检查普通、紧凑显示中的重试进度和紧凑失败原因。
- `pnpm run verify:review-refresh-errors` 在真实 Git 工作区里按住、注入失败或放行审阅快照与单文件 Diff 请求，核对陈旧内容始终自报状态：刷新中显示上次结果、失败分别落在各自提示并给出重试，且“重试差异”确实发出新的 Diff 请求（页面 `fetch` 探针计数）而不是复用缓存。
- 任务书级应用验收的范围、结果与未覆盖项集中记录在 `docs/taskbooks/application-ui-ux-taskbook-2026-09-22.md`；通过单个脚本不代表其未覆盖场景也通过。
