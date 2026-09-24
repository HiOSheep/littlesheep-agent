# Renderer 设置
最后更新：2026-09-25 06:53:14

这里负责设置侧边栏、设置页和直接打开的记忆树/插件/已安排页面。设置与主页共用全局导航和侧边栏交互，但不复制运行时数据。

- `navigation.ts`、`types.ts`：设置分组和页面契约。
- `workspace.tsx`、`home.tsx`：设置壳与总览；归档、技能和外部渠道页复用 Renderer 根目录的 `ArchiveManager.tsx`、`MemorySkills.tsx`、`ChannelConnections.tsx`。
- `agent-profile.tsx`、`appearance.tsx`、`storage.tsx`、`scheduled.tsx`、`plugins.tsx`、`direct-module.tsx`：领域页面；`appearance.tsx` 只放显示偏好（对话显示密度，普通/紧凑，存储仍是 `normal`/`compact`），`agent-profile.tsx` 只放 profile 与上下文策略（压缩阈值收在“高级上下文设置”折叠里），术语统一遵循 `docs/principles/ui-interaction-guidelines.md` 的术语表。
- `scheduled.tsx`：计划任务尚未接入 Runtime，因此页面只声明“功能尚未接入”，不提供筛选或创建控件，也不显示“暂无数据”式的空态；侧边栏、设置总览和直接模块页共用这一个页面，入口描述同样标注未接入。
- `models.tsx`、`model-provider-editor.tsx`、`model-provider-draft.ts`、`provider-editor-session.ts`：模型供应商卡片、编辑对话框、纯校验草稿和会话级草稿存储；删除供应商先经 `ui/danger-confirm.tsx` 确认，影响文案来自 `deletion-impact.ts`，只描述配置条目移除，不声称密钥被清除。空态明确写出“保存配置只代表写入了密钥和模型声明，不代表 LS 已经验证过它真的可以调用”，与输入栏的 `runtime-availability.ts` 用同一个 `isConfiguredProvider` 判定“已配置”。
- `web.tsx`、`web-state.ts`、`browser.tsx`、`development-environments.tsx`：网络检索、内置浏览器和开发环境注册表页面。
- `application-background.tsx`、`active-run-row.tsx`、`application-background-state.ts`：三档关闭策略与活动任务控制。活动列表通过 `api/application-lifecycle.ts` 的 SSE 订阅同步，手动刷新只用于快照校准，不使用常驻轮询。

页面只能通过 Renderer API 读写主进程服务；任何迁移、密钥、插件启停或归档操作都必须保留错误、取消和恢复状态。
长生命周期页面必须在卸载时中止 fetch/stream、清除重连 timer，并依赖 Main 的监听器释放契约；不得让设置页成为 Runtime 状态权威源。

供应商编辑的草稿策略：设置容器按 `key={page}` 重新挂载页面，因此草稿保存在 `provider-editor-session.ts` 的**模块内存**里（不写 localStorage、不写日志、不落盘）：切换设置页再回来会恢复草稿并说明来源；提交时先清空草稿副本，避免保存中的内容在别的页面显示为待保存编辑；保存失败把可修正内容放回原处并就地显示失败；取消与保存中禁止关闭都会丢弃或推迟处理。明文密钥只在这份内存草稿里存在，保存或取消后立即丢弃。编辑器自身显示四种状态：未改动不提示、`已修改，尚未保存。`、`保存中…`、`保存失败：…`（`role="alert"`），头部关闭按钮在保存中禁用；`providerDraftIsDirty` 逐字段比较（含模型行与明文密钥），因此"改回原值"算干净。关闭是模态唯一出口，有未保存修改时先出现 `provider-editor-discard`（`role="alertdialog"`：继续编辑 / 丢弃修改），不会静默丢弃；由于编辑器是否渲染由会话草稿决定，带着未保存草稿切回该页会自动重新打开编辑器（实机验收记录在 `scripts/verify-provider-editor-draft.mjs`）。

异步操作的反馈统一走 `ui/feedback.ts` 的结构：色调来自操作结果字段而不是解析文案，失败留在发起操作处并带可重试动作，长 Runtime 错误有界折叠。因此设置页的每一处写操作都必须把结果带回来：供应商保存/删除、插件启停与重载在页面内显示；压缩阈值保存经由 `applyRuntimePatchReporting` 把失败文本返回给页面（不再只写进聊天区的错误行），重新加载失败也不会留下旧的成功提示。

## 入口 → 页面 → 返回目标

每个模块只有一个页面身份；不同入口指向同一个页面组件，不复制状态。

| 入口 | 页面 | 返回目标 |
| --- | --- | --- |
| 侧边栏「设置」 | 设置总览 `home` | 关闭设置回到打开设置前的路由（`settingsReturnRouteRef`），前进/后退按钮走全局历史 |
| 设置侧边栏 / 总览列表 | 对应设置页（含「界面」`appearance`） | 同一设置壳内切换；关闭设置回到进入前的路由 |
| 侧边栏「记忆树」「已安排」「插件」 | 直接模块页 `DirectModuleWorkspace` | 全局返回按钮回到进入前的路由，不再叠加一层设置壳 |
| 设置「归档」「技能」「外部渠道」 | 复用 `ArchiveManager`、`MemorySkills`、`ChannelConnections`（embedded） | 关闭动作与 Escape 回设置总览；这三页不新增自己的返回栈 |

页面身份由 `types.ts` 的 `SettingsPage` 联合类型唯一声明：`navigation.ts` 的分组、`persistent-state.ts` 的可恢复集合和 `workspace.tsx` 的渲染分支必须覆盖同一批 id，`navigation.test.ts` 会对三者做集合比对，新增页面必须同时登记，否则重启恢复会静默丢弃该页。

**名称一致性（UX-12/UX-13 实机验收）**：同一功能在导航条目、页面标题与各入口里必须是同一个名字。设置总览的 14 行与侧边栏的 15 项逐行同名（实测 `missingInNav: []`）；记忆树 / 已安排 / 插件三个工作模块从侧边栏直接打开与从设置进入得到同一标题，关闭设置回到**打开设置前的那一页**（实测返回后仍是该模块，不是聊天）；外部渠道页的标题曾是「渠道连接」，与导航条目、空态和反馈文案里的「外部渠道」不一致，已统一为「外部渠道」。整条走查见 `pnpm run verify:settings-navigation-terminology`。

「界面」只放显示偏好（对话显示密度），「Agent 行为」只放 profile 与上下文策略（压缩阈值收在「高级上下文设置」折叠里），权限继续只由输入栏的权限模式控制。

网络检索页（`web.tsx`、`web-state.ts`）的 Tavily 配置通过 Main-owned `/config/web-provider` 路由完成：密钥进入 Electron `safeStorage`，配置文件只保存 `$TAVILY_API_KEY` 引用；保存密钥不会自动打开网络总开关。

页面中的“检查 Tavily 连接”调用固定的 Main-owned provider-check 路由，只在网络已启用且用户主动点击时执行一次受限搜索；成功后 Web 状态才显示 `ready`。检查结果只存在进程内、不写入配置，网络检索策略变化即失效；设置页不会自行判断或伪造 Provider 健康状态。

**模型行的宽度契约（UX-15 实测）**：`provider-model-row` 在宽布局下是四字段一行（`minmax(0,1.4fr) minmax(0,1fr) 150px 150px 26px`），列名由共享的 `provider-model-columns` 表头给出；当**设置内容宽度 ≤560px**（`provider-editor` 上的容器查询）时改为堆叠布局：字段各占一行、`provider-model-columns` 表头隐藏、每个字段显示自己的 `provider-model-field-label`。实测（800×600 最小窗口，内容宽 474px）此前两个弹性字段只剩 62px 与 44px，堆叠后四个字段各 425px；宽布局（1280×840，内容宽 760px）仍是一行、最小字段 150px。每个模型输入都带 `aria-label`，所以两种布局都有可访问名称。

`plugins.tsx` 为 394 行，暂处 300-600 行软上限区间，原因是发现状态、筛选、启停、来源确认和本地代码授权共同组成一个插件管理事务；新增插件能力应进入插件宿主或独立设置组件，不能继续堆入该页。
