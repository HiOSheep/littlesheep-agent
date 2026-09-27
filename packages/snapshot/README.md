# @littlesheep/snapshot

最后更新：2026-09-27 13:26:40

为记忆、LS 应用数据和用户授权工作区提供快照索引、shadow Git 版本定位和回滚基元。

## 职责与边界

- 公开入口是 `src/index.ts`；旧记忆快照适配在 `snapshot-memory-store.ts`（`SnapshotMemoryStore`），索引在 `snapshot-index.ts`（`SnapshotIndex`），shadow Git 适配在 `git-client.ts`（`ShadowGitRepository`：spawn、按仓库串行的 mutation 队列与锁文件、`trackedPaths`/`head`/`workTreeChanges`/`commitPaths`/`commitWorkTreeChanges`），双域检查点在 `git-checkpoint.ts`（`GitCheckpointCoordinator`、`RunGitCheckpoint`），数据路径选择与 preimage 判定在 `git-checkpoint-preimage.ts`，manifest 持久化/恢复/保留在 `checkpoint-manifest-store.ts`，文件规则与 codec 在 `git-checkpoint-files.ts`。
- 负责快照元数据、数据/工作区 before/after revision、回退和退出冻结基元，不决定何时写入长期记忆或恢复活动 TaskBook。
- 禁止删除权威数据来换取快照空间，清理策略必须显式且有界。

## 依赖与数据

- 只依赖公共契约，当前由 Runner（`infra.ts` 装配 `GitCheckpointCoordinator` 与 `SnapshotMemoryStore`、`version-checkpoint-lifecycle.ts` 完成收尾）和 CLI 记忆命令消费；memory-tree / memory-service 不消费本包。
- 快照属于用户数据，必须可定位来源层级、run/session、创建时间和关联工作区；密钥、缓存、SQLite/WAL、构建物及无关未跟踪文件不得进入 shadow Git。
- 版本位置固定在 `<data-root>/backups/versioning/`：`checkpoints/`（manifest）、`pending-runs/`（未结算 run 的记录）、`repositories/`（data.git 与按工作区隔离的 shadow 仓库）；这些目录本身被排除规则挡在版本化之外。

## 启动路径（2026-09-27：路径来源改由 git 提供）

- 一次数据提交覆盖的路径 = `git ls-files`（一次进程，不 stat 任何文件）＋ `git status --porcelain -z --untracked-files=all`（一次进程，只 stat 它报告为新增的少数路径）＋ 具名根文件 `DATA_ROOT_FILES`（存在才加），三者统一过 `isManagedDataPath` / `dataDirectoryExcluded` 字符串规则。
- 已跟踪路径由 `git add -u -- .` 一次进程更新（含磁盘上已删除的路径）；只有新增/变化路径被显式 `git add -A -f`，所以 `-f` 永不作用于目录，`backups/`、`attachment-cache/`、`models/`、`vectors/`、`*.sqlite` 等排除项不可能被强制加入。
- `collectDataFileStats` / `collectDataFiles`（recursive readdir + 每个受管文件一次 `lstat`）已删除。它们此前在每次启动、且在就绪路径上运行：4,730 文件的夹具上实测 7.2 s，真实 31k 文件数据根更差。
- 未结算 run 的恢复不再逐 manifest 解析：`beginRun` 先写 `pending-runs/<id>.json`、再写 manifest，恢复只读这些记录（正常情况下目录为空）；没有该目录的旧数据根回退一次全量扫描。结算时记录被清除——否则恢复会退化成"每个已结算 run 读一次 manifest"。`prune()` 只在 manifest 数超过 `maxCheckpoints + 32` 时才读 mtime，并一次删回上限。
- preimage 复用（同日更早的改动）保留：工作树干净且签名指向 HEAD 时直接复用；树通常是脏的（应用在两次启动之间写受管目录），此时走上面的 git 路径——这正是遍历必须消失、脏路径必须变便宜的原因。
- 实测（`scripts/measure-desktop-large-root-startup.mjs --fixtures=synthetic-large --runs=2`，label `snapshot-git-path-selection`）：`runner-infra-observability-ready → runner-infra-durable-events-ready` 由基线 **13,580 ms / 3,173 ms**（冷/热）变为 **17,124 ms / 863 ms**；`spawnToReadyMs` 由 25,098 ms / 7,773 ms 变为 19,382 ms / 2,172 ms（第二组样本：15,914 / 1,190 ms，17,538 / 3,223 ms）。冷启动那一项由"首次把全部受管文件写入 shadow 仓库"支配：同一夹具上的隔离 A/B 中旧实现 26.5 / 23.0 s、新实现 24.4 / 23.1 s，即冷启动区间不变，收益全在热启动（每个后续启动）上。
- 已知边界：新出现的、命中忽略模式的文件（shadow 仓库 `info/exclude` 或工作树 `.gitignore`）不会被 `git status` 报告，因此不会在它首次出现的那次启动被版本化；已跟踪路径不受影响（来自 `ls-files`，且 `git add -u` 不查忽略规则），今天已有的回滚点不会丢。这是"排除规则权威、`-f` 不得越过它"的直接结果。

## 测试与修改定位

- 存储和索引测试与实现同目录；`git-client.test.ts` 覆盖真实 Git 子进程、工作树状态列表（改动/删除/未跟踪，且不含被忽略项）与共享锁；`git-checkpoint.test.ts` 覆盖双域关联、回退、preimage 复用与提交、路径来源（改动的文件仍被提交、新增与删除仍被提交、排除目录永不入库）、未结算 run 的恢复，以及"一次启动只 stat git 报告的新路径、一次恢复只读未结算的 manifest"。
- 修改排序或回滚语义时覆盖空仓库、过滤、损坏、重复时间戳、新建文件 preimage、部分失败和无关未跟踪文件保留。
