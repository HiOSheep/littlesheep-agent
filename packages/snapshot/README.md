# @littlesheep/snapshot

为记忆、LS 应用数据和用户授权工作区提供快照索引、shadow Git 版本定位及回滚基元。公开入口为 `src/index.ts`；Runner 与 CLI 消费本包，具体快照时机由调用方决定。

## 数据与回滚边界

- 本包记录受管数据与工作区的 before／after revision、关联来源及可恢复版本；不决定长期 Memory 写入，也不调度活动 TaskBook。
- 版本数据属于用户数据，位于活动数据根的 `backups/versioning/`。数据根快照与每个授权工作区的 shadow 仓库分离。
- 密钥、缓存、SQLite/WAL、构建产物和无关未跟踪文件不进入 shadow Git。排除规则须明确且有界；不得通过删除权威数据换取快照空间。
- 未结算 run 有独立恢复记录；恢复不能重放已结算副作用。旧数据根只在必要时走兼容读取。
- Git 状态负责列出已跟踪和新增路径，提交前仍执行受管路径检查。新增路径的忽略状态不可被强制暂存规则绕过。

索引、manifest、Git client 与 checkpoint coordinator 分别拥有存储职责。相关测试验证损坏、恢复、并发、路径排除和回滚；桌面文件故障的外层行为由 `verify:desktop-file-consistency` 覆盖。
