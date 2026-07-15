# Memory Repository 内部边界

本目录实现 `MemoryRepository` facade 背后的持久层基元，不是新的公开 API。

- `document-store.ts`：文档版本、v1→v2 迁移、原子持久化、损坏备份和实例级串行写锁。
- `resource-store.ts`：资源注册组、生命周期、来源冲突校验和资源审计。
- `node-store.ts`：节点查询、管理、恢复队列和迁移标记。
- `write-policy.ts`、`intent-writer.ts`：写入规范化、安全闸门、去重/合并和父索引刷新。
- `project-rebinding.ts`：节点、恢复队列和资源的一次原子项目路径重绑定。
- `write-service.ts`：写入后失效通知的应用服务。

外部调用继续使用 `../memory-repository.ts`。修改持久化格式必须增加版本化迁移和回滚测试；任何资源或节点写入必须经过同一个 `MemoryDocumentStore.update()`，不得另建并发写路径。
