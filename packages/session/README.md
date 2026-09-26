# @littlesheep/session

最后更新：2026-09-27 05:17:22

管理 JSONL 会话、文件锁、用户可见回复 settlement 身份与文本指纹账本，以及非破坏式长会话摘要。

## 职责与边界

- 公开入口是 `src/index.ts`；`manager.ts` 管理会话，`lock.ts` 管理并发，`reply-fingerprint-store.ts` 以 settlement 身份保证跨重启、并发安全的发布幂等并保留文本指纹账本，`compaction.ts` 生成版本化摘要，`compaction-store.ts` 原子持久化摘要与 activation，`compaction-store-codec.ts` 校验恢复事务和磁盘投影。
- 安装摘要及其覆盖范围是**一次**原子提交：`maybeCompact` 计算 `transactionKey` 与 `sourceHash`，`manager.commitCompaction` 带前置条件（前一摘要 id、`sourceEndMessageId`、来源哈希、策略版本）提交；前置条件不满足即失败并保留上一份有效摘要（`StaleCompactionError`）。原始 JSONL 消息从不删除。
- **Runtime 尾部记录不算对话**：带 `runtimeTail` 的消息随转录保存以便按字节回放，但不计入压缩阈值与 keepRecent 窗口（否则每轮约 10 条会把整轮挤出），也不进入摘要输入；摘要元数据的 `collapsedCount`/`messageCount` 只统计对话消息，而覆盖范围仍按记录给出（`sourceEndMessageId` 可能落在该轮的尾部记录上）。
- 本包是压缩路径（持久记忆的唯一写入方）的持久化边界：摘要与其记忆候选作为一个事务提交，未结算的 pending 事务留给恢复处理。
- 保留原始消息，不负责 UI 排序、项目索引、Agent Workflow 或长期记忆选择。
- 禁止用摘要覆盖原始 JSONL，禁止把附件正文写入会话元数据。

## 依赖与数据

- 只依赖公共契约；Runner 写入，App 的 session index 仅维护 UI 元数据。
- 会话正文是用户数据，锁和原子写入必须保持重启可恢复。回复注册表只保存规范化文本的 SHA-256，首次创建时从完整原始会话回填，不进入 LLM Context。

## 测试与修改定位

- 会话与回复原子占用行为在 `src/manager.test.ts`，锁在 `src/lock.test.ts`，压缩行为在 `src/compaction.test.ts`，持久化投影兼容与来源校验在 `src/compaction-store.test.ts`，activation 投影在 `src/cache-activation-store.test.ts`。
- 变更格式时同时验证旧会话读取、增量摘要和并发写入。
