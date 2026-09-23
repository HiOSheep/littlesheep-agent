# @littlesheep/types

最后更新：2026-09-24 02:33:06

保存跨 package 的纯 TypeScript 契约，是运行时协议的唯一公共类型来源。

## 职责与边界

- 公开入口是 `src/index.ts`；`conversation-continuation.ts` 拥有会话续接审计证据（`ConversationContinuationEvidence` 与它的版本常量，含 `handoff`），`task.ts` 拥有需求校准、TaskBook、步骤执行与验证契约（已持久化的 TaskBook 在当前 runtime 里是只读历史，`TaskComplexity` 等由已删除的 DECIDE 产生的字段只作兼容），`agent.ts` 拥有状态机、RunContext 与 Hook 契约（`RunContext.modelHistory` 是"模型回放用的任务区间转录"，与只含 prose 的 `history` 分开），`message.ts` 拥有 Message/ContentBlock/ToolCall/ToolResult 契约（`ToolCall.rawArguments`、`tool_result.modelContent`、assistant 的文本前言与 `reasoning`、`Message.runtimeTail`/`runtimeTailId` 都是任务区间按字节回放所需：原始参数串只在工具没有输入 projector 时保存，带 `webEvidence` 的结果永不保存模型看到的正文，`runtimeTail` 消息不得进入 prose/UI/连续性投影、也不计入压缩阈值与摘要计数，`runtimeTailId` 让下一轮识别"同一条目、同样文本"从而不重复发送），`stage-transitions.ts` 是 Core Flow 边的唯一来源（唯一驱动会用 `inspectStageTransition` 校验每一次实际转移，因此新增路由必须同时登记该边；`execute` 边上 `ask_user` 是**真实**可达目标——主循环内模型可调用 `request_user_input`，漏登会让一次合法提问判定整轮失败；`decide`/`evolve`/`capture` 只作为历史 stage 名与旧记录的兼容边保留，供旧检查点读取与改派），`runtime-contracts.ts` 的 `RuntimeActiveRunPhase` 用 `starting`/`executing`/`verifying`/`finalizing` 描述活动 run，未产生步骤、工具或验证证据的阶段就是 `starting`，不存在规划阶段，`web-retrieval.ts` 拥有 provider 无关、可序列化且有界的网络策略、搜索、抓取、引用、错误和证据投影契约，其余消息、会话、工具、记忆和运行协议也按领域文件分组。
- 只定义稳定数据结构和端口，不实现文件系统、网络、Electron、Provider 或业务流程。
- `ConversationContinuationEvidence.handoff` 是"新 run 故意没有继承什么"的公开字段：任务进度随 checkpoint 继承，限制单轮自主工作量的额度不继承，因此 `previousFailure` 与 `runBudget`（来源轮的模型调用数、工具循环次数，以及本 run 按当前配置拿到的额度）只作记录，不重新施加。`RunContext` 契约里 `lastError`、`recoveryAttempts`、`modelCallCount`、`loopBudget` 的 `purpose` 同步写明这条边界：续接只继承任务状态。
- `tool.ts` 定义工具契约与 `ToolContext` 的两个宿主端口：`versioning` 是 run 级的回滚 preimage 钩子，`observation` 是**会话级**的"模型实际读过哪个文件版本"登记端口（`FileObservationPort`，含登记、查询、失效、挂起与同路径互斥），两者不得互相替代：前者记录改动前的内容、随 run 结算，后者记录模型所见、随每次读写复核并随会话表退出。
- 禁止依赖其他 workspace package（当前 `package.json` 没有声明任何依赖），禁止放入只被单一文件使用的内部实现类型。

## 数据所有权

- 类型不拥有数据；生产者、消费者和持久化位置必须在对应领域说明中明确。
- 版本化持久协议变更必须保留兼容解析或显式迁移。
- `FetchedDocument.content` 只用于 run-local 证据；`ToolResult`、checkpoint 和 execution log 只能持久化不含正文和原始 query 的 `WebEvidenceProjection`。

## 测试与修改定位

- 运行契约测试位于 `src/runtime-contracts.test.ts`，状态机边与 RunContext 契约位于 `src/stage-transitions.test.ts` 与 `src/run-context-contract.test.ts`，Web 证据与检索契约位于 `src/web-retrieval.test.ts` 与 `src/web-evidence-format.test.ts`，activation 投影与 reconciliation key 位于 `src/activation.test.ts`、`src/activation-projection.test.ts` 与 `src/reconciliation-key.test.ts`。
- 修改公共字段时搜索所有生产者、消费者、日志、恢复路径和 renderer 类型投影。
