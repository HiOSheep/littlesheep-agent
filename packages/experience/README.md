# @littlesheep/experience

最后更新：2026-09-27 20:27:52

保存经过校验确认的可复用经验、置信度和衰减信息，支持能力持续改进。

## 职责与边界

- 公开入口是 `src/index.ts`；`experience-store.ts` 管理索引、记录、并发、备份与衰减。
- **遗留的 `record_experience` 工具已退役**（SL-03，2026-09-27）：`src/record-experience.ts` 的 `createRecordExperienceTool` 只有定义与 public export，没有任何 Runtime 装配、测试或动态导入引用它（唯一的调用方是已删除的 EVOLVE 路径），整文件与 `index.ts` 的对应 export 一并删除。不要因为"经验记录"这个名字把它重新加回工具注册表：持久记忆的写入方是受控的 `memory_write`/`memory_manage`。
- 只保存结构化经验，不保存完整对话、原始工具输出或未经验证的模型猜测。
- 禁止绕过安全校验直接把一次性执行日志提升为长期经验。

## 依赖与数据

- 依赖记忆兼容存储（`atomicWrite`）、安全和公共契约。本兼容存储的唯一写入方仍是 CLI `import-repo`（`experienceStore.append`）；持久记忆本身由受控的 `memory_write`/`memory_manage` 写入；EVOLVE 已删除，Runner 只在旧迁移未完成时把 store 注册为兼容读取分支 `LegacyExperienceBranch`，不再主动提出经验写入。
- 经验数据属于用户数据根，损坏索引只做有备份的恢复（原始字节先写入 `backups/index.corrupt-*.json`）。

## 测试与修改定位

- 存储、并发、损坏恢复和衰减测试位于 `src/experience-store.test.ts`。
- 调整生命周期时同时检查备份、去重和用户可管理性。
- 依赖边收口（2026-09-27）：SL-03 删除 `createRecordExperienceTool` 后，`zod` 与 `@littlesheep/types` 在本包已无引用（0 个 zod import、0 个 types import），故一并移除；`@littlesheep/memory-core` 与 `@littlesheep/safety` 仍在用，保留。
