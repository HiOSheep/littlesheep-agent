# @littlesheep/memory-core

最后更新：2026-09-22 12:47:49

提供文件型记忆的兼容存储、共享原子写入基元、写入安全策略和旧来源适配。

## 职责与边界

- 公开入口是 `src/index.ts`；实际被最多消费的是 `atomic-write.ts`（`atomicWrite`，tmp + 同卷 rename），被 App 主进程、memory-tree 文档/投影写入、harness 缓存观测和 experience 索引共用；`store.ts` 是兼容的 `MemoryStore`（`MEMORY.md` + `memory/YYYY-MM-DD.md`），`prelude.ts`（`buildRecentPrelude`）和 `search.ts`（`searchMemory`/`isRipgrepAvailable`）是旧 prelude 与 ripgrep 检索适配，`write-memory.ts` 只提供遗留的 `write_memory` AgentTool 工厂 `createWriteMemoryTool`——当前没有任何 runtime 装配它，模型也没有可用的记忆写入工具。
- `MemoryStore` 现在只被 Runner 装配为未完成旧迁移时的兼容读取分支，以及 CLI 的记忆命令使用；memory-tree 只使用 `atomicWrite`。
- memory-tree / Memory Service 只消费 `atomicWrite`；本包不负责树形导航 UI、项目投影或 Context 选择。
- 禁止新增绕过 `@littlesheep/memory-tree` 注册和审计的新主运行时写入路径。
- 旧 `daily -> MEMORY.md` 原文追加、月/年 Markdown 摘要和独立远程向量维护入口均已退役；未来 daily 提升或压缩只能生成结构化 Memory v3 写入提案，并经过来源、认识状态、去重、审计和恢复校验。

## 依赖与数据

- 依赖安全和公共契约，不拥有 Provider 调用或向量目录（`package.json` 只声明 `@littlesheep/safety` 与 `@littlesheep/types`）。
- 拥有其文件格式的原子写入与备份语义；用户可见权威索引由 Memory Service 协调。

## 测试与修改定位

- 存储与写入测试和实现同目录（`src/store.test.ts`、`src/write-memory.test.ts`）；`write-memory.test.ts` 同时覆盖 `atomicWrite` 的并发与原子性。
- 修改兼容层必须验证迁移边界，不能重新导出扁平追加、月/年摘要或独立向量 helper，也不能静默改写正式用户数据。
