# @littlesheep/runner

作为核心应用服务装配 Harness、Context、Memory、Tools、Session、Skills 和执行日志，并提供单次 run 接口。

## 职责与边界

- 公开入口是 `src/index.ts`；`runner.ts` 负责 run 生命周期装配，`session-continuity.ts` 负责会话压缩、摘要登记和有界 daily 提升，`run-config.ts` 冻结决议，`version-checkpoint-lifecycle.ts` 协调每轮数据/工作区检查点，`execution-log.ts` 持久化证据和按会话原子替换的上一轮摘要，`session-run-summary.ts` 生成有界进度/耗时摘要，`memory-workload-observability.ts` 聚合不含正文、路径和 Atom ID 的 Memory v3 质量/成本信号，`runtime-resource-observation.ts` 每轮只采集两次资源快照，`core-source-protection.ts` 从实际 workspace 标记发现 LS 核心源码只读根。
- 负责依赖注入和运行生命周期，不吸收各领域内部算法或 Electron UI 逻辑。
- 禁止让渠道、插件私有实现或 renderer 状态成为核心 run 的必要依赖。
- Runner 只把真实状态、证据和已在持久化会话注册表中原子占用的模型文案交给上层；面向用户的回复、任务说明、验证说明和交付语气必须由真实 LLM 调用结合运行时 `SOUL.md` 构思，并携带 `ReplyProvenance`。Runner 不用固定模板替代 Agent 人格表达，模型、注册表或改写失败时只返回错误状态。

## 依赖与数据

- Runner 可以组合基础设施，但跨领域只使用公开入口。
- 拥有 execution log 与 run checkpoint 生命周期协调；会话、记忆、配置和 shadow Git 存储仍由各自服务拥有。Runner 关闭时先释放 SQLite/Embedding，再请求版本服务执行退出冻结。

## 测试与修改定位

- 运行行为和摘要接续在 `src/runner.test.ts`，决议在 `src/run-config.test.ts`，检查点收尾在 `src/version-checkpoint-lifecycle.ts` 及 `@littlesheep/snapshot` 测试，日志及摘要原子替换在 `src/execution-log.test.ts`，负载报告的脱敏、有界、质量、成本和资源契约在 `src/memory-workload-observability.test.ts` 与 `src/runtime-resource-observation.test.ts`。
- 新 run 输入或事件必须同步公共契约、历史恢复和 Local App API 消费方。
