# @littlesheep/runner

Runner 是应用层 run 创建、请求装配、Harness 集成、事件持久化、最终结算与恢复的 owner。公开入口为 `src/index.ts`。它组合 Context、Harness、Session、Tools、Memory 与 Safety；Electron 和渠道适配器提供外层宿主。

## 持久边界

- ExecutionLog 保存已结算 run 证据；RunCheckpoint 保存活动 run 的可恢复状态，两者用途不同。
- Run 与 tool identity 支持幂等结算。续跑前校验 durable lease；未完成或状态未知的副作用须停止并明确处理。
- FINALIZE 按唯一 settlement 身份登记并持久化权威模型回复。没有有效模型回复时可报告 Runtime 状态，不能伪造 Agent 答案。
- 会话压缩保存带 source／predecessor 校验的版本化摘要，不写 durable Memory。
- 长期 Memory 变更走 `memory_write` 或 `memory_manage`，并满足授权、来源和 revision 检查。
- 工作区、会话、checkpoint、事件日志、索引和用户配置属于活动数据根；测试使用隔离根与合成输入。
- 新模型请求／响应／结算先写持久待更新标记，再提交事件。用量查询通过 `ProviderUsageDailyService.synchronizeCurrent` 处理这些分区，索引保存成功且 revision 未改变后才确认标记；重启或索引写入失败不丢新调用。历史回填独立运行，旧逻辑响应只作为没有物理回执时的兼容来源。
- 用量实报、记录异常与调用失败／中断／进行中分开统计；新日序列不输出“部分记录”状态。`provider-usage-live-recording.test.ts` 用本地 HTTP Provider 协议夹具执行真实客户端与 Runner，覆盖新回复、工具、重试、校验失败、缺失字段和重启／写入恢复；不代表外部 Provider 的真实计费验收。

Runner 负责组合，不重写协作者的契约：Harness 拥有状态转移；Context 拥有提示候选和预算；Session 拥有转录／摘要持久化；Tools 拥有工具执行；Memory 拥有索引记忆；Safety 拥有权限决策。Checkpoint decoder 只接受受支持历史格式；续跑不得重放已结算副作用。

局部 codec、恢复和结算运行 package typecheck 与 Runner 定向测试。`verify:app-recovery`、`verify:file-consistency-faults`、受控记忆和真实 Electron 连续性检查覆盖更广边界；按改动契约选择。单测不证明跨进程 lease 恢复。
