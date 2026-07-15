# LittleSheep 原子记忆与内置向量目录任务书 2026-07-15

最后更新：2026-07-15
版本：v1.0
状态：目标架构已确认，待按阶段实施；本任务书不会自动迁移正式用户数据

## 1. 目标

把现有集中式记忆文档升级为 Memory v3：

- 一条可独立理解、更新、归档和引用的记忆对应一个原子文件；
- 原子记忆仍属于长期、daily、项目或经验分支，并通过 parent 保持树状层级；
- 内置本地向量目录负责原子文件的登记、层级查询、全文检索、向量检索、状态和一致性管理；
- 记忆读取继续遵守 `root index -> branch index -> hierarchy expansion -> branch-scoped search`；
- 默认 Embedding 在本地生成，不把记忆正文发送到 Provider 的 `/embeddings`；
- 现有用户数据只能通过备份、校验、可恢复迁移和显式批准进入新格式。

本任务不是把任意长文机械切成固定字符块。原子化的依据是语义所有权：一项事实、偏好、决策、经验、约束或可复用方法应能独立理解，并拥有独立来源和生命周期。

## 2. 当前实现差距

当前 Memory v2 已具备分支、parent、tier、scope、索引优先读取、资源注册和写入闸门，但仍有三项结构性差距：

1. `memory-tree/index.json` 同时保存全部节点、资源、审计和恢复队列，单文件会随记忆增长而扩大；
2. `packages/vector` 的 SQLite 数据库位于本地，但向量通过当前 LLM Client 的 `/embeddings` 生成，并固定使用 `text-embedding-3-small`；
3. 旧 `VectorIndexedMemoryStore` 与新的 `MemoryRepository` 是两条并存路径，向量目录没有成为原子记忆文件的统一管理索引。

因此，当前不能宣称已经实现“原子文件 + 层级 + 完全本地向量管理”。

## 3. Memory v3 数据模型

### 3.1 原子记忆文件

每个原子文件至少包含：

```text
version
id
branch
parentId
scope / scopeKey
tier
title
summary
content
retrievalKeys
importance / confidence
reason
sourceRunIds / sourceStages
status
createdAt / updatedAt
contentHash
```

约束：

- `id` 创建后不因标题、父级、项目路径或文件路径变化而改变；
- `parentId` 是层级权威字段，子节点列表由目录查询生成，不在多个文件中重复维护；
- 一个 atom 只保存一个可独立治理的记忆语义；多个来源可以强化同一 atom，不应重复创建近义文件；
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
    backups/
```

分片只服务于文件系统规模，不代表记忆层级；真实层级由 `parentId` 和目录数据库共同表达。

### 3.2 内置向量目录

`catalog.sqlite` 是 Memory Repository 的本地操作目录，至少包含：

- `atoms`：atom id、文件路径、branch、parent、scope、tier、状态、哈希和时间；
- `atom_fts`：标题、摘要、正文与 retrieval keys 的本地全文索引；
- `atom_vectors`：atom id、embedding 版本、维度和向量；
- `operations`：跨文件系统与 SQLite 更新的恢复日志；
- `audit`：写入、合并、移动、归档、失效、删除和重建证据。

Memory Repository 是唯一写入入口。原子文件保存可审计内容与最小重建元数据，SQLite 负责高效管理和查询。数据库属于可重建索引：损坏或删除后，可以扫描 atom 文件、校验哈希和 parent 引用并重建目录；不能让数据库成为无法恢复的唯一记忆副本。

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

## 4. 本地 Embedding

- 默认使用随应用提供的本地多语言 Embedding Engine，覆盖中文、英文和代码/技术文本；
- Provider `/embeddings` 默认关闭，只能在用户明确启用远程 Embedding 时作为可选实现；
- Embedding Engine 通过版本化接口接入，记录 engine id、model id、维度和内容哈希；
- 更换模型时后台分批重建向量，不阻塞文件读取和层级导航；
- 模型选择通过代表性中文偏好、项目决策、代码经验和混合语言查询基准确定，兼顾召回质量、安装体积、内存和首轮延迟；
- 初始候选优先评估量化的 `multilingual-e5-small` 与 `bge-small-zh-v1.5`，不在没有基准证据时锁定最终模型。

即使本地 Embedding 不可用，层级索引和 FTS 仍必须正常工作，不能让向量能力成为记忆系统的单点故障。

## 5. 一致性与恢复

文件系统和 SQLite 不能依靠一个普通事务同时提交，因此每次变更使用可恢复操作日志：

1. 写入带 operation id 的 pending 记录；
2. 原子创建或替换 atom 文件；
3. 在 SQLite 事务中更新目录、FTS、向量状态和审计；
4. 校验文件哈希与数据库记录；
5. 标记 operation committed；
6. 启动时重放或回滚未完成 operation。

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

- 定义 `MemoryAtom`、`MemoryCatalogEntry`、`EmbeddingEngine` 和 operation journal v1；
- 冻结 v2 行为特征：层级、写入闸门、项目重绑定、资源注册和 UI 管理；
- 增加“默认禁止远程 Embedding”的网络出口测试。

验收：新契约不改变当前运行数据；旧路径有完整行为基线。

### 阶段 1：Atom Store

- 实现分片路径、原子读写、哈希、状态管理和损坏隔离；
- 实现 parent 校验、循环检测、孤儿恢复和目录扫描；
- 所有测试使用隔离数据目录。

验收：一万 atom 的创建、读取、更新、归档和重启扫描保持有界且不丢层级。

### 阶段 2：Catalog 与本地 Embedding

- 建立 SQLite catalog、FTS、向量接口和恢复日志；
- 接入本地 Embedding Engine 并完成候选模型基准；
- 建立模型升级、向量失效和后台重建机制。

验收：断网时层级、FTS 和向量检索均可运行；数据库删除后可从 atom 文件完整重建。

### 阶段 3：Memory Repository v3 适配

- 让现有 facade 在 feature flag 下读写 v3；
- 保持 Memory Service、Runner、Harness、工具和 UI 公共接口兼容；
- 去重、合并、冲突、失效和项目重绑定只走统一 repository transaction。

验收：现有 Memory Tree 契约测试在 v2/v3 两种后端均通过。

### 阶段 4：安全迁移

- 实现 v2 快照、atom 生成、目录构建、校验、切换和回滚；
- 覆盖断电点、磁盘不足、损坏节点、孤儿 parent、重复 id 和模型不可用；
- 正式用户数据仍保持 v2，直到单独批准。

验收：故障注入下不存在节点丢失、双写分叉或不可恢复切换。

### 阶段 5：检索路径统一

- 将 `memory_tree`、`memory_search` 和 `memory_deep_search` 统一到 v3 catalog；
- 退役 `VectorIndexedMemoryStore` 的 Provider Embedding 路径；
- 强制 branch/subtree filter、预算、去重和访问账本。

验收：网络被阻断时记忆写入和检索正常，向量搜索不能绕过层级导航。

### 阶段 6：管理 UI 与真实迁移

- UI 展示 atom、父级、来源、向量状态、冲突、归档和重建进度；
- 用户可以移动、合并、失效、恢复和导出 atom；
- 在用户批准后迁移正式数据并完成重启、回滚和长时间运行验收。

验收：UI 管理的就是运行时同一份 atom 和 catalog，不建立展示副本。

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

## 9. 总完成门槛

- 不再存在随记忆规模线性膨胀的单一权威 `index.json`；
- 每个记忆 atom 有稳定 id、parent、来源、状态和独立生命周期；
- 内置目录可管理层级、FTS、向量、审计和恢复，并能从文件重建；
- 默认断网仍可写入、导航和语义检索记忆；
- Provider 不会在未经明确启用时收到记忆 Embedding 内容；
- v2 用户数据可验证迁移、可中断恢复、可回滚且不丢失；
- 现有 Memory Service、Runner、工具和 UI 行为通过回归；
- 全量测试、typecheck、build、恢复检查和真实窗口验收通过。
