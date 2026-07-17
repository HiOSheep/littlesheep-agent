# @littlesheep/snapshot

为记忆、LS 应用数据和用户授权工作区提供快照索引、shadow Git 版本定位和回滚基元。

## 职责与边界

- 公开入口是 `src/index.ts`；旧记忆快照适配在 `snapshot-memory-store.ts`，索引在 `snapshot-index.ts`，shadow Git 适配在 `git-client.ts`，双域检查点在 `git-checkpoint.ts`，文件过滤与 manifest codec 在 `git-checkpoint-files.ts`。
- 负责快照元数据、数据/工作区 before/after revision、回退和退出冻结基元，不决定何时写入长期记忆或恢复活动 TaskBook。
- 禁止删除权威数据来换取快照空间，清理策略必须显式且有界。

## 依赖与数据

- 只依赖公共契约，被 Runner、CLI 和记忆服务消费。
- 快照属于用户数据，必须可定位来源层级、run/session、创建时间和关联工作区；密钥、缓存、SQLite/WAL、构建物及无关未跟踪文件不得进入 shadow Git。

## 测试与修改定位

- 存储和索引测试与实现同目录；`git-client.test.ts` 与 `git-checkpoint.test.ts` 覆盖真实 Git 子进程、双域关联和回退。
- 修改排序或回滚语义时覆盖空仓库、过滤、损坏、重复时间戳、新建文件 preimage、部分失败和无关未跟踪文件保留。
