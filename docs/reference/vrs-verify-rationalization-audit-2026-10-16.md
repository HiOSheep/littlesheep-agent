# LS VRS：VERIFY 去留审计与运行架构简化（V0/V1）

日期：2026-10-16
审计基线：LittleSheep main，HEAD e14ca2bf1759068e2522130c75164a8fd5460567
批次：仅 V0 与 V1；未修改 Harness、Runner、类型、UI 或生产运行行为。

## 决策摘要

**建议选择方案 C：取消独立 VERIFY Stage，保留小型运行证据结算函数，在 EXECUTE 主循环完成时调用。** 这不是任务验收引擎：它只确认当前运行的工具事实是否完整、一致、已结算，并把确定的事实写入现有记录。没有匹配任务目标的证据时，新运行不得写出代表“用户目标已验证”的 pass。

保留的必要职责是**发布前的证据完整性闸门和有限恢复路由**。工具调用、授权、取消、工具结果及副作用 ledger 仍由 Runtime / ToolExecutionService / Runner 拥有；VERIFY 本身不做授权，也不执行工具或模型调用。移除独立 Stage 不应移除证据闸门。

去掉独立 Stage 的收益合理：当前注册 8 个活动 Stage，普通 EXECUTE 完成额外经过一次 VERIFY 调度和一次持久化阶段转换；VERIFY 没有模型调用，也没有独立副作用。其规则可在现有执行结算边界完成。另有已退役的重规划参数、未调用 helper、声称 VERIFY 调用模型的合同和模型活动文案仍留在代码中。

**V2 可以进入实施，前提是先以测试证明旧 VERIFY checkpoint 不会绕过证据失败、权限拒绝或未知副作用保护。** 当前 checkpoint 不保存工具 invocation/result 或 provisional reply；因此不能仅把旧 verify 名称改映射到 FINALIZE。本报告之后停止，不在本批删除生产 Stage。

## V0-01：生产调用链

1. **生产装配**：Runner 使用 Harness 工厂创建唯一的 durable driver；default-harness.ts 注册 verify；durable-harness.ts 执行阶段、校验 transition、记录阶段 trace 和 stage_transition_recorded 事件。见 [default-harness.ts](../../packages/harness/src/default-harness.ts#L16) 和 [durable-harness.ts](../../packages/harness/src/durable-harness.ts#L24)。
2. **常规路径**：EXECUTE 的单一工具循环正常结束时返回 next: verify；verify 成功后转 finalize。Harness 图还允许 RECOVER 重试到 VERIFY，但当前结构性证据缺口的实际恢复路径是 RECOVER → EXECUTE。见 [execute/main-loop.ts](../../packages/harness/src/stages/execute/main-loop.ts#L160)、[stage-transitions.ts](../../packages/types/src/stage-transitions.ts#L39) 和 [recover.ts](../../packages/harness/src/stages/recover.ts#L25)。
3. **VERIFY 实际工作**：createVerifyStage 发出 silent 的 verification_start，依次尝试两个结构性 pass；随后检查 Runtime evidence gap、Provider-authored reply、已记录的负结果，最后记下 pass、fail 或 unverified。源码没有模型调用；单测断言所有路径的模型请求数为零。见 [verify.ts](https://github.com/HiOSheep/littlesheep-agent/blob/e14ca2bf1759068e2522130c75164a8fd5460567/packages/harness/src/stages/verify.ts#L24) 和 [verify.test.ts](https://github.com/HiOSheep/littlesheep-agent/blob/e14ca2bf1759068e2522130c75164a8fd5460567/packages/harness/src/stages/verify.test.ts#L258)。
4. **缺口与恢复**：结构性缺口会撤回 provisional reply、记录 fail 和 Runtime failure，再转 RECOVER。RECOVER 根据已记录事实执行取消中止、未结算副作用中止、权限拒绝升级给用户、有限重试或升级；“VERIFY 缺口”只使 RECOVER 首次回到 EXECUTE，第二次相同缺口升级。见 [verify/routing.ts](https://github.com/HiOSheep/littlesheep-agent/blob/e14ca2bf1759068e2522130c75164a8fd5460567/packages/harness/src/stages/verify/routing.ts#L185)、[recover/policy.ts](../../packages/harness/src/stages/recover/policy.ts#L27) 和 [recover/escalation.ts](../../packages/harness/src/stages/recover/escalation.ts#L70)。
5. **最终回复与任务状态**：FINALIZE 检查回复是否可追溯到本轮 Provider 请求、持久化 session transcript，并完成 final-reply proposal/settlement。Runner 的 AgentResult.status 来自中止状态和 StageResult.ok，不是由 verificationHistory.verdict 直接推导。见 [finalize.ts](../../packages/harness/src/stages/finalize.ts#L71)、[runner-finalize.ts](../../packages/runner/src/runner-finalize.ts#L72) 和 [agent.ts](../../packages/types/src/agent.ts#L474)。

## V0-02：规则与证据强度

所有规则读取当前 RunContext 中的 invocation、tool result、副作用 ledger、模型当轮 transcript/reply 及 reply provenance。invocation 由 EXECUTE 的 ToolExecutionService 执行与记录；VERIFY 只消费这些事实，不是其权威来源。主要入口见 [execute/tool-loop.ts](../../packages/harness/src/stages/execute/tool-loop.ts#L627)。

### 当前 verdict 规则

1. **结构性 pass：单次只读调用**
   - 输入：toolInvocations、toolResults、sideEffects、reply/replyProvenance。
   - 条件：全程恰好一次 builtin read、grep、glob 或 session_status；调用成功且输出完整、未清洗；配对 result 成功；没有任何副作用；有非空、LLM provenance 回复。
   - 证明：本轮记录到一次符合白名单的只读调用，返回未截断、未清洗的成功结果，且没有记录写入或外部副作用。
   - 不证明：该调用回答了用户的哪项要求，也不检查模型回复是否忠于结果。即使读到错误文件或回复内容不符，也可能产生 pass。它证明的是调用形状，不是完整任务接受条件。
   - 误判消费者：VerificationRecord 对 pass 的类型注释称 Runtime 证明了 acceptance；Runner memory summary activation 和 workload metrics 会把 pass 作为 proven/verified 统计。

2. **结构性 pass：精确 write-read**
   - 输入：调用与结果来自 toolInvocations/toolResults；write/read 参数按 call id 从本轮 produced、modelHistory 或 history transcript 查找；副作用来自 side-effect ledger。
   - 条件：全程恰好两次 builtin 调用，顺序为 write、read；规范化后同一路径；read 没有 offset/limit；两者成功、未截断/清洗；read result 字符串与 write 参数 content 完全相等；唯一 side effect 是与 write call 匹配且已成功结算的 effect；另有非空 LLM 回复。
   - 证明：本轮 write 成功并记录了已结算 effect，之后同路径 read 工具返回与 write 参数相同的字符串。
   - 不证明：路径或内容是否符合用户目标、最终回复是否准确、任务是否还有其他要求。故仍不能解释为“用户目标已验证”。

3. **结构性 fail：证据缺口**
   - 输入：toolInvocations 是否截断/重复、调用 status 和 outputTruncated、toolResults 是否按 call id 配对、副作用 status/identity，以及 reply/provenance。
   - 条件：invocation 列表截断、重复 call id、权限拒绝状态、截断输出、调用缺结果、副作用未结算、effect 无匹配 invocation 或工具身份不符；另外，无非空 Provider-authored reply 也走同一失败路由。
   - 证明：Runtime 当前无法安全结算所记录的执行事实，或没有可发布的本轮 Provider 回复。
   - 不证明：用户任务本身已经失败；它表示证据不足以安全发布。此路径撤回 draft 并进入 RECOVER。permission hard-deny 本身由执行边界决定，VERIFY 不授予或移除权限。

4. **unverified：已知负结果**
   - 输入：完整 invocation/result/effect 记录、status、以及 Provider-authored reply。
   - 条件：记录了工具 failed/timed_out/aborted、validation_failed、unknown_tool、repeated_call_blocked，或副作用 failed/cancelled。permission denied/unavailable/hard denied 先被上行缺口规则处理。
   - 证明：运行知道某些调用失败，保留失败事实并可以发布回复；这种运行不能得到 pass。
   - 不证明：回复是否准确反映失败、用户要求是否完成。结果仍可能是 RunStatus ok，UI 另显示调用失败/未验证。

5. **unverified：一般完整运行**
   - 输入：运行调用事实和 reply provenance。
   - 条件：没有命中两个窄 pass，证据无缺口，无上述已知负结果，且有非空 Provider-authored reply。没有工具调用时也会进入该分支。
   - 证明：Runtime 所记录的调用事实完整、没有失败，模型回复存在。
   - 不证明：不存在通用任务目标、成功标准或交付验收比较；一般复杂任务通常停留在这里，这是诚实边界。

6. **旧值读取**：类型/codec 还接受 needs_replan，以及 model/degraded 来源。当前生产 VERIFY 不产生这些值；当前新写入由结构规则写 pass、fail、unverified。未发现当前生产调用 escalateExhaustedReplan。旧 execution log、checkpoint、UI 和 durable projection 仍能表示历史结果；没有找到新生产者并不意味着旧持久化数据不存在。

证据与状态含义有一处真实契约不一致：VerificationRecord 类型注释称 pass 已证明“recorded acceptance”，但两个实际规则只证明调用轨迹/读回事实，代码并未解析用户成功条件。因此结构性 pass 可能把“工具工作成功”扩成“任务接受条件已满足”。见 [task.ts](../../packages/types/src/task.ts#L183) 和 [verify/routing.ts](https://github.com/HiOSheep/littlesheep-agent/blob/e14ca2bf1759068e2522130c75164a8fd5460567/packages/harness/src/stages/verify/routing.ts#L66)。


## V0-03：职责、消费者与删除影响

| 关注点 | 当前事实与依赖 | 移除 Stage 时的要求 |
|---|---|---|
| 授权、hard deny、工具执行 | ToolExecutionService 在 EXECUTE 路径拥有调用校验、授权与执行；VERIFY 不调用工具，也不决定授权。它读取 approval 结果，缺口后由 RECOVER 将权限拒绝升级给用户。 | 授权责任原地保留；证据结算仍须在发布回复前消费拒绝状态。 |
| 副作用、安全重放 | Tool loop 的 side-effect lifecycle/ledger 创建和结算 effect；VERIFY 校验 effect 与 invocation 一致、没有 planned/in_progress/unknown；RECOVER 对未结算 effect abort。 | ledger 与 RECOVER 的 abort 语义必须保持，缺口不得变成再次执行许可。 |
| 取消 | durable driver 在安全边界消费 runtime control；RECOVER 也先检查 signal abort。VERIFY 不负责用户取消。 | 保持现有边界和取消结果。 |
| checkpoint/resume | checkpoint 写入 currentStage、sideEffects、resumeState.lastError、最多 32 条 verificationHistory；codec 当前仍接受 verify stage。恢复把 side effect/history 还原，但会清除 reply/lastError。checkpoint 不存工具 invocations、tool results 或 provisional reply；当前 resume resolver 对普通 verify entry 不做归一化。见 [run-checkpoint.ts](../../packages/runner/src/run-checkpoint.ts#L103)、[run-checkpoint-codec.ts](../../packages/runner/src/run-checkpoint-codec.ts#L41)、[checkpoint-resume.ts](../../packages/harness/src/checkpoint-resume.ts#L8)、[runner.ts](../../packages/runner/src/runner.ts#L2263)。 | **最高兼容风险。** 旧 verify checkpoint 的评估输入缺失。不可直接将 stage 名改映射到 FINALIZE 并发布，也不可跳过恢复保护。V2 必须把旧 verify entry 送入现有安全 RECOVER/EXECUTE 续接路径，保留失败线索与 side-effect ledger；未知/无法分类状态必须中止或升级给用户。等待用户的旧 sourceStage=verify 当前会映射到 decide 再进入 EXECUTE，也须保持兼容。 |
| Stage 状态与 transition | CurrentStageName 有 8 个活动 Stage；VERIFY 是其中之一。durable driver 为每个实际阶段持久化一次 stage transition 和 trace entry。 | 新图减到 7 个活动 Stage；普通 execute completion 从 execute→verify→finalize 收敛到 execute→finalize。历史 verify 名称仍须能读取。 |
| final reply 与 RunStatus | VERIFY 成功/未验证均以 ok: true 到 FINALIZE；FINALIZE 验证 reply provenance 和持久化。Runner 状态不是 pass 的同义词。没有独立 TaskOutcome union；RunStatus 表达运行是否结束/中止/错误，不是任务接受结果。 | 保留 Execution Status 与 Verification Evidence 分离；不要把删 stage 变成默认“任务成功”。未验证事项仍由回复诚实说明。 |
| durable 事件和审计记录 | recordVerification 追加内存 history，写 verification_recorded durable event（只存 verdict/source、reason hash/length、有限失败 id），并发 silent verification event。execution log、checkpoint、Runner Result 和 conversation-source record 保存可读历史。见 [verify/routing.ts](https://github.com/HiOSheep/littlesheep-agent/blob/e14ca2bf1759068e2522130c75164a8fd5460567/packages/harness/src/stages/verify/routing.ts#L24)、[durable-kernel.ts](../../packages/harness/src/durable-kernel.ts#L559)、[execution-log.ts](../../packages/runner/src/execution-log.ts#L80)、[conversation-source-records.ts](../../packages/harness/src/conversation-source-records.ts#L101)。 | 保留必要 invocation/effect 事实和 verificationHistory 旧格式读取；可继续发 verification_recorded。旧事件不迁移/重写，不为旧值建立第二执行链。阶段开始事件可以改由执行结算事件表达。 |
| UI、内部指标、memory feedback | active-run activity 和 task progress 显示 verifying 阶段；run event handler、history/activity、Runner Result 使用 history。chat UI 对非 pass verdict 明确呈现“未验证/失败”；常规 process line 通常不展示 pass。Pass 还被 session-summary activation 标记为 proven/verified，memory workload observability 统计 verified pass runs。见 [active-run-activity.ts](../../packages/runner/src/active-run-activity.ts#L121)、[activity-model.ts](../../packages/app/src/renderer/chat/activity-model.ts#L241)、[activity-visibility.ts](../../packages/app/src/renderer/chat/activity-visibility.ts#L120)、[session-summary-activation.ts](../../packages/runner/src/session-summary-activation.ts#L23)、[memory-workload-observability.ts](../../packages/runner/src/memory-workload-observability.ts#L145)。 | 去掉“正在验证”的过渡但保留必要的非 pass 事实展示、历史 verdict 和 RunResult 字段。需要修正新 structural pass 影响的 verified 统计语义，旧记录仍按历史值读取。 |
| 外部消费者 | 仓库内的 plugins/channels 没找到 verificationHistory 调用方；公共 types、RunResult、App API、执行日志和 checkpoint 持久化仍是消费者边界。仓库外本地数据/消费者不可由静态搜索穷尽。 | 维持历史类型和 JSON 可读；不把旧 Stage 名从所有持久类型中直接删除。 |

## 额外架构残留

- 当前 stage 之外，llm-call-contracts/definitions.ts 仍声明 verify 需要模型调用，而 createVerifyStage 已完全没有模型请求；model-activity.ts 仍显示“模型正在检查执行证据”。这是已失真的活动合同/文案，不是生产 VERIFY 的职责。
- createVerifyStage 仍读取 replanAttempts/maxReplanAttempts，但传入路由后被 void 丢弃；旧 partial replan helper、verify-replan-boundary context owner 和旧字段仍在 checkpoint/type contracts。
- hasCleanVerification / hasProvenVerification 当前仅有定义，仓库内未发现生产调用方。应在 V2 由消费者证明后删除或合并，不因名字相似而顺带删掉有真实消费者的记录路径。


## 定向基线

基线命令在 main HEAD e14ca2bf 上运行，覆盖 VERIFY、结构证据、证据缺口、RECOVER、EXECUTE 补充控制、stage transition、checkpoint、Runner continuation、execution log、Memory feedback、session-summary activation 和 UI history/event 消费者：

~~~powershell
pnpm.cmd exec vitest run packages/harness/src/stages/verify.test.ts packages/harness/src/stages/verify/structural-evidence.test.ts packages/harness/src/stages/verify/evidence-gap.test.ts packages/harness/src/stages/execute/tool-result-persistence.test.ts packages/harness/src/stages/recover.test.ts packages/harness/src/e2e.test.ts packages/harness/src/default-harness.test.ts packages/types/src/stage-transitions.test.ts packages/runner/src/run-checkpoint.test.ts packages/runner/src/runner-continuation.test.ts packages/runner/src/execution-log.test.ts packages/runner/src/memory-feedback-evidence.test.ts packages/runner/src/session-summary-activation.test.ts packages/app/src/shared/history-activity.test.ts packages/app/src/renderer/chat/activity-visibility.test.ts packages/app/src/renderer/chat/run-event-handlers.test.ts
~~~

**结果：16 个测试文件、194 tests passed，0 failed；Vitest 总历时 128.48 秒，其中 Runner continuation 27 项耗时约 120.35 秒。** 这是本地 unit/integration fixture 基线，不是 Electron、Provider 或真实 Runtime 证据。

当前有 checkpoint 字段/codec 和 continuation 的定向覆盖，但没找到从真实旧 checkpoint currentStage=verify 端到端恢复的专项测试；现有 checkpoint test 只构造 verify StageResult，旧 waiting-user verify source 测试只验证 semantic target。V2 必须增加：旧 verify entry、旧 fail/permission marker、已有 settled effect、未知 effect 以及恢复不重复副作用的实际 Runner continuation 回归。

本批没有运行 RCD C02/C08/R01/R02/L01/X01。V3 应由 RCD 冻结 owner 确定版本后再运行，尤其 R01 不应把另一专项的当前改动计入 VRS。当前 main 工作树里存在 RCD 未跟踪文件；本审计未修改或纳入它们。

## V1：方案比较

| 方案 | 优点 | 成本/风险 | 判断 |
|---|---|---|---|
| A：保留独立 VERIFY Stage | 当前 evidence gap → RECOVER 和 checkpoint stage 不需改。 | 继续保留一个没有模型/副作用的阶段、一次普通 transition/event/trace；Pass 仍须修语义；旧模型合同和重规划残留依旧。 | 除非旧 checkpoint 无法安全兼容，否则没有足够依据保留独立节点。 |
| B：删除 Stage，把规则全部内联至主流程/Runner | 最少的阶段概念。 | 若直接内联完整规则，会把任务式判定和 Runtime settlement 混合；容易出现重复恢复分支或新通用机制。 | 可行，但不如单一小型 helper 易于单测/复用。 |
| **C：保留轻量证据评价，移除独立 Stage** | 保留必要一致性/副作用证据闸门；复用现有 EXECUTE、RECOVER 和记录路径，不引入第二套执行循环。 | 必须处理旧 verify checkpoint、历史 verdict 的语义和旧 UI/event 读路径。 | **推荐，并建议进入 V2。** |

### V1-01：语义分层

1. **Execution Status**：使用当前 ToolInvocation/ToolResult/SideEffect status、Abort 状态和 RunStatus 表达实际发生、成功、失败、取消、未知。
2. **Verification Evidence**：记录 Runtime 确认了哪些事实，保留来源、时间和受限 durable projection。结构性读/写读回只属于事实，不代表用户目标接受。
3. **Task Outcome**：当前没有独立 Runtime 类型能普遍判断目标完成。由回复基于证据说明完成、部分完成、受阻或不确定；不从 Shell exit code、HTTP 200、read/write 成功或旧 pass 静默推导。

建议 V2 将新窄结构结果写成**证据事实 + unverified acceptance**；已知证据缺口仍写 fail 并走现有恢复。不要为保留 pass 而扩充硬编码任务规则。旧 pass 记录只保留为旧版本记录，不追溯重写。

### V1-02：兼容、影响与回滚

- **旧 checkpoint**：继续解码 version 1 和 StageName verify。恢复边界将它视为历史入口并送入现有安全 RECOVER/EXECUTE 路径；保留 effect ledger 与历史验证记录。不得将缺少工具/回复证据的 checkpoint 直接路由到 final reply。恢复时已清掉的 lastError 需对 verify 历史失败做兼容保留/重建；不能可靠判定为可重试时先中止或升级给用户。待新执行经过证据结算后再追加本轮记录。不要新增第二个旧 VERIFY loop。
- **已持久化 VERIFY 结果**：保留 verificationHistory、verification_recorded 的旧 verdict/source codec；不修改老 execution log、durable projection 或 checkpoint 中的 pass / needs_replan / model / degraded。旧 verify stage trace 仍可解析，未来 transition graph 将它移为历史 Stage。
- **运行结果/UI**：保持 AgentResult/ExecutionLog 的 verificationHistory 兼容字段；新 trace 不再含活动 verify，但历史 StageName 仍合法。取消 verification_start 后，修正 task-progress/activity phase；仍展示失败、权限、取消、未验证和旧历史记录。
- **插件/API**：仓库内没有发现 plugin/channel 的直接依赖；本地 RunResult、JSON 日志和 checkpoint 是已确认兼容面。未知的仓库外消费无法从本次源码审计排除。
- **副作用与权限**：保留 ToolExecutionService 授权、invocation/result 写入、side-effect lifecycle/ledger 和 RECOVER 的 unknown-effect abort/permission escalation。旧 checkpoint 不得绕过这些边界。
- **回滚**：V2 单独提交。尽量不更改 checkpoint 或 durable event schema；让新写的 unverified、旧字段和事件均可由当前 reader 读取。若旧 verify continuation、取消/权限或副作用恢复用例失败，回滚该 V2 commit，保持本报告 commit，不把改动集成 main。无需推送/改写远端历史。


## V2 建议改动范围（本批未实施）

1. 在 execute/main-loop.ts 正常结束前调用一个小型 evidence settlement helper；输入限于本次执行证据，输出“证据缺口/已知负结果/完整但未验收”，不新增任务状态机。
2. 普通执行从 execute 直接进入 finalize；缺口复用既有 execute→recover。RECOVER 保留一次闭合机会、权限升级、取消和未知副作用停止语义。
3. 移除活动 Stage 注册、执行图中的 VERIFY 节点和对应 read/write stage 权限；StageName、checkpoint codec、ExecutionLog reader 保留旧值用于历史数据。
4. 旧 currentStage verify checkpoint 做专门兼容归一化；旧 waiting-user verify source、lastError 和 verificationHistory 不能丢。新增端到端 Runner continuation fixtures 证明不重复 effect、拒绝不自动放行、gap 不误发回复。
5. 保留 verification_recorded 的审计所需字段与 ExecutionLog/RunnerResult 历史字段；新运行不再发任务 acceptance pass。修正 memory summary verified/pass 统计的含义。
6. 删除已无活消费者的 VERIFY model-call contract、模型进度文案、dead partial-replan helper/字段和 context owner；逐项确认旧 checkpoint/旧日志读取仍兼容。
7. 更新 Core Flow graph、run-context contract、activity/UI、module-split map、Core Flow 文档和相关包说明。

主要风险为旧 checkpoint 输入不全、从 lastError.stage=verify 解耦恢复策略时权限状态丢失、历史 pass 被误当成新结果、UI 误报完成，以及 effect ledger 回归。V3 需另外覆盖用户指定的 10 类功能、RCD 六项、类型检查和 repo check；还要比较 transition 数量、event/checkpoint 大小和实际常见任务耗时。当前 verifier 不作模型调用，故没有模型 token 节省；普通路径预计少一个 durable stage transition 和一项 trace entry，verification_recorded 与必要证据记录仍保留。**本批没有测量 Runtime 实际毫秒数，不能把预期结构减少写成已验证性能收益。**

## 审计边界

上述生产链与规则是基于 main 源码、静态消费者检索和所列测试确认；删除阶段后的安全恢复与性能结论仍是设计推断，尚未由真实 Electron/Runtime 证明。V0/V1 出门条件完成后，本批到此为止，等阶段验收后再决定 V2 与 main 集成。
