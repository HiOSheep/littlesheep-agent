# @littlesheep/session

管理 JSONL 会话、文件锁和非破坏式长会话摘要。

## 职责与边界

- 公开入口是 `src/index.ts`；`manager.ts` 管理会话，`lock.ts` 管理并发，`compaction.ts` 生成版本化摘要。
- 保留原始消息，不负责 UI 排序、项目索引、Agent Workflow 或长期记忆选择。
- 禁止用摘要覆盖原始 JSONL，禁止把附件正文写入会话元数据。

## 依赖与数据

- 只依赖公共契约；Runner 写入，App 的 session index 仅维护 UI 元数据。
- 会话正文是用户数据，锁和原子写入必须保持重启可恢复。

## 测试与修改定位

- 会话行为在 `src/manager.test.ts`，压缩行为在 `src/compaction.test.ts`。
- 变更格式时同时验证旧会话读取、增量摘要和并发写入。
