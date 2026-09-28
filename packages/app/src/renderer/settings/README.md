# Renderer 设置
最后更新：2026-09-28 13:05:34

设置页跟随窗口的 Beta/Chali 原生状态：Beta 侧栏从 32px 标题栏下方开始并隐藏独立拖拽带；Chali 侧栏贯通顶边。窗口左上角的三个导航控件始终可达（它们是窗口镶边层的固定层，见 `../README.md` 的 chali 段落），页面正文不透明。几何覆盖集中在 styles/14-window-layout.css，不由设置页另建窗口状态。

这里负责设置侧边栏、设置页和直接打开的记忆树/插件/已安排页面。设置与主页共用全局导航和侧边栏交互，但不复制运行时数据。

**设置表面镜照 chali 窗口结构**（2026-09-28）：`.settings-workspace` 由 `inset: 32px 0 0` 改为 `inset: 0`，其 `.settings-layout` 与 `.app` 用同一组行列（`grid-template-rows: var(--window-titlebar-height) minmax(0, 1fr)`），`.settings-sidebar-track` 与 `.settings-sidebar-resizer` 占 `grid-row: 1 / -1`，`.settings-workspace-body` 占 `grid-column: 3; grid-row: 2`。于是**打开设置不再把左侧卡片往下推 32px**：应用侧栏卡片与设置侧栏卡片的顶边都在 `y=8`（真实窗口实测）。整窗覆盖后命中测试改为按区域声明——`.presence-layer.settings-presence`、`.settings-workspace`、`.settings-layout` 都是 `pointer-events: none`，只有侧栏轨道、分隔条、正文列与 `settings/workspace.tsx` 渲染的 `WindowDragRegion`（`.window-drag-band`，覆盖侧栏那条 32px 带）取回 `auto`；这就是"窗口左上角仍可拖动"的实现方式（`workspace.tsx` 里同时挂 `[inert]`/`aria-hidden` 的只有 `.settings-sidebar-track`，与应用侧栏一致）。三个全局导航控件不再依赖这批区域规则：它们已是窗口镶边层（`z-index: 1003`）里的固定层，设置打开时正落在设置侧栏自己预留的那条 32px 空带里，因此仍然可达。设置侧栏内容加了 `padding-top: calc(var(--window-titlebar-height) - var(--floating-panel-inset))`，第一行搜索框落在拖拽带之下（实测 `y=33`，真实点击可获焦）。结构与命中区域由 `chat-layout-stability.test.ts` 的 chali 用例与 `interaction-visibility.test.ts` 共同钉住。

**信息架构（S1，2026-09-27）**：侧栏从“通用承载 9 项”的五组改为按用户意图分的四组——**通用**（`home`、`appearance`、`application`）、**模型与行为**（`api`、`agent`）、**连接与扩展**（`web`、`browser`、`plugins`、`skills`、`channels`）、**存储与环境**（`storage`、`developmentEnvironments`）——另加**工作模块**（`archive`、`memoryTree`）与**未接入**（`scheduled`）。页面身份（`SettingsPage` 的 15 个 id）没有改名，所以持久化路由、返回/前进历史和 `openSettingsPage(id)` 深链接照旧解析；新增的 `LEGACY_SETTINGS_PAGE_GROUPS` 是「旧页面标识 → 新分组」的映射表，`RENAMED_SETTINGS_PAGE_IDS` 与 `REMOVED_SETTINGS_PAGE_IDS` 为后续重排预留，`resolveSettingsPage(id)` 保证旧标识要么落到同一个页面、要么落到有明确去向的页面，不会出现空白页。自动化证明在 `navigation-architecture.test.ts`：15 项清单逐个断言去向、四个分组的页面集合、归档/记忆树的去向、已安排只在搜索索引里、每个常用页从设置入口 ≤2 次选择可达、以及旧标识全部仍能解析。

- `navigation.ts`、`types.ts`：设置分组、搜索索引和页面契约。`searchOnly` 条目（目前只有 `scheduled`）仍可从设置搜索打开，因此 `filteredNavGroups` 在没有搜索词时用 `commonSettingsNavGroups()`、有搜索词时用 `settingsSearchNavGroups()`。
- `workspace.tsx`、`home.tsx`：设置壳与总览；归档、技能和外部渠道页复用 Renderer 根目录的 `ArchiveManager.tsx`、`MemorySkills.tsx`、`ChannelConnections.tsx`。
- `home.tsx`：**总览只列出** 4 个常用入口（模型供应商、界面、网络检索、存储与数据）和**有证据**的配置问题（`settingsHomeProblems()` 只读 `runtime.providers`，用设置页自己的 `isConfiguredProvider` 判定“还没有配置模型 / 已配置的供应商还没有可用模型”）。它不再复制整份目录，也不做状态仪表盘；“网络检索未配置”这类偏好性提示故意不做，因为 Runtime 没有把“用户需要处理”作为事实给出。
- `agent-profile.tsx`、`appearance.tsx`、`storage.tsx`、`scheduled.tsx`、`plugins.tsx`、`direct-module.tsx`：领域页面；`appearance.tsx` 只放显示偏好（对话显示密度，普通/紧凑，存储仍是 `normal`/`compact`），`agent-profile.tsx` 只放 profile 与上下文策略（压缩阈值收在“高级上下文设置”折叠里），术语统一遵循 `docs/principles/ui-interaction-guidelines.md` 的术语表。
- `scheduled.tsx`：计划任务尚未接入 Runtime，因此页面只声明“功能尚未接入”，不提供筛选或创建控件，也不显示“暂无数据”式的空态；侧边栏、设置总览和直接模块页共用这一个页面，入口描述同样标注未接入。它已退出常用导航（`searchOnly: true`），但设置搜索仍能找到并打开它。
- `models.tsx`、`model-provider-editor.tsx`、`model-provider-draft.ts`、`provider-editor-session.ts`：模型供应商卡片、编辑对话框、纯校验草稿和会话级草稿存储；删除供应商先经 `ui/danger-confirm.tsx` 确认，影响文案来自 `deletion-impact.ts`，只描述配置条目移除，不声称密钥被清除。空态明确写出“保存配置只代表写入了密钥和模型声明，不代表 LS 已经验证过它真的可以调用”，与输入栏的 `runtime-availability.ts` 用同一个 `isConfiguredProvider` 判定“已配置”。
- 供应商删除在确认后立即以 `deletingRef` 同步锁住同一次操作，防止同一帧连点发出两次 DELETE；响应完成或失败后才释放。真实窗口验收见 `pnpm run verify:deletion-confirmation`。
- `web.tsx`、`web-state.ts`、`browser.tsx`、`development-environments.tsx`：网络检索、内置浏览器和开发环境注册表页面。
- `application-background.tsx`、`active-run-row.tsx`、`application-background-state.ts`：三档关闭策略与活动任务控制。活动列表通过 `api/application-lifecycle.ts` 的 SSE 订阅同步，手动刷新只用于快照校准，不使用常驻轮询。

页面只能通过 Renderer API 读写主进程服务；任何迁移、密钥、插件启停或归档操作都必须保留错误、取消和恢复状态。
长生命周期页面必须在卸载时中止 fetch/stream、清除重连 timer，并依赖 Main 的监听器释放契约；不得让设置页成为 Runtime 状态权威源。

供应商编辑的草稿策略：设置容器按 `key={page}` 重新挂载页面，因此草稿保存在 `provider-editor-session.ts` 的**模块内存**里（不写 localStorage、不写日志、不落盘）：切换设置页再回来会恢复草稿并说明来源；提交时先清空草稿副本，避免保存中的内容在别的页面显示为待保存编辑；保存失败把可修正内容放回原处并就地显示失败；取消与保存中禁止关闭都会丢弃或推迟处理。明文密钥只在这份内存草稿里存在，保存或取消后立即丢弃。编辑器自身显示四种状态：未改动不提示、`已修改，尚未保存。`、`保存中…`、`保存失败：…`（`role="alert"`），头部关闭按钮在保存中禁用；`providerDraftIsDirty` 逐字段比较（含模型行与明文密钥），因此"改回原值"算干净。关闭是模态唯一出口，有未保存修改时先出现 `provider-editor-discard`（`role="alertdialog"`：继续编辑 / 丢弃修改），不会静默丢弃；由于编辑器是否渲染由会话草稿决定，带着未保存草稿切回该页会自动重新打开编辑器（实机验收记录在 `scripts/verify-provider-editor-draft.mjs`）。

异步操作的反馈统一走 `ui/feedback.ts` 的结构：色调来自操作结果字段而不是解析文案，失败留在发起操作处并带可重试动作，长 Runtime 错误有界折叠。因此设置页的每一处写操作都必须把结果带回来：供应商保存/删除、插件启停与重载在页面内显示；压缩阈值保存经由 `applyRuntimePatchReporting` 把失败文本返回给页面（不再只写进聊天区的错误行），重新加载失败也不会留下旧的成功提示。

**设置页不画框线**（2026-09-26）：导航行、模块搜索框、筛选胶囊、供应商卡片与各类字段/徽标一律 `border: 0`，靠填充区分——这条决定写在 `styles/07-overlays-settings.css` 末尾的"Settings frames are off"块里，集中一份而不是散落二十多条规则；块内第二批给原本只靠边框才看得见的元素（筛选胶囊、缓存按钮、开发环境状态、供应商徽标/模型芯片/移除按钮、模型行输入框等）补了 `rgba(255, 255, 255, 0.035)` 填充。**仍然保留线条的三类**：语义色条（danger / warning / success 的 `border-left`）、行与行之间的分隔线（`border-bottom`）、以及 `.dialog`——模态需要一条边界把它和整个窗口分开。真实窗口实测：`.settings-nav-item`（含 `.active`）、`.settings-module-search`、`.settings-filter-pill`、`.provider-card`、`.provider-badge` 的四边宽度都是 `0px`。

**正文由一套设置排版令牌驱动**（2026-09-27）：设置正文的字号与尺寸唯一定义在 `styles/03-shell-sidebar.css` 的 `:root` 里——页面标题 26px、页面说明 14px、分组标题 15px、行标题 14px、行说明 13px、元信息 12px、行高 68px、开关 40×22。取值对齐应用基准（归档页标题 26px、正文 14px；侧栏 13px），**行的动作按钮仍归共享的"段内紧凑动作"角色**（`--control-height-row` 30px + `--control-font-size` 12px），不再被后写的规则改成 42px / 16px。分组卡片保留：一张卡片一个分组，行内左侧标题与灰色说明、右侧控件；卡片填充用 `--surface-2`、分隔线用 `--border`，不再写 `#232323` / `#383838` / `#303030` / `#ababab` 这类字面值。窄窗口收紧内边距。设置首页的 `.settings-overview-row` 是**导航条目**而不是设置行，它保持侧栏交互外框（透明填充、hover 变色、10px 圆角），只有字号跟着上面这套令牌走。页面特有的状态、错误和确认交互仍归各页面组件所有。

**为什么重写这一块**（同日）：此前设置正文叠了四轮互相覆盖的样式——页面标题先后声明为 22 / 26 / 30 / 36px、行高 64 / 68 / 90px、行按钮一轮 30px 下一轮 42px——而**插件页（10–12px）、模型页（10–13px）与"应用与后台"的活动任务（11px）一轮都没被覆盖**，于是同一个设置区里出现相差 6px 的两套字阶，同一个开关还有三套几何（32×18 / 36×20 / 48×30）。参考图那一轮还把 `.development-environment-group-heading` 写成组件里不存在的类名（组件渲染的是 `.development-environment-group-title`），开发环境页的分组标题因此静默保持 11px。现在同一选择器不再重复声明；`settings-typography.test.ts` 比较的是**最终生效值**，并拒绝同层重复声明、校验样式表点到的类名确实有组件渲染。

## 入口 → 页面 → 返回目标

每个模块只有一个页面身份；不同入口指向同一个页面组件，不复制状态。

| 入口 | 页面 | 返回目标 |
| --- | --- | --- |
| 侧边栏「设置」 | 设置总览 `home` | 关闭设置回到打开设置前的路由（`settingsReturnRouteRef`），前进/后退按钮走全局历史 |
| 设置侧边栏（14 项，四组 + 工作模块）/ 总览常用入口（4 项） | 对应设置页（含「界面」`appearance`） | 同一设置壳内切换；关闭设置回到进入前的路由 |
| 设置搜索结果 | 常用页 + 未接入的「已安排」 | 与点侧栏一致：`onOpenPage(id)` 走同一条路由，因此返回/前进历史照旧 |
| 侧边栏「记忆树」「已安排」「插件」 | 直接模块页 `DirectModuleWorkspace` | 全局返回按钮回到进入前的路由，不再叠加一层设置壳 |
| 设置「归档」「技能」「外部渠道」 | 复用 `ArchiveManager`、`MemorySkills`、`ChannelConnections`（embedded） | 关闭动作与 Escape 回设置总览；这三页不新增自己的返回栈 |

页面身份由 `types.ts` 的 `SettingsPage` 联合类型唯一声明：`navigation.ts` 的搜索索引、`persistent-state.ts` 的可恢复集合和 `workspace.tsx` 的渲染分支必须覆盖同一批 id，`navigation.test.ts` 会对三者做集合比对，新增页面必须同时登记，否则重启恢复会静默丢弃该页。

**名称一致性（UX-12/UX-13 实机验收，S1 后更新）**：同一功能在导航条目、页面标题与各入口里必须是同一个名字。S1 之前是「总览 14 行 = 侧栏 15 项逐行同名」（实测 `missingInNav: []`）；S1 之后侧栏是 14 项（四组 12 项 + 工作模块 2 项），总览只保留 4 个常用入口 + 配置问题提醒，因此这条断言改成**方向性**的：总览出现的每一行（常用入口）仍必须在侧栏同名，而侧栏的 14 项不再要求出现在总览里。「已安排」退出常用导航后，走查改为先在设置搜索里输入「已安排」再点结果，并断言页面标题仍是「已安排」（`pnpm run verify:settings-navigation-terminology` 的第 4 步）。记忆树 / 插件两个工作模块从侧边栏直接打开与从设置进入仍是同一标题，关闭设置回到**打开设置前的那一页**；外部渠道页的标题曾是「渠道连接」，与导航条目、空态和反馈文案里的「外部渠道」不一致，已统一为「外部渠道」。

「界面」只放显示偏好（对话显示密度），「Agent 行为」只放 profile 与上下文策略（压缩阈值收在「高级上下文设置」折叠里），权限继续只由输入栏的权限模式控制。

网络检索页（`web.tsx`、`web-state.ts`）的 Tavily 配置通过 Main-owned `/config/web-provider` 路由完成：密钥进入 Electron `safeStorage`，配置文件只保存 `$TAVILY_API_KEY` 引用；保存密钥不会自动打开网络总开关。

页面中的“检查 Tavily 连接”调用固定的 Main-owned provider-check 路由，只在网络已启用且用户主动点击时执行一次受限搜索；成功后 Web 状态才显示 `ready`。检查结果只存在进程内、不写入配置，网络检索策略变化即失效；设置页不会自行判断或伪造 Provider 健康状态。

**模型行的宽度契约（UX-15 实测）**：`provider-model-row` 在宽布局下是四字段一行（`minmax(0,1.4fr) minmax(0,1fr) 150px 150px 26px`），列名由共享的 `provider-model-columns` 表头给出；当**设置内容宽度 ≤560px**（`provider-editor` 上的容器查询）时改为堆叠布局：字段各占一行、`provider-model-columns` 表头隐藏、每个字段显示自己的 `provider-model-field-label`。实测（800×600 最小窗口，内容宽 474px）此前两个弹性字段只剩 62px 与 44px，堆叠后四个字段各 425px；宽布局（1280×840，内容宽 760px）仍是一行、最小字段 150px。每个模型输入都带 `aria-label`，所以两种布局都有可访问名称。

`plugins.tsx` 为 394 行，暂处 300-600 行软上限区间，原因是发现状态、筛选、启停、来源确认和本地代码授权共同组成一个插件管理事务；新增插件能力应进入插件宿主或独立设置组件，不能继续堆入该页。
