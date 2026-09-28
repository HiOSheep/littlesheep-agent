# @littlesheep/app

最后更新：2026-09-28 13:40:25

Beta 的标题栏与侧栏共用同一个 L 形底层材质，子区域不再各叠一层玻璃；交接处没有色差或分隔。两种窗口布局均已移除标题栏里的 LittleSheep 文字和小羊图标，侧栏自身内容不受影响。

窗口布局按原生窗口状态切换：普通窗口使用 Chali（侧栏贯通顶边、实体标题栏只覆盖右侧），最大化或系统全屏使用 Beta（整宽玻璃标题栏、下方侧栏与聊天/工作区）。Windows 11 22H2+ 使用系统 Acrylic 透出应用后方窗口，macOS 使用 vibrancy；不支持的系统保留实体底色。启动页仍保持独立实体底色。三个窗口导航控件（侧栏开关、返回、前进）钉在窗口左上角：它们是窗口镶边层（`z-index: 1003`，与设置入口同层）里的固定层，不随侧栏展开、折叠或拖宽移动，所以折叠侧栏后唯一的展开入口不会跟着顶部条滑走；真实窗口在展开 / 折叠 / 拖宽中三态实测坐标逐像素相同，顶边依旧可拖（细节见 `src/renderer/README.md`）。验证：scripts/verify-window-layout.mjs（三态坐标、按 1px 采样顶边拖拽覆盖与真实指针拖动；加 --desktop-backdrop 检查真实桌面合成）。

LittleSheep 的 Electron 桌面应用。Agent Runner、记忆、工具、会话和可选渠道在主进程中装配；React renderer 通过 loopback Local App API 与主进程通信。

运行时基线（2026-09-27）：Electron 从 **36.9.5（Chromium 136 / Node 22）**升到 **44.4.5（Chromium 152 / Node 24.21）**。最近的起因是终端圆角要用 Chromium 139+ 的 `corner-shape`（见 `src/renderer/README.md`），但 39 早已不在 Electron 只维护最新三个大版本的窗口内，所以直接落到当前稳定线。两个原生依赖（`node-pty`、`@huggingface/transformers` 及其 onnxruntime-node）都是 N-API，与 Electron 36 下安装的是同一份二进制，升级后在主进程内实测直接加载成功，**无需重编**；`electron-vite` 仍是 2.3.0，main/preload 的 1340 个模块照常转换。**`docs/reference/cold-start-baseline/` 下的记录全部标着 `electronVersion: 36.9.5`，描述的是 Chromium 136 / Node 22 上的测量，跨版本对比前必须重跑 `pnpm measure:desktop-cold-start`（及 `measure:desktop-first-token`、`measure:desktop-large-history-startup`、`measure:desktop-large-root-startup`）。**

升级 `electron` 依赖**不会**顺带换掉本机那份运行时副本，这一步是显式的。`scripts/prepare-littlesheep-runtime.mjs` 按**当前已安装的 Electron 版本**生成 `packages/app/runtime/electron-v<版本>-<平台>-<架构>/LittleSheep.exe`，并在 `node_modules/electron/dist/` 放一份同名 alias 供 `electron-vite` 启动；它挂在 `predev` 和 `prebuild` 上，所以 `pnpm run dev` / `pnpm run build` 各自先跑一次。`runtime/` 下本该只留一个 `<版本>-<平台>-<架构>` 目录：`electron-v36.9.5-win32-x64/` 是旧版本留下的孤儿，带 `-<毫秒时间戳>` 后缀的则是运行时被判定不完整时另建的新副本（原目录可能正被在跑的进程占用）。两者都是安装产物，被 `.gitignore` 忽略、不进 Git，确认新副本完整后可以删除，每个约占 290 MB。**桌面快捷方式也在同一条链路上**：`scripts/sync-desktop-shortcut.mjs` 挂在 `predev` / `prebuild` 之后（根目录 `build:app` 亦然），把快捷方式指向 prepare 刚产出的运行时，所以升级 Electron 后从桌面图标启动不会再停在旧引擎上。它默认尽力而为——非 Windows、桌面本来没有快捷方式、`packages/app/out` 还没构建出来，都只报告原因并退出 0，不会挡住 `pnpm run dev`，真正的失败也只警告而不中断；显式创建或排错用 `pnpm run refresh:desktop-shortcut`。`scripts/refresh-desktop-shortcut.ps1` 在目标、参数、工作目录、图标四项已一致时**不重写**文件——重存 `.lnk` 会丢掉资源管理器保存在文件之外的状态（图标位置、固定状态）——`-Force` 强制重写，`-IfPresent` 供上面那条尽力而为路径使用。本次升级已实测该路径：`runtime/electron-v44.4.5-win32-x64/LittleSheep.exe` 报 Electron 44.4.5 / Chromium 152.0.7977.130 / Node 24.21.0（N-API 10），`CSS.supports('corner-shape', 'squircle')` 为真、`squircle` 的计算值是 `superellipse(2)`。应用实际采用的指数是 **`superellipse(1.5)`**，不是 `squircle`：同一个 `border-radius` 下角框（半径×半径）被让出的面积，普通圆弧 21.5%、`superellipse(1.5)` 12.3%、`squircle` 只有 6.9%，也就是角只读起来普通圆角半径的 0.76x / 0.57x——`squircle` 会让 `10px` 的表面令牌看着刚过 5px。选 1.5 是为了让拐弯看得出来，同时一个半径令牌、一个控件尺寸都不动（依据、实测与取舍见 `src/renderer/README.md`）。

运行中补充由 Local App API 写入当前 run 的事件队列，再由 Harness 在安全边界送进同一执行循环；Renderer 按事件身份显示一次用户消息。停止与补充的隔离窗口验收见 `pnpm run verify:composer-stop-append`。

应用层这一轮（UX-32～UX-38）改了三条用户可见的边界，细节在各自的领域 README，汇总在[项目状态](../../docs/decision/project-status.md) 的"应用层 UI 与工作区"一节：终端同一时刻只读一个会话（每会话一条 SSE 会耗尽浏览器对同一 origin 的 6 条 HTTP/1.1 连接），切回的会话保持键盘可用、重放不再让终端重答设备查询；目录筛选下推到 Main 的 320 项截断之前；对话区的验证结论在普通显示模式下也有独立一行。真实窗口门：`verify:transcript-state-visibility`、`verify:conversation-workspace-scenarios`、`verify:workspace-terminal`、`verify:html-preview-baseline`（含 `--app=packaged`）。

- **冷启动三段式**：窗口早于执行能力出现。①数据根迁移、用户布局、keychain、config、Memory v3（顺序是任何写入者的前置条件）；②UI 索引 + Local App API 监听 + 窗口加载渲染器；③Runner 与 RunRouter 建成后发布执行就绪。可选插件宿主在就绪之后异步加载，不阻塞执行能力。

界面材质（2026-09-27）：输入栏弹出的添加菜单、权限/模型选择器与运行时选择器（含子菜单）与输入框是同一块半透明磨砂玻璃且不带描边——材质只在 `src/renderer/styles/06-composer.css` 的一条共享规则里声明，并且真正生效：`.composer` 自带 `backdrop-filter` 会让它成为弹层的 backdrop root、把添加菜单与权限选择器的模糊变成空操作（Chromium 152 实测条纹残留约 60/255 对输入框约 1/255），现已把材质挪到内缩的 `.composer::before`（`.composer` 只给 `position: relative`、不新增堆叠上下文），并把三个弹层的圆角对齐到输入框的 `var(--radius-composer-input)`（14px）、阴影收敛成同一份；执行过程中模型说的话回到正文色（`.agent-transcript-prose`），步骤、工具与思考摘要仍保持 muted；侧边栏的玻璃另叠了一层从上到下的淡蓝→淡紫晕色（工作区面板不染色）；工作区树的文件夹与文件图标改成圆角字形并按各类型官方标识着色（文件夹琥珀色圆角板、文件圆角纸张 + 类型标记），展开缩进引导线改为随指针淡入淡出（默认隐藏），工作区两个筛选框去掉描边、只用填充区分。代码换行按钮按状态画两个不同图标（不换行／自动换行）。设置页不画框线，行、字段、卡片与徽标一律靠填充区分（语义色条、行分隔线与模态边界保留）。设置页正文按"分组卡片 + 行"组织，开关为蓝色胶囊。会话行行尾提供置顶 / 归档 / "…" 三个快捷控件；审阅 diff 的标题行改用代码区表面色，不再在审阅界面顶部留下一块更亮的横带。任务胶囊从标题栏迁到聊天区最上方（侧边栏右侧的点击穿透浮层），宽度自适应，双击标题就地重命名，展开后「进行中」指令可终止、「已结束」过长自动折叠，胶囊与浮层同为输入框同款磨砂玻璃；聊天内容的上缘不超过胶囊上缘、下缘不超过输入框下缘。细节与实测值见 `src/renderer/composer/README.md`、`src/renderer/chat/README.md`、`src/renderer/sidebar/README.md` 与 `src/renderer/ui/README.md`。
- **右侧可用性**：拓展工作区进面板即可读目录与预览文件，不等待 Runner；两个可用性指标（首个目录行、首个文件正文可见）只在 `LITTLESHEEP_BOOTSTRAP_TIMING=1` 时由渲染器上报，配对测量见 `docs/reference/cold-start-baseline/` 的 CS-08 一节。
- **首屏按需加载**：Monaco、mermaid 与 `react-syntax-highlighter` 都不得进入入口 chunk。完整 Prism 构建单独求值约 380 ms，改为按需后入口 chunk −936 KB、真实首帧早约 148 ms（成对实测见 `docs/reference/cold-start-baseline/`）。**入口字节数在本应用里不是首帧的可靠代理**：Markdown 解析管线整条按需（−400 KB）与 dompurify 按需（−49 KB）都实测无收益并已回退，新增加载态前必须用成对实测证明收益。
- **就绪是唯一事实**：`src/shared/runtime-readiness-{contracts,ipc}.ts` 定义载荷与通道，`src/main/runtime-readiness.ts` 拥有状态，renderer 经 `src/renderer/runtime-readiness/` 消费。未就绪时 metadata 路由照常应答、Runner 依赖路由以 503 `runtime-not-ready` 失败关闭；具体边界见 `src/main/local-app-api/README.md`。正常启动的阶段文字只在发送按钮旁就地显示（`composer-readiness-hint`），横跨整窗的条带只用于失败态与重试（CS-09）。
- **恢复期仍可使用，且恢复不再挡在执行就绪前面**：启动恢复（活跃 run、过期租约、中断的续跑、已完成 run 的对账）在 Runner 发布**之后**开始，结果保存在 `src/main/run-recovery.ts` 的 promise 里，只有真正依赖它的路径才等待——带 `sessionId` 的 run 入口（`POST /runs`、`POST /runs/stream`）和全部检查点路由（发现、详情、放弃、续跑）。**全新对话**（没有 `sessionId`）不等待，因为不存在的会话不可能有历史可恢复（`isFreshConversation`，测试钉住）。对旧版事件分区的完整兼容扫描仍随后异步进行，且**仍然不等待**：`recoverDurableRun` 每次重读该 run 的租约并失败关闭，所以它不会接管一个正在跑的同名 run。恢复也会放过本进程正在跑的续跑（`RunRouter` 把活动 run 注册表作为 `isRunActive` 传进去），否则它会把用户刚续跑的那次运行当作死进程留下的租约释放掉——这是改成并发后实测到的一次真实回归（disposition 由 `resumed` 变 `interrupted`）。事件存储初始化只确保根目录存在，分区内容在读取、写入或后台恢复时逐段严格验证。会话索引、配置和工作区接口在恢复期间继续应答；执行入口在路由尚未建成时明确返回 503。
- **启动恢复的诊断计数按最近一次扫描**：`src/main/local-app-api/run-checkpoint-view.ts` 把 store 的扫描结果投影成两个互斥计数（`invalidFiles` = 读不出来的记录数，`warningCount` = 不属于这些记录的目录级发现），`src/renderer/runtime-recovery/` 只负责如实展示。计数不再按进程生命周期累加，因此用户反复点"重新检查"不会把同一份坏记录越算越多（实机验收见 `pnpm run verify:recovery-states`，领域实现见 `@littlesheep/runner` 的 `run-checkpoint-scan.ts`；HTTP 契约与假 Runner 夹具见 `src/main/README.md` 的"测试与修改定位"）。
- **一个功能只有一个名字**：同一功能从聊天、设置总览、设置侧边栏和工作模块直入页进入时，标题与导航条目必须同名，关闭设置回到打开设置前的那一页；面向用户的文案只描述当前可用能力（术语表见 `docs/principles/ui-interaction-guidelines.md`，源码扫描见 `terminology.test.ts`，真实窗口走查见 `pnpm run verify:settings-navigation-terminology`）。
- **窄窗口与缩放下的表单可用性**：关键按钮必须始终可达（含滚动后可达），输入字段不得被压缩到无法输入，页面不出现非必要横向滚动，长路径既能完整查看也能复制。供应商模型行在 560px 以下由四列改为堆叠并显示每字段标签（实测最小窗口下原布局只剩 62px/44px，见 `src/renderer/README.md` 的 `styles/` 条目）；五组窗口×缩放组合的走查见 `pnpm run verify:narrow-high-dpi-forms`。
- **失败留在发起处**：供应商保存、阈值保存、渠道重载、插件启停、文件保存五类写操作都必须在本页显示失败与下一步（`src/renderer/ui/feedback.ts` 的 `tone` 字段决定 `status`/`alert` 与色调，长错误有界折叠），不要求用户回到聊天区找错误；工作区文件保存的状态行还要跨过它自己触发的那次预览刷新。五类注入见 `pnpm run verify:async-feedback`。
- **不可逆删除先讲清范围**：归档项目删除说明随项目移除的归档对话数和本地消息记录，并确认磁盘目录保留；供应商删除说明模型条目、当前模型依赖、密钥库与对话记录边界。真实窗口门 `pnpm run verify:deletion-confirmation` 覆盖取消、Escape、失败重试、归档项目多会话清理及删除连点只提交一次。
- **陈旧数据必须自报状态**：Git 审阅在刷新进行中、更新失败或差异仍属于上一个 revision 时，旧结果必须说明自己是旧的——快照与单文件 Diff 各自成条、各自带重试，快照失败还要报出上次成功读取时间；提示的文案与色调只由 `src/renderer/workspace/review-refresh-notice.ts` 派生，视图不写提示句子。真实窗口门 `pnpm run verify:review-refresh-errors` 会按住、注入失败并断言“重试差异”真的发出新请求。
- **HTML 预览要留住文档本身，也不要留下空帧**：净化按整份文档处理并放行 `title`（否则 `<head>`/`<style>` 被丢，重样式页面退化成黑字白底），`meta`/`link` 仍禁止；帧只为真实内容创建、并按文档摘要做 `key`（`srcdoc` 在帧加载初始空文档时被更新会被 Chromium 忽略，留下永久空白）。静态预览不运行脚本、不发起网络请求，并在帧上方明说这一点。本地相对资源（`<link>`/图片/CSS `url()`/字体）在沙箱帧里加载不到——出路是"运行"而不是放宽 sandbox。真实窗口门 `pnpm run verify:html-preview-baseline` 逐项读取渲染后的 DOM 与计算样式（标题、`styleSheets`、`body`/`canvas` 计算色、脚本数）。
- **跑起来的东西走"运行"，不走预览**（UX-26）：HTML 工具条的 **运行 / 停止** 请求 Main 的 `/workspace/preview-server`——一个有界、只绑 loopback、URL 带随机 token 的静态服务，范围限定所选工作区，只答 `GET`/`HEAD`，路径解码 + `realpath` 双重校验（穿越、符号链接逃逸、错误 token 都拒），无目录列表、无 CORS、有界数量与空闲回收；成功后经既有浏览器 guest 打开该 URL（独立分区、无 LS preload / IPC / Node 集成）。运行**只用磁盘上的版本**：有未保存草稿时先问"保存并运行 / 取消"，保存失败不运行；停止即释放服务，界面显示"运行服务已停止；页面重新加载会失败。"。它不代理进程、不执行项目脚本、不安装依赖——需要构建的项目仍走用户自己的开发服务。
- **右侧工作区的导航占位是布局契约**：普通目录导航由 `.workspace-shared-file-navigator` 这个 flex 项占位，而审阅标签的导航是审阅表面的直接子元素——只有 `position: absolute` 时它会盖住 Diff 表面和标题行按钮（UX-18 实机验收测得两组按钮落在同一矩形，指针不可达）。`src/renderer/styles/04-workspace.css` 的 `.workspace-files > .workspace-files-navigator` 规则让它留在行内，改动这块样式前先读 `src/renderer/README.md` 的 `styles/` 条目与 `pnpm run verify:review-navigator-width`。
- **代码换行偏好跨两个代码界面共享**：Markdown 代码块的头部栏在高亮与纯文本回退路径中相同；`CodeWrapToggle` 与工作区 Monaco 读取 `littlesheep.ui.codeWrap`。默认关闭、开启后即时同步并记住状态。`pnpm run verify:code-wrap-control` 在隔离 Electron 窗口实测了水平溢出变化与 Monaco 折行行数。
- **重启保留当前入口**：启动时恢复上次会话只装载会话历史与工作区，不会覆盖应用关闭前保存的设置页或模块路由；用户手动切换会话仍返回对话。真实退出/重开验收见 `pnpm run verify:electron-ui-state-continuity`。
- **技能目录的空态与失败各有真实证据**：`MemorySkills.tsx` 只有 Runtime 成功返回空数组才显示“暂无技能”；列表刷新失败保留旧列表，详情失败保留可重试的选择。`pnpm run verify:skills-catalog-states` 的隔离窗口门覆盖 loading、成功有数据、成功空数组、列表/详情失败与详情快速切换。
- **没有模型时的第一步是可用路径**：输入栏的选择器把"还没配置""配置读取失败""已保存但不可用""可用但还没选模型"分成四种事实（`src/renderer/composer/runtime-availability.ts`），空菜单直接给出"配置模型 / 检查供应商配置 / 重试读取"，打开设置只是路由切换、不清空草稿与附件；自定义供应商保存的模型条目是元数据对象，因此 Runtime 的模型引用校验必须按解析后的 id 比较（`src/main/local-app-api/runtime-routes.ts`）。整条路径由 `pnpm run verify:no-model-config-loop` 在真实窗口走查。
- **发不出去的提交必须被拒绝，并说明原因**：发送入口（按钮与 Enter 是同一条入口）按 `src/renderer/composer/send-readiness.ts` 的同一判据拒绝——执行不可用，或没有选中可用模型。后一种此前会真的发出去：默认模型引用 `openai/gpt-5.6` 指向没有密钥的供应商，实测那一轮停在"正在工作"1 分 14 秒、零字符、无错误也无结算。原因就地显示在控件旁（`composer/send-block-notice.tsx`），禁用控件的可访问名携带同一句，空对话文案也说同一件事而不是邀请一次发不出去的任务；ChatGPT / Cursor / VS Code 同样拒绝这种提交并把人指向模型设置。真实窗口门：`pnpm run verify:composer-send-gate`（未配置时拒绝、不产生 run、不建会话；配置好后照常发送并结算）。
- **输入框默认拿到光标**：窗口刚可用和新建对话都要把光标放进输入栏（ChatGPT / Claude / Cursor / VS Code 的同一约定），此前实测两种时刻 `document.activeElement` 都是 `BODY`，真实按键什么也插不进去。归属判据在 `src/renderer/composer/focus-routing.ts`，接线在 `use-composer-focus.ts`；对话框、审批提示和用户自己移走的焦点都不被抢。真实窗口门：`pnpm run verify:composer-focus`。
- **草稿跟着对话走，不跟着窗口走**（P1，2026-09-28）：一份草稿是文字加它旁边的附件卡片，此前两者都是应用壳里的单一全局值，切换对话不碰它们——实测在全新对话里打一段草稿再点侧栏另一个对话，转录切换了而输入栏仍握着上一个对话的草稿且发送可用，按 Enter 就发到错误的线程，附件卡片携带的也是另一个对话的工作区路径。现在按 `currentSession ?? 'draft'` 分槽保存（`src/renderer/app-shell/composer-drafts.ts` 持有地图与两个迁移，`use-composer-drafts.ts` 是 React 半边）：打开一个对话显示**它自己的**草稿（没有就是空的、发送控件随之禁用），切回来逐字恢复，发送只清被发送的那个对话；运行结算成新会话、当前对话被归档或删除这类没人导航的迁移把草稿带走而不是丢掉。`persistent-state.ts` 仍只持久化它原来那一条记录（跨对话的草稿地图是运行时状态，不是新的持久化格式）。真实窗口门：`pnpm run verify:composer-draft-scope`。
- **渲染器接管之前的启动失败也必须能重试**：渲染器从未加载时错误只由独立启动失败页承载，而重试控件此前只存在于 React 通知条（`src/renderer/runtime-readiness/runtime-readiness-notice.tsx`）里，那条路根本没挂载过。现在 `src/main/desktop-startup-page.ts` 的失败卡片自带一个 `重试启动运行能力` 按钮，经 preload 既有的 `retryExecution()` 走 Main 的有界重试，并如实显示 Main 的答复；`src/main/index.ts` 的重试在"启动根本没走到配置阶段"时重跑整个 `bootstrap()`（失败点之前幂等、之后什么都没跑过），成功后把窗口交给渲染器。真实窗口门：`node scripts/verify-startup-failure-retry.mjs`。
- **启动计时**：`LITTLESHEEP_BOOTSTRAP_TIMING=1` 时主进程、Runner 基础设施与 renderer 自报首帧输出同一格式的 `[bootstrap-timing]` 阶段标；五时间点基线与回归护栏见 `docs/reference/cold-start-baseline/`。Runner 侧的 durable 存储并行初始化后，该阶段墙钟 36–40 ms → 10–13 ms、Runner 构建 114–116 → 99–101 ms（净约 14 ms，属阶段级收益，不声称首次可执行变快）。**2026-09-27 起 `execution-ready` 只包含发布本身**：启动恢复整体移出该窗口，`run-recovery-start` / `run-recovery-runs-ready` / `run-recovery-resumes-ready` / `run-recovery-ready` / `run-recovery-settled` 与 `runner-durable-inbox-deferred-read`、`runner-rebuilt` 是它的新标，全部出现在 `execution-ready` **之后**。大根夹具实测 `execution-ready` 10002 ms → 0.9 ms（冷）、2718 ms → 0.8 ms（温）；同一份数据上 `runner-infra-durable-inbox-ready` 183 ms → 53 ms、`runner-infra-durable-run-leases-ready` 198 ms → 15 ms（冷）；`spawnToReadyMs` 25098 → 12852（冷）、7773 → 1757（温），剩余差距由影子 Git 的 `versioning.initialize()` 支配，不属于本模块。
- **启动失败页可取证**：`src/main/desktop-acceptance-actions.ts` 只在 `LITTLESHEEP_ELECTRON_ACCEPTANCE=1` 时装配隔离验收动作（`/application/acceptance` 的 `resize` / `startup-error` 等），后者把真实失败文案交给生产同一份 `showStartupError` 文档，使 CS-02 能对"启动失败"这一无法靠等待到达的状态取像素证据；生产运行不挂载这些动作。
- **验收运行不占用用户的屏幕**：隔离验收脚本经调试协议驱动真实渲染器，窗口只需存在而不必可见——`desktop-visual-acceptance.ts` 判定"这次是否扣住窗口"，`desktop-shell.ts` 把这条判定放在**唯一的上屏出口 `showWindow()`** 里（启动页、渲染器就绪、恢复几何、`show()` 全部经过它；只在 `show()`/`showStartup()` 上设卡会漏掉内部调用，实测窗口照样弹出）。需要像素的检查必须先经验收动作显式放行，顺序有单元测试钉住。生产启动不受影响。**副产品（实测）**：窗口隐藏时渲染器仍报 `document.visibilityState === 'visible'`、DOM 与输入管线照常工作（`Input.insertText` 能改编辑器模型并让面板变脏），但 Chromium 不做布局与绘制——`.view-line` 为 0，**离屏 iframe 也没有调试目标**；一次 `Page.captureScreenshot` 会强制出帧，之后帧目标才出现（实测目标数 1 → 2），验收门因此先"预热一帧"再读帧内文档；隐藏窗口下的截图很慢（实测 5 s，下一次 12 s 超时），所以截图已改成有界、失败只记录不判定。
- **HTML 运行入口是"运行 / 重新加载 / 停止"**（UX-26 第 1 条）：静态预览不执行脚本，运行经 Main 的有界 loopback 服务在既有浏览器 guest 里打开；运行中"运行"按钮禁用（避免再开一个标签），"重新加载"以 URL 寻址的窗口事件让**显示该页面的那个标签**重新加载（不重启服务，保存到磁盘的改动因此生效），停止释放服务。真实窗口验收在 `pnpm run verify:html-preview-baseline`。
- **UX-26 的六条全部完成**（2026-09-26）：HTML 工具条 运行/重新加载/停止、Main 有界 loopback 服务、guest 隔离与 Main 硬约束、项目范围校验、诊断读数（脚本报错/资源失败/服务停止 + 死循环与崩溃韧性）、真实窗口验收（canvas 有画面、输入改变计分、输入不触达宿主界面、重开一局、多文件 module/图片/JSON、切标签/缩放/关闭后释放）。唯一还剩的收尾：声音夹具接进门（目前只有一次性探针证据：点击播放后 `paused === false`）。
- **打开的文件是否还是磁盘上的版本会主动提示**（UX-25 第 3 条）：预览面板每 5 秒用 `GET /workspace/file-stat` 比对 `modifiedAt`，"磁盘上的版本已变化"给"保留我的修改 / 重新加载磁盘版本"，"文件已不在磁盘上"是失败色；草稿永远不会因为提示被丢弃，保存失败的 409/413/415/403 直接显示服务端可执行的原因。
- **静态预览的相对资源走 Main 校验的回环服务**（UX-25 第 2 条）：预览帧仍是 `sandbox=""` 且 `connect-src 'none'`，但 `img`/`link rel=stylesheet`/`@font-face` 等相对引用会被改写成 Main 有界服务的地址（每次请求都按工作区根校验真实路径），因此子目录、中文、空格、`#`、`%` 名称都能加载，缺失资源在预览上方以"N 个资源未能加载（查看详情）"列出并可重试；CSP 里的 `http(s)` 已移除，提示语承诺的"不发起网络请求"成立。
- **guest 的硬约束在 Main，不在渲染器**（UX-26 第 3 条）：`<webview webpreferences>` 是渲染器写的，Main 在挂载时重写并拒绝不合规的挂载——无 Node 集成、contextIsolation/sandbox 开启、分区固定为内嵌浏览器分区、**preload 与 additionalArguments 一律删除**、非 http(s) 来源直接拒绝（`embedded-browser-hardening.ts`，3 例单测）。真实窗口实测 guest 自成顶层帧、`window.opener === null`、`window.open` 返回 null（弹窗被拒并路由成 LS 标签）、无 LS bridge、无 Node、空存储。
- **运行中的页面自己报告问题**（UX-26 第 3 条）：`embedded-browser-diagnostics.ts` 在 Main 侧保有一份有界记录（40 条、消息截断、逐出最旧），渲染器在"运行"提示旁显示"脚本报错 N · 资源失败 M（查看详情）"，展开是页面原文。**两条来源缺一不可**：`console-message` 只报页面自己抛的错（实测缺失样式表与图片完全不产生 console 消息），子资源 4xx 与连接被拒来自 session 的 `webRequest.onCompleted/onErrorOccurred` 并以 `referrer` 归到页面上；用户因此不必打开 DevTools。真实窗口验收见 `pnpm run verify:html-preview-baseline`（`error-page.html` 夹具：脚本报错 1 + 资源失败 2）。
- **会话累计缓存命中**：composer 的上下文指示器除窗口占用外，还显示**本会话累计**的缓存命中率与 `缓存读取 / 输入` 原值。该值由主进程 `buildSessionContextUsageRecord` 按会话汇总每次 run 的 provider 用量（`cachedPromptTokens / promptTokens`，**含冷启动**、不含压缩等分离调用），与验收账本、`check:cache-acceptance` 用的是同一组字段与同一公式；`requestsWithoutUsage > 0` 时明确标注"usage 未上报"，不把局部读数当成完整读数。展示层四舍五入，判定层一律用精确值。

## 应用层交互基线

以下规则跨 Renderer 领域生效，细节与类名归属见 `src/renderer/` 各目录 README：

- 输入确认：Enter 发送、Shift+Enter 换行、输入法组词确认候选不触发提交，由 `renderer/ui/enter-confirm.ts` 单独拥有；视图不得自行判断 Enter。
- 键盘层级：`renderer/ui/modal-layer.ts` / `modal-surface.ts` 决定 Escape 属于最上层、模态对话框的 Tab 约束与焦点归还；平铺编辑页只用页面级作用域，不捕获 Tab。
- 恢复对话框打开时，恢复入口保留为焦点返回目标并暂时退出键盘顺序；Escape 只收起弹窗，不续跑或放弃现场。
- 异步反馈：`renderer/ui/feedback.ts` / `feedback-notice.tsx` 是唯一结构，色调来自结果字段而不是解析文案；失败留在发起操作处、可重试、长错误折叠呈现。设置页的写操作必须把结果带回本页，包括 `applyRuntimePatchReporting` 返回的 Runtime 失败文本。
- 不可逆操作：永久删除先经 `renderer/ui/danger-confirm.tsx` 确认，影响文案由 `renderer/deletion-impact.ts` 按真实 API 行为生成；可恢复的归档恢复保持单次点击。删除事务的防重复必须是**同步的 ref**（`ArchiveManager.tsx` 的 `deletingRef`）：同一 task 内连点两次时 React state 仍是旧值，真实窗口实测会向 API 发出两次 DELETE。
- 显示密度：紧凑模式只折叠无需关注的行，失败、权限拒绝、未验证、部分完成与待用户事项必须继续可见（`renderer/chat/activity-visibility.ts`）。
- **未接通的能力不装成可用**：没有 Runtime 支撑的页面（当前是「已安排」）只声明"尚未接入"，不提供点了没反应的筛选控件，也不用"暂无任务"这类数据空态冒充已实现但没有数据；同一个页面从设置总览、设置侧边栏和应用侧边栏直入模块三个入口进入时渲染同一份内容。真实窗口走查见 `pnpm run verify:channel-entry-states`。
- **渠道健康按运行项派生**：`/channels/status` 的 `channels` 只含正在运行的实例（`PluginHost.listChannels()` 读渠道管理器的运行表，停止移出、启动失败进 `failures`，契约由 `packages/plugins/src/channel/manager.test.ts` 钉住），所以外部渠道页必须按 `running` 计数而不是列表长度派生「未配置/未运行/部分运行中/运行中」，并保留"已配置""已启用""运行中"的区别；四种 fixture 的标签、计数与取色在同一窗口内核对（同上一条的门）。
- 视觉角色：危险文本、通知几何、控件高度与禁用态使用 `03-shell-sidebar.css` 中的角色 token（`--feedback-danger-text`、`--notice-padding-*`、`--control-height-md|sm|row`、`--control-disabled-opacity`、`--choice-disabled-opacity`），同类控件不得重新写回字面值；`ui-state-consistency.test.ts` 直接测量样式源，`pnpm run verify:shared-ui-roles` 在真实窗口里测量渲染结果（错误文本 `rgb(255, 210, 210)`、通知 8px/10px/12px、页头动作 32px、段内动作 30px、进行中 0.42、reduced-motion 下 0.001s），角色清单与未收敛范围见 `src/renderer/ui/README.md`。

真实窗口验收（最小窗口、系统缩放、输入法、失败注入与场景连续性）仍是未完成项，逐项脚本见 `docs/taskbooks/application-ui-ux-taskbook-2026-09-22.md`。

## 开发

从仓库根目录执行：

```powershell
pnpm install
pnpm --filter @littlesheep/app dev
```

完整构建使用：

```powershell
pnpm --filter @littlesheep/app build
```

桌面快捷方式**不必再单独刷新**——`prebuild` 之后已经跟着同步到本次构建的运行时。只有首次创建或排错时才显式执行（在仓库根目录）：

```powershell
pnpm run refresh:desktop-shortcut
```

根目录的 `build-app.bat` 已把构建与刷新集中到 `scripts/build-app.ps1`，并且不依赖固定仓库路径。构建前会由 `scripts/prepare-littlesheep-runtime.mjs` 在本机 Electron 安装目录生成同版本的 `LittleSheep.exe`；它是被 `.gitignore` 忽略的运行时副本，不进入 Git。应用构建输出位于 `packages/app/out/`，只保留在本机供 `LittleSheep.exe` 启动，不进入 Git。

## 发布载荷（Windows x64）

`pnpm run package:win`（解包目录）与 `pnpm run package:win-installer`（NSIS 安装程序）都由 `scripts/package-windows-release.mjs` 驱动。**产物不写进检出目录**：`scripts/lib/release-artifacts.mjs` 解析发布根，`LITTLESHEEP_RELEASE_DIR` 优先，否则是 `<系统临时目录>/littlesheep-run-artifacts/windows-release/`；暂存 `out`、暂存 Electron 运行时、生成的临时配置和打包锁同样落在系统临时区。`packages/app/electron-builder.yml` 里 `directories.output` 的值只是手跑 `electron-builder` 时的默认，脚本会重写它。

`electron-builder.yml` 的 `files` 是唯一的载荷契约，只有两类收窄，且都是**加法安全**的（没被点名的依赖照常打包，新运行时依赖不会被静默丢掉）：

1. **非目标平台/架构**：`onnxruntime-node` 的 `bin/napi-v6/{darwin,linux}` 与 `win32/arm64`、`node-pty` 的 darwin/win32-arm64 prebuild 与 arm64 ConPTY。`@napi-rs/*` 与 `@img/*` 不需要规则——pnpm 在这台机器上只安装 win32-x64 变体，electron-builder 对缺失的可选依赖只报告"not present"。
2. **已经编译进 `out`、运行时不会再按模块名解析的目录**：`onnxruntime-web`（transformers 的 Node 构建内联了它的 JS，只用 `requireFromHere("onnxruntime-node")`）、`pdfjs-dist`（PDF.js 已打进 `out/main/chunks/pdf-*.js`，且 `read-pdf.ts` 不传 `cMapUrl`/`standardFontDataUrl`/`wasmUrl`，包内的 `cmaps`/`standard_fonts`/`wasm` 不可达）、以及 mermaid/monaco/@xterm/react-markdown 语法高亮这一批渲染器库及其独占依赖树。清单由"渲染器库闭包 − 打包运行时闭包"算出，不是逐个猜的。

**必须保留**：`@napi-rs/canvas`（`out/main/chunks/pdf-*.js` 通过 `createRequire` 动态要求它，electron-builder 自动解包）、`onnxruntime-node` 的 win32/x64、`@img/sharp-win32-x64`、`@huggingface/*`、`node-pty` 的 win32-x64 prebuild，以及 `@littlesheep/documents` 的依赖树（`xlsx`/`pdfkit`/`docx`/`mammoth`/`fontkit` 等约 35 MiB 仍在载荷里：它们是运行时文档库，pdfkit 还会按 `__dirname` 读自己的数据文件，删它们需要各自单独取证）。

实测（同一台机器连续两次重打包，文件长度合计）：解包目录 **1,232,082,503 → 597,288,192 字节（1,175.01 → 569.62 MiB）**、`app.asar` **466,509,892 → 69,688,045 字节（444.90 → 66.46 MiB）**、`app.asar.unpacked` **378,806,235 → 140,833,771 字节（361.26 → 134.31 MiB）**、安装程序 **286,793,650 → 165,898,400 字节（273.51 → 158.22 MiB）**。解包侧的 226.95 MiB 差值里 223.10 来自 `onnxruntime-node`、3.85 来自 `node-pty`，与收窄前的分平台测量逐项吻合；`app.asar` 内的 `out/renderer` 同期从 16.44 涨到 16.46 MiB，那 0.02 MiB 来自打包期间并行的渲染器改动，不计入本收窄。隔离验收见 `pnpm run verify:packaged-isolation` 与 `node scripts/verify-html-preview-baseline.mjs --app=packaged`（后者经根 `verify:*` 运行时会被前置的 `ensure:app-build` 吃掉参数，所以写直接调用），事实边界写在 `scripts/README.md`。

## 运行边界

1. 主进程在 `src/main/index.ts` 先恢复待处理的数据根迁移或回滚，再初始化用户数据、配置、密钥、Runner、会话/项目索引和 Local App API。
2. `src/main/local-app-api-server.ts` 提供本地 UI、流式执行、设置、记忆树、项目、工作区、终端和开发环境接口。
3. `src/preload/` 只暴露 renderer 必需的桥接信息。
4. `src/renderer/` 负责聊天、侧边栏、设置、归档、记忆树、执行过程和拓展工作区。
5. Electron 主进程并列装配 Runner 与 `@littlesheep/plugins` 宿主；插件工具经校验后迁移进 Runner，插件 Skill 通过 owner-scoped 来源进入 SkillLoader 和记忆注册表，外部渠道以插件贡献形式接入且不是本地 UI 的必要依赖。插件 API v1 的边界和本地代码信任规则见 [插件开发说明](../../docs/reference/plugin-development.md)。

网络设置页的 Provider 检查是用户主动触发的 Main-owned 一次性搜索：只有当前已配置 Provider 的真实检查成功才显示 `ready`；检查结果只保存在当前运行时，配置变化、Runner 重建或重启后重新回到 `configured_unchecked`。启动过程不会为健康状态隐式联网。

`src/main/runtime-config-change.ts` 的保存事务（normalize → persist → 重建 Runner）按顺序串行化，保存失败时拒绝调用方并保留旧版本。**"已保存"不等于"已生效"**：持久化会把新版本写进 Runner 副本读的那个槽位，所以字段比较必须在持久化之前做；一次重建失败会被记成"已落盘但未生效"，再次保存同一个版本仍会重建 Runner，而不是返回一个没人用的"保存成功"。它的测试夹具始终持有一份已载入的配置，因此 `current()` 在该用例里不返回 `null`（null 仍属 Main 尚未读取配置时的契约）。

### 权限容器

活动 `dataDir`（默认 `.littlesheep`）是 LS 的逻辑容器根，`workplaceDir` 是其默认工作区，不是完整应用数据根。Main 将 `dataDir` 传给 Runner、Agent 工具和终端路由，用于标记容器内、容器外及无法证明范围的访问。当前这不是实际 Docker/OS 进程隔离，Shell 仍由宿主系统启动；任何未来的系统沙箱都只能作为额外防线。

三档权限含义：完全访问启用时先进行一次红色风险确认，确认后容器内外及范围不明的读写改删和执行免逐次批准；研究仅对容器内读取免批准；受限所有操作都需批准。核心源码只读和危险命令硬拒绝高于这些模式。

用户主动选择外部工作区、预览文件或保存编辑内容属于用户发起的 UI 操作，不会把该路径纳入容器。Agent run 对外部或未知工作区仍由 Main 判定范围；研究/受限先等待批准，完全访问确认后直接继续。

## 数据所有权与禁止事项

- Main 进程拥有 Electron 生命周期和用户数据 adapter；Renderer 只拥有临时交互状态。
- 完整应用数据根由 branding、外部 locator 或 `LITTLESHEEP_DATA_DIR` 解析并可整体迁移；`<data-root>/workplace` 只是默认工作区，不是全部应用数据。
- 会话、记忆、项目、附件、工作区和插件数据各自由对应服务管理，UI 不维护第二份权威副本。
- 禁止让 Renderer 直接访问 Node.js 或用户数据，禁止让外部渠道成为本地 UI 启动条件。
- 禁止继续向 `App.tsx`、`local-app-api-server.ts` 和 `renderer/api.ts` 加入无关领域逻辑；兼容修改应服务于后续分域。

## 重要入口

| 路径 | 职责 |
| --- | --- |
| `src/main/index.ts` | Electron 主进程启动和退出；窗口、托盘、关闭策略和拖拽/退出前落盘 IPC 在 `src/main/desktop-shell.ts`；Runner 的构建、重建与退役在 `src/main/runner-lifecycle.ts`，启动恢复在 `src/main/run-recovery.ts`，Runner→RunRouter 的发布与恢复闸门在 `src/main/run-router-publisher.ts`。 |
| `src/main/local-app-api-server.ts` | Local App API、SSE、工作区和终端；长生命周期 SSE 由 `local-app-api/http.ts` 统一提供 15 秒心跳、512 KiB 单连接待写上限和清理。 |
| `src/main/desktop-acceptance-snapshot.ts` | 只读桌面验收快照；采样进程/Electron 内存、句柄、活动请求、Runner、活动源和监听器，用于验证资源是否回落。 |
| `src/main/attachment-cache.ts`、`attachments.ts` | 受管附件缓存、稳定索引、安全清理、按需解析和 run 所有权分类。 |
| `src/main/data-root-migration.ts`、`data-root-metadata.ts` | 外部 locator、启动期 staging 复制、SHA-256 清单校验、活动元数据路径重绑定、原子切换、中断恢复和回滚。 |
| `src/main/development-environment-definitions.ts`、`development-environment-files.ts`、`development-environments.ts` | LS 管理的运行时/工具链定义、版本检测、导入移除事务、Electron Node shim 和终端派生 PATH。 |
| `src/main/local-app-api/development-environment-routes.ts` | 开发环境状态、版本偏好、导入和移除接口。 |
| `src/main/memory-v3-migration-control.ts`、`memory-embedding-model-control.ts`、`local-app-api/memory-migration-routes.ts` | Memory v3 迁移预检与回滚判定、固定本地向量模型资产检查、显式准备、进度、取消和关闭中止。 |
| `../memory-tree/src/workspace-resource-index.ts`、`workspace-resource-scanner.ts` | 工作区相对路径元数据索引；通过 Runner/MemoryService 接入，正文仍由显式工作区工具读取。 |
| `src/main/keychain.ts` | API key 安全存储；网络设置页通过 Main-owned route 保存 Tavily 密钥，配置只保留 secret reference。 |
| `src/main/project-index.ts`、`project-rebinding.ts` | 稳定项目身份、路径冲突检查和可恢复跨索引重绑定。 |
| `src/main/local-app-api/session-routes.ts`、`src/renderer/sidebar/session-row.tsx` | 独立对话和项目对话共用的会话重命名契约、持久化回滚与侧边栏内联编辑。 |
| `src/main/workspace-*.ts` | 工作区布局、产物、文件路由和 shell。 |
| `src/renderer/App.tsx` | 主 UI 编排。 |
| `src/renderer/TraceCard.tsx` | 历史执行阶段（含历史 stage 名）与工具调用记录；不再渲染 TaskBook。 |
| `src/main/memory-files.ts`、`src/renderer/MemoryTreeView.tsx` | 用户记忆文件视图；只显示六份权威文件，后端仅允许编辑 `SOUL.md`，不暴露 Atom、关系或向量结构。 |
| `src/renderer/chat/assistant-turn.tsx`、`Markdown.tsx`、`workspace/browser.tsx` | 思考/执行/结果渐进披露与文件、网页链接的内置预览。 |
| `src/renderer/api.ts` | Local App API 客户端。 |
| `src/renderer/styles.css`、`src/renderer/styles/*.css` | 共享深灰视觉和交互规范；`styles.css` 只汇总 `00`–`10` 分域样式表。 |

拓展工作区关闭最后一个标签后保持展开，并显示审查、产物、终端、空白浏览器和侧边聊天快捷入口；面板只在用户明确折叠或拖过第二层阈值时收起。折叠后同时保留右上角固定入口和右侧全高悬浮感应入口。审阅的更改列表与普通文件导航各有自己的宽度（`reviewNavigatorWidth` / `fileNavigatorWidth`，同一组 160–520 上下限、默认 214），两者都随会话现场持久化，拖宽其中一个不会移动另一个。

应用表面圆角使用统一 token：普通表面为 `10px`，圆形和胶囊单独处理；输入栏使用 `12px`，与固定 `24px` 圆形发送键的实际半径一致。侧边栏与拓展工作区共用的折叠图标使用 `3px` 小圆角、`18 x 14` SVG 视口、半像素坐标和 `1px` 非缩放描边，分隔线只做整数位移动画，以保证高 DPI 与窗口缩放下的边缘清晰度。

流式回答的文字边界有一条硬规则：SSE 帧解析（`src/renderer/api/common.ts`）对无法解析的 `data:` 行**只跳过该帧**，不再抛出——此前一个畸形帧会中断整条流的读取，连带丢掉它之后的全部增量与 `result`（UX-20 分层定位确认的整段丢失路径）。"始终没有可解析结果"的失败关闭由 `src/renderer/api/run.ts` 的 `consumeRunStream` 承担，坏帧不得被当成静默成功；分层探针在 `src/renderer/chat/stream-text-integrity.test.ts`。

对话区的阅读位置由 `src/renderer/chat/use-chat-scroll-controller.ts` 单独拥有（UX-19）：贴底时按底边跟随新内容，离开底部后锚定"正在读的那条消息"（`chat-scroll-anchor.ts` 的纯算术），视口或分栏变化不再按"离底部的距离"推移读者；新输出到达而读者不在底部时只提示，并提供 `.chat-jump-to-latest` 作为可达的返回入口——它是一个与输入框同材质的圆形玻璃按钮（只画向下的天蓝箭头，底边固定在输入框可见上沿上方 3px），出现与消失都从输入框边缘长出来／收回去，细节见 `src/renderer/chat/README.md`。只有真正的会话切换才重新贴底——草稿会话取得持久 id、以及加载更早消息，都必须保持读者位置（真实窗口实测：前者曾把向上滚动的读者拽回底部）。真实窗口实测（`verify:electron-ui-state-continuity`）：视口高度变化后锚点位移 0.00 px、宽度重排后 0.29 px，底边距离按视口变化量改变，"回到最新"把底边距离恢复到 0。流式场景在 `verify:chat-streaming-rendering`：输出中途向上滚动后，答案剩余部分到达期间锚点位移 0 px，最终 DOM 文本与持久化结算一致（1014 字符 vs 投影后 1004 字符，差异全部是 Markdown 语法空白），标题/链接/行内代码/引用/代码块的取色在"代码围栏刚出现"与"结算后"两次采样完全一致。

## 开发环境管理

设置中的“开发环境”页面是版本管理入口。Electron 内置 Node 会随应用提供；其他常用运行时和工具链当前由用户选择已下载并解压的目录后导入到 `<data-root>/toolchains/`。页面保存的是目标版本偏好，真实生效版本必须经过可执行文件版本校验；版本系列（如 `3.12`）会选择已导入的最高匹配补丁版本。终端使用由 Main 派生的进程环境，优先放置已验证的 LS 工具链，不修改宿主进程的 `PATH`。

当前尚未实现官方运行时下载、签名/哈希清单和完整安装包分发；相关边界与当前待办以 [项目状态](../../docs/decision/project-status.md) 为准。

## 验证

从仓库根目录运行：

```powershell
pnpm.cmd --filter @littlesheep/app typecheck
pnpm.cmd --filter @littlesheep/app build
pnpm.cmd run verify:app-recovery
pnpm.cmd run verify:electron-deepseek-sustained-load
pnpm.cmd run verify:electron-deepseek-hours
```

涉及公共事件、持久化、权限或恢复时，还必须运行根目录的全量测试、typecheck 和 build。`verify:electron-deepseek-sustained-load` 使用隔离数据根和已配置的DeepSeek API 实测 凭证运行 diagnostic 门，默认 120 秒，也可在 15-1200 秒内显式配置；它验证暂停、恢复不重放、最终回答连续性和资源回落，但不是小时级稳定性证明。`verify:electron-deepseek-hours` 使用同一产品路径运行 formal 门，默认 2 小时、允许 1-6 小时，并额外检查最多 24 个资源窗口的后半程趋势；正式基线是否达成、当前数字与未完成项以 `docs/decision/project-status.md` 为准，本文件不另行断言。普通 Agent run 与 Checkpoint 续跑的观察 SSE 断开不会取消 Main 中的任务；终端主动命令仍保留断连取消语义。用户数据位置由 branding、外部 locator 或 `LITTLESHEEP_DATA_DIR` 解析；应用只在用户明确登记迁移后于下次启动执行，测试必须使用隔离临时目录。

常见修改位置：启动/退出看 `src/main/`，纯跨进程规则看 `src/shared/`，UI 与交互看 `src/renderer/`，最小桥接看 `src/preload/`。各目录的 README 是更细一层的所有权入口。
- **审阅快照会自报"读取期间仓库仍在变化"**（UX-27 第 2 条）：一次审阅读取是多条 Git 命令拼起来的，Main 现在用 HEAD、index stat 与同参数的 status 指纹在装配前后比对，不一致就有界重读一次；仍不一致时快照带 `unstable` 并显示"仓库在读取期间仍在变化"，而不是把混合状态当成新结果。
- **Git 读取失败会说清楚是哪一种**（UX-28 第 1 条）：损坏的仓库、属主不符、权限拒绝、超时、取消与"真的不是仓库"各有自己的原因与下一步；属主不符时只转达 Git 的提示，绝不自动改动用户的全局配置。
- **重命名与权限变化会显示为元数据**（UX-28 第 3 条）：纯重命名在 Git 里没有文本 hunk，只有 `rename from/to`、`similarity index` 这类 extended header；审阅差异层现在把它们作为元数据列出（并解释 `100755` 之类的权限号），不再显示成"没有可显示的行差异"或"普通 unified diff 之外的格式"。
- **审阅上限会自己说明**（UX-28 第 5 条）：列表超过 2,000 个文件时摘要显示"显示前 2000 个，共 2054 个文件"，合计被标成不完整；每层超过 5,000 行（或 8 MB）时差异层提示写明是哪个上限。折叠审阅导航器会连同这份说明一起隐藏，缺口已记录，待把上限挪到差异表头。
- **审阅上限在导航器折叠时也可见**（UX-28 第 5 条）：折叠更改文件列表后，差异面板会接过那句话（"显示前 2000 个，共 2054 个文件。"，差异层被截断时追加"N 个差异层已达上限"）；导航器展开时正文不重复。
- **行评论不会悄悄换位置**（UX-28 第 4 条）：评论记下创建时的那几行源码，文件被刷新改动后卡片显示"代码行已变化"，而不是把评论留在同一行号指向的新代码上；删除文件的"打开"按钮写明"文件已删除，无法在文件工作台中打开"。
- **差异交互有真实走查**（UX-28 第 4 条）：真实回车（浏览器输入管线）在评审树里换选中项、从差异回到文件工作区的源文件、gutter 渲染真实行号、长行进入应用提供的差异数据；长行换行与删除行评论的视觉证据在隐藏窗口里拿不到（Monaco 不布局），只有配置级/单元级证据。
- **审阅与命令行基线一致**（UX-28 第 2 条）：子目录（路径相对工作区且能被自己的 diff API 取到）、linked worktree、detached HEAD（`detached@<sha>`）、合并冲突（`conflicted`）、子模块 gitlink、中文与空格路径、空文件与二进制，逐形态对照 `git status --porcelain`。
- **Git 失败分类有真机复现**（UX-28 第 1 条）：清空 PATH 得到 `git-unavailable`，用 ACL 拒绝读 `.git/index` 得到 `permission-denied`（而不是"不是 Git 仓库"），并实测读损坏仓库不会改动全局 `safe.directory`；ownership 与 timeout 在本机无法复现，保持分类级证据。
- **编辑器布局不再依赖动画帧**（UX-28 第 4 条排查副产品）：`workspace/code-editor.tsx` 同步布局并在模型变化后重新布局；被遮挡/最小化的窗口不产生帧，也不投递 resize observer，布局不该依赖它们。实测说明：隐藏窗口里编辑器根节点仍是 5 px（pane 715 px）、只渲染 1 行，这条改动不改变那组测量。
- **验收窗口可以停在屏幕外渲染**（只有验收环境可用）：`/application/acceptance` 的 `park-offscreen` 先把窗口移到所有显示器之外再 `showInactive()`，因此需要真实布局的检查能在**不打扰用户**的前提下进行；普通走查仍保持隐藏窗口。同时记录一个真实缺陷：审阅差异面板里 Monaco 根节点保持 inline `height: 5px`（父链明确 716 px），只渲染 1 行——与窗口是否渲染无关，已作为后续条目。
- **审阅差异面板不再只有一行**（UX-28 第 4 条修掉的真实缺陷）：编辑器首次布局发生在容器为空时，Monaco 把 5 px 写成行内高度后再没更新；现在由 `measureEditorBox` 自己量好再 `layout({width,height})`（实测修复前 5 px/1 行/1 个行号 → 修复后 716 px/12 行/行号 1,2,3）。验收新增 `park-offscreen`：窗口移到所有显示器之外并 `showInactive()`，需要真实布局的检查因此能在**不打扰用户**的前提下运行（实测 screenX/Y = -21846、focused false）。
- **终端可以选 Shell**（UX-29）：Main 探测本机真实可用的 Windows PowerShell / PowerShell 7 / Git Bash / cmd / WSL（不可用项说明原因与配置路径，PATH 上的 `bash.exe` 若是 WSL 启动器不会被当成 Git Bash），终端顶部下拉用真实名称，选择只发送受校验的 profile id。
- **终端 Shell 有真实验收**（UX-29 第 4 条 PowerShell 侧）：真实会话里验证 `$PSVersionTable` 与实际启动的 Shell 一致、进程可执行文件、cwd、中文输出、环境继承与多行粘贴；顺带修掉"可执行文件消失时返回假活会话"与"终止未启动进程抛 EINVAL 逃逸退出路径"两个缺陷。
- **WSL 会话从工作区开始**（UX-29 第 3 条）：`windowsPathToWslPath` 把 Windows 路径映射为 `/mnt/<盘符>/...`（UNC 不猜、退回 home），WSL 的 `--cd` 因此跟随会话目录；实机验收还覆盖了含空格与中文的工作区路径（cwd 正确、能写读 `中文 文件.txt`）。
- **多终端会话**（UX-30 起步）：Main 侧实测两个真实会话互不干扰、关掉一个另一个照常、超过上限的创建被拒绝；渲染侧新增纯标签模型（状态、退出码、有上限的回放缓存、输入永不送到已退出/启动中的会话）与标签条，单个会话时外观不变。
- **多终端会话已接线**（UX-30）：`use-terminal-sessions.ts` 持有会话集合与流（按会话缓冲输出、输入只发给活动且就绪的会话），标签条出现于第二个会话；真实窗口走查实测 Shell 下拉列出 `PowerShell 7 / Windows PowerShell / 命令提示符 / WSL · Ubuntu-26.04`（据此更正了"本机没有 WSL 发行版"的旧结论）。
- **WSL 可用性探测与失败如实报告**（UX-29 第 3、4 条）：`wsl.exe` 解析为绝对路径、每个发行版做启动探测并把原因写进 profile；实测本机会话因宿主机代理配置无法启动（`Wsl/Service/E_UNEXPECTED`），验收因此断言"失败必须报出来"而不是假装可用。
- **WSL 会话实测通过**（UX-29 第 4 条）：真实 WSL Bash 里验证 `BASH_VERSION`、`uname -s`、映射后的 `/mnt` 工作区、profile 环境（`LANG`/`TERM`）、中文回环与多行粘贴；此前"本机 WSL 起不来"的记录是验收脚本用文本匹配误判警告导致，已更正。
- **多终端可用**（UX-30 第 1 条）：工具栏新增"新建"（提示说明不影响正在运行的终端），多个会话时中断/重启/清空的提示会说明影响范围，标签条显示每个会话的真实 Shell 与状态；工作区或会话切换时终止全部会话。真实窗口走查：新建后 2 个标签、恰好 1 个选中、原有会话状态不变（`终端 1运行中 / 终端 2启动中`），关闭第二个后标签条消失且剩余会话仍在运行。
- **终端专项门与三个修复**（UX-30 第 1、2 条）：`verify:workspace-terminal` 独立走查终端（Shell 下拉、恰好一个会话、新建得到两个标签、两个会话各自收到自己的输入、关闭只移除那一个）；修复"打开面板泄漏第二个会话""隐藏面板会杀掉所有会话""重复的清空按钮"。

- 工具事件与运行流恢复（2026-09-27）：Main 侧 `local-app-api/run-tool-event-projection.ts` 把过大的工具事件压到本地 SSE 单事件上限（32 KiB）内并保留路径与真实行数；Renderer 侧 `chat/run-transport-recovery.ts` 把 SSE 只当观察者——连接断开不等于 run 失败，先回读权威执行日志再决定是否抹掉预览。
- UI 门与热点（2026-09-27）：本轮新增的聊天样式回到门的要求——圆角只用语义 token（含设置列表角的 --floating-panel-inner-radius）、普通交互控件不用 pointer 光标；enderer/chat/run-actions.ts 回到 349 行登记上限以内（348），断流对账接线集中在 enderer/chat/run-transport-recovery.ts。
- 冷启动就绪路径（2026-09-27）：附件保护/清理与会话索引预热移出关键路径，窗口与发送可更早就绪；真实数据根上可用 LITTLESHEEP_BOOTSTRAP_TIMING=1 查看 ttachment-protection* 标点。
- 前端改造第一批（2026-09-27）：**O1** 把"未解决失败／权限拒绝／待决策／未通过的验证结论"投影到过程折叠**之外**（`renderer/chat/attention-row.tsx`），普通模式也不再漏掉失败步骤计数，且未通过的验证结论绝不读成通过；**S1** 把设置侧栏重排为四组（通用／模型与行为／连接与扩展／存储与环境），总览只留少量常用入口与需要处理的配置问题，归档与记忆树保留工作模块入口、"已安排"退出常用导航但设置搜索仍可直达，并新增旧标识映射保证深链与前进后退不失效（可达性由测试断言，不靠文字声称）。两项均未跑完真实窗口的最终验收，边界见任务书台账。
- 前端改造第二批（2026-09-27）：**V1** 收敛材质与层级——新增 `styles/13-interaction-states.css` 统一控件角色状态，12 个样式文件按已有令牌去重填充/边框/覆盖规则，玻璃限定在侧栏、输入区、浮动条与菜单，密集内容改用稳定底色；**V3** 新增 `ui/state-view.ts(x)` 与 `ui/state-icons.tsx`，把加载/无数据/不可用/失败四态做成共享原语并配图标与文字（不只靠颜色）。断言层新增 `ui-material-roles.test.ts`、`ui-state-matrix.test.ts`，其中状态矩阵抓到并修掉一个真实缺陷：`.runtime-menu-item:hover:not(:disabled)`（specificity 400）曾压过菜单按下组（300），即按下态在真实窗口里不可见。**尚未完成真实窗口最终验收**：150%/200% 缩放对比度、减少动态效果、圆角是否裁切焦点环未测。
- 发布载荷收窄（2026-09-27，SL-04 已完成）：真实重打包实测 unpacked **1175.01 → 569.62 MiB（−51.5%）**、`app.asar` **444.90 → 66.46 MiB（−85.1%）**、`app.asar.unpacked` **361.26 → 134.31 MiB（−62.8%）**、安装包 **273.51 → 158.22 MiB（−42.2%）**；解包差值可精确分解为 `onnxruntime-node` −223.10 MiB（非目标平台/架构切片）与 `node-pty` −3.85 MiB。收窄规则写在 `electron-builder.yml` 的两组 negation：非目标平台原生资产，以及渲染器 bundle 已自带的前端库（按"渲染器库闭包 − 主进程可动态加载包闭包"计算，避免误删）。打包输出改由 `scripts/lib/release-artifacts.mjs` 解析（`LITTLESHEEP_RELEASE_DIR`，默认在共享运行产物根），因此仓库内不再产生发布产物。**未验证**：embedding 模型的**下载**路径（本机 Node 出网到 huggingface.co 被阻断，已改用 SHA-256 校验过的文件验证加载与离线复用）与 Mermaid 渲染（无门禁断言）。
