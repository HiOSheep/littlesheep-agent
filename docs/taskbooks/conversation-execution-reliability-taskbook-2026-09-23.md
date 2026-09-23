# 对话执行可靠性修复任务清单 2026-09-23

最后更新：2026-09-23 21:22:00

## 目标与证据边界

让“做一个小游戏吧 → 继续做吧”这类已授权、可执行的请求，在正确工作区内完成产物；普通工具错误可在同一主循环中有界纠正；确实无法继续时留下明确状态和可操作原因。

来源：用户提供的《LittleSheep 对话测试问题汇总（完整版）》，覆盖 2026-09-11～09-23，重点是 09-23 最新两轮失败。本次对照源码基线 `2476a2b` 制作清单，未重新运行原会话、读取原始执行日志或进行 Electron 实机复现。下文的“报告复现”来自该汇总，“源码确认”仅指当前代码机制；两者不能替代修复后的端到端验收。原始会话、日志和配置不复制进仓库，自动化夹具使用合成数据。

这是待实施清单，本次只增加文档与导航，所有实现、复现和回归验收均未完成。原报告的 P1～P9 是问题编号，下文 P0/P1/P2 是排期优先级，二者分开使用。

## 优先级与排期总表

工作量为相对规模：S 单一边界，M 跨模块，L 涉及恢复、故障矩阵或真实环境；不是工时承诺。P0 优先恢复基本执行能力，P1 收口安全读取与恢复可靠性，P2 改善表达或保留历史回归。

| 状态 | 编号 | 优先级 | 任务 | 对应原问题 | 规模 | 前置依赖 |
|---|---|---|---|---|---|---|
| 已实施待实测 | CE-01 | P0 | 统一每次 run 的工作区事实 | P1 第一、三层 | M | 无 |
| 已实施待实测 | CE-02 | P0 | 工作区切换与配置更新即时生效 | P1 第二层 | M | CE-01 的事实契约 |
| 已实施待实测 | CE-03 | P0 | 显式披露真实 shell 与语法约束 | P2 | S | 无 |
| 已实施待实测 | CE-04 | P0 | 区分普通执行失败、权威拒绝与未知副作用 | P3 | L | 无，联验依赖 CE-01/03 |
| 已实施待实测 | CE-05 | P1 | 提供受保护目录的可靠只读探测路径 | P4 | M | CE-03/04 |
| 已实施待实测 | CE-06 | P1 | 只读观察与副作用防重放正确分流 | P5 | M | CE-04/05 |
| 已取证已修 | CE-07 | P1 | 核验 VERIFY“工具结果缺失”证据链 | P6 疑点 | M | 可先取证；复测依赖 CE-04 |
| 已实施待实测 | CE-08 | P1 | 恢复耗尽后的续接必须产生进展或具体阻塞 | P6 | L | CE-04、CE-07 的结论 |
| 待复现 | CE-09 | P1 | run 失败也有可见、可恢复的终态 | P8 | M | 可先复现；联验依赖 CE-08 |
| 待实施 | CE-10 | P2 | 中文过程表达与低风险模糊请求直接执行 | P9 | S | CE-01/03/04 |
| 待回归 | CE-11 | P2 | 保留 DSML 泄漏历史回归 | P7 | S | 无 |
| 待验收 | CE-12 | P0 交付门 | 三类工作区的真实完整流程验收 | P1～P9 | L | 对应实现与调查关闭后 |
| 已实施待实测 | CE-13 | P0 | 注入简短的运行时变更上下文 | 用户追加：模型、工作区等即时信息 | M | CE-01/02/03 的有效事实来源 |

建议交付批次：

1. **恢复基本能力**：CE-01～04 与 CE-13；立即跑 CE-12 的正常工作区、切换目录、运行时变更简报、可纠正失败用例，不等所有优化结束。CE-13 编号追加，但随首批实施。
2. **消除反复空转**：CE-05～09；CE-07/09 的调查可提前开始，结论出来后再决定是否改代码。
3. **质量与收口**：CE-10/11，完成 CE-12 全矩阵和文档同步。历史已修项不重新排成缺陷实现。

## 源码核对后的定性

| 原问题 | 本次结论 | 排期注意事项 |
|---|---|---|
| P1 | 源码确认：提示配置取 `agents.defaults.workspace`，请求工作区另行解析；配置更新只因 model/web 变化重建 Runner；能力事实只有 workspace 状态 | 不能只加一句“优先相信 cwd”；须消除相互矛盾的 Runtime 路径来源 |
| P2 | 源码确认：Windows 实际启动 `powershell.exe -NoProfile -Command`，工具描述未披露 shell | 数据根 TOOLS 模板未注入的具体历史情况来自报告，本次未重读运行数据 |
| P3 | 源码确认：任意 `ok:false` 触发强制收尾；VERIFY 对已有失败记录可发布 `unverified` | 不应把所有失败改成 stage 重跑，也不能把 `unverified` 解释成任务已完成 |
| P4 | 源码确认：组合命令被保守拒绝；补充发现 `Test-Path` 本身也不在当前核心目录只读白名单中 | 拆掉分号仍可能失败；优先结构化只读入口，不扩大为任意 shell 放行 |
| P5 | 源码确认：默认 `exec` 进入副作用账本，成功同输入再次调用会被防重放拦截 | 现有账本已允许明确失败的新 attempt；问题不能概括为“所有失败永远不能重试” |
| P6 | 已确认恢复预算与单次续接重试机制；循环行为和 VERIFY 缺失原因仍需日志及复现 | 先查真实记录，不把模型转述当作缺失证据的直接证明 |
| P7 | 报告判定历史已修；当前可见 DSML 解析及发布前拒绝控制标记的保护 | 本次未运行回归，仅保留防退化项 |
| P8 | 历史报告有空回复，当前故障链未确认 | 无 assistant 消息不自动等于 UI 无状态；须同时检查持久化、事件流和界面 |
| P9 | 报告中的表达质量问题 | 不先认定全是模型责任；核查提示来源、过程流与 Runtime 状态的归属 |

## 任务明细与验收标准

### CE-01｜统一每次 run 的工作区事实（P0）

**问题**：模型使用配置默认目录，工具使用本次请求目录，导致探测、写入目标及交付路径发生偏离。

**定位**：[execute/prompt.ts](../../packages/harness/src/stages/execute/prompt.ts)、[reply.ts](../../packages/harness/src/stages/reply.ts)、[builder.ts](../../packages/prompt/src/builder.ts)、[runtime-awareness.ts](../../packages/harness/src/runtime-awareness.ts)、[run-support.ts](../../packages/app/src/main/local-app-api/run-support.ts)。

**工作范围**：由 Runtime 在 run 入口确定规范化工作区，将同一事实用于提示、工具上下文、权限分类、产物归属与恢复。动态路径放在既有可回放的运行事实区域，稳定前缀不保留一个与之冲突的“当前工作区”。旧记忆路径仅为历史来源，不能覆盖当前目录或成为跨目录操作授权。事实统一后，由 CE-13 向模型注入简短的当前上下文及变更信息，不让模型靠历史记录猜测切换结果。

- [x] 配置目录 A、请求目录 B 时，execute、能力回复、默认工具 cwd 与产物索引均指向 B。（提示、工具 cwd 与能力回复已由 `run-workspace-fact.test.ts`、`stages/execute/prompt.test.ts`、`stages/reply.test.ts` 断言；产物索引沿用调用方传入的同一个 `cwd`，未单独断言。）
- [ ] 覆盖默认 workplace、用户外部目录、项目绑定目录，以及空格/中文路径；不把数据根与 workplace 混用。（已覆盖配置默认目录与含空格路径；外部/项目绑定目录与中文路径待 CE-12。）
- [ ] 本轮有显式工具 cwd 时，目标和授权范围按该调用重新求值，不能因此悄悄更改会话归属。
- [ ] 历史记忆指向 A、当前在 B 时，不声称 A 的文件存在于 B，不自动跳回 A；需要访问 A 时遵循当前权限。
- [x] 同目录后续轮次保持缓存前缀稳定；切换目录时不为命中缓存继续使用旧事实。（`stableText` 逐次比对；切目录产生新的 prompt 字节与新 run 事实。）

### CE-02｜工作区切换与配置更新即时生效（P0）

**定位**：[main/index.ts](../../packages/app/src/main/index.ts) 的 `updateRuntimeConfig` / `rebuildRunner`、[run-support.ts](../../packages/app/src/main/local-app-api/run-support.ts)、[runtime-config.test.ts](../../packages/app/src/main/runtime-config.test.ts)、[runtime-config-api.test.ts](../../packages/app/src/main/runtime-config-api.test.ts)。

**工作范围**：消除 Runner 长期引用旧配置造成的事实漂移。优先让新 run 获取最新、不可变的有效配置及目录快照；是否重建 Runner 以最小改动和并发正确性决定，不把“每次切目录都重建”预设为唯一方案。

- [ ] 不重启应用，保存默认工作区 A→B 后，新建且未绑定目录的 run 使用 B。（变更检测与重建触发已由 `runtime-config-change.test.ts` 覆盖到字段级；不重启应用的端到端确认属 CE-12 实机项。）
- [ ] 已绑定项目 A 的会话仍按项目归属运行，不被全局默认 B 偷换；显式切换会话目录后，新 run 使用新目录。（`resolveRunWorkspaceContext` 的项目归属已断言；渲染器侧仍以 `runtime.workspace` 下发请求目录，实机行为待 CE-12。）
- [x] 正在执行的 run 保留启动时目录；切换设置不把执行中的命令或产物改派到另一目录。（Runner 在 `executeRun` 入口解析一次 `cwd`，整轮工具上下文与提示共用该值；重建采用"先建后换 + 延迟关闭旧 Runner"。）
- [ ] 配置持久化失败不显示保存成功；连续更新和并发启动不混用两份配置。
- [x] 覆盖 Main→Runner→提示→工具 cwd 的集成断言，不能只检查 config 文件已写入。（`packages/runner/src/run-workspace-fact.test.ts` 走真实 Runner + 真实工具调用，断言提示、工具 `ctx.cwd` 与环境简报一致。）

### CE-03｜披露真实 shell（P0）

**定位**：[exec.ts](../../packages/tools/src/builtin/exec.ts)、[runtime-awareness.ts](../../packages/harness/src/runtime-awareness.ts)、[exec.test.ts](../../packages/tools/src/builtin/exec.test.ts)。

**工作范围**：从实际执行器产生平台、shell 名称及必要语法约束，进入模型可见契约。Windows 明确为 `powershell.exe`，不能暗示 PowerShell 7；Unix 按实际 `/bin/sh` 描述。不得依赖仓库根 TOOLS.md 或覆盖用户的运行时 TOOLS.md 来补事实。

- [x] Windows 与 Unix 的披露值和实际启动的可执行文件、参数一致；未知版本不编造版本号。（`describeExecutionShell()` 与 spawn 共用同一组常量，`stages/execute/prompt.test.ts` 用返回的 descriptor 反查披露文本；只说明是 Windows PowerShell 而非 `pwsh`，不给版本号。）
- [x] Windows 示例覆盖带空格目录的列举、文件存在性查询；不把 cmd 的连接语法或 Bash 的 `&&` 当作默认兼容语法。（`Runtime Facts` 的 shell 行与 `exec` 工具描述都给出 `;` 分隔、`Get-ChildItem`/`Test-Path`、含空格路径的引用方式，并明确 cmd 的 `&&` 不可用。）
- [x] 合成运行时 TOOLS.md 为空/占位时，模型仍能得知 shell；无须额外调用模型猜测环境。（Runtime facts 与工具目录都不读 TOOLS.md。）
- [ ] 真实模型小游戏样本不再因缺失 shell 信息产生报告中的首条命令错误；剩余偶发错误由 CE-04 处理。（需要真实模型的 CE-12 场景。）

### CE-04｜普通工具错误可以有界纠正（P0）

**定位**：[tool-loop.ts](../../packages/harness/src/stages/execute/tool-loop.ts)、[tool-result-persistence.ts](../../packages/harness/src/stages/execute/tool-result-persistence.ts)、[side-effect-ledger.ts](../../packages/harness/src/stages/execute/side-effect-ledger.ts)、[verify.ts](../../packages/harness/src/stages/verify.ts)、[recover/policy.ts](../../packages/harness/src/stages/recover/policy.ts)。

**工作范围**：用 Runtime 已有结构化结果区分可纠正执行错误、权限/硬边界拒绝、未结算副作用、取消和预算耗尽；必要字段只做最小补齐。可纠正错误留在同一个 execute 主循环，将结果交给模型修正；不得以删除失败记录、整轮重跑或新增规划器实现“恢复”。

- [x] 只读路径不存在、确定未执行的语法错误、测试命令返回失败，均可在预算内补充观察或修正输入，无须用户再发“继续”。（`tool-failure-disposition.test.ts`：读取失败后同一 run 内改用 `glob` 观察并交付。）
- [x] 非零退出不等于零副作用：先写文件再退出失败的命令不会被无条件原样重放；必要时观察实际状态再决定后续动作。（失败的副作用调用追加 Runtime 控制消息要求先观察；Runtime 自身从不重放，成功副作用仍被账本拦截。）
- [x] 权限拒绝、核心源码写入硬拒绝、未知工具等权威边界保持停止/升级规则，不能换工具绕过；取消和未结算副作用不自动续跑。（权威状态/错误种类/未结算副作用一律强制收尾；无 invocation 记录的结果按权威处理。）
- [ ] 同批部分成功、部分失败时保留成功结果和账本，只处理未完成部分。（现有批处理已逐项保留结果与账本条目，本次未新增专项断言。）
- [x] 连续相同失败无新增证据时有界停止，报告实际阻塞；不放大为无限模型/工具循环。（同输入重复失败的证据指纹不变，2 轮无进展后收回工具；用例断言 3 次执行、6 次模型调用后停止。）
- [ ] 先失败后纠正的历史仍可追溯；按现行 VERIFY 契约保留 `unverified`，最终产物完成情况单独以证据说明，不伪造 `pass`。（失败结果仍进入 `ctx.toolResults` 与 invocation 记录，VERIFY 路径未改动；"纠正后仍为 `unverified`"的定向断言待补。）

### CE-05｜核心目录可读、不可写（P1）

**定位**：[path-protection.ts](../../packages/tools/src/path-protection.ts)、[exec.ts](../../packages/tools/src/builtin/exec.ts)、[path-protection.test.ts](../../packages/tools/src/path-protection.test.ts)。

**工作范围**：优先让存在性/目录列举需求使用现有可证明只读的工具；有缺口时补最小结构化读能力。若必须支持 shell，只支持能够验证的狭窄形态。复杂组合无法证明只读时继续拒绝，并提供明确的只读替代入口；不要求放行原报告中的组合命令。

- [x] 在授权允许时，可完成核心目录的存在性与文件列表查询；既覆盖组合语法被拒，也覆盖单条 `Test-Path` 当前未被允许的问题。（`isReadOnlyCoreCommand` 新增单条 `Test-Path`；`exec.test.ts` 用真实 shell 断言受保护根内的 `Get-ChildItem` 列举与 `Test-Path -LiteralPath` 存在/不存在三例，以及四种组合/写入形态仍被拒。）
- [x] `mkdir`、写入、删除、重定向、读命令夹带写命令，以及符号链接/动态路径绕行仍受保护。（分隔符/重定向/子表达式守卫未放宽，`-Credential` 另被排除；组合用例断言未产生任何文件。）
- [x] 三档权限保持原语义；只读判定不把容器外目录自动变成容器内，也不等于免除审批。（`describeToolAccess` 对受保护根外的只读命令仍判 `outside`，研究模式仍需批准；`full` 放行、`restricted` 一律批准，均由 `exec.test.ts` 断言。）
- [ ] 选中核心目录要求生成游戏时，明确它不可写；在产品现有授权下提出可用工作区，确需选择时只请求一次具体路径，不静默改目录。（拒绝文案已明确"审批不能覆盖该保护"并指向可写工作区；模型据此如何组织回复属 CE-10/CE-12。）

### CE-06｜重复只读观察不误判为副作用重放（P1）

**定位**：[side-effect-ledger.ts](../../packages/harness/src/stages/execute/side-effect-ledger.ts)、[side-effect-lifecycle.ts](../../packages/harness/src/stages/execute/side-effect-lifecycle.ts)、[side-effect-ledger.test.ts](../../packages/harness/src/stages/execute/side-effect-ledger.test.ts)。

**工作范围**：与 CE-05 共用可验证的只读事实。优先把目录探测交给结构化只读工具；若保留只读 exec 例外，必须由 Runtime 验证完整执行语义。仅凭 `dir` 前缀、模型声明或 `isLikelyReadOnlyCommand` 启发式不能豁免副作用账本。泛化的 exec 继续按不透明操作处理。

- [x] 列目录→创建产物→再次列目录能取得新观察，不因“上次成功”触发 `side_effect_replay`；通过结构化入口替换原命令也可满足该目标。（走结构化入口：只声明读资源的调用不进账本，`read-observation-loop.test.ts` 用真实主循环断言两次列举都执行、第二次看到新产物、结果里没有任何 replay 拒绝。）
- [x] 没有环境变化的重复观察仍受无进展预算限制，不能无限调用。（同一用例：3 次列举后由证据指纹与无进展预算收边，且不以 replay 名义拒绝。）
- [x] 真正写操作、外部操作的重复成功调用仍被拦截；unknown/in_progress 状态继续保护，不通过改 callId 绕过。（不透明 `exec` 不声明资源，命令文本再像列举也记为 `external`；重复成功写与重复成功命令都被拒，`callId` 变化不影响键——账本按 tool+input 哈希记账。）
- [x] 当前已支持的失败 attempt 重试不退化；重启与并发执行的防重放规则仍通过现有账本回归。（`side-effect-ledger.test.ts` 的 `:retryN` 与 `unknown`/`cancelled` 用例未改；durable 重启/并发用例继续通过。）
- [x] 不削弱不透明 exec 前的观察冻结与结束后的失效处理，保持 Runtime 状态一致性专项的约束。（`exec.ts` 的观察端口序列未改，`exec.test.ts` 的四条失效用例继续通过。）

### CE-07｜核验 VERIFY 证据缺失（P1，先取证）

**定位**：[verify/task-state.ts](../../packages/harness/src/stages/verify/task-state.ts)、[tool-result-persistence.ts](../../packages/harness/src/stages/execute/tool-result-persistence.ts)、[execution-evidence-state.test.ts](../../packages/harness/src/execution-evidence-state.test.ts)、[run-checkpoint.ts](../../packages/runner/src/run-checkpoint.ts)。

**工作范围**：先沿报告所指 run 对齐 tool call、result、执行记录、checkpoint、恢复上下文与 VERIFY 输入，确认“未找到工具结果”来自什么事实。仅记录脱敏关联标识和存在性结论；缺历史数据时明确不可判定，并用故障注入重建最小场景。

- [x] 给出“真实记录丢失 / 查找或恢复投影缺陷 / 历史兼容问题 / 无法证实”之一，附可复核证据；不得只引用模型解释。**结论：恢复投影缺陷（已修）＋ 原报告那次运行无法证实。** 证据见下方"CE-07 取证记录"；原 run 的会话、执行日志与 checkpoint 不在仓库，报告那一跳无法回溯，因此不把本轮结论当成对它的复现。
- [x] 覆盖正常完成、失败已记录、写结果前后中断、恢复、重复 callId 或裁剪/截断边界。（`evidence-gap.test.ts` 的 13 条用例逐项驱动 `runtimeExecutionEvidenceGap` 并断言各自的判定文本。）
- [x] 若确认缺陷，补先失败后通过的定向用例并修最小持久化/索引链路；若未复现，记录已测范围与剩余未知，不标成已修。（三条用例先在修复前失败、修复后通过；修复只改 `verify/task-state.ts` 的继承证据判定，不新增持久化字段。）
- [x] 已存在的工具失败不能变成“结果缺失”；真正缺失也不能补造成功结果或无条件重新执行原副作用。（旧检查点里**失败**的步骤结果同样算已记录（原实现只认 `result.ok`，本身就是"失败变缺失"）；没有 callId 或仍未结算的继承条目仍是 gap；gap 走 `routeKnownIncompleteExecution` → RECOVER，未结算副作用由 `recover/policy.ts` 直接 abort，不会重放。）

### CE-08｜恢复耗尽后不再循环空问（P1）

**定位**：[recover.ts](../../packages/harness/src/stages/recover.ts)、[recover/policy.ts](../../packages/harness/src/stages/recover/policy.ts)、[runner-continuation.test.ts](../../packages/runner/src/runner-continuation.test.ts)、[run-checkpoint.ts](../../packages/runner/src/run-checkpoint.ts)。

**工作范围**：明确自动恢复预算、用户授权的一次重试、原目标与已完成证据的续接关系；复用已有 continuation coordinator。用户选择重试后应执行一次有意义的恢复尝试，或说明仍缺哪项条件，不能用清零所有预算掩盖循环。

- [ ] “再尝试一次 / 继续做吧”正确绑定原任务、产物、工作区和权限，不重新询问已经回答的目标。（Runtime 侧的一次性绑定重试已有实现与用例，本轮未改；端到端绑定属 CE-12。）
- [ ] 预算耗尽后用户选择重试，保留累计历史并给出明确有界机会；重启后语义一致。（`recover.test.ts` 断言绑定重试恰好消费一次、第二次回到耗尽路径；跨重启语义由 runner-continuation 用例覆盖，本轮未新增。）
- [x] 同一阻塞未改变时不再只给原样三选一：呈现具体原因、已完成部分和所需动作；保持旧回复的发布幂等，不靠强制改写文案去重。（`recover/escalation.ts` 给出原因类别、已完成部分与所需动作三件事实并写进 `clarificationRequest`；选项集合与发布 settlement 未改，重复措辞仍按原样发布。）
- [x] 权限不足、资源缺失和证据不可恢复分开处理；用户取消立即停止，成功副作用不重放。（`recordedFailureKinds` 在无 TaskBook 步骤时改读 invocation 状态与 `lastError`：权限拒绝第一次就升级而不是烧掉重试预算，`aborted` 直接停止，`verify` 阶段的缺口归为"证据不可恢复"；未结算副作用仍由 `policy.ts` 直接 abort。）
- [x] CE-07 若发现证据缺口，先修缺口再验收本项，不仅修改追问措辞。（CE-07 的恢复投影缺陷已在本轮先修并有先失败后通过的用例，之后才改升级事实。）

### CE-09｜失败不能在界面上消失（P1，先复现）

**定位**：[runner-finalize.ts](../../packages/runner/src/runner-finalize.ts)、[user-facing-reply.ts](../../packages/harness/src/user-facing-reply.ts)、[Renderer runtime](../../packages/app/src/renderer/runtime/README.md)、[恢复界面](../../packages/app/src/renderer/runtime-recovery/README.md)。

**工作范围**：检查普通输入到 run 终态、事件流、持久化和重新打开会话的链路。先核实旧 TaskBook step 的工具拒绝在当前单循环/旧 checkpoint 兼容路径上能否发生，不重新引入已删除的步骤执行器。

- [ ] 模型失败、工具拒绝、无可发布模型正文、断流和终态持久化异常均有可见 Runtime 状态，输入框不永久停留在运行中。
- [ ] 无合法 LLM 回复时允许只有 Runtime 错误/状态，不能生成固定“Agent 道歉”冒充模型回复。
- [ ] 同一失败刷新、重开会话后仍可识别，已有模型回复不重复发布；确实未持久化时不得暗示已保存。
- [ ] 待决定状态可在原对话发现与继续；启动自动恢复不新增阻塞式提示，与既有静默恢复约定一致。
- [ ] 如果原 P8 已不可复现，记录环境、覆盖范围与结果，按回归保护关闭调查，不能声称找到了历史根因。

### CE-10｜过程中文与合理默认执行（P2）

**定位**：[execute/prompt.ts](../../packages/harness/src/stages/execute/prompt.ts)、[prompt builder](../../packages/prompt/src/builder.ts)、[模型客户端](../../packages/llm/src/client.ts)。

**工作范围**：核实过程说明的真实来源，统一用户语言与 SOUL 的生效边界。对“做个小游戏吧”这类目标明确、细节可合理默认的低风险请求，简短说明选择后开工；真正缺权限、目标冲突或不可逆决策时才等待用户。

- [ ] 中文样本的自然语言过程、澄清、最终交付均为中文；代码、路径、工具原始事实不强行翻译。
- [ ] 已有可写且获授权工作区时，不先问游戏类型、也不再问“是否现在开始”；产物生成并验证后交付。
- [ ] 必需澄清发出后，依赖答案的操作确实等待；可独立的安全工作仍可继续。
- [ ] 英文用户请求仍用英文；自然语言来自真实 LLM，不增加每条过程文案的额外改写请求。

### CE-11｜DSML 控制标记历史回归（P2，仅防退化）

**定位**：[dsml-tool-calls.test.ts](../../packages/llm/src/dsml-tool-calls.test.ts)、[dsml-stream-scanner.test.ts](../../packages/llm/src/dsml-stream-scanner.test.ts)、[user-facing-reply.test.ts](../../packages/harness/src/user-facing-reply.test.ts)。

- [ ] 合法 DSML 工具控制文本恢复为结构化调用，不作为普通答案发布。
- [ ] 畸形、分片、截断控制标记不会泄漏到流式界面或历史回复；失败时与 CE-09 的 Runtime 状态衔接。
- [ ] 用户要求解释 DSML 的合法引用/代码示例不会被过度拦截。
- [ ] 现有回归已覆盖则直接复用，仅补真正缺失用例；无新失败不安排解析器重写。

### CE-12｜真实对话完整验收（P0 交付门）

**目标**：用真实模型、真实 Windows shell 与 Electron 窗口确认用户能拿到可玩的产物。单元测试通过不能替代本项，模型自称“完成”也不能替代文件与运行验证。

| 场景 | 预期结果 |
|---|---|
| 默认数据根下 workplace，发送“做一个小游戏吧” | 在该工作区交付产物，可打开并完成一次主要玩法 |
| 切换到含空格的外部目录，不重启，再发同一请求 | 权限允许后在新目录交付；提示、真实 cwd、产物索引与链接一致 |
| 项目目录与全局默认目录不同，历史记忆另指旧目录 | 按当前项目操作，不自动跳回旧目录 |
| 同一会话切换模型/Provider、工作区或权限，继续对话；另测切换失败与连续快速切换 | 新配置实际生效后的首次模型请求包含简短变更上下文；失败不虚报生效，连续变更按有效状态合并，不污染其他会话或运行中的目录 |
| 在上述普通目录注入一次确定可纠正的工具错误 | 同一 run 内纠正并交付，无须手动“继续” |
| 重复只读查询，中间创建文件 | 第二次取得新结果，不误判副作用重放 |
| 选择受保护核心目录请求生成文件 | 核心写入仍被拒；明确可用去向/必要选择，不声称已在核心目录产出 |
| 预算耗尽后自然语言续接；中途重启再续接 | 绑定原目标，保留成功部分，出现进展或具体阻塞，不重复空问 |
| 模型失败、发布校验失败、断流、权限拒绝、未知副作用 | 终态可见且语义准确；硬边界不被修复逻辑绕过 |

- [ ] 默认目录和外部目录的正常样本各至少独立执行两次；失败样本保留，修复后重跑，不以挑选成功样本关闭任务。
- [ ] 至少人工玩一局生成游戏，检查启动、输入、计分/胜负或对应核心规则、重新开始；结果注明实测范围。
- [ ] 记录源码版本、实际构建版本、模型/Provider、权限模式、脱敏目录类别、run 关联、产物校验与窗口结论。原始日志留在数据根，仓库仅保留脱敏验收摘要。
- [ ] 三档权限的拒绝和同意路径均有自动化覆盖；“完全访问确认后可运行”不代表研究/受限模式可绕过批准。
- [ ] 缓存检查沿用[既有缓存验收约束](../reference/cache-95-acceptance.md)，验证同目录复用和跨 run 回放；两轮小游戏不强行套用长区间 95% 命中结论，不为缓存保留错误 cwd。

### CE-13｜注入简短的运行时变更上下文（P0，首批实施）

**需求来源**：用户追加要求——模型切换、工作区切换等即时信息，应通过一块简短上下文告知模型。此项是明确的新增需求，不声称原报告已复现了所有变更类型的问题。

**定位**：[runtime-awareness.ts](../../packages/harness/src/runtime-awareness.ts)、[runtime-awareness.test.ts](../../packages/harness/src/runtime-awareness.test.ts)、[main/index.ts](../../packages/app/src/main/index.ts)、[execute/prompt.ts](../../packages/harness/src/stages/execute/prompt.ts)、[reply.ts](../../packages/harness/src/stages/reply.ts)、[tool-result-persistence.ts](../../packages/harness/src/stages/execute/tool-result-persistence.ts)。

**工作范围**：复用既有 Runtime facts 注入和模型请求回放链路，增加一块精简的“当前执行环境 / 本次变更”上下文。内容由 Runtime 从实际生效状态确定性生成，作为模型输入，不作为 Agent 回复发布，也不增加一次 LLM 调用。首次建立上下文提供最小当前快照；之后只追加与模型决策有关的有效变化，保留最新状态可恢复。不得为了通知功能新增独立状态机或事件存储系统。

**首批字段**：本次请求实际使用的 Provider 标识及请求模型标识、当前项目/工作区、真实 shell；权限模式、网络开关及实际可调用能力发生变化时也应通知。模型标识来自最终请求路由，不能只读设置页选中值，更不能由模型猜测底层模型身份；密钥、鉴权头、完整配置、无关 UI 设置不进入简报。精确时钟、耗时和每次调用统计不按请求刷入。

**形式示例**（仅说明模型输入形状，字段按实际变化省略）：

```text
[Runtime 上下文变更；本次请求已生效]
模型：provider-a/model-a → provider-b/model-b
工作区：<目录 A> → <目录 B>；后续默认相对路径以 B 为准
Shell：powershell.exe；权限：研究（写入仍需批准）
```

**生效与归属**：变更应用成功后，在使用新状态的首次模型请求之前注入；同轮后续模型请求若实际路由或权限改变，也按该请求的有效状态更新。仅修改偏好但尚未应用、或保存/切换失败时，不宣称新状态已生效。工作区继续遵守 CE-02 的 run 快照：执行中的 run 不换目录，下一 run 生效时再通知。权限执行仍由 Runtime 按现行规则实时复核，简报本身不授予任何权限。

- [x] 首次请求无需模型探测即可知道最小有效环境；模型/Provider A→B 后，实际发往 B 的首个请求含正确变更事实，能力回复与 execute 使用同一来源。（首个请求渲染 6 行快照；`runtime-context-notice.test.ts` 断言切换后出现 `Changed: model.` 与新值，并断言能力回复注入的是同一份事实。）
- [ ] 工作区 A→B 后，简报、提示、工具默认 cwd 与产物归属一致；保留的旧 A 信息明确属于历史，当前区域不同时声称 A 和 B 都是当前工作区。（简报/提示/工具 cwd 已一致；"旧 A 声明为历史"的提示层措辞未单独断言。）
- [x] 权限、网络或工具可用性变化时，模型能及时得知实际限制；工具目录稳定性与调用时授权仍按既有契约处理，不能用通知替代硬校验。（变化进入 `Changed: access, tools.`；授权仍由权限边界实时复核。）
- [x] 同一有效状态不重复追加“已切换”消息；连续快速修改只在请求边界合并为最终有效差异。已被某次模型请求观察到的中间状态保留历史，不回写或删除旧请求。（渲染是纯函数：与上次已观察状态相同则完全不输出；渲染发生在请求边界，中间状态不被回写。）
- [x] 简报以短字段表达，通常不超过 6 行，设置明确长度预算；较长路径优先保证当前目标完整准确，必要时省略旧值或低优先级字段，不截断成错误路径。（1 行表头 + 5 个字段行；路径整段渲染，不做截断。）
- [x] 不改写已发送的稳定前缀来反复通知；变更内容进入既有可回放上下文。后续请求复用已加入的事实而非不断复制；真实变化需要使过期事实失效时，以正确性优先。（走既有尾部账本与 runtime-tail 回放；同一 run 内不重复，下次 run 从回放里读上次状态。）
- [x] 重启、checkpoint 续接与上下文压缩后，最新有效环境仍可获得，已过期状态不会被恢复成当前状态；复用现有持久化/回放机制，不把每次切换写入长期用户记忆。（上一次状态从 `modelHistory` + `produced` 的 `runtime-context` 记录解析；早期记录保留为历史而非被改写。）
- [ ] 多会话、并发 run、切换失败及请求发送失败重试均有定向覆盖：不跨会话串入目录或模型状态，不因“已标记通知”而漏掉模型实际未收到的事实。（单 run 语义与幂等已覆盖；并发/跨会话专项用例待补。）
- [ ] 在 CE-12 中检查真实出站请求及后续行为，不能仅以 UI 已切换或模型口头复述作为验收；通知无需用户再发一句“我刚换了模型/目录”。

## 实施边界与关闭规则

- 本专项属于已观察到的 correctness 问题，遵守 kernel 冻结：保留单一 execute 循环、Runtime VERIFY/RECOVER，不新增规划层、恢复模型或第二套执行器。
- 与[Runtime 状态一致性任务书](runtime-state-consistency-taskbook-2026-09-22.md)衔接：CE-04/06 复用文件观察、写前校验、exec 失效和副作用证据；旧任务书中的历史现状须以实施时源码为准，不重复开发已落地能力。
- 与[对话任务连续性专项](conversation-task-continuity-taskbook-2026-08-13.md)衔接：CE-07/08/09 复用其续接入口与发布规则；与[UI/UX 专项](application-ui-ux-taskbook-2026-09-22.md)的恢复可发现性共用验收，不重复做恢复界面。
- 每项实现同步更新实际改动 package/领域 README，时间取系统时钟，README 与实现同次提交。每项关闭填写：改动/调查结论、验证命令与结果、实机证据、剩余限制；“已修未实测”与“验收完成”分开标注。
- 自动化从上文定位的现有测试扩展，按改动运行定向测试、相关类型检查和 `pnpm.cmd check:repo`；不为文档清单本身新增产品测试。
- 发布顺序先 CE-01～04 与 CE-13 的基本执行能力及运行时变更感知，再恢复与观察边界，最后全矩阵。CE-07/09 若无法证实须保留明确未知项；CE-11 仅回归，不因历史记录把当前版本判为复发。

## 本次清单交付记录

- 已完成：阅读用户问题汇总、核对关键源码机制、映射原 P1～P9，并按用户追加需求加入 CE-13 运行时变更上下文；共 13 项任务，已定义依赖与验收。
- 未进行：产品代码修复、原始日志核验、故障复现、真实模型调用、Electron 实机验收。
- 文档检查结果在本次交付回复中说明；以上任务状态不因文档检查通过而变为已完成。

## 实施记录｜2026-09-23 第三轮（CE-07 取证、CE-08）

### CE-07 取证记录

**原报告那次运行：无法证实。** 报告所指 run 的会话、执行日志与 checkpoint 都在数据根，不在仓库里；本轮没有读取原始日志，也没有 Electron 实机复现。因此不对"那一次为什么报缺失"下结论，下面只记录**从源码可以建立**的事实。

**从源码建立的事实（每条都有对应用例）**：`runtimeExecutionEvidenceGap` 只有在"存在 invocation 记录、却找不到同 callId 的结果"时才说 `tool result <callId> is missing`，其余情况各自有独立文案：

| 输入事实 | 判定 | 是不是"结果缺失" |
|---|---|---|
| invocation `succeeded` + 结果在 | 无 gap | 否 |
| invocation `failed` + 失败结果在 | 无 gap（负结果是证据） | 否 |
| invocation `running`/`proposed`（记录已发布、结果未写回） | `tool result <id> is missing` | **是，唯一一条** |
| invocation 状态被拒（`approval_denied` 等）+ 结果在 | `tool invocation <id> is <status>` | 否 |
| 同 callId 出现两次 | `duplicate tool invocation <id>` | 否 |
| invocation 证据被裁剪 | `tool invocation evidence is truncated` | 否 |
| 副作用 `unknown`/`in_progress`/`planned` | `side effect <key> is <status>` | 否 |
| 副作用是终态但本 run 没有对应 invocation | `side effect <key> has no matching tool invocation` | 否 |

**确认的缺陷：恢复投影不自洽（已修）。** `run-checkpoint.ts` 的 `buildRunCheckpoint` 持久化 `sideEffects` 与 `taskExecution`，但**不**持久化 `toolInvocations`；`restoreContinuationContext` 用 `replaceSideEffectEvidence` 恢复账本，而 `ctx.toolInvocations` 从 `runner-init` 起是空数组。于是续跑的 run 继承了一批 callId 属于**上一轮**的终态副作用，这些 callId 永远不可能出现在本轮的 invocation 列表里，判定就把 Runtime 自己已经结算过的工作报成"没有对应工具调用"。任何"中断前已结算副作用、续跑后继续做完"的 run 都会命中，而 `runner-continuation.test.ts` 之前没有覆盖这一条。

同一段的第二处：旧检查点的步骤证据回退分支要求 `result.ok === true`，于是**已记录的失败**也被算成"没有证据"——正是本节验收里"已存在的工具失败不能变成结果缺失"要禁止的事。

**最小修复**（只改判定，不加持久化字段）：`inheritedEffectEvidence()` 取代 `hasLegacyCheckpointToolResult()`：只有在 `resumedFromCheckpointId` 存在时才谈继承；继承证据来自检查点自己带过来的东西——旧检查点步骤里记过这次调用与它的结果（成功或失败都算），或账本条目本身已是终态（`succeeded`/`failed`/`cancelled`，说明 Runtime 在中断前已结算）。没有 callId、仍未结算、或本 run 根本没续跑，仍然报 gap。

**先失败后通过的证据**：上述三条用例在修改前失败（`expected 'side effect tool:exec:call-1 has no m…' to be undefined`），修改后 13 条全过；另有一条阶段级用例断言续跑 run 现在能以 `unverified` 进入 FINALIZE，而不是被打回 RECOVER。

**剩余未知**：报告中"未找到工具结果"的原始文案与触发路径仍不可回溯；本轮只能说明"结果缺失"这一判定的成立条件，以及它此前会在续跑场景被**错误地**触发。若原报告那次并未续跑，则它属于另一条路径，需要原始日志才能继续。

### CE-08 改了什么

| 改动 | 内容 | 主要文件 |
|---|---|---|
| 恢复分类读到真实证据 | `recordedFailureKinds` 在 TaskBook 步骤为空（单循环下永远如此）时，改读 invocation 的权限类状态、`aborted` 状态、以及 `core_source_read_only` 这一声明种类，并把 `lastError` 文本交给既有的 `classifyStepFailure`。修复前：步骤执行器删除后没人再写 `taskExecution`，种类永远是空数组，`decideRecovery` 的权限拒绝与取消分支永久失效——每次失败都重试到预算耗尽，再以 `recovery_budget_exhausted` 升级，用户看到的原因与实际阻塞无关 | `packages/harness/src/stages/recover/policy.ts` |
| 升级事实分三件 | 新增 `recover/escalation.ts`：原因类别（权限不足 / 资源缺失 / 证据不可恢复 / 副作用未结算 / 恢复预算耗尽 / 已中止 / 执行无法继续）、已完成部分（调用与副作用计数与状态、是否存在未发布草稿；只有计数与状态）、继续所需动作。三件事实写进 `clarificationRequest.blockingReason`，问题本身也点名原因与所需动作 | `packages/harness/src/stages/recover/escalation.ts`、`stages/recover.ts` |

### 验证命令与结果

- `pnpm.cmd exec vitest run packages/harness` → **80 文件 / 659 项通过**；`packages/runner` → **58 文件 / 368 项通过**（在 CE-07 修复之后跑，续跑相关用例全绿）。
- `pnpm.cmd run typecheck` → exit 0；`pnpm.cmd run check:repo` → `ok (36 passed, 0 failed)`。
- 新增用例：`stages/verify/evidence-gap.test.ts`（13）、`stages/recover.test.ts` 新增 5 条无 TaskBook 步骤的分类与升级事实用例（18）。

### 本次未做

- 仍未做真实模型调用与 Electron 实机；CE-12 全部场景未执行。
- CE-08 的"绑定重试跨重启语义"沿用既有 runner-continuation 覆盖，本轮没有新增端到端断言；`escalateExhaustedReplan`（VERIFY 自己的升级）仍用原有的原因文案，未合并到新的三件事实格式。
- CE-09～CE-11 未开始。

## 实施记录｜2026-09-23 第二轮（CE-05、CE-06）

同样只记录**已合入源码、已过自动化验证、尚未实机验收**的改动。

### 改了什么

| 编号 | 改动 | 主要文件 |
|---|---|---|
| CE-05 | 受保护根内补上可证明的存在性探测：`isReadOnlyCoreCommand` 放行单条 `Test-Path`，并排除 `-Credential`（本地探测不能变成认证通道）；四种写入方（`exec`/`write`/`edit`/`document_create`）的拒绝改用同一份 `coreSourceReadOnlyMessage()`，点名仍可用的只读形态与"改用可写工作区"，并统一声明 `meta.errorKind: 'core_source_read_only'` | `packages/tools/src/path-protection.ts`、`builtin/exec.ts`、`builtin/write.ts`、`builtin/edit.ts`、`builtin/document-create.ts` |
| CE-04 补口 | 上面这个 kind 接进失败处置：核心源码只读保护是权威边界（审批也不能覆盖），模型不得换工具试探；同时把 `repeated_call`（执行服务的重复调用护栏）也列为权威，理由与状态名解耦 | `packages/harness/src/stages/execute/tool-failure-disposition.ts` |
| CE-06 | 重复观察不再等于重放：判据仍是 Runtime 能证明的事实——只声明读资源或属于 Runtime 只读名单的调用不进账本（不变），不透明 `exec` 无论命令文本如何都记为 `external`（不变，未新增启发式豁免）；`side_effect_replay` 改为"对这次调用终局、对整轮不终局"，让模型能改用结构化工具；拒绝文案点名 `glob`/`read`；`exec` 工具描述提前说明"相同成功调用会被拒"并指向结构化入口 | `packages/harness/src/stages/execute/tool-failure-disposition.ts`、`side-effect-lifecycle.ts`、`packages/tools/src/builtin/exec.ts` |

### 验证命令与结果

- `pnpm.cmd exec vitest run packages/harness packages/tools` → **95 文件 / 847 项通过，1 跳过，0 失败**。
- 新增/扩展用例：`path-protection.test.ts`（6）、`builtin/exec.test.ts` 新增受保护根读/写三例（24）、`stages/execute/read-observation-loop.test.ts`（4，真实主循环）、`stages/execute/side-effect-ledger.test.ts` 新增"观察 vs 效果"（9）、`tool-failure-disposition.test.ts`（12）。
- `docs/reference/cache-baseline/` 只更新 freeze 提交号：探测用的固定工具目录不含 `exec`，工具描述改动没有进入可缓存字节基线。
- 受保护根内的只读路径用**真实 shell**（`powershell.exe`）执行验证，不是只测分类函数。

### 本次未做

- 仍未做真实模型调用与 Electron 实机；CE-12 全部场景未执行。
- CE-05 最后一条（模型如何向用户说明"该目录不可写"并只请求一次具体路径）只有拒绝文案这一半，行为面属 CE-10/CE-12。
- CE-07～CE-11 未开始。

## 实施记录｜2026-09-23 第一轮（CE-01～04、CE-13）

本段记录的是**已合入源码、已过自动化验证、尚未实机验收**的第一批改动。任何真实模型 / Electron 结论都不在此，CE-12 仍是唯一交付门。

### 改了什么

| 编号 | 改动 | 主要文件 |
|---|---|---|
| CE-01 | `# Workspace` 段落改读 run 级事实：`RuntimeFacts.workspace`（= `ctx.cwd`）优先于 `agents.defaults.workspace`；run 入口把工作区归一化成绝对路径后再下发 | `packages/prompt/src/builder.ts`、`packages/harness/src/stages/execute/prompt.ts`、`packages/harness/src/stages/reply.ts`、`packages/app/src/main/local-app-api/run-support.ts` |
| CE-02 | Runner 捕获的配置一旦与保存值不同即重建：比较按字段而非"模型/网络"白名单，`desktop`（窗口策略，读者实时取值）与 `version` 除外；规范化/持久化/重建事务由模块串行化 | `packages/app/src/main/runtime-config-change.ts`、`packages/app/src/main/index.ts` |
| CE-03 | shell 从执行器自身常量产生：`describeExecutionShell()` 同时供 spawn、Runtime facts 与 `exec` 工具描述使用；Windows 明确 `powershell.exe` 而非 `pwsh`，给出分隔符、`Get-ChildItem`/`Test-Path`、含空格路径引用与"cmd `&&` 不可用" | `packages/tools/src/builtin/exec.ts`、`packages/tools/src/index.ts`、`packages/harness/src/runtime-awareness.ts` |
| CE-04 | 失败处置分档：只有权威边界（权限/硬拒绝、未知工具、schema 校验、中止、未结算副作用、无 invocation 记录）才强制收尾；普通执行失败留在同一循环里纠正，仍受迭代与无进展预算；失败的副作用调用追加"先观察再决定"的 Runtime 控制消息 | `packages/harness/src/stages/execute/tool-failure-disposition.ts`、`tool-loop.ts`、`tool-result-persistence.ts` |
| CE-13 | 新增 ≤6 行的"当前执行环境/本次变更"简报：字段取自 `resolvedRunConfig`（provider/model、权限、网络、可用工具数）、`ctx.cwd` 与真实 shell；渲染是纯函数，状态未变则完全不输出；上一次状态从 `modelHistory` + `produced` 的 `runtime-context` 记录解析，主循环走既有尾部账本，单请求阶段注入并在发布成功后写入 transcript | `packages/harness/src/runtime-context-notice.ts`、`run-tail-ledger.ts`、`runtime-awareness.ts`、`stages/reply.ts` |

### 验证命令与结果

- `pnpm.cmd exec vitest run packages/harness packages/app packages/prompt packages/tools` → **291 文件 / 1783 项通过，1 跳过，0 失败**。
- `pnpm.cmd exec vitest run packages/runner` → **58 文件 / 368 项全部通过**。（首次全量运行时 `runner.test.ts` 有一项因断言写死了 Runtime 尾部记录下标而失败；该下标随本轮新增的 `runtime-context` 记录位移，已改为按记录内容定位。）
- 全量 `pnpm.cmd exec vitest run`（本轮较早一次，覆盖 487 个文件）→ **486 passed / 1 failed**；唯一失败项是 `scripts/verify-web-live-llm-evidence.test.mjs` 的 "accepts pnpm forwarding…"：它直接运行 `verify-web-live-llm-evidence.mjs`，而该脚本导入 `packages/harness/dist/`，本机 `dist/` 里留有 2026-09-21 的过期产物 `compact-explicit-tool-decision.js`（对应源码已不存在）。这是本地构建缓存问题，与本次改动无关，`dist/` 也在 `.gitignore` 内。
- `pnpm.cmd run typecheck` → exit 0；`pnpm.cmd run check:repo` → `ok (36 passed, 0 failed)`。
- 受影响的可缓存字节基线由 `packages/harness/src/probe/baseline.test.ts` 自动重算：本轮 `Runtime Facts` + 环境简报使每个请求多 1 条消息约 467 字符（`docs/reference/cache-baseline/`），共享前缀比例随之下降，稳定头不变——这是新增事实的预期代价，不是回退。
- 新增/扩展的定向用例：`runtime-context-notice.test.ts`（10）、`stages/execute/prompt.test.ts`（4）、`stages/execute/tool-failure-disposition.test.ts`（10）、`runtime-config-change.test.ts`（6）、`local-app-api/run-support.test.ts`（9）、`packages/runner/src/run-workspace-fact.test.ts`（2，真实 Runner + 真实工具调用断言 Main→Runner→提示→工具 cwd 同源）。
- 为容纳新事实而更新的既有断言：`run-tail-ledger.test.ts`、`model-observability.test.ts`、`model-request-characterization.test.ts`、`cache-request-shape-matrix.test.ts`、`stages/reply.test.ts`、`e2e.test.ts`、`runner.test.ts`。每条都补了说明新事实的注释，没有为了让测试通过而放宽语义。
- 两处为满足"600 行以上生产文件受控"门禁而做的结构下沉：`updateRuntimeConfig` 的规范化/持久化/重建事务整体移入 `runtime-config-change.ts`（组合根只保留接线），失败处置判定移入 `tool-failure-disposition.ts` 的 `toolRoundFailurePolicy`。

### 本次未做（不得据本段认为已关闭）

- 没有真实模型调用、没有 Electron 实机窗口、没有真实小游戏产物；CE-12 全部场景未执行。
- CE-04 的"同批部分成功/失败"与"纠正后仍为 `unverified`"两条只有源码级理由，没有定向断言。
- CE-13 的多会话/并发 run/发送失败重试没有专项用例。
- CE-05～CE-11 未开始。
- 上一轮清单里"报告复现"与"源码确认"的区分依然成立：本段所有结论都是自动化证据，不替代实机观察。
