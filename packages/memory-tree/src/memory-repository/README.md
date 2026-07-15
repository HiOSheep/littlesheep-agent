# Memory Repository 内部边界

最后更新：2026-07-15 20:46:57

本目录实现 `MemoryRepository` 稳定 facade 背后的版本后端与持久化基元，不是新的平行公开 API。

## 日常运行路径

- `factory.ts`、`v2-backend.ts`、`v3-backend.ts`：后端选择、失败关闭闸门和稳定接口适配。
- `document-store.ts`、`node-store.ts`、`resource-store.ts`：Memory v2 文档、节点、资源、审计和串行持久化。
- `v3-node-store.ts`、`v3-resource-store.ts`、`v3-ledger.ts`：Memory v3 节点/资源投影、分片兼容账本、scope alias 和事务恢复。
- `v3-statement.ts`、`v3-node-mapping.ts`、`v3-node-transitions.ts`：认识状态分类、稳定实体映射和生命周期转换。
- `write-policy.ts`、`intent-writer.ts`、`write-service.ts`：写入规范化、安全闸门、去重/合并和缓存失效。

## 安全迁移路径

- `repository-locator.ts`：活动后端和待处理迁移的原子版本 locator。
- `v3-migration-source.ts`：直接只读原始 v2 文件、严格校验和完整哈希 snapshot。
- `v3-migration-mapping.ts`、`v3-migration-build.ts`、`v3-migration-ledger.ts`：保留稳定 ID、层级、资源和兼容账本的 staging 构建。
- `v3-migration-validation.ts`：逐节点、资源、审计、Graph、Atom Store 和 Catalog 完整性校验。
- `v3-migration-commit.ts`、`v3-migration-files.ts`、`v3-migration.ts`：ownership 边界、同卷原子提交、故障恢复和防数据丢失回滚。

迁移模块只对显式调用生效，不在 Runner 或应用启动时自动执行。正式用户数据仍由 v2 管理，直到用户单独批准阶段 6 切换。
