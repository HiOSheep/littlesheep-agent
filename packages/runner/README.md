# @littlesheep/runner

最后更新：2026-09-24 18:49:21

作为核心应用服务装配 Harness、Context、Memory、Tools、Session、Skills 和执行日志，并提供单次 run 接口。

## 冷启动计时

`DurableEventStore.initialize()` 只确保事件根目录存在；分区目录名由后台旧版恢复扫描检查，每个分区的文件名、版本、游标和完整性在实际读取/追加及扫描时逐段严格验证。发现损坏会让对应操作失败并留下诊断，不再用全部历史事件文件阻塞无关的新会话。现代待恢复任务仍由租约和收件箱在执行就绪前检查。

`infra.ts` 的 `buildInfrastructure` 在 `LITTLESHEEP_BOOTSTRAP_TIMING=1` 时输出以 `runner-infra-` 开头的 `[bootstrap-timing]` 阶段标（可观测性存储、durable harness 的四个存储、检查点存储、embedding、memory、bootstrap 文件、skill loader、harness 装配），并以 `runner-infra-returned` 收尾：该收尾标与 `execution-start`→`runner-ready` 的差值实测只差 0.2 ms（112.1/128.0/124.1 对 111.9/127.8/123.9），因此 `buildInfrastructure` 可以认定覆盖了 Runner 构建的全部成本，不要再为"还有别的东西没算进去"另设探针。`mark` 的第二个参数是给重叠阶段用的：`durable-harness-infrastructure.ts` 并行初始化四个存储（各自目录、各自目录内锁文件，互不共享状态），每个存储完成后用自己测得的耗时打标，而不是让共享计时器去量"两次打标之间的间隔"。配对实测（normal，每变体 8–10 次）：durable 阶段墙钟 36–40 ms → 10–13 ms，Runner 构建 114–116 ms → 99–101 ms，其中 10–16 ms 被紧随其后的 bootstrap 文件注册吸收，净收益约 14 ms；失败语义不变（按声明顺序报告第一个失败并关闭 next 模式准入）。Runner 构建仍是"进程启动 → 首次可执行"里唯一还有量级的成本（本次改动后中位约 100–116 ms）；这些阶段标只做诊断，正常启动不输出、不轮询，也不改变任何初始化顺序。

## 职责与边界

- 公开入口是 `src/index.ts`；`runner.ts` 负责 run 生命周期装配，`continuation-evidence.ts` 装配续接审计证据（绑定/推迟/放弃、shadow 审计、执行前被拒三种形状，只从检查点事实构造），`runner-finalize.ts` 是 FINALIZE 阶段（证据/反馈登记、结果装配、按压力触发压缩），`session-continuity.ts` 负责压力触发的会话压缩与摘要/候选结算（`runner-finalize` → `compactSessionAfterRun` → `maybeCompact`，经 `resolveMemoryWriteEpistemic` 写记忆，是持久记忆的唯一写入方；默认 `threshold 400`、`keepRecent 200`、`background false`，见 `packages/config/src/defaults.ts`），`session-compaction-scheduler.ts` 的 `SessionCompactionScheduler` 持有每会话 single-flight、合并、软并发上限、取消和有界操作历史（`SessionCompactionUsage` 记录 `requestCount` 与可选 `retryRequests`/`failedRequests`，未上报的 token 保持缺失而非 0），`session-summary-fidelity.ts` 从明确要求记住的用户字段重建最多 24 项 Runtime 权威精确字段并附加到概率摘要，`run-config.ts` 冻结决议，`version-checkpoint-lifecycle.ts` 协调每轮数据/工作区检查点，`execution-log.ts` 持久化证据和按会话原子替换的上一轮摘要，`session-run-summary.ts` 生成有界进度/耗时摘要，`memory-workload-observability.ts` 聚合不含正文、路径和 Atom ID 的 Memory v3 质量/成本信号，`runtime-resource-observation.ts` 每轮只采集两次资源快照，`core-source-protection.ts` 从实际 workspace 标记发现 LS 核心源码只读根。
- 只运行单一 harness 驱动：`durableHarnessMode` 只保留历史持久标签（`readDurableHarnessMode` 从 durable 事实读取，早于该字段的 run 只要有 durable 事实就按 `next` 处理），shadow/next 双驱动切换已删除，按 session/origin/profile 的覆盖项不再生效（只剩未读取的类型字段残留），`resolveDurableHarnessMode` 只返回 `opts.durableHarnessMode ?? 'next'`。durable event store、durable inbox、run/effect lease store、权威 final-reply settlement 与崩溃恢复构成唯一的恢复边界：重启的 run 重放一次已持久化 transcript，已结算的副作用绝不重放。
- 负责依赖注入和运行生命周期，不吸收各领域内部算法或 Electron UI 逻辑。
- `session-file-observations.ts` 的 `SessionFileObservationRegistry` 随进程存活、按 `sessionId` 取表：每个会话一张有界观察表（默认 16 张表、每表 512 条，LRU 淘汰整表），会话之间不能互相借用观察；全 host 共享一张同路径互斥表，使两个会话对同一文件的"复核 + 写入"串行。观察表**不持久化**，Runner 重建或应用重启后模型需要重读；`runner.ts` 在 shutdown 时释放它，并在每次 `buildRunContext` 时把该会话的表注入 `ToolContext.observation`。淘汰和释放只约束内存：已经交给在飞 run 的那个端口仍持有自己的有界表，不会在写入中途被抽走依据。
- 禁止让渠道、插件私有实现或 renderer 状态成为核心 run 的必要依赖。
- Runner 只把真实状态、证据和已在持久化会话注册表中原子占用的模型文案交给上层；面向用户的回复、任务说明、验证说明和交付语气必须由真实 LLM 调用结合运行时 `SOUL.md` 构思，并携带 `ReplyProvenance`。Runner 不用固定模板替代 Agent 人格表达，模型、注册表或改写失败时只返回错误状态。
- 会话摘要是 Context 来源，不是“已经记住”的结论。Runner 只登记版本化摘要和最终回答实际采用的摘要 id；记忆连续性的最终判定由 Harness 对 LS 用户可见回答执行，只有回答级 `supported` 才能反馈摘要被真实承接。压缩的输入与计数只针对对话消息：带 `runtimeTail` 的 Runtime 尾部记录随转录保存以便按字节回放，但既不进入摘要输入，也不计入压缩阈值与 keepRecent 窗口。**压缩由真实上下文压力触发**：预算已知时（`contextSnapshot.budget.status === 'known'`）只允许 `compressionRecommended` 启动压缩，消息条数阈值退化为"窗口不可知"时的兜底——压缩会重写转录、让下一次请求重付整段前缀（实测 28 回合长任务里 6 次按条数触发的压缩在窗口充裕时白白重付了约 288k tokens）。

## 依赖与数据

- Runner 可以组合基础设施，但跨领域只使用公开入口。
- 拥有 execution log 与 run checkpoint 生命周期协调；检查点保存最多 4 个 `activeStepIds`（单循环内串行步骤的当前活动集，不再是并行执行器）并保留 `currentStepId` 兼容入口。会话、记忆、配置和 shadow Git 存储仍由各自服务拥有。Runner 关闭时先释放 SQLite/Embedding，再请求版本服务执行退出冻结。
- 精确 tokenizer 不属于桌面启动前置条件。Runner 创建只装配轻量惰性代理，首次真实 run 与会话装配并行预热经过校验的本地资源；准备中的请求由 Context Engine 保守估算保护，重复准备合并，失败重试退避，关闭时取消未完成准备。

## 测试与修改定位

- 运行行为和摘要接续在 `src/runner.test.ts`，摘要精确字段保真在 `src/session-summary-fidelity.test.ts`，决议在 `src/run-config.test.ts`，活动 run 检查点在 `src/run-checkpoint*.ts` 与 `src/runner-continuation.test.ts`，版本检查点收尾在 `src/version-checkpoint-lifecycle.ts` 及 `@littlesheep/snapshot` 测试，日志及摘要原子替换在 `src/execution-log.test.ts`，压缩压力触发与候选结算在 `src/session-compaction-scheduler.test.ts` 与 `src/session-compaction-input.test.ts`，durable 恢复在 `src/durable-*.test.ts`，负载报告的脱敏、有界、质量、成本和资源契约在 `src/memory-workload-observability.test.ts` 与 `src/runtime-resource-observation.test.ts`。涉及会话转录的断言先过滤 `runtimeTail` 记录：它们为按字节回放而持久化，但不是对话。`session-compaction-input.test.ts` 的用例会驱动真实 run 与真实压缩调用，因此该文件显式把测试超时设为 90 秒——并行跑全量测试时它们曾因默认超时而失败，那与它们断言的行为无关。**2026-09-24 测得超时的真实成因**：开着影子 Git 版本检查点时，一次 run 会 spawn 约 56 个 `git` 进程（基线快照、逐次调用扫描 tracked paths、收尾提交），在 Windows 上约 10 秒/次，全量并行时把该文件里最长的一条推到 90 秒以上。该文件断言的是**压缩输入**，不看快照，所以按验收脚本的既有做法设 `config.versioning.enabled = false`：文件总时长 52 秒 → 30 秒，最长用例 20 秒 → 11.8 秒。需要验证快照行为的用例不要照抄这一行。
- 新 run 输入或事件必须同步公共契约、历史恢复和 Local App API 消费方。
- 续跑样本的断言必须按**当前**行为写：旧检查点的 `taskBook`/`taskExecution` 是只读历史，VERIFY 不再把它当成缺口，因此"预算耗尽后授予完全访问并重试"这一样本交付的是模型自己写的回答（2 次请求、轨迹 `[recover, execute, verify, finalize]`）。它此前断言的那次额外请求其实是 `ask_user` 的措辞调用——即工作已经做完却又问了一遍用户。
- 检查点里的**任务状态**与**本轮额度**必须分开传递。`continuationLoopBudget`（`src/run-checkpoint.ts`）让续跑继承 taskBook、已完成步骤、副作用、验证历史和权限，但把模型调用数、工具循环次数、连续无进展计数与证据指纹重置为 0，并按**当前**配置取 `maxModelCallsPerRun`；`restoreContinuationContext` 同时清空来源轮的 `lastError` 与 `recoveryAttempts`。此前把"已花掉的额度"当作新 run 的已用额度，等于让耗尽预算后的用户重试在第一次模型请求之前就失败：用户每次说"再尝试一次"，得到的都是同一句升级提问，且没有任何新工作。本次改动前的复现是轨迹 `[recover, execute, recover, ask_user]` 且没有副作用；改动后为 `[recover, execute, verify, finalize]`。上一轮的耗尽事实不丢：它作为续接证据的 `handoff`（`previousFailure` 与 `runBudget`）记录在 `ConversationContinuationEvidence` 上，而不是重新施加到新 run。
- 绑定续跑的历史投影只排除**本 run 自己那一轮 inbound**：等待用户回答的续跑里 inbound 是用户的回答，被续跑的原请求必须留在历史里（否则重试的 run 看不到自己在重试什么，只剩 Runtime 的提问和"再尝试一次"），只有已持久化的回答消息因本 run 会重新渲染才排除；被中断的 run 则以原消息为 inbound，因此排除的是原消息本身。
- `run-context-notice-delivery.test.ts` 守住"没送到就不算送达"：FINALIZE 的每条失败路径都不写 `produced`，所以传输层失败的 run 不会把环境简报留在转录里，下一次 run 必然重新投递。
