# LittleSheep 模块拆分地图

最后更新：2026-08-10 15:57:32

本文件记录大型生产文件的当前所有权、目标边界和拆分顺序。它是仓库基元化任务书的阶段产物，不替代项目状态，也不把行数当成唯一质量指标。

## 规则

- 生产文件目标不超过 300 行。
- 301-600 行是软上限：先确认单一职责，不能继续吸收新领域；确需保留时登记例外。
- 超过 600 行默认进入强制拆分队列；先冻结 facade 和特征测试，再移动实现。
- 拆分必须保持公共 API、持久化格式、URL、动画、导航、恢复和用户数据语义。
- 阶段 0-2 串行；共享契约冻结后按 A 文档、B Renderer、C Main/Adapter、D Memory、E Harness/Context 分配所有权。

## 强制拆分队列

下表行数是 2026-08-03 当前工作树的物理行数，不是历史完成值。生产 `.ts/.tsx` 文件超过 600 行必须进入本表；已登记不等于要求立即做无收益拆分。当前仓库卫生扫描共有 80 个生产文件超过 300 行，其中 10 个超过 600 行并进入受控清单。

| 当前文件 | 当前行数 | 当前责任 | 目标边界 | 所有权 |
| --- | ---: | --- | --- | --- |
| `packages/runner/src/runner.ts` | 818 | run 生命周期、输入装配、Memory 反馈、日志、检查点持久化/续跑、活动任务注册、后台维护准入透传和资源收尾 | 保持应用服务 facade；活动快照与中断/超时所有权已下沉，继续下沉日志、检查点和收尾协调；checkpoint 预算重concile 保持在 `run-checkpoint.ts` 边界 | E |
| `packages/channels/qqbot/src/plugin.ts` | 801 | QQ 协议、连接、消息、发送和生命周期 | transport、protocol、message-mapper、sender、lifecycle | C |
| `packages/memory-tree/src/project-memory-projection.ts` | 780 | 投影生成、同步、冲突、恢复和删除 | projection facade + render、sync、conflict、lifecycle | D |
| `packages/types/src/runtime-contracts.ts` | 760 | Context、事件、检查点、活动任务控制、执行证据和版本化运行时契约 | Token 账本已迁入 `token-ledger.ts`；继续按 context、event、checkpoint、active-run、execution 分组并保持 barrel | E |
| `packages/runner/src/runtime-event-queue.ts` | 729 | run/session 隔离、有界事件、幂等、租约、结算和快照恢复 | `RunContext` 顶层 runtime state 已由 Harness `runtime-state.ts` 统一批次写入；本文件继续独占 queue codec、lease/settle、registry 和快照恢复内部状态，保持 facade 稳定 | E |
| `packages/runner/src/run-checkpoint-store.ts` | 678 | 检查点 codec、原子存储、校验、列表、容量和保留期 | 分离 schema/codec、store、query 与 retention policy | E |
| `packages/memory-tree/src/memory-tree.ts` | 655 | 根索引、导航、展开和搜索；working set 预算/去重/释放已拆出 | tree facade + index、navigation、expansion、branch-search | D |
| `packages/channels/feishu/src/plugin.ts` | 632 | 飞书验签、事件、消息、发送和生命周期 | verification、transport、message-mapper、sender、lifecycle | C |
| `packages/app/src/main/data-root-migration.ts` | 628 | locator、清单、复制、重绑定、提交、恢复和回滚 | migration facade + plan、manifest、copy、rebind、commit、recovery | C |
| `packages/memory-tree/src/v3/catalog.ts` | 626 | Memory v3 Catalog facade、Atom/FTS/账本/due/激活投影 | ledger/due 管理与 management projection 继续下沉 | D |

## 软上限审查队列

| 当前文件 | 当前行数 | 主要责任 | 处理方向 | 所有权 |
| --- | ---: | --- | --- | --- |
| `packages/memory-tree/src/types.ts` | 580 | 记忆树内部和持久化类型 | 按 node、resource、audit、projection 分组 | D |
| `packages/harness/src/tests/helpers.ts` | 308 | Harness 测试夹具与 RunContext 构造 | 按夹具领域拆分；测试 helper 不进入生产 Harness 依赖 | E |
| `packages/types/src/agent.ts` | 470 | 状态机、活动路由兼容、RunContext、stage 与 Hook 契约 | TaskBook 已迁入 `task.ts`；继续保持状态机与运行上下文边界，不再吸收领域协议 | E |
| `packages/types/src/run-context-contract.ts` | 428 | 八组高频 RunContext 字段的 owner、读写阶段、生命周期和写入查询 | 保持 machine-readable manifest；继续由 `replan-state.ts`、`reply-state.ts`、`runtime-state.ts`、`memory-state.ts`、`usage-state.ts`、`decision-state.ts`、`failure-state.ts`、`execution-evidence-state.ts`、`model-observability-state.ts` 等领域边界消费，不把具体状态写入逻辑吸回 types | E |
| `packages/tools/src/tool-execution-service.ts` | 583 | 工具查找、校验、审批、执行生命周期、事件与结构化记录 facade | 调度、中断、记录摘要和结果处理已拆分；facade 不吸收 Harness 编排或副作用状态所有权 | E |
| `packages/memory-tree/src/memory-repository/v3-node-store.ts` | 581 | v3 节点查询、写入编排、层级和实体关联 | 事件与生命周期规则已拆出；后续分离 query projection 与 write coordinator | D |
| `packages/app/src/renderer/app-shell/use-app-controller.ts` | 580 | Renderer 跨领域兼容协调、启动恢复和视图快照 | 保持装配职责；Runtime/附件 effect 契约稳定后再下沉 | B |
| `packages/memory-tree/src/memory-repository/v3-resource-store.ts` | 575 | v3 资源元数据、生命周期事务、实体投影和恢复 | 分离 resource registry、transaction recovery 与 graph projection | D |
| `packages/app/src/main/index.ts` | 579 | Electron 启动和组合；窗口、托盘、关闭策略、活动任务聚合、Memory v3、桌面验收采样与内置浏览器宿主已下沉；后台维护准入由 `background-maintenance-policy.ts` 提供 | 继续抽取 bootstrap 服务，入口只保留装配顺序 | C |
| `packages/app/src/renderer/workspace/terminal.tsx` | 557 | PTY 生命周期、SSE、尺寸、命令历史和权限预检/批准重试 | 保持终端事务边界，禁止吸收工作区导航职责；权限语义继续下沉到 Main/Safety | B |
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
| `packages/app/src/renderer/workspace/preview-pane.tsx` | 484 | 文件分派、编辑草稿、保存审批、预览错误和首帧状态 | 建立文件打开事务测试后再拆编辑与预览；Monaco 语言配置保持独立；取消链路稳定后优先下沉 view/controller | B |
| `packages/app/src/main/local-app-api/workspace-git-review-cache.ts` | 272 | Main Git 审阅快照缓存、revision、并发、取消、TTL 和容量预算 | 保持缓存策略与 Git 解析、路由分离 | C |
| `packages/memory-tree/src/v3/storage-coordinator.ts` | 308 | v3 raw/event/operation/atom/catalog 事务协调与恢复 | 保持事务边界；后续拆 recovery replay 与 commit projection | D |
| `packages/app/src/renderer/api/workspace-files.ts` | 337 | Renderer 工作区文件 API、目录有界缓存与失效 | 若继续增长，拆分缓存与请求 helper | B |
| `packages/app/src/renderer/workspace/review.tsx` | 316 | 审阅可见生命周期、single-flight 刷新、共享导航装配和树/差异选择 | 保持 policy、model 与 view helper 分离；单双列偏好留在 Renderer UI 层 | B |
| `packages/app/src/main/memory-tree-control.ts` | 474 | 记忆控制面查询、v3 D0-D3 详情适配和既有管理命令 | 分离 query/detail、resource、projection command | C |
| `packages/llm/src/client.ts` | 463 | 请求、流式、reasoning、重试适配 | 分离 request builder、stream parser、response mapper | E |
| `packages/harness/src/stages/execute/tool-loop.ts` | 529 | 单步模型工具循环、审批、失败记录、时间感知、消息续接和紧凑后续请求 | 分离 loop policy、invocation adapter 与 transcript；不得继续吸收检查点恢复或回答连续性判定 | E |
| `packages/memory-tree/src/memory-repository/resource-store.ts` | 454 | 资源注册、生命周期、重绑定和审计 | 分离 registry、lifecycle、rebind、audit | D |
| `packages/memory-tree/src/v3/event-journal.ts` | 451 | Memory v3 event 与 operation journal 的同构恢复语义 | 契约稳定后拆为两个 store，共享 bounded journal codec | D |
| `packages/memory-tree/src/workspace-resource-index.ts` | 448 | 工作区资源索引、游标和更新 | 分离 store、scanner state、change-set | D |
| `packages/app/src/renderer/workspace/file-navigator.tsx` | 436 | 目录缓存、筛选、展开路径、文件树和可见性取消 | 与 `navigator-frame.tsx` 共享壳；建立树状态特征测试后再拆 controller/view；目录请求取消与缓存恢复保持在独立 loader 边界 | B |
| `packages/harness/src/taskbook-patch.ts` | 525 | TaskBook 局部修订契约、校验和合并 | 保持纯任务书补丁边界；若继续增长，分离 schema、merge 和 validation | E |
| `packages/memory-tree/src/memory-repository/v3-atom-management.ts` | 443 | Atom move/merge/revise/invalidate/reactivate 原子 mutation 与审计 | 保持持久化 mutation 边界；语义准入留在独立 service | D |
| `packages/runner/src/execution-log.ts` | 469 | 执行日志 schema、写入、查询与按会话原子摘要 sidecar | 分离 codec、store、query 与 latest-summary store | E |
| `packages/session/src/manager.ts` | 438 | 会话 JSONL、metadata、回复指纹、压缩投影与摘要 activation facade | 保持 facade；继续增长时拆 compaction/activation adapter | E |
| `packages/memory-tree/src/v3/atom-store.ts` | 437 | atom 原子读写、轻量索引、扫描、层级和隔离 | 保持 store facade；规模验收稳定后分离 scanner/quarantine | D |
| `packages/runner/src/infra.ts` | 450 | 默认基础设施创建与 Memory v3 后台维护准入回调注入 | 按 memory、tools、session、skills adapter 分组 | E |
| `packages/app/src/renderer/workspace/panel.tsx` | 414 | 拓展工作区页面、缓存和工作面装配 | 保持纯组合；标签条和浏览器状态已分别下沉 | B |
| `packages/app/src/main/development-environments.ts` | 421 | LS 工具链管理 facade、版本偏好、导入/移除事务和终端环境派生 | 保持 facade；下载器不得回填此文件 | C |
| `packages/app/src/renderer/workspace/browser.tsx` | 411 | 内置浏览器标签、导航、加载状态和网页内跳转 | 保持视图组合；历史算法和导航资格留在独立模块 | B |
| `packages/app/src/renderer/workspace-persistence.ts` | 404 | 工作区恢复快照与规范化 | 分离 schema、normalize、serialize | B |
| `packages/prompt/src/builder.ts` | 401 | Prompt 分段、完整执行与紧凑 respond 装配 | 保留 builder facade，复杂 section 移入 `sections` | E |
| `packages/app/src/renderer/settings/plugins.tsx` | 394 | 插件发现、筛选、启停、来源确认和代码授权 | 新能力进入插件宿主或独立设置组件 | B |
| `packages/app/src/renderer/workspace/use-workspace-layout-controller.ts` | 422 | 布局恢复、标签/草稿持久化和拖动入口 | 两级阈值算法保持在独立 interaction 模块 | B |
| `packages/types/src/activation.ts` | 390 | 持久 Atom 与语义缓存共用的连续 activation 契约和纯计算 | 按 evidence、scoring、projection 分组并保持 barrel | E |
| `packages/app/src/renderer/chat/assistant-turn.tsx` | 381 | 思考摘要、执行过程、验证与最终产物的渐进式披露 | 持续拆出纯展示段；禁止吸收状态决策 | B |
| `packages/app/src/renderer/ArchiveManager.tsx` | 369 | 归档加载、树和操作 | controller + project/session 视图 | B |
| `packages/plugins/src/channel/manager.ts` | 366 | 渠道调度、会话和发送 | 分离 dispatch、session、delivery | C |
| `packages/harness/src/stages/evolve.ts` | 357 | 记忆/Skill 提案和多个受约束治理 service 的组合 facade | 保持组合层；新增治理进入独立模块 | E |
| `packages/app/src/main/local-app-api/memory-routes.ts` | 349 | 记忆文件、旧控制面兼容、资源、项目投影及迁移子路由组合 | 保持纯路由组合；新增治理进入独立子路由 | C |
| `packages/memory-tree/src/task-query.ts` | 345 | 当前请求、有限近期历史、版本化摘要、排除和任务转向语义 | 按 reference、negative/contrast、summary continuity 拆分 | D |
| `packages/app/src/main/attachments.ts` | 344 | run 附件解析和所有权分类 | 分离 ownership、metadata、content resolver | C |
| `packages/runner/src/run-checkpoint-disposition-store.ts` | 375 | 检查点 resuming/resumed/abandoned 决策的原子持久化 | 保持有界审计 store；后续分离 codec 与 retention | E |
| `packages/app/src/renderer/ui/icons.tsx` | 351 | 无状态声明式图标集合 | 浏览器图标家族已拆出；其余继续按家族拆分 | B |
| `packages/memory-tree/src/memory-service.ts` | 342 | Memory Service facade 与运行协调器组合 | 保持 facade；新增能力进入领域协调器 | D |
| `packages/app/src/main/workspace-office-preview.ts` | 339 | 有界 Office/OpenDocument 只读文本预览 | 分离格式解析器与统一预览预算 | C |
| `packages/channels/telegram/src/plugin.ts` | 339 | Telegram 协议和生命周期 | 分离 transport、mapper、sender | C |
| `packages/memory-tree/src/memory-repository/v3-retrieval-materializer.ts` | 331 | 候选优先级、证据封套和治理读取投影 | 保持候选投影单一来源 | D |
| `packages/cli/src/commands/import-repo.ts` | 323 | 导入流程、Git、LLM 和进度 | 分离 source、distill、progress adapter | C |
| `packages/memory-tree/src/index.ts` | 323 | Memory Tree 公共 barrel 与稳定导出 | 保持无逻辑导出层 | D |
| `packages/app/src/main/local-app-api/terminal-routes.ts` | 319 | 终端会话、原始 PTY 输入、权限校验和活动捕获路由 | 保持路由只做 HTTP 编排 | C |
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

## 已完成拆分

| 原始文件 | 原基线 | 当前入口 | 已形成边界 | 完成日期 |
| --- | ---: | --- | --- | --- |
| `packages/app/src/renderer/api.ts` | 1088 | 22 行兼容 barrel | `run`、`sessions`、`runtime`、`attachments`、`workspace-files`、`terminal`、`extensions`、`browser`、`development-environments`、`memory` 与 `common` | 2026-07-14 |
| `packages/app/src/main/local-app-api-server.ts` | 2819 | 257 行 server 组合入口 | HTTP 基元、run、projects、sessions/archive、runtime、memory、workspace、browser、development-environments、terminal、extensions、公共 contracts；实例级资源清理由 `local-app-api-server-shutdown.ts` 承担 | 2026-08-05 |
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
| `packages/channels/qqbot/src/plugin.ts` | C / Channel Plugins | 等待渠道 transport 与协议适配端口稳定后拆分 | 801 | 2026-08-15 |
| `packages/memory-tree/src/project-memory-projection.ts` | D / Memory | 投影事务、冲突与恢复必须在特征测试覆盖后迁移 | 780 | 2026-08-15 |
| `packages/runner/src/runner.ts` | E / Runtime | run 生命周期、输入装配、检查点续跑、后台维护准入透传和资源收尾仍共享跨阶段不变量；先冻结恢复与幂等特征测试 | 830 | 2026-08-20 |
| `packages/types/src/runtime-contracts.ts` | E / Runtime | Context、事件、检查点和执行证据仍共享版本边界；拆分时必须保持现有 barrel 与持久化兼容 | 820 | 2026-08-15 |
| `packages/runner/src/runtime-event-queue.ts` | E / Runtime | 安全边界接入已经完成；租约、结算、快照恢复与 ActiveRunRegistry 契约刚稳定，补齐拆分特征测试后再下沉 codec/registry | 760 | 2026-08-15 |
| `packages/runner/src/run-checkpoint-store.ts` | E / Runtime | 检查点 codec、原子存储、查询、容量与保留期共享恢复不变量；应用恢复控制面完成前保持 facade 稳定 | 720 | 2026-08-15 |
| `packages/memory-tree/src/memory-tree.ts` | D / Memory | 根索引、导航和预算状态共享不变量，先冻结 facade | 660 | 2026-08-15 |
| `packages/channels/feishu/src/plugin.ts` | C / Channel Plugins | 等待渠道 transport 与事件验签端口稳定后拆分 | 632 | 2026-08-15 |
| `packages/app/src/main/data-root-migration.ts` | C / App Main | 数据迁移事务需保持恢复与回滚原子性，先补齐阶段检查点 | 637 | 2026-08-15 |
| `packages/memory-tree/src/v3/catalog.ts` | D / Memory | activation schema 与检索投影刚稳定，先保持 Catalog facade 和恢复契约；本轮新增激活与关系投影后复查 | 640 | 2026-08-15 |
