# VERIFY 内部边界

最后更新：2026-09-23 22:30:00

- `task-state.ts`：步骤完整性、失败类型、重规划目标和已完成证据保护。`runtimeExecutionEvidenceGap` 只把**不可用证据**算作缺口（调用被拒/校验失败/未知工具、结果缺失、输出截断、未结算副作用）；`recordedToolFailures` 单独列出**已记录的负结果**（`failed`/`timed_out`/`aborted` 调用与 `failed`/`cancelled` 副作用）。**`tool result <id> is missing` 只有一个成立条件**：存在该 callId 的 invocation 记录却找不到对应结果（记录已发布、结果未写回，即执行被截断）；其余情况各有独立文案（状态被拒、重复 callId、证据裁剪、副作用未结算、副作用没有对应调用）。
- `task-state.ts` 的**计划证据只对本次 run 执行过的计划成立**：检查点恢复的计划是只读历史，所以 `runtimeExecutionEvidenceGap` 的两条步骤分支（步骤未完成、执行状态非 done）只在本 run 没有续跑标记时才生效。此前实现与这句注释相反，旧检查点续跑会把继承来的历史判成缺口，把 run 打回 `execute` 去重规划一个没有执行器能跑的步骤集，直到重规划预算耗尽再问用户。
- `task-state.ts` 的**继承证据**（`inheritedEffectEvidence`）：检查点持久化 `sideEffects` 但不持久化 `toolInvocations`，续跑的 run 从空 invocation 列表开始，因此上一轮结算过的副作用永远匹配不到本轮的 invocation。判定于是改为以检查点自己带过来的东西为据——旧检查点步骤里记过这次调用与结果（**成功或失败都算**），或账本条目本身已是终态（`succeeded`/`failed`/`cancelled`）——只有没有 callId、仍未结算，或本 run 根本没续跑时才报缺口。取证矩阵与先失败后通过的用例在 `evidence-gap.test.ts`。
- `routing.ts`：验证记录的持久化（只写脱敏证据）、单只读步骤与写后读回的结构性快速通道、证据缺口判断、局部重规划和达到上限后的用户决策路由。局部重规划只写回状态（`partialReplanRequest` + `verifyFeedback`）并把路由交回单一主循环 `execute`；DECIDE 已删除，路由不得再指向未注册 stage（`src/stage-routing-registry.test.ts` 守住这条不变量）。
- `structural-write-read.test.ts`：结构性写后读通道的回归；`evidence-gap.test.ts`：证据缺口的输入矩阵与续跑继承证据的回归（先失败后通过）。

`../verify.ts` 不再调用验证模型。它只断言 Runtime 证据能证明的事实：窄结构形态（单只读步骤、写后读回）判定为 `pass`；存在模型回复但记录了失败结果的 run 记为 `unverified`（发布模型回答、失败写入验证记录，永远不能成为 `pass`）；证据缺口或缺少 Provider 回复按未完成处理并进入有界恢复。实测依据：把记录到的失败当缺口会自动重跑 `execute`（每回合多 2 次请求，且重建出的提示更短、命中更低），并在恢复耗尽后把模型已经给出的回答替换成 Runtime 追问。
