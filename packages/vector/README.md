# @littlesheep/vector

最后更新：2026-09-22 12:47:49

保留 Memory v2 本地向量数据库的兼容类型、读取与测试实现。当前 Memory v3 Runtime 不再装配或写入该存储；新的 Atom Embedding 由 `@littlesheep/memory-tree` 内的本地 Catalog 统一管理。

## 职责与边界

- 公开入口是 `src/index.ts`；类型在 `types.ts`，兼容实现在 `vector-store.ts`。
- 当前没有任何生产包导入它，`packages/tools` 只保留一条未被使用的 workspace 依赖声明；不得由 Runner、Harness、Memory Core 或 CLI 注册为写入权威（`check:repo` 同时禁止 CLI tsconfig 引用本包）。
- 仅用于读取或验证既有 v2 数据。
- v2 向量结果不能直接进入 Context，也不能创建、更新或提升 Memory v3 Atom。

## 依赖与数据

- 兼容实现仍依赖旧 LLM embedding 接口；生产 Runtime 不应构造它。
- 既有向量数据库只是可再生派生数据，权威正文与 Memory v3 状态不在此包。

## 测试与修改定位

- 存储、排序和边界行为测试位于 `src/vector-store.test.ts`。
- 修改兼容读取时必须保持旧数据库可读，并证明不会恢复写入装配路径。
