# Harness 瘦身第二批实施包：HL-05/HL-06 与配套 HL-10 · 2026-09-13

最后更新：2026-09-14 10:28:47

状态：第二批代码、离线/构建及隔离桌面功能交付已完成，结果见第 12 节；真实 Provider 配对性能及启用/发布未验收。第 1～11 节保留实施前规格与基线，不代表当前仍未实施。上位：[全面审计任务书](harness-lean-audit-taskbook-2026-09-12.md)；前置：[第一批实施结果](harness-lean-phase-a-implementation-taskbook-2026-09-12.md#9-第一批实施结果与证据--2026-09-13)；后续：[第三批实施设计](harness-lean-phase-c-implementation-taskbook-2026-09-14.md)。

## 1. 本批目标与边界

本批承接总任务书第 7 节的 C 阶段：让普通明确任务减少独立规划、重复总结和无效工具轮次，同时保持复杂任务的计划、验证与恢复能力。第一批已覆盖总任务书 A/B 两阶段；本文的“第二批 / phase-b”是实施包编号，不是重复执行总任务书 B 阶段。

主范围为 HL-05、HL-06；HL-10 只纳入新工作循环、升级和候选复用所需的安全/恢复矩阵，HL-12 只纳入本批离线对照与交付证据。HL-07 的准备缓存/并发优化、HL-08/09 的压缩记忆/上下文优化、HL-11 的双驱动删除及完整发布灰度继续后续推进。普通任务仍可能等待 EVOLVE；这项延迟只有 HL-08 实施后才可能消除，不能计成本批收益。

用户已确定自动记忆沉淀随实际上下文压缩触发，不是逐 run 后台学习。本批保留该方向，不增加后台学习队列，也不提前删除原始会话、effect、权限证据或回复可靠结算。

交付分两级：**代码交付门**证明受控用例、真实桌面链路和恢复契约通过；**性能/启用门**还需同模型、同推理配置、同任务质量的配对基准及受影响 HL-10 场景通过。前者不能自动把后者标绿。任务书编制不启动真实收费基准、不切用户模型或配置、不提交推送第一批工作树。

### 1.1 当前源码复核，避免重复实施

以下为 2026-09-13 当前工作树的静态事实，非新的生产现场测量：

| 入口 | 已有实现与本批需要处理的问题 |
| --- | --- |
| `packages/harness/src/lean-work-policy.ts` | 准入依赖 `streamModelTranscript`、规则来源、`reason === 'action verb'` 和措辞正则；排除恢复、澄清、重规划等状态。需要分离展示与工作策略，不能只扩充关键词。 |
| `packages/runner/src/runner.ts` | 当前按 `durableHarnessMode === 'next'` 设置 transcript 开关；兼容旧模式的投影可保留，但不得继续用它决定工作准入。 |
| `packages/harness/src/model-request-policy.ts` | `preferDirectModelOutput` 仍以 transcript 决定是否保留推理；关闭订阅可能触发 Provider 的 disabled/none。需要回归用户配置的唯一解析边界。 |
| `packages/harness/src/stages/classify.ts` | 已有 respond/execute/clarify 路由和恢复澄清绑定，符合准入时可直接进 EXECUTE。不得新增一个无条件轻量路由模型。 |
| `packages/harness/src/stages/decide/model-call.ts` | 已有 compact 250/400 与普通 1400/2200 token 预算、最多两次 JSON 尝试。需要针对重复字段及失败原因改进，不能宣布“新增重试上限”。 |
| `packages/harness/src/stages/execute/task-book-runner.ts` | 已复用 trivial/simple 单步骤、非 toolProposal、done 且无 error 的 output；否则调用最终汇总。需要补全候选来源与适用范围，不能宣布从零实现复用。 |
| `packages/harness/src/stages/execute/tool-loop.ts` | 已有 20 轮上限、连续 2 轮无新证据后禁用工具，以及有界 fingerprint 集合。fingerprint 目前按工具名/状态/输出或 effect key，需核对路径、读取区间、版本及饱和语义。 |
| `packages/types/src/stage-transitions.ts` | 当前无 `execute → decide` 边。工作中升级 TaskBook 需要明确合法迁移及事实继承，不能直接返回非法 next。 |

第一批变更仍在 dirty/untracked 工作树；HEAD `6a4e5f9` 只是实施前检查点。第二批基线必须包括当前 tracked diff 和新增源文件，不能仅检出此 HEAD 当成第一批完成态。已有测试数量是前批证据，第二批要报告实际执行的新结果。

### 1.2 固定原则

- **Harness state controls execution. Runtime activity explains execution. Renderer projects activity, not state.** 继续复用现有事件/SSE/Reducer；升级、规划和验证只在实际工作发生时投影 activity。
- 策略、模型传输、用户推理档位和 Normal/Compact 各有独立职责。显示设置、监听器有无、是否 next 不得改变工具权限、验收标准或用户推理配置。
- 模型输出只提出目标、工具调用、升级或候选；Runtime 校验范围、预算、schema、权限、effect 和验证证据。模型自评完成不能替代验收。
- 每个小包先写稳定反例，再修改必要实现。公共字段必须列 owner、消费者、默认值、旧 checkpoint 读取及恢复规则；优先扩展已有 needAssessment/taskExecution/decision/reply 合同。
- 不新增第三套状态机、通用 EventBus、独立任务调度平台或第二份事实账本；不靠固定 Agent 文案、缩短有效产物、关推理或删除测试换速度。
- 保留所有已有工作树改动。每包记录目标文件开始/结束 hash 及 diff；若需超出指定入口，先在交付记录写明哪个验收要求迫使扩展。

## 2. 小包顺序与交付点

| 小包 | 内容 | 前置 | 完成时必须交付 |
| --- | --- | --- | --- |
| B00 | 第一批完成态与当前调用基线 | 第一批交付记录 | 可复现源码/构建身份、固定任务及请求归因 |
| B10A | 受影响控制边界的故障夹具 | B00 | 可注入停止/崩溃/拒绝的生产链测试 |
| B05A | 工作策略与显示/推理解耦 | B10A | 结构化准入原因、版本、兼容恢复合同 |
| B05B | 普通目标进入同一个有界循环 | B05A | 无独立规划正例、误执行负例、最小目标验收 |
| B05C | 工作中升级 TaskBook，继承现场 | B05B | 合法迁移、部分继承、升级中断恢复 |
| B06A | 规划字段与重试归因减法 | B05C | 紧凑解码、完整内部计划、请求预算对账 |
| B06B | 合格最终候选复用 | B06A | 候选资格、撤回/失效、一次权威结算 |
| B06C | 基于真实证据缺口停止工具轮次 | B06B | 不误停、不伪成功、饱和/恢复有界 |
| B10B | 对新策略跑完整受影响矩阵 | B05C、B06B、B06C | 零重复 effect/回复、零未授权、消息不丢 |
| B12 | 离线对照、桌面验收及启用判定 | 全部上述小包 | 验收报告，代码门/性能门分列 |

默认逐包执行。B10A 的夹具先落地，新增准入只在隔离测试中启用；B10B 通过前禁止扩大生产接纳。无需为每包创建新任务或启用多个 Agent。只收到“实施小包 ID”时停在该包；收到“实施第二批”时按顺序推进到本批代码交付门，费用预算或发布授权缺失不阻止离线实现与验收。

## 3. B00 与 B10A：基线及故障注入

B00 记录当前 branch/HEAD、tracked diff、untracked 源文件清单和 hash，核验第一批报告及构建 fingerprint。需要保存基线时使用可恢复的独立快照，包含未跟踪源文件，排除密钥、用户数据、日志正文与生成物。旧进程构建身份和磁盘 build 必须分开记录；不修改 manifest 伪造 fresh。

固定任务至少包括：问候/诊断、明确只读、精确单文件写读、现有文件修复、可运行小游戏、多文件依赖任务、歧义目标、执行中变更目标。中英文等价改写固定在夹具中；同一游戏验收既检查文件内容，也执行实际行为测试。以同一受控 Provider 脚本比较策略；允许请求形状改变，禁止候选策略使用更容易的题目或更多预置答案。

按 HL-03 账本记录 route/decide/tool-loop/final-reply/verify/recover/evolve 等目的及实际 transport attempt。decode retry、Provider retry 和 stream fallback 分别归因，保留 usage 缺失/部分状态。不从 64 条诊断窗口计算总成本。实际费用未知时标未知，不用 token 数冒充金额。

B10A 复用 `runtime-control-boundary.ts`、现有 durable effect/lease/inbox/reply stores 和 crash-worker 测试。先支持在请求派发前、参数完成后、approval 等待、intent 落盘后、effect 执行后 settlement 前、候选登记后持久结算前暂停。每个注入点暴露测试 latch，不将测试开关带进用户界面。

必须区分 pause（安全边界保存，可续）、abort（停止该次工作）、lease 失效（失去执行所有权）、waiting-user（等待已绑定输入）。停止后新业务模型/工具派发数为 0；允许对已发生 effect 做必要的确定性结算，不得调用模型追问用户是否取消。

## 4. B05A：独立的工作策略合同

主要入口：`lean-work-policy.ts`、`model-request-policy.ts`、`stages/classify.ts`、`decision-state.ts`、`packages/classifier/src/rules.ts`、`packages/types/src/agent.ts`、`run-context-contract.ts`、`packages/runner/src/runner.ts` 及现有 durable projection/checkpoint 编解码。

推荐语义为 `workPolicy = { version, route, mode, reasonCode }`；字段名为待实现建议，不代表已有 API。mode 只区分 bounded-loop / task-book，route 复用 respond/execute/clarify。reasonCode 使用有限的结构值；自然语言 rationale 仅供解释，不再作为代码分支依据。优先把这些字段合入既有权威决策记录；若新增嵌套字段，不能另存重复 classification/needAssessment。

策略选择由 Harness 决策边界负责，Runner 负责加载/恢复已选版本，Renderer 不写入。新 run 在第一次执行前固定版本；恢复沿已持久化版本，不因当前默认变化重新 classify。老 checkpoint 缺字段时使用明确 legacy 解释器；无法确定必要范围或未结算 effect 时保持阻塞/对账，不猜测为新策略。

最低持久化内容：目标及来源消息 ID、scope/资源引用、验收条目及证据要求、工作策略版本、预算消耗与剩余、证据引用、候选引用及所依据的目标版本。复用已有字段，工具输出正文只保存一次。无法从原文可靠得到具体目标/验收时保持待决，不用模板伪造用户要求。

`preferDirectModelOutput` 的 Provider 字段必须遵循已有 resolvedRunConfig 和 Provider 能力解析；订阅思考流、Normal/Compact、驱动模式不参与覆盖。用户显式开启/关闭/选择档位应保留；auto 的默认由配置层决定。本包不新增推理模式或默认降档。

B05A 先保持旧准入任务集合，只切断错误耦合；B05B 才定义新集合。传输选择可依据 Provider 支持和调用方需求，`streamModelTranscript` 只控制过程投影；无订阅不能导致额外规划、跳过验证或静默改推理。

验收 HB-05A：

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| 01 | 同一输入 × Normal/Compact × transcript 开关 × 两驱动 | 同一策略/权限/验收；允许传输与显示不同，业务模型目的序列相同 |
| 02 | 同一结构化分类，只改变 reason 文案或语言 | 准入不变；reasonCode/version 可追溯 |
| 03 | 推理显式开启/关闭/auto，覆盖支持的 Provider | prepared request 与配置解析一致；关监听器不产生 none/disabled 覆盖 |
| 04 | 新/旧/未知 policy version 的 checkpoint | 已知版本恢复一致；旧值走兼容，未知值明确拒绝续跑，不重做 |
| 05 | 外部研究/受限工作区，策略判为简单 | 未批准前零自动扫描；Main 执行边界仍有效 |

## 5. B05B/B05C：有界循环与升级

主要入口：`stages/classify.ts`、`stages/execute.ts`、`stages/execute/runners.ts`、`tool-loop.ts`、`guidance.ts`、`stages/decide/adoption.ts`、`stages/decide/replan.ts`、`execution-evidence-state.ts`、`task-book-runner.ts`、`checkpoint-resume.ts` 及公共 transition/decision/task 合同。

### 5.1 B05B：普通目标最小准入

复用现有 runToolLoop，撤除第二套靠措辞堆叠的快速路径。规则只接纳高置信、明确执行意图及可界定的单目标；读取/修复/生成不代表天然可验证。否定、引用命令、问候后附问题、能力询问、诊断说明均有负例。模糊输入继续沿既有路由，不新增无条件 LLM 路由请求；需要语义判断时复用已有分类结果，或在已授权 execute 后与首轮工作合并。

首轮工作沿用真实工具协议；Runtime 在 dispatch 前要求最小目标、范围和验收已可用。可从明确用户条件确定的内容直接复用；需要模型补全时，允许首轮同一请求生成一个有界的 Runtime 决策提案。若采用控制工具表达，必须单独 schema 校验、不得拥有文件/网络副作用，不计成用户工具执行；混合批次先验收控制提案，再逐一重新检查真正工具。禁止把普通正文或 reasoning 解析成授权指令。

无法形成可靠验收的目标转 TaskBook/已有澄清边界，不能靠“至少一次成功工具”补全。read/grep/glob 的结果与完整语义验收保持第一批底线；精确 write→read 只证明窄结构一致性，小游戏仍需行为 oracle。默认不把新 Web/浏览器/跨 scope/长期任务作为扩准入样本。

沿用 20 轮、原有总 token/工具预算，所有 route/决策/重试/升级共享 run 剩余额度；升级、恢复和 Provider retry 不能刷新额度。预算不足时可靠保存现场并报告未完成，不能用成功口吻收尾。

### 5.2 B05C：升级只规划尚未完成部分

触发原因限定为真实发现的依赖/多目标、验收缺口、需要长期续跑或预算压力；模型只提出，Runtime 校验并记原因。有工具批次正在执行时先达到可安全切换边界；待批准/unknown effect 先按原协议处理，不能因升级替换 callId 绕过它。

本包选择显式、受保护的 `execute → decide` 升级边：在唯一 transition manifest 中补边，同时在两驱动实际边界校验已持久化的升级请求、来源目标版本和安全切换条件。只改 manifest 不算完成；未带合法请求的同一边必须失败。升级是正常决策，不伪造一次工具失败去借道 RECOVER。旧 checkpoint 读取语义不变。

升级请求保存剩余目标、目标版本、已确认步骤及 evidence/effect/call 引用、pending/unknown 状态、预算余额和 request ID。DECIDE 使用已有 adoption/replan 机制生成或补充 TaskBook；已执行事实只引用一次，步骤映射保留 provenance。只有满足对应验收的旧事实才可标 done，单纯工具成功仍可能是待验证步骤。

每一目标版本最多一次 bounded-loop→TaskBook 升级，之后保留 TaskBook 路径；局部重规划受现有上限控制。目标修改来自已接受的用户消息及既有 inbox：提升目标版本、使不再适用的候选失效，保留旧 effect；不能把用户补充当旧 run 可随意变更授权。

验收 HB-05B/C：

| ID | 固定任务/故障 | 必须断言 |
| --- | --- | --- |
| 01 | 单文件明确写读，中英文至少各 3 种等价措辞 | 无独立 DECIDE 模型请求，无新增轻量规划请求；验收与授权完整 |
| 02 | “解释这条 write 命令”、否定执行、纯诊断、能力询问 | 无意外写入；Provider DSML 仍不能升级 respond 权限 |
| 03 | 修复文件/生成小游戏 | 有实际目标验收；存在文件或 verifier 自评不能替代行为结果 |
| 04 | 执行 A 后发现 B/C 依赖，升级 TaskBook | A 证据继承且不重复执行；只规划未完成部分，预算不重置 |
| 05 | 升级请求保存前后崩溃，或缺请求强行 execute→decide | 恢复唯一一次升级；非法边两驱动都拒绝 |
| 06 | 升级时有 denied/unknown effect/待批准调用 | 保留其状态，无新 callId 盲重做；当前权限重新检查 |
| 07 | 缺验收、预算临界、再次升级请求 | 可靠未完成/澄清或 TaskBook；不在两个模式间无限切换 |
| 08 | 运行中用户补充目标、附件或纠正路径 | inbox 接纳不丢，目标版本更新；旧候选不能结算新目标 |

## 6. B06A：规划与重试减法

入口：`stages/decide/request.ts`、`contracts.ts`、`model-call.ts`、`adoption.ts`、`stages/_shared.ts`、`compact-explicit-tool-decision.ts`、`compact-autonomous-read-task.ts`。保持两条既有 compact 合同可读，先列出 wire 字段→内部 NeedAssessment/TaskBook 消费者映射，再移除可确定派生或重复字段。

Runtime 可生成稳定步骤 ID、初始状态和机械默认值；模型仍需提供真实目标、必要依赖、工具意图及验收。不得把工具授权/资源路径/schema/副作用等级当作模型可信事实。裁剪 wire schema 后，先校验再展开为既有内部 TaskBook；完整路径的调度与验证不因此少字段。

固定失败处理：transport 按已有 LLM client 策略；length 只在剩余额度内允许一次受限增额；decode/schema 仅给有界错误反馈再试一次；abort/权限拒绝/硬预算耗尽不重试。JSON 层最多两次的基线不得扩大；若共享 helper 影响 VERIFY/RECOVER，必须跑对应负例。每次记录 retryOf、reason、实际输出与账本 completeness，不能把完整需求截掉让 JSON 易解码。

HB-06A-01：普通/compact/升级/partial replan 的 wire 输出均能形成完整内部合同。HB-06A-02：length/decode/schema/503/abort 各有独立尝试计数，嵌套网络重试不漏算。HB-06A-03：恶意扩大 scope、虚假 done、缺依赖/验收、unknown tool 不被默认值补成成功。HB-06A-04：同产物 oracle 下，记录规划请求数/输出长度及重试分布，不能只报 schema 行数减少。

## 7. B06B：最终候选复用与唯一结算

入口：`task-book-runner.ts` 的 `resolveCompletedTaskReply`、`final-reply.ts`、`stages/reply.ts`、`user-facing-reply.ts`、`reply-state.ts`、`final-reply-identity.ts`、`stages/verify.ts`、`packages/runner/src/authoritative-reply.ts` 及现有 reply settlement/replay。

复用资格必须同时满足：候选来自本 run/目标版本的真实 LLM 请求；覆盖整个目标而非局部步骤；证据版本在生成后没有失效；明确保留失败/拒绝/不确定性；协议和引用校验通过。task step output、工具原始输出、Runtime 标签和任意最后一段正文不能自动获得资格。来源未知时不按可复用处理。

优先使用已有候选/回复身份字段，必要时增加最小 provenance 与 evidence revision。候选是 preview，VERIFY 及唯一 registry/settlement 仍决定最终可信结果。相同候选的 UI 流式、日志、会话持久化只复用同一个身份；已有原子占用成功后不再占用一次把自己误判为重复。

需要额外最终模型请求的原因限定并记录：无合格候选、跨步骤综合缺失、验证失败后的内容更新、引用修复、重复文案改写。注册表冲突最多两次改写；引用修复仍有界，所有组合受 run 总预算约束。注册表不可用、候选为空或改写失败时只显示真实 Runtime 错误，不能用固定完成模板。

HB-06B-01：合格单目标候选的 execute_final_reply 调用为 0、最终登记与发布各一次。HB-06B-02：toolProposal 原始结果、内部 JSON、只覆盖部分步骤、旧目标/旧 evidence 候选都不能复用。HB-06B-03：引用错误/重复/验证失败先 reset 旧 preview，再有限修复，无旧成功正文漏进历史。HB-06B-04：登记后崩溃、并发结算及重放不重复回复，也不为相同已接纳候选额外调模型。HB-06B-05：复杂任务确需综合时保留一次有归因的汇总且在 settlement 前真实流式显示。

## 8. B06C：证据进展与停止条件

入口：`tool-loop.ts`、`execution-evidence-state.ts`、`stages/verify/evidence.ts`、`stages/verify/task-state.ts`、`stages/verify/routing.ts`。复用现有 20 轮/2 轮无进展上限，先修判定语义，不增一层自检 LLM。

进展 fingerprint 应关联工具来源、规范化资源/读取区间、相关 revision/hash、结果完整性和对应验收缺口；优先使用已有 invocation/evidence 元数据。相同文本来自不同必要文件不等于无新证据；同路径不同测试失败或修改后复验可有进展。仅输出随机时间、改变格式或重读已完整证据不算满足新验收。未知版本只能标 unknown，不能伪造精确 revision。

判定用于控制下一轮，不用作缓存工具结果：不得跳过权限检查、effect 执行/对账或把写操作视作可重用读取。集合达到上限不能让每个未存 fingerprint 都被视为新进展；使用有界窗口/明确饱和状态，保留总轮次硬界限。跨恢复保留必要进展/预算水位，不能重新获得 20 轮。

验收满足后停止非必要搜索；没有新增证据但目标未满足时进入有界失败/恢复/请求决定，不能直接标 pass。工具禁用后的末轮如果模型继续生成工具调用，拒绝执行并按既有协议失败收口。大文件读取按缺口缩小范围，全文/行为要求存在时必须得到对应证据。

HB-06C-01：同一文件同区间重复读取触发有界停止，目标未满足时终态非成功。HB-06C-02：不同目标文件内容相同、修改后的复验、连续测试由 2 失败变为 1 失败不误停。HB-06C-03：不同时间戳/格式但无验收进展不能无限续轮。HB-06C-04：集合饱和与恢复后仍有界，Unicode/长输出不发生反复全量重扫。HB-06C-05：截断或清洗证据不能满足完整性要求；小游戏行为错误必须失败。HB-06C-06：停止后额外 toolCalls、预算耗尽和取消均无新工具副作用。

## 9. B10B：受影响恢复与权限矩阵

每行同时覆盖新 bounded-loop 与 TaskBook；适用的 legacy/next 驱动均运行。使用真实 Runner/store/Main 路由及故障注入；仅 mock stage 返回值不算通过。进程崩溃场景使用现有 crash-worker/隔离 Electron，不能只测内存 throw。

| HB-10 ID | 中断位置 | 权威预期 |
| --- | --- | --- |
| 01 | 请求准备/派发、流式参数、等待批准时 stop/abort | 关闭旧 attempt/preparing，停止后新模型/工具派发为 0；迟到事件不复活 |
| 02 | intent 持久化失败或 intent 后进程退出 | 失败时工具未执行；恢复按原 intent 身份协调，不能盲重做 |
| 03 | effect 成功但 settlement 尚未落盘 | 已知成功不重复执行；unknown 保持待对账/决定，不能转 legacy 重跑 |
| 04 | lease 过期/另一 owner 接手 | 旧 owner 不能继续执行或结算；所有实际操作只有一个合法 owner |
| 05 | 升级/partial replan 后暂停及重启 | 完成步骤/effect/预算/目标版本保留，只续未完成部分 |
| 06 | 候选已占用、持久结算/前端确认前重启 | 权威回复与 UI 历史各一份；preview reset 不损坏已结算结果 |
| 07 | waiting-user、运行中 inbox 消息、重连/重送 | 已接纳消息不丢不重复消费，绑定正确 run/目标，不静默重开任务 |
| 08 | 恢复时权限降低、workspace 改变、符号链接/unknown shell、硬拒绝 | Main 按当前范围复核；不沿用旧 approval 扩权，未批准不扫描 |
| 09 | 网络关闭、timeout、Provider retry 耗尽、工具拒绝 | 原因和终态明确；不发取消后的恢复模型或伪造最终成功 |

本矩阵是 HL-05/06 启用前置；不宣称覆盖 HL-08 压缩提交或 HL-11 删除迁移。任何重复副作用、未授权操作、重复权威回复、已接纳消息丢失的容忍数为 0。

## 10. 可执行验证与 B12 交付门

下列命令中的测试文件目前存在。实现者应将新增 HB 测试并入相应入口，或显式补充新文件名；不能把文件被删除/未发现当作通过。先跑小包定向门，跨公共合同变更跑 core，候选全批只在必要时跑 full，避免每次改动重复全仓构建。

```powershell
# B05A/B05B：策略、分类、配置及投影不影响执行
pnpm exec vitest run packages/classifier/src/rules.test.ts packages/classifier/src/llm.test.ts packages/harness/src/stages/classify.test.ts packages/harness/src/decision-state.test.ts packages/harness/src/model-observability.test.ts packages/types/src/run-context-contract.test.ts
# B05C/B06A：升级、预算、规划和双驱动迁移
pnpm exec vitest run packages/harness/src/stages/decide.test.ts packages/harness/src/stages/_shared.test.ts packages/harness/src/stages/execute.test.ts packages/harness/src/default-harness.test.ts packages/harness/src/durable-kernel-guards.test.ts packages/types/src/stage-transitions.test.ts
# B06B/B06C：候选、证据、唯一回复与流式闭合
pnpm exec vitest run packages/harness/src/stages/execute/final-reply.test.ts packages/harness/src/stages/execute/model-transcript.test.ts packages/harness/src/stages/verify.test.ts packages/harness/src/stages/verify/structural-write-read.test.ts packages/harness/src/user-facing-reply.test.ts packages/runner/src/authoritative-reply.test.ts packages/app/src/shared/history-activity.test.ts packages/app/src/main/run-stream-api.test.ts
# B10：生产 Runner、控制、崩溃与恢复
pnpm exec vitest run packages/harness/src/runtime-control-boundary.test.ts packages/runner/src/runner.test.ts packages/runner/src/runner-continuation.test.ts packages/runner/src/durable-runner-effect-recovery.test.ts packages/runner/src/durable-runner-effect-crash-worker.test.ts packages/runner/src/durable-run-lease-recovery.test.ts packages/runner/src/durable-run-lease-crash-worker.test.ts packages/runner/src/durable-inbox-recovery.test.ts packages/runner/src/durable-inbox-crash-worker.test.ts packages/app/src/main/run-checkpoint-api.test.ts
# 公共合同与全批候选
pnpm run verify:core
pnpm run verify:full
pnpm run assert:app-build
pnpm run verify:electron-ui-state-continuity
pnpm run verify:electron-continuity
```

B12 扩展现有受控本地 Provider/Electron 验收，不接生产密钥。比较第一批完成态与本批候选，固定任务/工具/模型配置、数据快照与 oracle，按目的报告模型请求/尝试、输入/输出/缓存/usage completeness、首有效进展、首工具真正执行、可靠完成及资源占用。两版本使用隔离数据根，不能污染真实会话。

受控任务期望：合格普通明确任务独立 DECIDE 请求为 0；已有合格候选的额外最终汇总为 0；结构验证外的必要语义验证保留；无证据循环有界。复杂任务保留必要规划/综合，不为凑请求数降低 oracle。凡减少一次请求，报告被移除的目的及替代证据；每次剩余重试/总结/验证有具体原因。

本地首反馈 P95 ≤ 200 ms、收到可展示增量后绘制 P95 ≤ 100 ms 仍为目标，沿总任务书口径测量。每组至少 30 次并记录冷/热、失败/取消和负载；样本不足只能标功能验证。受控 Provider 可以证明因果与流式先后，不证明真实 Provider TPS/费用或产品端到端性能。

真实配对基准属于单独性能门：预先确定模型、reasoning、费用和总尝试上限；每类每策略至少 30 次，交错新旧，失败/中止全部保留。旧策略必须使用第一批完成态而非原始审计 HEAD。复杂任务可靠完成 P95、总 tokens/成本及 CPU/内存稳定退化超过 5% 时记录预警并调查噪声/根因；未知 usage 不参与“成本降低”的确定性结论。真实基准未跑时可以交付代码，性能门保持未验收。

启用只影响新 run 的已验收策略版本；已有 run/checkpoint 沿原协议结算。异常时停止新策略接纳，原地对账/恢复，不能切回旧模式重做 effect。复用既有运行策略配置，不新增用户可见开关矩阵。两驱动仍保留；正式发布和完整 HL-12 灰度不在本包自动执行。

## 11. 交接提示词与报告

```text
在 LittleSheep 当前工作树实施第二批小包 <ID>。
先读 AGENTS.md、总审计任务书相关 HL 条目、第一批结果，以及本实施包通用合同和该包全文。
核对前置包证据与当前 dirty/untracked 源码，不把实施前 HEAD 当作第一批完成态。
按 HB 用例先形成稳定反例，复用现有工具循环、TaskBook、权限、durable store 和回复结算。
保持 Renderer 投影真实 activity；展示/订阅不能改工作策略或用户 reasoning。
记录生产消费者和兼容恢复规则；完成定向测试及必要跨层门，逐项回填 HB 证据。
不提前实施记忆迁移、准备缓存平台或双驱动删除。只收到一个小包时停在其边界；
用户要求整批实施时按依赖推进，真实收费基准/发布授权缺失只阻止对应外部步骤。
```

每包报告：开始/结束源码身份与 diff；新增测试路径；HB 编号→断言→生产入口→运行结果；减少/保留的模型请求原因；权限/effect/验证/候选/预算守恒；编解码与旧数据表现；构建和实际 Electron 身份；未做项目及下一包接口。最终汇总将“规格已写 / 代码完成 / 离线通过 / 桌面通过 / 真实性能通过 / 已启用”分别标记。

停止扩大范围的条件：需要改变授权或效果对账、不能解释旧 checkpoint、无法证明候选覆盖范围、发生误验证/重复回复/消息丢失、为了提速需调低 reasoning/裁剪关键上下文、同一失败多次局部修改仍无确定根因。先保留复现与已完成证据，定位必要合同；不得放宽断言或以新旁路掩盖问题。

## 12. 实施结果与验收状态（2026-09-14）

第二批代码交付已按 B00 → B10A → B05A/B/C → B06A/B/C → B10B → B12 顺序完成。实现没有提前进入 HL-08 记忆压缩迁移、HL-11 双驱动删除或完整 HL-12 灰度发布，也没有新增第三套状态机/EventBus。

### 12.1 逐包结果

| 小包 | 状态 | 生产入口与关键守恒 | 主要 HB 证据 |
| --- | --- | --- | --- |
| B00 / B10A | 完成 | `6a4e5f996bb9` 仅是早期 Git 检查点；第一/二批完成态还包含 tracked diff 与新增源文件，不能仅用 HEAD 重建。保留现有 control boundary、effect/lease/inbox/reply store 与 crash worker，不把故障开关带入 UI | Runner、checkpoint controller、effect/lease/inbox crash 与 continuation 测试覆盖 pause/abort/lease/waiting-user、effect 对账和幂等恢复 |
| B05A | 完成 | `WorkPolicyV1` 成为 Harness 权威策略合同；Renderer display/transcript 与 reasoning 配置不参与策略；checkpoint 恢复按版本解释，未知版本失败关闭 | `lean-work-policy.test.ts`、`classify.test.ts`、`run-context-contract.test.ts`、Runner checkpoint codec 测试覆盖 reasonCode、配置矩阵和旧值兼容 |
| B05B | 完成 | 高置信单目标进入既有 bounded tool loop；显式点名工具时只暴露该有界工具集合；Web/浏览器/跨 scope 仍进入 TaskBook；20 轮预算为 run 级持久预算 | 明确 glob 任务无独立 DECIDE；否定/解释/问候附问题负例不执行；工具 schema、权限和 ToolExecutionService dispatch 仍二次校验 |
| B05C | 完成 | 新增受保护的 `execute → decide` 升级边和无副作用 `request_task_book` 控制提案；升级请求持久化 goal/evidence/effect/budget，目标版本内最多一次且只规划未完成部分 | `execute.test.ts` 端到端证明执行 A → 升级 → 仅执行 B，A 不重做，预算 2 → 4 延续；transition、durable-kernel 与 Runner continuation 测试覆盖非法边和恢复 |
| B06A | 完成 | DECIDE wire 删除 Runtime 可派生状态/机械默认值；模型步骤一律先归一为 pending；decode/schema retry 记录 `retryOf/retryReason`，JSON 尝试上限仍为 2 | 普通、compact、升级与 partial replan 均可展开为完整内部合同；恶意 done、unknown tool、schema 错误和 retry attribution 有定向测试 |
| B06B | 完成 | reply candidate 绑定精确 run/model request/goal version/evidence revision；只有覆盖完整单目标且证据未失效的候选可复用，preview 仍由 authoritative settlement 覆盖 | candidate/final-reply/reply/authoritative-reply 测试覆盖合格复用、旧目标/局部输出拒绝、reset、重复注册与重放 |
| B06C | 完成 | invocation 持久化 Runtime 解析后的 `resourceKeys`；进展 fingerprint 关联工具、规范资源、完整性、effect/revision，饱和后仍受 20 轮硬上限约束 | 重复读取、同内容不同资源、修改后复验、截断证据、无进展与恢复预算均由 tool-loop/verify/structural-write-read 测试覆盖 |
| B10B | 完成 | 新 bounded-loop 与 TaskBook 继续复用同一 Runner/store/Main 权限边界；停止后不再派发新业务模型/工具，旧 owner 不可结算，waiting-user/inbox 不丢 | `runner.test.ts`、`runner-continuation.test.ts` 及 effect/lease/inbox crash-worker 矩阵通过；Electron 强制退出后只续未完成 checkpoint |
| B12 | 功能验收完成 | 受控本地 Provider 与隔离数据根验证真实 SSE、工具行、后台运行和恢复；未使用生产密钥 | UI：`decideRequests=0`、`streamedRequests=2`、`renderedToolRows=1`；Runtime continuity 覆盖跨重启、pause/resume、checkpoint 恢复、Runner 热切换和 interrupt，最终 continuity=`supported` |

### 12.2 请求减法与保留原因

- 合格明确工具任务移除了独立 DECIDE 请求；模型直接通过 Provider 原生工具协议进入 bounded loop，Runtime 仍校验 schema、权限、资源与 effect。
- 显式工具任务只发送用户点名的工具 schema；`request_task_book` 仅作为受保护的升级控制工具存在，不产生业务副作用。
- 合格的全目标 execute candidate 不再额外生成 `execute_final_reply`；候选不完整、证据变更、引用修复或重复改写时仍保留有归因请求。
- 语义 VERIFY 没有为了凑请求数删除。仅能证明结构的 read/glob 结果仍需必要语义判断；确定性结构证据充分时继续走 structural verdict。
- reasoning 配置不降档；Normal/Compact 和过程订阅只改变投影/传输，不改变业务模型目的序列。

### 12.3 验证记录

- 定向策略/规划/候选/证据/恢复测试均通过；最新新增边界组为 115/115、83/83、恢复审计与 controller 13/13。
- 仓库卫生：33/33；TypeScript project references：28/28；应用 TypeScript 与 Electron build 通过。
- 全量 Vitest：451/451 个测试文件，3170 通过、1 跳过（3171 总计）。
- `verify:electron-ui-state-continuity`：通过；本次功能样本 local feedback 520 ms、model feedback 576 ms、partial-before-settlement=true、SVG rows=3。
- `verify:electron-continuity`：通过；13 次受控 Provider 请求，跨重启/后台/pause-resume/强制恢复/热切换/interrupt 均通过，最终 recentHistoryMessages=6、continuity=`supported`。
- 恢复源审计已区分成功完成与 `waiting_user/paused` 的有意开放边界；真实数据只读审计为 `ok`。待回答 checkpoint 未被错误封存。

### 12.4 交付门分层结论

| 门 | 结论 |
| --- | --- |
| 规格已写 | 通过 |
| 第二批生产代码完成 | 通过 |
| 离线测试/类型/构建 | 通过 |
| 隔离桌面功能验收 | 通过 |
| 真实 Provider 配对性能（每类每策略至少 30 次） | **未执行 / 未验收**；缺少费用预算与生产密钥授权，不能从受控 Provider 样本推断 TPS、费用或 P95 |
| 新策略正式启用/灰度/发布 | **未执行**；本包不自动发布，旧 checkpoint 继续按持久化版本结算 |

因此本批达到代码交付门，但不宣称真实性能门或产品发布门通过。下一步如获费用与发布授权，应先运行 `scripts/verify-harness-path-comparison.mjs` 的真实交错 30× 配对基准，再按异常阈值决定是否启用；不得以当前单次 UI 延迟替代 P95。
