# @littlesheep/runner

Runner 是应用层 run 创建、请求装配、Harness 集成、事件持久化、最终结算与恢复的 owner。公开入口为 `src/index.ts`。它组合 Context、Harness、Session、Tools、Memory 与 Safety；Electron 和渠道适配器提供外层宿主。

## 持久边界

CMv2 P1B-1 的 `RunInput.memoryAccessGrant` 是 Main 在进程内签发的一次性句柄。Runner 将最终 session/run/cwd 绑定并传给 MemoryService，不把授权放入 Prompt、ToolContext、执行日志或 checkpoint。缺句柄的 CLI、渠道与直接调用使用无项目、无全局授权的 standalone adapter；这仅是授权传递，旧检索与写入行为仍保留，不能宣称完成读取隔离。恢复须取得新句柄，子任务通过 MemoryService 的 `createChildRunAccessGrant` 保留祖先限制。详见 [P1B-1 报告](../../docs/reference/cmv2-p1b-1-memory-authority-2026-10-14.md)。

P1B-2A 的 `CreateRunnerOptions.memoryOwnershipBindings` 是可信 Host/隔离测试依赖，不来自普通 Config、Renderer 或工具参数。只有 sealed grant 的 `enforced` 模式消费该依赖；缺绑定、版本变化或授权过期时受保护 Atom 读取失败关闭。生产仍为原有传播模式，六类请求组装基线不变。本阶段不提供整个 Prompt 的撤销或完整记忆隔离保证。

- `AgentRunner.inspectContext(sessionId)` 只读取已有聊天／日志读写时产生的有界内存脱敏投影和当前运行快照；没有原文回放、额外 tokenization 或新磁盘存储。历史范围为 loaded_history（最多返回 32 请求），不能代表会话累计账单。外层 Main 必须先验证会话归属；旧日志缺快照时保持不可用。隐私／归属测试见 `context-inspection.test.ts`，Electron 入口验收见 `scripts/verify-context-inspector.mjs`。
- ExecutionLog 保存已结算 run 证据；RunCheckpoint 保存活动 run 的可恢复状态，两者用途不同。
- Run 与 tool identity 支持幂等结算。续跑前校验 durable lease；未完成或状态未知的副作用须停止并明确处理。
- 每个新 run 都使用严格 durable 持久化与结算；执行模式选择和 per-session/origin/profile overrides 已移除。旧 `shadow` 标签只供历史记录读取、回放和用量报告。
- FINALIZE 按唯一 settlement 身份登记并持久化权威模型回复。重启恢复只在 durable event 投影与 reply registry 都确认结算后，补齐作为历史投影的 ExecutionLog；没有有效模型回复时可报告 Runtime 状态，不能伪造 Agent 答案。
- 会话压缩保存带 source／predecessor 校验的版本化摘要，不写 durable Memory。
- 长期 Memory 变更走 `memory_write` 或 `memory_manage`，并满足授权、来源和 revision 检查。
- 工作区、会话、checkpoint、事件日志、索引和用户配置属于活动数据根；测试使用隔离根与合成输入。
- 新模型请求／响应／结算先写持久待更新标记，再提交事件。用量查询通过 `ProviderUsageDailyService.synchronizeCurrent` 处理这些分区，索引保存成功且 revision 未改变后才确认标记；重启或索引写入失败不丢新调用。历史回填独立运行，旧逻辑响应只作为没有物理回执时的兼容来源。
- 用量实报、记录异常与调用失败／中断／进行中分开统计；新日序列不输出“部分记录”状态。`provider-usage-live-recording.test.ts` 用本地 HTTP Provider 协议夹具执行真实客户端与 Runner，覆盖新回复、工具、重试、校验失败、缺失字段和重启／写入恢复；不代表外部 Provider 的真实计费验收。

Runner 负责组合，不重写协作者的契约：Harness 拥有状态转移；Context 拥有提示候选和预算；Session 拥有转录／摘要持久化；Tools 拥有工具执行；Memory 拥有索引记忆；Safety 拥有权限决策。宿主保护源码根通过 `AgentRunner.protectedWriteRoots` 暴露给 Main 侧执行入口复用。Checkpoint decoder 只接受受支持历史格式；续跑不得重放已结算副作用。

Main 在每次普通 run、continuation 与 checkpoint resume 时提供当前工作区事实和不可变 Permission V2 决策快照；Runner 只在运行时上下文中传递它，并将工具授权交给 Safety 与 Main 审批入口。Runner 不把新权限快照写入 checkpoint 或 execution log；旧 checkpoint 的权限上限由 Main 按历史可证明的 legacy mode 保守解析。

局部 codec、恢复和结算运行 package typecheck 与 Runner 定向测试。Runner 的 settlement ack-lost 用例覆盖写入成功但确认丢失、重启修复历史投影、completed receipt 幂等与副作用不重放；`verify:app-recovery`、`verify:file-consistency-faults`、受控记忆和真实 Electron 连续性检查覆盖更广边界，按改动契约选择。单测不证明跨进程 lease 恢复。
