# 整仓瘦身基线账本（SL-00）2026-09-27

最后更新：2026-09-27 18:22:26

本文件是整仓瘦身收口工作中 SL-00 的交付物（任务书已退役，结果见[项目状态](../decision/project-status.md)同名小节）：把"改动前的四类基线"绑定到确切提交、工作区差异摘要、平台/架构与构建指纹，供 SL-01～SL-08 前后对比。它只写实测，不写计划；下面没有一个数字是从任务书第 2 节抄来的。

## 0. 口径与边界（先读这一段）

1. **提交与时刻**。两次测量都在 HEAD `ec527a7e`（`docs(taskbooks): add the repository-slimming taskbook`）上：第一次 2026-09-27 17:51:09（+08:00），SL-03 改动后复测 17:58:21。任务书第 2 节的审查基线是更早的 `ea3e5af8`，两次工作区内容不同，**不能直接相减**。测量之后 SL-01（`c203f4aa`）与 SL-06（`25cf9764`）已提交，HEAD 变成 `25cf9764`；SL-03 的改动仍留在工作树里。后续对比要重新绑定当时的工作区。
2. **三类数值分开记**：HEAD 快照（`git ls-tree -r -l HEAD` 的 blob 字节）、工作树实测（逐文件 `lstat` 与逐文件行数）、构建指纹（只读调用 `scripts/lib/app-build-fingerprint.mjs`）。目录大小一律标为工作树观察。
3. **没有重建、没有运行**。本轮没有执行 `pnpm run build`、没有重新打包、没有启动 Electron、没有真实模型运行，也没有做任何耗时或吞吐对比。因此本账本**不含任何提速结论**，也不支持把删除字节数换算成安装包收益。
4. **并行改动**：同一工作区存在其他 agent 未提交的 App/样式/脚本/文档改动，SL-01 正在删除已跟踪的误入库生成物。除明确标为 SL-03 的条目外，本账本不把这些改动归因给任何任务，也不冻结它们的状态；下一次复测必须重新绑定提交与差异摘要。
5. **目录字节是逐文件 `lstat` 求和，不跟随符号链接，不是磁盘分配量（allocated size）**。`packages/app/runtime` 在测量时正被运行时准备流程写入，只代表那一秒。

## 1. 版本库清单与工作区差异摘要

| 维度 | 第一次（17:51:09） | 复测（17:58:21） | 口径 |
| --- | ---: | ---: | --- |
| HEAD | `ec527a7e` | `ec527a7e` | `git rev-parse HEAD` |
| `git ls-files` 条目 | 1,930 | 1,930 | 不含忽略目录与未跟踪文件 |
| HEAD blob 总字节 | 18,351,219（17.50 MiB） | 18,351,219 | `git ls-tree -r -l HEAD` 求和；HEAD 未变，故两次相同 |
| 工作树中**存在**的跟踪文件字节 | 18,125,555（17.29 MiB） | 18,114,139 | 逐文件 `lstat`；索引里有、磁盘上没有的条目按 0 计 |
| 索引里有但工作树已删除的跟踪条目 | 111 | 112 | 第一次的 111 个全部是 SL-01 正在删除的生成物；复测的 +1 是 SL-03 删除的 `record-experience.ts` |
| `git diff --shortstat` | 160 files changed, 992 insertions(+), 1009 deletions(-) | 166 / 1140 / 1384 | 含全部并行改动，不是本任务单独差异 |
| `git status --porcelain` 条目（staged/unstaged/untracked） | 168（0/160/8） | 175（0/166/9） | 无 staged 条目；修改 50、删除 111、未跟踪 8 |
| workspace package | 28 | 28 | `packages/*` 与 `packages/channels/*` 下的 `package.json` |

## 2. 源码、测试与脚本计量

| 维度 | 第一次（17:51:09） | 复测（17:58:21） | 口径 |
| --- | ---: | ---: | --- |
| package TS/TSX 非测试 | 905 文件 / 153,887 行 | 904 / 153,658 | `packages/*/src` 与 `packages/channels/*/src`；排除 `node_modules`、`dist`、`out`、`coverage`、`.git`；按文件名 `.test.` / `.spec.` 区分 |
| package TS/TSX 测试 | 537 文件 / 96,273 行 | 538 / 96,467 | 同上 |
| `scripts/` 已跟踪 | 148 项（147 个 mjs/cjs/ps1 + 1 个 README）/ 67,377 行 | 148 项 | `git ls-files scripts/` 加逐文件行数 |
| `scripts/` 工作树 | 152 文件（151 个代码）/ 68,035 行 | 153（152）/ 68,193 | 磁盘遍历，含未跟踪文件 |

复测与第一次的差值可以逐项对上本任务的改动：非测试 −1 文件 / −229 行（删 `record-experience.ts` 250 行、`index.ts` +4、`runner.ts` +17），测试 +1 文件 / +194 行（新增 `taskbook-skill-registration.test.ts`）。`scripts/` 的变化（+1 文件 / +158 行）不是本任务造成的。

## 3. 已跟踪的生成物（测量时刻观察）

- 第一次测量时索引里仍有 **111 个误入库生成物**：110 个 `cache-scope-matrix-*/*.json` 加 1 个 `vitest.config.ts.timestamp-*.mjs`，按 HEAD 快照合计 **271,959 字节**（与任务书第 2 节的 111 个 / 271,959 字节一致）。
- 但那一刻**它们已全部从工作树删除**（SL-01 的并行工作，`git status` 显示为 111 条未暂存删除），所以第 1 节"工作树中存在的跟踪文件字节"不含它们。
- 测量时仓库根目录已没有 `cache-*` 目录（会话开始时的未跟踪目录已被清理）。
- 复测（17:58:21）时索引里**仍是这 111 个**（工作树仍缺），`git status` 的未暂存删除因此是 112 条 = 这 111 个加本任务删除的 `record-experience.ts`；判定用的是 `git ls-tree`/`git ls-files` 全路径，不是按文件名匹配。
- **测量之后**：SL-01 的提交 `c203f4aa`（18:13:25）已把这 111 个从索引移除，`check-repository-hygiene.mjs` 的"Git 未跟踪生成物"随之通过（38/38）。本节描述的是 `ec527a7e` 时刻的状态，不是现在的索引状态。

结论只到这一步：**这 111 个条目的移除属于 SL-01，本账本只记录"我在 17:51 与 17:58 看到了什么"**。

## 4. 构建指纹

`node scripts/ensure-app-build.mjs --assert`（只读断言，不重建）在 17:52 的输出是失败，退出码 1：

```text
Error: App build artifacts are stale (manifest-unavailable): ENOENT: no such file or directory,
lstat '<仓库根>/packages/app/out/.littlesheep-build-fingerprint.json'
```

也就是说当前工作树**没有已登记的构建指纹**（`packages/app/out` 有 165 个文件、28,189,998 字节，但没有指纹清单）。本轮没有重建，所以不写"已构建"。

为了给后续对比留下可比的指纹，用 `scripts/lib/app-build-fingerprint.mjs` 的只读入口（`collectAppBuildInputs` / `fingerprintAppBuildOutputs`）在同一时刻现算了一次，**它不代表产物新鲜**：

| 项 | 实测 |
| --- | --- |
| input.digest | `a4d5caa99492c9dd393f5101082eba2cfa880732a0e5183f99f945ba6a6f9a3a` |
| input.sourceDigest | `31b12c8c6f6ad503ce03f5c722a73fd9a71ae15f954f30cce1a284180cff35b8` |
| input 文件数 / 字节 | 1,549 / 12,248,813 |
| app 依赖闭包中的 workspace 包 | 27 |
| output.digest | `fec1bb3838aaaa681c0997c16aef996eeb248e0aeb193dca09a1f517b6479cc7` |
| output 文件数 / 字节 | 165 / 28,189,998 |
| runtime | Electron 44.4.5，win32，x64 |

## 5. 本地目录（工作树观察，只读 `lstat`）

| 目录 | 字节（MiB） | 文件数 | 备注 |
| --- | ---: | ---: | --- |
| `release/` | 1,390,699,795（1,326.3） | 1,448 | 含解包程序、安装程序与旁车文件；可能仍用于验收，本任务不动 |
| `.codex_tmp/` | 1,229,554,900（1,172.5） | 22,667（跳过 1,257 个符号链接） | 与任务书口径一致 |
| `packages/app/runtime/` | 1,704,804,578（1,625.9） | 294 | 测量时正被运行时准备写入；见下面的分项 |
| `packages/app/out/` | 28,189,998（26.9） | 165 | 当前构建输出，不是无用缓存 |
| `tmp/` | 9,854,175（9.4） | 47 | 图标材料，不默认视为可再生 |

`packages/app/runtime/` 与任务书第 2 节的 289.0 MiB 不是同一件事，分项如下（同一时刻）：

| 子目录 | MiB | 说明 |
| --- | ---: | --- |
| `electron-v36.9.5-win32-x64` | 289.0 | 任务书记录的就是这一个 |
| `electron-v44.4.5-win32-x64` | 367.4 | 与 App manifest 声明的 Electron 44 对应 |
| `electron-v44.4.5-win32-x64-1790493273396` | 602.0 | 准备流程的临时目录（测量时正在写入） |
| `electron-v44.4.5-win32-x64-1790493274303` | 367.4 | 同上 |

这两个临时目录是测量时另一个 agent 的运行时准备产生的；本账本不去清理，只用来说明该目录字节数为什么与任务书不同。

## 6. 平台与运行时

- 平台：`win32`，架构 `x64`，OS 版本 `10.0.26200`。
- 测量用 Node：`v26.4.0`（`node` 默认版本）。
- 已就绪的 Electron 运行时：`44.4.5`（`packages/app/runtime` 内同时存在 `36.9.5`）。

## 7. 本账本明确没有证明的事

- 没有重建、打包、启动 Electron 或真实模型运行；没有耗时对比，因此**不声明任何提速**，也不把移除的文件字节当作安装包或内存收益。
- 没有测量磁盘分配量，没有做逐文件可达性证明，没有断言"某模块无用"——那属于 SL-02/SL-03 各自的消费者证据。
- 第 3、5 节是测量时刻的工作树观察：SL-01 会继续删生成物，App/runtime 侧的并行改动会继续改变 `packages/app/runtime`、`packages/app/out` 与工作区差异摘要。
- 后续任何前后对比必须满足：同一 commit 或同一工作区差异摘要、同一口径、同一平台/架构，并重新记录构建指纹。

## 8. SL-03 改动前后（同一工作树，可逐项核对）

| 项 | 改动前 | 改动后 | 说明 |
| --- | ---: | ---: | --- |
| `packages/experience/src/record-experience.ts` | 250 行 | 文件删除 | `createRecordExperienceTool` 无消费者（证据见下） |
| `packages/experience/src/index.ts` | 19 行 | 23 行 | 去掉 2 个公共导出，补上删除理由的注释 |
| `packages/runner/src/runner.ts` | 2,514 行 | 2,531 行 | taskbook Skill 改为"有正文才注册"，并把注册移到续跑恢复之后 |
| package TS/TSX 非测试合计 | 153,887 行 | 153,658 行 | 净 −229 行 |
| 公共导出（experience） | 10 个 | 8 个 | −1 个函数（`createRecordExperienceTool`）、−1 个类型（`RecordExperienceToolDeps`） |
| 新增测试 | — | `packages/runner/src/taskbook-skill-registration.test.ts`（194 行） | 探针在模型请求内读实时目录与 `loadBody` |

消费者搜索（改动理由，全部在改动前执行）：全仓 `git grep` 对 `createRecordExperienceTool`、`RecordExperience`、`record-experience` 只命中该文件自身、`src/index.ts` 的一行导出、`packages/experience/README.md` 与任务书；`record_experience` 另外命中 `packages/app` 的批准文案、`packages/safety` 的工具名单与已存在的"不在注册表"断言——都不是装配。保留的消费者：`packages/runner/src/infra.ts`（`ExperienceStore`、`LegacyExperienceBranch`）与 `packages/cli/src/commands/import-repo.ts`（`experienceStore.append`），因此 experience 包本体不是死代码。

taskbook Skill 取证命令与输出（都是命令原样输出，`taskbookBody` 缺键表示 `loadBody` 返回 `undefined`；第二轮起探针把它记为 `null` 以便读出来）：

```text
$ pnpm exec vitest run packages/runner/src/taskbook-skill-registration.test.ts     # 改动前
[SL-03 evidence] plain-run {"requestIndex":1,"advertisedSkills":"taskbook"}
[SL-03 evidence] legacy-checkpoint {"requestIndex":1,"advertisedSkills":"taskbook","taskbookBody":"Proposed plan:\n1. finish the legacy plan step"}

$ pnpm exec vitest run packages/runner/src/taskbook-skill-registration.test.ts     # 改动后
[SL-03 evidence] plain-run {"requestIndex":1,"advertisedSkills":"(none)","taskbookBody":null}
[SL-03 evidence] legacy-checkpoint {"requestIndex":1,"advertisedSkills":"taskbook","taskbookBody":"Proposed plan:\n1. finish the legacy plan step"}
```

普通新 run 的目录项在改动前是 `taskbook`、正文 `undefined`（探针当时用 `toBeUndefined()` 断言并通过），改动后是 `(none)`、正文仍为 `undefined`；旧 `decide` 检查点两次都仍能 advertise 并读到恢复的 plan，轨迹里 `execute` 只出现一次、没有 `decide`。

`packages/vector` 本轮**没有改动**：全仓搜索 `@littlesheep/vector` 只命中包自身、`packages/tools/package.json` 的未使用声明、`vitest.config.ts` 的测试别名与冷启动账本；产品、CLI（含已退役的 `memory archive`）、v3 迁移和 `scripts/` 的旧数据根升级脚本都不读 v2 向量库，唯一可执行消费者是它自己的测试。是否整个包退役需要协调者决定，见任务书 SL-03 的开放问题；既有 v2 数据库是用户数据，任何情况下都不删。

### 8.1 本批次实际运行过的验证（命令与结果）

| 命令 | 结果 |
| --- | --- |
| `pnpm exec vitest run packages/experience packages/vector packages/skills packages/harness packages/runner packages/cli` | 151 个测试文件、1,200 通过、1 跳过、0 失败，退出码 0（18:14:08 在 `25cf9764` 上启动；此前一次同命令的进程被别的清理步骤杀掉，结果不计） |
| `node scripts/check-repository-hygiene.mjs` | 38 通过、0 失败，退出码 0（在 `c203f4aa` 之后运行） |
| `pnpm run check:repo` | 仓库卫生 38/38 + "TypeScript project references: ok (28 packages)"，退出码 0 |
| `pnpm exec tsc -b packages/runner/tsconfig.json packages/cli/tsconfig.json packages/skills/tsconfig.json packages/vector/tsconfig.json packages/experience/tsconfig.json packages/harness/tsconfig.json --pretty false` | 无输出，退出码 0 |

`pnpm run typecheck`（整个 workspace）在本批次**没有**通过，但失败与本任务无关：`packages/app/src/main/embedded-browser.ts:125,127` 报 `'guestContents.hostWebContents' is possibly 'null'`。该文件自提交 `09926c9a` 起未被修改，而 `packages/app/package.json` 在工作树里正被另一个任务从 `electron ^36` 改到 `^44`，Electron 44 的类型把 `hostWebContents` 收紧为可空。这一条由 App 侧任务收口，本任务不碰它。
