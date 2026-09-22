# Memory Repository 内部边界

最后更新：2026-09-22 12:47:49

本目录实现 `MemoryRepository` 稳定公共接口背后的版本后端与持久化基元，不是新的平行公开 API。

## 日常运行路径

- `factory.ts`、`v2-backend.ts`、`v3-backend.ts`、`backend.ts`、`contracts.ts`：后端选择、安全校验和稳定接口适配。
- `document-store.ts`、`node-store.ts`、`resource-store.ts`、`management.ts`、`retrieval.ts`、`retrieval-facade.ts`：Memory v2 文档、节点、资源、审计、串行持久化与检索门面。
- `v3-node-store.ts`、`v3-resource-store.ts`、`v3-ledger.ts`、`v3-retrieval.ts`、`v3-retrieval-activation.ts`、`v3-retrieval-materializer.ts`、`v3-retrieval-relations.ts`：Memory v3 节点/资源投影、分片兼容账本、scope alias、事务恢复，以及 branch/scope 受限检索与激活物化。
- `v3-atom-management.ts`、`v3-feedback-manager.ts`、`project-rebinding.ts`：Atom 生命周期管理、经校验的运行反馈回写和项目路径原子重绑定。
- `v3-statement.ts`、`v3-node-mapping.ts`、`v3-node-transitions.ts`：认识状态分类、稳定实体映射和生命周期转换。
- `write-policy.ts`、`intent-writer.ts`、`write-service.ts`：写入规范化、安全策略校验、去重/合并和缓存失效。

## 安全迁移路径

- `repository-locator.ts`：活动后端和待处理迁移的原子版本 locator。
- `v3-migration-preflight.ts`、`v3-migration-contracts.ts`、`v3-migration-operation.ts`：只读迁移就绪预检（不创建 locator/snapshot/staging）、迁移公共契约和串行化迁移/回滚请求队列。
- `v3-migration-source.ts`：直接只读原始 v2 文件、严格校验和完整哈希 snapshot。
- `v3-migration-mapping.ts`、`v3-migration-build.ts`、`v3-migration-ledger.ts`：保留稳定 ID、层级、资源和兼容账本的 staging 构建。
- `v3-migration-validation.ts`、`v3-migration-validation-state.ts`：逐节点、资源、审计、Graph、Atom Store 和 Catalog 完整性校验，以及已初始化 v3 与迁移源的一致性校验。
- `v3-migration-commit.ts`、`v3-migration-files.ts`、`v3-migration.ts`：ownership 边界、同卷原子提交、故障恢复和防数据丢失回滚。

迁移请求只由显式控制面登记，真正的迁移或回滚在下一次应用启动、任何写入者初始化之前执行。正式活动后端已经切换为 v3；v2 源、迁移 snapshot 和兼容读取只用于校验、审计及满足防数据丢失条件时的受约束回滚，不能继续接收新正式写入。
