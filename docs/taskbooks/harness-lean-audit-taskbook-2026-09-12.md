# Harness 全面瘦身审计与实施任务书 · 2026-09-12

最后更新：2026-09-14 10:28:47

状态：审计完成；第一批 HL-00～HL-04、第二批 HL-05/06 与受影响 HL-10 已达到各自代码交付门。第三批 HL-08/09 与配套 HL-07/10 已完成设计、尚未实施；真实 Provider 配对性能、HL-11 与完整发布门仍待完成，本文不构成发布批准。

实施记录：[第二批实施包：HL-05/HL-06 与配套 HL-10](harness-lean-phase-b-implementation-taskbook-2026-09-13.md)第 12 节。下一批执行规格：[第三批实施包：HL-08/HL-09 与配套 HL-07/HL-10](harness-lean-phase-c-implementation-taskbook-2026-09-14.md)，承接本文 D 阶段：先保证未压缩来源回查、显式记忆指令与压缩恢复，再退出逐任务自动沉淀。仅纳入压缩相关 HL-07 关键路径子集，HL-07 其余准备优化和 HL-11 不提前扩入。

## 1. 结论与工作边界

需要继续瘦身，但问题不是简单的“状态太多”。当前是**常规任务承担过多串行模型工作，同时轻量路径缺少与完整路径等价的验证、恢复和展示契约**。继续添加关键词捷径、跳过验证或只合并 stage 名称，都不能可靠解决等待和反复回归。

下一步顺序：先封住错误通过和非法迁移，再建立可信的端到端观测，随后合并重复模型工作、拆开展示与执行策略，最后将自动记忆沉淀收敛到上下文压缩并收敛双驱动。优先服务于“不失忆”和“高效执行任务”，不以代码行数、状态数量、缓存命中率或 TPS 单项作为成功标准。

2026-09-12 的审计阶段只交付审计和任务书：读取当时源码、历史执行日志，运行既有定向测试和只读逻辑探针；当时未修改生产逻辑、未启动真实 Provider 任务，也未改用户配置、权限或记忆。第一批后续实施结果见第 9 节；不能用实施后的证据倒写或抹去审计基线。

### 1.1 审计基线与证据等级

- 工作区：`D:\Repositories\littlesheep`；HEAD：`39f0509`，**存在大量未提交及未跟踪改动，不能只用 HEAD 复现本次审计**。
- 范围：桌面发送入口 → Local App API/SSE → Runner 初始化 → Harness 双驱动与路由 → 模型准备/推理/工具循环 → 验证/恢复 → 记忆/压缩 → 持久化/最终回复 → Renderer 实时与历史投影。
- `[代码]`：在当前工作树中确认的行为或契约冲突；不等于已在用户桌面现场复现。
- `[探针]`：对当前源码进行无网络、无工具执行的逻辑复现；隔离函数不能代替端到端测试。
- `[日志]`：既有真实 run 的阶段/请求证据；没有构建指纹，不能假定来自最新工作树。
- `[待测]`：存在调用或风险，但没有耗时/故障证据；禁止写成已确认的主要瓶颈。

关键源码 SHA-256 前 12 位，便于识别审计对象，完整构建基线由 HL-00 固化：

| 文件 | SHA-256 前缀 |
| --- | --- |
| `packages/harness/src/lean-work-policy.ts` | `7D9F81B729E1` |
| `packages/harness/src/stages/verify/routing.ts` | `803B5C26E5B5` |
| `packages/types/src/stage-transitions.ts` | `177F27F7FBDA` |
| `packages/harness/src/stages/execute/model-transcript.ts` | `B8B587EC7F84` |
| `packages/app/src/shared/run-usage.ts` | `D98DFEAB13A4` |

### 1.2 当前究竟是不是 next

当前源码默认配置为 `next`，桌面 Main 从配置传入模式；最近三个本机日志也均记录 `durableHarnessMode: next`。不能再把所有现象归因于“桌面仍然使用旧 Harness”。

但 `next` 仍调用与旧路径相同的 `createHarnessStages`，增加 durable 调度并不自动减少规划、验证或记忆模型调用。旧日志也不能证明当前窗口已经加载最新构建；HL-00 必须将实际模式、策略版本、源码/构建指纹与 run 绑定。

来源：[配置默认值](../../packages/config/src/defaults.ts)、[桌面启动](../../packages/app/src/main/index.ts)、[durable 驱动](../../packages/harness/src/durable-harness.ts)、[stage 工厂](../../packages/harness/src/default-harness.ts)。

与旧任务书关系：保留 [9 月 2 日重建与 Cache 任务书](harness-rebuild-and-cache-taskbook-2026-09-02.md) 的权限、durable、effect、回复结算和缓存隔离要求；本文承接其中尚未解决的执行效率与反馈体验。 [9 月 11 日对比记录](../reference/harness-rollout-readiness-2026-09-11.md) 是历史证据，其“默认 shadow”描述与当前源码已不一致；不能拿历史测试数量或小样本对比为当前瘦身背书。实施前统一更新决策文档，不覆盖或抹去历史记录。

### 1.3 用户方向更新：自动记忆沉淀随上下文压缩触发

2026-09-12，用户提出：记忆沉淀应在上下文压缩时进行，而不是每个任务结束时。本文据此调整 HL-08：**取消普通任务结束时的独立 EVOLVE/LLM CAPTURE 沉淀，不改成每轮后台照跑；自动语义提炼以实际上下文压缩为触发点。**这是后续实施方向，当前生产逻辑尚未修改。

- **每轮保存事实，不每轮重新理解事实。** 会话原文、工具/权限/副作用证据、回复结算与必要的来源索引仍可靠落盘。这是防丢与可回查，不等于每次调用模型沉淀长期记忆。
- **压缩时合并语义工作。** 优先在同一压缩请求中，从原始覆盖区间和已有摘要生成“会话续跑摘要 + 有界长期记忆候选”；分别校验和提交。候选不是自动生效的记忆，必须有来源、scope、证据及冲突处理。
- **未触发压缩不主动补一轮学习。** 短会话、退出或任务结束不因此另调模型；保留原始会话及有界来源索引，按既有权限和记忆树导航回查。未压缩只是“尚未提炼”，不能解释为不存在历史。
- **显式记忆指令是用户任务，不是自动收尾。** 用户明确要求记住、纠正或忘记时即时按写入/撤销策略处理，优先复用当轮模型形成的合法意图；不能等压缩再生效，也不能只写日志就声称已记住/已忘记。存在歧义或提交失败时如实说明。
- **避免把等待搬到下一轮。** 在软阈值触发、具备一致性和资源余量时可提前准备压缩；硬上下文上限前仍可能需要等待。压缩成本不能消失，应减少重复调用、合并待压缩区间、显示准确状态，测量触发压缩那轮的延迟而非只看普通轮次。

本次补查确认：现有 [session-continuity.ts](../../packages/runner/src/session-continuity.ts) 已在 `maybeCompact` 成功后调用 `registerSessionSummary` 和 `consolidateDailyMemory`；[compaction.ts](../../packages/session/src/compaction.ts) 保留原始 JSONL，并记录覆盖范围及来源 hash。这是收敛入口，但现有压缩输出仍是摘要文本，不能据此宣称已具备统一候选提炼/写入能力。不要新建另一套逐 run 学习调度系统。

### 1.4 补充设计原则：Renderer 投影可观测活动，而非 Harness 控制状态

本原则直接约束 HL-04，但不改变既定实施顺序、不扩大第一批范围，也不提前实施 HL-05/08/11。

**Harness state controls execution. Runtime activity explains execution. Renderer projects activity, not state.**

Harness 状态机继续负责合法迁移、权限与副作用边界、取消/恢复、验证及最终结算；Renderer 不与 `DECIDE / EXECUTE / VERIFY / EVOLVE` 等内部 stage 名称形成强耦合。内部状态机未来即使重构、合并或替换，稳定的活动投影合同仍应可复用。链路应当是：

```text
Harness state ──控制──> 实际 Model / Tool / Runtime activity
                                  │
                                  ▼
                            Activity events
                                  │
                                  ▼
                         Renderer projection
```

禁止将链路简化成 `Harness state → Renderer label`。不是每个内部 state 都必须产生 UI event；仅执行数毫秒确定性函数、没有用户可感知等待的 stage 可以完全不展示。UI 事件应说明“实际发生了什么”，而不是“系统位于哪里”。

Renderer 主要消费三类真实活动：

1. **Model activity**：只在模型请求真实发生时展示，例如模型正在思考、生成正文、生成工具参数或组织最终回复。Provider 有真实 reasoning/text/tool-argument stream 时使用真实增量。Runtime 阶段说明、固定状态文案和参数计数不得伪装成 `model_reasoning`。
2. **Tool activity**：严格区分 `tool_preparing`、`tool_started`、`tool_completed`、`tool_failed`。参数尚未完整，或尚未通过 schema、权限、approval 时，只能显示准备/等待，不能提前显示“正在执行”。只有 ToolExecutionService 真正开始后才产生 started，取得真实结果后才产生 completed/failed。
3. **Runtime activity**：仅投影确实存在且可能阻塞用户等待的 Runtime 工作，例如准备上下文、恢复执行、等待权限、检查修改结果、压缩上下文或可靠保存结果。活动来源必须是实际执行事实，不能机械映射 `DECIDE → 正在规划`、`VERIFY → 正在验证`、`FINALIZE → 正在完成`。

长期稳定语义应覆盖 model request/stream、tool lifecycle、Runtime waiting/validating/recovering/compacting/persisting、reply preview/reset/settled 以及 run failed/aborted/completed。优先扩展既有 `ToolStreamEvent`、Runtime event 和 durable event 边界；本原则不要求新建第三套状态机或通用 EventBus。

HL-04 的实施与验收必须逐项核对 `Producer → Harness/Runtime event → SSE → Renderer reducer → Activity row`：同一信息在整条链路中保持同一种语义；不得把 snapshot 当 delta 拼接，不得把 Runtime 状态标记成 model reasoning。实时与历史使用同一投影规则，重试、停止、错误和取消必须闭合旧活动，最终 preview 仍由权威 settlement 覆盖。

以后新增任何运行状态前先回答：“用户看到它后，是否更清楚 Agent 此刻实际在做什么？”如果理由只有“内部进入了某个 stage”，原则上不展示；如果它说明模型正在生成参数、Runtime 正在等权限、工具正在读取文件、测试正在运行或结果正在可靠落盘，才是合适的 activity。

## 2. 等待究竟发生在哪里

### 2.1 真实日志样本

仅从本机活动数据根的 `execution-logs/conversation-run-*.json` 提取时间、计数和状态；不把原始输入、系统提示词、记忆正文或完整日志复制进仓库。以下时间为香港时间，样本 ID 仅保留前 8 位。

| 样本 / 开始时间 | 结果 | 总用时 | DECIDE | EXECUTE | VERIFY | EVOLVE | 工具执行合计 | 模型请求快照数 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A `ccbd81ea` / 09-12 10:42:59 | ok | 106.290 s | 14.159 s | 79.349 s | 2.051 s | 8.121 s | 0.642 s / 8 次 | 11 |
| B `e9cb6922` / 09-12 10:51:03 | ok | 160.628 s | 13.389 s | 120.400 s | 3.291 s | 20.589 s | 0.819 s / 11 次 | 12 |
| C `8b284edc` / 09-12 11:18:16 | aborted | 67.882 s | 12.854 s | 53.316 s | — | — | 无工具执行 | 5 |

读法和限制：

- 阶段耗时来自 trace 的 `endedAt - startedAt`；总用时来自 run。工具合计是 invocation 的 duration 求和，包含于 EXECUTE，不可再次加到总耗时里；并行时也不等于关键路径用时。
- A/B 的 ENTER 为 0–1 ms、CLASSIFY 为 18–20 ms、CAPTURE 为 5–8 ms、FINALIZE stage 为 133–278 ms。**把这些 stage 改名/合并，不会消除十几秒模型开销**；Harness 外的 Runner 收尾另需测量。
- 三个样本都有两次 DECIDE 请求，第一次输出恰为 1,400 tokens，第二次预算为 2,100。源码确有解码重试/增大预算；这是排查规划过长与截断的强线索，但日志未给出完整 finish/decode 归因，不能直接断言三次都是同一种失败。
- A 的一次 EXECUTE 请求耗时 57.764 s、输出 16,215 tokens；B 的一次耗时 73.573 s、输出 19,772 tokens。输出包括工具参数、推理等，不能等同于用户可见正文。高 TPS 与长等待完全可以同时成立。
- B 的 EVOLVE 出现两次请求，合计阶段耗时 20.589 s。它当前仍在交付关键路径中；跳过它和可靠地移到后台不是同一件事。
- C 在 EXECUTE 中止后还有 RECOVER/ASK_USER 请求快照；快照**不证明请求实际到达 Provider**。需要在取消矩阵中检查是否还做了无意义的上下文准备、模型请求或追问。
- 样本没有 Renderer 首帧、SSE 收发、首 token 或真实执行程序构建标识，不能据此宣布“前端没有流式”“瘦身节省了 N 秒”或计算端到端 P95。这只是诊断样本，不是新旧性能对照实验。

### 2.2 当前链路的阻塞与反馈

```text
用户发送 → Renderer 本地占位 → API start / runId
         → 会话/附件/Runner 准备 → 活动路由
         → [规划与重试] → 模型生成文字或工具参数 → 权限/工具 → 后续模型轮次
         → [汇总回答] → 验证 → [EVOLVE] → CAPTURE
         → Runner 记忆反馈/压缩/持久化/回复结算 → API result → Renderer 完成态
```

方括号表示应按任务需要选择的工作，不表示当前所有分支都已经可选。需要区分四种反馈：已接收、运行时正在做什么、模型正在生成什么、结果已可靠结算。首个 `start` 或心跳只能证明连接/接收，不能当作首回答。

源码已有本地占位、提前发送 SSE `start`、正文增量缓冲（动画帧/约 16 ms）及 EXECUTE 流式路径；不能重复实施“加一个 start/打开 stream=true”后宣称问题结束。仍有非流式模型调用、准备阶段缺细分反馈、事件归并错误和收尾阻塞，具体如下。

## 3. 审计发现

### F01 · P0：回复纠偏产生非法状态迁移

`reply.ts` 检测到 DSML 后返回 `reply → decide`，但 `allowedTransitions.reply` 只有 `verify/finalize/exit`。两个驱动都会执行迁移检查。只测 REPLY 返回值的测试会通过，整条流程却会拒绝该边。

`[代码][探针]` 当前 `inspectStageTransition('reply', 'decide')` 返回 `ok:false`。此外，模型输出控制语法本身不是用户授权：普通问候、查询或讲解 DSML 时，不能直接升级成可写任务。修复必须同时处理路由意图、转移契约、已用预算、预览撤回和 checkpoint，而不是只在表里加一条边。

来源：[reply.ts](../../packages/harness/src/stages/reply.ts) `containsDsmlControlMarkup` 分支；[stage-transitions.ts](../../packages/types/src/stage-transitions.ts)；[durable-harness.ts](../../packages/harness/src/durable-harness.ts) `inspectStageTransition`。任务：HL-01。

### F02 · P0：轻量验证存在错误通过条件

`verifyLeanToolLoopExecution` 只要求工具调用成功、名字在名单里、副作用均成功，以及最后一次 write/edit 后有任意 read/grep/glob 成功。它没有证明读取的是目标产物、内容满足要求、所有变更均被覆盖、副作用 callId 对应、读取未截断或工具来源正确。读取成功也不等于需求满足。

`[探针]` 从当前 TS 源码提取该判定函数及常量，以无 I/O 的记录/发布替身运行：`write A → glob 无关 B`，副作用使用无关 callId，读取标记截断，仍返回 `verdict:pass / next:capture`。这是判定谓词复现，不是实际文件写入或发布测试。

对比已有 `verifyDeterministicWriteReadExecution`：它要求同一路径、完整一致内容、精确步骤/callId/副作用关联，限定得明显更严格。**当前轻量捷径不能标为“验证质量不降低”**。有条件的结构验证可以保留，但不同任务需要对应的证据标准，例如生成游戏不能仅靠文件存在证明可运行。

来源：[verify/routing.ts](../../packages/harness/src/stages/verify/routing.ts)。任务：HL-02；在其验收前禁止扩大轻量准入。

### F03 · P0：没有 TaskBook 时，验证失败可能退化为通过

`hasIncompleteTaskExecution` 在没有 TaskBook 或 taskExecution 时返回 false；`routeKnownIncompleteExecution` 据此把 verifier transport/decode failure 记录为 `degraded pass`，并发布 verified reply。减少 TaskBook 后，这条旧假设更危险：没有记录不是已经完成。

`[代码]` 应以事实区分“目标已由确定性证据满足”“尚未验证”“证据失败”，而不是用有无 TaskBook 决定可信度。证据缺失、验证器不可用、权限拒绝、截断或 unknown effect 不能因降级而变成成功。

来源：[verify/task-state.ts](../../packages/harness/src/stages/verify/task-state.ts)、[verify.ts](../../packages/harness/src/stages/verify.ts)、[verify/routing.ts](../../packages/harness/src/stages/verify/routing.ts)。任务：HL-02。

### F04 · P1：展示开关决定了执行、传输与推理策略

`streamModelTranscript` 同时参与轻量准入、轻量验证、EXECUTE 选择 chat/chatStream，以及 `preferDirectModelOutput` 是否直接返回原请求。Runner 又把它与 `durableHarnessMode === 'next'` 绑定。一个展示字段承担了至少四种职责。

`[代码]` `canUseLeanWorkLoop` 还依赖分类器来源、`reason === 'action verb'` 和中英文关键词。它不是完整的复杂度/风险/验收判断。加关键词可能减掉一次规划，也可能绕开必要的任务状态。后续应分离执行策略、传输能力、用户推理配置和 Renderer 披露模式，不以关掉模型推理换取未经说明的速度提升。

来源：[lean-work-policy.ts](../../packages/harness/src/lean-work-policy.ts)、[model-observability.ts](../../packages/harness/src/model-observability.ts) `preferDirectModelOutput`、[model-transcript.ts](../../packages/harness/src/stages/execute/model-transcript.ts)、[runner.ts](../../packages/runner/src/runner.ts)。任务：HL-05。

### F05 · P1：过程事件的增量/快照语义冲突

`[代码]` 工具准备事件发送累计摘要，却标成 `model_reasoning/running`；REPLY 的思考事件发送累计文本的最后 240 字符。Renderer 将所有运行中的 `model_reasoning` 当增量拼接。因此会重复文本、迅速碰到 8,000 字符上限，再在完成时被全文替换。Runtime 参数计数也被伪装成模型思考。

其他同一链路问题：

- 准备阶段只维护一个工具名和计数，忽略原生流的 call index/id，多工具交错时失真。
- `string.length` 被显示成 B/KB，中文和 Unicode 下并非字节；原生函数名也可能分片。
- reset 清了后端缓冲和正文，没有对应 Renderer 思考行重置；重试可能混入上次内容。
- tool-loop 的 `stop` 和异常返回早于 `closeTranscriptTurn`，过程行缺少稳定的结束事件。
- 参数生成每 chunk 都触发活动状态更新，而正文已有帧缓冲；高频更新成本尚未压测。

来源：[model-transcript.ts](../../packages/harness/src/stages/execute/model-transcript.ts)、[reply.ts](../../packages/harness/src/stages/reply.ts) `emitReplyThinking`、[run-event-handlers.ts](../../packages/app/src/renderer/chat/run-event-handlers.ts)、[tool-loop.ts](../../packages/harness/src/stages/execute/tool-loop.ts)。任务：HL-04。

### F06 · P1：流式覆盖不完整，完成正文仍可能整段出现

`[代码]` EXECUTE 的工具循环可以流式，但 TaskBook 路径的 `synthesizeFinalReply` 使用 `callModelChat`。规划、验证、恢复和记忆 JSON 也不是正文流。不能把内部 JSON 原样展示给用户，但必须有准确的 Runtime 活动与请求状态。

Renderer 发送时已建立 assistant 占位，API 已提前发送 `start`；它们只解决“已收到”，不覆盖附件准备、扫描、规划重试、长工具参数生成、验证和最终持久化。API 在 `finishRunResources` 完成后才发送 result。大段工具参数必须完整校验后才允许执行，不能为了早出现“运行中”而提前执行半份命令。

来源：[execute/final-reply.ts](../../packages/harness/src/stages/execute/final-reply.ts)、[run-actions.ts](../../packages/app/src/renderer/chat/run-actions.ts)、[assistant-delta-buffer.ts](../../packages/app/src/renderer/chat/assistant-delta-buffer.ts)、[run-routes.ts](../../packages/app/src/main/local-app-api/run-routes.ts)。任务：HL-04、HL-06、HL-07。

### F07 · P1：TPS、缓存及请求快照不足以支持性能结论

`[代码][探针]`

- Provider 起始计时只在 `callModelChat/callModelChatStream` 设置；JSON helper 路径的 `beforeRequest` 只等待 started，没有同等计时。A/B 的 DECIDE/VERIFY/EVOLVE duration 缺失与此一致。
- `aggregateRunUsage` 把所有请求输出相加，duration 只加已报告项。探针：未计时请求输出 1,000，计时请求输出 100、用时 1 s，合计显示 1,100 tok/s；这不是任何一致口径的生成速度。
- 聚合层遇到部分缓存字段缺失时省略字段，页脚随后 `cachedPromptTokens ?? 0`，把未知显示成 0% 命中/全部未缓存。不能据此判断缓存坏了。
- 当前运行用量从有界快照汇总；每 run 最多 64 份模型请求快照，长 run 不能依赖这个显示窗口作为完整账本。
- EXECUTE 请求准备时没设置 stream，但调用包装层最终使用 chatStream，记录中的 stream/payload 与实际传输选项可能不一致。A/B 所有快照显示 stream=false，不能据此认定真实网络不流式。
- 缺 Provider 首 token、首正文、首工具参数、API 发出、Renderer 接收与绘制的关联时间点；当前 TPS 也不能代表首 token 延迟。

来源：[model-observability.ts](../../packages/harness/src/model-observability.ts)、[decide/model-call.ts](../../packages/harness/src/stages/decide/model-call.ts)、[context-engine/contracts.ts](../../packages/context/src/context-engine/contracts.ts)、[run-usage.ts](../../packages/app/src/shared/run-usage.ts)、[assistant-turn.tsx](../../packages/app/src/renderer/chat/assistant-turn.tsx) `TurnUsageFooter`。任务：HL-03。

### F08 · P1：系统提示词展示不是最终发给模型的精确投影

`[代码]` REPLY/EXECUTE 在 `prepareModelRequest` 之前投影 prompt，后者还会注入记忆已知状态、working set、Runtime 信息和 ContextEngine 处理。投影又只能每 run 一次，早于 EXECUTE 的 DECIDE 以及后续纠偏/重试提示词可能不在其中。

保留用户要求的“每 run 一行、可展开全文”，但必须标明对应 request/purpose；一行内可查看同 run 的实际请求版本/变更。不能把基础 prompt 称作“完整实际系统提示词”。该产品功能只展示 LS 自身已授权的运行时提示词，不能混入开发助手环境提示词、密钥、网络认证材料或跨 scope 内容。

来源：[system-prompt-transcript.ts](../../packages/harness/src/system-prompt-transcript.ts)、[reply.ts](../../packages/harness/src/stages/reply.ts)、[execute.ts](../../packages/harness/src/stages/execute.ts)、[model-observability.ts](../../packages/harness/src/model-observability.ts)。任务：HL-04、HL-09。

### F09 · P1：规划、执行汇总和重复验证有真实串行成本

`[代码][日志]` 完整路径先规划，再逐步执行并汇总，最后验证；普通单目标任务也可能支付这组调用。DECIDE 的通用 JSON 为 1,400 tokens 起步、最多两次，紧凑分支另有 250/400 预算；三个样本的第一轮均触顶，应先减少不必要字段和重复内容，再按 finish/decode 原因修复，不能简单放大所有预算。

工具循环已存在 20 轮上限和连续两次无新证据收口，并非完全失控。但“不同 grep/读取片段”不一定等于新验收证据；输出截断也可能诱发反复检查。长产物生成不能靠统一削减输出上限解决，否则会产生不完整文件。应把验收条件关联到证据，按缺口读取/运行验证，满足后复用同一份真实 LLM 文案完成结算，而不是再无条件生成一次总结。

来源：[decide/model-call.ts](../../packages/harness/src/stages/decide/model-call.ts)、[stages/_shared.ts](../../packages/harness/src/stages/_shared.ts)、[execute/runners.ts](../../packages/harness/src/stages/execute/runners.ts)、[execute/task-book-runner.ts](../../packages/harness/src/stages/execute/task-book-runner.ts)、[execute/final-reply.ts](../../packages/harness/src/stages/execute/final-reply.ts)、[execute/tool-loop.ts](../../packages/harness/src/stages/execute/tool-loop.ts)。任务：HL-05、HL-06。

### F10 · P1：记忆维护尚未真正离开交付关键路径

`[代码][日志]` EVOLVE 虽有 adaptive gate，但 standard/complex 任务、恢复以及 write/edit/exec 等即可触发；A/B 分别耗时 8.121/20.589 s。轻量 VERIFY 直接去 CAPTURE，会跳过 EVOLVE；当前未看到该分支为长期沉淀建立等价的持久待办，因此不能将它描述为“后台沉淀”。

CAPTURE 默认有确定性实现，当前样本只有毫秒级，无证据支持为提速删除它。其 LLM 可选分支的“non-blocking”注释只代表异常不阻断，调用仍被 await。Harness 之后 Runner 还依次做 source capture、反馈、summary activation、finishRun、条件压缩等。必须测量并划分必要持久化与可延后派生工作，而不是把它们一起 fire-and-forget。

来源：`evolve.ts`、`evolve/signal.ts`（两者已随极简方案删除，见 `docs/decision/project-status.md` 2026-09-20 条目）、[capture.ts](../../packages/harness/src/stages/capture.ts)、[runner-finalize.ts](../../packages/runner/src/runner-finalize.ts)、[runner-persist.ts](../../packages/runner/src/runner-persist.ts)。任务：HL-08。

方向更新：上述为当前实现的审计事实；处置按第 1.3 节执行，将自动沉淀并入已有压缩入口，**不要求为每个 run 创建 EVOLVE 待办**。可靠恢复记录以压缩覆盖区间/版本为单位，必要时仅补齐尚未提交的摘要或记忆候选。

### F11 · P1：取消、恢复与无 TaskBook 执行的证据连续性需补齐

`[代码][待测]` `checkpoint-resume.ts` 对“任务已经完成”的判断依赖 TaskBook/step results。轻量循环移除它后，不能假设重启、追问、局部重做、运行中改目标仍天然保持原保证。需要按持久化工具/副作用/目标证据恢复，而非从头再调用模型执行。

日志 C 的中止后请求快照是取消专项回归的入口，但不能据此宣称发生了额外外部执行。signal abort、durable stop、权限拒绝、Provider 中断、待批准与 effect unknown 必须分别处理；取消不能触发普通 LLM 恢复/追问链，也不能抹去尚未对账的副作用。

来源：[checkpoint-resume.ts](../../packages/harness/src/checkpoint-resume.ts)、[durable-harness.ts](../../packages/harness/src/durable-harness.ts)、[stages/recover.ts](../../packages/harness/src/stages/recover.ts)、[runner.ts](../../packages/runner/src/runner.ts)、[durable-effect-lease-coordinator.ts](../../packages/runner/src/durable-effect-lease-coordinator.ts)。任务：HL-10，作为 HL-05 灰度前置门。

### F12 · P2：准备与上下文开销存在，但应先测再删

`[代码][待测]` Runner 在模型之前 await 工作区资源/文档同步、历史会话/缓存观察、context 构建、memory beginRun 等。文档扫描有数量/目录深度上限且不默认读正文，权限不足会延后扫描；不应误称为无界全盘扫描。热 run 是否重复扫、冷启动是否被 tokenizer/索引初始化阻塞、每请求 token 计数和投影成本各占多少，目前没有完整分解。

已有稳定工具排序、cache boundary、按索引读取和上下文预算，不能重做一套平行缓存。`recentHistoryForModel` 已是有界历史，并在工具继续轮次进一步缩减，不是“全历史直塞”。必须证明约束/偏好经 summary 或索引仍可恢复，不能以更小 prompt 换失忆。

来源：[runner.ts](../../packages/runner/src/runner.ts)、[harness/context.ts](../../packages/harness/src/context.ts)、[memory-service/workspace-documents.ts](../../packages/memory-tree/src/memory-service/workspace-documents.ts)、[model-observability.ts](../../packages/harness/src/model-observability.ts)、[runtime-awareness.ts](../../packages/harness/src/runtime-awareness.ts)、[execute/tool-loop.ts](../../packages/harness/src/stages/execute/tool-loop.ts)。任务：HL-07、HL-09。

### F13 · P2：双驱动与多份派生状态加大修改半径

`[代码]` default/durable 驱动复用 stage，但各有控制消费、hook、转移检查和运行循环。分类结果、TaskBook、taskExecution、verification、reply settlement、durable projection、UI activity 又分别承担事实/决策/展示。它们不是全都冗余；真正的问题是改一个路由时没有自动验证所有消费者，F01 就是实例。

不再新增第三套 `ROUTE/WORK/SETTLE` 持久状态机。先建立一次权威执行与派生关系，提取共同驱动规则，保留旧 stage/checkpoint codec 做兼容读取；只有实测/契约证明不再需要时才删除旧实现。

来源：[default-harness.ts](../../packages/harness/src/default-harness.ts)、[durable-harness.ts](../../packages/harness/src/durable-harness.ts)、[durable-kernel.ts](../../packages/harness/src/durable-kernel.ts)、[run-context-contract.ts](../../packages/types/src/run-context-contract.ts)、[history-activity.ts](../../packages/app/src/shared/history-activity.ts)。任务：HL-11。

### F14 · P1：DSML 兼容仍是跨层纠偏，长流和引用场景缺合同

`[代码][待测]` LLM client 每个 content chunk 扫描累计文本；进入 DSML 后也反复查找首个 invoke 名字，并统一发 index=0。随长输出增长有重复扫描成本，多调用无法准确区分。协议分隔符切在 chunk 边界时，识别前已输出的前缀需要 reset；正文/代码引用中的控制语法也需要与真正工具意图区分。

现有完整封套解析和工具白名单是必要边界，应收敛成 Provider 适配层的增量解码与原生工具事件；Harness 不负责二次解释整份协议，Renderer 更不能靠隐藏字符串制造“已修好”。无效、残缺或未知工具不得执行，讲解协议的文本不得改变任务授权。

来源：[llm/client.ts](../../packages/llm/src/client.ts)、[dsml-tool-calls.ts](../../packages/llm/src/dsml-tool-calls.ts)、[reply.ts](../../packages/harness/src/stages/reply.ts)。任务：HL-01、HL-04。

## 4. 应保留、合并、按需及延后的职责

以下是设计方向，不是新增对外术语或立即迁移数据库 schema 的要求。

| 现有职责 | 处置 | 不可丢失的保证 |
| --- | --- | --- |
| ENTER / 活动路由 | 轻量入口与事实化进度；明确场景不单独问模型 | 当前请求/continuation 绑定、范围和权限不受模型改写 |
| DECIDE / TaskBook | 复杂任务、目标冲突、跨阶段协作时按需启用 | 即使无 TaskBook，也有目标、作用域、验收条件、证据和剩余缺口 |
| EXECUTE | 统一工具循环；计划是输入，不另造工具执行器 | 参数校验、权限审批、工具白名单、预算、effect lease/settlement |
| VERIFY | 证据驱动；确定性可证则免额外 LLM，否则明确调用 | 成功调用不等于任务通过；unknown 不能自动成功 |
| RECOVER | 分类错误后局部修正；取消/拒绝/unknown effect 不走普通重试 | 有界预算、保留已完成步骤、不重复副作用 |
| REPLY / ASK_USER / 最终汇总 | 共用请求、文案登记与流式发布边界 | Agent 文案来自真实 LLM，追问只在真实缺事实/权限时发生 |
| EVOLVE / 派生记忆优化 | 自动沉淀并入上下文压缩；不再每 run 单独调用或排学习待办 | 原文可回查，压缩候选去重、版本/作用域/证据闸门及恢复 |
| CAPTURE / 原始流水 | 必要事实落盘保留前台；模型提炼并入压缩 | 用户事实及证据不丢，不能只保最终摘要；显式记忆指令即时处理 |
| FINALIZE / Runner settle | 收敛唯一结算负责人，测量并去除重复装配 | 回复注册、审计、effect 与 session/durable 一致；unknown 不宣告成功 |
| Context / cache / UI | 复用权威输入和一次请求投影，展示只消费事件 | 预算/隔离/截断标识，Normal/Compact 不影响执行或模型策略 |

目标主路径可用“接收与路由 → 工作循环 → 可靠交付”理解，内部正交的权限、effect、运行控制、请求生命周期和持久化状态仍各负其责。三个宏观阶段仅供理解，不能与旧 stage、durable projection 再组成三套调度权威。

## 5. 实施任务清单

审计时本表状态统一为“待开始”；截至 2026-09-14，HL-00～06 及前两批受影响的 HL-10 已达到代码交付门，详见第 9/10 节和实施包交付记录。HL-08/09、配套 HL-07/10 的第三批目前仅完成设计，其余任务及真实性能/发布门不得连带标绿。P0 优先修正确性；P1 为主线；P2 在有基线和稳定契约后进行。S/M/L 表示相对修改规模，不是工期或性能承诺。每个任务完成后更新状态、证据与限制，不仅填测试数量。

HL-00～HL-04 的可交接规格见 [第一批实施包](harness-lean-phase-a-implementation-taskbook-2026-09-12.md)：固定最小修复决定、文件边界、请求/流式合同、失败用例及逐包命令。第一批不扩大轻量准入，也不实施 HL-08。总任务书保留总体方向，实施包约束第一批具体范围；需要偏离时先记录理由并复核。

| ID | 优先级 / 规模 | 交付物 | 前置依赖 |
| --- | --- | --- | --- |
| HL-00 | P0 / S | 可复现基线、缺陷夹具、运行构建身份 | 无 |
| HL-01 | P0 / M | 路由纠偏/迁移与工具协议边界闭合 | HL-00 |
| HL-02 | P0 / M | 轻量与完整路径一致的验证底线 | HL-00 |
| HL-03 | P1 / M | 统一模型请求计时、完整用量与未知语义 | HL-00 |
| HL-04 | P1 / M | 全链路类型化进度、真实流式与展示归并 | HL-01、HL-03 |
| HL-05 | P1 / L | 与 UI 解耦的轻量工作循环及按需规划 | HL-01、HL-02、HL-03；上线另须 HL-10 |
| HL-06 | P1 / M | 规划/总结/验证去重和证据驱动停止 | HL-02、HL-03、HL-05 |
| HL-07 | P2 / M | 热路径准备/扫描与前台收尾优化 | HL-03 |
| HL-08 | P1 / L | 压缩驱动的一次语义提炼与记忆提交，取消逐 run 沉淀 | HL-02、HL-03；上线另须 HL-10 |
| HL-09 | P2 / M | 上下文/缓存稳定性与长会话连续性 | HL-03、HL-05；联验 HL-08 |
| HL-10 | P1 / L | 取消/恢复/权限/effect/最终结算矩阵 | HL-00；与 HL-05/08 迭代联验 |
| HL-11 | P2 / L | 双驱动/契约收敛，兼容迁移与删除清单 | HL-01、HL-02、HL-05、HL-10 |
| HL-12 | P1 / M | 配对基准、真实 Electron 验收及灰度门 | 待发布批次的任务及 HL-10 完成 |

### HL-00 · 固化基线与失败用例

范围：现有 `test`、`scripts/verify-harness-path-comparison.mjs`、构建身份/运行诊断及本任务书。

- 在安全的本地证据目录记录源树/构建指纹、实际入口、模式覆盖来源、策略版本、Provider/model/reasoning、脱敏测试环境；禁止将配置密钥、会话/记忆原文纳入源码快照。
- 把 F01/F02/F03/F05/F07 的最小反例变成自动化回归，包括驱动集成而不只是 stage 单测；修复前能稳定失败，修复后能稳定通过。
- 固定普通聊天、只读查询、单文件生成/修改、复杂依赖、历史连续性、审批/取消、工具故障任务集；预先写清验收标准和产物 oracle，不能由当前 verifier 自己定义“正确”。

验收：同一构建/run 可追溯；用户桌面实际加载版本可读；复现步骤不依赖当前脏树偶然状态；无真实 Provider 成本的基线先可运行。禁止用 `git reset --hard` 等方式清理当前工作树。

### HL-01 · 路由与协议纠偏闭合

范围：`types/stage-transitions`、`harness/stages/reply`、两套驱动、checkpoint/ownership contract、`llm/client` 与 DSML 适配。

- 明确真正执行意图、respond 协议错误和引用示例的区别。执行意图成立时才走有界路由纠偏；不成立时重试修复回复或给 Runtime 错误，不从模型语法推导写入授权。
- 一个权威的转移声明覆盖阶段、驱动、回放、恢复和测试。纠偏继承本轮工具/权限/调用预算，不清零重试计数、不重复正文。
- DSML 解码统一输出标准工具事件；使用完整白名单、完整参数和原工具服务校验。完整封套是执行前提，流式准备不构成工具开始。

验收：两驱动覆盖 respond→纠偏→执行及失败、原生工具、分块 DSML、多调用、截断、未知工具、转义/引用协议、问候/状态询问；没有非法边、协议泄漏、自动越权或无界纠偏。需测试结束前撤回与最终持久化一致。

### HL-02 · 修复验证底线，保留可证明的快速验证

范围：`harness/stages/verify*`、执行证据、失败状态、memory feedback 使用的验证事实。

- 先收紧/停用 F02 的宽泛捷径及 F03 的无证据 degraded pass；只允许已证明等价的狭窄验证器免 LLM。
- 复用现有字段或最小证据结构关联目标/验收条件、产物版本/路径、tool source/callId、effect、读取/测试输出、截断和缺口；不另造一整本简化 TaskBook。
- 读取、写入、代码可运行、外部请求成功采用不同证据要求。不能强制每个任务都增加一轮通用模型“自检”。

验收：错文件/错内容、无关 glob、读取后又修改、多文件只验证一个、截断输出、插件同名工具、失败或缺失 effect、验证器异常、无 TaskBook 的不完整执行均不得 pass；精确写读、只读事实查询的合法快速路径仍通过。对失败/未知不产生“已验证完成”的最终文案或长期成功记忆。

### HL-03 · 统一模型生命周期和延迟/用量观测

范围：`harness/model-observability`、JSON helper 及所有调用点、`llm/client`、types token ledger、Runner 计数、`app/shared/run-usage` 与页脚。

- chat、chatStream、JSON/retry 使用同一请求生命周期；每次重试独立 requestId/attempt/retryOf，真实传输选项在投影前确定。
- 记录 prepare、durable-start wait、Provider dispatch、首 reasoning/正文/工具参数、结束、解析/验证、settlement；包含无首 token、取消和 usage 缺失状态。
- 完整 run 用量以权威累计账本为准，独立于 64 份诊断快照；记录计时覆盖率、usage 完整性和多 Provider/model 分组。
- TPS 分子分母必须来自同一请求集合。缺计时则标 partial/不可用；未知缓存/推理字段不补零。run 吞吐与 Provider 生成速度分别命名，均不冒充 TTFT。

验收：全部计时、部分缺失、失败重试、65+ 请求、真实零缓存、未提供缓存、混合模型、推理 tokens 包含关系、流式 usage fallback 均可对账。统计逻辑不能改变请求形状来刷命中率；遥测异常不绕过模型持久化边界。

### HL-04 · 全链路进度与流式投影收敛

范围：LLM 流解码、`model-transcript`、reply/final-reply、types 事件、API SSE、Renderer reducer/活动行/历史投影。

- 明确 delta、replace/reset、snapshot、done/failed/aborted 的语义；工具准备作为 Runtime 事件，带 request/attempt/call index，不归类为模型思考。Runtime 阶段标签与真实 Agent 文案分离。
- 同一流按序归并，多工具参数分片、函数名分片、工具名未出现时均可展示事实；参数量用正确字节数或明确称字符数。
- 共享节流/帧缓冲，保留即时首事件；长 JSON 不逐帧整段重排。任何 stop/error/reset/cancel 都闭合旧事件，不在重试后混入前次思考或预览。
- 覆盖最终汇总文本的流式预览，完成态仍走唯一回复登记/结算。编排 JSON 只显示 Runtime 活动，不向对话泄露。
- Normal/Compact、实时/历史、重连/恢复使用同一投影规则；错误、拒绝、待批准不可被折叠隐藏。系统提示词一行从实际 request 取版本化投影；SVG 覆盖系统、思考、上下文、准备、工具、旧历史 fallback，Input/Output/Running 状态一并做视觉回归。

验收：延迟注入模型在完成前可看到逐段真实正文或准确的参数准备进度；停止后不留永久 Running；高频分片无重复思考。测 SSE 发出→接收→绘制耗时，而不是仅断言事件数组非空。详见第 6 节性能门。

### HL-05 · 用有界工作循环替代零散轻量捷径

范围：`lean-work-policy`、classify/decide/execute、工具可用范围、RunContext policy、checkpoint。

- 执行策略独立于 stream/展示/next 标志；尊重用户 reasoning 设置。统一 route/work admission 原因和版本，替代对自然语言 reason 字符串的硬依赖。
- 普通明确目标直接进入同一个有界工作循环，保留最小目标/范围/验收/完成证据。规则负责高置信分类；模型必要决策尽量与第一轮工作合并，不另叠一轮“轻量规划模型”。
- 发现跨步骤依赖、范围/验收不明确、需要长期续跑或预算压力时升级已有 TaskBook，继承已经完成的证据和副作用；不从头执行。
- 不因无需 TaskBook 就给模型扩大工具授权；权限仍由 Main 在执行时判断。

验收：等价中英文/不同措辞、Normal/Compact、是否订阅思考流不会改变权限和任务完成保证；固定简单任务无需独立 DECIDE 调用；复杂任务仍保留计划/部分重做能力。安全与恢复矩阵 HL-10 未过，不能放大准入范围。

### HL-06 · 减少重复模型工作与无效工具轮次

范围：decide 请求/schema/retry、execute task/loop/final-reply、verify 证据选择与模型预算。

- 按实际目标裁剪规划字段、重复提示和冗长输出；解码失败、length、transport、schema 错分别处置并计费。保留硬预算，不以不断重试求通过。
- 同一个合格的 LLM 最终候选只经过一次最终登记，流式、日志、落盘复用；只有缺必要综合信息、重复文案/引用修复等明确原因才再调用汇总模型。
- 验收已满足时停止查找；读取按当前缺口选择范围。大文件优先可验证的读取/测试证据，不能把截断看作完整，也不能因工具“有输出”就认为有进展。
- 长产物生成保留完成任务所需预算；优化重复全文件重写/无谓大参数，不能通过截短代码造高 TPS/低耗时。

验收：样本类任务每次规划重试/总结/自检都有归因；无默认额外总结轮、无不增加证据的无限 grep/read；相同产物验收下比较模型请求数、输入/输出、费用与完成时间。质量 oracle 独立于模型自评。

### HL-07 · 准备与交付关键路径减法

范围：API run-routes、Runner 初始化/收尾、context、workspace resource/document coordinator、版本 checkpoint。

- 先按 HL-03 分解冷/热准备成本。热工作区资源同步使用明确 revision/dirty 标记；权限或 scope 变化必须使缓存失效，不以后台预扫绕过审批。
- 只并发没有依赖、没有状态竞争的只读准备；明确取消、过期结果丢弃与索引预算。必须使用最新上下文的任务不得读取过期缓存。
- 逐项列出 result 前 await 的用途和耗时：审计/回复/副作用结算保持硬前置，派生 UI/可重建索引更新只有在有恢复机制后才能后移。
- 冷 tokenizer/ContextEngine/序列化是否占主线程由 trace 确认后再优化；不先引入常驻 worker 池或第二套缓存。

验收：冷启动、连续热 run、工作区切换、外部研究/受限权限、大目录、附件、损坏索引与取消均有准备阶段反馈；未批准无扫描；失效正确。只有基准证明有收益且资源不劣化的改动才能合入。

### HL-08 · 自动记忆沉淀并入上下文压缩

范围：evolve/capture、Runner finalize/session-continuity、session compaction、已有 daily consolidation 与 memory intent gates。采用第 1.3 节用户方向，替代原“每轮派生工作移到后台”的宽泛方案。

- **删除重复触发。** 普通 run 结束不调用独立 EVOLVE/LLM CAPTURE，也不为该 run 排一份等价模型学习任务。保留可靠的原始会话/执行事实、权限与 effect 证据、来源登记和唯一回复结算；轻量路径与 TaskBook 路径采用同一规则。
- **复用压缩入口。** `maybeCompact` 确认存在新增覆盖区间后，使用同一不可变快照做一次语义提炼，目标输出为续跑摘要及有界长期候选。会话摘要保留目标、约束、决定、未完成工作、产物与关键标识；长期候选仅含具备持久价值的事实/偏好/经验，包含 source message/evidence refs、scope、权威与置信度。不把整份摘要直接写成长效规则，不默认再追加一轮 EVOLVE。
- **在丢失细节前提炼。** 长期候选必须基于本次待压缩的原始消息/证据与已有摘要，而不是只读已经有损压缩的结果；增量提炼以覆盖区间和水位定位，避免重复理解全历史。上下文预算不足时有界分批，记录调用归因，不能截断关键证据后仍提交高置信记忆。
- **复用写入闸门与持久记录。** 以 session、覆盖区间 hash、策略版本关联本次摘要和候选；原始来源先可靠存在，候选校验/提交走既有 intent gate、去重与冲突规则。若分存储不能原子提交，持久记录哪些已成功、哪些待补，优先重放同一已校验结果，不因单次写库失败重调模型；复用既有存储/协调能力，不另建通用后台任务平台。
- **处理压缩并发。** 检查 session revision 与 summary 前驱，使用 CAS 或已有等价机制；过期摘要不能覆盖新消息。新消息留在压缩水位之后，不能因旧快照覆盖范围错误而被吞掉。模型调用/解析失败保留旧摘要和原文；候选写入部分失败不能伪装整批已完成，也不撤销已安全提交的原始记录。
- **未压缩也可记忆连续。** 短会话或退出不自动触发模型提炼；原始记录及有界来源索引在重启、同轮与跨会话检索中可达，遵循 root → branch → expand，不默认把全会话注入上下文。明确“记住/纠正/忘记”按用户任务即时处理；删除/撤销留下版本标记，后续压缩不得从旧原文重新激活已撤销记忆。
- **调度不转移卡顿。** 压缩由实际上下文压力或显式压缩请求触发，单纯 task-end 不是语义沉淀触发条件。软阈值允许有余量时提前压缩并合并区间，硬上限需等待时显示 Runtime 压缩状态；工作使用独立生命周期和受限资源，不捕获可变 RunContext/过期 signal。压缩调用/费用单独标记并纳入总账，不能从页脚消失来制造提速。

验收：

1. 未达压缩条件的连续普通任务，独立自动 EVOLVE/LLM CAPTURE 调用数为 0，后台也没有逐 run 学习调用；源记录、证据及回复结算完整。
2. 一次正常压缩用同一请求生成摘要与候选，没有无条件第二轮沉淀；相同区间重试/重启不重复创建 atom，提交失败可从已生成结果恢复。
3. 立即追问、未压缩短会话重启/跨会话回查、长会话压缩后续跑均能找到必要事实；显式记住/纠正/忘记即时生效，后续压缩不会复活已撤销事实。
4. 摘要成功而候选失败、无长期候选、冲突记忆、跨 scope 来源、压缩期间新消息、模型中止/崩溃、硬上限及资源拥塞均有明确结果；原文不丢，旧摘要不覆盖新消息。
5. 单测与真实基准分别报告普通轮和压缩轮的首反馈/完成延迟、模型调用/总 tokens/费用、峰值资源。合并输出若造成更多解码重试或更慢的压缩，必须减小 schema/调整预算并重新验证，不能把“不每轮调用”当作自动达成绩效。

### HL-09 · 上下文/缓存只做有证据的减法

范围：ContextEngine、prompt/runtime/memory 注入、cache observation、history/working set。

- 用同任务/同权限/同模型的前缀散列和请求差异定位抖动，不为了提高命中率固定错误的时钟、权限或会话信息。
- 稳定 policy/tools 前缀与动态 run 信息按已有机制分离；复用同一实际 request 投影，避免第二套上下文拼装与精确 token 计数重复。
- 查清 history 收缩后约束/偏好/产物位置如何经 summary/索引回查；使用长会话、跨会话、同名不同项目、冲突记忆与压缩后继续任务测连续性。

验收：未知缓存保持未知；hit/miss/write 按 Provider 口径对账；无跨 session/project/permission 泄漏、无默认全树注入、无必要记忆丢失；计算/序列化开销和总成本实测后才能宣布收益。缓存命中率不是硬保值承诺。

### HL-10 · 运行控制、恢复与结算不退化

范围：Harness 驱动/checkpoint、Runner durable run/effect/inbox/reply stores、权限与生产路由。

- 为轻量和 TaskBook 路径共用取消/暂停/待批准/失败/恢复边界；中止不再发新模型工作，已发生或状态不明的 effect 仍须结算/对账。
- 验证中断发生在 intent 前后、工具已成功但尚未落盘、回复已登记但未确认、run lease 失效、应用重启、会话重连、用户运行中补充目标等位置。
- 重启使用权威证据，不重跑已完成步骤；unknown effect 保持待对账或请求决定，不降级旧路径盲重做。最新权限、路径边界、硬拒绝必须重新检查。

验收：零重复副作用、零未经授权操作、零重复最终回复、零静默丢失已接受消息；过期事件不能修改新 run。网络关闭、Provider timeout、审批拒绝和原始 signal abort 分别有终态及可恢复边界。

### HL-11 · 收敛双驱动与状态/文档契约

范围：default/durable driver、stage manifest、RunContext field ownership、codec/replay、API/UI 派生、AGENTS/决策与导航文档。

- 列出每项事实的唯一 owner、写入时点、持久化表示及派生消费者；先收敛转移/控制/预算/hook 规则，再删除重复实现。
- 临时对比/灰度策略有明确删除条件；不把 shadow/next/lean/stream/display 组合变成无限兼容矩阵。
- 旧 stage/checkpoint/log 保留版本化读取适配；不为了内部改名迁移所有用户历史。每次删除列出依赖、替代与回退方案。
- 更新 AGENTS 描述的主流程、默认模式和文档入口，但不降低权限/记忆/真实 LLM 文案要求。

验收：旧 checkpoint/未结算 run 可读可续，非法边静态/运行时均捕获；同一故障只修一个权威执行点；文档、类型、测试与实际默认一致。减少文件/状态数量仅作辅助数据，不作为完成标准。

### HL-12 · 基准、交付与灰度

范围：离线契约/延迟夹具、真实 Electron 脚本、Provider 配对验证、本文件与发布记录。

- 每批在固定构建上执行对应门；跨 Harness/Runner/Context/Memory 的公共契约变更至少 `verify:core`，最终候选 `verify:full`，再做真实 Electron 生产路由体验验收。
- 新旧策略交错运行，控制模型、reasoning、工具权限、任务/产物要求、上下文与冷/热状态；分别统计普通任务和复杂任务，保留失败/中止样本，不能换 session 后静默排除。
- 灰度只切策略版本，不切换正在执行或 unknown effect 的 run 所属协议；异常停止新策略接纳，按原协议安全结算/恢复。不得笼统“退回旧路径重跑”。

验收：第 6 节通过并附报告；明确通过的是源码测试、构建还是实际桌面，记录真实载入指纹。不得用一次成功截图、45 个旧单测、编译成功或主观“更顺滑”替代门禁。

## 6. 不降低性能与质量的验收口径

### 6.1 必须测量的指标

| 指标 | 定义 | 注意 |
| --- | --- | --- |
| 本地首反馈 | 用户发送 → Renderer 首个可见占位/状态绘制 | 只证明 UI 响应，不冒充回答 |
| 接收确认 | 请求发出 → API start 被 Renderer 接收 | 与准备结束分开 |
| 首有效进展 | 发送 → 首个与真实请求/工具/准备工作绑定的进展 | 心跳和循环假文案不计 |
| Provider TTFT | dispatch → 首个模型 token 事件 | 分 reasoning/text/tool-args；无 token 不补零 |
| 首正文 / 首工具准备 / 首工具执行 | 三个独立时间点 | 参数生成不算已执行工具 |
| 流式传递/绘制延迟 | Provider chunk、SSE emit/receive、Renderer paint 分段测量 | 同段用单调时钟；跨进程靠关联 ID/校准，不能直接混减 |
| 最终预览与可靠完成 | 首个最终正文 → 已验证/登记/持久结算 → UI done | 预览允许撤回，不提前宣布已完成 |
| 成本与效率 | 每目标请求数/重试原因、完整 tokens、缓存与费用、模型与本地耗时 | 相同覆盖集；缓存未知与 0 分开 |
| 连续性与质量 | 任务 oracle、产物测试、记忆回查、恢复/权限/去重矩阵 | 不以 VERIFY 自己的 passRate 代替质量 |

### 6.2 建议初始性能门（实施前由 HL-00 固定环境校准）

以下是目标，不是本次实测结果，也不承诺 Provider 外部服务时延：

- 受控热启动延迟夹具：本地首反馈 P95 ≤ 200 ms；可流式请求的增量在 Renderer 接收后 P95 ≤ 100 ms 绘制。通过注入慢模型确认不是 run 完成后才绘制。
- 冷启动/附件/索引/等待模型阶段应立即显示对应 Runtime 状态，并且可取消；不能用定时改文案假装真实工作进展。
- 固定普通明确目标不增加独立路由/规划模型轮；已有满足要求的最终候选不再无条件总结一次；自动语义沉淀仅随实际压缩触发，未压缩普通轮次前台/后台独立学习模型调用数均为 0。显式记忆指令按用户任务单独计数，不能拿来掩盖自动收尾调用。
- 长流夹具覆盖不少于 100,000 个小分片、多工具交错及 Unicode；无文本重复、无永久运行态，内存有界。测总处理时间随输入量增长的趋势，避免累计文本反复扫描的超线性退化。
- 真实任务基准建议每类每策略至少 30 个有效尝试，报告 P50/P95、样本数、失败/中止和不确定性；低于样本要求只能写探索性结果。先约定成本预算再启动真实调用。
- 配对基准中简单任务首有效进展/可靠完成显著改善；复杂任务可靠完成 P95、总 tokens/成本与主进程/Renderer CPU、峰值内存不得在等价任务质量下出现稳定退化。暂以相对 5% 为性能预警线，结合重复测量噪声判定，超过需解释并重新批准预算，不能直接宣告通过。
- 安全/重复副作用/重复权威回复/数据丢失的容忍数为 0。任务成功率和记忆连续性不得降低；若样本不足以证明，明确标未验收，而非用平均速度抵消质量损失。

### 6.3 回归任务矩阵

1. 问候、解释/诊断、状态询问、缺事实澄清：无意外工具执行，Agent 文案来自真实 LLM，Runtime 状态不伪装思考。
2. 明确只读、精确单文件写读、修复已有文件、生成可运行小应用：不同验收标准，工具执行成功与功能正确分开。
3. 多文件/依赖/长期任务：升级 TaskBook，失败局部重做，不牺牲已完成成果。
4. 重复问题、同回合流式复用、长会话重复文案、重启/并发发布：注册表一次权威发布，冲突改写有界。
5. 原生工具、DSML、协议引用、无效/截断 JSON、工具名单不匹配、SSE retry/reset/重连：无控制语法泄漏、无半份命令执行。
6. 容器内外、研究/受限/完全访问、符号链接/未知 shell 路径、硬拒绝：Main 权限边界不退化。
7. intent/执行/settlement 各点中止和进程崩溃：不丢已接受输入、不重做 effect、不盲目降级。
8. 同轮/跨会话记忆、未压缩短会话、明确“记住/纠正/忘记”、scope 冲突、压缩同时来新消息、压缩提交中途重启：原始事实可回查，压缩候选可靠落地且不过期覆盖/复活已撤销记忆。
9. 冷/热启动、长工具输出、高频小分片、65+ 模型请求、多模型 usage 缺失、Normal/Compact 与历史恢复：性能与统计均可解释。

## 7. 建议执行批次与止损点

1. **A：基线与正确性封口。** HL-00 → HL-01/HL-02；同时准备 HL-03。此阶段不扩大轻量路径、不删 durable 边界。
2. **B：让实际工作及时可见。** HL-03 → HL-04；先在现有两路径修事件与计时，建立可比较前端基线。
3. **C：减少真正的串行工作。** HL-05/HL-06，配套 HL-10；HL-07 只做有测量证据的本地优化。逐项开关/比较，不把全部改变混成一个“大改快照”。
4. **D：记忆与上下文。** HL-08/HL-09，联验 HL-10；自动沉淀收敛到实际压缩，不保留逐 run 学习待办。先保证原始来源可检索、压缩提交可恢复和显式记忆指令即时生效，再去掉旧 EVOLVE/LLM CAPTURE 触发。
5. **E：收敛与交付。** HL-11、HL-12，更新实际默认与旧文档。删除兼容实现必须满足恢复与回退前提。

任一批出现权限回归、unknown effect 被重做、验证误通过、回复重复、消息/记忆丢失，停止扩大灰度，优先修复；性能对比失去相同任务/模型/上下文条件则重建基线，不以换模型、关推理或减少任务要求替代 Harness 优化。

## 8. 审计阶段已完成的验证与当时尚未证明的事项

已完成：

- 全链路源码审计及最近三个日志的脱敏阶段/请求汇总。
- 执行 `pnpm exec vitest run packages/harness/src/stages/reply.test.ts packages/harness/src/stages/verify.test.ts packages/harness/src/model-observability.test.ts packages/app/src/shared/run-usage.test.ts packages/app/src/renderer/chat/run-event-handlers.test.ts`：**5 文件、45 测试通过**（本次运行约 4.17 s）。这是现有测试结果，不代表 F01–F14 已解决。
- 无文件写入/无 Provider 调用的源码探针：非法 reply→decide 被拒、混合计时口径生成错误 TPS、无关读取仍触发 lean pass。迁移与用量模块直接 TS 转译运行；验证谓词提取源码函数/常量，记录/发布副作用使用替身，因此只证明判定缺口，不证明实际发布已发生。

尚未完成：真实 Electron 收发/绘制剖析、当前加载构建确认、全量质量门、所有负例的持久回归测试、新旧瘦身策略真实配对基准、后台记忆可靠性验收。不能据此给出固定加速百分比、发布就绪或“质量不降低”的结论。

审计阶段确定的下一步最小可执行包是 **HL-00 + HL-01 + HL-02，随后 HL-03/HL-04**。该批现已完成，结果如下；原始审计数据仍保留为实施前证据。

## 9. 第一批实施状态更新 · 2026-09-13

第一批已按既定顺序完成，没有提前实施 HL-05/08/11。详细代码范围、HA-01～04 用例落点、命令与构建身份见 [第一批实施任务书第 9 节](harness-lean-phase-a-implementation-taskbook-2026-09-12.md#9-第一批实施结果与证据--2026-09-13)。

已成立的结论：

- respond/DSML 边界、Runtime 证据优先验证、完整用量/attempt 账本以及 activity stream 的核心错误已修复；错误草稿、非法工具控制、unknown effect 和缺失缓存字段不再伪装成成功或零值。
- Renderer 现在投影真实 model/tool/runtime activity，不直接投影 Harness stage；`tool_preparing` 与真实开始/完成严格分离，正文 preview 仍由权威 settlement 覆盖。
- 标准全仓门禁通过 448 个测试文件、3126 个通过、1 个预期跳过；Electron 36.9.5 新鲜构建、增强 UI 验收和 7 场景 Runtime 连续性验收通过。
- 受控桌面单样本中，本地 Runtime 反馈约 260 ms、真实模型活动约 337 ms，6 字符正文已在最终结算前显示；这只证明流式先后和可见性，不构成 P95 或新旧性能结论。

第一批交付当时仍待后续（2026-09-13；最新状态见第 10 节）：

- HL-05/06 继续减少真正的串行模型工作；HL-08 将普通任务末尾的自动语义沉淀收敛到上下文压缩；HL-10/11/12 完成恢复、双驱动收敛、配对基准和灰度发布。
- 尚未进行真实 Provider 30 次以上配对样本，因此不宣称固定加速比例、初始 200 ms P95 目标已经达成或当前可发布。

## 10. 第二批交付与第三批设计交接 · 2026-09-14

第二批第 12 节已记录工作策略、bounded loop、受保护的 TaskBook 升级、规划/候选/证据减法及控制恢复的代码交付结果；离线/构建及隔离桌面功能门通过。真实 Provider 配对性能和正式启用/灰度未执行。本次第三批设计只核对该交付记录与当前入口，不重新执行第二批全仓/桌面门，也不把早期 HEAD 当成包含全部工作树的完成态。

[第三批实施包](harness-lean-phase-c-implementation-taskbook-2026-09-14.md)给出 C00 → C10A → C08A/B/C → C09 → C07 → C08D → C10B → C12 顺序，明确 20 组 HC 验收与停止点：先保证短会话可回查、显式记住/纠正/忘记即时生效，再实现同次摘要与候选提炼、跨存储幂等与前驱 CAS，最后退出普通任务结束时的自动 EVOLVE/LLM CAPTURE 及等价后台学习。

第三批保持 activity 而非 stage 的投影原则，纳入压缩等待、取消、用量及实时/历史一致性；不删除状态机、不新建通用调度平台，不提前实施 HL-11。第三批现为设计完成，生产实现、HC 门、桌面门、配对性能与发布均未执行。
