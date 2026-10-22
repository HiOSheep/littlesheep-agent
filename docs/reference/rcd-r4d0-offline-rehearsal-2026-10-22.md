# RCD R4-D0 离线端到端演练报告

**协议版本：** `1.0.0`　**演练批次：** `r4d0-offline-rehearsal-2026-10-22`　**证据层级：** `A_runtime_deterministic`（本地 scripted Provider）

> 本演练未调用真实 Provider、未使用真实凭据、未授权任何付费试验。演练结果为评测机制证据，不代表模型能力。

## 计划与执行

- 计划试验：20（4 任务 × Trial 1–5）；实际执行：20。
- 通过 / 能力失败 / 未解决 / 基础设施失败：20 / 0 / 0 / 0。
- 产品 SHA：`7eabdab36ac435148320fa7e55306f9d8025e318`；评测器指纹：`56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4`。

## 三维度指标（仅受控演练）

| 指标 | 分母 ID | n | 通过 | 失败 | 排除 |
|---|---|---:|---:|---:|---|
| goal | A_runtime_deterministic:goal | 20 | 20 | 0 | — |
| contract | A_runtime_deterministic:contract | 5 | 5 | 0 | not_applicable=15 |
| mechanism | A_runtime_deterministic:mechanism | 5 | 5 | 0 | not_exercised=15 |

N=20 属初步故障发现样本；`populationClaim=false`，不得据此声称稳定的总体任务成功率。

## 逐试验证据

| 记录 | 任务 | trial | 分类 | Goal | Contract | Mechanism | 逻辑/物理请求 | 工具执行 | 已结算 Effect | 耗时 ms |
|---|---|---:|---|---|---|---|---:|---:|---:|---:|
| v2:r4d0-offline-rehearsal-2026-10-22:FILE-02-G:trial:1 | FILE-02-G | 1 | capability_pass | passed | not_applicable | not_exercised | 3/0 | 2 | 1 | 5278 |
| v2:r4d0-offline-rehearsal-2026-10-22:FILE-02-G:trial:2 | FILE-02-G | 2 | capability_pass | passed | not_applicable | not_exercised | 3/0 | 2 | 1 | 5115 |
| v2:r4d0-offline-rehearsal-2026-10-22:FILE-02-G:trial:3 | FILE-02-G | 3 | capability_pass | passed | not_applicable | not_exercised | 3/0 | 2 | 1 | 5258 |
| v2:r4d0-offline-rehearsal-2026-10-22:FILE-02-G:trial:4 | FILE-02-G | 4 | capability_pass | passed | not_applicable | not_exercised | 3/0 | 2 | 1 | 5065 |
| v2:r4d0-offline-rehearsal-2026-10-22:FILE-02-G:trial:5 | FILE-02-G | 5 | capability_pass | passed | not_applicable | not_exercised | 3/0 | 2 | 1 | 5071 |
| v2:r4d0-offline-rehearsal-2026-10-22:FILE-02-S:trial:1 | FILE-02-S | 1 | capability_pass | passed | passed | not_exercised | 3/0 | 2 | 1 | 5049 |
| v2:r4d0-offline-rehearsal-2026-10-22:FILE-02-S:trial:2 | FILE-02-S | 2 | capability_pass | passed | passed | not_exercised | 3/0 | 2 | 1 | 5046 |
| v2:r4d0-offline-rehearsal-2026-10-22:FILE-02-S:trial:3 | FILE-02-S | 3 | capability_pass | passed | passed | not_exercised | 3/0 | 2 | 1 | 5145 |
| v2:r4d0-offline-rehearsal-2026-10-22:FILE-02-S:trial:4 | FILE-02-S | 4 | capability_pass | passed | passed | not_exercised | 3/0 | 2 | 1 | 5205 |
| v2:r4d0-offline-rehearsal-2026-10-22:FILE-02-S:trial:5 | FILE-02-S | 5 | capability_pass | passed | passed | not_exercised | 3/0 | 2 | 1 | 5228 |
| v2:r4d0-offline-rehearsal-2026-10-22:DELIV-01-G:trial:1 | DELIV-01-G | 1 | capability_pass | passed | not_applicable | not_exercised | 2/0 | 1 | 1 | 2527 |
| v2:r4d0-offline-rehearsal-2026-10-22:DELIV-01-G:trial:2 | DELIV-01-G | 2 | capability_pass | passed | not_applicable | not_exercised | 2/0 | 1 | 1 | 2593 |
| v2:r4d0-offline-rehearsal-2026-10-22:DELIV-01-G:trial:3 | DELIV-01-G | 3 | capability_pass | passed | not_applicable | not_exercised | 2/0 | 1 | 1 | 2625 |
| v2:r4d0-offline-rehearsal-2026-10-22:DELIV-01-G:trial:4 | DELIV-01-G | 4 | capability_pass | passed | not_applicable | not_exercised | 2/0 | 1 | 1 | 2552 |
| v2:r4d0-offline-rehearsal-2026-10-22:DELIV-01-G:trial:5 | DELIV-01-G | 5 | capability_pass | passed | not_applicable | not_exercised | 2/0 | 1 | 1 | 2623 |
| v2:r4d0-offline-rehearsal-2026-10-22:DELIV-01-R:trial:1 | DELIV-01-R | 1 | capability_pass | passed | not_applicable | passed | 3/0 | 1 | 1 | 2656 |
| v2:r4d0-offline-rehearsal-2026-10-22:DELIV-01-R:trial:2 | DELIV-01-R | 2 | capability_pass | passed | not_applicable | passed | 3/0 | 1 | 1 | 2747 |
| v2:r4d0-offline-rehearsal-2026-10-22:DELIV-01-R:trial:3 | DELIV-01-R | 3 | capability_pass | passed | not_applicable | passed | 3/0 | 1 | 1 | 3059 |
| v2:r4d0-offline-rehearsal-2026-10-22:DELIV-01-R:trial:4 | DELIV-01-R | 4 | capability_pass | passed | not_applicable | passed | 3/0 | 1 | 1 | 2662 |
| v2:r4d0-offline-rehearsal-2026-10-22:DELIV-01-R:trial:5 | DELIV-01-R | 5 | capability_pass | passed | not_applicable | passed | 3/0 | 1 | 1 | 2702 |

## 隔离、预算与停止条件

- PASS：unique-record-identities — 20/20 unique record ids
- PASS：unique-record-paths — 20/20 distinct record files
- PASS：trial-cleanup — 0 cleanup failures
- PASS：one-trial-per-identity — 4 tasks x trials 1-5, no duplicate (batch, task, trial)

- PASS：per-trial-request-budget — every executed trial stayed inside its per-trial caps
- PASS：batch-request-budget — logical=55, physical=0, observedOutputTokens=0
- PASS：usage-unavailable-preserved — scripted Provider reports no Provider usage/cost; records keep unavailable

## 失败分类与拒绝路径

- PASS：capability-contract-failure-detected — wrong-field variant: Goal passed / Contract failed, detected as a capability failure without changing the task prompt
- PASS：capability-mechanism-failure-detected — no-recovery fault: Goal and Mechanism independently failed while the exception stayed localized
- PASS：infrastructure-failure-classified-not-capability — invalid task/adapter failure exits non-zero; it is recorded as infrastructure failure and never enters capability denominators
- PASS：duplicate-run-refused — repeating an existing (batch, task, trial) identity is refused instead of overwriting history
- PASS：budget-stop-without-raising-budget — simulated per-trial/batch overage stops the batch; no code path increases the budget to finish N=5
- PASS：authorization-gate-closed — protocol freeze reports no real authorization; rehearsal evidence tier remains A

## 结论

离线批次调度、trial 隔离、记录落盘、失败分类、重复运行拒绝与预算停止演练通过。真实 Provider 费用上限、真实模型执行适配器与用户授权仍未就绪，因此本演练不构成付费试验的 Go。

