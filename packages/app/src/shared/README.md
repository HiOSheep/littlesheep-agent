# App Shared Contracts

最后更新：2026-09-26 04:43:19

保存 Electron main 与 renderer 共同使用的纯数据模型和无副作用规则。

## 边界

- 当前包含权限模式、模型能力、会话/项目与 session scope、工作区与 Git 审阅、运行时与应用状态、数据根、运行检查点/用量/压缩操作、记忆控制面、附件、插件/渠道、浏览器控制、开发环境和历史活动等共享规则。
- `permission-modes.ts` 只描述三档授权策略并兼容旧 id；行为 profile（`general`/`coding`）由 `@littlesheep/prompt` 的 `AgentProfileId` 管理，`../main/modes.ts` 只是转发 shim。逻辑容器根由 Main 解析，Renderer 不拥有最终边界判断。
- `workspace-contracts.ts` 的 `WorkspaceLayoutSnapshot` 现在同时带 `fileNavigatorWidth` 与 `reviewNavigatorWidth`（后者可选，UX-18）：普通文件导航与审阅更改列表各有自己的宽度，共用 `WORKSPACE_FILE_NAVIGATOR_WIDTH_*` 上下限；旧快照缺该字段时由两侧各自回落默认值，不能继承另一个宽度。
- `context-usage-contracts.ts` 的 `SessionContextUsageRecord` 增加 `sessionCache`（`SessionCumulativeCacheUsage`）：会话累计缓存复用，字段与验收账本一致，精确值不做取整。
- `run-checkpoint-contracts.ts` 的 `LocalAppRunCheckpointDiagnostics` 两个计数**互斥**：`invalidFiles` 是最近一次扫描读不出来的记录数（每份文件算一次），`warningCount` 只统计不属于这些记录的发现（残留临时文件、目录 I/O）。此前 `warningCount` 取诊断条目总数，而每条坏记录自己也贡献一条，同一份文件因此被同时说成"无法读取"和"不完整"；领域实现见 `@littlesheep/runner` 的 `run-checkpoint-scan.ts`。
- `runtime-readiness-contracts.ts` / `runtime-readiness-ipc.ts`：执行就绪的唯一载荷与通道契约（`starting`/`ready`/`failed` + 阶段 + 原因 + 端口，`apiVersion` 校验）、渲染器启动计时的通道名与封闭阶段白名单，以及失败后**有界重试**的通道（`RUNTIME_RETRY_EXECUTION_CHANNEL`；渲染器计时白名单另含 `renderer-workspace-entries` / `renderer-workspace-preview` 两个"右侧真正可用"阶段；回答带 `accepted` / `attemptsUsed` / `attemptsRemaining` / `refusedBecause`，窗口据此如实呈现"这次没被接受"）。窗口早于 Runner 出现，这两个文件是渲染器判断"能不能执行、能不能重试"的唯一协议来源。
- `local-app-api-routes.ts` 的 `browserDiagnostics: '/browser/diagnostics'`（UX-26）只读投影 Main 的页面诊断记录（按 `?url=` 过滤），供运行读数使用。
- `local-app-api-routes.ts` 是两侧唯一的路径目录（静态路由、动态前缀和 ID 编解码都只认它）。UX-26 新增 `workspacePreviewServer: '/workspace/preview-server'`：`POST` 为选定工作区的 HTML 页面启动有界 loopback 服务并返回带 token 的 URL，`DELETE` 停止它，`GET` 列出现有服务；服务本身的边界（根范围、真实路径、token、Host、生命周期）由 `../main/local-app-api/workspace-preview-server.ts` 拥有，这里只登记路径。
- `channel-control-contracts.ts` 的 `ChannelStatus.running` 带后端契约：`ChannelConnectionsStatus.channels` 来自 `PluginHost.listChannels()`，即渠道管理器的**运行表**（停止会移出条目，启动失败进 `failures`），所以列出的条目按契约就是在运行的；字段保留是因为设置页必须按运行项计数，不能把"已配置"或"列表非空"当成连接健康。契约由 `packages/plugins/src/channel/manager.test.ts` 钉住，四种 fixture 的真实窗口核对见 `pnpm run verify:channel-entry-states`。
- 只能依赖纯 TypeScript 契约，不依赖 Electron、React、文件系统或网络；测试可以用隔离临时目录。
- 跨 package 的稳定协议应进入 `@littlesheep/types`；仅 App 两侧共享的模型留在此处。

主要契约：`session-project-contracts.ts`、`session-scope.ts`、`workspace-contracts.ts`、`workspace-review-contracts.ts`、`runtime-api-contracts.ts`、`runtime-event-contracts.ts`、`application-state-contracts.ts`、`run-checkpoint-contracts.ts`、`run-usage.ts`、`compaction-operation-contracts.ts`、`context-usage-contracts.ts`、`cache-call-observations.ts`、`history-activity.ts`、`memory-control-contracts.ts`、`attachment-contracts.ts`、`plugin-control-contracts.ts`、`channel-control-contracts.ts`、`browser-control-contracts.ts`、`development-environment-contracts.ts`、`permission-modes.ts`、`model-capabilities.ts`、`window-drag-contracts.ts` 和 `local-app-api-routes.ts`。

## 测试与修改定位

- 每个共享模块均应有同目录测试（当前已有 `permission-modes`、`model-capabilities`、`run-usage`、`cache-call-observations`、`history-activity`、`session-scope`、`window-drag-contracts`、`local-app-api-routes`）。
- 修改持久化字段时同时检查 main 生产者、renderer 消费者和旧快照兼容。

## 工作区磁盘状态路由（2026-09-26）

`local-app-api-routes.ts` 增加 `workspaceFileStat: '/workspace/file-stat'`：打开文件的元数据查询（exists/modifiedAt/size），供预览面板发现外部改写或删除（UX-25 第 3 条）。

## 审阅快照的 unstable 字段（2026-09-26）

`workspace-review-contracts.ts` 的 `WorkspaceReviewSnapshot` 增加可选 `unstable?: boolean`：仓库在全部有界重读尝试期间仍在变化时为 true（UX-27 第 2 条），缺省即"读取一致"。渲染器据此提示，而不是把混合状态当成已结算结果。

## 审阅可用性的失败分类（2026-09-26）

`workspace-review-contracts.ts` 的 `WorkspaceReviewAvailability` 除 `ready`/`not-repository`/`git-unavailable` 外，新增 `dubious-ownership`/`permission-denied`/`corrupt-repository`/`timed-out`/`cancelled`/`git-error`：非 ready 的快照都带一句可执行原因，渲染器只需显示 `message`（UX-28 第 1 条）。