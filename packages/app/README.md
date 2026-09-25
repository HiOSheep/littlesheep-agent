# @littlesheep/app

最后更新：2026-09-25 18:43:18

LittleSheep 的 Electron 桌面应用。Agent Runner、记忆、工具、会话和可选渠道在主进程中装配；React renderer 通过 loopback Local App API 与主进程通信。

运行中补充由 Local App API 写入当前 run 的事件队列，再由 Harness 在安全边界送进同一执行循环；Renderer 按事件身份显示一次用户消息。停止与补充的隔离窗口验收见 `pnpm run verify:composer-stop-append`。

- **冷启动三段式**：窗口早于执行能力出现。①数据根迁移、用户布局、keychain、config、Memory v3（顺序是任何写入者的前置条件）；②UI 索引 + Local App API 监听 + 窗口加载渲染器；③Runner 与 RunRouter 建成后发布执行就绪。可选插件宿主在就绪之后异步加载，不阻塞执行能力。
- **右侧可用性**：拓展工作区进面板即可读目录与预览文件，不等待 Runner；两个可用性指标（首个目录行、首个文件正文可见）只在 `LITTLESHEEP_BOOTSTRAP_TIMING=1` 时由渲染器上报，配对测量见 `docs/reference/cold-start-baseline/` 的 CS-08 一节。
- **首屏按需加载**：Monaco、mermaid 与 `react-syntax-highlighter` 都不得进入入口 chunk。完整 Prism 构建单独求值约 380 ms，改为按需后入口 chunk −936 KB、真实首帧早约 148 ms（成对实测见 `docs/reference/cold-start-baseline/`）。**入口字节数在本应用里不是首帧的可靠代理**：Markdown 解析管线整条按需（−400 KB）与 dompurify 按需（−49 KB）都实测无收益并已回退，新增加载态前必须用成对实测证明收益。
- **就绪是唯一事实**：`src/shared/runtime-readiness-{contracts,ipc}.ts` 定义载荷与通道，`src/main/runtime-readiness.ts` 拥有状态，renderer 经 `src/renderer/runtime-readiness/` 消费。未就绪时 metadata 路由照常应答、Runner 依赖路由以 503 `runtime-not-ready` 失败关闭；具体边界见 `src/main/local-app-api/README.md`。正常启动的阶段文字只在发送按钮旁就地显示（`composer-readiness-hint`），横跨整窗的条带只用于失败态与重试（CS-09）。
- **恢复期仍可使用**：当前租约与收件箱里的待恢复任务先完成安全检查；对旧版事件分区的完整兼容扫描随后异步进行。事件存储初始化只确保根目录存在，分区内容在读取、写入或后台恢复时逐段严格验证。真实数据根的历史扫描可能耗时数十秒，Local App API 不在所有请求前等待它；会话索引、配置和工作区接口在恢复期间继续应答，执行入口在路由尚未建成时明确返回 503。
- **启动恢复的诊断计数按最近一次扫描**：`src/main/local-app-api/run-checkpoint-view.ts` 把 store 的扫描结果投影成两个互斥计数（`invalidFiles` = 读不出来的记录数，`warningCount` = 不属于这些记录的目录级发现），`src/renderer/runtime-recovery/` 只负责如实展示。计数不再按进程生命周期累加，因此用户反复点"重新检查"不会把同一份坏记录越算越多（实机验收见 `pnpm run verify:recovery-states`，领域实现见 `@littlesheep/runner` 的 `run-checkpoint-scan.ts`；HTTP 契约与假 Runner 夹具见 `src/main/README.md` 的"测试与修改定位"）。
- **一个功能只有一个名字**：同一功能从聊天、设置总览、设置侧边栏和工作模块直入页进入时，标题与导航条目必须同名，关闭设置回到打开设置前的那一页；面向用户的文案只描述当前可用能力（术语表见 `docs/principles/ui-interaction-guidelines.md`，源码扫描见 `terminology.test.ts`，真实窗口走查见 `pnpm run verify:settings-navigation-terminology`）。
- **窄窗口与缩放下的表单可用性**：关键按钮必须始终可达（含滚动后可达），输入字段不得被压缩到无法输入，页面不出现非必要横向滚动，长路径既能完整查看也能复制。供应商模型行在 560px 以下由四列改为堆叠并显示每字段标签（实测最小窗口下原布局只剩 62px/44px，见 `src/renderer/README.md` 的 `styles/` 条目）；五组窗口×缩放组合的走查见 `pnpm run verify:narrow-high-dpi-forms`。
- **失败留在发起处**：供应商保存、阈值保存、渠道重载、插件启停、文件保存五类写操作都必须在本页显示失败与下一步（`src/renderer/ui/feedback.ts` 的 `tone` 字段决定 `status`/`alert` 与色调，长错误有界折叠），不要求用户回到聊天区找错误；工作区文件保存的状态行还要跨过它自己触发的那次预览刷新。五类注入见 `pnpm run verify:async-feedback`。
- **不可逆删除先讲清范围**：归档项目删除说明随项目移除的归档对话数和本地消息记录，并确认磁盘目录保留；供应商删除说明模型条目、当前模型依赖、密钥库与对话记录边界。真实窗口门 `pnpm run verify:deletion-confirmation` 覆盖取消、Escape、失败重试、归档项目多会话清理及删除连点只提交一次。
- **陈旧数据必须自报状态**：Git 审阅在刷新进行中、更新失败或差异仍属于上一个 revision 时，旧结果必须说明自己是旧的——快照与单文件 Diff 各自成条、各自带重试，快照失败还要报出上次成功读取时间；提示的文案与色调只由 `src/renderer/workspace/review-refresh-notice.ts` 派生，视图不写提示句子。真实窗口门 `pnpm run verify:review-refresh-errors` 会按住、注入失败并断言“重试差异”真的发出新请求。
- **右侧工作区的导航占位是布局契约**：普通目录导航由 `.workspace-shared-file-navigator` 这个 flex 项占位，而审阅标签的导航是审阅表面的直接子元素——只有 `position: absolute` 时它会盖住 Diff 表面和标题行按钮（UX-18 实机验收测得两组按钮落在同一矩形，指针不可达）。`src/renderer/styles/04-workspace.css` 的 `.workspace-files > .workspace-files-navigator` 规则让它留在行内，改动这块样式前先读 `src/renderer/README.md` 的 `styles/` 条目与 `pnpm run verify:review-navigator-width`。
- **代码换行偏好跨两个代码界面共享**：Markdown 代码块的头部栏在高亮与纯文本回退路径中相同；`CodeWrapToggle` 与工作区 Monaco 读取 `littlesheep.ui.codeWrap`。默认关闭、开启后即时同步并记住状态。`pnpm run verify:code-wrap-control` 在隔离 Electron 窗口实测了水平溢出变化与 Monaco 折行行数。
- **重启保留当前入口**：启动时恢复上次会话只装载会话历史与工作区，不会覆盖应用关闭前保存的设置页或模块路由；用户手动切换会话仍返回对话。真实退出/重开验收见 `pnpm run verify:electron-ui-state-continuity`。
- **技能目录的空态与失败各有真实证据**：`MemorySkills.tsx` 只有 Runtime 成功返回空数组才显示“暂无技能”；列表刷新失败保留旧列表，详情失败保留可重试的选择。`pnpm run verify:skills-catalog-states` 的隔离窗口门覆盖 loading、成功有数据、成功空数组、列表/详情失败与详情快速切换。
- **没有模型时的第一步是可用路径**：输入栏的选择器把"还没配置""配置读取失败""已保存但不可用""可用但还没选模型"分成四种事实（`src/renderer/composer/runtime-availability.ts`），空菜单直接给出"配置模型 / 检查供应商配置 / 重试读取"，打开设置只是路由切换、不清空草稿与附件；自定义供应商保存的模型条目是元数据对象，因此 Runtime 的模型引用校验必须按解析后的 id 比较（`src/main/local-app-api/runtime-routes.ts`）。整条路径由 `pnpm run verify:no-model-config-loop` 在真实窗口走查。
- **启动计时**：`LITTLESHEEP_BOOTSTRAP_TIMING=1` 时主进程、Runner 基础设施与 renderer 自报首帧输出同一格式的 `[bootstrap-timing]` 阶段标；五时间点基线与回归护栏见 `docs/reference/cold-start-baseline/`。Runner 侧的 durable 存储并行初始化后，该阶段墙钟 36–40 ms → 10–13 ms、Runner 构建 114–116 → 99–101 ms（净约 14 ms，属阶段级收益，不声称首次可执行变快）。
- **启动失败页可取证**：`src/main/desktop-acceptance-actions.ts` 只在 `LITTLESHEEP_ELECTRON_ACCEPTANCE=1` 时装配隔离验收动作（`/application/acceptance` 的 `resize` / `startup-error` 等），后者把真实失败文案交给生产同一份 `showStartupError` 文档，使 CS-02 能对"启动失败"这一无法靠等待到达的状态取像素证据；生产运行不挂载这些动作。
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

完整构建和桌面快捷方式刷新使用：

```powershell
pnpm --filter @littlesheep/app build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\refresh-desktop-shortcut.ps1
```

根目录的 `build-app.bat` 已把这两步集中到 `scripts/build-app.ps1`，并且不依赖固定仓库路径。构建前会由 `scripts/prepare-littlesheep-runtime.mjs` 在本机 Electron 安装目录生成同版本的 `LittleSheep.exe`；它是被 `.gitignore` 忽略的运行时副本，不进入 Git。应用构建输出位于 `packages/app/out/`，只保留在本机供 `LittleSheep.exe` 启动，不进入 Git。

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
| `src/main/index.ts` | Electron 主进程启动和退出；窗口、托盘、关闭策略和拖拽/退出前落盘 IPC 在 `src/main/desktop-shell.ts`。 |
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

对话区的阅读位置由 `src/renderer/chat/use-chat-scroll-controller.ts` 单独拥有（UX-19）：贴底时按底边跟随新内容，离开底部后锚定"正在读的那条消息"（`chat-scroll-anchor.ts` 的纯算术），视口或分栏变化不再按"离底部的距离"推移读者；新输出到达而读者不在底部时只提示，并提供 `.chat-jump-to-latest` 作为可达的返回入口。只有真正的会话切换才重新贴底——草稿会话取得持久 id、以及加载更早消息，都必须保持读者位置（真实窗口实测：前者曾把向上滚动的读者拽回底部）。真实窗口实测（`verify:electron-ui-state-continuity`）：视口高度变化后锚点位移 0.00 px、宽度重排后 0.29 px，底边距离按视口变化量改变，"回到最新"把底边距离恢复到 0。流式场景在 `verify:chat-streaming-rendering`：输出中途向上滚动后，答案剩余部分到达期间锚点位移 0 px，最终 DOM 文本与持久化结算一致（1014 字符 vs 投影后 1004 字符，差异全部是 Markdown 语法空白），标题/链接/行内代码/引用/代码块的取色在"代码围栏刚出现"与"结算后"两次采样完全一致。

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
