# @littlesheep/memory-tree

最后更新：2026-08-02 12:37:00

实现索引优先的记忆树、统一 Memory Service、T0-T3 资源注册、项目投影、Memory v3 数据层和资源生命周期。

## 职责与边界

- 公开入口是 `src/index.ts`；`memory-service.ts` 与 `memory-repository.ts` 是稳定门面，内部协调器分别位于 `memory-service/` 和 `memory-repository/`，`memory-tree.ts` 负责导航。
- `conversation-source-store.ts` 保存用户输入与对话区可见内容形成的对话原始来源；`src/v3/` 拥有 atom projections、投影变更记录、有界事件/操作 journal、SQLite catalog、FTS/向量、启动恢复协调、有界维护 worker、实体关系与引用治理。对话来源证明当时收到了或展示了什么；投影变更记录只负责幂等、恢复和审计；atom 是可治理投影。
- `src/memory-repository/v3-migration*.ts` 与 `repository-locator.ts` 负责隔离的 v2→v3 快照、映射、构建、校验、原子提交、恢复和回滚；运行中的 v3 backend 通过同一验证核心提供只读回滚就绪检查，只有 v2 源与 v3 当前状态均未变化时才允许登记重启回滚。它们不会自动迁移正式用户数据。
- 读取遵循根索引、分支索引、按需展开和分支内深搜；`task-query.ts` 先把当前请求解析为有界任务语义，只有真实指代才继承最多 2 条最近 user/assistant 文本；近期仍缺任务锚点时，才从版本化会话摘要提取最多 4 段、1,000 字符作为低权重回退。硬排除、负向约束和任务转向在所有检索层共用；`task-relevance.ts` 计算当前任务匹配，不混入 confidence、importance 或历史 usefulness。D1 在已限定 branch/scope 内用 FTS 找精确候选并补少量近期候选，不调用向量；prime 在每分支最多 80 个 D1 条目中只接纳 `task relevance > 0.25` 且属于最强相关簇的候选，再按完整治理优先级选择有界 D2 working set，执行中可 release 当前 Atom。弱相关尾部保持可发现但不为填满上限自动注入。分支内深搜在高置信候选与后续候选出现清晰 task-relevance 断层时停止，不为填满 limit 注入噪声；分数整体偏弱或连续时不武断截断。物理目录和 parent 层级只负责持久化、恢复、人工治理和限定候选空间；Runtime 决定本轮发现、采用、保留、释放和重新激活哪些 Atom。最终注入由任务匹配、作用域、权威、可信度、认识状态、时效、已验证收益、有界 routing feedback、有效关系相关度和预算共同决定。routing 派生相关度会随时间回归中性，新反馈先衰减旧有效权重，避免历史负反馈复活。同一次分支内深搜只生成一次查询向量并复用于已授权作用域。写入先持久化 Atom 引用的对话原始来源，再写投影变更记录，并更新带 parent、scope、tier、`sourceRefs`、`evidenceRefs` 和认识状态的 Atom 投影。
- `src/memory-repository/v3-write-graph-projection.ts` 把 EVOLVE/CAPTURE 的有界实体与关系 hints 投影为 proposed 图记录；`v3-write-graph-policy.ts` 校验实体边界、方向、来源、证据与 scope，并由 Runtime 决定 confidence、authority、status 和 resolution；`v3-write-graph-activation.ts` 在 Atom 成功提交和引用后激活满足证据门的关系，并在启动时有界补偿中断激活。关系提交失败或证据不足时保持 proposed，不参与自动注入；`similar-to` 只用于导航。
- `memory-reconciliation-contracts.ts`、`memory-reconciliation-validation.ts` 与 `memory-reconciliation.ts` 组成模型提案的重复 Atom 调和边界。模型只能引用本轮 adopted KnownState 中的当前 revision；Runtime 另行校验 scope、parent、认识边界、确定性语义锚点及 `conflicts-with`/`replaces` 关系。单轮最多 2 个提案、每项最多 4 个 source；多源提交复用现有原子 merge mutation，部分失败保留未提交 source，重试会识别已完成合并。该路径不扫描全库、不调用向量，也不允许模型重写 canonical 内容或事实状态。
- `memory-hierarchy-contracts.ts`、`memory-hierarchy-validation.ts` 与 `memory-hierarchy.ts` 组成显式关系驱动的叶子 Atom 跨 parent 重组边界。模型只能引用本轮 adopted 的当前 D2/D3 Atom；Runtime 校验同 scope、叶子状态、关系方向、active/resolved 状态、来源证据、confidence/relevance、revision、循环和恢复。单轮最多 1 项，超额提案进入拒绝审计；真实 V3 Backend 集成覆盖提交、重启、Catalog、关系邻域和投影记录。该路径不重写正文、不搬迁非叶子子树、不扫描全库、不调用向量。
- `memory-subtree-contracts.ts`、`memory-subtree-validation.ts` 与 `memory-subtree.ts` 组成独立的非叶子子树移动边界。模型只能引用本轮 adopted 的完整 D3 根与目标 parent；Runtime 校验同 branch/scope、active descendant 有界计数、根至少 1 个且最多 128 个 active descendants、关系方向/强度、revision、循环和恢复。单轮最多 1 项，超额提案进入拒绝审计；真实 V3 Backend 集成覆盖只移动根、后代保持、Catalog 计数、重启、关系邻域、投影记录和 noop 恢复。该路径不重写正文、不扫描全库、不调用向量，且不放宽叶子 reparent 协议。
- `memory-correction-contracts.ts`、`memory-correction-validation.ts` 与 `memory-correction.ts` 组成有证据约束的事实纠正/冲突替代边界。模型只能引用本轮通过验证、完整 D3、当前 revision 的两个既有 Atom；Runtime 校验同 branch/scope/parent/statement kind、权威与证据、方向正确且已 resolved 的 `replaces`/`conflicts-with` 关系，再以 supersession mutation 原子提交。旧 Atom 保留正文、来源与历史，只改变生命周期投影为 `superseded`；普通检索排除它，管理与恢复路径仍可读取它。单轮最多 1 项，响应丢失重试返回 noop；该路径不创建新 Atom、不覆盖原始数据、不扫描全库、不调用向量。
- `MemoryRunCoordinator.refine` 与 `MemoryTree.refine` 为 DECIDE 后的结构化 TaskBook 提供二次有界选择。goal、success criteria、未完成步骤和 acceptance criteria 作为独立任务锚点评分；单次最多 2 Atom/400 tokens，单 run 最多 4 次，规范化重复 query 直接跳过。新增 Atom 仍进入同一 working set、KnownState 与访问账本，不建立旁路 Context。
- 文件位置、语义 `parentId`、D0-D3 披露和缓存压缩深度都不是 Atom 的动态热度。连续、惰性衰减的 activation score 已统一用于持久记忆和语义缓存：真实采用并产生验证价值才升温，长期不用或无帮助逐渐降温；两类资源共享计算契约，但隔离 namespace、TTL 与删除规则。任务相关度、作用域和认识状态始终先于 activation，前端只显示带滞回的高/中/低三层只读投影。
- Atom 完整 `contentHash` 用于文件完整性；Catalog v9 的 `embeddingHash` 只覆盖真正进入本地向量模型的语义内容。纯反馈、层级、关系权重和治理元数据变化不得重建向量；只有 active Atom 保留可检索向量，归档或 tombstone 会释放向量，恢复为 active 后重新进入有界维护队列。
- 禁止默认跨树向量召回、复制 UI 专用记忆，或让用户项目文件自动变成长期记忆。
- 普通 GUI 不展示 Atom、关系、向量或压缩投影，只展示应用数据根中的记忆文件；Runtime 仍保留完整结构，LLM 通过有界根索引按需展开 Atom。用户可见的回复、过程说明、验证说明和记忆变化表达由 LLM 结合 `SOUL.md` 构思，Renderer 只呈现 Runtime 事实与模型文案。

## 依赖与数据

- 依赖 memory-core、安全和公共契约；Runner、Harness 和 App 只通过公开服务访问。
- 拥有记忆树仓库、资源注册表、审计、项目投影和工作区元数据索引，不拥有外部文件正文。
- 正式用户数据当前由 v3 接管；backend 仍以数据根中的 locator 为权威并失败关闭。v2 实现与迁移 snapshot 继续保留用于兼容读取、验证和受约束回滚，不再承接正式新写入。

## 测试与修改定位

- 双后端行为契约位于 `src/memory-repository.contract.test.ts`。
- v2→v3 安全迁移、实时回滚预检与故障注入位于 `src/memory-repository/v3-migration.test.ts`；App validator 透传位于 `packages/app/src/main/memory-v3-migration-control.test.ts`。
- 对话原始来源不可改写测试位于 `src/conversation-source-store.test.ts`；重复 Atom 合并的幂等、部分失败重试、语义锚点和关系阻断位于 `src/memory-reconciliation.test.ts`，EVOLVE 的 KnownState/revision 准入位于 `packages/harness/src/stages/memory-stages.test.ts`。任务语义组合、多轮指代、压缩摘要回退、否定条件、任务相关度、D1 admission、最强相关簇、旧 Atom 精确召回、综合优先级、动态 feedback 衰减、连续 activation、缓存隔离、重复 active Atom 去重和 D1 零向量边界位于 `src/task-query.test.ts`、`src/task-relevance.test.ts`、`src/memory-prime-relevance.test.ts`、`src/memory-feedback.test.ts`、`src/memory-tree-evidence.test.ts`、`src/memory-tree.test.ts`、`src/memory-service-v3.test.ts`、`src/memory-repository/v3-retrieval-activation.test.ts`、`../types/src/activation.test.ts`、`../session/src/cache-activation-store.test.ts` 与 `src/memory-repository/v3-backend.test.ts`。Memory v3 的投影变更记录保留/孤儿恢复、10,000 Atom 扫描、Catalog 重建、离线向量批处理、inactive 向量释放、due 补偿、关系引用治理、提交后关系激活和故障重放测试位于 `src/v3/*.test.ts` 与 `src/memory-repository/v3-*.test.ts`。统一规模与运行时路由验收位于 `scripts/verify-memory-v3-soak.mjs` 和 `scripts/lib/memory-v3-runtime-soak.mjs`；`verify:memory-v3-bge-soak` 使用真实本地 BGE 验证 512 维批处理、暂时不可用、瞬时失败恢复、离线和释放生命周期；`verify:memory-v3-relevance` 分开量化 D1 与 branch-scoped deep search 的 Recall@K、误注入、scope 泄漏、token 和查询向量调用边界；`verify:memory-v3-evolution` 验证真实请求释放/重入、KnownState、旧反馈衰减、验证收益分层、重启保持和 vector deep search；`verify:memory-v3-intent-routing` 验证中英文指代、LS 方案引用、硬排除/负向约束、任务转向和项目作用域；`verify:memory-v3-compaction-continuity` 验证版本化摘要回退、重启连续性和弱相关尾部不自动注入；`verify:memory-v3-atom-reconciliation` 验证有界 hints、proposed→active、提交失败隔离、跨 scope 拒绝、替代方向、未验证建议和重启一致性；`verify:memory-v3-taskbook-refinement` 验证模糊请求延迟注入、结构化锚点独立评分、working set/KnownState 同步、重复 query 去重、预算和零网络边界。真实负载质量、成本和资源聚合位于 `@littlesheep/runner`，不会由 memory-tree 启动常驻采样。
- 叶子层级重组的纯边界测试位于 `src/memory-hierarchy.test.ts`，真实 V3 Backend 提交、关系邻域、投影记录和重启一致性位于 `src/memory-hierarchy-backend.test.ts`；非叶子子树的纯边界和真实 V3 Backend 重启/响应丢失测试位于 `src/memory-subtree.test.ts`、`src/memory-subtree-backend.test.ts`；事实纠正的纯边界和真实 V3 Backend 重启/响应丢失测试位于 `src/memory-correction.test.ts`、`src/memory-correction-backend.test.ts`；EVOLVE 的 D1/D2/D3、revision、correction、subtree 单轮上限和超额拒绝审计由对应 stage 测试覆盖。
- 修改持久格式时必须提供版本化迁移、回滚、重启恢复和防数据丢失证据。
