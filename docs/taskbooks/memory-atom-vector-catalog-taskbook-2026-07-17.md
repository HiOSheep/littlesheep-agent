# LittleSheep 原子记忆与内置向量目录任务书 2026-07-17

最后更新：2026-07-17 23:33:48
版本：v3.30
状态：阶段 0-26 的 Runtime 工程实现、正式数据迁移、本地向量、动态路由、独立任务相关度、D1 精确候选召回、Memory v3 专属相关性门、动态 working set 与反馈演化门、多轮指代/否定条件/任务转向门、压缩后任务连续性门、关系引导的一跳 Atom 选择门、写入认识边界门、Atom 相关性与关系调和门、TaskBook 驱动的二次注入调和门、跨持久记忆/语义缓存的连续 activation、前端三层只读投影、真实负载质量/成本/资源观测、初始 KnownState、显式 Atom 使用反馈、500 Atom 确定性规模门、256 Atom 真实 BGE 恢复门、Memory v2 写入退役、结构化 daily 压缩提升、模型提案的有界重复 Atom 合并闸门、显式关系驱动的叶子 Atom 跨 parent 重组、有证据约束的同陈述内容修订、有证据约束的事实纠正/冲突替代，以及有证据约束的非叶子子树重组均已完成首版工程闭环；真实 Provider 与达到校准门槛的长期真实负载验收仍未完成

## 1. 目标

把现有集中式记忆文档升级为 Memory v3：

- 用户输入与对话区可见的 LS 回复、任务步骤、工具过程、验证和错误先形成带哈希的对话原始来源；来源一旦写入不修改、不合并、不裁剪，纠正通过新的来源记录表达；它证明当时收到了或展示了什么，不自动证明其中技术主张为真；
- 每次 Atom 变化另写投影变更记录，保存 `MemoryUpdateEvent`、mutation、期望 revision 和 commit receipt；它只服务幂等、恢复与审计，不再称为原始数据；
- 一条可独立理解、检索和治理的记忆对应一个 atom projection；atom 可去重、合并、调整层级、规范化、失效、恢复和重建，但不得改写其对话原始来源；
- 每次 run 维护独立的 Context working set：首次用户请求由 Runtime 从 D1 索引自动选择少量相关 atom；执行中 LLM 可通过受控 `expand/deep_search` 决策继续纳入 atom，也可 `release` 当前无用 atom；
- 原子记忆仍属于长期、daily、项目或经验分支，并通过 parent 保持树状层级；
- 物理文件位置和分片层数只服务持久化、恢复与规模治理，不直接决定 Atom 是否进入 Context；
- 每次 run 先从当前请求形成有界任务语义；请求本身足够明确时不拼接历史，只有真实指代或选项引用才补最近少量用户/LS 对话，并显式处理否定、排除与任务转向；
- 内置本地向量目录负责原子文件的登记、层级查询、全文检索、向量检索、状态和一致性管理；
- 记忆读取继续遵守 `root index -> branch index -> hierarchy expansion -> branch-scoped search`；
- 在已导航分支和当前作用域内，经过验证、对当前任务更有价值的记忆优先进入 Context；
- 可选记忆长期没有产生验证价值或对当前决策无用时降低注入权重，Context 在全流程中可以增补也可以收敛；
- 记忆使用反馈必须区分“被访问”与“被验证有用”，防止错误内容因重复出现而自增强；
- Atom/关系的相关性和 usefulness 可随真实使用结果变化；事实 confidence 只由权威来源或验证证据改变，访问频率不能替代证据；
- Atom 不采用固定三层或四层热度模型。语义 parent、D0-D3 披露、缓存压缩深度和动态激活层级彼此独立；真实采用且产生价值的频率推动 activation score 上升，长期不用或无帮助使其惰性衰减。该分数只影响候选速度、缓存驻留和任务门后的排序，不改变事实、权威或语义归属；
- 注入 LLM 的记忆必须携带有界证据元数据，让模型能判断来源、层级、置信度、重要性、新鲜度和冲突状态；
- 用户记忆、LS 自身记忆、项目/会话记忆、经验与知识资源统一使用渐进式披露，不建立旁路副本；
- 所有记忆更新由时间和真实事件驱动，先持久捕获、再幂等归并，失败可恢复且不静默丢失；
- 每条记忆区分事实、用户陈述、观察、建议、假设和决定，并保留验证状态与权威范围；
- 记忆中的用户、项目、文件、会话、任务、Skill、工具、规则和概念具有明确实体边界，有向关系按证据和作用域渐进披露；
- 默认 Embedding 在本地生成，不把记忆正文发送到 Provider 的 `/embeddings`；
- 现有用户数据只能通过备份、校验、可恢复迁移和显式批准进入新格式。

本任务不是把任意长文机械切成固定字符块。原子化的依据是语义所有权：一项事实、偏好、决策、经验、约束或可复用方法应能独立理解，并拥有独立来源和生命周期。

对话原始来源、投影变更记录、atom、向量目录和 working set 都只是实现机制。它们的唯一目的，是让 LS 对需要保留的信息不失忆，并让每次任务只加载和使用当前真正有效的信息；任何不能改善持久可恢复性或任务执行效率的细分设计，都不应继续增加复杂度。

## 2. 当前实现差距

迁移前的 Memory v2 已具备分支、parent、tier、scope、索引优先读取、资源注册和写入闸门，但仍有七项结构性差距：

1. `memory-tree/index.json` 同时保存全部节点、资源、审计和恢复队列，单文件会随记忆增长而扩大；
2. `packages/vector` 的 SQLite 数据库位于本地，但向量通过当前 LLM Client 的 `/embeddings` 生成，并固定使用 `text-embedding-3-small`；
3. 旧 `VectorIndexedMemoryStore` 与新的 `MemoryRepository` 是两条并存路径，向量目录没有成为原子记忆文件的统一管理索引。
4. 用户记忆、LS 自身记忆、项目/会话记忆和知识资源尚未拥有统一的 domain 与 D0-D3 渐进披露契约。
5. 写入仍缺少统一的 `MemoryUpdateEvent` journal、时间 due index、幂等归并和启动补偿协议，不能宣称所有记忆都能近实时更新且失败不丢。
6. 用户、外部资料和模型产生的事实主张、建议、偏好与决定尚无统一 epistemic schema，存在把“有人建议”误当成“事实成立”的风险。
7. 实体身份、所有权边界和关系尚未形成统一 schema；名称、路径、向量相似或共现可能被误当成同一对象或已验证关系。

正式运行路径现已切换到“对话原始来源 + 可演化 Atom 投影 + 层级导航 + 完全本地向量目录”。阶段 0-26、正式迁移、Catalog v9 工程契约、初始 working set、KnownState、动态路由、D1/分支内深搜相关性门、动态反馈演化、多轮任务语义门、压缩后任务连续性门、关系引导的一跳 Atom 选择、运行时认识元数据决策、自动实体/关系投影、提交后关系激活、冲突/替代调和、TaskBook 驱动的二次 Atom 选择、持久记忆/语义缓存连续 activation、前端三层只读投影、真实负载质量/成本/资源观测、投影恢复、隔离 soak、真实本地 BGE 恢复、旧双权威写入退役、结构化 daily 提升、重复 Atom 合并闸门、显式关系驱动的叶子 Atom 跨 parent 重组、同陈述内容修订、事实纠正/冲突替代和有界非叶子子树重组均已完成首版工程闭环。当前未完成的不是文件位置、迁移、本地反馈、基础多轮指代、压缩摘要回退、关系候选发现、写入认识分类、结构化任务二次注入、动态 activation、daily 一对一提升、重复投影合并、叶子层级修正、同陈述澄清、有证据事实替代或有界子树移动，而是真实 Provider 驱动的新会话与 EVOLVE/CAPTURE、真实长任务、纠正/子树提案质量、跨陈述语义重写和达到校准门槛的持续用户负载验收。

## 3. Memory v3 数据模型

### 3.0 四层数据语义

```text
Conversation Source Store
  -> Projection Mutation Record Store
  -> Atom Projection Store + rebuildable Catalog
  -> Run Context Working Set
```

- **Conversation Source Store** 保存用户发来的内容，以及用户能在对话区域看到的 LS 回复、任务步骤、工具过程、验证结果和错误。每条记录保存稳定 id、session/run、发生时间、原始载荷、捕获时间和内容哈希；没有 update/delete/prune API。它是“当时收到了或展示了什么”的原始数据，不等于其中所有陈述已经成为事实。
- **Projection Mutation Record Store** 保存一次 `MemoryUpdateEvent`、结构化 mutation、涉及的 atom id、期望 revision、捕获时间和内容哈希；没有 update/delete/prune API。mutation 提交后另写 append-only commit receipt。它是内部恢复与审计记录，不是对话原始数据。当前源码为兼容既有磁盘格式仍保留 `raw-record*` 内部文件名和类型别名，公开契约与 UI 统一使用“投影变更记录”。
- **Atom Projection Store** 是面向层级导航、相关性计算、FTS/向量检索和用户治理的当前语义投影。去重、合并、移动层级、规范化、失效、恢复、重建和 tombstone 都只影响投影；合并保留来源、证据、来源 atom tombstone 与历史，不能因重复出现自动提高 confidence。
- **Run Context Working Set** 是单次 run 内实际介入模型的有界 atom 集。加入和 `release` 都由 Runtime 校验索引前置条件、作用域、预算、去重和证据封套；release 的即时动作只改变当前 working set，不改原始来源或事实状态。run 结束后，Runtime 可以把“本轮被释放”转换为有界、可恢复的 routing feedback，用于降低未来默认注入概率，后续仍可重新介入。
- Recovery journal 与 operation journal 只保存有界恢复状态，可以裁剪已提交记录；它们既不是对话原始来源，也不是投影变更记录的替代品。

### 3.1 Atom 投影文件

Atom 是从对话原始来源、外部证据、投影变更记录或迁移基线派生的可重建语义投影，不是原始对话文件。每个 atom 文件至少包含：

```text
version
id
domain
branch
parentId
scope / scopeKey
tier
statementKind / epistemicStatus / authorityScope
assertedBy / sourceRefs / evidenceRefs
entityRefs / relationRefs
title
summary
content
retrievalKeys
importance / confidence / basePriority
verifiedUsefulness / routingFeedback / feedbackRevision
mergedFromAtomIds / mergedIntentIds
lastUsefulAt / lastVerifiedAt / lastRoutedAt
reason
sourceRunIds / sourceStages
status
resolutionStatus
effectiveAt / expiresAt / revalidateAt
createdAt / updatedAt
contentHash
```

约束：

- `id` 创建后不因标题、父级、项目路径或文件路径变化而改变；
- `domain` 至少区分 user、agent-self、task/project/session、experience 和 knowledge；domain 只定义主体与治理边界，不替代 branch/scope/tier；
- `statementKind` 区分 instruction/goal、preference/value、reported observation、factual claim、suggestion/hypothesis 和 decision/approval；`epistemicStatus` 记录 reported、unverified、corroborated、verified、disputed、superseded 等状态；
- `authorityScope` 描述来源在哪些问题上有决定权。用户对自身目标、偏好、授权和决定拥有权威，不因此自动拥有客观技术事实的证明力；
- `resolutionStatus` 记录建议/假设的 proposed、under-review、adopted、rejected、superseded，或 claim 的待验证/已解决状态；采纳建议不能把其事实主张自动改为 verified；
- `entityRefs` 只引用具有稳定 id、类型和 owner/scope 的实体；`relationRefs` 引用独立关系记录，不能仅凭名称、路径、共现或向量相似自动生成强关系；
- `parentId` 是层级权威字段，子节点列表由目录查询生成，不在多个文件中重复维护；
- 一个 atom 只保存一个可独立治理的记忆语义；多个来源可以强化同一 atom，不应重复创建近义文件；
- `sourceRefs` 只引用对话原始来源；工具、VERIFY、外部文档和其他佐证进入 `evidenceRefs`，两者不得混用；
- `basePriority` 是可审计的基础治理值，不等于最终注入顺序；最终顺序由当前任务、作用域、来源、状态和已验证使用反馈动态派生；
- `verifiedUsefulness` 只保存有界、可重建的验证反馈摘要，`feedbackRevision` 防止旧反馈覆盖新状态；详细证据进入受限审计记录，不把无限增长的访问历史塞进 atom；
- `routingFeedback` 只保存有界的 useful/not-useful/conflict/stale 路由摘要、最近反馈 id 和最后路由时间。VERIFY 明确列出本轮实际使用的 active/adopted Atom 时，可以形成仅影响路由的 useful 反馈；未验证 release 可以降低后续可选注入排序。两者都不能修改 `confidence`、认识状态或 `verifiedUsefulness`；反馈计数和去重 id 都有硬上限，旧影响随时间回归中性；
- `lastUsefulAt` 只在有验证收益时更新；由它派生的衰减只降低可选候选的注入权重，不改写事实 confidence，不作用于 T0、安全规则和当前用户约束；
- 单纯读取或仅留在 Context 中不得修改 `confidence`、`importance`、`basePriority` 或正向路由。模型必须在 VERIFY 结构中显式声明实际使用的 Atom，且 Runtime 只接受当前 active + adopted 的 id；该声明本身只更新 routing usefulness，只有结构性验证或独立成功工具证据才能更新 verified usefulness；
- 完全相同或近义 atom 只有在 statement、epistemic、authority 与作用域兼容时才能去重；重复来源可以补充溯源，但不能因模型给出更高 confidence 就覆盖正文；合法父级变化保持稳定 id，并执行 revision、同作用域和循环校验；
- Atom 的 routing relevance、关系 relevance 与已验证 usefulness 可以按各自证据规则变化；事实 `confidence` 只在证据真实支持陈述，或用户在自身目标、偏好和决定等权威范围内确认时变化；关系 relevance 会有界参与候选排序，但关系 confidence 与事实状态不随普通 release 改变；
- 原始文档、附件和项目文件仍是资源，不应为了进入向量库而复制成大量记忆 atom；
- 写入使用临时文件、刷盘和同卷原子 rename，不允许原地截断覆盖。

建议目录：

```text
memory-tree/
  v3/
    conversation-sources/
      <shard>/<source-hash>.conversation-source.json
    raw-records/
      <shard>/<event-hash>.raw-record.json  # 兼容路径，语义为 projection mutation record
    raw-record-commits/
      <shard>/<event-hash>.commit.json      # projection mutation commit receipt
    atoms/
      long-term/<shard>/<atom-id>.memory.json
      daily/<shard>/<atom-id>.memory.json
      project/<shard>/<atom-id>.memory.json
      experience/<shard>/<atom-id>.memory.json
    catalog.sqlite
    operations/
    events/
    backups/
```

分片只服务于文件系统规模，不代表记忆层级；真实层级由 `parentId` 和目录数据库共同表达。

因此，本任务的质量核心不是“文件摆放得多像一棵树”，而是同一份 Atom 能否被稳定定位、关系相关性是否会随证据与真实使用结果演化，以及 Context Engine 能否在每个阶段正确注入、释放和重新激活 Atom。物理目录可以在兼容迁移中调整，只要稳定 id、来源、层级、关系、审计和检索语义保持不变。

### 3.2 内置向量目录

`catalog.sqlite` 是 Memory Repository 的本地操作目录，至少包含：

- `atoms`：atom id、文件路径、branch、parent、scope、tier、状态、哈希和时间；
- `atom_fts`：标题、摘要、正文与 retrieval keys 的本地全文索引；
- `atom_vectors`：atom id、embedding 版本、维度和向量；
- `atom_access`：访问时间、run、stage、检索路径、命中原因和是否进入 Context；
- `atom_feedback`：从 atom 的验证反馈摘要和受限审计事件生成的查询投影，包含有用/无帮助/冲突/过期结果、证据引用、衰减后的 usefulness 和最近验证时间；
- `memory_events`：已持久捕获投影事件的查询投影、处理状态、目标版本、幂等键、重试和恢复位置；完整 mutation 在投影变更记录中，pending/recovery 状态由有界 event journal 管理；
- `memory_due`：按 effective、expiry、revalidation 和 usefulness decay 时间定位到期 atom，避免全库轮询；
- `evidence_links`：atom/claim 与工具结果、用户原话、文档版本、执行步骤和 VERIFY 结果之间的可追溯关系；
- `entities`：实体 id、类型、owner、scope、稳定外部键、状态、别名和版本；
- `relations`：有向实体关系、作用域、来源、证据、置信度、权威范围、相关度、有效/过期时间、冲突和解析状态；
- `operations`：跨文件系统与 SQLite 更新的恢复日志；
- `audit`：写入、合并、移动、归档、失效、删除和重建证据。

Memory Repository 是 Atom 与目录的唯一持久写入入口；Conversation Source Store 独立保存不可改写的对话原始来源。投影变更记录保存事件与 mutation 的恢复/审计依据；atom 文件保存可审计的当前投影、最小重建元数据和有界验证反馈摘要；SQLite 负责高效管理和查询；访问明细与恢复日志按容量和保留期治理。数据库属于可重建索引：损坏或删除后，可以扫描持久文件、校验哈希和 parent 引用并重建目录与当前优先级基线；不能让数据库、journal 或 Renderer 成为无法恢复的唯一记忆副本。

### 3.3 层级与检索

读取顺序保持：

```text
bounded root index
  -> selected branch index
  -> parent/child expansion
  -> FTS or vector candidates inside the selected branch/subtree
  -> read selected atom files
  -> Context budget and dedup gate
```

- 默认禁止跨分支、跨项目或跨 scope 的全库向量召回；
- 向量检索只返回候选 atom id、分数和命中原因，正文仍从 atom 文件按预算读取；
- 层级导航足够时不调用向量检索；FTS 与向量只作为分支内补充；
- 每次介入继续记录 branch、parent、atom、source、tier、预算和命中原因。
- 分支内候选稳定排序至少考虑 scope/项目匹配、来源权威、当前任务相关性、confidence、importance、basePriority、新鲜度、已验证 usefulness 与冲突/失效/过期惩罚；排序明细必须可审计。关系 relevance 只有在候选与当前任务匹配时才偏离中性，不能因一个 Atom 关系很多就把它顶入无关任务。
- `accessCount` 只能用于访问统计和缓存优化，不能直接提高 confidence 或注入优先级；正向 routing feedback 必须绑定 VERIFY 明确使用证据，verified usefulness 还必须绑定结构性验证或真实工具证据。
- Memory Repository 向 Context Engine 返回证据引用和优先级明细，由 run 级 `KnownState` 记录本轮实际采用、拒绝和仍冲突的记忆；后续阶段不能依赖未登记的记忆内容。
- 可选候选按最后验证收益和策略配置执行时间衰减；衰减后仍可通过强 scope 匹配、新证据、用户点选或索引导航重新激活。低频不等于错误，衰减不能自动改变 confidence、归档或删除 atom。
- 实际注入使用 `MemoryEvidenceEnvelope`，只携带本次判断需要的 atom 引用、branch/scope、tier、来源/权威、confidence、importance、task relevance、routing relevance、relationship relevance、验证/更新时间、命中理由、状态、冲突与截断信息；完整访问历史不进入 Prompt。
- 当前初始选择实现只检查 D1 索引元数据，最多选择 2 个 D2 atom、总预算 600 tokens，并要求任务相关度严格高于 `0.25`。先用 task relevance 决定是否准入并保留最强相关簇，再按 scope、authority、confidence、importance、epistemic status、verified usefulness、routing/relationship relevance 和时效形成综合选择顺序。明显较弱的尾部候选留在索引中供后续展开；没有候选达标时保持零注入，不为凑数量加入无关 Atom。这些是可测试的安全默认值，不是永久固定的产品常量。初始选择不做跨树向量搜索。
- 执行过程中，LLM 可通过 `memory_tree` 请求 branch index、expand、branch-scoped deep search 或 `release`。新增片段进入当前 working set；release 只移出本轮 active set、释放 token/dedup 预算并记录 KnownState 排除原因。run 收尾时可以另写 routing feedback 投影，影响未来排序，但不修改对话原始来源、事实 confidence 或认识状态。

### 3.4 统一渐进式披露

所有 domain 使用同一披露协议：

```text
D0 root/domain/branch index
  -> D1 atom summary + evidence metadata
  -> D2 selected atom content
  -> D3 source versions + update/audit history
```

- LLM 和 UI 默认从 D0/D1 开始，只有任务、验证或用户管理需要时才进入 D2/D3；
- D0-D3 表示披露深度，T0-T3 表示介入优先级和预算语义，两者不能共用字段或相互推断；
- 冲突、低置信、待恢复、待重验和权限风险必须在 D1 可见，不能等展开审计后才暴露；
- User Memory 与 Agent Self Memory 都不能维护脱离 Memory Repository 的私有 Prompt 副本或 UI 副本。

### 3.5 陈述与事实边界

所有来源先产生 statement，再依据类型和证据进入不同治理路径：

```text
user/external/model statement
  -> classify statementKind + authorityScope
  -> preserve assertedBy + exact source
  -> attach evidence and epistemicStatus
  -> verify / adopt / reject / keep unresolved
  -> expose through KnownState and MemoryEvidenceEnvelope
```

- 用户说“我希望/我选择/我允许”时，分别作为 goal/preference/decision/approval 处理，在其权威范围内直接约束 Agent；
- 用户说“系统一定是这样”时，保存为来自用户的 factual claim；工具或权威资料验证前不能改写为 verified fact；
- 用户或外部来源提出“建议这样做”时，保存为 proposal/hypothesis。Agent 可以评估并采用，但必须独立记录采纳决定和验证证据；
- 官方文档、专家、搜索结果和其他 Agent 具有不同 source authority，但仍需保留版本、适用范围和冲突状态；
- 单条错误建议不能派生用户能力、知识水平或人格标签。对用户能力的任何长期信息必须有用户明确陈述或多次、直接且经用户可管理的证据，并默认标记为待确认推断；
- confidence 表示对内容正确性的证据强度，authority scope 表示来源在该问题上的决定权，两者不能合并成一个分数。

### 3.6 实体边界与关系

实体和关系使用独立、版本化的 catalog 契约：

```text
statement / atom / resource
  -> resolve or create scoped entity ids
  -> propose directed relations with evidence
  -> validate ownership, scope and temporal bounds
  -> persist relation state
  -> disclose D0 boundary -> D1 strongest relations -> D2 local neighborhood -> D3 evidence/history
```

- 实体至少区分 user、project、directory、file、session、task、skill、tool、rule、concept 和 external-source；同名实体默认保持独立，只有稳定外部键或经验证映射才能合并；
- 关系至少支持 belongs-to、depends-on、references、conflicts-with、replaces、derived-from、similar-to、affects 和 supported-by；方向与反向查询不能混为一条无方向标签；
- 每条关系记录 `scope`、`source`、`evidenceRefs`、`confidence`、`authorityScope`、`relevance`、`effectiveAt`、`expiresAt`、`status` 和 `resolutionStatus`；
- `similar-to`、向量距离、共现次数和路径邻近只用于候选导航，不能证明 same-as、belongs-to、depends-on 或因果关系；
- 跨用户、跨项目、跨会话、跨插件 owner 和跨权限边界的关系默认不传播记忆或权限；需要传播时必须有显式规则和审计；
- 删除、归档或合并实体前先检查入边、出边、TaskBook/项目/Skill 引用和可恢复状态，不能产生静默悬空引用。

## 4. 本地 Embedding

- 默认使用随应用提供的本地多语言 Embedding Engine，覆盖中文、英文和代码/技术文本；
- Provider `/embeddings` 默认关闭，只能在用户明确启用远程 Embedding 时作为可选实现；
- Embedding Engine 通过版本化接口接入，记录 engine id、model id、维度和内容哈希；
- 更换模型时后台分批重建向量，不阻塞文件读取和层级导航；
- 模型选择通过代表性中文偏好、项目决策、代码经验和混合语言查询基准确定，兼顾召回质量、安装体积、内存和首轮延迟；
- 初始候选优先评估量化的 `multilingual-e5-small` 与 `bge-small-zh-v1.5`，不在没有基准证据时锁定最终模型。

当前基准结论：

- `bge-small-zh-v1.5` 为平衡默认：18 组中英/混合/代码查询 Recall@1 `0.7778`、Recall@3 `0.8889`，量化 ONNX 约 24 MB，离线复跑 RSS 增量约 104 MB；
- `multilingual-e5-small` 为高质量可选档：同一基准 Recall@1 `0.9444`、Recall@3 `1.0`，量化 ONNX 约 118 MB，离线复跑 RSS 增量约 441 MB；
- 两种模型都从 LS 显式资产目录读取，文件固定 revision、大小和 SHA-256；模型验证完成后阻断进程内网络请求，推理阶段网络尝试均为 0；
- BGE 作为默认是资源与质量的平衡选择，E5 保留给更重视混合语言/代码召回且能接受更高内存占用的设备。向量仍只在层级导航和分支内 FTS 不足时介入。

即使本地 Embedding 不可用，层级索引和 FTS 仍必须正常工作，不能让向量能力成为记忆系统的单点故障。

## 5. 一致性与恢复

文件系统和 SQLite 不能依靠一个普通事务同时提交，因此每次变更使用可恢复操作日志：

1. 先确认本次 Atom 引用的对话原始来源已经持久化，再把带 event id、idempotency key、domain/scope、来源时间、观察时间、证据和期望 atom 版本的 `MemoryUpdateEvent` 与 mutation 原子写成投影变更记录；
2. 将同一事件登记到有界 event journal，并写入带 operation id 的 pending 记录；
3. 在版本前置条件下原子创建、合并或替换 atom projection 文件；
4. 在 SQLite 事务中更新目录、FTS、向量状态、due index 和审计；
5. 校验投影变更记录/atom 哈希、事件 revision 与数据库记录；
6. 标记 operation 与 event committed；
7. 启动时先比对投影变更记录、journal 与 catalog：变更记录已存在但 journal 缺失时补建恢复事件；随后幂等重放未完成操作。状态含糊时报告冲突，不能猜测覆盖。

V3 backend 激活后，对话原始来源由 Runner 从用户输入和对话区域可见内容补齐；正式 V2 路径在迁移前继续使用会话 JSONL，不提前创建 V3 来源文件。投影事件至少覆盖用户新增/纠正、任务状态、工具与 VERIFY 证据、项目/受管资源变化、LS 能力和配置变化、冲突处理、权限决定，以及 effective/expiry/revalidation/decay 时间到达。主任务只有在所引用对话来源与投影事件均已持久捕获后才能把记忆更新显示为“已记录”；atom 归并可以在不阻塞回复的有界后台流程中完成。

应用运行时通过事件队列和 due index 近实时处理，不使用无界轮询。应用关闭期间跨过的时间点在下次启动补偿，已登记资源使用保存的指纹对账；未授权目录不扫描。事件处理失败必须显示 pending/recovery 状态并有限重试，不能伪装为成功。

删除默认先进入 archived/tombstone 状态，经过保留期和引用检查后再回收文件与向量。项目移动只更新 scope/path 投影，不改变 atom id。

## 6. v2 到 v3 迁移

正式迁移必须满足：

1. 只读检查现有 `index.json`、备份、资源和恢复队列；
2. 创建完整 v2 快照，不修改原文件；
3. 按现有 node id 生成 atom 文件，保留 branch、parent、scope、tier、来源、状态和时间；
4. 构建本地目录、FTS 和待生成向量队列；
5. 校验节点数量、根节点、父子关系、内容哈希、资源关联和审计数量；
6. 通过版本 locator 原子切换到 v3；
7. 保留 v2 快照和回滚入口，用户确认稳定前不删除；
8. 中断后必须能够继续迁移或恢复 v2，不能产生双重权威写入。

本任务书获批不等于立即迁移当前用户数据。迁移代码先在隔离副本和故障注入测试中通过，再单独请求用户批准正式切换。

## 7. 实施阶段

### 阶段 0：契约与特征测试

状态：**已完成隔离契约与特征基线**。`packages/memory-tree/src/v3/contracts.ts` 已冻结 atom、domain、D0-D3、陈述/认识状态/权威、实体/关系、事件、操作、证据、反馈、优先级和 Embedding 端口；现有 v2 测试保持原样通过。

- 定义 `MemoryAtom`、`MemoryCatalogEntry`、`EmbeddingEngine` 和 operation journal v1；
- 定义 `MemoryDomain`、`MemoryDisclosureLevel`、`StatementKind`、`EpistemicStatus`、`AuthorityScope`、`MemoryEntity`、`MemoryRelation`、`MemoryUpdateEvent`、`MemoryAccessRecord`、`MemoryUseFeedback`、`MemoryEvidenceEnvelope`、候选优先级明细和 `KnownState` 记忆证据引用契约；
- 冻结 v2 行为特征：层级、写入闸门、项目重绑定、资源注册和 UI 管理；
- 增加“默认禁止远程 Embedding”的网络出口测试。
- 增加“重复访问不自动强化”“显式使用与独立验证分层反馈”“低收益可选记忆按策略衰减”“T0/安全/当前约束不被普通衰减淘汰”“冲突/过期记忆不优先注入”的特征测试。
- 增加“所有 domain 使用 D0-D3”“事件先持久再确认”“重复事件幂等”“崩溃后重放”“关闭期间到期项启动补偿”的特征测试。
- 增加“用户目标/偏好具有范围内权威”“用户技术主张仍待验证”“采纳建议不等于事实验证”“错误建议不生成用户能力画像”“外部权威来源仍保留版本和适用范围”的特征测试。

验收：新契约不改变当前运行数据；旧路径有完整行为基线。

### 阶段 1：Atom Store

状态：**已完成隔离实现**。Conversation Source Store 使用独立分片文件、内容哈希和只追加 API；投影变更记录沿用兼容 `raw-record*` 内部路径与只追加 API；Atom 使用 branch + SHA-256 shard 路径、稳定 id、轻量常驻 header、按需正文读取、内容哈希、修订前置条件、同卷临时文件/刷盘/rename、parent/作用域/循环校验和损坏/孤儿隔离；event 与 operation journal 具备幂等键、三态恢复、记录/数量硬上限。隔离测试覆盖对话来源幂等/冲突、变更记录冲突、journal 裁剪后恢复依据保留、CRUD、归档/恢复与 10,000 atom 重启扫描，未读取或迁移正式用户目录。

- 实现分片路径、原子读写、哈希、状态管理和损坏隔离；
- 实现 parent 校验、循环检测、孤儿恢复和目录扫描；
- 实现分片 event journal、事件幂等键、版本前置条件和 pending/committed/recovery 生命周期；
- 所有测试使用隔离数据目录。

验收：一万 atom 的创建、读取、更新、归档和重启扫描保持有界且不丢层级。

### 阶段 2：Catalog 与本地 Embedding

状态：**已完成隔离实现与真实离线验收**。

- 已完成：可删除重建的 `node:sqlite` catalog、FTS5、branch/scope/subtree 强制过滤、向量 BLOB 与版本状态、访问/反馈有界保留、due index、事件/操作投影、实体/有向关系边界、数据库完整性检查和流式重建；
- 已完成：`MemoryV3StorageCoordinator` 强制执行“投影变更记录捕获 → event/operation 登记 → atom 写入 → catalog 投影 → 双提交”；启动时分批协调投影变更记录、journal 与 catalog，故障注入覆盖变更记录已写/event 未写、只捕获事件、merge 部分写入和 atom 已写/catalog 未写等中断点；
- 已完成：远程 Embedding 默认硬拒绝且测试确认零调用；`packages/embedding` 通过显式 provision 流程管理固定 revision、大小与 SHA-256，产品运行只读完整本地目录，不隐式联网或依赖 Transformers 缓存；
- 已完成：BGE 与 multilingual E5 使用同一 18 组中文、英文、混合语言和代码基准；BGE 定为平衡默认，E5 作为高质量档；两种模型均在进程内断网断言下完成真实推理；
- 已完成：模型版本或内容变化会令已有向量进入 stale/pending；`MemoryV3MaintenanceWorker` 按有界批次生成/重建向量，不使用常驻轮询计时器，模型暂不可用时保持 pending；层级与 FTS 不依赖向量；
- 已完成：每次成功 atom 写入后会等待一次有界维护批次；若写入发生在已有批次选定工作之后，会合并为至多一个后续批次。维护失败只保留 pending/failed 状态并记录诊断，不回滚已经提交的 atom；
- 已完成：due 启动补偿先把幂等 `time-due` 事件持久捕获到 event journal，再按 atom/kind/dueAt 精确确认；存储协调器不会误消费不属于存储 mutation 的事件；
- 已完成：atom 到 entity/relation 的引用投影进入 SQLite，实体或关系归档、删除与物理清理前会检查原子引用和入/出边，避免静默悬空引用；
- 已完成：Catalog 的 Embedding 职责拆分到独立控制器，主门面保持在仓库大型文件门槛以内。

- 建立 SQLite catalog、FTS、向量接口和恢复日志；
- 建立实体与有向关系表、边界查询、关系证据和悬空引用检查；
- 建立访问账本、验证反馈表、优先级查询索引和有界保留/衰减策略；衰减参数可配置、可测试且不修改 confidence；
- 建立 memory event 投影、due index、启动补偿扫描和有界后台消费队列；
- 接入本地 Embedding Engine 并完成候选模型基准；
- 建立模型升级、向量失效和后台重建机制。

验收：断网时层级、FTS 和向量检索均可运行；数据库删除后可从 atom 文件与可恢复操作记录重建当前目录和优先级基线；访问账本与详细反馈证据有容量/保留期上限，不随运行次数无界增长。

### 阶段 3：Memory Repository v3 适配

状态：**已完成隔离适配与完整工程验证**。

- 已完成：`MemoryRepository` 保持原公共 API，通过 `memory.repositoryBackend` 在 v2/v3 间选择；默认始终为 v2，v3 还必须存在隔离数据根标记，未标记数据根失败关闭；
- 已完成：v2/v3 共享根索引、节点、资源、管理、恢复和项目重绑定契约；并发去重、daily T1 边界、资源冲突/重绑定和恢复队列由双后端契约共同验证；
- 已完成：v3 atom、资源和项目变更统一经过 event/operation journal 或 repository transaction，Catalog 删除后先恢复实体/关系投影，再重建带引用的 atom；
- 已完成：每次写入都获得 domain、statement kind、epistemic status、authority scope 和 asserted-by；事实、建议、偏好和决定不会跨认识类别合并；
- 已完成：用户、项目、文件、会话、任务、Skill、工具、规则和概念引用映射为稳定实体类型；资源仅保存元数据与权威来源引用，不复制正文；
- 已完成：Memory Service 与 Runner 在隔离 v3 数据根上完成 EVOLVE/CAPTURE、索引导航、重启恢复和 `memory-v3:atom:<id>` 证据定位；Runner shutdown 会释放 v3 Catalog SQLite 句柄；
- 已完成：大型节点存储已拆出事件与生命周期转换模块，Graph、Ledger 和 Resource Store 的首次初始化共享同一 Promise，避免重复扫描、递归等待和退出后句柄残留。

- 让现有 facade 在 feature flag 下读写 v3；
- 保持 Memory Service、Runner、Harness、工具和 UI 公共接口兼容；
- 去重、合并、冲突、失效和项目重绑定只走统一 repository transaction。
- 将用户、LS 自身、任务/项目/会话、经验和知识资源统一映射到 domain，不允许旁路写入。
- 将项目、文件、会话、任务、Skill、工具、规则和概念映射到稳定实体 id；atom、资源与关系只保存引用，不复制另一份权威内容。
- 所有写入先经过 statement/authority/epistemic 分类；建议、事实主张、用户偏好和决定走独立状态转换，禁止通过 merge 丢失类别。

验收：现有 Memory Tree 契约测试在 v2/v3 两种后端均通过。

### 阶段 4：安全迁移

状态：**已完成隔离实现与故障注入验收**。

- 已完成：迁移器直接只读原始 `memory-tree/index.json`，不会调用会自动备份并重建损坏文档的 v2 初始化器；v2 文件、备份和其他普通文件按流式 SHA-256 清单完整复制到迁移专属 snapshot，源文件在迁移前后保持相同哈希；
- 已完成：`repository-version.json` 记录 `requested -> snapshot -> building -> validating -> ready -> committing -> recovery` 状态。活动 backend 在最终 locator 原子提交前始终为 v2；locator 存在时优先于实验标记，回滚后的 v2 不能被旧实验标记绕过；
- 已完成：同卷 staging 按原 node id、parent、branch、scope、tier、状态、时间、来源、资源、写入/管理/资源审计、恢复队列、旧迁移和 schema migration 构建 atom、Graph、FTS、Catalog 与分片兼容账本；v2 没有保存的认识分类按保守规则重新分类，不伪造不存在的旧元数据；
- 已完成：提交前比较 source/snapshot manifest，逐节点比较 v2 projection 与 v3 atom，验证资源和全部账本内容、Graph 引用、Atom Store 扫描、Catalog 数量与 SQLite integrity；Embedding 模型不可用时层级和 FTS 正常完成，向量保持 pending；
- 已完成：staging 通过同卷 rename 提交为活动 v3 目录，再原子提交 locator。目录已提交但 locator 未提交时可幂等恢复；任意较早中断会丢弃受 ownership marker 约束的局部 staging 后重建；
- 已完成：回滚只在 v2 源和 v3 validation hash 均未变化时允许，防止把 v3 新写入静默丢弃。v2 原文件和 snapshot 均保留，不建立双写；
- 已完成：30 项迁移测试覆盖全部 9 个声明断电点、预检和中途 ENOSPC、损坏 JSON、损坏节点、孤儿 parent、重复 id、快照后 v2 变化、v3 写入后拒绝回滚、模型不可用、重启恢复、请求合并/取消、运行中回滚预检、回滚后重新迁移和旧 v3 保留；
- 已完成：应用只在用户确认登记后，于下一次启动的 Runner、Local App API、渠道插件、SQLite 和 Embedding 写入者创建前执行迁移或回滚；locator 是 backend 权威，配置在运行时创建前与 locator 自动对齐；
- 正式用户已通过管理控制面明确批准并完成迁移；locator/config 均为 v3，迁移前 V2 源与 snapshot 继续保留为来源和受约束回滚证据。

验收：已通过。隔离故障注入下不存在节点丢失、双写分叉或不可恢复切换；正式迁移后 40 个业务 atom、5 个内部根、11 个资源与源清单一致，重启恢复通过。

### 阶段 5：检索路径统一

状态：**已完成隔离实现与完整工程验证**。

- 已完成：`memory_tree`、`memory_search` 和 `memory_deep_search` 统一使用 repository retrieval facade；v3 依次执行层级导航、分支/作用域/子树过滤、FTS、本地向量候选、优先级排序和关系邻域展开；
- 已完成：Runner 不再创建 `VectorIndexedMemoryStore`、`SemanticDailyBranch` 或运行时 `VectorStore`，默认 Provider Embedding 旁路已退役；v3 本地模型由显式动态加载和 shutdown 释放管理；
- 已完成：branch/subtree filter、分支/run token 预算、去重、访问账本和取消信号贯穿检索路径，向量搜索不能绕过已导航边界；
- 已完成：候选优先级、`MemoryEvidenceEnvelope` 与版本化 run 级 `KnownState` 已接入 Harness。DECIDE、EXECUTE、VERIFY 和 FINALIZE 可追溯采用、排除、冲突、重新激活、状态版本和实际介入 Context 的 token；
- 已完成：statement kind、epistemic status、authority scope、asserted by 与 evidence refs 会投影给模型；VERIFY 明确拒绝把 suggestion、reported observation 或 unverified claim 当作 verified fact 交付；
- 已完成：D0-D3 使用同一份 atom/catalog 渐进展开，Prompt 与运行时不建立记忆正文副本；Context 只展开当前目标需要的关系邻域；
- 已完成：成功写入后的本地向量维护可等待、单批有界、并发合并且失败不回滚 atom，长期运行不再依赖重启补齐新记忆向量；
- 已验证：仓库卫生 32/32、27 个 workspace 类型检查、全量测试、Electron main/preload/renderer 构建、正式 V2 数据只读就绪演练、正式 V3 迁移、45 条本地向量回填和应用恢复源检查通过。

验收：已通过隔离与正式数据验收。网络被阻断时记忆写入和检索正常，向量搜索不能绕过层级导航；同一作用域内经验证且相关的记忆稳定优先介入，单纯重复访问不能形成错误自增强。

### 阶段 6：管理 UI 与真实迁移

状态：**正式迁移与数据/向量验收已完成；Runtime 同源读取、实时回滚安全预检、本地模型资产控制面、atom 高级管理、working set、运行中 release、对话原始来源、验证反馈和隔离 soak 均已接入正式 v3。普通 GUI 不再承担 Atom 管理，只展示六份记忆文件并仅允许编辑 `SOUL.md`；真实 Provider 与正式新写入场景仍待后续验收**。

- 已完成：Runtime 的 `/memory/tree`、节点详情、Atom 管理与证据导出接口继续使用同一 `MemoryRepository`、atom 和 Catalog，作为内部维护、迁移与诊断能力保留；它们不再由普通 Renderer 页面调用；
- 已完成：用户侧 `/memory/files` 只返回 `AGENTS.md`、`SOUL.md`、`USER.md`、`PHILOSOPHY.md`、`TOOLS.md` 和 `MEMORY.md`；允许列表、大小上限与“仅 `SOUL.md` 可写”由 Main/Local App API 强制执行，保存后重新加载 bootstrap；
- 已完成：LLM Context 仍使用原子化记忆。每轮只预载简短记忆树说明和有界根索引，再沿分支索引展开 Atom；GUI 文件视图不会替换或削弱 Runtime 的完整树、层级、关系和向量目录；
- 已完成：设置页“迁移与目录”展示只读预检，包括 v2 源文件/节点/资源数量、数据大小、所需与可用空间、当前 backend、pending phase，以及恢复/回滚可用性；预检不创建 locator、snapshot 或 staging；
- 已完成：设置页通过显式确认登记迁移或回滚，运行中的 API 只持久化请求、不执行结构性变更；用户可在重启前取消请求，失败进入可见 recovery，并可重启恢复或在安全边界内取消；
- 已完成：“登记请求 -> 应用重启 -> 数据根准备 -> Memory v3 迁移/回滚 -> 配置对齐 -> Runner -> Local App API -> 渠道插件”的启动前执行协议；迁移不与活动 Agent run、渠道、Repository、SQLite 或 Embedding 写入竞争；
- 已完成：迁移失败继续使用 v2；回滚失败继续使用 v3。只有 v2 源和 v3 validation hash 均未变化时才允许回滚，回滚后的重新迁移会保留旧 v3 后从最新 v2 重建；
- 已完成：回滚就绪检查在登记前读取迁移 snapshot、当前 V2 manifest，并通过活动 Runner 使用的同一 V3 repository 执行全量 validation；UI 分别显示 V2 回滚源与 V3 当前状态。V2 变化、V3 新写入或 validator 缺失均不生成 pending rollback；启动执行仍重复磁盘级强校验，防止预检后竞态或旧版本 pending 绕过；
- 已完成：迁移页与 CLI 就绪检查独立显示默认 BGE 本地资产的缺失、损坏、准备中、失败和就绪状态。用户显式点击后才按固定 repository/revision/大小/SHA-256 下载，可见进度并可取消；并发点击只复用一个任务，应用关闭会中止；模型准备期间 UI 与 Local App API 均拒绝登记迁移，避免重启与下载竞态。模型缺失不阻断迁移或层级/FTS，但不会再被误报为向量就绪；
- 已完成：用户可对 v3 atom 执行同分支/同作用域移动、受认识边界约束的合并、失效、恢复和单 atom D3 证据包导出；双 revision 预检、层级循环防护、来源 tombstone、对话来源和投影变更记录保证治理不丢溯源；
- 已完成：Runner 每轮结束补齐用户输入与对话区可见的回复、步骤、工具过程、验证和错误；EVOLVE/CAPTURE 写 Atom 前先持久化所引用来源，失败时延期投影写入。Atom 的 `sourceRefs` 与工具/VERIFY/外部佐证 `evidenceRefs` 已分离；D3 和证据导出分别展示对话原始来源与投影变更记录；
- 已完成：Conversation Source Store 只在 V3 backend 激活时写入 `memory-tree/v3/conversation-sources/`。其有界 manifest 进入 V3 validation hash；新增对话来源会使 `activeV3Unchanged=false` 并关闭可能丢失来源的回滚，同时不会改变 V2 源 manifest；
- 已完成：完全相同或近义 Atom 不再因模型重复给出更高 confidence 就覆盖正文；只有新增验证证据，或用户对自身目标、偏好、价值和决定等权威来源，才允许增强 confidence。带支持来源的完全相同 Atom 可移动到合法父级；合并继续保留来源 Atom tombstone；
- 已完成：Runner 将初始 prime 的 KnownState 同步到 Harness，确保首次注入 Atom 从第一条业务模型请求起就能被阶段链、执行日志和反馈系统识别；不再出现“正文进入 Context、KnownState 却不知道”的断链；
- 已完成：VERIFY 输出可选 `usedMemoryAtomIds`。Runtime 只接受当前 active 且 adopted 的 id；显式使用可形成轻量正向 routing feedback，但不验证 Atom 为事实。只有结构性 VERIFY，或 VERIFY 通过且存在成功工具证据时才增加 verified usefulness；单纯读取、重复出现或留在 working set 中不产生正向反馈。未验证 release 只形成轻量负向 routing feedback；已有关系的 relevance 按证据强度轻量或较强调整，relation confidence 始终保持不变；
- 已完成：首次业务模型请求从 D1 索引中最多自动选择 2 个 D2 atom、预算 600 tokens，并执行 `0.25` 最低任务相关度门；不达标时记录四个分支的零 token D1 检查而不展开正文。执行中可显式 release 当前 atom，真实请求内容和 KnownState 同步移除，后续允许重新介入；
- 已完成：`raw-record-captured` 兼容崩溃点可在重启时从投影变更记录自动补建 recovery event 并恢复 atom/catalog；已提交 journal 即使被裁剪，投影变更记录仍保留；
- 已完成：提交边界会生成独立的 append-only commit receipt。删除 catalog 并从已经历 update/archive/restore/merge 的当前 atom 文件重建时，历史投影变更记录依据 receipt 只恢复审计投影，不会倒放覆盖较新 atom；没有 receipt 的变更记录才进入 pending/committed 判定；
- 已完成：`verify:memory-v3-soak` 默认档在隔离临时数据根验证 120 次初始写入、150 条最终投影变更记录、121 个 atom、4 次重启、journal 裁剪到 8 条、projection-record-only 崩溃恢复、catalog 删除重建、96 次 working-set run、release/re-admit 和 16 条有界 ledger；120 个 active atom 的向量全部 ready，单批不超过 16，SQLite integrity 为 `ok`，临时根已删除；
- 历史验收：Renderer Atom 管理原型曾完成“更多”菜单、目标选择、D2/D3、移动、失效/恢复和证据导出真实窗口验收；2026-07-16 起该原型已从产品 GUI 删除，相关路由和 Repository management 只保留为内部治理与回归能力；
- 已完成：`verify:memory-v3-readiness` 对当前正式 V2 数据执行只读预检，并只复制 `memory-tree` 到系统临时目录。首次迁移完成关闭重启、catalog 检查和无新增写入回滚；重新迁移后再通过真实 Runner 产生会话、EVOLVE/CAPTURE atom，关闭重启后按 ID 恢复，沿索引展开、release 并由 FTS 重新介入，同时验证 V3 新权威写入会在 pending 登记前关闭回滚。40 个原业务节点、11 个资源和源哈希保持一致，V3 的 5 个内部 scope root 与业务 atom 分开验证，临时副本在成功或失败后均自动删除；演练证据只对该次源快照有效，正式登记前必须重新预检，迁移提交仍独立复核源 manifest；
- 已完成：用户明确批准后，正式 locator 在应用重启前登记迁移；启动阶段在 Runner、Local App API 和插件宿主创建前提交 v3。正式 Catalog 为 45 个 atom、integrity `ok`，配置同步为 v3，恢复源检查通过；
- 已完成：固定 BGE 模型 4 个文件共 24451050 字节通过 SHA-256 校验。修正 Electron 构建边界后，Transformers.js 使用外部 Node/ONNX 运行时，45 个 atom 均完成 512 维向量回填，0 pending、0 failed，实际向量查询命中相关记忆；
- 待完成：真实 Provider 驱动的正式会话、EVOLVE/CAPTURE 新写入和长任务连续性验收；本地动态反馈演化已由阶段 10 独立验收。

验收：读取、迁移生命周期、实时回滚预检、内部 atom 管理、working set、投影变更记录孤儿恢复、对话来源不可改写、验证反馈、catalog 灾难重建、隔离 soak、正式迁移与本地向量回填已通过类型检查、HTTP、故障/重启/并发、Runner 首次请求、会话与 atom 恢复、索引/FTS/向量和源哈希检查；用户 GUI 的文件允许列表与 `SOUL.md` 单写边界已有单元和真实 HTTP 测试。真实 Provider 新写入验收属于下一质量门。

### 阶段 7：动态注入相关性与低成本向量维护

状态：**工程实现、初始 KnownState、任务相关度门、显式使用反馈、定向与全量回归、正式 Catalog v8、500 Atom 确定性规模验收、256 Atom 真实 BGE 恢复验收和阶段 10 本地反馈演化门已完成；真实 Provider 连续性仍属于下一质量门**。

- 已完成：Atom 新增可选 `routingFeedback`。它保存有界 useful/not-useful/conflict/stale 计数、最后路由时间和最近反馈 id；旧 Atom 无需批量改写即可继续读取；
- 已完成：所有新反馈通过 Storage Coordinator、投影变更记录和 commit receipt 持久化。未验证 release 只更新 routing feedback，不改变 confidence、epistemic status 或 verified usefulness；重复反馈按持久 id 去重；
- 已完成：routing feedback 总证据和最近反馈 id 均设硬上限，并保存与事实 confidence 分离的 `effectiveRelevance/effectiveEvidenceWeight`。旧影响随时间回归中性；新事件先在当前时间点折算旧有效权重，再更新派生相关度，不会把已经衰减的历史负反馈重新放大。连续 release 会降低可选候选排序，新的验证成功、强 scope/task 匹配和索引导航仍可恢复；T0、安全规则和当前用户强约束不受普通路由衰减淘汰；
- 已完成：Atom 引用的有效关系由 Catalog 分批聚合为有界 relationship relevance。无关系 Atom 使用中性值；过期或非 active 关系不参与；聚合关系强度会按当前 task relevance 向中性值收缩，因此无关任务不会因关系数量或历史强度获得额外排序优势；
- 已完成：D1 项目条目显式携带当前 task relevance，初始 prime 使用 `0.25` 门槛且不凑满配额；四个分支的 D1 检查即使零注入也进入 run 账本，正文、token 和 working set 仍保持为空；
- 已完成：`MemoryEvidenceEnvelope`、Run KnownState 和 VERIFY 摘要均携带 task/routing/relationship 三类路由信号，并向模型提供有界 verified usefulness 正/负摘要；模型能看到“为何介入、过去是否真正有用”，但这些分数不替代来源、权威和事实状态；
- 已完成：受控 mock 连续性验收覆盖首轮 D1 注入、KnownState、VERIFY 显式采用、仅 routing usefulness 增长、EVOLVE/CAPTURE、关闭重启和新 run 项目 Atom 再召回；该验收明确标记为 mock，不替代真实 Provider；
- 已完成：Catalog schema 升至 v8，Atom 完整 `contentHash` 与 Embedding 语义 `embeddingHash` 分离。只有标题、摘要、实际嵌入正文和 retrieval keys 变化才重建向量；反馈、层级、认识状态和其他治理元数据变化保留现有 ready 向量；
- 已完成：v7 Catalog 升级会从现有 FTS 内容分批补齐语义哈希，并在旧向量与当前 Atom 完整哈希一致时保留 ready 状态；缺失或不一致记录进入 stale/pending，不伪装可用；
- 已完成：非 active Atom 不再占用可检索向量或留下无法处理的 pending 任务；归档会释放向量，恢复为 active 后重新进入有界维护队列；
- 已验证：最新全量为 175 个测试文件、1300 passed、1 skipped；仓库卫生 32/32、27 个 workspace 类型检查、Electron main/preload/renderer 构建和恢复源检查通过。新增回归覆盖连续 activation、跨刷新三层滞回、有界投影状态、重启重置、旧高价值 D1 候选、冷 Atom FTS 召回、任务相关度优先、语义缓存隔离/重启、摘要真实使用 sidecar、前端三层 API 投影、真实负载脱敏聚合和公共聚合上限，并保持既有相关性、TaskBook、关系、迁移与重启契约。正式 Catalog 已增量升级到 v9，45 个 atom/向量全部 ready，45 条 activation 投影完整，`integrity_check=ok`。
- 已验证：`verify:memory-v3-provider` 在进入隔离 Runner 前执行脱敏非流式预检并要求 Provider 返回真实 usage；当前 DeepSeek 官方端点返回 HTTP 401，OpenAI/GLM 无可用密钥，因此没有把状态机恢复文本或 mock 结果误报成真实 Provider 通过，也没有留下临时数据根；
- 已验证：统一规模 soak 的增强档使用 500 个基础 Atom、32 个关系引用 Atom、256 次 run 和双阶段共 512 条反馈。关系 relevance 从 `0.94` 调整为 `0.68` 时候选分下降但不重算向量；目标 Atom 连续 release 后让位于中性对照 Atom，验证有用后恢复首位；Catalog 删除重建后 500 个 active 向量全部 ready，最大批次 16，最近反馈 id 64、ledger 16，峰值 RSS 约 213 MiB，低于 384 MiB 门槛。该用例使用确定性本地测试 Embedding，不替代正式 BGE 大规模吞吐或真实 Provider 验收。
- 已验证：`verify:memory-v3-bge-soak` 使用活动应用数据根中经过大小与 SHA-256 校验的固定 BGE q8 资产，只在隔离临时数据根生成 256 个基础 Atom。模型暂不可用时保留全部 256 个 pending 且零 Embed 调用；恢复后完成真实 512 维向量。语义更新注入一次瞬时失败并在同一 maintenance drain 内恢复；Catalog 删除重建、4 次重启、128 次 run 后仍为 256 ready、0 pending、0 failed。全程阻断网络且尝试数为 0，pipeline 在报告前释放，峰值 RSS 约 349 MiB，低于 512 MiB 门槛。该门不替代真实 Provider 或长期用户负载验收。

验收：目录和文件位置不参与最终注入判定；层级先缩小候选范围，任务/作用域/权威/可信度/时效/验证收益/routing feedback/关系相关度共同排序；Runtime 按预算注入、释放和重新激活，所有跨 run 影响有界、持久、可恢复且不污染事实状态。

### 阶段 8：D1 召回准确性与任务相关度解耦

状态：**本地工程实现、定向回归和阶段 9 的真实 BGE 量化质量门均已完成**。

- 已完成：新增独立 `task-relevance.ts`。task relevance 只表达当前查询与 Atom 标题、摘要、retrieval keys、正文的匹配，不再混入 confidence、importance、verified usefulness 或 routing feedback；这些信号继续由候选优先级层分别治理，避免重复计权和事实可信度污染召回判断；
- 已完成：任务相关度提供有界解释，包括有效查询词数、命中词、最强字段和完整短语命中。中文请求前缀只在明确的礼貌/操作框架中剥离，不会把“检查点恢复”一类领域词误当成套话；
- 已完成：D1 在已限定的 branch/scope 内先使用 Catalog FTS 找精确候选，再补最多 80 个近期候选。这样较旧但精确相关的 Atom 不再因“只看最近 400 项”而从 D1 消失；该步骤只用本地索引，不调用向量模型；
- 已完成：初始 prime 从每个分支最多检查 80 个有界 D1 条目，而不是只看综合排序后的前 8 项；任务最相关但 confidence、authority 或历史收益较低的候选不会在进入 `0.25` admission 门之前被提前漏掉；
- 已完成：分支名称、用途、`whenToUse` 和 search hints 不再自动算作分支内每个 Atom 的 task relevance，避免用户提到“项目”“测试”“记忆”等分支概念时整批误注入；
- 已完成：测试强制 D1 branch index 不调用 Embedding；只有已完成 branch index 与 expansion 后的 branch-scoped deep search 才允许本地向量查询。定向 4 个测试文件、33 项通过；
- 已完成：固定的中英文、跨语言改写、冲突说法、近邻概念和项目作用域干扰数据集已进入阶段 9；正式本地 BGE 分别测量 D1 admission 与 branch-scoped deep search，Embedding 自身的通用基准不再替代 Memory v3 运行时质量门。

验收：task relevance 与认识可信度、治理优先级和历史使用收益保持正交；较旧精确 Atom 能通过 scope 内 FTS 进入 D1；prime 会在有界完整 D1 候选中执行门槛；分支说明不会污染 Atom 相关度；D1 零向量调用，向量仍只在已导航分支内兜底。

### 阶段 9：Atom 注入与分支内语义检索质量门

状态：**已完成真实本地 BGE 运行时验收**。

- 已完成：新增 `scripts/verify-memory-v3-relevance.mjs` 与 16 个隔离 Atom 的固定数据集，覆盖中文、英文、混合语言、用户偏好、技术规则、争议说法、项目 A/B、daily、experience 和无关负例。所有合成数据只写系统临时目录，正式用户记忆与 Catalog 保持只读；
- 已完成：D1 使用 11 个案例，其中 8 个正例、3 个负例。结果为 Recall@1 `1.0`、Recall@2 `1.0`、正例通过率 `1.0`、负例通过率 `1.0`、多余 Atom `0`、query Embedding 调用 `0`；平均注入 `132.5455` tokens，最大 `319` tokens；
- 已完成：初始注入先以 task relevance `0.25` 作为准入门，再使用完整治理优先级排序。英文词项按完整 token 匹配，`data` 不再误命中 `database`；争议外部说法即使词面更接近，也不能压过当前有效且权威的规则；
- 已完成：branch-scoped deep search 使用 10 个案例。结果为 Recall@1 `0.7`、Recall@3 `0.9`、MRR `0.7833`、通过率 `0.9`、作用域泄漏 `0`；阶段 11 加入明确相关性断层截断后，平均返回从 `530.7` 降为 `495.3` tokens，最大仍为 `638` tokens，Recall 指标不变；
- 已完成：同一次 deep search 的查询向量只生成一次，再复用于 global/workspace/project/session 的已授权作用域过滤。10 个案例只产生 10 次 query Embedding；D1 仍为 0 次。完整运行共 27 次 Embed、32 段文本，阻断网络后实际网络尝试为 0；
- 已验证：固定 BGE q8 资产为 24,451,050 字节、512 维，版本 `75c43b069aac4d136ba6bc1122f995fedcfd2781:q8`。最终复跑耗时约 `4492 ms`，RSS 从约 `56.8 MiB` 增至 `188.9 MiB`；Repository、模型 pipeline 和临时目录在退出路径均完成关闭与清理；
- 已知边界：一个较长的英文工程进度表达未进入前 5，说明平衡默认 BGE 并非跨语言语义检索的完美上限。该失败保留在明细中；当前门要求总体 Recall@3 至少 `0.9`，不通过降低阈值或隐藏失败伪装满分。高质量可选模型与持续真实负载仍需后续比较。

验收：文件路径和目录层级只负责持久化、恢复与候选导航；真正决定本轮是否介入的是 Atom 与当前任务的匹配、作用域、权威、认识状态、验证收益、动态路由/关系相关性和 token 预算。D1 精准且零向量，分支内深搜不跨 scope、每次请求只计算一次查询向量，失败边界可见且可复测。

### 阶段 10：动态 Working Set 与反馈演化质量门

状态：**已完成真实本地 BGE、Runner 请求链和重启连续性验收**。

- 已完成：初始 Atom、`memory_tree release`、重新 `expand` 使用显式起止边界。释放只删除目标 Atom 的正文，不再因按标题猜测边界而误删后续 Prompt 段；真实 Runner 请求验证释放后的下一次调用不含旧正文，重新介入后只保留最新工具结果中的一份正文；
- 已完成：KnownState 与 working set 同步记录 `adopted -> excluded -> adopted`，重新介入计数为 1；run 账本同时保留 release 与 expand 记录。文件目录不参与这条状态转换；
- 已完成：只有当前 active 且被 VERIFY 明确使用的 conflicted Atom 才能形成 conflict routing feedback。仅存在于候选池、未进入 Context 或未被使用的争议 Atom不会因一次检索被自动降权；
- 已完成：成功的 `memory_tree`、兼容记忆导航和 `use_skill` 不再冒充独立执行证据。它们可以证明“发生了导航或加载”，但不能单独提高 verified usefulness；结构性 VERIFY 或非记忆工具的独立成功证据仍可提高验证收益；
- 已完成：routing feedback 增加与 confidence 分离的派生相关度和有效证据权重。历史 useful/not-useful/conflict/stale 计数继续用于审计，但排序使用会随时间回归中性的派生值；新反馈到来时先衰减旧权重，防止历史负反馈重新复活；
- 已完成：`scripts/verify-memory-v3-evolution.mjs` 使用 24,451,050 字节、512 维的正式 `bge-small-zh-v1.5` q8 资产，在隔离数据根验证 3 个 Atom、working set 释放/重入、未见冲突不写反馈、32 次历史 release、routing-only useful、结构性 verified useful、重启恢复和 vector deep search；
- 已验证：目标 Atom 的 routing relevance 在历史 release 后为 `0.0294`，一年后回归到 `0.4717`，新的明确使用提升到 `0.5790`，结构性验证后为 `0.6500`。即时负反馈使中性对照 Atom 排到前面；衰减和新证据后目标 Atom恢复首位；
- 已验证：反馈演化前后 Atom 正文、confidence 与 embedding hash 不变，ready 向量没有因治理元数据更新而重算；重启后 routing feedback、verified usefulness 和排序保持。重启后的 branch-scoped deep search 使用真实 vector 路径，1 次请求只生成 1 次 query Embedding；网络尝试为 0，RSS 约 186 MiB，低于 512 MiB 门槛；
- 已知边界：该门证明本地 Runtime 的动态路由与证据分层，不替代真实 Provider 对 `usedMemoryAtomIds` 的判断质量，也不替代数周真实用户任务中的长尾表达、多轮指代和负面条件数据集。

验收：存储路径与文件分层只保证可恢复、可导航和便于治理；Atom 是否进入、保留、退出或重新进入 Context，必须由当前任务相关度、作用域、权威、认识状态、验证收益、动态路由/关系相关性和预算共同决定。任何访问、导航或文件位置都不能冒充事实证据或验证收益。

### 阶段 11：多轮任务指代、否定条件与任务转向质量门

状态：**已完成正式本地 BGE、D1 初始注入和分支内深搜验收**。

- 已完成：新增有界 `MemoryTaskQuery`。当前请求足够明确时只使用当前请求；只有“继续处理它”“刚才第二个方案”“Continue with that”一类真实指代才补充最近对话。继承上限固定为最多 2 条 user/assistant 文本、总计 1,200 字符，tool/system 内容不进入，最终检索文本上限 1,800 字符；
- 已完成：显式任务转向会切断旧历史，例如“换个话题”“忽略之前任务”；包含“这个项目”但已经给出完整主题的自足请求不会因为一个指示词就错误继承旧话题；
- 已完成：任务语义区分正向主题和硬排除对象。“不要旧方案，改用新方案”会保留新方案以及“旧方案已禁用”这类负向约束 Atom，同时排除只描述旧方案正文的候选；“怎样避免上下文膨胀”属于要解决的问题，不会被错误解释成禁止检索“上下文膨胀”相关知识；
- 已完成：D1、scope 内 FTS 和 branch-scoped vector deep search 共享同一结构化任务语义。候选生成可检索排除对象，以便找到负向约束；完整 Atom 正文完成 polarity 判定后，D1 摘要层不得再用不完整标题/摘要推翻该结果。没有完整判定标记的 v2/兼容索引仍执行本地词法补判；
- 已完成：branch-scoped deep search 不再为了填满调用方 `limit` 注入低相关候选。当高置信候选形成清晰 task-relevance 簇并与后续候选出现显著断层时，只返回断层前的 Atom；候选整体偏弱或分数连续时保持保守，不武断截断；
- 已完成：`MemoryBranchContext.recentHistory` 不再是闲置字段；Runner 既有 `keepRecent` 历史先经过会话边界，再由任务查询组合器做更小的二次上限。该机制不复制历史到长期记忆，不改变原始来源，也不建立无界缓存；
- 已完成：新增 `verify:memory-v3-intent-routing`。固定隔离集包含 11 个 Atom、8 个 D1 案例和 2 个 branch-scoped deep-search 案例，覆盖中英文指代、LS 方案引用、硬排除与替代、负向约束保留、任务转向、自足指示词、无历史指代、项目 A/B 作用域隔离和缓存策略否定；
- 已验证：D1 `8/8`、deep search `2/2` 全部通过；D1 查询 Embedding 为 `0`，2 次深搜恰好生成 2 次查询向量；作用域泄漏 `0`、被排除正文命中 `0`、多余 Atom `0`、网络尝试 `0`。阶段 9 的 10 个深搜案例复跑后 Recall@1/3 与 MRR 保持 `0.7/0.9/0.7833`，平均 Context tokens 降至 `495.3`。固定 BGE q8 资产仍为 24,451,050 字节、512 维，运行后 RSS 约 179 MiB，隔离临时数据根已删除；
- 已知边界：当前规则覆盖高频中英文指代和明确否定，不宣称已解决所有自然语言省略、反讽、多重否定、跨数十轮指代或真实 Provider 对 `usedMemoryAtomIds` 的判断质量。后续长尾样本必须作为新增固定案例进入同一门，不能靠放宽阈值掩盖失败。

验收：层级只限定可搜索候选，文件位置不参与注入价值；Runtime 必须先判断“本轮到底在做什么、是否引用前文、排除了什么、是否切换任务”，再让 task/scope/authority/epistemic/confidence/importance/usefulness/routing/relationship/time/budget 决定哪些 Atom 进入、保留或退出 Context。当前请求足够时不消费旧历史，信息不足时也只能有界补充。

### 阶段 12：长会话压缩后的任务连续性质量门

状态：**已完成正式本地 BGE、版本化会话摘要、重启前后初始注入和既有阶段回归验收**。

- 已完成：`MemoryRunRegistration` 新增有界 `continuitySummary`，Runner 只把当前会话元数据中已有版本 id 和摘要正文传给 Memory v3；摘要不复制成新的长期记忆，不替代原始 JSONL，也不改变 Conversation Source Store；
- 已完成：压缩摘要只在当前请求确属指代、最近 user/assistant 文本缺少明确任务主题且存在版本化摘要时作为回退。当前请求权重为 `1.0`，最近用户目标为 `0.9`，最近 LS 回复为 `0.8`，摘要片段为 `0.7`；摘要最多提取 4 个高价值句段、总计 1,000 字符，优先保留目标、未完成事项、下一步、约束和决定；
- 已完成：当前明确目标优先于旧摘要，显式任务转向完全切断摘要；摘要内的正向主题、硬排除对象和方向一致的负向决定继续使用阶段 11 的同一任务语义，不会因压缩边界复活旧方案；
- 已完成：初始自动注入在 `task relevance > 0.25` 后只保留最强相关簇。与最强候选出现明确绝对差距且相对强度明显较低的尾部 Atom 留在 D1 索引中供后续 `expand/deep_search`，不为填满最多 2 个 Atom 的上限而占用首轮 Context；治理优先级只能给已通过任务相关性簇的候选排序，不能让弱相关高优先级 Atom 越过该门；
- 已完成：新增 `verify:memory-v3-compaction-continuity`。固定隔离集包含 8 个 Atom、7 个案例，并在 Repository 重启前后各执行一次，覆盖中文/英文摘要回退、最近目标优先、任务转向、旧方案排除与新方案选择、session A/B 隔离和无摘要模糊“继续”零注入；
- 已验证：14/14 案例全部通过，D1 query Embedding `0`、网络尝试 `0`；固定 BGE q8 资产为 24,451,050 字节、512 维，运行后 RSS 约 182 MiB。阶段 11 复跑保持 D1 `8/8`、深搜 `2/2`；阶段 9 复跑保持 D1 Recall@1/2 `1.0/1.0`、多余 Atom `0`、深搜 Recall@1/3 `0.7/0.9` 和 scope leak `0`；
- 已知边界：该门证明“版本化摘要 → 有界任务锚点 → Atom 初始注入”的本地连续性，不代表活动 run 检查点、工具副作用恢复、真实 Provider 长会话或数十轮自然语言省略已经完成。摘要生成质量仍需在真实模型和真实用户负载下持续扩充固定案例。

验收：存储目录、摘要文件位置和物理层级都不能直接决定注入。Runtime 先恢复当前任务语义，再在作用域内选择最强相关 Atom 集；摘要只在必要时补任务锚点，当前输入、近期明确目标、排除条件和任务转向始终拥有更高优先级。弱相关候选保持可发现，但默认不进入首轮 Context。

### 阶段 13：关系引导的 Atom 选择与质量门

状态：**已完成有界一跳关系发现、首次 working set 注入、证据封套和重启一致性验收**。

- 已完成：关系不再只是对已经进入候选池的 Atom 做排序加权。Runtime 会从 `task relevance >= 0.7` 的高相关种子出发，通过 Catalog 的实体/关系投影做一次有界一跳发现；单次最多使用 8 个种子、检查 512 条原始路由行并返回 24 个关系候选，不扫描整棵关系图；
- 已完成：关系扩展严格限定在同一 branch、scope、scopeKey 和已选 subtree。关系必须为 active、已 adopted/resolved、已生效且未过期，confidence、relevance、authority scope 与来源/证据引用均通过门；项目 A/B、session A/B 不传播；
- 已完成：关系类型按方向分别处理。`depends-on`、`supported-by`、`belongs-to`、`references`、`derived-from`、`affects` 只沿主体到目标扩展；`replaces` 只从旧对象反向发现替代对象；`conflicts-with` 双向披露；`similar-to` 只保留为导航候选，不能触发自动注入；
- 已完成：被关系发现的 Atom 仍须独立满足 `task relevance > 0.25`，并继续接受 Atom 状态、认识边界、完整优先级和 Context 预算。关系不能替代任务价值、事实证据或作用域；低相关候选即使存在强关系也不进入；
- 已完成：阶段 12 的“最强相关簇”保持默认规则。只有已经通过独立任务门、`retrievalPath=relation` 且 route strength 至少 `0.65` 的必要关系候选，才允许跨越普通相关性断层进入首次 working set；普通弱相关尾部继续只留在 D1；
- 已完成：`MemoryAccessRecord`、`MemoryEvidenceEnvelope`、Runtime KnownState 和 D2/D3 展示新增独立 `relation` 路径与结构化 `relationRoute`，记录种子 Atom、关系 id、类型、方向、confidence、relevance 和 strength；关系发现不再伪装成 hierarchy/FTS/vector；
- 已完成：新增 Catalog、Repository、prime 和 KnownState 回归，并新增 `verify:memory-v3-relationship-routing`。固定隔离集含 20 个 Atom、20 个实体、13 条关系和 7 个案例，覆盖必要依赖、替代方向、冲突双向、`similar-to` 不注入、过期/归档/争议/低置信关系不扩散、无独立任务价值不注入、项目/会话隔离、首次 D2 注入和重启一致性；
- 已验证：7 个案例在 Repository 重启前后共 `14/14` 通过，关系路径候选 12 次，scope leak `0`、多余 Atom `0`、D1 query Embedding `0`、网络尝试 `0`；首次 working set 在重启前后均只注入种子与必要依赖，使用 319 tokens。

验收：物理文件位置、parent 层级和向量相似度只负责持久化与候选导航。Runtime 必须先由当前任务找到种子 Atom，再按有方向、有证据、有作用域的关系发现可能必要的邻接 Atom；邻接 Atom 只有独立证明对本轮有价值且预算允许时才能进入 Context。关系扩展必须可追溯、可截断、可重启复现，不能演变为无界图遍历或“有关联就全量注入”。

### 阶段 14：写入认识边界与安全蒸馏基线

状态：**已完成 EVOLVE/CAPTURE 显式陈述来源契约、Runtime 认识状态决策、重启保持和旧扁平蒸馏入口退役**。

- 已完成：EVOLVE/CAPTURE 的模型输出新增 `epistemic.domain`、`statementKind`、`assertedBy` 和 `topics`。模型只描述“谁说的、属于哪类陈述”，不允许提交 `verified`、authority 或 resolution 结论；
- 已完成：Harness 新增独立 `memory-epistemic-policy`。用户来源必须能回溯到对话原始来源，工具来源必须存在成功工具证据，外部来源必须存在外部资源证据；来源证明不足时统一降级为 LS 自身的未验证陈述，并丢弃不可信主体 id/label；
- 已完成：建议与假设始终保持 `unverified`；用户陈述保持 `reported`；工具事实只有同时存在成功工具结果与通过的 VERIFY 时才升为 `corroborated`，不会由模型直接写成 `verified`。Runtime 同时根据 branch、scope 和可信主体决定 domain 与 authority scope；
- 已完成：认识元数据进入同一个 `MemoryWriteIntent`、投影变更记录和 Atom，Repository 继续按 statement/domain/authority/actor 边界去重，避免同文建议与事实互相强化。真实 Runner 隔离测试证明 EVOLVE/CAPTURE 写入、D3 检查和关闭重启后分类保持不变；
- 已完成：旧 `packages/memory-core/src/distill.ts` 及其 `distillDailyToMemory/markDistilled` 公开入口已删除。未来 daily 提升不得原文追加到 `MEMORY.md`，只能生成结构化 Memory v3 写入提案并经过来源、认识状态、去重、审计和恢复闸门；
- 已完成：模型协议文本从阶段实现中拆到独立 `memory-stage-prompts.ts`，保持 `evolve.ts` 低于 300 行；仓库卫生新增“旧扁平记忆蒸馏入口已退役”硬检查；
- 已验证：`verify:memory-v3-epistemic-writes` 的 3 个文件、15 项专项回归通过；全量为 166 个测试文件、1266 passed、1 skipped；仓库卫生 32/32、27 个 workspace 类型检查、完整 Electron 构建和应用恢复源检查通过。

已知边界：本阶段证明模型不能自行抬高陈述真实性或权威，不代表模型对 statement/source 的描述在真实 Provider 上已经达到生产质量。实体/关系提示的 Runtime 投影、提交后激活和冲突/替代调和已由阶段 15 完成；真实 Provider 对提示质量与长期关系演化的验证仍待后续质量门。

验收：模型提出的记忆即使措辞自信，也不能绕过真实来源和证据获得更高认识状态；建议、用户陈述、工具事实与 LS 推断保持可区分、可重启恢复。同一次写入只能通过 Memory v3 结构化闸门，旧扁平原文追加路径不能重新进入公开 API 或主运行时。

### 阶段 15：Atom 相关性与注入调和质量门

状态：**已完成有界实体/关系提示、Runtime 关系投影、提交后激活、启动补偿和独立调和验收**。

- 已完成：核心指标从“文件放在哪里、关系有多少”收敛为 Runtime 能否准确决定本轮应发现哪些 Atom、首次注入哪些、保留哪些、释放哪些，以及冲突、纠正、替代或任务转向后应重新激活哪些。记忆文件和物理 parent 只负责持久化、恢复、人工管理与候选导航，不提供隐式路径权重；
- 已完成：共享认识契约允许 EVOLVE/CAPTURE 单次最多提出 12 个实体 hint 和 16 条关系 hint。模型只能描述实体键、类型、标签、端点与方向；Runtime 独立校验稳定实体边界、branch/scope/scopeKey、来源、证据和引用完整性，并决定 confidence、authority、status 与 resolution；
- 已完成：关系采用两阶段写入。候选关系先以 `proposed` 持久化，只有 Atom 成功提交、显式引用该关系且满足证据与 resolution 门后才激活。Atom 提交失败时关系保持 proposed，不参与候选扩展或自动注入；启动恢复单次最多补偿 1,000 条可证明已被 active Atom 采用或解决的中断关系；
- 已完成：跨 scope 的显式图引用直接拒绝。未经验证的建议关系保持 proposed；`replaces`、`conflicts-with`、`supported-by` 等关系按方向和证据调和，`similar-to` 仍只用于导航，不自动抬高可信度或触发注入；
- 已完成：当前任务相关度继续作为首要准入门。关系、向量、历史 usefulness、访问频率或治理优先级都不能让一个对本轮无独立价值的 Atom 越过任务门；执行中仍可通过 `expand/deep_search/release` 调整 working set；
- 已完成：`verify:memory-v3-atom-reconciliation` 覆盖替代路线、未验证建议、作用域隔离、提交失败、中断补偿和重启一致性。专项 3 个测试文件共 `17/17` 通过；可信替代路线 strength 为 `0.855` 且关系为 active，未验证建议关系保持 proposed；scope leak `0`、网络请求 `0`，重启前后候选与路线一致，Catalog integrity 为 `ok`；
- 已验证：阶段 13 关系路由复测保持 `14/14`；最新全量为 175 个测试文件、1300 passed、1 skipped；仓库卫生 32/32、27 个 workspace 类型检查、完整 Electron 构建和应用恢复源检查通过。

验收：固定数据集已量化 scope 泄漏、未验证关系误激活、替代项接管、无关关系扩散、提交失败隔离和重启一致性。通过标准继续以“当前任务拿到最少且足够的正确 Atom”为准，不以文件布局、关系图规模或召回列表长度为准。下一质量门转为真实 Provider、真实长任务与持续用户负载下的注入准确性、关系演化和 Context 成本验证。

### 阶段 16：TaskBook 驱动的二次 Atom 注入调和

状态：**已完成 DECIDE 后结构化任务锚点检索、working set/KnownState 同步、重复与次数硬上限和端到端隔离验收**。

- 已完成：首次 D1 选择仍只依据用户原始请求并保持保守。DECIDE 形成规范化 TaskBook 后，Runtime 使用 goal、success criteria、未完成步骤和 acceptance criteria 形成独立加权任务锚点，再执行一次有界 D1→D2 补充选择；模糊原始表达不会提前加载仅由 TaskBook 才能定位的 Atom；
- 已完成：TaskBook 的多个结构化锚点分别计算 task relevance，取最强有效信号，不再先拼成长文本后因额外词项稀释核心目标。候选生成仍使用统一有界 retrieval text，排除条件继续保留；
- 已完成：每次 refinement 最多增加 2 个 Atom、最多使用 400 tokens；单个 run 最多 4 次。规范化后相同 query 直接返回 `duplicate-query`，不重复扫描、注入或增加 Context；所有消耗继续受原有总 run/branch token 预算约束；
- 已完成：新增 Atom 作为 system-resident memory section 进入后续 EXECUTE/VERIFY 请求，并与 `memoryContextWorkingSet`、KnownState、访问账本和最终反馈同步。replan 只针对目标步骤生成新锚点，重复 Atom 不复制正文；
- 已完成：修复重复检索的认识状态覆盖。active/adopted Atom 再次命中但因 dedup 未重复注入时继续保持 adopted，不再被错误改写成 excluded；
- 已完成：统一用户指令的认识状态。用户在自身权威范围内明确给出的 `instruction` 与关系投影一致，resolution 为 adopted，不再因默认 unresolved 被检索层误标为 conflicted；
- 已验证：5 个定向测试文件共 35 项通过；`verify:memory-v3-taskbook-refinement` 真实走 Runner 的 CLASSIFY→DECIDE→EXECUTE→VERIFY 链。前两次模型请求未出现目标 Atom，EXECUTE 在 TaskBook 明确后收到并由 VERIFY 显式引用；4 个分支 D1 检查均有审计记录，记忆使用 553/3200 tokens，重复 query 被跳过，网络请求 `0`，隔离数据根已清理。

验收：原始请求信息不足但 DECIDE 已能精确形成 TaskBook 时，Runtime 必须用结构化任务锚点补足“哪些 Atom 应进入后续执行”的判断；不得把 TaskBook 再压成会稀释相关性的扁平长文本，也不得绕过首次选择、作用域、任务门、证据、去重和预算。二次调和只增补当前 run 的 Context，不修改对话原始来源、Atom 事实状态或跨 run relevance；长期真实模型对 TaskBook 表达质量的影响仍属于 Provider 质量门。

### 阶段 17：跨记忆与缓存的动态 Atom 激活层级

状态：**工程实现与隔离质量门已完成；后端保持连续、动态且无固定层数，前端只展示带滞回的高/中/低三层只读投影。真实 Provider 与长期用户负载观察仍是后续质量门**。

- 将“层级升降”实现为连续、惰性衰减的 activation score，不通过频繁移动文件、改写 `parentId` 或把 Atom 固定分成若干永久热层实现；
- 只有 Atom 在当前 active working set 中被模型明确使用，并由 VERIFY 或独立成功工具证据证明对任务有价值时，才计入正向使用频率。单纯检索、D1 命中、进入 Context、UI 查看或重复读取均不升温；
- 长期未使用、被 `release`、验证无帮助、冲突、过期或被替代会按不同证据强度降低动态激活值。衰减只影响候选速度、缓存驻留和排序先验，不改写 confidence、statement kind、authority、原始来源或关系事实；
- 持久记忆与语义缓存共享同一激活计算和有界聚合契约，但保留独立 vector namespace、TTL、压缩和删除策略。运行缓存可以过期或压缩，持久 Atom 只能降为冷候选，不能因低频自动丢失；
- 当前任务相关度继续是首要 admission gate。高激活但无关的 Atom 不注入；低激活但被当前任务、明确索引或强作用域精确命中的 Atom仍可即时重新激活；
- activation 使用有界计数、有效证据权重、最近真实使用时间和半衰期惰性计算，不保存无界访问日志、不启动全库常驻轮询，也不要求每次请求扫描全部 Atom。热区阈值由设备能力、工作集预算和候选分布动态决定，不写成固定层数；
- 后端保留连续 activation 与动态热区；前端只映射为三层展示，并使用滞回阈值防止临界分数反复跳层。三层 UI 结果是只读 projection，不写回后端，也不要求普通记忆文件页暴露 Atom；
- 固定回归必须覆盖：连续有效使用逐步升温、长期不用逐步降温、无关高频 Atom 被任务门阻断、冷 Atom 精确命中后重新激活、缓存与持久记忆 namespace 不串线、重启前后分数确定、反馈账本与内存占用保持有界。

实现结果：

- 已完成：`@littlesheep/types` 提供持久 Atom 与语义缓存共用的连续 activation 契约、有界证据、惰性半衰期、受保护 Atom 和三层滞回投影；共享 `AtomicActivationLevelTracker` 只保留当前投影条目的上一层，持久记忆上限 100,000、语义缓存上限 10,000，刷新替换旧集合、移除自动释放、重启自动清空，不保存无界访问历史，也没有常驻全库计时器；
- 已完成：Catalog schema v9 保存 `activation_score` 与 `activation_updated_at`，旧 Catalog 可由有界反馈兼容回填。D1 fallback 合并“高 activation”与“最近更新”两个有界候选池，精确 FTS 仍可找回冷 Atom；
- 已完成：候选评分增加任务 admission 乘数，routing 乘数也由 task relevance 调制。activation 只能在作用域、状态、认识边界和当前任务门之后影响排序，高频无关 Atom 不再压过低频精确相关 Atom；
- 已完成：版本化会话摘要正文保持不可变，独立 sidecar 记录语义缓存 activation；提交新摘要和删除会话会清理旧 sidecar，namespace、TTL 与持久记忆隔离，重启后可恢复；
- 已完成：Runner 只在摘要真实参与任务语义恢复且最终 VERIFY 通过时记录 useful；只有 structural VERIFY 或独立成功工具证据才记录 verified useful，模型自报成功不能形成已验证价值；
- 已完成：Memory Files API 汇总持久记忆与语义缓存的三层计数；Renderer 只显示高/中/低三项合计，不暴露 Atom、连续分数、内部阈值或来源明细，也不允许三层投影写回后端；
- 已验证：`pnpm.cmd run verify:memory-v3-activation` 的 11 个测试文件、62 项全部通过，覆盖升温/衰减、跨刷新滞回、投影状态上限、移除释放、重启重置、有界证据、Catalog v9、旧高价值候选、冷 Atom FTS 召回、任务优先级、缓存隔离、摘要真实使用与前端 API 投影；全工作区类型检查通过。

验收结论：工程门通过。在同一任务族和作用域内，经验证高频有用的 Atom 可更早进入有界候选窗口；低频 Atom 逐渐退出高速候选区但仍可由精确 FTS/索引找回。前端固定为三层只读汇总，后端继续保留连续动态分数；跨刷新采用真实滞回，重启只重置派生层级。长期真实负载仍需观察候选数量、任务成功率、内存回落、半衰期和设备差异，不能用 62 项隔离测试替代数周使用数据。

### 阶段 18：真实负载只读观测与校准门

状态：**观测实现、脱敏边界和正式数据只读基线已完成；当前样本不足，校准状态为 `insufficient`，不得据此调整后端 activation 参数**。

- `@littlesheep/runner` 新增版本化 `observeMemoryWorkload()`，只聚合 run 覆盖、记忆访问动作与状态、Memory token 消耗、KnownState 决策、VERIFY 显式 Atom 使用和权威 Provider usage 覆盖；不返回对话、回复、工具内容、工作路径或 Atom ID；
- 聚合默认最多检查 1,000 个 run、最多持有 4,096 个去重 Atom ID，动态 action key 和所有集合均有硬上限；没有常驻计时器、后台扫描或无界历史，报告生成后临时集合随进程退出释放；
- `scripts/report-memory-v3-workload.mjs` 沿活动数据根只读选择最新执行日志，使用固定容量最小堆控制文件选择内存；每份日志先投影为最小观测结构，再交给聚合器。损坏日志只计为拒绝，不输出路径或解析内容；
- 默认校准门要求至少 20 个包含 KnownState 的 run、10 个包含 VERIFY 显式 Atom 使用的 run、10 个包含权威 Provider usage 的 run。门槛只判断数据是否足以开始校准，不代表任务质量已经达标；
- 正式数据根只读报告发现 36 份日志，36 份成功解析、0 拒绝、0 投影截断；其中 5 个 run 有记忆访问、0 个 run 有 KnownState、1 个 run 有 VERIFY、0 个 run 报告显式 Atom 使用、2 个 run 有 Provider usage。Memory 访问共 5 条，全部为 `root_index` 且状态正常，使用 1,880/16,000 tokens；
- 当前三个校准维度均未达到门槛，因此保持现有后端连续动态 activation、半衰期和候选策略，不根据少量历史记录主观调参。前端仍只展示高/中/低三层只读投影，本阶段不新增复杂观测 UI。

验收结论：观测基础设施通过，数据校准门未通过。后续真实 Provider 与长期用户使用应自然积累 KnownState、显式使用和 usage 记录；只有报告达到 `ready`，并同时具备任务成功率、误注入、内存回落和设备差异证据后，才能提出 activation 参数调整。`ready` 只允许进入校准评审，不自动修改配置。

### 阶段 19：真实负载质量、成本与资源观测

状态：**工程实现、脱敏投影、旧日志兼容与正式数据只读报告已完成；五项校准门仍全部不足，不能据此调整 activation、Memory 预算或设备阈值**。

- `ExecutionLog` 新增可选 `runtimeResources`。Runner 每轮只在开始和持久化执行日志前各采样一次 RSS、heap、external 与 array buffer，不轮询、不启动常驻计时器；设备只保留 platform、arch、总内存和逻辑 CPU 的二次幂粗粒度桶，不保存主机名、用户名或设备唯一标识；
- `observeMemoryWorkload()` 升级为 v2，在原覆盖统计上增加最终 VERIFY verdict、TaskExecution 完成状态、Provider prompt/completion/cache/reasoning token、Memory/Provider prompt 比率以及 RSS/heap 起止值、变化量和粗粒度设备类别；所有 run、记录、引用、快照、动态 key、临时 Atom 去重和设备类别仍有硬上限；
- “adopted 但未在 VERIFY 中显式使用”只表示观测链中缺少显式采用证据，是定位埋点缺口、可能冗余或模型未报告使用情况的诊断代理；它不等同于误注入事实，不能单独生成负反馈、降低 Atom 层级或触发自动调参；
- `scripts/report-memory-v3-workload.mjs` 只接受 `source=provider` 的权威 usage，投影任务状态、真实 token 数字和资源快照后再聚合；对话、回复、工具正文、路径、请求标识和 Atom ID 均不进入最终报告；
- 默认校准门扩展为五项：20 个 KnownState run、10 个显式 Atom 使用 run、10 个 Provider usage run、20 个最终 VERIFY 结果 run、20 个资源采样 run。`ready` 只允许进入人工校准评审，不代表质量达标，更不会自动改变运行参数；
- 最新正式数据根只读报告仍发现 36 份日志，36 份成功解析、0 拒绝、0 投影截断。覆盖为：5 个 Memory access run、0 个 KnownState run、1 个最终 VERIFY run、0 个显式使用 run、2 个 Provider usage run、0 个资源采样 run；TaskExecution 为 3 done、1 incomplete、32 未记录；
- 旧日志中 4 次权威 Provider 请求共报告 prompt 5,560、completion 891、reasoning 658、cached prompt 0，Memory/Provider prompt 比率为 0.1439。该数字只描述已有日志，不代表成本目标已经合理；旧日志没有资源字段时保持缺失，不用当前进程数据回填历史；
- 专项测试覆盖 v2 schema、质量代理、Provider 成本、资源聚合、隐私边界和多重硬上限。新 run 会自然积累资源样本，旧日志继续兼容读取，不迁移、不重写正式用户数据。

验收结论：阶段 19 的观测工程门通过，真实负载校准门未通过。当前证据足以说明“可以安全观察”，不足以说明“参数已经最优”；后续必须通过有效 Provider 和长期真实任务积累质量、成本、资源回落与设备差异数据，再做人工评审。

### 阶段 20：退役 Memory v2 归档与远程向量双权威写入

状态：**已完成。旧写入代码、主动入口和核心依赖已经退役；既有磁盘数据保持原样，只保留显式标注的只读兼容边界；全量工程质量门通过**。

- 删除旧 daily 月/年 Markdown 摘要写入、`vectors/memory.db` 装饰写入和 CLI archive adapter；`@littlesheep/memory-core` 不再依赖 Config、LLM 或旧 Vector 包，CLI TypeScript 图也不再引用 Vector；
- `memory archive` 仍由参数解析器识别，但在 branding、配置、Provider、Runner 和用户数据加载前以退出码 2 失败关闭，避免旧命令被当作聊天输入或重新产生第二写入权威；
- `MemoryTier`、旧 `VectorTier`、旧 archive 文件搜索和兼容 Vector 实现仅用于读取或验证既有 v2 数据。Runner 注册的 `memory_search`/`memory_deep_search` 继续由 Memory v3 Repository 提供；兼容 adapter 不创建摘要、向量或 Atom；
- 仓库卫生门禁止七个旧文件、六个主动符号、Memory Core 的 Config/LLM/Vector 依赖和 CLI Vector project reference 回流；旧命令名称只允许出现在退役识别、错误提示和回归测试中；
- 正式用户数据中的旧 archive index 与 vector database 没有删除、迁移或改写。未来 daily 压缩、提升或蒸馏必须先形成带来源、认识状态和层级的结构化 Atom 提案，再经过统一去重、调和、审计、提交和恢复闸门；
- 对话区中真正给用户看的 Agent 回复、澄清、任务说明、步骤摘要、验证说明和交付表达必须由真实 LLM 调用结合 `SOUL.md`、用户语言与 Runtime 事实生成；同一文案只能在同一 UI 回合的更新、日志和持久化中复用，不能作为新的重复消息发送。Renderer 只呈现通过重复检查的文案和机器状态，不能自行代写 Agent 人格内容；模型不可用、空回复或重复改写耗尽时只呈现 Runtime 错误/状态。

验证证据：阶段 20 验收时的基线为 `check:repo` 33/33、180 个测试文件/1317 passed/1 skipped；当前完整复跑已更新为 209 个测试文件/1453 passed/1 skipped。CLI、参数解析和 `SOUL.md` 表达边界定向测试保持通过；27 个 workspace typecheck、Electron main/preload/renderer build、CLI 依赖构建和应用恢复检查通过。真实 Node 子进程使用故意损坏的隔离配置执行 `memory archive --force`，退出码为 2，数据目录哈希前后一致且未进入 Provider/Runner 路径。

验收结论：阶段 20 完成。Memory v3 已成为唯一生产写入路径，旧 archive/vector 只读兼容不再具有提交权；正式用户旧数据未改写。结构化 daily 压缩/提升本身属于下一阶段，不在本阶段伪装完成。

### 阶段 21：结构化 daily 压缩与提升

状态：**已完成首版确定性一对一提升闭环；来源、范围、失败保留、幂等恢复和硬上限均已接通；重复投影合并进入阶段 22，更复杂的内容重写与层级重组仍留在后续阶段**。

- `CompactionSummaryV2` 记录压缩覆盖消息中的最近 `sourceRunIds`，最多 64 个，并用 `sourceRunIdsTruncated` 明示更早来源是否被省略；旧摘要缺少新字段时继续兼容读取，字段存在时必须通过类型、非空和数量校验；
- Memory Repository 提供 Catalog 支持的 `listRecentNodes()`，单次查询硬上限为 256；consolidation 每次最多处理 8 个 Atom，不全库扫描、不建立轮询任务，也不在应用空闲时静默遍历用户数据；
- `MemoryDailyConsolidationService` 只接受当前压缩摘要明确覆盖、仍为 active、来源阶段包含 `capture`、无子节点且具有完整认识元数据的 daily Atom。争议、已替代、建议、假设、批准和证据不足的模型陈述不会自动提升；
- 首版按原 Atom 一对一形成结构化写入，不额外调用 LLM。目标按 domain/scope 保守映射到 project、long-term 或 experience，统一写入 T2；不能根据使用频率或摘要位置自动进入 T1；
- 对话原始来源继续只进入 `sourceRefs`；来源 Atom revision 和版本化会话摘要进入 `evidenceRefs`。维护写入保留全部有界来源 run/stage，并显式登记为 `maintenance`、`resource-change`；
- 流程严格执行“目标先提交，源后归档”。只有统一写入闸门返回 created/merged/reinforced 后，才按源 Atom 的 expected revision 归档；写入拒绝、异常、归档冲突或进程中断时保留 daily 源，不以消除重复为理由冒险丢失证据；
- Runner 在会话压缩摘要完成持久化和资源登记后触发 consolidation。真实集成测试确认 daily Atom 被提升为 project T2、目标保留 `capture + maintenance` 来源阶段、源 Atom 成功归档，且整轮模型请求仍为 7 次，没有为维护流程增加 LLM 调用；
- 本阶段的维护流程不负责生成用户可见文案。需要向用户说明记忆变化时，Runtime 提供真实状态与证据，LLM 结合 `SOUL.md` 和用户语言构思表达，Renderer 只负责呈现与渐进披露。

验证证据：Session compaction 6/6、daily consolidation 4/4、稳定事件/审计 1/1、写入认识边界 6/6、真实 Runner integration 7/7；阶段 21 定向回归和本轮完整质量门均保持通过；当前 `check:repo` 33/33、全量测试 209 文件/1453 passed/1 skipped、全量 typecheck、build、应用恢复检查和桌面窗口启动均通过。

验收结论：阶段 21 完成。版本化压缩摘要现在可以有界、可追溯地驱动 daily Atom 的保守提升，同时保持原始对话来源不变、失败不丢源、零额外模型调用和可恢复提交。后续若需要多个 Atom 的语义去重、合并或层级重组，只允许由模型提出结构化提案，Runtime 校验来源、认识边界、作用域、revision、关系和回归条件后提交，不允许模型直接改写存储。

### 阶段 22：模型提案的有界重复 Atom 调和

状态：**已完成 duplicate-projection 合并闸门；模型提案、KnownState 准入、Runtime 校验、幂等重试和部分失败保留均已接通；任意内容重写、跨 parent 调层级和真实 Provider 提案质量仍未开放**。

- EVOLVE 输出契约升级为 `evolution-proposal.v2`，新增独立 `reconciliations` 数组。普通 `memories[].intent=merge` 不再被当作新写入或相似写入提交，而是明确延期到 Atom 调和协议；
- 单轮最多接收 2 个提案；每个提案固定一个 canonical target 和最多 4 个 source。模型只能从本轮 `KnownState` 中引用已 adopted、未冲突、未过期且 revision 完全一致的 D2 Atom，不能凭索引标题或全库扫描提出合并；
- 模型只负责判断“这些投影是否表达同一陈述”并说明理由。Runtime 重新校验 branch、scope、scopeKey、parent、domain、statement kind、epistemic/resolution、authority、asserted source、revision、确定性语义锚点，以及连接两组实体的 `conflicts-with`/`replaces` 关系；任一边界不满足即拒绝；
- 提交继续复用 Memory v3 的原子 merge mutation、投影变更记录、operation journal 和 commit receipt。目标 wording、confidence、verified usefulness 与事实状态不被模型重写；source 保留正文并进入 tombstone，来源和证据只做有界并集；
- 多 source 以同一个有界提案顺序提交。每次成功都会推进 target revision；进程或存储在中途失败时返回 `partial`，未提交 source 保持 active。重试时根据 `source.merge.intoAtomId` 和 revision 识别已完成部分，不重复提交，也不回滚已落盘证据；
- 调和不会新增独立 LLM 调用、向量查询、后台轮询或全库扫描；它只复用本来就会发生的 EVOLVE 调用和本轮已介入 Atom。模型提案与 Runtime 的 committed/deferred/rejected/partial/noop 结果写入同一有界 `MemoryIntentDecisionRecord` 审计；
- 协议、校验和编排分别位于 `memory-reconciliation-contracts.ts`、`memory-reconciliation-validation.ts`、`memory-reconciliation.ts` 与 `stages/evolve/reconciliation.ts`，核心组合文件保持在仓库维护基线内。

验证证据：阶段 22 的 Memory Tree 与 Harness 定向回归覆盖多源合并、重复执行幂等、第二源瞬时失败后的部分结果和重试、无语义锚点拒绝、冲突/替代关系阻断、普通 merge intent 延期、KnownState adopted/revision 门和 Runtime 审计；本轮完整质量门为 `check:repo` 33/33、全量测试 209 文件/1453 passed/1 skipped、27 个 workspace typecheck、Electron build、应用恢复检查和桌面快捷方式启动均通过。

验收结论：阶段 22 的“重复投影合并”工程边界完成。LS 现在允许模型提出、但不允许模型直接执行 Atom 合并；Runtime 只在本轮已采用证据内做有界、可恢复的结构调和。下一步仍需真实 Provider 判断质量、错误提案率、长期收益和更复杂的层级/内容重组方案，不能把本阶段等同于任意语义自治整理。

### 阶段 23：显式关系驱动的叶子 Atom 跨 parent 重组

状态：**已完成首版叶子层级重组闭环；模型提案、KnownState 准入、关系方向与强度校验、叶子/作用域边界、原子提交、重启恢复、幂等重试和超额提案审计均已接通；非叶子子树移动由阶段 26 的独立协议治理**。

- EVOLVE 契约升级为 `evolution-proposal.v3`，新增独立 `reparents` 数组。普通 `memories[].intent=move` 只能进入延期审计，不能旁路写入；真正的层级调整必须携带 Atom、目标 parent、当前 revision、关系 id 和具体理由；
- 单轮最多提交 1 个 reparent 提案。第 2 个及之后的提案不静默丢弃，而是在有界数量内逐项写入 `rejected` 决策；超出审计上限的尾部另写一条有界拒绝记录，防止模型输出规模转化为无界内存或审计增长；
- Atom 与目标 parent 必须是本轮 adopted、当前 revision、未冲突、未过期的 D2/D3 KnownState 引用；二者必须保持 branch、scope 和 scopeKey 一致；只允许移动没有 active child 的叶子 Atom，避免模型在不了解隐藏子树时搬迁整棵层级；
- Runtime 只接受方向为 Atom 实体 → parent 实体的 active、resolved 且有来源证据的 `belongs-to` 或 `derived-from` 关系，最低 confidence 为 0.75、relevance 为 0.5。名称、路径、向量相似、共现和文本相似不能替代关系证据；
- 提交复用 Memory v3 的 move mutation、projection record、operation journal、commit receipt 和 revision precondition。提交成功后 Catalog、Atom、关系邻域和审计保持同源；提交响应丢失时，下一次相同提案识别已完成状态并返回 noop，不重复移动；
- 本阶段不新增 LLM 调用、向量查询、后台轮询或全库扫描。模型只负责提出语义关系，Runtime 独立决定是否满足安全边界；原始对话来源仍不可改写，Atom 只是可修订投影；
- 面向用户的记忆变化说明、任务过程、验证结果和交付表达继续由 LLM 结合运行时 `SOUL.md` 与用户语言构思。Runtime 只提供事实、状态、权限、路径、进度和证据，Renderer 只呈现并执行渐进式披露。

验证证据：Harness、纯层级服务和真实 V3 Backend 重启集成定向回归共 3 个文件、18/18 通过；覆盖正常移动、已提交重试、响应丢失恢复、非叶子拒绝、关系方向/强度拒绝、跨 scope 拒绝、D1 拒绝、超额提案拒绝审计、真实 relation neighborhood、Catalog/Atom revision、投影记录和重启后一致性。最终质量门为 `check:repo` 33/33、全量测试 209 文件/1453 passed/1 skipped、全工作区 typecheck 27/27、build 和 `verify:app-recovery` 通过。

验收结论：阶段 23 完成了“有明确语义关系时的叶子层级纠正”，没有把模型提案权扩大为任意记忆重写权。后续应先用真实 Provider 和长期负载评估提案准确率、误拒率与收益，再决定是否开放更复杂的内容修订或子树重组。

### 阶段 24：有证据约束的 Atom 同陈述内容修订

状态：**已完成首版 same-claim-refinement 闭环；模型提案、完整 D3 KnownState 准入、当前 run 验证证据、语义/硬锚点边界、原子提交、响应丢失恢复、幂等重试和超额提案审计均已接通。阶段 24 当时不包含事实纠正、冲突替代、跨陈述扩写和任意语义重写；其中事实纠正/冲突替代已由阶段 25 的独立协议补齐**。

- EVOLVE 输出契约升级为 `evolution-proposal.v4`，新增独立 `revisions` 数组和 `revise` 记忆意图。普通 `memories[].intent=revise` 只能进入延期审计，不能旁路修改 Atom；单轮最多接受 1 个内容修订提案，超额项会形成有界拒绝记录；
- 候选必须来自本轮 adopted、当前 revision、未冲突、未截断的完整 D3 KnownState，并且当前 run 已有通过的 VERIFY 记录和可追溯 Runtime 证据。模型必须复制准确 Atom id/revision，不能从索引标题、向量相似或全库扫描猜测目标；
- 首版只允许同时替换 `title`、`summary`、`content` 和 `retrievalKeys`，用于同一陈述的澄清、规范化和去冗余。稳定 Atom id、对话 `sourceRefs`、证据、实体/关系、branch/scope/parent、confidence、importance、epistemic/resolution 和生命周期状态保持不变；
- Runtime 独立校验原陈述词项保留率、新文本精度、检索锚点、长度扩张和路径、URL、版本、数字等硬锚点。修订既不能删除原硬锚点，也不能引入无证据的新硬锚点；陈述本身错误、冲突或被替代时必须进入独立纠正/冲突流程，不能借内容润色静默覆盖历史；
- 提交复用 Memory v3 的原子 update mutation、投影变更记录、operation journal、commit receipt、Catalog/FTS 同步和向量重建状态。提交响应丢失后，相同提案会依据新 revision 与投影内容识别已提交结果并返回 `noop`；
- 本阶段不新增独立 LLM 调用、向量搜索、后台轮询或全库扫描，只复用 EVOLVE 已有调用和本轮 KnownState。面向用户的记忆变化说明、任务过程、验证结果和交付表达必须由真实 LLM 调用结合 `SOUL.md`、用户语言和 Runtime 事实构思，并通过统一来源与持久化会话级精确去重；Renderer 只负责稳定状态、排版和渐进式披露，不能把固定模板冒充 Agent 人格。

验证证据：阶段 24 的 Harness、纯修订服务和真实 V3 Backend 重启集成共 3 个测试文件、22/22 通过；覆盖正常修订、重复调用 noop、响应丢失恢复、revision 冲突、无关语义拒绝、硬锚点删除/新增拒绝、D2/截断 D3 拒绝、单轮超额提案审计，以及 Atom、Catalog、投影记录和 commit receipt 的重启一致性。最终质量门为 `check:repo` 33/33、全量测试 209 文件/1453 passed/1 skipped、全工作区 typecheck 27/27、完整 build 和 `verify:app-recovery` 通过；桌面快捷方式已刷新并完成窗口启动验证。

验收结论：阶段 24 允许模型在严格证据与 Runtime 边界内改善同一 Atom 投影的清晰度，但没有授予模型改写事实、改变认识状态或直接操作存储的权力。下一步应以真实 Provider 和长期负载评估修订提案的准确率、误拒率、重复率与检索收益，再决定事实纠正或更复杂语义重组协议。

### 阶段 25：有证据约束的事实纠正与冲突替代

状态：**已完成首版事实纠正/冲突替代工程闭环；旧 Atom 保留、既有 replacement 投影、完整 D3 KnownState 准入、当前 run 验证证据、显式关系门、原子 supersession、管理读取、响应丢失恢复、幂等重试和超额提案审计均已接通；真实 Provider 的提案质量和跨陈述扩写仍待验收**。

- EVOLVE 输出契约升级为 `evolution-proposal.v5`，新增独立 `corrections` 数组和 `propose_atom_correction` 决策。普通 `memories[].intent=conflict/invalidate` 仍只能进入延期审计，不能旁路修改 Atom；单轮最多接受 1 个纠正提案，额外提案形成有界拒绝记录；
- 提案只能引用两个当前已存在的 Atom：replacement 必须是本轮 adopted、当前 revision、未冲突且未截断的完整 D3；被替代 Atom 必须是本轮 adopted 或 conflicted、当前 revision 且完整 D3。两者必须保持 branch、scope、scopeKey、parent 与 statement kind 一致，模型不能在纠正提案内创建新 Atom；
- 当前 run 必须有通过的 VERIFY 记录和 Runtime evidence。replacement 还必须具备足够权威、置信与可追溯来源；名称、共现、文本相似或向量相似不能证明纠正关系；
- Runtime 只接受方向正确、active、resolved、有来源证据且达到强度门槛的 `replaces` 或 `conflicts-with` 关系。`evidence-backed-correction` 必须使用 `replaces`；`conflict-replacement` 可以使用满足同等证据门的 `conflicts-with`；
- 提交复用 Memory v3 的 supersede 管理事务、投影变更记录、operation journal、commit receipt、revision precondition 和 Catalog 同步。旧 Atom 的正文、来源、证据与历史不被覆盖，只新增指向 replacement 的 supersession 投影并标记为 `superseded`；普通检索继续过滤旧投影，管理与恢复读取可以定位它；
- 提交响应丢失后，相同提案可以读取已 superseded Atom 并返回 `noop`，不会重复提交。该路径不新增独立 LLM 调用、向量查询、后台轮询或全库扫描，只复用 EVOLVE 的结构化提案和本轮 KnownState；
- 用户真正看到的记忆变化说明、执行过程、验证结果和交付表达，每条新消息都必须在本轮实时调用当前 Provider API，由 LLM 结合 `SOUL.md`、用户语言和 Runtime 事实生成。Runtime 不生成候选文案、不从候选池选择，也不在模型不可用时伪造正常 Agent 回复。

验证证据：阶段 25 的 Harness、纯纠正服务和真实 V3 Backend 重启集成专项共 17/17 通过；相邻 Memory/Harness/Runner 回归 76/76 通过，覆盖正常 supersede、conflict replacement、权威/证据/关系方向与强度拒绝、revision 冲突、跨边界拒绝、单轮上限、普通 intent 延期、真实 Catalog/投影记录、响应丢失与 noop 恢复。当前完整质量门为 `check:repo` 33/33、209 个测试文件/1453 passed/1 skipped、全工作区 typecheck 27/27、完整 build 和 `verify:app-recovery` 通过；桌面快捷方式已刷新，并通过该快捷方式确认 `LittleSheep` 窗口可见。

验收结论：阶段 25 允许模型在严格证据与 Runtime 关系边界内声明“哪个既有投影替代哪个旧投影”，但不允许覆盖历史、直接创建事实、跨作用域纠正或绕过验证。工程闭环已经建立；下一步重点是用真实 Provider 和长期负载评估提案准确率、错误替代率、检索收益和纠正后的任务质量。

### 阶段 26：有证据约束的非叶子子树重组

状态：**已完成首版非叶子子树重组工程闭环；Catalog 有界后代统计、完整 D3 KnownState 准入、当前 run VERIFY/evidence 门、方向正确关系门、同 branch/scope 边界、128 active descendant 自动上限、只移动子树根、原子提交、重启恢复、响应丢失 noop 和超额提案审计均已接通；真实 Provider 的提案质量、超大子树人工治理和长期负载收益仍待验收**。

- EVOLVE 契约当前升级为 `evolution-proposal.v6`，新增独立 `subtreeMoves` 数组和 `propose_atom_subtree_move` 决策。普通 `memories[].intent=move` 仍只能进入延期审计，叶子 `reparents` 仍使用独立协议，二者不能旁路子树服务；
- 子树根与目标 parent 必须是本轮 adopted、当前 revision、未冲突、未过期、未截断的完整 D3 KnownState 引用，且保持 branch、scope 和 scopeKey 一致。Runtime 通过方向为根实体 → parent 实体的 active、resolved、有证据 `belongs-to`/`derived-from` 关系证明语义归属；名称、路径、文本相似、向量距离和共现不能替代关系证据；
- V3 Catalog 递归统计 active descendants，查询以 `MAX_SUBTREE_ACTIVE_DESCENDANTS + 1` 截断；子树根必须至少有一个 active descendant，超过 128 个 active descendants 自动拒绝，不能把未知或无界的影响范围交给模型自动搬迁；
- 提交复用 Memory v3 的 move mutation、projection record、operation journal、commit receipt 和 revision precondition，只修改子树根 `parentId`。后代 Atom 的正文、父链、revision、原始对话来源、关系和生命周期保持不变；Storage 层继续负责循环与 tombstone parent 检查；
- 响应丢失后，相同提案依据根 parent/revision 和有界后代检查识别已提交状态并返回 `noop`，不重复移动；本阶段不新增 LLM 调用、向量查询、后台轮询或全库扫描；

验证证据：Catalog、纯子树服务、真实 V3 Backend 重启集成和 EVOLVE 专项共 4 个文件、27/27 通过；相邻 Memory/Harness/Runner 回归 13 个文件、85/85 通过，覆盖非叶子正常移动、后代保持、超限/叶子/缺少检查拒绝、关系方向拒绝、D3/VERIFY/单轮上限、普通 move intent 不旁路、真实 Catalog/投影记录、重启和响应丢失 noop 恢复。完整质量门待本轮最后执行后更新。

验收结论：阶段 26 把“可证明的非叶子语义归属修正”开放为独立、可恢复且有硬规模上限的 Runtime 能力；它不是任意树编辑器，也不代表 LS 已经能在真实 Provider 长期负载下自动可靠重组所有记忆。

## 8. 已确认决策

| 编号 | 决策 | 方案 |
| --- | --- | --- |
| D1 | 记忆粒度 | 按可独立治理的语义原子切割，不按固定字符机械分块 |
| D2 | 层级 | atom 保存稳定 `parentId`，数据库按 parent 查询子级 |
| D3 | 向量库 | 使用应用内置的本地 SQLite 向量目录管理 atom |
| D4 | 权威边界 | 对话原始来源记录用户输入和对话区可见信息；投影变更记录与 append-only commit receipt 负责幂等、恢复和审计；atom 是可治理、可重建投影；catalog 是高效管理索引；journal 只是有界恢复状态 |
| D5 | Embedding | 默认本地生成；远程 Provider Embedding 仅显式选择后允许 |
| D6 | 检索范围 | 先沿层级导航，FTS/向量只在已选择分支或子树内检索 |
| D7 | 用户数据 | 不自动迁移；先完成隔离迁移与故障注入，再单独批准正式切换 |
| D8 | 优先注入 | 层级先限定候选范围；在作用域和预算约束内，按任务匹配、权威、置信度、重要性、新鲜度、已验证 usefulness、routing feedback 和有效关系相关度综合排序 |
| D9 | 防错误强化 | 访问或停留在 Context 不产生正反馈；VERIFY 明确使用只提高 routing usefulness，结构性验证或成功工具证据才能提高 verified usefulness，二者都不能自动提高事实 confidence |
| D10 | 当前已知信息 | 记忆检索结果以证据引用进入 run 级版本化 `KnownState`，DECIDE、EXECUTE、VERIFY、FINALIZE 不使用未登记事实 |
| D11 | 使用衰减 | 长期无验证收益或多次 release 只降低可选记忆的 routing 权重，不降低 confidence；旧影响回归中性，T0、安全规则和当前用户约束不受普通衰减淘汰 |
| D12 | 请求证据 | 注入 LLM 的记忆携带有界 `MemoryEvidenceEnvelope`；Context 可按阶段加入或排除信息，取舍全程可追溯 |
| D13 | 记忆主体 | User、Agent Self、Task/Project/Session、Experience、Knowledge 使用同一 repository，仅以 domain/scope/authority 区分 |
| D14 | 渐进披露 | 所有 domain 统一使用 D0 索引、D1 摘要元数据、D2 正文、D3 来源与审计；D0-D3 与 T0-T3 独立 |
| D15 | 实时更新 | 时间和真实事件生成 `MemoryUpdateEvent`；先持久捕获，再异步幂等归并，失败进入恢复队列 |
| D16 | 不失忆语义 | 保证持久、可发现、可追溯、可恢复和相关时可取回，不以全量常驻 Prompt 实现 |
| D17 | 陈述分类 | instruction/goal、preference/value、reported observation、factual claim、suggestion/hypothesis、decision/approval 分开治理 |
| D18 | 权威边界 | 用户对自身目标、偏好、授权和决定具有权威；客观 claim 仍需证据验证，来源身份不替代 epistemic status |
| D19 | 防错误画像 | 单条错误建议不生成用户能力画像；采纳建议不等于事实已验证，confidence 与 authority scope 独立 |
| D20 | 实体边界 | user/project/file/session/task/skill/tool/rule/concept 等使用稳定、带 owner/scope 的实体 id；同名或相似不自动合并 |
| D21 | 关系语义 | 关系有方向、证据、权威、置信度、相关度、时间与冲突状态；高相关种子只允许在同 branch/scope/subtree 内做一次有界语义扩展；相似度只用于候选导航，不证明事实或触发自动注入 |
| D22 | 应用数据根 | Memory、用户/LS 记忆、Skills 与 catalog 都属于可整体迁移的应用数据根；`workplace/` 仅是默认工作区子目录 |
| D23 | 原始数据 | 原始数据只指用户输入与对话区可见信息；写入后不修改、不合并、不裁剪，纠正通过新的对话来源记录表达；它证明当时收到了或展示了什么，是否为事实由 Atom 认识状态与证据另行判断 |
| D24 | 运行工作集 | 首次用户请求由 Runtime 从 D1 选择少量 D2 atom；执行中由 LLM 通过受控 `expand/deep_search` 决策纳入 atom，或通过 `release` 移出 atom。即时 release 只影响当前 run；run 收尾可生成有界 routing feedback 影响未来排序，但不改事实状态，且可沿索引重新介入 |
| D25 | Atom 演化 | Atom 可在稳定 id、revision、作用域、认识类别和审计约束下去重、合并、调整层级、失效、恢复与重建；所有变化保留来源与证据，不改写对话原始来源 |
| D26 | 动态信号 | confidence 表示陈述可靠性，verified usefulness 表示经验证价值，routing/relationship relevance 表示注入路由价值，importance/basePriority 表示治理优先级；各自分开更新，访问频率不能冒充证据 |
| D27 | 三层视图 | 用户 GUI 只显示六份记忆文件且仅 `SOUL.md` 可写；Runtime 使用完整 Atom/关系/向量结构；LLM 只预载树简介与根索引并按需展开 Atom。后续自我介绍由独立 Skill 承担 |
| D28 | 存储与注入解耦 | 记忆文件放置与物理分层只负责持久化、恢复、人工管理和索引导航；最终注入不读取“路径权重”，而由 Atom 的 task/scope/authority/epistemic/confidence/importance/usefulness/routing/relationship/time/budget 信号决定。Runtime 必须记录哪些 Atom 被发现、采用、排除、释放或重新激活及其理由 |
| D29 | 多轮任务语义 | 当前请求足够时只用当前请求；真实指代才有界继承最近 user/assistant 目标。硬排除对象、与排除方向一致的约束 Atom、任务转向和自足新主题必须分开处理，并由 D1/FTS/向量共用同一任务语义 |
| D30 | 压缩连续性 | 版本化会话摘要只在真实指代且近期消息缺少任务锚点时作为有界回退；当前请求和近期明确目标优先，任务转向阻断旧摘要。摘要不替代原始会话，也不因文件位置获得注入权重 |
| D31 | 关系引导注入 | 关系只帮助发现和排序邻接候选；候选仍须独立通过 task relevance、Atom 状态、scope、证据和预算。必要强关系可在通过独立任务门后进入首次 working set，检索路径和关系证据必须结构化记录 |
| D32 | 写入认识权 | 模型只描述 statement kind、asserted source、domain 和 topics；epistemic status、authority 与 resolution 由 Runtime 根据对话来源、工具证据和 VERIFY 决定。证据不足时降级，不接受模型自证 |
| D33 | 蒸馏边界 | 旧 daily 原文追加到 `MEMORY.md` 的 helper 永久退役；压缩、蒸馏和提升只能形成结构化 Atom 写入并经过统一来源、认识、作用域、revision、审计与恢复闸门。阶段 21 已完成保守的一对一提升；阶段 22 只开放模型提案的重复投影合并，更复杂重组仍由 Runtime 闸门控制 |
| D34 | 注入优先级 | 文件与目录仅负责持久化、恢复、管理和候选导航；Memory 的首要质量指标是 Runtime 能否基于当前任务、作用域、证据、认识状态、时效、验证收益、路由关系和预算，正确决定 Atom 的发现、采用、释放与重新激活 |
| D35 | TaskBook 二次调和 | 首次选择使用原始请求；DECIDE 得到更精确的 TaskBook 后，goal、验收标准与目标步骤作为独立加权锚点再做一次有界补充选择。单次最多 2 Atom/400 tokens、单 run 最多 4 次，重复 query 跳过；新增 Atom 必须同步 working set、KnownState 和访问账本 |
| D36 | 动态激活层级 | 后端 Atom 热度是连续、可衰减且不限制层数的 activation score，不是文件位置、语义 parent、D0-D3 或固定 T0-T3。真实采用并产生价值才升温，长期不用或无帮助逐渐降温；持久记忆与语义缓存共享计算但隔离 namespace/lifecycle，任务相关度始终先于热度。前端只做带滞回的三层只读投影 |
| D37 | 真实负载校准 | 先通过只读、脱敏、有界报告确认 KnownState、显式 Atom 使用与 Provider usage 覆盖充足，再评审 activation 参数。当前正式数据为 `insufficient`；前端三层展示不等于后端三档模型，报告达到 `ready` 也不自动调参 |
| D38 | 质量与资源代理 | 最终 VERIFY、TaskExecution、Provider token 和起止资源快照用于补足真实负载判断；adopted 但未显式使用只是诊断代理，不自动等同误注入或负反馈。所有采样、集合和设备类别有硬上限，旧日志缺字段时保持缺失 |
| D39 | 用户可见表达 | Runtime 提供并约束事实、状态、权限、路径、进度和验证结果；每条新的用户可见 Agent 自然语言必须来自本轮当前 Provider 的实时 API 返回，并结合 `SOUL.md` 与用户语言构思，不存在候选文案池或 Runtime 选稿。发布前在持久化会话级注册表中原子占用规范化回复指纹，覆盖完整历史、重启和并发 run；完全重复时最多重新实时调用两次当前 Provider API。Renderer 只负责呈现与渐进披露，不能把固定前端模板冒充 Agent 人格文案。模型不可用、注册表不可用、空回复或重新生成耗尽时只显示 Runtime 错误/状态 |
| D40 | daily 结构化提升 | 压缩摘要只提供有界来源 run 范围；Runtime 仅从该范围内筛选可提升 daily Atom，先写目标、再按 expected revision 归档源。首版不调用 LLM、不进行多 Atom 语义合并，失败时保留源；后续调和使用独立模型提案与 Runtime 提交协议 |
| D41 | 重复 Atom 调和 | 模型只能对本轮已 adopted、未冲突且 revision 匹配的 KnownState Atom 提出 `duplicate-projection` 合并。Runtime 独立验证作用域、parent、认识边界、确定性语义锚点、冲突/替代关系和恢复状态；单轮最多 2 个提案、每项最多 4 个 source。提交复用原子 merge 事务，部分失败保留未提交 source，重试幂等；同陈述内容修订由 D43 单独治理，事实纠正和任意语义重写仍未授权 |
| D42 | 叶子层级重组 | 只允许模型对本轮 adopted、未冲突、当前 revision 的 D2/D3 叶子 Atom 提出跨 parent 移动；目标 parent 必须在同 branch/scope/scopeKey，且存在方向为 Atom 实体到 parent 实体的 active、resolved、有证据 `belongs-to`/`derived-from` 关系，confidence ≥ 0.75、relevance ≥ 0.5。单轮最多 1 项，超额项必须记录拒绝；Runtime 负责叶子、循环、边界、revision、原子提交、恢复和审计，模型不能直接修改存储，也不能移动非叶子子树或重写正文 |
| D43 | 同陈述内容修订 | 模型每轮最多对 1 个本轮 adopted、当前 revision、未冲突、未截断的完整 D3 KnownState Atom 提出 `same-claim-refinement`。只允许澄清、规范化和去冗余地替换 title/summary/content/retrievalKeys；Runtime 必须有当前 run 的通过验证证据，并独立校验语义保留、检索锚点、硬锚点、长度、revision、提交与恢复。来源、证据、实体/关系、层级、认识状态和生命周期不变；事实纠正、冲突替代和新增陈述使用独立协议 |
| D44 | 事实纠正与冲突替代 | 模型每轮最多对 1 组本轮完整 D3 KnownState Atom 提出 supersede：replacement 必须 adopted，旧 Atom 可以 adopted 或 conflicted；两者保持 branch/scope/scopeKey/parent/statement kind 一致，并精确匹配 revision。Runtime 必须验证当前 run 的通过证据、replacement 权威与来源，以及方向正确、active、resolved、有证据的 `replaces`/`conflicts-with` 关系。提交只把旧 Atom 标记 superseded 并指向既有 replacement，保留旧正文、来源和历史；普通 conflict/invalidate intent、创建新 Atom、覆盖原始数据和跨边界替代均不能旁路该协议 |
| D45 | 非叶子子树重组 | 模型每轮最多对 1 个本轮 adopted、当前 revision、未冲突且未截断的完整 D3 非叶子 Atom 提出 `move-subtree`；目标 parent 同 branch/scope/scopeKey，必须存在方向正确、active、resolved、有证据的 `belongs-to`/`derived-from` 关系。Catalog 只提供有界 active descendant 计数；根至少有 1 个且最多 128 个 active descendants，超过上限或缺少检查自动拒绝/延期。提交只改变根 `parentId`，后代父链、正文、revision、来源与关系不变；Runtime 负责循环、边界、revision、原子提交、恢复和审计，普通 `move` intent 与叶子 reparent 不能旁路该协议 |

## 9. 总完成门槛

- 不再存在随记忆规模线性膨胀的单一权威 `index.json`；
- 每条对话原始来源都有只追加文件、内容哈希和稳定会话/run 归属；每次 Atom 变化都有投影变更记录与 commit receipt；每个记忆 atom 有稳定 id、parent、`sourceRefs`、`evidenceRefs`、状态和独立投影生命周期；
- 经验证的高价值记忆能在匹配作用域内优先注入，排序原因和反馈证据可审计；
- 重复访问不会自动提高可信度，错误、冲突和过期记忆不会形成自增强循环；
- 长期低收益的可选记忆会降低注入频率，强制信息不被误衰减；每次 LLM 请求能看到所用记忆的必要证据元数据；
- 动态激活层级在持久记忆与语义缓存间使用同一有界计算；经验证的高频 Atom 更早进入候选窗口，低频 Atom 退到冷候选但不丢失，无关高频 Atom 不能绕过任务门；
- DECIDE、EXECUTE、VERIFY 和 FINALIZE 可以按当前目标增加或减少 Context 信息，且不丢失权威来源和排除记录；
- 首次请求能在有界预算内自动选择相关 atom；执行中模型可沿索引纳入更多 atom，并可 release 当前无用 atom；即时操作不修改对话原始来源或事实状态，跨 run 只留下有界 routing feedback，目标变化后可重新介入；
- 当前请求充足时不回放历史；多轮指代只继承有界最近目标，任务转向不受旧历史污染，硬排除正文不会因词面命中进入 Context，与排除方向一致的约束 Atom 仍可介入；
- 长会话压缩后，版本化摘要只能在必要时恢复任务锚点；当前目标、任务转向、排除条件和 session scope 不会被旧摘要覆盖，弱相关尾部 Atom 不为填满初始上限而进入 Context；
- 高相关种子可以沿有方向、有证据且同作用域的一跳关系发现必要 Atom；相似、过期、归档、争议、低置信、跨 scope 或无独立任务价值的关系候选不能进入 Context，关系路径可在证据封套和访问账本中审计；
- 用户记忆、LS 自身记忆及其他 domain 都能从 D0/D1 渐进展开到 D2/D3，且 UI、Prompt 与运行时使用同一权威数据；
- 每个有效时间/事件更新先持久捕获，重复消费幂等，故障与重启不会静默丢失；关闭期间的到期项在启动时补偿；
- 已确认记忆具有稳定索引、版本、恢复与备份验证，相关时可以重新取回，不依赖永久注入 Prompt；
- 用户、外部来源和模型的陈述都保留 statement kind、epistemic status、authority scope、asserted by 与 evidence refs；
- 实体边界、所有权和关系可按 D0-D3 查询；跨 scope 不会因名称、路径、共现或向量相似自动合并或传播；
- 用户偏好和决定在其范围内受到尊重，客观事实主张经过验证；建议可被采纳但不会被冒充为事实，错误建议不会自动形成用户能力画像；
- 内置目录可管理层级、FTS、向量、审计和恢复，并能从文件重建；
- 默认断网仍可写入、导航和语义检索记忆；
- Provider 不会在未经明确启用时收到记忆 Embedding 内容；
- v2 用户数据可验证迁移、可中断恢复、可回滚且不丢失；
- 现有 Memory Service、Runner、工具和 UI 行为通过回归；
- 全量测试、typecheck、build、恢复检查和真实窗口验收通过。
