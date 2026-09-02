# LittleSheep 模块拆分地图

最后更新：2026-09-02 20:45:00

本文件记录大型生产文件的当前所有权、目标边界和拆分顺序。它是仓库基元化任务书的阶段产物，不替代项目状态，也不把行数当成唯一质量指标。

## 规则

- 生产文件目标不超过 300 行。
- 301-600 行是软上限：先确认单一职责，不能继续吸收新领域；确需保留时登记例外。
- 超过 600 行默认进入强制拆分队列；先冻结 facade 和特征测试，再移动实现。
- 拆分必须保持公共 API、持久化格式、URL、动画、导航、恢复和用户数据语义。
- 阶段 0-2 串行；共享契约冻结后按 A 文档、B Renderer、C Main/Adapter、D Memory、E Harness/Context 分配所有权。

## 强制拆分队列

下表行数是 2026-09-02 冻结前工作树的物理行数，不是历史完成值。生产 `.ts/.tsx` 文件超过 600 行必须进入本表；已登记不等于要求立即做无收益拆分。当前仓库卫生扫描共有 111 个生产文件超过 300 行，其中 15 个超过 600 行并进入受控清单。

| 当前文件 | 当前行数 | 当前责任 | 目标边界 | 所有权 |
| --- | ---: | --- | --- | --- |
| `packages/runner/src/runner.ts` | 2144 | run 生命周期、输入装配、Memory 反馈、日志、检查点持久化/续跑、活动任务注册、后台维护准入透传和资源收尾 | 保持应用服务 facade；活动快照与中断/超时所有权已下沉，继续下沉日志、检查点和收尾协调；checkpoint 预算重concile 保持在 `run-checkpoint.ts` 边界 | E |
| `packages/harness/src/durable-kernel.ts` | 412 | durable event command validation、effect lifecycle、projection rebuild 和 final settlement reducer | 保持纯协议/kernel 边界；Runner 只提供 event store/inbox adapter，后续拆分 event reducer 与 settlement policy | E |
| `packages/runner/src/durable-event-store.ts` | 289 | 哈希分区、append-only event 文件、cursor/idempotency 校验和 fail-closed replay | 保持文件 store facade；后续按 codec、partition IO、replay query 拆分 | E |
| `packages/runner/src/durable-inbox-store.ts` | 338 | 持久 command inbox、claim lease、重启 requeue、complete/fail 和幂等校验 | 保持 inbox facade；后续按 codec、lease policy、query 拆分 | E |
| `packages/app/src/renderer/app-shell/use-app-controller.ts` | 656 | Renderer 跨领域兼容协调、启动恢复、Runtime 设置和视图快照 | 保持装配 facade；启动恢复、持久化和领域投影继续下沉，冻结期间不得继续吸收新职责 | B |
| `packages/channels/qqbot/src/plugin.ts` | 803 | QQ 协议、连接、消息、发送和生命周期 | transport、protocol、message-mapper、sender、lifecycle | C |
| `packages/memory-tree/src/project-memory-projection.ts` | 780 | 投影生成、同步、冲突、恢复和删除 | projection facade + render、sync、conflict、lifecycle | D |
| `packages/types/src/runtime-contracts.ts` | 859 | Context、事件、检查点、活动任务控制、执行证据和版本化运行时契约 | Token 账本已迁入 `token-ledger.ts`；继续按 context、event、checkpoint、active-run、execution 分组并保持 barrel | E |
| `packages/runner/src/runtime-event-queue.ts` | 729 | run/session 隔离、有界事件、幂等、租约、结算和快照恢复 | `RunContext` 顶层 runtime state 已由 Harness `runtime-state.ts` 统一批次写入；本文件继续独占 queue codec、lease/settle、registry 和快照恢复内部状态，保持 facade 稳定 | E |
| `packages/runner/src/run-checkpoint-store.ts` | 875 | 检查点 codec、原子存储、校验、列表、容量、保留期和 conversation-turn 查询 | 分离 schema/codec、store、query 与 retention policy | E |
| `packages/app/src/renderer/workspace/line-comments.tsx` | 448 | 普通文件与双列 diff 的行号映射、手势、装饰、共享评论 surface 装配和附件发布 | 保留 Monaco 映射与交互 adapter；draft、表单、卡片、几何和通用 view-zone 生命周期由共享模块维护 | B |
| `packages/memory-tree/src/memory-tree.ts` | 655 | 根索引、导航、展开和搜索；working set 预算/去重/释放已拆出 | tree facade + index、navigation、expansion、branch-search | D |
| `packages/channels/feishu/src/plugin.ts` | 633 | 飞书验签、事件、消息、发送和生命周期 | verification、transport、message-mapper、sender、lifecycle | C |
| `packages/app/src/main/data-root-migration.ts` | 628 | locator、清单、复制、重绑定、提交、恢复和回滚 | migration facade + plan、manifest、copy、rebind、commit、recovery | C |
| `packages/memory-tree/src/v3/catalog.ts` | 626 | Memory v3 Catalog facade、Atom/FTS/账本/due/激活投影 | ledger/due 管理与 management projection 继续下沉 | D |
| `packages/runner/src/run-checkpoint-disposition-store.ts` | 683 | waiting-user disposition、claim、恢复租约与有界审计持久化 | 分离 disposition codec、query 与 retention；保持原子 claim facade | E |

## 软上限审查队列

| 当前文件 | 当前行数 | 主要责任 | 处理方向 | 所有权 |
| --- | ---: | --- | --- | --- |
| `packages/memory-tree/src/types.ts` | 580 | 记忆树内部和持久化类型 | 按 node、resource、audit、projection 分组 | D |
| `packages/harness/src/tests/helpers.ts` | 308 | Harness 测试夹具与 RunContext 构造 | 按夹具领域拆分；测试 helper 不进入生产 Harness 依赖 | E |
| `packages/types/src/agent.ts` | 470 | 状态机、活动路由兼容、RunContext、stage 与 Hook 契约 | TaskBook 已迁入 `task.ts`；继续保持状态机与运行上下文边界，不再吸收领域协议 | E |
| `packages/types/src/run-context-contract.ts` | 428 | 八组高频 RunContext 字段的 owner、读写阶段、生命周期和写入查询 | 保持 machine-readable manifest；继续由 `replan-state.ts`、`reply-state.ts`、`runtime-state.ts`、`memory-state.ts`、`usage-state.ts`、`decision-state.ts`、`failure-state.ts`、`execution-evidence-state.ts`、`model-observability-state.ts` 等领域边界消费，不把具体状态写入逻辑吸回 types | E |
| `packages/tools/src/tool-execution-service.ts` | 583 | 工具查找、校验、审批、执行生命周期、事件与结构化记录 facade | 调度、中断、记录摘要和结果处理已拆分；facade 不吸收 Harness 编排或副作用状态所有权 | E |
| `packages/memory-tree/src/memory-repository/v3-node-store.ts` | 581 | v3 节点查询、写入编排、层级和实体关联 | 事件与生命周期规则已拆出；后续分离 query projection 与 write coordinator | D |
| `packages/web/src/fetch/dns-resolver.ts` | 395 | 系统/固定 Cloudflare DoH 解析、DNS wire 校验、TTL 缓存和取消边界 | 保持 DNS resolver 单一职责；若继续增长，拆分 wire codec、transport 与 cache，同时保持 URL policy 只接收已验证地址 | C |
| `packages/app/src/renderer/sidebar/session-actions.ts` | 315 | 对话切换、历史分页、归档/删除及会话视图令牌失效 | 保持会话生命周期 facade；历史加载和视图令牌继续共享同一会话代次边界 | B |
| `packages/app/src/main/local-app-api/run-checkpoint-routes.ts` | 304 | checkpoint 发现、详情、补充信息、续跑、停止和放弃路由 | 保持路由 facade；将恢复准入和响应投影继续下沉到独立 adapter | C |
| `packages/memory-tree/src/memory-repository/v3-resource-store.ts` | 575 | v3 资源元数据、生命周期事务、实体投影和恢复 | 分离 resource registry、transaction recovery 与 graph projection | D |
| `packages/app/src/main/index.ts` | 600 | Electron 启动和组合；窗口、托盘、关闭策略、活动任务聚合、Memory v3、桌面验收采样与内置浏览器宿主已下沉；后台维护准入由 `background-maintenance-policy.ts` 提供 | 继续抽取 bootstrap 服务，入口只保留装配顺序 | C |
| `packages/app/src/renderer/workspace/terminal.tsx` | 564 | 用户交互 PTY 生命周期、SSE、尺寸、命令历史和输入队列 | 保持终端事务边界，禁止吸收工作区导航或 Agent 审批职责；来源与 Agent 权限语义由 Main 明确拥有 | B |
| `packages/memory-tree/src/v3/contracts.ts` | 547 | Memory v3 atom、认识状态、事件、实体、证据与 Embedding 契约 | 按 atom、event、graph、evidence 分组并保持 barrel | D |
| `packages/snapshot/src/git-checkpoint.ts` | 546 | 数据与工作区两阶段 checkpoint、同步回退和退出冻结协调 | 保持事务 facade；文件筛选、manifest codec 与 Git plumbing 已独立 | E |
| `packages/memory-tree/src/memory-repository/v3-migration.ts` | 538 | v2->v3 请求登记、启动执行、恢复、受约束回滚和 locator 状态机 | 保持事务 facade；若继续增长，分离 request/recovery 与 rollback coordinator | D |
| `packages/plugins/src/host.ts` | 538 | 插件发现、加载、启停、贡献迁移 | 分离 discovery、activation、contribution、reconcile | C |
| `packages/memory-tree/src/legacy-memory-branches.ts` | 509 | 旧记忆分支兼容 | 保持隔离，迁移结束后缩减或退役 | D |
| `packages/memory-tree/src/memory-repository/v3-ledger.ts` | 502 | v3 分片审计、恢复队列、scope alias、schema migration 兼容和事务账本 | 一次性 v2 导入已放入独立迁移模块；后续分离 audit shards、recovery queue 与 transaction ledger | D |
| `packages/app/src/main/attachment-cache.ts` | 488 | 附件索引、配额、清理和校验 | 分离 index、quota、cleanup、validation | C |
| `packages/memory-tree/src/memory-repository/v3-backend.ts` | 488 | v3 后端组合、检索 facade、management adapter 和写后维护协调 | 保持组合层；若继续增长，拆出生命周期与 maintenance adapter | D |
| `packages/memory-tree/src/v3/maintenance-worker.ts` | 382 | v3 embedding/due 后台维护、延迟调度、批次预算和可中止收尾 | 保持有界 worker；后续若扩展维护种类，拆 scheduler 与 batch adapters | D |
| `packages/app/src/shared/memory-control-contracts.ts` | 486 | 记忆文件、资源、投影、迁移和治理控制面公共契约 | 按普通文件视图与内部治理契约分组，保持 shared 无运行逻辑 | C |
| `packages/app/src/main/local-app-api/run-routes.ts` | 383 | run 流式入口、运行时事件 ingress 和收尾路由 | 保持 HTTP 路由组合；检查点恢复与应用生命周期控制面使用独立 adapter | C |
| `packages/app/src/main/local-app-api/terminal-process.ts` | 305 | PTY、ConPTY 与 spawn fallback 的终端进程适配、关闭状态和输入错误收敛 | 保持进程适配器边界；继续将平台差异和 write-after-close 保护留在此层 | C |
| `packages/app/src/main/provider-calibration.ts` | 318 | 运行中 Provider 的 chat、continuity、tool、abort 有界校准 | 保持纯校准编排与脱敏结果；Provider 客户端和凭证仍由 Runner/Main 负责，不继续吸收通用运行逻辑 | C |
| `packages/app/src/renderer/workspace/preview-pane.tsx` | 378 | 编辑草稿、Monaco/Markdown/媒体预览和预览状态栏 | 文件加载与保存事务已下沉到 `file-view.tsx`；继续保持编辑与展示边界 | B |
| `packages/app/src/main/local-app-api/workspace-git-review-cache.ts` | 272 | Main Git 审阅快照缓存、revision、并发、取消、TTL 和容量预算 | 保持缓存策略与 Git 解析、路由分离 | C |
| `packages/app/src/renderer/Markdown.tsx` | 305 | 聊天与预览中的 Markdown、流式分段、安全链接、代码块和 Mermaid 图表渲染 | 保持纯展示与链接导航边界；若继续增长，拆出 Mermaid/代码块渲染 adapter | B |
| `packages/memory-tree/src/v3/storage-coordinator.ts` | 308 | v3 raw/event/operation/atom/catalog 事务协调与恢复 | 保持事务边界；后续拆 recovery replay 与 commit projection | D |
| `packages/app/src/renderer/api/workspace-files.ts` | 337 | Renderer 工作区文件 API、目录有界缓存与失效 | 若继续增长，拆分缓存与请求 helper | B |
| `packages/app/src/renderer/workspace/review.tsx` | 316 | 审阅可见生命周期、single-flight 刷新、共享导航装配和树/差异选择 | 保持 policy、model 与 view helper 分离；单双列偏好留在 Renderer UI 层 | B |
| `packages/app/src/main/memory-tree-control.ts` | 474 | 记忆控制面查询、v3 D0-D3 详情适配和既有管理命令 | 分离 query/detail、resource、projection command | C |
| `packages/llm/src/client.ts` | 463 | 请求、流式、reasoning、重试适配 | 分离 request builder、stream parser、response mapper | E |
| `packages/harness/src/stages/execute/tool-loop.ts` | 604 | 单步模型工具循环、审批、失败记录、时间感知、消息续接和紧凑后续请求 | 受控超限复查：2026-09-03；分离 loop policy、invocation adapter 与 transcript；不得继续吸收检查点恢复或回答连续性判定 | E |
| `packages/harness/src/cache-observability.ts` | 485 | Provider、Context、Memory/Embedding 三套缓存账本、脱敏指纹和失效原因 | 保持观测适配器边界；真实 Provider 对账与 durable event log 接入后再按 ledger、fingerprint、report 拆分 | E |
| `packages/harness/src/model-observability.ts` | 325 | 模型请求快照、Context 关联、Provider usage 与缓存观测绑定 | 保持请求观测 facade；后续将 provider reconciliation 与 request snapshot projection 下沉 | E |
| `packages/memory-tree/src/memory-repository/resource-store.ts` | 454 | 资源注册、生命周期、重绑定和审计 | 分离 registry、lifecycle、rebind、audit | D |
| `packages/memory-tree/src/v3/event-journal.ts` | 451 | Memory v3 event 与 operation journal 的同构恢复语义 | 契约稳定后拆为两个 store，共享 bounded journal codec | D |
| `packages/memory-tree/src/workspace-resource-index.ts` | 448 | 工作区资源索引、游标和更新 | 分离 store、scanner state、change-set | D |
| `packages/app/src/renderer/workspace/file-navigator.tsx` | 436 | 目录缓存、筛选、展开路径、文件树和可见性取消 | 与 `navigator-frame.tsx` 共享壳；建立树状态特征测试后再拆 controller/view；目录请求取消与缓存恢复保持在独立 loader 边界 | B |
| `packages/harness/src/taskbook-patch.ts` | 525 | TaskBook 局部修订契约、校验和合并 | 保持纯任务书补丁边界；若继续增长，分离 schema、merge 和 validation | E |
| `packages/memory-tree/src/memory-repository/v3-atom-management.ts` | 443 | Atom move/merge/revise/invalidate/reactivate 原子 mutation 与审计 | 保持持久化 mutation 边界；语义准入留在独立 service | D |
| `packages/runner/src/execution-log.ts` | 469 | 执行日志 schema、写入、查询与按会话原子摘要 sidecar | 分离 codec、store、query 与 latest-summary store | E |
| `packages/session/src/manager.ts` | 438 | 会话 JSONL、metadata、回复指纹、压缩投影与摘要 activation facade | 保持 facade；继续增长时拆 compaction/activation adapter | E |
| `packages/session/src/reply-fingerprint-store.ts` | 307 | 旧文本回复去重、final settlement reservation/settle sidecar、会话重启恢复与原子锁 | 保持会话级幂等存储边界；继续增长时分离 legacy fingerprint 与 settlement registry codec | E |
| `packages/memory-tree/src/v3/atom-store.ts` | 437 | atom 原子读写、轻量索引、扫描、层级和隔离 | 保持 store facade；规模验收稳定后分离 scanner/quarantine | D |
| `packages/runner/src/infra.ts` | 450 | 默认基础设施创建与 Memory v3 后台维护准入回调注入 | 按 memory、tools、session、skills adapter 分组 | E |
| `packages/app/src/renderer/workspace/tab-strip.tsx` | 410 | 工作区标签渲染、关闭、重排、拖拽和溢出标签 | 将拖拽 controller 与标签视图继续保持独立，禁止吸收面板状态 | B |
| `packages/app/src/renderer/workspace/panel.tsx` | 399 | 拓展工作区页面、评论状态和工作面装配 | 保持纯组合；标签条、浏览器和文件预览事务已分别下沉 | B |
| `packages/app/src/main/development-environments.ts` | 421 | LS 工具链管理 facade、版本偏好、导入/移除事务和终端环境派生 | 保持 facade；下载器不得回填此文件 | C |
| `packages/app/src/renderer/workspace/browser.tsx` | 411 | 内置浏览器标签、导航、加载状态和网页内跳转 | 保持视图组合；历史算法和导航资格留在独立模块 | B |
| `packages/app/src/renderer/workspace/code-editor.tsx` | 355 | Monaco 编辑器唯一懒加载、模型/视图生命周期和代码查看/编辑适配 | 保持编辑器运行时单一所有者；继续将语言支持与视图状态留在独立边界，不在普通文件/审阅组件重复初始化 | B |
| `packages/app/src/renderer/workspace-persistence.ts` | 565 | 会话工作区布局 schema、draft 迁移、路径重绑定、快照恢复与规范化 | 保持纯数据转换边界；继续增长时分离 schema/codec 与路径转换 | B |
| `packages/app/src/renderer/workspace/use-workspace-session-layouts.ts` | 413 | 会话工作区桶、draft 接管、本地持久化、Main 镜像恢复与关闭事务所有权 | 保持会话状态 Hook；文件保存行为继续留在布局 controller/file-close 边界 | B |
| `packages/app/src/renderer/app-shell/preferences.ts` | 331 | Renderer 本地偏好键、基础 codec、旧工作区布局迁移与镜像应用判定 | 保持兼容偏好入口；后续将旧布局迁移下沉到 workspace persistence adapter | B |
| `packages/prompt/src/builder.ts` | 401 | Prompt 分段、完整执行与紧凑 respond 装配 | 保留 builder facade，复杂 section 移入 `sections` | E |
| `packages/app/src/renderer/settings/plugins.tsx` | 394 | 插件发现、筛选、启停、来源确认和代码授权 | 新能力进入插件宿主或独立设置组件 | B |
| `packages/app/src/renderer/workspace/use-workspace-layout-controller.ts` | 600 | 布局尺寸交互、标签命令、草稿编辑与关闭前保存编排 | 会话布局持久化已下沉到 `use-workspace-session-layouts.ts`；保持交互 controller，冻结期间不得继续吸收新职责 | B |
| `packages/types/src/activation.ts` | 390 | 持久 Atom 与语义缓存共用的连续 activation 契约和纯计算 | 按 evidence、scoring、projection 分组并保持 barrel | E |
| `packages/app/src/renderer/chat/assistant-turn.tsx` | 381 | 思考摘要、执行过程、验证与最终产物的渐进式披露 | 持续拆出纯展示段；禁止吸收状态决策 | B |
| `packages/app/src/renderer/ArchiveManager.tsx` | 369 | 归档加载、树和操作 | controller + project/session 视图 | B |
| `packages/plugins/src/channel/manager.ts` | 366 | 渠道调度、会话和发送 | 分离 dispatch、session、delivery | C |
| `packages/harness/src/stages/evolve.ts` | 357 | 记忆/Skill 提案和多个受约束治理 service 的组合 facade | 保持组合层；新增治理进入独立模块 | E |
| `packages/app/src/main/local-app-api/memory-routes.ts` | 349 | 记忆文件、旧控制面兼容、资源、项目投影及迁移子路由组合 | 保持纯路由组合；新增治理进入独立子路由 | C |
| `packages/memory-tree/src/task-query.ts` | 345 | 当前请求、有限近期历史、版本化摘要、排除和任务转向语义 | 按 reference、negative/contrast、summary continuity 拆分 | D |
| `packages/app/src/main/attachments.ts` | 344 | run 附件解析和所有权分类 | 分离 ownership、metadata、content resolver | C |
| `packages/app/src/renderer/api/run.ts` | 316 | Renderer 普通 run、SSE、稳定 request key 与 continuation failure 映射 | 保持传输 facade；继续将响应 codec 和重连观察下沉 | B |
| `packages/app/src/renderer/workspace/review-diff.tsx` | 375 | Git diff 模型、单双列 Monaco 装配和行评论层组合 | 保持审阅视图组合；diff 映射、评论附件和删除行适配继续独立 | B |
| `packages/app/src/main/desktop-shell.ts` | 345 | Electron 窗口、托盘、关闭策略、窗口状态和退出前刷新 | 保持 DesktopShell 生命周期边界；状态 codec 留在 `desktop-window-state.ts` | C |
| `packages/app/src/renderer/workspace/review-inline-deleted-comments.tsx` | 534 | 单列删除行评论手势、view zone 编辑器和附件发布 | 与通用行评论共享纯 helper；后续下沉删除行 view-zone controller | B |
| `packages/app/src/renderer/workspace/review-inline-deleted-line-numbers.ts` | 326 | 单列删除区域的源行号投影和交互目标同步 | 保持 Monaco view-zone adapter，不吸收评论编辑状态 | B |
| `packages/app/src/renderer/chat/activity-model.ts` | 319 | Agent 活动、公开推理、工具步骤和完成态投影 | 保持纯活动模型；展示组件不得回填状态归并逻辑 | B |
| `packages/app/src/renderer/chat/run-actions.ts` | 323 | 聊天发送、流式事件所有权和输入/附件重试保留 | turn fingerprint 与完成态消息归并已下沉；保持发送 facade | B |
| `packages/app/src/renderer/sidebar/project-section.tsx` | 304 | 项目树、折叠状态、项目菜单和持久化刷新 | 保持项目区视图边界；项目事务继续由 sidebar actions 拥有 | B |
| `packages/app/src/main/workspace-layout-index.ts` | 375 | Main 多会话工作区镜像、旧单快照兼容、边界规范化与项目路径重绑定 | 保持持久化索引边界；继续增长时分离 store codec 与路径重绑定 | C |
| `packages/app/src/renderer/runtime-recovery/use-checkpoint-recovery.ts` | 302 | Checkpoint 恢复面板、续跑请求和资源/权限状态展示 | 保持恢复控制器；将状态选择与展示 helper 分离 | B |
| `packages/runner/src/run-checkpoint-controller.ts` | 306 | Checkpoint inspect、唯一 head、claim 和 durable resume identity 查询 | 保持控制面 facade；后续分离 query/claim policy | E |
| `packages/app/src/renderer/ui/icons.tsx` | 359 | 无状态声明式图标集合 | 浏览器图标家族已拆出；其余继续按家族拆分，冻结期间不得继续增长 | B |
| `packages/memory-tree/src/memory-service.ts` | 342 | Memory Service facade 与运行协调器组合 | 保持 facade；新增能力进入领域协调器 | D |
| `packages/app/src/main/workspace-office-preview.ts` | 339 | 有界 Office/OpenDocument 只读文本预览 | 分离格式解析器与统一预览预算 | C |
| `packages/channels/telegram/src/plugin.ts` | 339 | Telegram 协议和生命周期 | 分离 transport、mapper、sender | C |
| `packages/memory-tree/src/memory-repository/v3-retrieval-materializer.ts` | 331 | 候选优先级、证据封套和治理读取投影 | 保持候选投影单一来源 | D |
| `packages/cli/src/commands/import-repo.ts` | 323 | 导入流程、Git、LLM 和进度 | 分离 source、distill、progress adapter | C |
| `packages/memory-tree/src/index.ts` | 323 | Memory Tree 公共 barrel 与稳定导出 | 保持无逻辑导出层 | D |
| `packages/app/src/main/local-app-api/terminal-routes.ts` | 319 | 用户终端会话、原始 PTY 输入、Agent 命令权限校验和活动捕获路由 | 保持路由只做 HTTP 编排，并显式区分 `workspace-user` 与 `agent` 来源 | C |
| `packages/channels/webhook/src/plugin.ts` | 310 | Webhook server、鉴权和消息 | 分离 server、auth、mapper、sender | C |
| `packages/app/src/renderer/composer/runtime-picker.tsx` | 379 | 输入栏模型、供应商和推理程度选择器及二级菜单定位 | 保持选择器视图编排；继续增长时分离菜单定位与选项渲染 | B |
| `packages/context/src/tokenizers/deepseek-v4-encoding.ts` | 396 | DeepSeek V4 消息、thinking 与 DSML 工具调用的官方请求 framing | 保持纯编码职责；继续增长时分离 DSML 工具序列化 | E |
| `packages/context/src/tokenizers/deepseek-v4-counter.ts` | 335 | DeepSeek V4 官方 tokenizer 资源校验、下载、加载与有界精确计数缓存 | 继续增长时分离通用不可变资源下载器 | E |
| `packages/context/src/context-engine/snapshots.ts` | 310 | Context/模型请求快照、哈希和有界裁剪 | 分离 builders 与 hash/shape codec | E |
| `packages/experience/src/experience-store.ts` | 309 | 经验索引、备份、并发和衰减 | 分离 index、backup、mutation、decay | D |
| `packages/memory-tree/src/memory-repository/v3-retrieval.ts` | 307 | 分支/作用域约束检索与精确治理读取路由 | 保持检索编排 | D |
| `packages/harness/src/stages/evolve/revision.ts` | 306 | Atom 内容修订提案解析、准入、提交和审计 | 后续增长时分离 parse/validate 与 commit adapter | E |
| `packages/harness/src/response-continuity-text.ts` | 475 | 回答连续性所需的有界文本、Atom 标记、显式标签值、Runtime 摘要保真字段和否定语义解析 | 保持纯文本解析边界；若继续增长，分离标签值解析与通用连续性术语处理 | E |

| `packages/harness/src/stages/decide/normalization.ts` | 303 | DECIDE 解码结果的澄清、计划、评估与 TaskBook 规范化 | 保持纯规范化边界；继续增长时按 clarification、plan 与 assessment builder 拆分 | E |
| `packages/harness/src/stages/execute/task-book-runner.ts` | 325 | TaskBook 依赖波次、步骤结果归并、安全暂停边界与最终回复装配 | 保持 TaskBook 编排入口；继续增长时下沉运行时控制收尾和完成回复装配 | E |
| `packages/app/src/main/local-app-api/runtime-routes.ts` | 367 | Runtime 配置、Web policy projection、provider 状态和 Web cache 路由 | 保持 Main 路由 facade；继续将 Web policy projection 与 cache control 下沉到独立 adapter | C |
| `packages/app/src/main/local-app-api/session-routes.ts` | 313 | 会话查询、权限模式更新和历史 projection 路由 | 保持 session API facade；继续将 session mutation 与 response projection 分离 | C |
| `packages/app/src/renderer/workspace/line-comment-surface.tsx` | 319 | Monaco 行评论交互、附件和 Web/文件来源关联的共享 surface | 保持交互 adapter；继续将 attachment lifecycle 与 view-zone rendering 下沉 | B |
| `packages/config/src/schema.ts` | 366 | 全局配置 schema、Web policy 和 provider 配置校验 | 保持版本化 schema facade；继续将 Web policy schema 与迁移解析分组 | E |
| `packages/harness/src/context.ts` | 306 | RunContext 构造、Web evidence sink 和工具上下文装配 | 保持 Context 入口；继续将 Web evidence 与基础 Context builder 分离 | E |
| `packages/harness/src/stages/memory-intent-gate.ts` | 307 | Memory write intent 准入、Web evidence 写入边界和 evidence refs | 保持 Memory write gate；继续将 Web-specific admission 规则下沉到独立 policy | E |
| `packages/types/src/web-retrieval.ts` | 398 | Web policy、provider、fetch、citation 和 evidence projection 公共契约 | 保持公共 barrel；按 policy/provider/evidence 分组并维持向后兼容 | E |
| `packages/web/src/runtime.ts` | 570 | 每轮 Web retrieval quota、取消、citation、cache 和 evidence projection | 保持 per-run runtime facade；继续将 quota/citation/evidence adapter 分离 | E |

## 已完成拆分

| 原始文件 | 原基线 | 当前入口 | 已形成边界 | 完成日期 |
| --- | ---: | --- | --- | --- |
| `packages/app/src/renderer/api.ts` | 1088 | 22 行兼容 barrel | `run`、`sessions`、`runtime`、`attachments`、`workspace-files`、`terminal`、`extensions`、`browser`、`development-environments`、`memory` 与 `common` | 2026-07-14 |
| `packages/app/src/main/local-app-api-server.ts` | 288 | 288 行 server 组合入口 | HTTP 基元、run、projects、sessions/archive、runtime、memory、workspace、browser、development-environments、terminal、extensions、公共 contracts；实例级资源清理由 `local-app-api-server-shutdown.ts` 承担 | 2026-08-05 |
| `packages/app/src/renderer/App.tsx` | 9935 | 7 行兼容入口 | `app-shell`、`approval`、`chat`、`composer`、`runtime`、`settings`、`sidebar`、`ui` 与 `workspace` 领域视图和 controller | 2026-07-14 |
| `packages/memory-tree/src/memory-repository.ts` | 1279 | 172 行 repository facade | 版本化后端选择、证据定位、稳定 Repository 公共契约和后台维护/关闭兼容入口；management 使用独立 facade，v2/v3 实现均已下沉 | 2026-08-05 |
| `packages/memory-tree/src/memory-service.ts` | 1120 | 342 行 service facade | run、摘要、daily consolidation、附件、事件、Bootstrap、Skills、工作区资源、项目投影和资源管理协调器；Atom reconciliation 保持为 Runner 独立组合端口 | 2026-07-15 |
| `packages/context/src/engine.ts` | 690 | 180 行 engine facade | candidates、budget、eviction、assembly、counting 与 snapshots | 2026-07-15 |
| `packages/harness/src/stages/decide.ts` | 620 | 16 行 stage facade | 请求组装、模型调用和结果采用已分别下沉到 `decide/request.ts`、`decide/model-call.ts`、`decide/adoption.ts`；契约、规范化、运行时事件和局部重规划保持独立模块 | 2026-07-18 |
| `packages/harness/src/stages/execute.ts` | 867 | 45 行 stage facade | guidance、tool-loop、权限/超时、failure-policy、TaskBook runners 与 final-reply | 2026-07-15 |
| `packages/harness/src/stages/execute/runners.ts` | 330 | 97 行 legacy facade 与 TaskBook re-export | TaskBook 编排、步骤调度和分支执行已下沉到 `task-book-runner.ts`、`task-step-runner.ts` 与 `task-step-scheduler.ts` | 2026-07-29 |
| `packages/harness/src/stages/verify.ts` | 473 | 123 行 stage facade | 模型请求、裁决契约、结构证据、步骤状态、验证记录和恢复路由已分离 | 2026-07-31 |
| `packages/harness/src/stages/verify/routing.ts` | 301 | VERIFY 结构证据记录、已验证回复发布和恢复/重规划路由 | 保持纯路由与证据边界；失败状态通过 `failure-state.ts` 写入，模型请求和 TaskBook 状态继续由各自模块拥有 | 2026-08-10 |
| `packages/harness/src/stages/recover.ts` | >300 | 168 行 stage facade | 恢复契约、模型请求和确定性策略已下沉到 `stages/recover/`，入口只保留状态编排 | 2026-07-31 |
| `packages/harness/src/stages/evolve.ts` | 555 | 357 行 stage facade | 记忆/Skill 提案、写入认识解析和模型调用留在入口；Atom reconciliation、leaf reparent、same-claim revision 与 evidence-backed correction 的解析、KnownState 准入、提交和审计分别下沉到 `stages/evolve/reconciliation.ts`、`stages/evolve/hierarchy.ts`、`stages/evolve/revision.ts`、`stages/evolve/correction*.ts` | 2026-07-17 |
| `packages/app/src/renderer/MemoryTreeView.tsx` | 1007 | 205 行用户记忆文件视图 | GUI 只展示六份记忆文件并仅允许编辑 `SOUL.md`；Atom、关系、向量、迁移和审计退回 Runtime 与内部治理 API | 2026-07-16 |

2026-08-03 的连续性阶段没有把新职责重新塞回组合入口：`packages/harness/src/default-harness.ts` 保持为 299 行状态机 facade，Checkpoint 证据归一与恢复入口下沉到 34 行的 `checkpoint-resume.ts`，回答连续性保持在 `response-continuity*.ts` 领域模块；Runtime 摘要精确字段的文本封套和重建逻辑分别位于 51 行的 `packages/harness/src/session-summary-fidelity-text.ts` 与 82 行的 `packages/runner/src/session-summary-fidelity.ts`。`packages/app/src/main/index.ts` 为 579 行组合入口，Electron 验收资源采样下沉到 81 行的 `desktop-acceptance-snapshot.ts`，活动任务聚合与监听器统计留在 145 行的 `run-activity-monitor.ts`。这些文件目前均未越过各自登记上限，后续新增验收维度应继续进入独立采样器或领域服务。

阶段 5M 的生命周期责任保持在现有模块：`packages/runner/src/run-checkpoint.ts` 负责 checkpoint snapshot ID 的最近 64 条引用窗口，`packages/runner/src/execution-log.ts` 负责 execution log 持久化边界的最近 64 条 request/context snapshot 窗口；两者共享 `@littlesheep/context` 的上限常量，不新增 facade 或 ownership group。资源索引从截断后的 snapshot 集合生成，保证日志内容与索引来源一致。

阶段 5N 继续由 `packages/runner/src/run-checkpoint-store.ts` 负责持久化闸门：`write()` 使用 64 条新窗口，`read()`/`list()` 使用 128 条历史兼容窗口。读写边界在同一 codec 校验函数中显式传入，避免把兼容读取上限误当作新数据生产上限；不新增模块或 ownership group。

阶段 5O 的窗口防护留在 `packages/harness/src/model-observability-state.ts`，由共享 `@littlesheep/context` 常量约束公开 `appendModelObservations()` 参数；模型观测语义仍由 `model-observability.ts` 拥有，Runner/Context 不新增中间 facade。

阶段 5P 的关联保留留在 `packages/runner/src/execution-log.ts` 的持久化边界：该模块先截取 request tail，再按 request 的 `contextSnapshotId` 保留必要 snapshot，最后用最新未引用 snapshot 填充 64 条容量。checkpoint 仍只负责 snapshot ID 窗口，Harness 仍负责运行时观测窗口；不新增跨域 facade、ownership group 或 checkpoint schema 字段。

阶段 5 暂停审计的结论是保持当前模块边界：`verificationHistory` 继续由 VERIFY 记录语义、Runner 负责恢复装配、checkpoint/store 与 execution log 各自负责持久化边界；静态扫描未发现已登记字段的生产绕过，当前也没有证据表明需要再抽象一个跨域 facade。只有出现可复现的历史丢失、恢复行为错误或可测量的开发反馈成本，才重新评估是否需要新的阶段。

## 拆分顺序

1. 阶段 2 先冻结共享契约、兼容 facade 和特征测试。
2. C 与 D 优先拆 Main/API 和 Memory，减少 B/E 的跨层依赖。
3. B 已在 API barrel 稳定后完成 Renderer 组合壳拆分；后续 Renderer 细分继续按真实窗口验收。
4. D/E 所有权下的 Memory、Harness/Context 已完成 facade 化与内部领域拆分，LLM Call Contract 和记忆意图闸门已在稳定边界上接入；`packages/harness/src/memory-state.ts` 负责 Memory 顶层 RunContext 批次校验与写入，`packages/harness/src/usage-state.ts` 负责顶层 provider usage 快照，`packages/harness/src/decision-state.ts` 负责活动路由、需求评估和澄清状态，`packages/harness/src/failure-state.ts` 负责 `lastError` 与 `recoveryAttempts`，`packages/harness/src/execution-evidence-state.ts` 负责顶层工具结果、调用记录和副作用账本写入，Repository/Service 持久化事务、请求级 context snapshot 观测和 TaskBook 内部执行证据仍留在各自领域。
5. Memory v3 阶段 4 已完成独立 snapshot、mapping、build、validation、commit 和 filesystem 模块；阶段 5 已把检索、证据封套与 KnownState 拆入独立模块；阶段 6 已拆出 conversation source store、projection mutation record/commit store（内部兼容名仍为 `raw-record*`）、feedback manager、management facade、working set、atom API router、迁移协调器和可复用 live validation state；阶段 22 的 Atom reconciliation、阶段 23 的 leaf hierarchy reparent、阶段 24 的 same-claim revision 与阶段 25 的 evidence-backed correction 均分为公共契约、纯校验、Runtime 编排和 Harness 提案适配边界。旧 Renderer Atom 管理原型已退役，普通 GUI 收敛为记忆文件视图；内部治理 API 继续服务诊断、迁移与审计。后续拆分只在能改善不失忆、任务执行效率或真实维护成本时进行，避免无需求的结构搬迁。

## 当前共享契约与 facade

这些契约先于实现搬迁冻结，旧模块继续 re-export 或组合它们，避免一次性修改所有调用方：

| 契约/Facade | 唯一来源 | 当前兼容入口 | 下一步移动边界 |
| --- | --- | --- | --- |
| 会话、项目、归档 | `packages/app/src/shared/session-project-contracts.ts` | `main/session-index.ts`、`main/project-index.ts`、`main/archive-index.ts`、`renderer/api.ts` | sessions/projects/archive API client 与 main routers |
| 工作区产物、布局、终端活动 | `packages/app/src/shared/workspace-contracts.ts` | 三个 main index 与 `renderer/api.ts` | workspace/terminal domain clients and routers |
| Runtime、Provider、数据根 | `packages/app/src/shared/runtime-api-contracts.ts` | `local-app-api-server.ts`、`renderer/api.ts`、`data-root-migration.ts` | runtime/data-root services |
| 记忆与文件视图 | `packages/app/src/shared/memory-control-contracts.ts` | `memory-tree-control.ts`、`renderer/api.ts` | 内部治理路由保持独立；普通 Renderer 只消费记忆文件契约 |
| 附件元数据 | `packages/app/src/shared/attachment-contracts.ts` | `attachments.ts`、`renderer/api.ts` | attachment API/import service |
| Local App API 路由 | `packages/app/src/shared/local-app-api-routes.ts` | `local-app-api-server.ts`、`renderer/api.ts` | 分域 router modules; static and dynamic path encoding remains centralized |
| Agent 状态机、模型请求、运行时事件与检查点 | `packages/types/` | `runner`、`harness` public barrels | Tool Execution Service 已归 `packages/tools/`；事件生产与恢复控制面留在 App adapter，Runtime 契约继续由 types/runner 维护 |

当前 facade 输入输出：`startLocalAppApiServer(initialRunner, options) → LocalAppApiServer`、`createRunner(options) → AgentRunner`、`MemoryService`、`ContextEngine`、`ToolExecutionService`、各 Harness stage function 和 renderer `api.ts` 导出函数。Call Contract 与统一工具执行已通过稳定入口接入；后续实时事件职责同样不得重新塞回 facade。

## 受控超限清单

以下不是永久例外，而是有界拆分队列。301-600 行文件继续由上方软上限队列管理；超过 600 行文件只能接受修复、特征测试或完成拆分所需的兼容修改，且不得超过登记上限。到期时必须复查、下调上限或完成拆分。

| 文件 | 所有者 | 暂缓原因 | 行数上限 | 复查日期 |
| --- | --- | --- | ---: | --- |
| `packages/app/src/renderer/app-shell/use-app-controller.ts` | B / Renderer | 启动恢复、Runtime 设置与会话投影仍共享跨领域不变量；先冻结兼容 facade 和状态快照特征测试，再下沉持久化与恢复编排 | 700 | 2026-09-24 |
| `packages/channels/qqbot/src/plugin.ts` | C / Channel Plugins | 等待渠道 transport 与协议适配端口稳定后拆分；本轮只补充连续性 request identity 透传 | 820 | 2026-09-24 |
| `packages/memory-tree/src/project-memory-projection.ts` | D / Memory | 投影事务、冲突与恢复必须在特征测试覆盖后迁移 | 780 | 2026-09-24 |
| `packages/runner/src/runner.ts` | E / Runtime | run 生命周期、输入装配、检查点续跑、后台维护准入透传和资源收尾仍共享跨阶段不变量；本轮 durable settlement/replay 接入后上限调整，先冻结恢复与幂等特征测试，连续性恢复入口完成后再拆分 | 2180 | 2026-09-24 |
| `packages/types/src/runtime-contracts.ts` | E / Runtime | Context、事件、检查点和执行证据仍共享版本边界；拆分时必须保持现有 barrel 与持久化兼容 | 900 | 2026-09-24 |
| `packages/runner/src/runtime-event-queue.ts` | E / Runtime | 安全边界接入已经完成；租约、结算、快照恢复与 ActiveRunRegistry 契约刚稳定，补齐拆分特征测试后再下沉 codec/registry | 760 | 2026-09-24 |
| `packages/runner/src/run-checkpoint-store.ts` | E / Runtime | 检查点 codec、原子存储、查询、容量、保留期和稳定 conversation-turn identity 共享恢复不变量；完成查询拆分前保持 facade 稳定 | 900 | 2026-09-24 |
| `packages/memory-tree/src/memory-tree.ts` | D / Memory | 根索引、导航和预算状态共享不变量，先冻结 facade | 660 | 2026-09-24 |
| `packages/channels/feishu/src/plugin.ts` | C / Channel Plugins | 等待渠道 transport 与事件验签端口稳定后拆分；本轮只补充连续性 request identity 透传 | 640 | 2026-09-24 |
| `packages/runner/src/run-checkpoint-disposition-store.ts` | E / Runtime | disposition claim、跨进程锁、有界历史和续跑 identity 查询共享原子写入不变量；先冻结 P0 连续性矩阵再拆 codec/query/retention | 740 | 2026-09-24 |
| `packages/app/src/main/data-root-migration.ts` | C / App Main | 数据迁移事务需保持恢复与回滚原子性，先补齐阶段检查点 | 637 | 2026-09-24 |
| `packages/memory-tree/src/v3/catalog.ts` | D / Memory | activation schema 与检索投影刚稳定，先保持 Catalog facade 和恢复契约；本轮新增激活与关系投影后复查 | 640 | 2026-09-24 |
| `packages/safety/src/permission-boundary.ts` | C / Safety | 网络 safe-read descriptor、路径边界、SSRF 前置语法和 hard-deny 统一判定刚接入；先冻结三档权限矩阵和网络 contract，再拆 network descriptor adapter | 660 | 2026-09-24 |
| `packages/tools/src/tool-execution-service.ts` | E / Tools | Web 工具接线需要保持统一校验、审批、事件、取消和持久化投影不变量；先完成 WB-09 发布矩阵，再拆 invocation lifecycle 与 Web result projection | 660 | 2026-09-24 |
| `packages/app/src/main/index.ts` | C / App Main | Electron 启动装配仍需以严格顺序协调数据根、窗口状态恢复、Local App API、Runner 和插件宿主；新增启动可见性与窗口状态调用使入口越过原 600 行软上限，后续将 bootstrap orchestration 下沉到独立服务 | 620 | 2026-09-24 |
| `packages/harness/src/stages/execute/tool-loop.ts` | E / Harness | 工具循环的审批、调用、失败与消息续接不变量刚完成 durable 观测接入；先冻结特征测试与 effect 生命周期，再拆 loop policy、invocation adapter 和 transcript | 620 | 2026-09-24 |
