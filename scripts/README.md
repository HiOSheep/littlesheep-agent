# LittleSheep 验收与维护脚本

最后更新：2026-09-26 04:21:56

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
- `pnpm run verify:html-preview-baseline` 建立 HTML 小游戏/Git/Shell 的固定基线并复核 HTML 两个入口：把静态页、内联脚本 Canvas 小游戏和多文件夹具写入隔离工作区，同一批文件分别在装机的 Chrome（回环 HTTP，参照实现）、LS 文件预览（沙箱 `srcdoc`）和 LS 浏览器标签（`webview` 来宾）里测量画面、脚本数、canvas 像素、子资源请求与首个控制台错误；UX-25 起还断言渲染后的 DOM 与计算样式（标题、`styleSheets`、`body`/`canvas` 计算色、脚本数）；UX-26 起再从 HTML 工具条点"运行 / 停止"，核对 Main 有界 loopback 服务返回的 URL 与浏览器标签一致、页面真的能玩（真实输入改变计分）、guest 无 LS bridge / 无 Node 集成、穿越与错误 token 被拒、多文件资源的 CSS / module / JSON / SVG 都 200，停止后 URL 立即拒连。另比对一个真实 Git 仓库在 CLI、Local App API 与审阅标签三处的同一份更改，并用真实终端会话记录 Shell 名称、后端、cwd、版本与编码。夹具是合成的——用户原例未提供，报告里如实标注。erify:review-refresh-errors 还覆盖 UX-27 第 4 条：并发读被合并（在飞时连点不产生新读取）、连点 5 次只有 1 次读取、伪造的旧回答不会赢过排队刷新、屏幕上的 Diff 与该 revision 的 Diff 一致、列表计数/合计与快照一致，以及 UX-25 的磁盘版本与草稿（保存成功刷新、409 可见且草稿保留、外部改写/删除的主动提示与重载、快速切换后每个标签只显示自己的文件）与静态预览相对资源（子目录/中文/空格/`#`/`%` 四例真的加载、缺失资源进提示并可重试、多文件外部样式表生效）与 UX-26 的"输入只进 guest"（宿主界面六项不变）、guest 生命周期（切标签存活、窗口缩放生效、关闭标签释放）与 guest 隔离（自成顶层帧、无 opener、弹窗在窗口边界被拒）与多文件运行（module/外部 CSS/图片/本地 JSON、真实点击、改盘后重新加载生效、重开一局）与韧性与诊断：死循环夹具（脚本先标记"已就绪"再 `while (true)`）与 `Page.crash` 之后断言主界面仍以毫秒级应答、停止与重新加载都生效；`error-page.html` 夹具断言诊断读数（`error-page.html` 夹具故意抛错并引用缺失资源：断言 Main 记到脚本报错与资源失败、工具栏显示"脚本报错 1 · 资源失败 2"、展开能看到页面原文）。门默认**不显示窗口**（隔离验收运行扣住上屏出口）：先"预热一帧"（隐藏窗口下 Chromium 不渲染，离屏 iframe 连调试目标都没有，实测 1 → 2），截图有界且失败只记录不判定；草稿那一半用隐藏窗口也成立的输入路径（聚焦编辑器输入元素 + `Input.insertText`），因此"草稿只为 dirty、预览渲染草稿、运行前先问且不启动服务"是**断言**而不是记录。
- 任务书级应用验收的范围、结果与未覆盖项集中记录在 `docs/taskbooks/application-ui-ux-taskbook-2026-09-22.md`；通过单个脚本不代表其未覆盖场景也通过。
