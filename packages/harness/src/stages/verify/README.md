# VERIFY 内部边界

最后更新：2026-09-22 14:03:40

- `task-state.ts`：步骤完整性、失败类型、重规划目标和已完成证据保护。`runtimeExecutionEvidenceGap` 只把**不可用证据**算作缺口（调用被拒/校验失败/未知工具、结果缺失、输出截断、未结算副作用）；`recordedToolFailures` 单独列出**已记录的负结果**（`failed`/`timed_out`/`aborted` 调用与 `failed`/`cancelled` 副作用）。
- `routing.ts`：验证记录的持久化（只写脱敏证据）、单只读步骤与写后读回的结构性快速通道、证据缺口判断、局部重规划和达到上限后的用户决策路由。局部重规划只写回状态（`partialReplanRequest` + `verifyFeedback`）并把路由交回单一主循环 `execute`；DECIDE 已删除，路由不得再指向未注册 stage（`src/stage-routing-registry.test.ts` 守住这条不变量）。
- `structural-write-read.test.ts`：结构性写后读通道的回归。

`../verify.ts` 不再调用验证模型。它只断言 Runtime 证据能证明的事实：窄结构形态（单只读步骤、写后读回）判定为 `pass`；存在模型回复但记录了失败结果的 run 记为 `unverified`（发布模型回答、失败写入验证记录，永远不能成为 `pass`）；证据缺口或缺少 Provider 回复按未完成处理并进入有界恢复。实测依据：把记录到的失败当缺口会自动重跑 `execute`（每回合多 2 次请求，且重建出的提示更短、命中更低），并在恢复耗尽后把模型已经给出的回答替换成 Runtime 追问。
