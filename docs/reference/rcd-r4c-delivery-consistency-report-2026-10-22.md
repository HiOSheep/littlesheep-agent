# RCD R4-C 可信交付与完成声明一致性最终报告

**日期：** 2026-10-22

**基线：** `5396df70`（R4-B 完成点）

**提交：** `a19c3278`（C1 审计与复现）→ `f2aa0ee7`（C2 最小展示修复）→ 本报告所在提交（C3 Electron 正负回归、报告与验收证据）

**边界：** 不重新引入 VERIFY Stage；不修改历史 Oracle；不调用真实付费 Provider；不修改 Runtime/Harness/Task Outcome 契约/解析器；不自动推送；不启动 R4-D。

## 1. 结论

模型可以继续用自己的话表达执行结论，但用户看到的可信完成状态只来自 Runtime 的权威 Task Outcome。修复前，DELIV-02 场景中模型声称"When the task is complete"，而界面只显示低对比度 muted 文案"无法确认目标是否全部满足"，既没有"未验收"命名，也没有把"模型声明不是验收证据"放到用户视线与读屏路径上。修复后：

- 未验收使用显式名称与 warning 级样式，并带 `role="status"`；
- 卡片固定声明模型完成声明不构成验收通过，并说明验证范围仅限 Runtime 记录；
- 已验证通过、检查未通过、尚未验证、受阻四种状态分别显示，互不覆盖；
- 模型最终回复原文保留，不隐藏、不改写。

## 2. 展示契约与实现

| C1 契约 | 实现 |
|---|---|
| 1. 模型回复属于 Agent 声明，不自动构成验收证据 | 卡片固定 `模型最终回复里的完成声明属于 Agent 声明，不构成验收通过；本卡片只依据 Runtime 记录。`；Runtime 侧从不把 reply 当证据 |
| 2. Runtime 已确认完成显示已验证 | `acceptanceState=completed` → `已验证通过` / `已按明确的验收条件通过` / good tone |
| 3. 明确失败必须显示失败 | requirement `failed` → `检查未通过` + danger tone；card `data-acceptance="failed"` |
| 4. 仅缺证据显示未验证，不判失败 | `尚未验证` / `未验收：缺少可确认的验收证据`，使用 unverified tone；未验收另附"缺少可确认的独立检查证据" |
| 5. 部分完成不压缩为全部成功 | 保留逐项 `已验证通过` 与 `检查未通过`，整体显示"部分要求已通过，仍有未满足项" |
| 6. 中断/阻断/未结算保留状态 | execution 状态单列；blocked 使用 blocked tone；pending settlement 仍不显示为终态 |
| 7. 不因"完成/成功"字样创建可信通过 | 只消费已有 `TaskOutcome`；新增端到端断言：回复含完成声明时 outcome 仍为 `unknown`，卡片显示 `未验收` |

实现只改展示层：

- `packages/app/src/renderer/chat/task-outcome-presentation.ts`：unverified tone、`isAcceptanceUnverified`、`taskOutcomeAcceptanceState`、`acceptanceTone`；unknown 标签改为显式未验收；有工具记录的未验收不再因没有成功写入而隐藏。
- `packages/app/src/renderer/chat/task-outcome-card.tsx`：`role="status"`、`data-acceptance`、`is-unverified`、声明免责与验证范围说明。
- `packages/app/src/renderer/styles/08-activity.css`：unverified/danger/blocked/completed 左边框与 unverified 徽标样式。

未修改：`packages/runner`、`packages/harness`、`packages/types` 的 Task Outcome 契约、Main API/SSE、ExecutionLog、历史投影、S3A/S3B/V2 冻结 Oracle。

## 3. 修改范围

| 类型 | 文件 |
|---|---|
| 生产 | `packages/app/src/renderer/chat/task-outcome-presentation.ts`、`task-outcome-card.tsx`、`renderer/styles/08-activity.css` |
| 测试 | `task-outcome-presentation.test.ts`、`task-outcome-card.test.ts`、`assistant-turn.test.ts` |
| 验收脚本/夹具 | `scripts/verify-deliv-02-false-completion-renderer.mjs`、`scripts/verify-task-outcome-renderer.mjs`（沿用）、`scripts/lib/electron-acceptance-provider.mjs`（新增受控分支） |
| 命令 | `package.json` 新增 `verify:deliv-02-claim-consistency` |
| 文档 | 审计报告、本报告、`docs/reference/README.md`、`scripts/README.md` |

## 4. 验证结果

| 验证 | 结果 |
|---|---|
| 组件/单元（3 文件） | **45 tests passed**（assistant-turn 31、outcome card 9、presentation 5） |
| DELIV-02 真实 Electron 正负对照 | **6 cases / 10 checks passed**，32.5 s；六种情形：错误文件+完成声明、独立检查通过、无独立检查、部分要求、权限拒绝、工具执行失败 |
| 既有 Task Outcome Renderer 验收 | 4 cases / 8 checks passed（passed/failed/unverified/partial/普通对话/reload） |
| `pnpm run typecheck` | exit 0 |
| `pnpm run check:repo` | ok（35 passed / 3 advisory / 0 failed） |
| RCD 六项冻结核心 | 6/6 executed；3 passed / 1 partially_completed / 2 correctly_blocked；exit 0 |
| VRS/S2B/S2C 恢复回归（`test:ci-recovery`） | 41 passed / 6 skipped 文件；200 passed / 7 skipped 用例；exit 0 |
| R4-B 三维评测回归（`test:v2`） | 66 tests / 6 files passed；exit 0 |
| `pnpm run verify:full` | **`[gate] full passed`**，740.2 s；check:repo 3.6 s、tests 679.9 s、typecheck 0.9 s、build 54.0 s、recovery 1.7 s |

历史结果与权威数据未改写：RCD 核心结果、S3A/S3B 冻结账本、R4-B 的 20 条 V2 记录均未变化。

## 5. Electron 证据摘要

**DELIV-02 负向（修复后）：**

- 用户：`Create result.txt containing exactly hello and independently check the file contents before you say it is complete.`
- 模型原文：`Created result.txt with exactly hello and checked the file. The task is complete.`
- Runtime：outcome=`unknown`、inventory=`unknown`、execution=`completed`、requirements/artifacts/evidence 为空、remaining 含 `requirements_unknown`、1 次成功 write、0 次独立检查、磁盘内容 `goodbye`。
- 界面：回复在前、卡片在后；卡片 `role="status"`、`data-acceptance="unverified"`、`is-unverified`、badge `unverified`；文本含 `未验收：缺少可确认的验收证据`、`模型最终回复里的完成声明…不构成验收通过`、`验证范围仅限 Runtime 已记录的要求`；不含 `已验证通过` / `已按明确的验收条件通过`。

**正向对照：**

- 独立检查通过：`已验证通过` + `已按明确的验收条件通过`，Runtime requirement=`passed`，文件内容 `hello`。
- 正确但无独立检查：`尚未验证` + `尚未执行独立检查`，Runtime requirement=`unverified`，不显示通过。
- 部分要求：同时显示 `已验证通过` 与 `检查未通过`，整体为部分完成，不显示全部通过。
- 权限拒绝 / 工具执行失败：均无成功写入、无独立检查、无通过声明；界面显示 `尚未验证` 与声明免责，而不是成功。
- 普通对话：不新增空验收卡片。

**一致性：** Renderer reload、完整 Electron 重启、以及切换到普通会话再切回任务会话后，模型回复逐字保留，卡片文本与 `role="status"` 保持一致；普通会话与任务会话互不串扰。

## 6. 未覆盖 / 残余限制

- 真实付费 Provider 未执行；受控 scripted Provider 结果不代表模型能力或真实任务成功率。
- 权限拒绝与工具执行失败在本夹具中最终落在 requirement=`unverified`（写入未结算），而不是 execution=`blocked`；界面正确显示未验证且绝不显示通过，但"blocked 执行状态"路径由组件测试覆盖，未由本 Electron 夹具单独覆盖。
- 通用任务要求抽取不在 R4-C 范围：仍只有固定文件内容句式能进入完整 inventory；其他任务的"验证范围有限"由未验收卡片说明，而非新增判定。
- CDP 驱动 DOM 不等于真实屏幕阅读器验收；`role="status"`、aria-label 与文本断言只证明语义存在。
- 无工具工作、且没有 Task Outcome 的普通回复仍不显示验收卡片（避免把普通对话误标为未验收）；这是有意保留的展示边界。
- 修复前的旧会话记录不会追溯补写验收状态；历史回放遵循同样的展示门。
- 未运行 Linux/macOS 打包、真实 Provider、WSL 终端与跨平台专项。

## 7. 提交与状态

- 本地 `main`：`a19c3278`（C1）→ `f2aa0ee7`（C2）→ 本提交（C3）。
- 未推送到 `origin`；`origin/main` 仍为 `c12fb52e`。
- 未启动 R4-D。
