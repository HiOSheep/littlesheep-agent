# LittleSheep 模块拆分地图

最后更新：2026-07-14

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
| `packages/app/src/renderer/App.tsx` | 9935 | 应用壳、导航、侧边栏、聊天、设置、工作区、浮层和大量状态 | `app-shell`、`navigation`、`sidebar`、`chat`、`settings`、`workspace`、`overlays` 领域组件与 controller | B |
| `packages/app/src/main/local-app-api-server.ts` | 2819 | HTTP 基础设施及所有 Local App API 路由 | `http` 基础设施和 run、sessions、runtime、memory、workspace、terminal、plugins、attachments 路由 | C |
| `packages/app/src/renderer/api.ts` | 1088 | 兼容 fetch/SSE barrel 和尚未分域的请求 | 按 run、sessions、runtime、memory、workspace、terminal、plugins、attachments 拆分客户端，保留 barrel | B |
| `packages/memory-tree/src/memory-repository.ts` | 1279 | 文档 IO、迁移、节点、资源、审计和备份 | repository facade + `document-store`、`migration`、`node-store`、`resource-store`、`audit-store` | D |
| `packages/memory-tree/src/memory-service.ts` | 1120 | run/project/bootstrap/skills/附件/事件资源协调 | service facade + scope、bootstrap、skill、attachment、event、project 协调器 | D |
| `packages/app/src/renderer/MemoryTreeView.tsx` | 1104 | 记忆树加载、管理、资源和项目投影视图 | controller + tree、resource、audit、project-projection 组件 | B |
| `packages/harness/src/stages/execute.ts` | 867 | 步骤调度、工具循环、权限、错误和证据 | stage facade + scheduler、tool-loop、permission、failure、evidence | E |
| `packages/channels/qqbot/src/plugin.ts` | 801 | QQ 协议、连接、消息、发送和生命周期 | transport、protocol、message-mapper、sender、lifecycle | C |
| `packages/memory-tree/src/project-memory-projection.ts` | 778 | 投影生成、同步、冲突、恢复和删除 | projection facade + render、sync、conflict、lifecycle | D |
| `packages/context/src/engine.ts` | 690 | 候选规范化、预算、淘汰、装配、计数和快照 | engine facade + candidates、budget、eviction、assembly、ledger、snapshot | E |
| `packages/memory-tree/src/memory-tree.ts` | 650 | 根索引、导航、展开、搜索和预算 | tree facade + index、navigation、expansion、branch-search、budget | D |
| `packages/app/src/main/data-root-migration.ts` | 637 | locator、清单、复制、重绑定、提交、恢复和回滚 | migration facade + plan、manifest、copy、rebind、commit、recovery | C |
| `packages/channels/feishu/src/plugin.ts` | 632 | 飞书验签、事件、消息、发送和生命周期 | verification、transport、message-mapper、sender、lifecycle | C |
| `packages/harness/src/stages/decide.ts` | 620 | 需求校准、复杂度、TaskBook、解析和重规划 | stage facade + calibration、complexity、taskbook-parser、replan | E |

## 软上限审查队列

| 当前文件 | 基线行数 | 主要责任 | 处理方向 | 所有权 |
| --- | ---: | --- | --- | --- |
| `packages/plugins/src/host.ts` | 536 | 插件发现、加载、启停、贡献迁移 | 分离 discovery、activation、contribution、reconcile | C |
| `packages/memory-tree/src/legacy-memory-branches.ts` | 509 | 旧记忆分支兼容 | 保持隔离，迁移结束后缩减或退役 | D |
| `packages/app/src/main/index.ts` | 503 | Electron 启动和组合 | 抽取 bootstrap 服务，入口只保留装配顺序 | C |
| `packages/types/src/agent.ts` | 493 | Agent 与 TaskBook 契约 | 按 taskbook、trace、stage 类型分组并保持 barrel | E |
| `packages/app/src/main/attachment-cache.ts` | 486 | 附件索引、配额、清理和校验 | 分离 index、quota、cleanup、validation | C |
| `packages/runner/src/runner.ts` | 484 | run 生命周期与依赖协调 | 分离 run lifecycle、session、memory、stream 协调器 | E |
| `packages/memory-tree/src/types.ts` | 484 | 记忆树内部和持久化类型 | 按 node、resource、audit、projection 分组 | D |
| `packages/harness/src/stages/verify.ts` | 473 | 步骤验收、缺口分类和恢复反馈 | 分离 criteria、gap、recovery-feedback | E |
| `packages/llm/src/client.ts` | 460 | 请求、流式、reasoning、重试适配 | 分离 request builder、stream parser、response mapper | E |
| `packages/types/src/runtime-contracts.ts` | 449 | 多类运行时版本契约 | 按 context、event、checkpoint、execution 分组并保持 barrel | E |
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
| `packages/runner/src/execution-log.ts` | 316 | 执行日志 schema、写入和读取 | 分离 codec、store、query | E |
| `packages/channels/webhook/src/plugin.ts` | 310 | Webhook server、鉴权和消息 | 分离 server、auth、mapper、sender | C |
| `packages/experience/src/experience-store.ts` | 309 | 经验索引、备份、并发和衰减 | 分离 index、backup、mutation、decay | D |

## 拆分顺序

1. 阶段 2 先冻结共享契约、兼容 facade 和特征测试。
2. C 与 D 优先拆 Main/API 和 Memory，减少 B/E 的跨层依赖。
3. B 在 API barrel 稳定后拆 Renderer；任何交互变化都按真实窗口验收。
4. E 最后拆 Harness/Context 并实现 LLM Call Contract，避免在不稳定接口上重复迁移。
5. 每次只移动一个责任域，完成定向测试和全量质量门后再继续。

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
| Agent 状态机和模型请求 | `packages/types/` | `runner`、`harness` public barrels | LLM Call Contract and stage-specific ports |

当前 facade 输入输出：`startLocalAppApiServer(initialRunner, options) → LocalAppApiServer`、`createRunner(options) → AgentRunner`、`MemoryService`、`ContextEngine`、各 Harness stage function 和 renderer `api.ts` 导出函数。阶段 3-4 只能在这些入口稳定、特征测试通过后移动内部实现。

## 例外登记

当前没有批准的永久例外。301-600 行文件可以暂缓拆分，但不得继续增加新的责任；超过 600 行文件只能接受用于 facade、特征测试或完成拆分的兼容修改。例外必须记录文件、原因、所有者、上限和复查日期。
