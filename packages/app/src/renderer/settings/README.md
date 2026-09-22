# Renderer 设置
最后更新：2026-09-22 12:41:58

这里负责设置侧边栏、设置页和直接打开的记忆树/插件/已安排页面。设置与主页共用全局导航和侧边栏交互，但不复制运行时数据。

- `navigation.ts`、`types.ts`：设置分组和页面契约。
- `workspace.tsx`、`home.tsx`：设置壳与总览；归档、技能和外部渠道页复用 Renderer 根目录的 `ArchiveManager.tsx`、`MemorySkills.tsx`、`ChannelConnections.tsx`。
- `agent-profile.tsx`、`storage.tsx`、`scheduled.tsx`、`plugins.tsx`、`direct-module.tsx`：领域页面。
- `models.tsx`、`model-provider-editor.tsx`、`model-provider-draft.ts`：模型供应商卡片、编辑对话框和纯校验草稿。
- `web.tsx`、`web-state.ts`、`browser.tsx`、`development-environments.tsx`：网络检索、内置浏览器和开发环境注册表页面。
- `application-background.tsx`、`active-run-row.tsx`、`application-background-state.ts`：三档关闭策略与活动任务控制。活动列表通过 `api/application-lifecycle.ts` 的 SSE 订阅同步，手动刷新只用于快照校准，不使用常驻轮询。

页面只能通过 Renderer API 读写主进程服务；任何迁移、密钥、插件启停或归档操作都必须保留错误、取消和恢复状态。
长生命周期页面必须在卸载时中止 fetch/stream、清除重连 timer，并依赖 Main 的监听器释放契约；不得让设置页成为 Runtime 状态权威源。

网络检索页（`web.tsx`、`web-state.ts`）的 Tavily 配置通过 Main-owned `/config/web-provider` 路由完成：密钥进入 Electron `safeStorage`，配置文件只保存 `$TAVILY_API_KEY` 引用；保存密钥不会自动打开网络总开关。

页面中的“检查 Tavily 连接”调用固定的 Main-owned provider-check 路由，只在网络已启用且用户主动点击时执行一次受限搜索；成功后 Web 状态才显示 `ready`。检查结果只存在进程内、不写入配置，网络检索策略变化即失效；设置页不会自行判断或伪造 Provider 健康状态。

`plugins.tsx` 为 394 行，暂处 300-600 行软上限区间，原因是发现状态、筛选、启停、来源确认和本地代码授权共同组成一个插件管理事务；新增插件能力应进入插件宿主或独立设置组件，不能继续堆入该页。
