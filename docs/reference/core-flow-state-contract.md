# Core Flow 状态契约

最后更新：2026-09-24 12:09:53

本页是 Harness 状态边和高频 `RunContext` 字段责任的导航入口。可执行契约位于 `packages/types/src/stage-transitions.ts` 与 `packages/types/src/run-context-contract.ts`；本页只解释如何阅读和扩展它们，不复制运行时实现。

## 状态边

`allowedTransitions` 是 Core Flow 唯一允许的 Stage 边表。每次 stage 或 hook 返回 `StageResult` 后，Harness 在进入下一轮前调用 `inspectStageTransition`。边不在 manifest 中时，Runtime 会把结果收敛为 `ok: false`、`next: 'exit'`，并在 `meta.transitionViolation` 中保留来源、目标和允许目标；不会让自定义 stage 或 hook 静默跳过安全流程。

下面是当前逻辑主边（不是 manifest 全文）：

```text
enter -> classify
classify -> execute          (每个请求，含常规会话/工具工作/续接)
classify -> reply            (能力/状态询问)
execute -> verify
execute -> recover
recover -> classify
recover -> execute
recover -> verify
recover -> reply
recover -> ask_user
recover -> finalize
verify -> finalize
verify -> recover
verify -> ask_user
reply -> verify
reply -> finalize
ask_user -> finalize
每个 stage -> exit
```

manifest 另外保留以下**兼容边**，它们只服务旧检查点读取与自定义轻量执行 stage，不代表可路由的产品语义：`classify -> decide`、`classify -> ask_user`、`decide -> {execute, ask_user, finalize, recover}`、`execute -> decide`、`execute -> finalize`、`recover -> decide`、`verify -> capture`、`verify -> decide`、`evolve -> capture`、`capture -> finalize`。

活动路由只产出 `execute` 与能力/状态询问 `reply` 两条路径。`ASK_USER` 不是可路由活动：它由主循环内模型发起的 `request_user_input` 到达，或由 `RECOVER` 在权限拒绝 / 恢复预算耗尽时升级到达。`clarify` 不是活动，`classify` 只是历史 stage id 与检查点兼容标签。

模型提问不产生续跑停放：A 方案下问题作为正常回复发布、run 正常结束，下一条消息按新任务处理，生产代码不会因“模型提问”创建 waiting-user 检查点。`waiting_user` 状态与旧等待头解析只作为旧版本遗留的兼容路径保留；显式续跑、应用启动恢复与 `RunCheckpoint` 仍是现行能力，恢复入口不会重放已结算的副作用。

提问轮里的兄弟调用不执行：同一批里与 `request_user_input` 一起到达的其它工具调用以带原因的拒绝结果记入转录（它们可能依赖尚未给出的答案），提问本身照常发布，整轮不因此判失败。升级（权限拒绝、预算耗尽）同样走 `ask_user` 后 `finalize`：普通 run 升级后其检查点被标记为 `completed`（不再可恢复，再次恢复会得到冲突），失败 run 则保留 `resumable`；升级之后用户的下一条普通消息是一个**新 run**，不存在 waiting-user 生产者。

`decide`、`capture` 与 `evolve` 仍出现在 `allowedTransitions` 与 `stageNames` 中，但已没有注册实现：驱动把恢复入口的 `decide` 映射到 `execute`，规划层、自动记忆演化编排与运行结束时的自动沉淀都已删除。

工作策略升级通道同样已不存在：`selectWorkPolicy` 的所有 execute 出口都返回 `bounded_loop`，恢复时持久化的 `task_book` 策略被降级，`request_task_book`、`workPolicyUpgradeProposal`、`bounded_loop_promoted` 与 `memory-intent-gate` 已随第二执行体系删除；`complex_scope` / `large_request` 只决定审计用 reason code，不改变路径。`TaskBookPatch` 与嵌套 `taskBook` 字段继续作为可读历史与局部修订契约存在。

每个 stage 都保留 `exit` 终止边，因为运行时暂停、中断、异常和 Provider 失败必须有明确的终态出口；默认工具循环仍然经过 `verify`。

扩展 stage 时必须先为边补 manifest 和回归测试，再注册 stage。不要在模型输出、hook 或临时分支中增加未登记的 `next`；`StageResult.next` 不是自由路由字段。

## 会话续接（conversation continuation）

- 所有入口（普通聊天、显式恢复面板、应用启动恢复）最终都进入 Runner 的同一个 `resumeCheckpointAuthoritative`：`sessionId + requestKey` 决定稳定 runId 与稳定 inbound messageId，Renderer 只提供稳定 requestKey，不参与解析或 claim。
- 每条用户回答最多消费一次；disposition 走文件锁加 `tmp`/`rename` 原子写，`requestId + answerMessageId + requestKey` 相同的重试只加入同一个 resume run；`deferred` 不进入自动 head，只有显式 `answer` 指令才允许再次取用。
- 语义恢复阶段由 `packages/runner/src/continuation-stage.ts` 计算，`finalize` 只是保存位置；历史 `decide` 入口在恢复时归一化到主循环 `execute`，改目标走主循环并携带修订反馈。
- 资源续接只保存有界 manifest（cacheId、contentHash、kind、size、contextPath）与封闭工具配方；恢复时按摘要、大小、类型与工具可用性校验，只有 `attachmentCount` 的旧检查点一律阻断并要求重新附加。受管附件缓存只在启动时按仍可恢复的检查点保护 cacheId（128 条窗口），没有在飞 lease。
- 恢复一律使用当前权限模式、当前工作区与当前审批 broker，检查点里的 `permissionPolicyId` 只作审计；含 `in_progress` / `unknown` 副作用的检查点失败关闭，已完成步骤与副作用不重放。
- 每轮 turn 在 execution log 记录 `ConversationContinuationEvidence`（resolution、checkpointId、requestId、answerMessageId、resumeRunId、disposition、resumeStage、resources、permissions、replayPrevention、failure），字段全部有界脱敏。

## Runner Coordinator

Runner 的最小 coordinator 由 `packages/runner/src/runner-coordinator.ts` 约束，固定执行 `prepare -> execute -> finalize -> persist`。`runner-execute.ts` 只负责 Harness 与运行时 checkpoint，`runner-finalize.ts` 负责记忆/会话收尾与结果装配，`runner-persist.ts` 负责 execution log、上一轮摘要和版本 checkpoint 完成；这些 helper 不重新承担 LLM 语义决策。当前只有一个驱动：每次 run 都走 durable 路径，`durableHarnessMode` 只是持久化事件里的**历史标签**，默认 `next`，按 session/origin/profile 的覆盖已不能把 run 降级到已删除的 shadow 路径。

## RunContext Ownership

Ownership manifest 目前登记 46 个字段，按八组高频共享状态提供可审计的字段 owner、读阶段、写阶段和生命周期边界。它不是把已有 `RunContext` 改成代理对象，而是要求生产写入经过对应领域边界；测试夹具仍可直接构造上下文。

| 分组 | 代表字段 | owner | 主要写入阶段 | 生命周期 |
| --- | --- | --- | --- | --- |
| `reply` | `reply`、`replyProvenance`、`finalReplySettlement`、`usage` | `user-facing-reply-boundary` / `final-reply-settlement-boundary` / `model-observability` | `reply`、`execute`、`recover`、`ask_user`、`finalize`；`reply` 与 `replyProvenance` 通过 `reply-state.ts` 批次写入，顶层 usage 通过 `usage-state.ts` 批次写入；请求级 usage 仍由 `model-observability.ts` 绑定到 `contextSnapshots` | `run-local` |
| `replan` | `taskBook`、`plan`、`taskBookRevision`、`taskExecution`、`replanAttempts`、`verifyFeedback`、`partialReplanRequest`、`replanHistory`、`appliedTaskBookPatchIds` | `decide-taskbook-boundary` / `execute-taskbook-boundary` / `verify-replan-boundary` / `runtime-taskbook-boundary` | `execute`、`verify`、`recover`、`runtime-boundary`、`runner-restore`；`decide-taskbook-boundary` 与 `decide` 写入阶段只为读取旧检查点保留 | `checkpoint-carried` |
| `decision` | `classification`、`needAssessment`、`clarificationRequest`、`clarificationResponse` | `activity-routing-boundary` / `decide-demand-boundary` / `clarification-boundary` | `classify`、`recover`、`verify`、`ask_user`、`runner-init`、`runner-restore`；`decide-demand-boundary` 与 `decide` 阶段只为读取旧需求评估数据保留 | `checkpoint-carried` 或 `run-local` |
| `failure` | `lastError`、`recoveryAttempts` | `failure-recovery-boundary` | `lastError`：Core Flow 各 stage、`runner-restore`、`post-run`；`recoveryAttempts`：`runner-init`、`recover`、`runner-restore`，均通过 `failure-state.ts` 批次写入 | `run-local` / `checkpoint-carried` |
| `executionEvidence` | `toolResults`、`toolInvocations`、`toolInvocationsTruncated`、`sideEffects` | `execute-result-boundary` / `tool-invocation-evidence` / `side-effect-ledger` | EXECUTE 顶层结果、ToolExecutionService 调用记录和副作用账本；初始化与 checkpoint restore 通过 `execution-evidence-state.ts` 接入，账本内部更新也通过不可变替换提交 | `run-local` / `checkpoint-carried` |
| `modelObservability` | `modelCallCount`、`modelRequests`、`contextSnapshots` | `model-observability-state` / `model-observability` | 模型请求准备与调用计数、受限请求快照和 Context 快照；初始化与 checkpoint restore 的调用计数通过 `model-observability-state.ts` 接入，`contextSnapshots[].providerUsage` 保持请求级嵌套观测 | `modelCallCount`: `checkpoint-carried`；其余：`run-local` |
| `runtimeControl` | `runtimeControl`、`runtimeEventQueue`、`deferredRuntimeEvents`、`deferredRuntimeEventIds`、`loopBudget` | `runtime-control-boundary` / `runtime-state` / `runner-runtime-queue` / `runner-runtime-budget` | Runtime safe boundary、延迟运行时事件消费、Runner 初始化/恢复；顶层批次写入统一经过 `runtime-state.ts` | `run-local` 或 `checkpoint-carried` |
| `memory` | `prelude`、`sessionSummary`、`memoryRootIndex`、`initialMemoryContext`、`memoryKnownState`、`memoryContinuityAssessment`、`memoryContextWorkingSet`、`evolutionNotes`、`insights`、`memoryIntentDecisions` | `runner-memory-bootstrap` / `memory-evidence-boundary` / `memory-context-boundary` / `evolve-memory-boundary` / `capture-memory-boundary` / `finalize-memory-continuity` / `memory-intent-gate` | Runner 初始化/恢复、主循环 EXECUTE、VERIFY、REPLY、FINALIZE；所有顶层 Memory 批次写入统一经过 `packages/harness/src/memory-state.ts`；`evolutionNotes`/`insights`/`memoryIntentDecisions` 及其 `evolve-memory-boundary`/`capture-memory-boundary` owner 现在只服务旧记录的读取与展示 | `run-local`、`checkpoint-carried` 或 `session-persisted` |

机器可读字段表通过 `getRunContextFieldContract`、`runContextFieldsForGroup` 和 `assertRunContextFieldWriteAllowed` 查询。各领域的顶层批次写入入口是：replan 组 `packages/harness/src/replan-state.ts`、`reply` 与 `replyProvenance` `reply-state.ts`、runtimeControl 组 `runtime-state.ts`、Memory 顶层字段 `memory-state.ts`、顶层 `usage` `usage-state.ts`、决策与澄清字段 `decision-state.ts`、`lastError` 与 `recoveryAttempts` `failure-state.ts`、执行证据字段 `execution-evidence-state.ts`、模型观测字段 `model-observability-state.ts`。这些入口都会先完成整批字段校验，再一次性写入，非法阶段不会留下半更新。`decision-state.ts` 负责活动路由、需求评估和澄清请求/响应的 RunContext 顶层状态；`failure-state.ts` 负责跨阶段失败证据和有界恢复计数，不负责模型观测或执行证据；`execution-evidence-state.ts` 负责顶层执行证据投影、调用记录有界 upsert 和副作用账本的不可变替换；`model-observability-state.ts` 负责三个顶层模型观测字段的批次校验、有界追加和不可变快照更新，不代理模型请求构造语义；`usage-state.ts` 不代理请求级 `contextSnapshots[].providerUsage` 观测；`memory-state.ts` 只负责 RunContext 顶层状态，不代理 Memory Repository/Service 的持久化事务；`runtimeEventQueue` 内部的 open/settle/lease、幂等和快照恢复状态仍由 `packages/runner/src/runtime-event-queue.ts` 自己拥有，不属于 RunContext 写入边界。TaskBook 的嵌套 `stageResults` 不再是执行期证据边界：步骤执行器已删除，该字段只由 `TaskBookPatch` 维护，并在写入 execution log 与 checkpoint 前被剥离。

模型观测的快照窗口当前统一使用 `MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN = 64`：`RunContext` 的模型观测入口、checkpoint 的 `contextSnapshotIds` 和 execution log 的 `modelRequests`/`contextSnapshots` 都以最近 64 条为有效窗口。`appendModelObservations()` 把非有限值、非整数值和过大值归一化到 `1..64`，因此公开状态 API 无法扩大该窗口。checkpoint store 的新写入按 64 条校验，读取与诊断继续接受最多 128 条历史 `contextSnapshotIds`，保证旧 checkpoint 可检查和迁移；该兼容分支只影响输入校验，不改变公共 checkpoint schema 或恢复 owner。execution log 在持久化前先收集 request tail 中的 `contextSnapshotId`，优先保留仍被引用的 snapshot，再从最新未引用 tail 填充剩余容量，结果最多 64 条并保持原始顺序，避免出现 dangling ID。checkpoint 边界还把 `modelCallCount` 重concile 到持久化 `loopBudget.attemptsUsed`、把 `maxModelCalls` 重concile 到 `loopBudget.maxAttempts`；这只是两个既有 owner 之间的确定性映射，不新增 ownership group。`contextSnapshots[].providerUsage` 始终是请求级嵌套观测，不提升为顶层字段。

`verificationHistory` 仍由 VERIFY 记录函数追加、由 Runner restore 恢复，并在 checkpoint/store 与 execution log 中有独立边界；它不纳入 ownership group，当前也没有第九组。

## 修改规则

1. 先修改 manifest，再修改使用方；保持公共 `RunContext` 字段和 checkpoint 格式兼容。
2. 新增 Stage 边必须增加非法边拒绝测试和至少一条真实流程回归。
3. 新增高频共享字段必须登记 group、owner、读写阶段、生命周期和 purpose；未知字段不能被 ownership 查询假装为已治理。
4. Harness/Runner/Context/Memory 公共契约变更运行 `pnpm.cmd run verify:core`；阶段结束再运行 `pnpm.cmd run verify:full`。
