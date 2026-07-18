# @littlesheep/session

管理 JSONL 会话、文件锁、用户可见回复指纹和非破坏式长会话摘要。

## 职责与边界

- 公开入口是 `src/index.ts`；`manager.ts` 管理会话，`lock.ts` 管理并发，`reply-fingerprint-store.ts` 负责跨重启、并发安全的回复精确去重，`compaction.ts` 生成版本化摘要，`compaction-store.ts` 原子持久化摘要与 activation，`compaction-store-codec.ts` 校验恢复事务和磁盘投影。
- 保留原始消息，不负责 UI 排序、项目索引、Agent Workflow 或长期记忆选择。
- 禁止用摘要覆盖原始 JSONL，禁止把附件正文写入会话元数据。

## 依赖与数据

- 只依赖公共契约；Runner 写入，App 的 session index 仅维护 UI 元数据。
- 会话正文是用户数据，锁和原子写入必须保持重启可恢复。回复注册表只保存规范化文本的 SHA-256，首次创建时从完整原始会话回填，不进入 LLM Context。

## 测试与修改定位

- 会话与回复原子占用行为在 `src/manager.test.ts`，压缩行为在 `src/compaction.test.ts`，持久化投影兼容与来源校验在 `src/compaction-store.test.ts`。
- 变更格式时同时验证旧会话读取、增量摘要和并发写入。
