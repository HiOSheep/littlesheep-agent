# LittleSheep 验收与维护脚本

最后更新：2026-09-26 15:41:47

`scripts/` 保存仓库检查、构建辅助和隔离的真实 Electron 验收入口。面向 UI 的验收脚本使用独立临时数据根、确定性 Provider 和可复现夹具，不读取用户的真实会话或密钥；临时截图与日志默认留在 `%TEMP%`，脚本失败时保留现场以便诊断。

- `verify-*.mjs` 是可直接运行的验收入口；根目录 `package.json` 中的 `verify:*` 命令负责先准备对应构建，再启动门。
- `lib/electron-cdp-harness.mjs` 与 `lib/electron-acceptance-provider.mjs` 提供隔离 Electron、CDP、窗口操作和确定性模型响应的共享夹具。
- `pnpm run verify:code-wrap-control` 核对对话代码块与工作区 Monaco 的共享自动换行偏好、真实滚动/折行变化及按钮状态。
- `pnpm run verify:skills-catalog-states` 使用可控 Local App API 响应验证技能页成功空列表、错误保留、重试和快速详情切换。
- `pnpm run verify:deletion-confirmation` 验证永久删除的取消、失败保留、连点去重，并确认项目删除会清理多个归档对话记录而保留磁盘文件夹。
- `pnpm run verify:keyboard-modal-focus` 只用键盘检查模态层打开、Tab 焦点范围、Escape 分层关闭和焦点返回；在真实 Agent 写入审批中验证说明焦点、背景指针阻断、双 Escape 仅拒绝一次及无文件副作用；UX-07 之后还走一遍**对话区的键盘全流程**——从输入框起 Tab 一圈（断言按文档顺序经过"加载更早内容"、消息复制、工具行展开、代码复制与"回到最新"，且每个都带可访问名）、Shift+Tab 按元素身份原路返回输入框、逐层 Escape 只关一层且焦点回到入口、并给每一步留下截图。前进/后退期间挂载或卸载的停靠点（读者回到最新时"回到最新"按钮会消失）按共同集合比对，覆盖度另有一条断言兜底。
- `pnpm run verify:recovery-states` 核对启动恢复的五类真实状态，并验证 Escape 只收起恢复层、保留待处理现场且把焦点还给入口。
- `pnpm run verify:composer-stop-append` 验证草稿和附件存在时停止入口仍可用、停止只提交一次、补充消息去重且进入当前 run 的 Provider 请求与回答。
- `pnpm run verify:provider-editor-draft` 在真实窗口验证编辑状态、切页草稿、丢弃确认、失败保留和保存中关闭；使用固定假密钥检查丢弃后密码框、浏览器存储、隔离配置与 Electron 日志均不含该值，报告只输出布尔结果。
- `pnpm run verify:conversation-workspace-scenarios` 覆盖对话滚动/输入/工具结果/多附件/工作区双栏，并按会话分别验证文件草稿、目录与浏览器现场；`pnpm run verify:electron-ui-state-continuity` 负责隔离数据根中的真实进程退出、启动恢复与窗口/路由/阅读位置。
- `pnpm run verify:retry-feedback` 注入 429/503/401/400/超时/断流/取消，验证有界重试与中断续接，并检查普通、紧凑显示中的重试进度和紧凑失败原因。
- `pnpm run verify:review-refresh-errors` 在真实 Git 工作区里按住、注入失败或放行审阅快照与单文件 Diff 请求，核对陈旧内容始终自报状态：刷新中显示上次结果、失败分别落在各自提示并给出重试，且“重试差异”确实发出新的 Diff 请求（页面 `fetch` 探针计数）而不是复用缓存。
- `pnpm run verify:html-preview-baseline` 建立 HTML 小游戏/Git/Shell 的固定基线并复核 HTML 两个入口：把静态页、内联脚本 Canvas 小游戏和多文件夹具写入隔离工作区，同一批文件分别在装机的 Chrome（回环 HTTP，参照实现）、LS 文件预览（沙箱 `srcdoc`）和 LS 浏览器标签（`webview` 来宾）里测量画面、脚本数、canvas 像素、子资源请求与首个控制台错误；UX-25 起还断言渲染后的 DOM 与计算样式（标题、`styleSheets`、`body`/`canvas` 计算色、脚本数）；UX-26 起再从 HTML 工具条点"运行 / 停止"，核对 Main 有界 loopback 服务返回的 URL 与浏览器标签一致、页面真的能玩（真实输入改变计分）、guest 无 LS bridge / 无 Node 集成、穿越与错误 token 被拒、多文件资源的 CSS / module / JSON / SVG 都 200，停止后 URL 立即拒连。另比对一个真实 Git 仓库在 CLI、Local App API 与审阅标签三处的同一份更改，并用真实终端会话记录 Shell 名称、后端、cwd、版本与编码。夹具是合成的——用户原例未提供，报告里如实标注。erify:review-refresh-errors 还覆盖 UX-27 第 4 条：并发读被合并（在飞时连点不产生新读取）、连点 5 次只有 1 次读取、伪造的旧回答不会赢过排队刷新、屏幕上的 Diff 与该 revision 的 Diff 一致、列表计数/合计与快照一致，以及 UX-25 的磁盘版本与草稿（保存成功刷新、409 可见且草稿保留、外部改写/删除的主动提示与重载、快速切换后每个标签只显示自己的文件）与静态预览相对资源（子目录/中文/空格/`#`/`%` 四例真的加载、缺失资源进提示并可重试、多文件外部样式表生效）与 UX-26 的"输入只进 guest"（宿主界面六项不变）、guest 生命周期（切标签存活、窗口缩放生效、关闭标签释放）与 guest 隔离（自成顶层帧、无 opener、弹窗在窗口边界被拒）与多文件运行（module/外部 CSS/图片/本地 JSON、真实点击、改盘后重新加载生效、重开一局）与韧性与诊断：死循环夹具（脚本先标记"已就绪"再 `while (true)`）与 `Page.crash` 之后断言主界面仍以毫秒级应答、停止与重新加载都生效；`error-page.html` 夹具断言诊断读数（`error-page.html` 夹具故意抛错并引用缺失资源：断言 Main 记到脚本报错与资源失败、工具栏显示"脚本报错 1 · 资源失败 2"、展开能看到页面原文）。门默认**不显示窗口**（隔离验收运行扣住上屏出口）：先"预热一帧"（隐藏窗口下 Chromium 不渲染，离屏 iframe 连调试目标都没有，实测 1 → 2），截图有界且失败只记录不判定；草稿那一半用隐藏窗口也成立的输入路径（聚焦编辑器输入元素 + `Input.insertText`），因此"草稿只为 dirty、预览渲染草稿、运行前先问且不启动服务"是**断言**而不是记录。
- 应用层验收的范围、结果与未覆盖项分散记录在各自 owning 文档：`docs/decision/project-status.md`（仍然成立的当前事实）、对应的 package/领域 README（实现边界）与每个门自己的 `limits`（该门证明不了什么，以及为什么）。通过单个脚本不代表其未覆盖场景也通过。

`verify:html-preview-baseline` 的静态预览一半现在还**断言**磁盘版本与未保存草稿的四类走向：保存成功后预览换成已保存文档且草稿转 clean、外部改写提示可"重新加载磁盘版本"且提示随之消失、409 保留草稿并显示服务端原句、删除是失败色提示且文件回来后不再说"已删除"。同一个合成夹具上再走一条**改游戏自身 CSS/JS → 重新加载生效 → 进 Git 审阅 → 从 Diff 返回源文件**的顺序链（此前的 `level.json` 只改了数据）；地址栏那一步断言裸回环地址被读成 **http**（提交 `127.0.0.1:<port>/...` 后 guest 与标签 URL 都是 `http://`，且页面真的画出来，而成 TLS 的服务端并不存在），并同时断言 `GET /workspace/preview-server` 没有为这个地址起任何服务、`/development-environments` 只列 LS 自己的工具链——**LS 不替用户启动项目脚本**是结论而不是待办。`--app=packaged` 变体（`node scripts/verify-html-preview-baseline.mjs --app=packaged`）跑同一个 walkthrough：harness 不启动仓库入口、跳过构建新鲜度断言，证据里记录 `packagedExecutable` 与 `app.asar` 的 sha256（打包产物必须先由 `pnpm run package:win` 重新生成，否则测的是旧字节）。字体一项按已测边界降级：隐藏窗口下 Chromium 不发起字体请求（`document.fonts` 恒 `unloaded`），因此只断言 `@font-face` 源被改写到回环服务，这一句在门的 `limits` 里。

`verify:conversation-workspace-scenarios` 的终端步骤会断言终端面板列出真实可用的 Shell（实测包含 PowerShell 7、Windows PowerShell、命令提示符与 WSL 发行版），并检查单会话不显示标签条；该门把窗口停在所有显示器之外渲染（隐藏窗口会让截图超时，停放后渲染正常且不会出现在桌面上）

`verify:workspace-terminal`（`scripts/verify-workspace-terminal.mjs`）是终端专项真实窗口门：窗口停在屏幕外渲染，面板以终端布局打开，断言 Shell 下拉列出本机真实 Shell、初始单会话、新建后两个标签且恰好一个选中、**切回第一个标签后仍能把命令写进它自己的标记文件**、关闭当前标签只移除那一个。每次输入前先等 xterm helper textarea 的 `readOnly` 变为 false（它是 `disableStdin` 的镜像，置位时 xterm 丢弃全部输入）；"会话真的跑起来"用命令写出的标记文件判定，不看状态文字（状态行只有命令执行完才读作"就绪"）。

`verify:transcript-state-visibility`（`scripts/verify-transcript-state-visibility.mjs`）用真实窗口把"需要注意的事实"在**普通与紧凑两种显示模式**下各测一遍：未验证（`unverified`，普通模式由 `[data-transcript-verification]` 承载、紧凑模式进 `.agent-transcript-attention`）、传输失败（401 × 8，`本轮未完成` + `.run-status-error` 原文）、被停止（`本轮已停止`）、等待用户批准（运行中回合，两模式渲染一致）、以及被拒绝的写调用（真实窗口重载后由持久历史投影成 `.agent-tool-call.fail`，紧凑模式保留该行）。十张截图对应五类 × 两模式；`waiting_user` 无法在本版本产生、`部分完成` 没有对应状态这两件事写在门的 `limits` 里，不用单测替代。

`verify:chat-reading-scenarios` 覆盖对话区阅读位置：顶部/中部/底部三种起始位置在插入历史与窗口变化后都按 `data-message-key` 锚定（容差 1 px），底部位置按"贴底 gap ≤ 1"判定；`回到最新` 按钮在普通/紧凑、800×660 最小窗口与 DPR 2 下的可达性（`elementFromPoint` 命中自身、不与输入栏相交、浮在实测 `--composer-overlay-height` 之上）；并断言**切回会话时按当前产品行为跳到最新**（`gap ≤ 1`、无 `回到最新` 按钮），不再是"只记录不判定"。门里另注明：`scripts/` 没有录屏能力，任务书要求的"截图/视频"以逐帧 DOM 采样 + 前后 PNG 替代，这一条写进 `limits`。

`verify:chat-readability`（= `scripts/verify-chat-output-readability.mjs`）把来源区块 `.web-sources` 纳入对比度/字号/横向溢出/可复制取样，并断言长工具结果的三条既有保证（默认折叠、摘要 ≤ 180 字符、展开后 `pre` 限高 180 px 且自己滚动）；DPI 一档从单一 2 扩到 1.25/1.5/2，并在 `limits` 里写明这是 CDP 设备像素比模拟、不是真实 Windows 缩放会话。

`verify:chat-streaming-rendering` 除逐帧样式签名外，还断言同一夹具在**紧凑模式**下与**重载后重开同一会话**时渲染出的结算文本与持久化 settlement 一致、复制按钮写入剪贴板的文本等于持久化文本；用户报告的"流式文字变色"在该固定输入下未能复现（每类块全程只有一个样式签名），继续追所需的复现输入与"重载后重开"这一步的边界都写在 `limits` 里。

`verify:workspace-large-directory` 在 1,000/10,000 个文件的隔离目录中检查 Main 的 320 行上限、筛选后再截断带来的上限外文件可达性、逐键稳定时间、320 行 Tab 导航及滚动布局成本；门里同时记录"不做虚拟化"的依据（未截断时的创建/布局成本随行数单调上升）。`verify:review-refresh-errors` 还断言连续 409 有界停止和持续 Git 状态变化时的 `unstable` 提示。

`verify:electron-ui-state-continuity` 另建第二个工作区根，走"root A → 项目 root B → B 内新建会话 → 重启应用 → 回到 A"的往返，断言：B 的文件树只列 B 自己的文件、`GET /workspace/review` 对非活动根返回 **403** 而活动根 200、切换后终端 0 会话，以及重启后未保存草稿（`draftRestored: true`）、文件标签的 dirty 状态、浏览器标签与展开目录都还在。该门为此修掉三处验收脚本缺陷：草稿输入落进文件导航的筛选框（把整棵树筛空）、没等 Monaco 的可编辑表面就开始打字、以及 `Page.reload` 之后 CDP 执行上下文失效而不重连。
