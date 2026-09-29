# @littlesheep/runner

Runner 是应用层 run 创建、请求装配、Harness 集成、事件持久化、最终结算与恢复的 owner。公开入口为 `src/index.ts`。它组合 Context、Harness、Session、Tools、Memory 与 Safety；Electron 和渠道适配器提供外层宿主。

## 持久边界

- ExecutionLog 保存已结算 run 证据；RunCheckpoint 保存活动 run 的可恢复状态，两者用途不同。
- Run 与 tool identity 支持幂等结算。续跑前校验 durable lease；未完成或状态未知的副作用须停止并明确处理。
- FINALIZE 按唯一 settlement 身份登记并持久化权威模型回复。没有有效模型回复时可报告 Runtime 状态，不能伪造 Agent 答案。
- 会话压缩保存带 source／predecessor 校验的版本化摘要，不写 durable Memory。
- 长期 Memory 变更走 `memory_write` 或 `memory_manage`，并满足授权、来源和 revision 检查。
- 工作区、会话、checkpoint、事件日志、索引和用户配置属于活动数据根；测试使用隔离根与合成输入。

Runner 负责组合，不重写协作者的契约：Harness 拥有状态转移；Context 拥有提示候选和预算；Session 拥有转录／摘要持久化；Tools 拥有工具执行；Memory 拥有索引记忆；Safety 拥有权限决策。Checkpoint decoder 只接受受支持历史格式；续跑不得重放已结算副作用。

局部 codec、恢复和结算运行 package typecheck 与 Runner 定向测试。`verify:app-recovery`、`verify:file-consistency-faults`、受控记忆和真实 Electron 连续性检查覆盖更广边界；按改动契约选择。单测不证明跨进程 lease 恢复。
