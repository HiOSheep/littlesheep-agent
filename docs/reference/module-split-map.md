# LittleSheep 模块拆分地图

最后更新：2026-07-15 15:07:00

本文件记录大型生产文件的当前所有权、目标边界和拆分顺序。它是仓库基元化任务书的阶段产物，不替代项目状态，也不把行数当成唯一质量指标。

## 规则

- 生产文件目标不超过 300 行。
- 301-600 行是软上限：先确认单一职责，不能继续吸收新领域；确需保留时登记例外。
- 超过 600 行默认进入强制拆分队列；先冻结 facade 和特征测试，再移动实现。
- 拆分必须保持公共 API、持久化格式、URL、动画、导航、恢复和用户数据语义。
- 阶段 0-2 串行；共享契约冻结后按 A 文档、B Renderer、C Main/Adapter、D Memory、E Harness/Context 分配所有权。

## 强制拆分队列

| 当前文件 | 基线行数 | 当前责任 | 目标边界 | 所有权 |
| --- | ---: | --- | --- | --- |
| `packages/app/src/renderer/MemoryTreeView.tsx` | 1104 | 记忆树加载、管理、资源和项目投影视图 | controller + tree、resource、audit、project-projection 组件 | B |
| `packages/channels/qqbot/src/plugin.ts` | 801 | QQ 协议、连接、消息、发送和生命周期 | transport、protocol、message-mapper、sender、lifecycle | C |
| `packages/memory-tree/src/project-memory-projection.ts` | 778 | 投影生成、同步、冲突、恢复和删除 | projection facade + render、sync、conflict、lifecycle | D |
| `packages/memory-tree/src/memory-tree.ts` | 650 | 根索引、导航、展开、搜索和预算 | tree facade + index、navigation、expansion、branch-search、budget | D |
| `packages/app/src/main/data-root-migration.ts` | 637 | locator、清单、复制、重绑定、提交、恢复和回滚 | migration facade + plan、manifest、copy、rebind、commit、recovery | C |
| `packages/channels/feishu/src/plugin.ts` | 632 | 飞书验签、事件、消息、发送和生命周期 | verification、transport、message-mapper、sender、lifecycle | C |

## 软上限审查队列

| 当前文件 | 基线行数 | 主要责任 | 处理方向 | 所有权 |
| --- | ---: | --- | --- | --- |
| `packages/plugins/src/host.ts` | 536 | 插件发现、加载、启停、贡献迁移 | 分离 discovery、activation、contribution、reconcile | C |
| `packages/memory-tree/src/legacy-memory-branches.ts` | 509 | 旧记忆分支兼容 | 保持隔离，迁移结束后缩减或退役 | D |
| `packages/app/src/main/index.ts` | 503 | Electron 启动和组合 | 抽取 bootstrap 服务，入口只保留装配顺序 | C |
| `packages/types/src/agent.ts` | 493 | Agent 与 TaskBook 契约 | 按 taskbook、trace、stage 类型分组并保持 barrel | E |
| `packages/app/src/main/attachment-cache.ts` | 486 | 附件索引、配额、清理和校验 | 分离 index、quota、cleanup、validation | C |
| `packages/runner/src/runner.ts` | 534 | run 生命周期与依赖协调 | 分离 run lifecycle、session、memory、stream 协调器 | E |
| `packages/memory-tree/src/types.ts` | 484 | 记忆树内部和持久化类型 | 按 node、resource、audit、projection 分组 | D |
| `packages/memory-tree/src/v3/catalog.ts` | 560 | Memory v3 catalog 生命周期、atom/FTS/向量/账本投影 | 保持 facade；schema、query/codec、graph 已分离，后续把 ledger/due 投影下沉 | D |
| `packages/memory-tree/src/v3/event-journal.ts` | 446 | Memory v3 event 与 operation journal 的同构恢复语义 | 契约稳定后拆为两个 store，共享 bounded journal codec | D |
| `packages/memory-tree/src/v3/contracts.ts` | 417 | Memory v3 atom、认识状态、事件、实体、证据与 Embedding 契约 | 阶段 3 接入前按 atom、epistemic、event、graph 分组并保持 barrel | D |
| `packages/memory-tree/src/v3/atom-store.ts` | 437 | atom 原子读写、轻量索引、扫描、层级和隔离 | 保持 store facade；规模验收稳定后分离 scanner/quarantine | D |
| `packages/llm/src/client.ts` | 460 | 请求、流式、reasoning、重试适配 | 分离 request builder、stream parser、response mapper | E |
| `packages/types/src/runtime-contracts.ts` | 449 | 多类运行时版本契约 | 按 context、event、checkpoint、execution 分组并保持 barrel | E |
| `packages/memory-tree/src/memory-repository/resource-store.ts` | 439 | 资源注册、生命周期、重绑定和审计 | 分离 registry、lifecycle、rebind、audit | D |
| `packages/memory-tree/src/workspace-resource-index.ts` | 446 | 工作区资源索引、游标和更新 | 分离 store、scanner state、change-set | D |
| `packages/memory-core/src/archive.ts` | 445 | daily 归档、摘要和回滚 | 分离 selection、distillation、commit、rollback | D |
| `packages/app/src/renderer/workspace-persistence.ts` | 381 | 工作区恢复快照与规范化 | 分离 schema、normalize、serialize | B |
| `packages/prompt/src/builder.ts` | 367 | Prompt 分段和装配 | 保留 builder facade，复杂 section 移入 `sections` | E |
| `packages/plugins/src/channel/manager.ts` | 366 | 渠道调度、会话和发送 | 分离 dispatch、session、delivery | C |
| `packages/app/src/renderer/ArchiveManager.tsx` | 363 | 归档加载、树和操作 | controller + project/session 视图 | B |
| `packages/runner/src/infra.ts` | 355 | 默认基础设施创建 | 按 memory、tools、session、skills adapter 分组 | E |
| `packages/app/src/main/memory-tree-control.ts` | 339 | 记忆控制面查询和命令 | 分离 query、resource、projection command | C |
| `packages/channels/telegram/src/plugin.ts` | 339 | Telegram 协议和生命周期 | 分离 transport、mapper、sender | C |
| `packages/app/src/main/attachments.ts` | 339 | run 附件解析和所有权分类 | 分离 ownership、metadata、content resolver | C |
| `packages/cli/src/commands/import-repo.ts` | 322 | 导入流程、Git、LLM 和进度 | 分离 source、distill、progress adapter | C |
| `packages/runner/src/execution-log.ts` | 389 | 执行日志 schema、写入、查询与按会话原子摘要 sidecar | 分离 codec、store、query 与 latest-summary store | E |
| `packages/channels/webhook/src/plugin.ts` | 310 | Webhook server、鉴权和消息 | 分离 server、auth、mapper、sender | C |
| `packages/experience/src/experience-store.ts` | 309 | 经验索引、备份、并发和衰减 | 分离 index、backup、mutation、decay | D |
| `packages/app/src/renderer/app-shell/use-app-controller.ts` | 576 | Renderer 跨领域兼容协调、启动恢复和视图快照 | 保持装配职责；Runtime/附件 effect 契约稳定后再下沉 | B |
| `packages/app/src/renderer/workspace/terminal.tsx` | 556 | PTY 生命周期、SSE、尺寸和命令历史 | 保持终端事务边界，禁止吸收工作区导航职责 | B |
| `packages/app/src/renderer/workspace/file-navigator.tsx` | 457 | 目录缓存、筛选、展开路径和文件树 | 建立树状态特征测试后再拆 controller/view | B |
| `packages/app/src/renderer/workspace/preview-pane.tsx` | 446 | 文件分派、编辑草稿、保存审批和预览错误 | 建立文件打开事务测试后再拆编辑与预览 | B |
| `packages/app/src/renderer/workspace/files.tsx` | 400 | 文件工作面组合 | 保持组合职责，不接收标签壳或终端逻辑 | B |
| `packages/app/src/renderer/settings/plugins.tsx` | 394 | 插件发现、筛选、启停、来源确认和代码授权 | 新能力进入插件宿主或独立设置组件 | B |
| `packages/app/src/renderer/workspace/use-workspace-layout-controller.ts` | 380 | 布局恢复、标签/草稿持久化和拖动入口 | 两级阈值算法保持在独立 interaction 模块 | B |
| `packages/app/src/renderer/workspace/panel.tsx` | 368 | 拓展工作区标签壳 | 保持纯组合，领域内容继续下沉 | B |
| `packages/app/src/renderer/ui/icons.tsx` | 333 | 无状态声明式图标集合 | 出现独立图标家族时按家族拆分 | B |
| `packages/harness/src/stages/execute/tool-loop.ts` | 326 | 单步模型工具循环、审批、失败记录和消息续接 | 分离 loop policy、invocation adapter 与 transcript | E |
| `packages/context/src/context-engine/snapshots.ts` | 310 | Context/模型请求快照、哈希和有界裁剪 | 分离 snapshot builders 与 hash/shape codec | E |
| `packages/app/src/renderer/chat/run-actions.ts` | 308 | SSE 顺序、活动归并、审批、停止和收尾 | 建立事件 reducer 特征测试后再拆分 | B |

## 已完成拆分

| 原始文件 | 原基线 | 当前入口 | 已形成边界 | 完成日期 |
| --- | ---: | --- | --- | --- |
| `packages/app/src/renderer/api.ts` | 1088 | 21 行兼容 barrel | `run`、`sessions`、`runtime`、`attachments`、`workspace-files`、`terminal`、`extensions`、`memory` 与 `common` | 2026-07-14 |
| `packages/app/src/main/local-app-api-server.ts` | 2819 | 241 行 server 组合入口 | HTTP 基元、run、projects、sessions/archive、runtime、memory、workspace、terminal、extensions、公共 contracts 与实例级资源清理 | 2026-07-14 |
| `packages/app/src/renderer/App.tsx` | 9935 | 7 行兼容入口 | `app-shell`、`approval`、`chat`、`composer`、`runtime`、`settings`、`sidebar`、`ui` 与 `workspace` 领域视图和 controller | 2026-07-14 |
| `packages/memory-tree/src/memory-repository.ts` | 1279 | 171 行 repository facade | 文档存储/迁移、资源生命周期、节点管理、写入策略、意图写入和项目路径重绑定 | 2026-07-15 |
| `packages/memory-tree/src/memory-service.ts` | 1120 | 343 行 service facade | run、摘要、附件、事件、Bootstrap、Skills、工作区资源、项目投影和资源管理协调器 | 2026-07-15 |
| `packages/context/src/engine.ts` | 690 | 180 行 engine facade | candidates、budget、eviction、assembly、counting 与 snapshots | 2026-07-15 |
| `packages/harness/src/stages/decide.ts` | 620 | 169 行 stage facade | 模型返回契约、需求/TaskBook 规范化、澄清请求和局部重规划 | 2026-07-15 |
| `packages/harness/src/stages/execute.ts` | 867 | 46 行 stage facade | guidance、tool-loop、权限/超时、failure-policy、TaskBook runners 与 final-reply | 2026-07-15 |
| `packages/harness/src/stages/verify.ts` | 473 | 145 行 stage facade | 裁决契约、结构证据、步骤状态、验证记录和恢复路由 | 2026-07-15 |

## 拆分顺序

1. 阶段 2 先冻结共享契约、兼容 facade 和特征测试。
2. C 与 D 优先拆 Main/API 和 Memory，减少 B/E 的跨层依赖。
3. B 已在 API barrel 稳定后完成 Renderer 组合壳拆分；后续 Renderer 细分继续按真实窗口验收。
4. D/E 所有权下的 Memory、Harness/Context 已完成 facade 化与内部领域拆分，LLM Call Contract 和记忆意图闸门已在稳定边界上接入。
5. 当前先完成 Memory v3 阶段 2 的剩余基准与后台治理，再收敛统一 Tool Execution Service；每次只移动一个责任域，完成定向测试和全量质量门后再继续。

## 当前共享契约与 facade

这些契约先于实现搬迁冻结，旧模块继续 re-export 或组合它们，避免一次性修改所有调用方：

| 契约/Facade | 唯一来源 | 当前兼容入口 | 下一步移动边界 |
| --- | --- | --- | --- |
| 会话、项目、归档 | `packages/app/src/shared/session-project-contracts.ts` | `main/session-index.ts`、`main/project-index.ts`、`main/archive-index.ts`、`renderer/api.ts` | sessions/projects/archive API client 与 main routers |
| 工作区产物、布局、终端活动 | `packages/app/src/shared/workspace-contracts.ts` | 三个 main index 与 `renderer/api.ts` | workspace/terminal domain clients and routers |
| Runtime、Provider、数据根 | `packages/app/src/shared/runtime-api-contracts.ts` | `local-app-api-server.ts`、`renderer/api.ts`、`data-root-migration.ts` | runtime/data-root services |
| 记忆控制面 | `packages/app/src/shared/memory-control-contracts.ts` | `memory-tree-control.ts`、`renderer/api.ts` | memory API router and MemoryTreeView controller |
| 附件元数据 | `packages/app/src/shared/attachment-contracts.ts` | `attachments.ts`、`renderer/api.ts` | attachment API/import service |
| Local App API 路由 | `packages/app/src/shared/local-app-api-routes.ts` | `local-app-api-server.ts`、`renderer/api.ts` | 分域 router modules; static and dynamic path encoding remains centralized |
| Agent 状态机和模型请求 | `packages/types/` | `runner`、`harness` public barrels | 统一 Tool Execution Service 与 RuntimeEventQueue |

当前 facade 输入输出：`startLocalAppApiServer(initialRunner, options) → LocalAppApiServer`、`createRunner(options) → AgentRunner`、`MemoryService`、`ContextEngine`、各 Harness stage function 和 renderer `api.ts` 导出函数。Call Contract 已通过这些稳定入口接入；后续工具执行与实时事件职责同样不得重新塞回 facade。

## 受控超限清单

以下不是永久例外，而是有界拆分队列。301-600 行文件继续由上方软上限队列管理；超过 600 行文件只能接受修复、特征测试或完成拆分所需的兼容修改，且不得超过登记上限。到期时必须复查、下调上限或完成拆分。

| 文件 | 所有者 | 暂缓原因 | 行数上限 | 复查日期 |
| --- | --- | --- | ---: | --- |
| `packages/app/src/renderer/MemoryTreeView.tsx` | B / Renderer Memory | 先冻结记忆管理、资源和投影交互特征，再按 controller/view 拆分 | 1104 | 2026-08-15 |
| `packages/channels/qqbot/src/plugin.ts` | C / Channel Plugins | 等待渠道 transport 与协议适配端口稳定后拆分 | 801 | 2026-08-15 |
| `packages/memory-tree/src/project-memory-projection.ts` | D / Memory | 投影事务、冲突与恢复必须在特征测试覆盖后迁移 | 780 | 2026-08-15 |
| `packages/memory-tree/src/memory-tree.ts` | D / Memory | 根索引、导航和预算状态共享不变量，先冻结 facade | 650 | 2026-08-15 |
| `packages/channels/feishu/src/plugin.ts` | C / Channel Plugins | 等待渠道 transport 与事件验签端口稳定后拆分 | 632 | 2026-08-15 |
| `packages/app/src/main/data-root-migration.ts` | C / App Main | 数据迁移事务需保持恢复与回滚原子性，先补齐阶段检查点 | 637 | 2026-08-15 |
