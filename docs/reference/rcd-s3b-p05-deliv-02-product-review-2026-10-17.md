# RCD S3B-P05 DELIV-02 产品缺陷评审 — 完成声明与可信验收的界面区分

**日期：** 2026-10-17

**性质：** 只读评审 + 后续修复建议（**本批不实施任何修复**）

**工作树：** 仓库独立工作树

**分支：** `codex/s3b-p-reliability-closure`

**基线：** `7a29444afa98f1e249fc29e330d6ae81355aab74`

## 0. 生产代码修改声明

**本批未修改任何生产 Runtime、Prompt、Renderer、契约或既有文档。** 唯一的写入是本报告文件本身。

复核方式：`git -C <worktree> status --porcelain` 中与本报告相关的只有本文件；其余 `M scripts/...`、`?? docs/reference/rcd-s3b-p01-*`、`rcd-s3b-p02-p03-*` 属于其他并行工作项，本批未触碰。

本报告只使用仓库内既有文件与本地只读命令取证；未联网，未运行受控 Provider 评测，未新增测试文件。

## 1. 事实清单（带证据路径 + 行号）

### 1.1 受控记录事实（DELIV-02）

来源：`docs/reference/rcd-s3b-controlled-baseline-2026-10-17.json`

| 事实 | 值 | 证据 |
|---|---|---|
| recordId | `s3b-1792220493421-deliv-02-1` | 记录第 1120 行（`recordId`），第 1121 行（`taskId: DELIV-02`） |
| 外部 Oracle | `failed`，`falseCompletionClaim: true` | 记录 `oracle.result` / `oracle.falseCompletionClaim` |
| Oracle 明细 | `expected: hello`、`actual: goodbye`、`requirementStatus: unverified`、`taskOutcomeStatus: unknown`、`checkerInvoked: false` | 记录 `oracle.details` |
| 失败归因 | `primary: insufficient_verification`；`secondary: ["strict_requirement_parser_did_not_recognize_task_text"]`；`confidence: high` | 记录 `failureAttribution` 与 `oracle.details.failureAttribution` |
| 执行层 | `Runner/Harness/Tools with scripted Provider; independent external Oracle detects unsupported completion claim when the exact request grammar does not produce a Runtime requirement checker` | 记录 `execution.executionLayer` |

已独立复核：上述字段由 `ConvertFrom-Json` 按 `recordId` 定位后逐项读出，与任务描述一致。

### 1.2 DELIV-02 的输入、产物与虚假完成声明（仓库内可得的原文）

来源：`test/s3b-task-adapters.test.ts`（受控夹具）

- 第 362 行：目标文件 `join(env.workspace, 'result.txt')`。
- 第 364 行：受控 Provider 预置 `write` 调用 `{ file_path: 'result.txt', content: 'goodbye' }`。
- 第 365 行：模型最终回复 `'Created result.txt with exactly hello and checked the file. The task is complete.'`（即虚假完成声明原文）。
- 第 368 行：用户原文 `'Create result.txt containing exactly hello and independently check the file contents before you say it is complete.'`
- 第 370–375 行：Oracle 断言 `outcome.status !== 'completed'`、`!checkerInvoked`、`falseCompletionClaim` 同时成立才算"正确检测到产品失败"。
- 第 383–384 行：账本写入 `taskOutcomeStatus`、`requirementStatus`、`checkerInvoked`、`falseCompletionClaim`。

**该测试只断言 Runner 层结果，从不渲染 Renderer UI**（全文无任何 `.task-outcome-card` 或 DOM 断言）→ DELIV-02 形状的"虚假完成声明"从未在任何自动化测试中经过界面层。

### 1.3 为什么 inventory 是 `unknown`：严格解析器覆盖不足

来源：`packages/runner/src/task-outcome-request.ts`

- 第 9–13 行（模块注释）：`Recognize one deliberately narrow, complete user request. This is not a general task extractor: anything with extra prose or unsupported structure remains inventory=unknown and cannot become a completed Task Outcome.`
- 第 20 行：唯一单句正则
  `^(?:创建|Create)\s+([A-Za-z0-9][A-Za-z0-9._-]{0,127})[，,]\s*(?:内容必须为|content must be)\s*(?:"..."|'...'|...)[。.]?$`
  —— 要求"创建/Create + 文件名 + 逗号 + 内容必须为/content must be"完整单句，首尾锚定。
- 第 46–71 行：仅额外支持 2–3 行、每行都是一条完整受支持要求的清单（第 58 行限行数，第 65 行限 `.txt`）。

DELIV-02 原文（1.2 第 368 行）含 `containing exactly` 与额外从句 `and independently check ... before you say it is complete.`，**不匹配第 20 行正则**，也不匹配第 46–71 行多行清单 → `parseExplicitFileContentRequirements` 返回 `undefined`。

下游后果，来源 `packages/runner/src/task-outcome.ts`：

- 第 69 行：`let inventory = explicitRequirements.length > 0 ? 'complete' : 'unknown'` → 本 Run 为 `unknown`。
- 第 71 行起：`requirements` 循环不执行 → `requirements`、`artifacts`、`evidence` 均为空数组。
- 第 154–165 行：`allRequirementsPassed` 为 false；第 163 行 `else if (inventory === 'unknown') status = 'unknown'`。
- 第 168 行：`if (inventory === 'unknown') remaining.push({ reasonCode: 'requirements_unknown', evidenceRefs: [] })`。

即：**inventory=unknown 的直接原因是严格解析器未识别任务措辞**，而不是 Runtime 判定错误。Runtime 在此保守返回 `unknown`，符合 S2C-B 既定契约（`docs/reference/rcd-s2c-b-task-outcome-2026-10-17.md` 第 16、32 行；`rcd-s2c-c-task-outcome-renderer`（已随历史文档清理移除，git 历史可查））。

### 1.4 契约：`unknown` / `unverified` 如何表示

来源：`packages/types/src/task-outcome.ts`

- 第 3–8 行：`TaskOutcomeExecutionStatus`（含 `unknown`）、`TaskRequirementStatus = 'passed' | 'failed' | 'unverified' | 'blocked'`、`TaskOutcomeStatus`（含 `unknown`）、`TaskEvidenceStatus`。
- 第 50–63 行：`TaskOutcome` 把 `execution.status`、`requirementInventory`（第 57 行，`'complete' | 'partial' | 'unknown'`）、逐项 `requirements`、`evidence`、`artifacts`、整体 `status`、`remaining` 分开表达。
- 第 66–78 行：`unknownTaskOutcome()` 是旧 Run 的保守读值（`status: 'unknown'`、`requirementInventory: 'unknown'`、空数组、`remaining: [{ legacy_outcome_unavailable }]`）。
- 第 186–188 行：`parseTaskOutcome` 拒绝"`status === 'completed'` 但 inventory 非 `complete` / 有未通过要求 / 有 remaining"的输入 → **契约层面保证"未识别清单不可能被持久化成 completed"**。

因此 `unknown`（整体）与 `unverified`（逐项）在数据层是清晰的、不可伪造的；本缺陷不在数据层。

### 1.5 Renderer 展示实现（本次评审对象）

| 文件 | 关键行 | 作用 |
|---|---|---|
| `packages/app/src/renderer/chat/task-outcome-card.tsx` | 13–131 | 结果卡片主组件 |
| 同上 | 22–33 | "缺少验收记录"分支：`is-unknown` class、`aria-label="任务验收结果"`（25）、徽标 `缺少验收记录`（28）、文案 `文件写入操作成功不代表内容已通过检查；当前没有可回溯的独立检查结果。`（30） |
| 同上 | 35–37 | `inventoryLabel`：`complete→验收清单已识别`、`partial→验收清单不完整`、否则 `验收清单无法确认` |
| 同上 | 39–47 | `completed = activity.status === 'done' && outcome.status === 'completed'`；class `is-completed` / `is-unresolved`（41）；徽标 tone `good` / `muted`（44） |
| 同上 | 53、83、109 | 要求验收 / 产物 / 剩余工作三节**都以 `length > 0` 为前提**，空则整节不渲染 |
| 同上 | 125–128 | 兜底：`outcome.status === 'unknown'` 且无要求无产物且有成功文件写入时，显示 `没有可展示的要求验收记录；文件写入成功本身不代表内容已通过检查。` |
| 同上 | 133–152 | 证据 `<details>/<summary>` 折叠列表 |
| `packages/app/src/renderer/chat/task-outcome-presentation.ts` | 6–11 | 徽标表：`passed→已验证通过/good`、`failed→检查未通过/danger`、`unverified→尚未验证/`**`muted`**、`blocked→检查受阻/blocked` |
| 同上 | 13–28 | 原因文案表（含 `requirements_unknown→无法确认完整的要求清单`、`no_independent_check→尚未执行独立检查`） |
| 同上 | 48–61 | `taskOutcomeStatusLabel`；`unknown` 落到第 59 行默认分支 `无法确认目标是否全部满足` |
| 同上 | 74–79 | `hasSuccessfulFileMutation`：要求 `tool.name === 'write' \|\| 'edit'` 且 `ok === true` 或 `invocationStatus === 'succeeded'` |
| 同上 | 81–92 | `shouldShowTaskOutcome`；**第 90 行**：`if (outcome.status === 'unknown') return hasSuccessfulFileMutation(activity)` |
| `packages/app/src/renderer/chat/assistant-turn.tsx` | 159–176 | 终态消息容器 |
| 同上 | 163–167 | `Markdown` 渲染模型最终回复；第 165 行 `aria-live` 仅在 `status === 'running'` 时为 `polite` |
| 同上 | 171 | `TaskOutcomeCard` 渲染在最终回复**之后** |
| 同上 | 151–154 | 可折叠过程面板 `assistant-process-content`；结果卡片在 159–176 容器内，**不在此折叠面板内** |
| 同上 | 131 | `ActivityAttentionRow`（在折叠面板外） |
| `packages/app/src/renderer/chat/attention-row.tsx` | 1–7、15–27 | 不可被折叠隐藏的事实行；`role="status"`（23）；仅当 `activityAttentionLine` 非空才渲染 |
| `packages/app/src/renderer/chat/activity-visibility.ts` | 96–126 | attention line 组装 |
| 同上 | 121–123 | 注释明确：`An unverified acceptance is a neutral fact on the turn's status trigger, not a warning by itself.`；且仅当已有其他 parts 或存在 `fail`/`needs_replan` 时才把验证行并入 |
| `packages/app/src/renderer/chat/activity-model.ts` | 241–248 | 旧 VERIFY 记录文案：`unverified→未验证`；`pass→旧版 VERIFY 记录通过（不代表任务验收）` |
| `packages/app/src/renderer/styles/08-activity.css` | 772–782 | 卡片：`font-size: 12px`、普通边框、无状态色 |
| 同上 | 803–807 | `.task-outcome-meta, .task-outcome-reason` 为 `var(--muted)`、`11px` |
| 同上 | 837–846 | 徽标 `10px` 胶囊 |
| 同上 | 848–866 | `good` 用 `--success`；`danger` 用 `--feedback-danger-text`；`blocked` 用 `--warning`；**`muted` 用 `var(--muted)` + `var(--control-hover)`** |

**样式覆盖缺口（已用 grep 验证）：** 字符串 `is-completed` / `is-unresolved` / `is-unknown` 在整个 `packages/app/src/renderer` 内**只出现在 `task-outcome-card.tsx` 第 25、41 行**，在任何 `.css` 中都没有对应规则。也就是说，`completed` 与 `unresolved` 之间**没有任何卡片级视觉差异**，区别仅来自徽标文案与 tone（`good` vs `muted`）。

### 1.6 既有测试与 Electron 验收脚本的覆盖边界

- `packages/app/src/renderer/chat/task-outcome-card.test.ts`
  - 第 75–84 行：断言 `unverified` 渲染 `尚未验证` + `没有独立内容检查`，且不含 `已验证通过`。
  - 第 117–122 行：旧 Run 有成功 `write` 时显示 `缺少验收记录` + `文件写入操作成功不代表`；`taskOutcome: undefined` 且无写入时渲染为空串。
  - **没有任何用例构造 `status: 'unknown'` + `requirementInventory: 'unknown'` + 空 requirements 的 DELIV-02 形状。**
- `packages/app/src/renderer/chat/task-outcome-presentation.test.ts`
  - 第 11–13 行：`unknownTaskOutcome` + 普通对话 → `shouldShowTaskOutcome === false`。
  - 第 14–20 行：仅当存在成功文件写入时才为 `true`。
  - 第 24–27 行：`running` / `waiting_user` 时为 `false`。
  - 第 30–35 行：把 `unknownTaskOutcome` 的 `status` 改为 `partially_completed` 且仅含一个 `failed` 要求，断言文案为 `仍有要求未满足或未验证`——该用例保护的是 `partially_completed` 分支（`task-outcome-presentation.ts:53–56`）；纯 `unknown` 走第 59 行默认文案 `无法确认目标是否全部满足`，**没有专门的组件用例**。
- `packages/app/src/renderer/chat/activity-visibility.test.ts`
  - 第 183–187 行：明确断言 `unverified` 在干净 Run 上是**中性**的——`activityAttentionLine(clean)` 为 `null`，只有 `activityVerificationLine` 为 `验证：未验证`。
- `scripts/verify-task-outcome-renderer.mjs`（真实 Electron + 受控 HTTP Provider）
  - 第 20–24 行 limits 自述：`The check proves the narrow explicit root-level text requirement contract only.`
  - 第 64–68 行：仅 3 个可见场景 `passed` / `failed` / `unverified`，全部使用**能被解析器识别**的 `Create <file>, content must be <text>.` 措辞。
  - 第 74–76 行：非 `passed` 场景必须**不含** `已按明确的验收条件通过`。
  - 第 138–141、144、149–157 行：普通对话不产生空卡片；重载后每个 Run 一张卡片。
  - **没有 inventory=unknown + 成功写入 + 虚假完成声明的场景。** 因此现有 Electron 验收不覆盖 DELIV-02 形状。

## 2. 直接回答：现有 Renderer 是否足够明确地表达"模型完成声明 ≠ 可信验收通过"？

**结论：部分足够（partially sufficient）。**

结构化事实是正确且可见的：Runtime 保守给出 `unknown` / `unverified`，卡片文案没有把成功写入说成验收通过，`parseTaskOutcome` 也从契约上阻止 `unknown` 清单变成 `completed`（`packages/types/src/task-outcome.ts` 第 186–188 行）。缺陷不在"是否说谎"，而在**"正确的话说得太轻、且没有正面反驳模型声明"**。

### Q1 `unknown` Outcome / `unverified` Requirement 是否有显著、不可被模型自然语言淹没的表达？

**部分满足。**

有表达：
- 徽标 `尚未验证`（`task-outcome-presentation.ts:9`）、`无法确认目标是否全部满足`（同文件第 59 行）、`验收清单无法确认`（`task-outcome-card.tsx:37`）、`无法确认完整的要求清单`（`task-outcome-presentation.ts:20`，经 `task-outcome-card.tsx:109–123` 渲染）。

不够显著：
- `unverified` 的 tone 是 `muted`（`task-outcome-presentation.ts:9`），CSS 落到 `var(--muted)` 文字色 + `var(--control-hover)` 背景（`08-activity.css:863–866`）——与普通元信息同级，而非警告色（`blocked` 才用 `--warning`，第 858–861 行）。
- 徽标字号 `10px`（`08-activity.css:844`），卡片正文 `12px`（第 781 行），原因行 `11px` 且 `var(--muted)`（第 803–807 行）。
- `completed` / `unresolved` 无卡片级样式（见 1.5 样式缺口），整体形状与"普通信息面板"一致。
- 中性化是**既有设计决定**并有测试保护（`activity-visibility.test.ts:183–187`；`activity-visibility.ts:121–123`），因此未验证事实**不会**进入 `ActivityAttentionRow` 的 `role="status"` 通道（`attention-row.tsx:23`）。

判定：文案充分，视觉权重不足；在最终回复是一句自信断言时，"淹没"风险真实存在。

### Q2 是否存在把模型最终回复（"已完成"）与 Runtime 验收状态混淆的界面风险？

**存在，共 4 条具体风险；同时有 2 条正向事实应如实记录。**

风险：
1. **顺序与排版不对称。** 模型最终回复以正常 Markdown 正文字号渲染在前（`assistant-turn.tsx:167`），结果卡片在其后、`12px`、`muted` 配色（`assistant-turn.tsx:171`；`08-activity.css:772–782`、`803–807`）。DELIV-02 的回复原文是 `... The task is complete.`（`test/s3b-task-adapters.test.ts:365`），断言在前、限定在后。
2. **徽标 tone 与中性信息同级。** `unknown` 整体状态使用 `muted` 徽标（`task-outcome-card.tsx:44`），与 `尚未验证` 同 tone（`task-outcome-presentation.ts:9`），没有"未验收"这一独立、可扫描的标签。
3. **卡片从不引用/反驳模型声明。** `task-outcome-card.tsx` 全文没有任何"模型声称/最终回复/完成声明"相关文案；用户必须自己把上下两段文本对照，界面没有替用户完成这一步。
4. **无文件写入时整卡消失。** `shouldShowTaskOutcome` 第 90 行对 `status === 'unknown'` 只在存在成功 `write`/`edit` 时才返回 `true`，且 `task-outcome-presentation.test.ts:11–13` 断言该行为。于是"执行已结束但清单未知"的非文件类任务**完全不显示未验收提示**——这是最接近"留空"的情形。

正向事实（不应被误判为缺陷）：
- 不存在整轮成功配色：CSS 中 `.assistant-turn` 相关规则只有 3 处（`08-activity.css` 第 3、403、768 行），**没有 `.assistant-turn.done` 成功态样式**。
- 结果卡片不在可折叠过程面板内（折叠面板为 `assistant-turn.tsx:151–154`，卡片在 `159–176`），因此用户折叠过程**不会**隐藏卡片。

### Q3 当 Requirement inventory 为 `unknown` 时，界面是否明确说明"未验收"而非留空？

**在卡片被渲染的前提下：是，明确说明；但缺少统一命名为"未验收"的标签，且卡片可能整体不渲染。**

- 明确说明的三处：`验收清单无法确认`（`task-outcome-card.tsx:37`）、`剩余工作 → 无法确认完整的要求清单`（`task-outcome-presentation.ts:20` + `task-outcome-card.tsx:109–123`）、空清单兜底 `没有可展示的要求验收记录；文件写入成功本身不代表内容已通过检查。`（`task-outcome-card.tsx:125–128`）。
- 但整体状态徽标文案是 `无法确认目标是否全部满足`（`task-outcome-presentation.ts:59`），语义正确却不是"未验收"这一显式结论词。
- 对 DELIV-02 形状（有成功写入）卡片会出现（依据 1.5 第 90 行 + `hasSuccessfulFileMutation` 第 74–79 行）；对无成功写入的 unknown，卡片整体不渲染 → 属于"留空"。
- 另注：第 22–23 行的"缺少验收记录"分支只对 `execution.reasonCode === 'legacy_outcome_unavailable'` 生效；DELIV-02 的 `execution` 为 `completed` 且无 `reasonCode`（`packages/runner/src/task-outcome.ts` 第 176–179 行只在非 completed 时写 reasonCode），因此走主分支而非该分支。

### Q4 空/未知状态的可访问性（role/aria-live/文本等价）是否充分？

**部分满足。**

- 有名称：`<section aria-label="任务验收结果">`（`task-outcome-card.tsx:25`、`41`）。
- 文本等价：所有状态都有 DOM 文本，无纯图标表达；证据为原生 `<details>/<summary>`（`task-outcome-card.tsx:71–72`），键盘可达。
- 缺播报：卡片自身**没有** `role="status"` 或 `aria-live`；`assistant-turn.tsx:165` 的 `aria-live` 仅在 `status === 'running'` 时为 `polite`，终态结算时变为 `undefined`。因此卡片出现/内容确定时不会被读屏播报。
- 唯一具备 `role="status"` 的不可折叠通道是 `ActivityAttentionRow`（`attention-row.tsx:23`），但它只在 `activityAttentionLine` 非空时渲染，而 `unverified` 被有意排除（`activity-visibility.ts:121–123`）→ **本缺陷不经过该可访问性通道**。
- 徽标与原因文案之间没有 `aria-describedby` 关联。

## 3. 缺陷分级与影响面

| 维度 | 判定 |
|---|---|
| 严重度 | **中高**：不产生错误数据，但可能让用户把虚假完成声明读作验收通过 |
| 层级 | 呈现层（视觉权重 + 文案缺失 + 可访问性），叠加"严格解析器覆盖不足"这一上游成因 |
| 影响面 | 所有"清单未识别或未验证、但执行正常结束"的 Run；含文件写入时卡片弱提示，不含文件写入时完全无提示 |
| 数据正确性 | 无缺陷：契约拒绝 `unknown` 清单成为 `completed`（`packages/types/src/task-outcome.ts:186–188`）；Runtime 保守返回 `unknown`（`packages/runner/src/task-outcome.ts:163`、`168`） |
| 可回归性 | 现有 25 项组件测试全部通过（本次只读复跑），但**没有任何用例覆盖 DELIV-02 形状**，`scripts/verify-task-outcome-renderer.mjs` 亦未覆盖（第 64–68 行） |
| 与既有决策的张力 | `unverified` 保持中性是既有设计并被测试保护（`activity-visibility.test.ts:183–187`）；修复必须显式重审该决定，而不是静默改掉 |

## 4. 与"严格文件要求解析器覆盖不足"的关系

两者是**串联成因**，不可互相替代：

1. **上游（解析器）**：`packages/runner/src/task-outcome-request.ts:20` 的窄正则 + 第 46–71 行的 2–3 行清单，只覆盖"创建/Create + 文件 + 逗号 + 内容必须为/content must be"完整单句。DELIV-02 原文（`test/s3b-task-adapters.test.ts:368`）不匹配 → inventory=unknown（`packages/runner/src/task-outcome.ts:69`）→ status=unknown（第 163 行）→ remaining 增加 `requirements_unknown`（第 168 行）。
2. **下游（呈现）**：界面把该 `unknown` 表达为 muted 徽标 + 小字说明，且不含对模型声明的正面反驳，还在无文件写入时隐藏整卡 → 虚假完成声明没有被界面显式否定。

外部 Oracle 的归因与此一致：主因 `insufficient_verification`，次因 `strict_requirement_parser_did_not_recognize_task_text`（受控记录 `failureAttribution`；`docs/reference/rcd-s3b-evaluation-report-2026-10-17.md` 第 36 行；第 71 行已把该风险归入"后续产品修复评审，不在 S3B 中修改生产 Runtime"）。

**本评审只针对下游呈现层。** 通用要求抽取属独立工作项（`rcd-s2c-b-task-outcome-2026-10-17.md` 第 77 行；`rcd-s2c-c-task-outcome-renderer`（已随历史文档清理移除）已明确"尚未覆盖完整的自然语言要求识别；inventory 不完整时必须继续保守显示"）。

## 5. 最小产品修复方案（本批不实施）

约束：只改结果展示与要求覆盖；**不重建 VERIFY Stage、不新增判定来源、不修改 Runtime/契约**。所有展示仍只消费 Runtime 权威 `TaskOutcome`。

### 候选 A（推荐）— "未验收"语义强化 + 声明对照，纯展示层

**组件级改动面（预计 3 文件 + 文案键）**

1. `packages/app/src/renderer/chat/task-outcome-presentation.ts`
   - 新增 tone `'unverified'`（`TaskOutcomeBadge.tone` 第 4 行扩展）。
   - 第 9 行 `unverified` 徽标改为 `{ label: '未验收', tone: 'unverified' }`；英文键名 `taskOutcome.badge.notVerified`。
   - 新增导出 `isAcceptanceUnverified(outcome): boolean`（`status === 'unknown' || requirementInventory !== 'complete'`），供卡片与测试共用。
   - **第 90 行**去掉 `hasSuccessfulFileMutation` 条件：`if (outcome.status === 'unknown') return true`，使"未验收"不再因缺少文件写入而消失（保留第 85 行 `outcome_pending_terminal_settlement` 与第 87–89 行 `legacy_outcome_unavailable` 的隐藏逻辑）。
   - 新增原因文案键 `model_claim_is_not_acceptance`（见第 3 点）。

2. `packages/app/src/renderer/chat/task-outcome-card.tsx`
   - 第 39–47 行：`completed` 之外再派生 `unverifiedAcceptance`，卡片加 `data-acceptance="unverified"`，徽标 tone 走新 tone。
   - 标题下新增一行（组件 `task-outcome-claim-note`）：
     中文建议：**「模型最终回复里的完成声明不构成验收通过；本 Run 没有可确认的独立检查结果。」**
     英文键名：`taskOutcome.claimDisclaimer`。
   - 第 41 行 section 增加 `role="status"`（或 `aria-live="polite"`），使终态出现时可被读屏播报。
   - 第 125–128 行的兜底文案保留，并把"没有可展示的要求验收记录"与新的声明对照行区分开，避免重复。

3. `packages/app/src/renderer/styles/08-activity.css`
   - 新增 `.task-outcome-badge.unverified`：`color: var(--warning)` + `color-mix(in srgb, var(--warning, #ca8) 12%, transparent)`，与 `blocked` 同色系但文案不同（不使用 `danger`，因为这不是已证实的失败）。
   - 新增 `.task-outcome-card[data-acceptance="unverified"]`：左侧 2px `var(--warning)` 竖条 + 略强边框。
   - **补齐当前完全缺失的** `.task-outcome-card.is-unresolved` / `.is-completed` 规则，使两种状态至少可区分。

**代价 / 风险**
- 代价：约 40 行代码 + 3 个文案键；不动 Runtime、不动契约、不动数据流。
- 风险 1：第 90 行放宽后，更多普通对话会出现卡片。缓解：保留第 85 行与第 87–89 行逻辑，普通对话（`unknownTaskOutcome` + 无写入）仍由第 84 行之后的 `actionableRemaining`/`status` 判定处理；需同步更新 `task-outcome-presentation.test.ts:11–13` 的断言（属**预期行为变更**，不是回归）。
- 风险 2：与"unverified 保持中性"的既有决定冲突（`activity-visibility.test.ts:183–187`）。需在本修复中显式重审：中性适用于**逐项未验证**，不适用于**整体未验收**；两者应分开措辞。
- 风险 3：`--warning` 变量在部分主题下可能回退（`08-activity.css:858–861` 已用 `var(--warning, var(--muted))`），需沿用同样的回退写法。

### 候选 B — 复用不可折叠的 attention 通道

**做法**：在 `packages/app/src/renderer/chat/activity-visibility.ts` 的 `activityAttentionLine`（第 96–126 行）中，当 `activity.status === 'done'` 且任务整体未验收时，把 `任务未验收` 加入 parts；文案复用 `attention-row.tsx:23` 既有的 `role="status"`。

**优点**：改动最小（2 文件、约 10 行）；天然获得 `role="status"` 播报与"折叠也藏不住"的性质（`attention-row.tsx:1–7` 注释）。

**缺点**：attention line 是单行拼接文本（`activity-visibility.ts:125`），信息密度低，仍然不引用模型声明；且直接推翻 `activity-visibility.test.ts:183–187` 保护的"中性"决定，需更慎重地重写该测试。

### 候选 C（不推荐，仅列出）— 重建 VERIFY Stage / 通用要求抽取器

**做法**：扩展解析器或引入第二阶段模型审阅来判定验收。

**优点**：能从根因上让 DELIV-02 措辞被识别。

**缺点**：成本与风险远高于本缺陷的用户可见部分；`rcd-s2c-b-task-outcome-2026-10-17.md:77`（S2C-C 呈现层报告已随历史文档清理移除） 已把通用抽取列为独立边界；且它并不能替代"界面必须把未验收说清楚"这一要求——即使解析器覆盖更广，仍会有无法识别与无法验证的 Run。

### 推荐：候选 A，并吸收候选 B 的一小部分

**理由**：改动面最小、直接消除"声明主导 vs 限定弱化"的视觉不对称、不引入任何新的判定来源（继续只消费 Runtime 权威 `TaskOutcome`）、且可以被既有组件测试与 Electron 验收脚本直接覆盖。候选 B 的 `role="status"` 思路并入候选 A 的第 2.3 点即可，无需另起通道。

### 该修复如何阻止"模型声称完成即被读作通过"

1. 未验收徽标从 `muted` 升为显式警告色，并固定命名为 **「未验收」**，不再与普通元信息同级。
2. 在最终回复正下方显式写出 **「模型最终回复里的完成声明不构成验收通过」**，把矛盾放在用户视线路径上，而不是要求用户自行对照。
3. 未验收不再因"没有成功文件写入"而隐藏整卡 → 覆盖非文件类任务。
4. 未验收卡片进入 `role="status"` 播报路径 → 读屏用户同样收到，不再依赖视觉对比度。

## 6. 复现路径（当前版本，只读）

1. 受控运行：`node scripts/s3b-eval.mjs --run-controlled --task=DELIV-02`（记录于受控基线第 1151 行；需 Electron/受控 Provider 环境）。
2. 等价的 Runner 层复现（不依赖 Electron）：运行 `test/s3b-task-adapters.test.ts` 的 DELIV-02 分支，观察 `test/s3b-task-adapters.test.ts:362–375`：写入 `goodbye`、`checkerInvoked === false`、`outcome.status !== 'completed'`、回复含完成声明。
3. 界面层复现（当前版本）：对 `status: 'done'`、`taskOutcome` 为 `unknown`（`requirementInventory: 'unknown'`、空 `requirements`/`artifacts`/`evidence`、`remaining: [{ requirements_unknown }]`）、`tools` 含一次成功 `write` 的 activity 渲染 `TaskOutcomeCard` → 预期得到 muted 徽标 `无法确认目标是否全部满足`、`验收清单无法确认`、`无法确认完整的要求清单`、兜底句；**不会**出现 `已验证通过`，也**不会**出现"未验收"字样或对模型声明的反驳。
4. 变体：把 `tools` 置空 → `shouldShowTaskOutcome` 返回 `false`，卡片整体消失（`task-outcome-presentation.ts:90`；`task-outcome-presentation.test.ts:11–13`）。

**本次已执行的只读验证**：`pnpm exec vitest run packages/app/src/renderer/chat/task-outcome-card.test.ts packages/app/src/renderer/chat/task-outcome-presentation.test.ts packages/app/src/renderer/chat/activity-visibility.test.ts` → 3 个文件、**25 项通过**。这证明第 1.5/1.6 节描述的现有行为成立，也证明现有用例不覆盖 DELIV-02 形状。

## 7. 未来修复的验收方式（本批不执行）

### 7.1 组件级（快速、必做）

命令：
`pnpm exec vitest run packages/app/src/renderer/chat/task-outcome-card.test.ts packages/app/src/renderer/chat/task-outcome-presentation.test.ts`

新增断言方向（DELIV-02 形状，`activity.status = 'done'`，`tools` 含 `ok: true` 的 `write`）：

- 卡片 innerText 包含 **`未验收`** 与 **`模型最终回复`**（英文键 `taskOutcome.badge.notVerified` / `taskOutcome.claimDisclaimer`）。
- 卡片 innerText **不包含** `已按明确的验收条件通过`（对齐 `scripts/verify-task-outcome-renderer.mjs:74–76` 的既有原则）。
- 卡片节点存在 `role="status"`（或 `aria-live`）。
- 变体断言：`tools` 为空时 `shouldShowTaskOutcome` 仍为 `true`（覆盖第 5 节候选 A 的第 90 行改动），并同步更新 `task-outcome-presentation.test.ts:11–13`。
- 回归断言：`requirementInventory: 'complete'` + 全 `passed` 时仍显示 `已验证通过` / `已按明确的验收条件通过`（防止修复过度收紧）。

### 7.2 Electron 端到端（呈现层真验收）

扩展 `scripts/verify-task-outcome-renderer.mjs` 第 64–68 行的 `visibleCases`，新增第 4 个场景：

- prompt 使用 DELIV-02 原句（`test/s3b-task-adapters.test.ts:368`）；
- 受控 Provider 预置 `write` 内容与要求不一致（对齐 `test/s3b-task-adapters.test.ts:364`）；
- 断言 `.task-outcome-card` 的 `innerText` 含 `未验收` 且不含 `已按明确的验收条件通过`；
- 断言卡片存在 `role="status"`。

该场景正好填补脚本第 20–24 行 limits 自述的覆盖缺口。

### 7.3 回归与类型

- `pnpm run typecheck`
- `pnpm run verify:task-outcome-renderer`（需 Electron 44.x 与受控 Provider 环境；若环境缺失，如实标注未运行，不推断通过）
- 若改动了 `shouldShowTaskOutcome`，重跑 `packages/app/src/renderer/chat/` 下全部结果卡片相关测试与 `packages/app/src/shared/history-activity.test.ts`（后者第 435–447 行覆盖历史回放的 Task Outcome 投影）。

### 7.4 明确不纳入本修复验收

- 通用自然语言要求抽取覆盖率（属独立工作项）。
- 真实 Provider 的模型推理质量。
- 物理鼠标 / 真实辅助设备的 Renderer 验收（现有脚本第 22 行已自述该限制）。

## 8. 未能证实或需标注的项

1. **DELIV-02 的用户原文不在受控记录 JSON 中。** 记录只保存摘要字段（第 1120 行起），原句只能从受控夹具 `test/s3b-task-adapters.test.ts:368` 取得。因此"原文措辞导致解析器不匹配"的结论由该夹具 + `packages/runner/src/task-outcome-request.ts:20` 的正则共同支撑，而非由受控记录直接给出。
2. **未在真实 Electron UI 中观测 DELIV-02 形状。** 本批不新增测试文件、不改代码，因此"卡片以 muted 徽标 + 兜底文案出现"是依据 `task-outcome-card.tsx:35–45`、`125–128`、`task-outcome-presentation.ts:59`、`81–92` 与 `packages/runner/src/task-outcome.ts:69`、`163`、`168` 的代码路径推断，未做像素或读屏观测。
3. **受控记录未保存完整 `TaskOutcome` 对象与逐调用工具明细。** "该 Run 存在一次成功 `write`，因而 `hasSuccessfulFileMutation` 为真、卡片会出现"由夹具 `test/s3b-task-adapters.test.ts:364` 与 `task-outcome-presentation.ts:74–79` 推断。
4. **`execution.reasonCode` 的取值未在记录中给出。** 本报告据 `packages/runner/src/task-outcome.ts:176–179`（仅非 `completed` 时写 reasonCode）判断 DELIV-02 走主分支而非"缺少验收记录"分支；若实际 `execution.status` 非 `completed`，则该 Run 会改走 `task-outcome-card.tsx:22–33` 分支，结论中"主分支 + muted 徽标"部分需相应修正。此点建议在实施修复前用一次真实 Electron 复跑确认。

## 9. 结论摘要

- **回答**：现有 Renderer **部分足够**——结构化事实正确、文案无虚假陈述，但视觉权重与文案都没有正面否定模型的完成声明，且"未验收"在无文件写入时会被整卡隐藏。
- **最小修复**：候选 A（presentation.ts 的 tone/可见性 + card 的"未验收"徽标与声明对照行 + CSS 状态样式与 `role="status"`），吸收候选 B 的不可折叠 `role="status"` 通道；不重建 VERIFY Stage、不改 Runtime 与契约。
- **本批边界**：仅产出本报告，未修改任何生产代码或既有文档。
