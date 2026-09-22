# VERIFY 内部边界

最后更新：2026-09-22 13:10:04

- `task-state.ts`：步骤完整性、失败类型、重规划目标和已完成证据保护。
- `routing.ts`：验证记录的持久化（只写脱敏证据）、单只读步骤与写后读回的结构性快速通道、证据缺口判断、局部重规划和达到上限后的用户决策路由。局部重规划只写回状态（`partialReplanRequest` + `verifyFeedback`）并把路由交回单一主循环 `execute`；DECIDE 已删除，路由不得再指向未注册 stage（`src/stage-routing-registry.test.ts` 守住这条不变量）。
- `structural-write-read.test.ts`：结构性写后读通道的回归。

`../verify.ts` 不再调用验证模型。它只断言 Runtime 证据能证明的事实：窄结构形态（单只读步骤、写后读回）判定为 `pass`；其余已完成的 run 记为 `unverified`（证据完整、全部调用成功、存在模型回复，但需要人工判断的验收标准未经验证），证据缺口或缺少 Provider 回复按未完成处理并进入有界恢复，任何记录到的失败都不能用 `pass` 绕过。
