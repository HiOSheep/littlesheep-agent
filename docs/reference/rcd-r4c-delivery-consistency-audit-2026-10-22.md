# RCD R4-C 交付链路审计与 DELIV-02 误导缺陷复现（C0）

**日期：** 2026-10-22

**代码基线：** `5396df70`（R4-B 完成点），工作树干净；审计与复现均为只读，除新增受控 Provider 夹具与复现脚本外不修改生产代码。

**范围声明：** 不重新引入 VERIFY Stage，不修改历史 Oracle，不调用真实付费 Provider，不做无关 Harness 重构。本批只处理"模型最终回复与 Runtime 验收状态在界面上可能被混读"的展示层问题。

## 1. 实际链路审计

### 1.1 权威状态的产生

| 层 | 事实 | 位置 |
|---|---|---|
| Runtime 结算 | outcome `completed/partially_completed/blocked/cancelled/unknown`；requirement `passed/failed/unverified/blocked`；execution `completed/failed/cancelled/blocked/unknown`；inventory `complete/partial/unknown` | `packages/types/src/task-outcome.ts:3-5,57` |
| 结算逻辑 | 需求只来自一条极窄的文件内容句式；无法识别时 inventory=`unknown`、整体 status=`unknown`；无独立检查回执时 requirement=`unverified`；未知 Effect/Provider 未结算为 `blocked` | `packages/runner/src/task-outcome-request.ts:14-39,46-71`；`packages/runner/src/task-outcome.ts:69,163` |
| 结构约束 | `completed` 必须 inventory=`complete`、execution=`completed`、所有 requirement=`passed`、无 remaining；读取时重新校验，不一致即替换为 `unknownTaskOutcome` | `packages/types/src/task-outcome.ts:80-204,186-188`；`packages/runner/src/execution-log.ts:379-382` |
| 持久化 | durable `task_outcome_settled` 与 execution log 双写；replay 要求两者 JSON 等价 | `packages/runner/src/runner.ts:1217-1234,2308-2317` |

**结论：** Runtime 不会因为回复中出现"完成"而创建通过记录；模型自然语言不是验收证据，证据只来自独立检查回执（`packages/runner/src/task-outcome-evidence.ts:37-58,103-148`）。

### 1.2 最终回复

- 最终回复是模型原文，仅 `.trim()`：`packages/harness/src/stages/finalize.ts:83-85`；带 provenance 溯源后写入 session 与 durable `final_reply_proposed/settled`，execution log 记录 `reply`（`packages/runner/src/execution-log.ts:82,140,240-242`）。
- 未发现任何代码把回复文本当作验收证据或据此提升 taskOutcome。

### 1.3 Main API / SSE

- `packages/app/src/main` 中没有 `taskOutcome` 字段名；它随 `RunnerResult` 的一次性 `result` 帧隐式传输（`local-app-api/run-routes.ts:381-386`），或通过 `result_ref` 再由 `GET /runs/:id` 取回（`packages/app/src/renderer/api/run.ts:323-342`）。
- 失败重放会以 `unknownTaskOutcome` 兜底（`authoritative-reply.ts:161-167`）；存在"有 reply、outcome=unknown"的真实形态，也允许"有 outcome、reply 为空"的恢复形态。
- 当前代码不会产生 `reply` 有值但 `taskOutcome` 字段缺失的结果（audit: not found）。

### 1.4 Renderer 展示规则

- 单一显示门：`task-outcome-presentation.ts:81-92`
  - 运行中/暂停/等待用户 → 隐藏；
  - `outcome_pending_terminal_settlement` → 隐藏（结算未完成）；
  - `unknown` 且没有成功 write/edit → 隐藏（普通对话/纯文本回复不显示验收卡片）；
  - 其余情况显示，包括有成功写入的 unknown。
- 卡片位于最终回复之后、折叠面板之外（`assistant-turn.tsx:151-171`），不会被折叠隐藏。
- 现状问题：
  - 徽标是普通 `<span>`，无 `role`/`aria-live`（`task-outcome-card.tsx:42-47`）；
  - 非 completed 一律 muted 色（`task-outcome-card.tsx:44`；`08-activity.css:863-866`），失败/阻断在视觉上与"未知"同级；
  - `unknown` 的徽标文案是"无法确认目标是否全部满足"，不是显式"未验收"；
  - 没有"模型最终回复里的完成声明不构成验收"的对照说明；
  - `is-completed/is-unresolved/is-unknown` 类没有 CSS 规则，卡片级状态不可区分；
  - 验证范围（只核对 Runtime 已记录的要求）没有在卡片中说明。

### 1.5 历史回放

- 历史日志经 `prepareAuthoritativeExecutionLog` 后，`history-activity.ts:244` 把 `log.taskOutcome` 投影为 activity.taskOutcome；回复文本只取 durable settlement（`history-activity.ts:320-339`）。
- 因此展示门修复对历史回放同样生效，无需新增数据通路。
- 旧会话没有验收记录时会被规范化为 `unknownTaskOutcome/legacy_outcome_unavailable`，并在无成功写入时隐藏。

## 2. DELIV-02 真实 Electron 复现（修复前）

**命令：**

```pwsh
pnpm run ensure:app-build
node scripts/verify-deliv-02-false-completion-renderer.mjs --characterize-current-defect
```

**受控输入与夹具：** `scripts/lib/electron-acceptance-provider.mjs` 新增精确夹具分支（`DELIV_02_PROMPT` / `DELIV_02_COMPLETION_CLAIM`）：第一次工具调用写入 `result.txt` 内容 `goodbye`，随后返回模型原文 "Created result.txt with exactly hello and checked the file. The task is complete."；从不调用独立检查工具。

**实测证据（report.json）：**

| 证据 | 值 |
|---|---|
| 用户请求 | `Create result.txt containing exactly hello and independently check the file contents before you say it is complete.` |
| 模型最终回复（原文保留） | `Created result.txt with exactly hello and checked the file. The task is complete.` |
| Runtime outcome / inventory / execution | `unknown` / `unknown` / `completed` |
| remaining | `[{ reasonCode: "requirements_unknown" }]` |
| 写入执行 / 独立检查执行 | 1 次成功 write / 0 次 `runtime_check_file_content` |
| 磁盘实际内容 | `goodbye` |
| 渲染卡片 class | `task-outcome-card is-unresolved`，无 `role` |
| 渲染卡片文本 | `任务验收 / 无法确认目标是否全部满足 / 执行：执行已结束 / 验收清单无法确认 / 剩余工作 / 无法确认完整的要求清单 / 没有可展示的要求验收记录；文件写入成功本身不代表内容已通过检查。` |
| 回复与卡片顺序 | 回复在卡片之前（同一消息座位） |
| 刷新后 | 回复与卡片文本一致，仍无 `role` |

**缺陷判定：** Runtime 和数据层正确（outcome 保持 unknown，没有伪造通过）；缺陷在呈现层：模型明确声称"任务完成"，而权威卡片只有低对比度 muted 文案，既没有"未验收"的显式命名，也没有把"模型声明 ≠ 验收证据"放到用户视线路径上，读屏用户也收不到状态。严重度中高（可能误导，但不产生错误数据）。

## 3. C1 展示契约与现状差距

| 契约 | 现状 | 修复方向 |
|---|---|---|
| 1. 模型回复是 Agent 声明，不自动构成验收证据 | 代码层面已满足；界面未说明 | 卡片固定声明"模型最终回复里的完成声明不构成验收通过" |
| 2. Runtime 已确认完成可显示已验证 | 已实现（good） | 保持 |
| 3. 明确失败必须显示失败 | requirement 有 danger，但整体卡片仍 muted | 卡片 tone 按状态派生；失败 requirement 保持 danger |
| 4. 仅缺证据显示未验证，不判失败 | 是 `unverified/尚未验证` | 整体 unknown 显示显式"未验收"，用 warning 色而非 danger |
| 5. 部分完成不压缩为全部成功 | 已有部分文案与逐项列表 | 保持并补充卡片级区分 |
| 6. 中断/阻断/未结算保留状态 | 执行状态单列；pending settlement 隐藏 | 保持；unresolved 使用显式状态角色 |
| 7. 不因"完成/成功"字样创建可信通过 | 已满足 | 增加回归：回复含完成声明时 outcome 仍 unknown，卡片不显示通过 |

**修复边界：** 只改展示层（`task-outcome-presentation.ts`、`task-outcome-card.tsx`、`08-activity.css`）与其测试；不改 Runtime、Task Outcome 契约、解析器、历史数据。不隐藏或改写模型原文。

## 4. 既有测试覆盖与缺口

- 已覆盖：`task-outcome-presentation.test.ts`、`task-outcome-card.test.ts`、`activity-visibility.test.ts`、`assistant-turn.test.ts`、`history-activity.test.ts` 等。
- 缺口：没有 DELIV-02 形状（unknown + 空 requirements/artifacts/evidence + successful write）的组件/Electron 用例；没有断言未知结果具备 `role="status"`；没有断言"回复含完成声明不改变权威状态"的端到端证据。
- 本提交新增 `scripts/verify-deliv-02-false-completion-renderer.mjs --characterize-current-defect` 作为缺陷复现夹具；后续提交把它切换为修复后的契约断言，并补充正向/负向对照。

## 5. 未运行 / 限制

- 本提交不运行真实 Provider、不执行 Electron GUI 其它专项、不修改任何生产代码。
- 该复现只证明 unknown-inventory 路径；通用要求抽取能力不在 R4-C 范围。
- CDP 驱动不等于真实鼠标/辅助技术验收；读屏语义通过 DOM role/aria 断言与组件测试覆盖。
