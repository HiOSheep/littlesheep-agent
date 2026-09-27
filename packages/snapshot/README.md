# @littlesheep/snapshot

最后更新：2026-09-27 11:49:02

为记忆、LS 应用数据和用户授权工作区提供快照索引、shadow Git 版本定位和回滚基元。

## 职责与边界

- 公开入口是 `src/index.ts`；旧记忆快照适配在 `snapshot-memory-store.ts`（`SnapshotMemoryStore`），索引在 `snapshot-index.ts`（`SnapshotIndex`），shadow Git 适配在 `git-client.ts`，双域检查点在 `git-checkpoint.ts`（`GitCheckpointCoordinator`、`RunGitCheckpoint`），文件过滤与 manifest codec 在 `git-checkpoint-files.ts`。
- 负责快照元数据、数据/工作区 before/after revision、回退和退出冻结基元，不决定何时写入长期记忆或恢复活动 TaskBook。
- 禁止删除权威数据来换取快照空间，清理策略必须显式且有界。

## 依赖与数据

- 只依赖公共契约，当前由 Runner（`infra.ts` 装配 `GitCheckpointCoordinator` 与 `SnapshotMemoryStore`、`version-checkpoint-lifecycle.ts` 完成收尾）和 CLI 记忆命令消费；memory-tree / memory-service 不消费本包。
- 快照属于用户数据，必须可定位来源层级、run/session、创建时间和关联工作区；密钥、缓存、SQLite/WAL、构建物及无关未跟踪文件不得进入 shadow Git。

## 测试与修改定位

- 存储和索引测试与实现同目录；`git-client.test.ts` 与 `git-checkpoint.test.ts` 覆盖真实 Git 子进程、双域关联和回退。
- 修改排序或回滚语义时覆盖空仓库、过滤、损坏、重复时间戳、新建文件 preimage、部分失败和无关未跟踪文件保留。
- preimage 复用（2026-09-27）：eginRun 先用遍历时已经拿到的 size/mtime 生成签名（preimage-signature.ts）并与上次提交比对；数据根没有变化且上次追踪的路径数与遍历数一致时，直接复用上一个提交，跳过 `ls-files`、逐路径 stat、分批 `git add` 与 commit——实测这是首 token 前最大的一项（隔离根上 448–563 ms / 约 915 ms）。`initialize()`（每次启动都会跑）现在用同一签名复用 bootstrap 提交：以前每次启动都要遍历整个数据根、逐路径 stat、分批 add 并创建一个**空** bootstrap 提交——这一步同样在就绪路径上，且随数据量增长。任何变化、任何遍历看不到的已跟踪路径、以及 `freeze` 之后都会退回完整提交：漏掉一次变化会丢回滚点，这是唯一不能失败的方向。
