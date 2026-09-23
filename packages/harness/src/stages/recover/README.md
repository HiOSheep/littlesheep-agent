# RECOVER 内部边界

最后更新：2026-09-23 21:52:00

- `policy.ts`：Runtime 自有的恢复策略——运行被中止、结构化解码失败的首次重试、未结算副作用判断、记录到的失败种类读取和目标阶段选择（`retry` / `escalate` / `abort`）。目标阶段只可能是仍注册的 stage：旧检查点记录到的 `decide` 等已退役 stage 名统一回到主循环 `execute`，避免以 `no stage registered` 结束运行。**`recordedFailureKinds` 在 TaskBook 步骤为空时改读单循环真正会写的证据**（invocation 的 `approval_denied`/`hard_denied`/`approval_unavailable`/`core_source_read_only` 状态与 `lastError` 文本，复用 `execute/failure-policy.ts` 的 `classifyStepFailure`）：步骤执行器删除后没有任何东西再写 `taskExecution`，旧实现因此对每个普通 run 都返回空种类，权限拒绝与取消分支永久失效，所有失败一律重试到预算耗尽。
- `escalation.ts`：升级时交给用户的三件事实——停下的**原因类别**（权限不足 / 资源缺失 / 证据不可恢复 / 副作用未结算 / 恢复预算耗尽 / 已中止 / 执行无法继续）、**已经完成了什么**（调用与副作用的计数与状态、是否存在未发布草稿；只有计数与状态，不含路径、正文或标识）、以及**继续所需的条件**。`../recover.ts` 把它们写进 `clarificationRequest`，可见文案仍由 `ASK_USER` 用真实模型调用撰写——Runtime 不替模型措辞，但也不让模型去猜是哪种阻塞。

`../recover.ts` 不再请求恢复模型：决策只由记录到的事实推导（可重试 → 回到失败阶段，权限拒绝 → `ASK_USER`，副作用未结算或被中止 → 显式停止并只呈现 Runtime 状态），重试受 `maxRecoveryAttempts` 约束，预算耗尽强制升级到 `ASK_USER`，也没有"修订计划"或模型撰写的用户文案。绑定续接的一次确定性重试由 Runtime 消费一次，已完成步骤不重复执行；用户可见文字仍只来自 `ASK_USER` 的真实模型调用或 Runtime 状态。同一阻塞重复升级时仍只给同一组选项（幂等由回复 settlement 保证），但每次都会带上当次的原因、已完成部分与所需动作，而不是把同一句三选一原样再问一遍。
