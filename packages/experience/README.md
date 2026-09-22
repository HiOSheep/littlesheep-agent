# @littlesheep/experience

最后更新：2026-09-22 12:47:49

保存经过校验确认的可复用经验、置信度和衰减信息，支持能力持续改进。

## 职责与边界

- 公开入口是 `src/index.ts`；`experience-store.ts` 管理索引与记录，`record-experience.ts` 定义遗留的 `record_experience` AgentTool 工厂 `createRecordExperienceTool`——当前没有任何 runtime 装配它（文件中关于 `append_daily`/`write_memory` 的注释是历史说明）。
- 只保存结构化经验，不保存完整对话、原始工具输出或未经验证的模型猜测。
- 禁止绕过安全校验直接把一次性执行日志提升为长期经验。

## 依赖与数据

- 依赖记忆兼容存储（`atomicWrite`）、安全和公共契约。当前唯一写入方是 CLI `import-repo`（`experienceStore.append`）；EVOLVE 已删除，Runner 只在旧迁移未完成时把 store 注册为兼容读取分支 `LegacyExperienceBranch`，不再主动提出经验写入。
- 经验数据属于用户数据根，损坏索引只做有备份的恢复（原始字节先写入 `backups/index.corrupt-*.json`）。

## 测试与修改定位

- 存储、并发、损坏恢复和衰减测试位于 `src/experience-store.test.ts`。
- 调整生命周期时同时检查备份、去重和用户可管理性。
