# RCD S2A — 持续执行与任务交付契约设计

**状态：** S2A 审计与设计完成；未实施 S2B/S2C 生产行为。  
**审计基线：** `0472bc4b1e73ddcc7127139f1a4bd1e6330f173d`（S1C 后源码，审计开始时工作树干净）。  
**结论：** 当前系统支持单次有界 Run、耐久 checkpoint 与用户发起的新 Run 恢复；它没有同一 Run 内跨段自动续接。L01 在第 30 个工具循环边界停止，35 项工作完成 30 项，结果为部分完成。S2B 应复用当前 Runner/Harness 和 checkpoint，在同一 Run 预算内实现有界续接；S2C 等 VRS 结算迁移确定后再接入成果交付。

## 1. 审计范围与事实边界

本报告针对 S1C 提交后的源码状态。VRS 的 V2A checkpoint 兼容工作已完成；V2B（迁移证据结算并移除独立 VERIFY Stage）在本报告编写时仍在另一工作树实施。因此本报告冻结接口与行为，不修改 VRS 正在调整的 Runner 结算、验证和持久化链路。

本次定向回归运行了 Harness 执行、模型 usage 观测、Runner checkpoint 三组测试：3 个测试文件、66 项通过。RCD 的 L01 机器记录提供了 30/35 的实际边界证据，但其执行层级是 Harness `execute` 主循环加 scripted Provider 与 fixture tool，并非完整 Runner / Electron 任务验收。两种证据不混称。

## 2. 当前 Runtime 生命周期

当前主路径为：

`Runner prepare → Harness durable stage driver → execute 主循环与 Tools → verify/finalize → Runner 持久化`

Runner Coordinator 固定 `prepare → execute → finalize → persist` 四个阶段；Harness durable driver 在单次 `run(ctx)` 中调度受允许图约束的 stage，并为每次 stage transition 写入幂等事件。当前实现没有“一个 Run 中多个 Execution Segment”的 Runner 概念或自动续接回边。执行阶段到达 `verify` 后，当前一次 Harness 调度不会因为工作仍有剩余而自动重新进入下一段。

| 问题 | 当前实现与证据 | S2A 结论 |
|---|---|---|
| 逻辑任务与单次调用 | `runId` 标识 Runner 管理的持久运行；模型请求有独立 request snapshot/id；工具调用与 side effect 有各自身份。显式用户续接会创建新的 Run，而不是延长原 Run 的预算。 | 自动跨段必须保留同一 `runId`，不能借新 Run 刷新额度。 |
| 工具循环上限 | `MAX_TOOL_LOOP_ITERATIONS = 30`；`reserveToolLoopIteration` 把已用轮数写入 RunContext runtime state。预算耗尽且已有工具结果时，允许一次受限 final-answer 请求，随后停止工具执行；再次越界失败。 | 30 是当前单段/单次循环边界，不是可信的全任务完成条件。 |
| 模型调用上限 | `recordPreparedRequest` 在模型请求准备前检查 `ctx.maxModelCalls`，并递增 `modelCallCount`；默认配置 32 次/Run。调用计数包含该 Run 内各 Harness stage 的模型请求，不只是工具循环。 | 自动续接不得重置或提高这个全 Run 上限。 |
| 无进展 | Harness 按工具结果证据指纹判断进展；连续 2 轮未增加可信证据后，停止提供可执行工具并要求模型给出受限答复。状态写入 runtime state，供 Run 内持续判断。 | 跨段不得重置该计数或指纹集合。 |
| L01 为什么是 30/35 | S1C 核心回归账本记录 30 次模型请求、30 次工具调用、30 个 fixture 文件、35 项需求；停止原因 `single_segment_iteration_budget_exhausted`，产品结果 `partially_completed`。账本 oracle 要求跨段完成，当前路径没有跨段回边。 | 这是现行行为限制的确定性复现，不是 Harness 基础设施失败。 |
| 预算耗尽后保留状态 | Runner 对中断、暂停、待澄清和失败结果建立 RunCheckpoint；记录 task progress、side effects、loop budget、模型 Context snapshot IDs、运行控制和恢复所需配置引用。RCD L01 自身是 Harness 层场景，没有验证 Runner checkpoint 的跨段续接。 | 有持久检查点不等于已有自动续接协议。 |
| 当前 checkpoint 能否自动续接 | checkpoint 能恢复 Run 相关状态；显式用户续接会经权威 checkpoint 路径创建新的 Run。`continuationLoopBudget` 把 attempts、工具循环次数、无进展计数、已用 cost 重置，并采用当前配置上限。 | 这是用户决定的新尝试语义；不能拿来实现同任务自动分段。 |
| 取消、暂停、steering、unknown | execute phase 在 abort 或 paused 状态停止；暂停/中断 checkpoint 可恢复。运行中用户消息由 Runtime event queue 在循环边界摄取；取消仍应终止执行。副作用恢复沿现有 effect identity / ledger 处理，unknown 不可通过新身份假装是干净的新操作。 | 段边界必须先检查取消、暂停、待处理用户指令和 unknown effect。 |
| Provider usage | usage 绑定实际模型请求 snapshot；接受一次回调，冲突会标记不完整；durable `model_response_received` / `model_request_settled` 事件以 `runId + requestId` 作为稳定 idempotency key。没有可靠 Provider usage 时保留 unavailable。 | 各段沿用原 Run 的请求序列和事件去重；重放回执不能再次加算。恢复后请求是否实际到达 Provider 不可确定时必须保留 unknown/unavailable 证据。 |
| 最终回复与 VERIFY | 当前状态图包含 execute → verify → finalize；Runner 再持久化 AgentResult、usage、工具调用、side effects、checkpoint 引用等。VRS 正在改造 VERIFY 与结算结构。 | S2A 只要求 Execution Status、Verification Evidence、Task Outcome 分离；不再设计或实现第二个 VERIFY。 |

源码入口：[Runner Coordinator](../../packages/runner/src/runner-coordinator.ts)、[Runner execute/checkpoint 写入](../../packages/runner/src/runner-execute.ts)、[Run checkpoint](../../packages/runner/src/run-checkpoint.ts)、[Harness durable driver](../../packages/harness/src/durable-harness.ts)、[工具循环预算](../../packages/harness/src/stages/execute/iteration-budget.ts)、[Provider usage 观测](../../packages/harness/src/model-observability.ts)、[Core Flow 状态契约](core-flow-state-contract.md)。

### L01 失败证据

[S1C 六项核心回归账本](rcd-s1c-core-regression-2026-10-16.json)中 L01 的执行层级为 `harness_execute_stage_real_main_loop_with_scripted_provider_and_fixture_tool`。记录为：`modelRequests=30`、`requiredOperations=35`、`completedOperations=30`、`loopBudget=30`、`toolFailures=0`、`completedFixtureFiles=30`，停止原因 `single_segment_iteration_budget_exhausted`，结果 `partially_completed`。Provider usage 为 `unavailable`。因此这证实了当前 Harness 单段边界；它没有证明完整 Runner 自动续接、真实 Provider 成本或 Electron 行为。

## 3. S2A 冻结的最小语义

### Run

继续复用 Runner 当前持久 Run。它拥有 `runId`、用户控制、当前权限、checkpoint、durable events、模型请求序列、预算消耗和副作用身份。S2B 不创建新的执行器或第二个 Harness。

### Execution Segment

一个有界的 Harness execute 主循环片段。段结束是控制权交还 Runner/现有编排边界的内部状态，不是新的 Run，也不是任务完成。每个段可以有局部迭代上限；段预算仅限制单段，不能重置任务/Run 总预算、无进展状态、授权消费或副作用保护。

### Task Outcome

对用户目标的结果描述，不启动新的模型循环。最小结果状态：

- `completed_with_evidence`：全部明确要求完成，并有适用证据支持。
- `partially_completed`：部分要求完成，至少一项剩余或未验证。
- `blocked`：必要权限、环境或安全前置条件阻止继续。
- `unverified`：存在执行产物或成功调用，但尚无足够证据确认目标完成。

该结果不得仅由模型自述决定。工具 exit code 0 只说明该调用成功；它不自动证明产物满足用户约束。VRS 最终结算类型未冻结前，这些状态作为接口语义，不要求 S2A 修改持久化类型。

### 预算关系

`segment allowance ≤ remaining Run allowance ≤ explicitly authorized Run ceiling`。

每个新段可用额度是以下剩余量的最小值：单段轮数、Run 剩余模型调用数、用户配置的工具调用/时间/成本上限、取消/权限/环境有效期。当前仓库有模型调用和循环轮次上限，并有可选 elapsed/cost 预算字段；尚无统一、显式的全任务工具调用额度。S2B 开始前应明确是否已有可复用配置；若没有，应以最小 Run budget 字段提供，而不能让“每轮工具数量”或新段数成为不受限资源。

消耗只在现有可信 Runtime / Provider / Tools 路径记账。模型或工具提供的计划不能生成预算，预算耗尽不能靠分段、checkpoint 恢复或改变调用身份重置。Provider usage 缺失时记录 `unavailable`，不估算成零成本。

## 4. 自动续接判定契约

仅在所有条件同时成立时允许自动开启下一段：

1. 本段以可续接的循环边界结束，而不是任务终止或安全错误。
2. 可信状态仍显示至少一项用户要求未完成。
3. Run 总预算仍有额度，且段预算预留成功。
4. 有新的、可信进展或具体可执行的后续步骤；重复证据不算进展。
5. 当前 Run 未取消，未暂停，未等待用户确认/澄清。
6. 当前宿主授权、精确工具作用域及环境仍有效；续接不产生新授权，也不扩大范围。
7. 没有阻塞后续操作的 `unknown`/`in_progress` 副作用。
8. 当前任务没有达到有证据支持的终止状态。

以下情况必须停止自动续接并按实际情况结算：用户取消；用户拒绝必要权限；总体预算耗尽；无进展上限到达；环境/授权失效；unknown effect 尚未解决；任务完成或状态无法验证。拒绝、取消、预算耗尽均不能由模型计划或新段重置。

### Checkpoint 与额度原子性

段交界必须保存同一个 Run 的当前消息/压缩 Context 引用、任务进度事实、已用预算、停止原因、用户控制状态、执行/副作用身份、usage 证据与下一段准入决策。写入下一段前，需要通过当前 Runner checkpoint/lease 的并发控制，原子地持久化段序号与预算预留；同一 checkpoint revision 或恢复请求重复提交不得二次发放额度。崩溃发生在预留后、请求前时，保守保留该预留，除非有可证明的“Provider 未触达”结算证据。

恢复必须以原 Run 和原副作用/模型请求身份核对状态。已 settle 的副作用不重放；unknown 不自动重试；恢复不刷新授权和预算。现有显式用户续接创建新 Run 的 allowance reset 继续表示用户新决定的尝试，不可复用为段切换路径。

## 5. Context、用户控制与执行事实

- Context 压缩只改变模型可见历史表示，不应清除 Run 预算、durable event cursor、证据指纹、授权消费或 effect identity。
- 运行中的用户消息在段边界前按现有 Runtime event queue 处理。只补充说明可应用为同一 Run 的 steering；用户改变任务目标需形成可信的新目标修订，并继续受旧预算约束。取消优先于续接。
- 暂停恢复保留原 Run 预算与授权状态；过期或撤销的授权重新检查，不能因 checkpoint 仍包含旧 capability snapshot 而继续执行。
- 模型生成的计划、清单和“已完成”声明只是待验证信息。实际工具调用、状态变化和验收证据通过现有 Tools / durable events 记录，不能由模型计划直接改写成完成事实。
- Shell 使用 S1B-F 精确命令与有界授权；Web 继续遵守 S1C 离线禁令及数据外传限制；Memory 的访问范围不能跨段扩大。

## 6. 与 VRS 的接口边界

三个维度相互独立：

| 维度 | 回答的问题 | 权威输入 |
|---|---|---|
| Execution Status | Runtime 是否实际执行、停止、失败或被阻断？ | Run/stage/tool 请求、durable events、停止原因 |
| Verification Evidence | 哪些检查在什么范围内得出什么证据？ | 可信检查结果、产物引用、检查范围与时间 |
| Task Outcome | 用户要求完成到什么程度？ | 目标要求与执行事实、适用验证证据的关联 |

S2B 的跨段边界只消费“当前 Run 是否可续接”以及已持久化的执行状态，不实现验证器或最终成果评级。VRS V2B/V2C 确定最终结算所有权及持久化后，S2C 将 Task Outcome 接入该结构。普通工具调用成功不等于 Task Outcome 完成；缺少验证证据时应为 `unverified`，不是通过。

## 7. T01–T08 可执行测试方案

以下测试方案均需通过现有 Runner/Harness 工具路径；不以直接调用预算 helper 作为端到端验收。S2A 不落地跨段生产代码，因此 T01 当前应保持红色/部分完成，不能把它改成静态成功断言。

| ID | 夹具与执行 | 主要断言 | 当前复用点 / 测试接缝 |
|---|---|---|---|
| T01 跨段连续执行 | 延用 RCD L01 临时 workspace 与 fixture tool，设每段 30 次、Run 总预算足够，目标 35 项。 | 同一个 `runId` 跨至少两段完成 35/35；用户无须再发继续；总模型/工具预算未越界，任务结果有证据。现行基线 30/35 应失败。 | `test/rcd-s0-adapters.test.ts` 的 `runL01` 是 Harness 层失败测试；S2B 应把同一场景提升到真实 Runner 注入点，不复制一套 Harness。 |
| T02 总体预算耗尽 | 允许段切换，但设置小于剩余任务需要量的 Run 模型/工具预算。 | 到全局额度后不创建新 allowance、不发 Provider 请求、不执行工具；产出部分完成/被阻断信息。 | `model-observability.test.ts` 的 call ceiling 与 Runner coordinator 的 segment boundary。 |
| T03 无进展防护 | Scripted Provider 重复相同工具调用和相同输出，无状态变化。 | 共享的 no-progress fingerprint 到限后禁止工具调用与新段，不形成无限续接。 | `tool-loop.ts` 现有两轮指纹逻辑；需在 Runner 路径观测跨段计数。 |
| T04 跨段恢复 | 第 1 段后持久 checkpoint；故障注入关闭并重新装配 Runner，使用同一 durable run 恢复。 | 已完成操作不重放；remaining work、Run budget、segment reservation、usage 与 side-effect identities 连续；重复恢复不重复发额度/调用。 | `runner-continuation.test.ts`、`run-checkpoint.test.ts`、durable effect recovery tests；需新增同 Run segment checkpoint seam，不能用“用户新 Run”替代。 |
| T05 用户取消与权限拒绝 | 在段边界注入 cancel；另一路拒绝下一操作所需授权。 | 下一段模型调用与工具副作用均为零；取消/拒绝为终止原因，不被自动审批或转为新段。 | Runtime event queue、Runner abort/pause 与 Shell/Web 授权现有测试。 |
| T06 命令成功但产物错误 | 工具执行命令返回 0，但产物内容/结构与任务约束不符。 | Execution Status 可为执行成功；Task Outcome 不能为 completed_with_evidence，缺少或不匹配证据时为 unverified/partial。 | S2C 与 VRS 结算结构依赖；测试通过真实工具临时文件观察，不以 exit code 当验收。 |
| T07 未验证的部分成果 | 多项要求中一部分有已观察产物，另一部分无检查证据。 | 逐项区分完成、未完成与未验证；最终回复不得将全部宣称为通过。 | RCD L01 的 30/35 观测作为边界夹具；VRS 最终 evidence schema 冻结后接入。 |
| T08 续接后 Usage | 多段 Provider 回调，注入重复 response/settled 回执，并做 checkpoint 恢复。 | 每个物理请求 usage 最多累计一次；重复回执不加算；缺少 Provider usage 保持 unavailable。 | `model-observability.test.ts` 的一次回调/冲突检查与 Runner usage durable event dedup；增加多段真实路径验收。 |

### 关键预期失败与现有证据

T01 的当前失败事实已由 L01 运行结果记录：30/35、30 个操作、单段预算耗尽。对 T02/T03/T05/T08 的基础安全性质，当前对应单元测试覆盖了模型调用 ceiling、两轮无进展、运行控制和 usage 去重；它们尚未验证“跨段”集成。T04 目前只有新 Run 显式续接的恢复语义测试，不存在同 Run 自动分段恢复证明。T06/T07 需要 VRS 最终结算契约，当前只冻结接口与测试夹具，不捏造通过结果。

## 8. S2B / S2C 实施拆分

### S2B — 有界持续执行

**生产边界：** Runner 对现有一次 Harness execute 调度建立有界段边界与续接判定；保留同一 `runId`、RunContext、lease、event queue 和工具权限链。更新 RunCheckpoint / durable events，只增加表达段序号、已消耗/预留全局额度及停止/续接决定所必需的最小字段。不得调用 `continuationLoopBudget` 刷新 allowance。

**重点模块：** `packages/runner/src/runner.ts`、`runner-coordinator.ts`、`runner-execute.ts`、`run-checkpoint.ts` / Store / restore 路径；`packages/harness/src/durable-harness.ts`、`stages/execute/iteration-budget.ts`、`tool-loop.ts`；相关 RunContext/checkpoint 公共类型。VRS V2B 修改 settle/finalize 时，先等其生产接口冻结，再改共有编排文件。

**验收：** T01–T05、原 L01 对照、暂停/恢复/并发 lease、S1A/S1B-F/S1C 安全边界、未知副作用和重复 checkpoint 回归。T01 需要 Runner 真实测试路径，不满足时明确标记未通过。

### S2C — 成果验收与交付

**生产边界：** 将用户目标要求、实际执行事实与 Verification Evidence 关联，形成 Task Outcome；在最终用户回复中分列已完成、部分完成、阻断和未验证事项。复用 VRS 完成后的结算事实与持久化，不创建第二个 VERIFY engine。

**重点模块：** VRS 确认的最终 settlement/evidence schema、Runner AgentResult 与 execution log/session summary 投影、用户回复组成逻辑和审计链接。目标/产物引用应稳定、可追溯且不将模型计划写成执行事实。

**验收：** T06–T08、产物不匹配、证据缺失、部分完成、Provider usage unavailable/replay、恢复后的结算一致性；另行运行真实 Electron 验收，不能用 Harness 单测替代。

## 9. 风险与未覆盖范围

- L01 是 scripted Provider 的 Harness 主循环测试；尚无同 Run Runner 自动跨段成功证据，也无真实付费 Provider 成本/usage 或真实 Electron 用户任务数据。
- 当前模型调用上限是 Run 范围，当前 checkpoint 用户续接有意重置该 allowance；S2B 若未实现原子 Run 级续接 ledger，会出现预算绕过风险。
- 当前没有统一全任务工具调用预算字段；S2B 必须决定并测试此额度的来源，不能只靠 30 轮循环上限推导工具调用总量。
- Provider 请求“已经触达但未收到回执”存在不确定性；必须沿用 request lifecycle unknown/unavailable，不能把恢复当作无成本新请求。
- 当前 VERIFY 的执行事实结算正在由 VRS V2B 迁移；S2C 的最终数据结构待该专项确认。
- S1C 对任意私有内容改写外传的风险仍须保持 S1C 安全限制；自动续接不可扩大 Web 输入或 Memory 权限。

## 10. 本次验证与提交

定向测试：

```text
pnpm exec vitest run packages/harness/src/stages/execute.test.ts packages/harness/src/model-observability.test.ts packages/runner/src/run-checkpoint.test.ts
3 files passed, 66 tests passed
```

该测试集验证当前单段预算、模型调用限制、usage 回调与 checkpoint 结构。S2A 没有新增或运行 S2B 跨段实现测试，因为本批不实现跨段生产代码。提交前另运行 `pnpm run check:repo` 与 `git diff --check`。

