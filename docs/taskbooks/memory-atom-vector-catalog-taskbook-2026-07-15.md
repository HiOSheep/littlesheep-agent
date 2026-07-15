# LittleSheep 原子记忆与内置向量目录任务书 2026-07-15

最后更新：2026-07-16 01:37:16
版本：v2.1
状态：实施中；阶段 0-5 已完成，阶段 6 的同源读取控制面、显式确认登记、启动前迁移、失败恢复与受约束回滚已完成；atom 写管理和正式用户场景验收仍待推进；未迁移正式用户数据

## 1. 目标

把现有集中式记忆文档升级为 Memory v3：

- 一条可独立理解、更新、归档和引用的记忆对应一个原子文件；
- 原子记忆仍属于长期、daily、项目或经验分支，并通过 parent 保持树状层级；
- 内置本地向量目录负责原子文件的登记、层级查询、全文检索、向量检索、状态和一致性管理；
- 记忆读取继续遵守 `root index -> branch index -> hierarchy expansion -> branch-scoped search`；
- 在已导航分支和当前作用域内，经过验证、对当前任务更有价值的记忆优先进入 Context；
- 可选记忆长期没有产生验证价值或对当前决策无用时降低注入权重，Context 在全流程中可以增补也可以收敛；
- 记忆使用反馈必须区分“被访问”与“被验证有用”，防止错误内容因重复出现而自增强；
- 注入 LLM 的记忆必须携带有界证据元数据，让模型能判断来源、层级、置信度、重要性、新鲜度和冲突状态；
- 用户记忆、LS 自身记忆、项目/会话记忆、经验与知识资源统一使用渐进式披露，不建立旁路副本；
- 所有记忆更新由时间和真实事件驱动，先持久捕获、再幂等归并，失败可恢复且不静默丢失；
- 每条记忆区分事实、用户陈述、观察、建议、假设和决定，并保留验证状态与权威范围；
- 记忆中的用户、项目、文件、会话、任务、Skill、工具、规则和概念具有明确实体边界，有向关系按证据和作用域渐进披露；
- 默认 Embedding 在本地生成，不把记忆正文发送到 Provider 的 `/embeddings`；
- 现有用户数据只能通过备份、校验、可恢复迁移和显式批准进入新格式。

本任务不是把任意长文机械切成固定字符块。原子化的依据是语义所有权：一项事实、偏好、决策、经验、约束或可复用方法应能独立理解，并拥有独立来源和生命周期。

## 2. 当前实现差距

当前 Memory v2 已具备分支、parent、tier、scope、索引优先读取、资源注册和写入闸门，但仍有七项结构性差距：

1. `memory-tree/index.json` 同时保存全部节点、资源、审计和恢复队列，单文件会随记忆增长而扩大；
2. `packages/vector` 的 SQLite 数据库位于本地，但向量通过当前 LLM Client 的 `/embeddings` 生成，并固定使用 `text-embedding-3-small`；
3. 旧 `VectorIndexedMemoryStore` 与新的 `MemoryRepository` 是两条并存路径，向量目录没有成为原子记忆文件的统一管理索引。
4. 用户记忆、LS 自身记忆、项目/会话记忆和知识资源尚未拥有统一的 domain 与 D0-D3 渐进披露契约。
5. 写入仍缺少统一的 `MemoryUpdateEvent` journal、时间 due index、幂等归并和启动补偿协议，不能宣称所有记忆都能近实时更新且失败不丢。
6. 用户、外部资料和模型产生的事实主张、建议、偏好与决定尚无统一 epistemic schema，存在把“有人建议”误当成“事实成立”的风险。
7. 实体身份、所有权边界和关系尚未形成统一 schema；名称、路径、向量相似或共现可能被误当成同一对象或已验证关系。

因此，正式运行路径当前仍不能宣称已经切换到“原子文件 + 层级 + 完全本地向量管理”；该能力已在隔离的 Memory v3 阶段 0-5 完成数据层、统一 facade、安全迁移工具、检索路径和 KnownState 接线，阶段 6 已接通同源 D0-D3 读取控制面与只读迁移预检，尚待正式迁移执行协议、atom 写管理、用户批准和真实用户场景验收。

## 3. Memory v3 数据模型

### 3.1 原子记忆文件

每个原子文件至少包含：

```text
version
id
domain
branch
parentId
scope / scopeKey
tier
statementKind / epistemicStatus / authorityScope
assertedBy / evidenceRefs
entityRefs / relationRefs
title
summary
content
retrievalKeys
importance / confidence / basePriority
verifiedUsefulness / feedbackRevision
lastUsefulAt / lastVerifiedAt
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
- `basePriority` 是可审计的基础治理值，不等于最终注入顺序；最终顺序由当前任务、作用域、来源、状态和已验证使用反馈动态派生；
- `verifiedUsefulness` 只保存有界、可重建的验证反馈摘要，`feedbackRevision` 防止旧反馈覆盖新状态；详细证据进入受限审计记录，不把无限增长的访问历史塞进 atom；
- `lastUsefulAt` 只在有验证收益时更新；由它派生的衰减只降低可选候选的注入权重，不改写事实 confidence，不作用于 T0、安全规则和当前用户约束；
- 单纯读取 atom 不得修改 `confidence`、`importance` 或 `basePriority`；只有用户确认或带工具/VERIFY 证据的成功使用才允许强化；
- 原始文档、附件和项目文件仍是资源，不应为了进入向量库而复制成大量记忆 atom；
- 写入使用临时文件、刷盘和同卷原子 rename，不允许原地截断覆盖。

建议目录：

```text
memory-tree/
  v3/
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

### 3.2 内置向量目录

`catalog.sqlite` 是 Memory Repository 的本地操作目录，至少包含：

- `atoms`：atom id、文件路径、branch、parent、scope、tier、状态、哈希和时间；
- `atom_fts`：标题、摘要、正文与 retrieval keys 的本地全文索引；
- `atom_vectors`：atom id、embedding 版本、维度和向量；
- `atom_access`：访问时间、run、stage、检索路径、命中原因和是否进入 Context；
- `atom_feedback`：从 atom 的验证反馈摘要和受限审计事件生成的查询投影，包含有用/无帮助/冲突/过期结果、证据引用、衰减后的 usefulness 和最近验证时间；
- `memory_events`：已持久捕获事件的查询投影、处理状态、目标版本、幂等键、重试和恢复位置；权威 pending 事件仍在可恢复 event journal；
- `memory_due`：按 effective、expiry、revalidation 和 usefulness decay 时间定位到期 atom，避免全库轮询；
- `evidence_links`：atom/claim 与工具结果、用户原话、文档版本、执行步骤和 VERIFY 结果之间的可追溯关系；
- `entities`：实体 id、类型、owner、scope、稳定外部键、状态、别名和版本；
- `relations`：有向实体关系、作用域、来源、证据、置信度、权威范围、相关度、有效/过期时间、冲突和解析状态；
- `operations`：跨文件系统与 SQLite 更新的恢复日志；
- `audit`：写入、合并、移动、归档、失效、删除和重建证据。

Memory Repository 是唯一写入入口。原子文件保存可审计内容、最小重建元数据和有界验证反馈摘要，SQLite 负责高效管理和查询；访问明细与审计事件按容量和保留期治理。数据库属于可重建索引：损坏或删除后，可以扫描 atom 文件、校验哈希和 parent 引用并重建目录与当前优先级基线；不能让数据库成为无法恢复的唯一记忆副本。

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
- 分支内候选稳定排序至少考虑 scope/项目匹配、来源权威、任务相关性、confidence、importance、basePriority、新鲜度、已验证 usefulness 与冲突/失效/过期惩罚；排序明细必须可审计。
- `accessCount` 只能用于访问统计和缓存优化，不能直接提高 confidence 或注入优先级；正向反馈必须绑定用户确认，或绑定真实工具证据与成功 VERIFY。
- Memory Repository 向 Context Engine 返回证据引用和优先级明细，由 run 级 `KnownState` 记录本轮实际采用、拒绝和仍冲突的记忆；后续阶段不能依赖未登记的记忆内容。
- 可选候选按最后验证收益和策略配置执行时间衰减；衰减后仍可通过强 scope 匹配、新证据、用户点选或索引导航重新激活。低频不等于错误，衰减不能自动改变 confidence、归档或删除 atom。
- 实际注入使用 `MemoryEvidenceEnvelope`，只携带本次判断需要的 atom 引用、branch/scope、tier、来源/权威、confidence、importance、验证/更新时间、新鲜度、命中理由、状态、冲突与截断信息；完整访问历史不进入 Prompt。

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

1. 把带 event id、idempotency key、domain/scope、来源时间、观察时间、证据和期望 atom 版本的 `MemoryUpdateEvent` 原子写入 event journal；
2. 解析事件并写入带 operation id 的 pending 记录；
3. 在版本前置条件下原子创建、合并或替换 atom 文件；
4. 在 SQLite 事务中更新目录、FTS、向量状态、due index 和审计；
5. 校验文件哈希、事件 revision 与数据库记录；
6. 标记 operation 与 event committed；
7. 启动时幂等重放未完成事件，或回滚未完成 operation 后重新归并。

事件来源至少覆盖用户新增/纠正、任务状态、工具与 VERIFY 证据、项目/受管资源变化、LS 能力和配置变化、冲突处理、权限决定，以及 effective/expiry/revalidation/decay 时间到达。主任务只有在事件已持久捕获后才能把记忆更新显示为“已记录”；atom 归并可以在不阻塞回复的有界后台流程中完成。

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
- 增加“重复访问不自动强化”“只有验证成功才产生正向反馈”“低收益可选记忆按策略衰减”“T0/安全/当前约束不被普通衰减淘汰”“冲突/过期记忆不优先注入”的特征测试。
- 增加“所有 domain 使用 D0-D3”“事件先持久再确认”“重复事件幂等”“崩溃后重放”“关闭期间到期项启动补偿”的特征测试。
- 增加“用户目标/偏好具有范围内权威”“用户技术主张仍待验证”“采纳建议不等于事实验证”“错误建议不生成用户能力画像”“外部权威来源仍保留版本和适用范围”的特征测试。

验收：新契约不改变当前运行数据；旧路径有完整行为基线。

### 阶段 1：Atom Store

状态：**已完成隔离实现**。Atom 使用 branch + SHA-256 shard 路径、稳定 id、轻量常驻 header、按需正文读取、内容哈希、修订前置条件、同卷临时文件/刷盘/rename、parent/作用域/循环校验和损坏/孤儿隔离；event 与 operation journal 具备幂等键、三态恢复、记录/数量硬上限。隔离测试分别覆盖 CRUD、归档/恢复与 10,000 atom 重启扫描，未读取或迁移正式用户目录。

- 实现分片路径、原子读写、哈希、状态管理和损坏隔离；
- 实现 parent 校验、循环检测、孤儿恢复和目录扫描；
- 实现分片 event journal、事件幂等键、版本前置条件和 pending/committed/recovery 生命周期；
- 所有测试使用隔离数据目录。

验收：一万 atom 的创建、读取、更新、归档和重启扫描保持有界且不丢层级。

### 阶段 2：Catalog 与本地 Embedding

状态：**已完成隔离实现与真实离线验收**。

- 已完成：可删除重建的 `node:sqlite` catalog、FTS5、branch/scope/subtree 强制过滤、向量 BLOB 与版本状态、访问/反馈有界保留、due index、事件/操作投影、实体/有向关系边界、数据库完整性检查和流式重建；
- 已完成：`MemoryV3StorageCoordinator` 强制执行“事件捕获 → 操作登记 → atom 写入 → catalog 投影 → 双提交”，故障注入覆盖只捕获事件和 atom 已写/catalog 未写两种中断点；
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
- 已完成：26 项迁移测试覆盖全部 9 个声明断电点、预检和中途 ENOSPC、损坏 JSON、损坏节点、孤儿 parent、重复 id、快照后 v2 变化、v3 写入后拒绝回滚、模型不可用、重启恢复、请求合并/取消、回滚后重新迁移和旧 v3 保留；
- 已完成：应用只在用户确认登记后，于下一次启动的 Runner、Local App API、渠道插件、SQLite 和 Embedding 写入者创建前执行迁移或回滚；locator 是 backend 权威，配置在运行时创建前与 locator 自动对齐；
- 正式用户数据仍保持 v2；具备正式迁移入口不等于已经替用户切换，实际切换仍由用户在管理 UI 中明确确认并重启。

验收：已通过。隔离故障注入下不存在节点丢失、双写分叉或不可恢复切换；本结论不代表已迁移正式用户数据。

### 阶段 5：检索路径统一

状态：**已完成隔离实现与完整工程验证**。

- 已完成：`memory_tree`、`memory_search` 和 `memory_deep_search` 统一使用 repository retrieval facade；v3 依次执行层级导航、分支/作用域/子树过滤、FTS、本地向量候选、优先级排序和关系邻域展开；
- 已完成：Runner 不再创建 `VectorIndexedMemoryStore`、`SemanticDailyBranch` 或运行时 `VectorStore`，默认 Provider Embedding 旁路已退役；v3 本地模型由显式动态加载和 shutdown 释放管理；
- 已完成：branch/subtree filter、分支/run token 预算、去重、访问账本和取消信号贯穿检索路径，向量搜索不能绕过已导航边界；
- 已完成：候选优先级、`MemoryEvidenceEnvelope` 与版本化 run 级 `KnownState` 已接入 Harness。DECIDE、EXECUTE、VERIFY 和 FINALIZE 可追溯采用、排除、冲突、重新激活、状态版本和实际介入 Context 的 token；
- 已完成：statement kind、epistemic status、authority scope、asserted by 与 evidence refs 会投影给模型；VERIFY 明确拒绝把 suggestion、reported observation 或 unverified claim 当作 verified fact 交付；
- 已完成：D0-D3 使用同一份 atom/catalog 渐进展开，Prompt 与运行时不建立记忆正文副本；Context 只展开当前目标需要的关系邻域；
- 已完成：成功写入后的本地向量维护可等待、单批有界、并发合并且失败不回滚 atom，长期运行不再依赖重启补齐新记忆向量；
- 已验证：仓库卫生 31/31、27 个 workspace 类型检查、145 个测试文件中的 1136 项通过且 1 项按预期跳过、Electron main/preload/renderer 构建和应用恢复源检查通过。

验收：已通过隔离工程验收。网络被阻断时记忆写入和检索正常，向量搜索不能绕过层级导航；同一作用域内经验证且相关的记忆稳定优先介入，单纯重复访问不能形成错误自增强。该结论不代表正式用户数据已经迁移。

### 阶段 6：管理 UI 与真实迁移

状态：**进行中；同源读取控制面、正式迁移生命周期和恢复/回滚控制已完成，atom 写管理与真实用户场景验收尚未完成**。

- 已完成：`/memory/tree` 只传输 D0/D1 概况与摘要，不再一次性返回记忆正文、完整来源和历史；D2 正文/认识状态与 D3 证据、命中、管理历史、事件时间线、实体和关系邻域均按节点请求展开；
- 已完成：v3 节点详情直接来自同一 `MemoryRepository`、atom 和 Catalog；独立 `management` facade 提供目录状态与节点检查，不建立 UI 展示副本，也不扩大 Repository 主 facade；
- 已完成：详情请求支持取消，Renderer 卸载时中止在途请求，详情缓存硬限制为 24 条，避免请求和缓存无界增长；
- 已完成：设置页“迁移与目录”展示只读预检，包括 v2 源文件/节点/资源数量、数据大小、所需与可用空间、当前 backend、pending phase，以及恢复/回滚可用性；预检不创建 locator、snapshot 或 staging；
- 已完成：设置页通过显式确认登记迁移或回滚，运行中的 API 只持久化请求、不执行结构性变更；用户可在重启前取消请求，失败进入可见 recovery，并可重启恢复或在安全边界内取消；
- 已完成：“登记请求 -> 应用重启 -> 数据根准备 -> Memory v3 迁移/回滚 -> 配置对齐 -> Runner -> Local App API -> 渠道插件”的启动前执行协议；迁移不与活动 Agent run、渠道、Repository、SQLite 或 Embedding 写入竞争；
- 已完成：迁移失败继续使用 v2；回滚失败继续使用 v3。只有 v2 源和 v3 validation hash 均未变化时才允许回滚，回滚后的重新迁移会保留旧 v3 后从最新 v2 重建；
- 待完成：用户移动、合并、失效、恢复和导出 atom 的写管理能力，以及隔离长时间运行和正式用户场景验收。

验收：读取控制面与迁移生命周期已通过定向类型检查和故障/重启/并发测试；UI 管理运行时同一份 atom/catalog，不建立展示副本。完整阶段验收仍要求补齐 atom 写管理、隔离长时间运行、正式用户场景，并由用户单独批准实际数据切换。

## 8. 已确认决策

| 编号 | 决策 | 方案 |
| --- | --- | --- |
| D1 | 记忆粒度 | 按可独立治理的语义原子切割，不按固定字符机械分块 |
| D2 | 层级 | atom 保存稳定 `parentId`，数据库按 parent 查询子级 |
| D3 | 向量库 | 使用应用内置的本地 SQLite 向量目录管理 atom |
| D4 | 权威边界 | Memory Repository 统一提交；atom 文件可审计、可重建，数据库是高效管理索引 |
| D5 | Embedding | 默认本地生成；远程 Provider Embedding 仅显式选择后允许 |
| D6 | 检索范围 | 先沿层级导航，FTS/向量只在已选择分支或子树内检索 |
| D7 | 用户数据 | 不自动迁移；先完成隔离迁移与故障注入，再单独批准正式切换 |
| D8 | 优先注入 | 在层级、作用域和预算约束内，按相关性、权威、置信度、重要性、新鲜度和已验证 usefulness 综合排序 |
| D9 | 防错误强化 | 访问次数不等于正确；只有用户确认或工具证据加成功 VERIFY 才能产生正向强化 |
| D10 | 当前已知信息 | 记忆检索结果以证据引用进入 run 级版本化 `KnownState`，DECIDE、EXECUTE、VERIFY、FINALIZE 不使用未登记事实 |
| D11 | 使用衰减 | 长期无验证收益只降低可选记忆的注入权重，不降低 confidence，不作用于 T0、安全规则和当前用户约束 |
| D12 | 请求证据 | 注入 LLM 的记忆携带有界 `MemoryEvidenceEnvelope`；Context 可按阶段加入或排除信息，取舍全程可追溯 |
| D13 | 记忆主体 | User、Agent Self、Task/Project/Session、Experience、Knowledge 使用同一 repository，仅以 domain/scope/authority 区分 |
| D14 | 渐进披露 | 所有 domain 统一使用 D0 索引、D1 摘要元数据、D2 正文、D3 来源与审计；D0-D3 与 T0-T3 独立 |
| D15 | 实时更新 | 时间和真实事件生成 `MemoryUpdateEvent`；先持久捕获，再异步幂等归并，失败进入恢复队列 |
| D16 | 不失忆语义 | 保证持久、可发现、可追溯、可恢复和相关时可取回，不以全量常驻 Prompt 实现 |
| D17 | 陈述分类 | instruction/goal、preference/value、reported observation、factual claim、suggestion/hypothesis、decision/approval 分开治理 |
| D18 | 权威边界 | 用户对自身目标、偏好、授权和决定具有权威；客观 claim 仍需证据验证，来源身份不替代 epistemic status |
| D19 | 防错误画像 | 单条错误建议不生成用户能力画像；采纳建议不等于事实已验证，confidence 与 authority scope 独立 |
| D20 | 实体边界 | user/project/file/session/task/skill/tool/rule/concept 等使用稳定、带 owner/scope 的实体 id；同名或相似不自动合并 |
| D21 | 关系语义 | 关系有方向、证据、权威、置信度、相关度、时间与冲突状态；相似度只用于候选导航，不证明事实 |
| D22 | 应用数据根 | Memory、用户/LS 记忆、Skills 与 catalog 都属于可整体迁移的应用数据根；`workplace/` 仅是默认工作区子目录 |

## 9. 总完成门槛

- 不再存在随记忆规模线性膨胀的单一权威 `index.json`；
- 每个记忆 atom 有稳定 id、parent、来源、状态和独立生命周期；
- 经验证的高价值记忆能在匹配作用域内优先注入，排序原因和反馈证据可审计；
- 重复访问不会自动提高可信度，错误、冲突和过期记忆不会形成自增强循环；
- 长期低收益的可选记忆会降低注入频率，强制信息不被误衰减；每次 LLM 请求能看到所用记忆的必要证据元数据；
- DECIDE、EXECUTE、VERIFY 和 FINALIZE 可以按当前目标增加或减少 Context 信息，且不丢失权威来源和排除记录；
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
