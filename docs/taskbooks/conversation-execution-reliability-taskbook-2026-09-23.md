# 对话执行可靠性修复任务清单 2026-09-23

最后更新：2026-09-24 03:05:00

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
| 已核查已修 | CE-09 | P1 | run 失败也有可见、可恢复的终态 | P8 | M | 可先复现；联验依赖 CE-08 |
| 部分实施待实测 | CE-10 | P2 | 中文过程表达与低风险模糊请求直接执行 | P9 | S | CE-01/03/04 |
| 已回归 | CE-11 | P2 | 保留 DSML 泄漏历史回归 | P7 | S | 无 |
| 大部分已实测，人工试玩待做 | CE-12 | P0 交付门 | 三类工作区的真实完整流程验收 | P1～P9 | L | 对应实现与调查关闭后 |
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
- [x] 覆盖默认 workplace、用户外部目录、项目绑定目录，以及空格/中文路径；不把数据根与 workplace 混用。（默认目录、**数据根之外**的目录、**含空格**路径与**中文**路径都由 `local-app-api/run-support.test.ts` 断言（中文用例确认归一化不转写、不转义、不丢字符）；项目绑定目录由 `resolveRunWorkspaceContext` 的 `project` 分支断言；数据根与 workplace 是两个不同的解析入口，未混用。）
- [x] 本轮有显式工具 cwd 时，目标和授权范围按该调用重新求值，不能因此悄悄更改会话归属。（`exec.test.ts` 新增用例：显式 `cwd` 让命令真的在那个目录里跑（输出含该目录）、`ctx.cwd` 保持不变，并且同一调用的边界按它实际运行的位置判定——目录在容器内判 `inside`、在容器外判 `outside` 且研究模式仍需批准。）
- [ ] 历史记忆指向 A、当前在 B 时，不声称 A 的文件存在于 B，不自动跳回 A；需要访问 A 时遵循当前权限。
- [x] 同目录后续轮次保持缓存前缀稳定；切换目录时不为命中缓存继续使用旧事实。（`stableText` 逐次比对；切目录产生新的 prompt 字节与新 run 事实。）

### CE-02｜工作区切换与配置更新即时生效（P0）

**定位**：[main/index.ts](../../packages/app/src/main/index.ts) 的 `updateRuntimeConfig` / `rebuildRunner`、[run-support.ts](../../packages/app/src/main/local-app-api/run-support.ts)、[runtime-config.test.ts](../../packages/app/src/main/runtime-config.test.ts)、[runtime-config-api.test.ts](../../packages/app/src/main/runtime-config-api.test.ts)。

**工作范围**：消除 Runner 长期引用旧配置造成的事实漂移。优先让新 run 获取最新、不可变的有效配置及目录快照；是否重建 Runner 以最小改动和并发正确性决定，不把“每次切目录都重建”预设为唯一方案。

- [x] 不重启应用，保存默认工作区 A→B 后，新建且未绑定目录的 run 使用 B。（变更检测与重建触发由 `runtime-config-change.test.ts` 覆盖到字段级；**实机**：`POST /runtime {workspace: <新目录>}` 保存后，**请求里不指定任何目录**再发一次，产物落在新目录、旧默认目录无同名文件、`write` 的 `resourceKeys` 解析到新工作区——说明提示、工具 cwd 与产物归属都跟着换了，不只是配置文件写了。）
- [ ] 已绑定项目 A 的会话仍按项目归属运行，不被全局默认 B 偷换；显式切换会话目录后，新 run 使用新目录。（`resolveRunWorkspaceContext` 的项目归属已断言；渲染器侧仍以 `runtime.workspace` 下发请求目录，实机行为待 CE-12。）
- [x] 正在执行的 run 保留启动时目录；切换设置不把执行中的命令或产物改派到另一目录。（Runner 在 `executeRun` 入口解析一次 `cwd`，整轮工具上下文与提示共用该值；重建采用"先建后换 + 延迟关闭旧 Runner"。）
- [x] 配置持久化失败不显示保存成功；连续更新和并发启动不混用两份配置。（`runtime-config-change.test.ts` 新增三条：`createRuntimeConfigUpdater` 先持久化再重建，且只在真正有变化时重建；**持久化抛错时 promise 拒绝、Runner 不替换、当前配置仍是磁盘上那一份**（调用方因此拿到错误而不是"已保存"）；两个并发更新被串行化，按序落盘、不会互相看到半应用状态。渲染器侧 `applyRuntimePatchReporting` 把该错误显示在设置页并在失败后重读配置——既有 `api` 用例覆盖。）
- [x] 覆盖 Main→Runner→提示→工具 cwd 的集成断言，不能只检查 config 文件已写入。（`packages/runner/src/run-workspace-fact.test.ts` 走真实 Runner + 真实工具调用，断言提示、工具 `ctx.cwd` 与环境简报一致。）

### CE-03｜披露真实 shell（P0）

**定位**：[exec.ts](../../packages/tools/src/builtin/exec.ts)、[runtime-awareness.ts](../../packages/harness/src/runtime-awareness.ts)、[exec.test.ts](../../packages/tools/src/builtin/exec.test.ts)。

**工作范围**：从实际执行器产生平台、shell 名称及必要语法约束，进入模型可见契约。Windows 明确为 `powershell.exe`，不能暗示 PowerShell 7；Unix 按实际 `/bin/sh` 描述。不得依赖仓库根 TOOLS.md 或覆盖用户的运行时 TOOLS.md 来补事实。

- [x] Windows 与 Unix 的披露值和实际启动的可执行文件、参数一致；未知版本不编造版本号。（`describeExecutionShell()` 与 spawn 共用同一组常量，`stages/execute/prompt.test.ts` 用返回的 descriptor 反查披露文本；只说明是 Windows PowerShell 而非 `pwsh`，不给版本号。）
- [x] Windows 示例覆盖带空格目录的列举、文件存在性查询；不把 cmd 的连接语法或 Bash 的 `&&` 当作默认兼容语法。（`Runtime Facts` 的 shell 行与 `exec` 工具描述都给出 `;` 分隔、`Get-ChildItem`/`Test-Path`、含空格路径的引用方式，并明确 cmd 的 `&&` 不可用。）
- [x] 合成运行时 TOOLS.md 为空/占位时，模型仍能得知 shell；无须额外调用模型猜测环境。（Runtime facts 与工具目录都不读 TOOLS.md。）
- [x] 真实模型小游戏样本不再因缺失 shell 信息产生报告中的首条命令错误；剩余偶发错误由 CE-04 处理。（**实机统计**：8 个隔离数据根共 21 次真实 run、**66 次 `exec`**；首个命令就是 `Get-Location; Get-ChildItem | Select-Object Mode,Name` 这样的 PowerShell 写法。18 次 `exec` 返回非零，逐条核对**没有一条**是 shell 语法/解释器错误（无 `CommandNotFoundException`、无 `&&` 被拒、无 `ParserError`、无 `command not found`），全部是普通非零退出（`node test_game.mjs`、`node game.test.js` 等）；这些正是 CE-04 的有界纠正路径。）

### CE-04｜普通工具错误可以有界纠正（P0）

**定位**：[tool-loop.ts](../../packages/harness/src/stages/execute/tool-loop.ts)、[tool-result-persistence.ts](../../packages/harness/src/stages/execute/tool-result-persistence.ts)、[side-effect-ledger.ts](../../packages/harness/src/stages/execute/side-effect-ledger.ts)、[verify.ts](../../packages/harness/src/stages/verify.ts)、[recover/policy.ts](../../packages/harness/src/stages/recover/policy.ts)。

**工作范围**：用 Runtime 已有结构化结果区分可纠正执行错误、权限/硬边界拒绝、未结算副作用、取消和预算耗尽；必要字段只做最小补齐。可纠正错误留在同一个 execute 主循环，将结果交给模型修正；不得以删除失败记录、整轮重跑或新增规划器实现“恢复”。

- [x] 只读路径不存在、确定未执行的语法错误、测试命令返回失败，均可在预算内补充观察或修正输入，无须用户再发“继续”。（`tool-failure-disposition.test.ts`：读取失败后同一 run 内改用 `glob` 观察并交付。）
- [x] 非零退出不等于零副作用：先写文件再退出失败的命令不会被无条件原样重放；必要时观察实际状态再决定后续动作。（失败的副作用调用追加 Runtime 控制消息要求先观察；Runtime 自身从不重放，成功副作用仍被账本拦截。）
- [x] 权限拒绝、核心源码写入硬拒绝、未知工具等权威边界保持停止/升级规则，不能换工具绕过；取消和未结算副作用不自动续跑。（权威状态/错误种类/未结算副作用一律强制收尾；无 invocation 记录的结果按权威处理。）
- [x] 同批部分成功、部分失败时保留成功结果和账本，只处理未完成部分。（`tool-failure-disposition.test.ts` 新增用例：同一轮两个 `write`，一个成功一个路径不存在——两条结果按序都保留、失败条目带原因；下一轮模型只重做失败的那条，成功的写入没有被 Runtime 重发（调用计数 3 = 2 次首批 + 1 次重做）。）
- [x] 连续相同失败无新增证据时有界停止，报告实际阻塞；不放大为无限模型/工具循环。（同输入重复失败的证据指纹不变，2 轮无进展后收回工具；用例断言 3 次执行、6 次模型调用后停止。）
- [x] 先失败后纠正的历史仍可追溯；按现行 VERIFY 契约保留 `unverified`，最终产物完成情况单独以证据说明，不伪造 `pass`。（**实机证据**：CE-12 验收里 6 次运行共出现 4 次 `observation_missing` 写入失败，全部在同一 run 内自行纠正为成功写入，而这些 run 的验证记录都是 `unverified`——没有一次因为"后来成功了"被写成 `pass`；失败仍在 `toolInvocations`/证据里可追溯。）

### CE-05｜核心目录可读、不可写（P1）

**定位**：[path-protection.ts](../../packages/tools/src/path-protection.ts)、[exec.ts](../../packages/tools/src/builtin/exec.ts)、[path-protection.test.ts](../../packages/tools/src/path-protection.test.ts)。

**工作范围**：优先让存在性/目录列举需求使用现有可证明只读的工具；有缺口时补最小结构化读能力。若必须支持 shell，只支持能够验证的狭窄形态。复杂组合无法证明只读时继续拒绝，并提供明确的只读替代入口；不要求放行原报告中的组合命令。

- [x] 在授权允许时，可完成核心目录的存在性与文件列表查询；既覆盖组合语法被拒，也覆盖单条 `Test-Path` 当前未被允许的问题。（`isReadOnlyCoreCommand` 新增单条 `Test-Path`；`exec.test.ts` 用真实 shell 断言受保护根内的 `Get-ChildItem` 列举与 `Test-Path -LiteralPath` 存在/不存在三例，以及四种组合/写入形态仍被拒。）
- [x] `mkdir`、写入、删除、重定向、读命令夹带写命令，以及符号链接/动态路径绕行仍受保护。（分隔符/重定向/子表达式守卫未放宽，`-Credential` 另被排除；组合用例断言未产生任何文件。）
- [x] 三档权限保持原语义；只读判定不把容器外目录自动变成容器内，也不等于免除审批。（`describeToolAccess` 对受保护根外的只读命令仍判 `outside`，研究模式仍需批准；`full` 放行、`restricted` 一律批准，均由 `exec.test.ts` 断言。）
- [x] 选中核心目录要求生成游戏时，明确它不可写；在产品现有授权下提出可用工作区，确需选择时只请求一次具体路径，不静默改目录。（**实机证据**：把工作区设为 LS 核心源码根、在**完全访问**下要求创建文件，`write` 以 `core_source_read_only` 被拒、目标文件不存在，模型给出 626 字的中文说明（含可用去向）。授权没有绕过宿主级只读保护。）

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
- [x] 同一阻塞未改变时不再只给原样三选一：呈现具体原因、已完成部分和所需动作；保持旧回复的发布幂等，不靠强制改写文案去重。（`recover/escalation.ts` 给出原因类别、已完成部分与所需动作三件事实并写进 `clarificationRequest`；选项集合与发布 settlement 未改，重复措辞仍按原样发布。**实机**：真实运行里预算耗尽后的回复确实写出了原因类别、23 次工具调用中 17 次成功、8 次副作用已成功等具体事实，而不是同一句三选一。）
- [x] 权限不足、资源缺失和证据不可恢复分开处理；用户取消立即停止，成功副作用不重放。（`recordedFailureKinds` 在无 TaskBook 步骤时改读 invocation 状态与 `lastError`：权限拒绝第一次就升级而不是烧掉重试预算，`aborted` 直接停止，`verify` 阶段的缺口归为"证据不可恢复"；未结算副作用仍由 `policy.ts` 直接 abort。）
- [x] CE-07 若发现证据缺口，先修缺口再验收本项，不仅修改追问措辞。（CE-07 的恢复投影缺陷已在本轮先修并有先失败后通过的用例，之后才改升级事实。）

### CE-09｜失败不能在界面上消失（P1，先复现）

**定位**：[runner-finalize.ts](../../packages/runner/src/runner-finalize.ts)、[user-facing-reply.ts](../../packages/harness/src/user-facing-reply.ts)、[Renderer runtime](../../packages/app/src/renderer/runtime/README.md)、[恢复界面](../../packages/app/src/renderer/runtime-recovery/README.md)。

**工作范围**：检查普通输入到 run 终态、事件流、持久化和重新打开会话的链路。先核实旧 TaskBook step 的工具拒绝在当前单循环/旧 checkpoint 兼容路径上能否发生，不重新引入已删除的步骤执行器。

- [x] 模型失败、工具拒绝、无可发布模型正文、断流和终态持久化异常均有可见 Runtime 状态，输入框不永久停留在运行中。（源码核对 + 新增回归：`run-actions.ts` 的 `finally` 在每条退出路径复位 `loading`；确定性流拒绝、流结束却没有 result、`ok` 却没有已结算回复分别变为 `failed`，中止为 `aborted`，两者都带上 Runtime 原因并把输入/附件还给输入栏。`run-actions.test.ts` 新增三条参数化用例逐项断言 `text === ''`、`activity.status === 'failed'`、`error` 等于 Runtime 消息、`setLoading(false)`。）
- [x] 无合法 LLM 回复时允许只有 Runtime 错误/状态，不能生成固定“Agent 道歉”冒充模型回复。（`run-result-reducer.ts` 在非 `ok` 时把正文置空、只保留 Runtime 错误行；新增用例断言失败回合的序列化消息里不含流式预览，也不含道歉式模板。发布侧边界本就只接受有 `ReplyProvenance` 的 Provider 文案。）
- [x] 同一失败刷新、重开会话后仍可识别，已有模型回复不重复发布；确实未持久化时不得暗示已保存。（`shared/history-activity.ts` 的 `buildHistoryMessages` 每次从持久化消息与执行日志重建同一状态，没有 assistant 消息的 run 得到一行不写入转录的 Runtime 状态行；未结算的终稿提案一律不显示为历史回答。既有 `history-activity.test.ts` 13 条覆盖，本轮未改该投影。）
- [x] 待决定状态可在原对话发现与继续；启动自动恢复不新增阻塞式提示，与既有静默恢复约定一致。（`runActivityOutcome` 把 `waiting_user` 映成同一状态并带 `runCheckpointId`，历史用例断言实时与重载一致；启动恢复在 `RunRouter.create` 里只做租约恢复与完成对账，只写 `console` 日志，不产生任何 UI 提示。）
- [x] 如果原 P8 已不可复现，记录环境、覆盖范围与结果，按回归保护关闭调查，不能声称找到了历史根因。**结论：从源码不可复现原 P8（空回复），按回归保护关闭；不声称找到历史根因。** 环境与覆盖范围见下方"CE-09 核查记录"。

### CE-10｜过程中文与合理默认执行（P2）

**定位**：[execute/prompt.ts](../../packages/harness/src/stages/execute/prompt.ts)、[prompt builder](../../packages/prompt/src/builder.ts)、[模型客户端](../../packages/llm/src/client.ts)。

**工作范围**：核实过程说明的真实来源，统一用户语言与 SOUL 的生效边界。对“做个小游戏吧”这类目标明确、细节可合理默认的低风险请求，简短说明选择后开工；真正缺权限、目标冲突或不可逆决策时才等待用户。

- [x] 中文样本的自然语言过程、澄清、最终交付均为中文；代码、路径、工具原始事实不强行翻译。**运行时侧已核实**：主循环的 `# Assistant Output Directives` 写着"Reply in the user's language (Chinese by default; keep technical terms in English)"与"Code, paths, commands go inline"，运行时 SOUL.md 通过 bootstrap 进入同一提示，`stages/execute/prompt.test.ts` 断言两件事同时在场；能力/澄清路径另有 `buildUserFacingVoiceAddon` 的同一条规则。中文**样本**的最终措辞仍需 CE-12 用真实模型确认。
- [ ] 已有可写且获授权工作区时，不先问游戏类型、也不再问“是否现在开始”；产物生成并验证后交付。**只完成了合同侧**：执行契约此前缺的"清晰、低风险、细节有明显默认值的目标不必先问；选定合理默认、一句话说明选择后开工"已补进 `# Assistant Output Directives`（会话契约原本就有等价规则，执行契约没有）。模型是否照做属 CE-12 的真实样本验收，本轮不预先判定。
- [ ] 必需澄清发出后，依赖答案的操作确实等待；可独立的安全工作仍可继续。（未动：当前架构下模型发起 `request_user_input` 即结束本轮并由下一轮回答，同轮内继续做独立工作没有实现，也没有被本轮改动影响。）
- [x] 英文用户请求仍用英文；自然语言来自真实 LLM，不增加每条过程文案的额外改写请求。**运行时侧已核实**：语言规则是"用户的语言"而非"总是中文"；发布路径复用模型自己写下的文本（`publishUserFacingReply` 只做来源与幂等校验），每条过程文案不会多出一次改写请求；`ask_user` 的措辞调用只发生在 Runtime 升级且模型没有给出提问时，属既有有界设计。

### CE-11｜DSML 控制标记历史回归（P2，仅防退化）

**定位**：[dsml-tool-calls.test.ts](../../packages/llm/src/dsml-tool-calls.test.ts)、[dsml-stream-scanner.test.ts](../../packages/llm/src/dsml-stream-scanner.test.ts)、[user-facing-reply.test.ts](../../packages/harness/src/user-facing-reply.test.ts)。

- [x] 合法 DSML 工具控制文本恢复为结构化调用，不作为普通答案发布。（既有 `dsml-tool-calls.test.ts`、`client.test.ts` 的"retracts streamed DSML text after recovering it as a tool call"与逐字符切分用例；本轮未改解析器。）
- [x] 畸形、分片、截断控制标记不会泄漏到流式界面或历史回复；失败时与 CE-09 的 Runtime 状态衔接。（补了四种畸形形态的流式用例：截断在闭合标签之前、没有信封的 `invoke`、没有 `invoke` 的 `parameter`、未注册工具 —— 均以 `reset` + `LlmError(502)` 失败关闭，重放 chunk 序列后可见文本里不含控制标记；分片由既有逐字符用例覆盖。**与 CE-09 的衔接仍待 CE-09 完成后联验**：这里证明的是不发布，不是界面如何呈现该失败。）
- [x] 用户要求解释 DSML 的合法引用/代码示例不会被过度拦截。（补了流式文档示例用例：围栏内的完整信封按普通文本流出与返回，无 `reset`、无工具调用；既有解析器用例覆盖行内与转义形式。）
- [x] 现有回归已覆盖则直接复用，仅补真正缺失用例；无新失败不安排解析器重写。（只新增用例，未改 `dsml-tool-calls.ts` / `dsml-stream-scanner.ts`。扫描器仍只认 `calls`/`tool_calls` 开头，因此正文先流、随后到达的 `invoke` 在流结束时统一撤回——两种路径的最终状态一致。）

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

- [x] 默认目录和外部目录的正常样本各至少独立执行两次；失败样本保留，修复后重跑，不以挑选成功样本关闭任务。（`scripts/verify-conversation-execution-reliability.mjs` 连做两轮完整验收：同一会话内"做一个小游戏吧"→"继续做吧"，加一次独立新会话重跑同一请求。工作区是**配置默认目录且位于数据根之外、路径含空格**的目录，属于"外部/含空格"一类；两轮共 4 次正常样本执行全部 `status=ok`，失败样本按 5.5 轮记录保留在数据根。）
- [ ] 至少人工玩一局生成游戏，检查启动、输入、计分/胜负或对应核心规则、重新开始；结果注明实测范围。**没有人工试玩**：本轮只做了机械校验（内联脚本可解析、无外部/远程脚本，并检出 canvas / game_loop / keyboard_input / score / restart 信号），以及一次模型自己写的 Node 沙箱试跑（8000 帧、0 运行时异常、得分 125）。"好不好玩、手感如何"仍是未完成的人工项。
- [x] 记录源码版本、实际构建版本、模型/Provider、权限模式、脱敏目录类别、run 关联、产物校验与窗口结论。原始日志留在数据根，仓库仅保留脱敏验收摘要。（报告含 `sourceRevision`、`electronVersion`、provider/model、`permissionMode=full`、目录类别（含空格的外部/默认工作区）、每个场景的 `runId`/`sessionId`、产物校验与真实窗口就绪判定；原始会话与执行日志留在隔离数据根，见下方"CE-12 实机验收记录"。）
- [x] 三档权限的拒绝和同意路径均有自动化覆盖；“完全访问确认后可运行”不代表研究/受限模式可绕过批准。（自动化：`packages/safety/src/permission-boundary.test.ts` 覆盖三档判定矩阵，`packages/tools/src/builtin/exec.test.ts` 断言研究模式仍需批准、受限一律批准、完全访问放行。**真实窗口**：CE-12 验收新增两条研究模式场景——工作区在容器内，`write` 触发的批准被**同意**时文件确实落盘（`approvals.granted=1`），被**拒绝**时文件不存在且回复没有谎称成功（`approvals.denied=1`，`write` 状态 `approval_denied`）。受限模式仍未在真实窗口里走过。）
- [x] 缓存检查沿用[既有缓存验收约束](../reference/cache-95-acceptance.md)，验证同目录复用和跨 run 回放；两轮小游戏不强行套用长区间 95% 命中结论，不为缓存保留错误 cwd。（`pnpm.cmd run check:cache-acceptance` → exit 0，结论 `met`；两轮小游戏样本刻意不套用长任务 95% 红线，验收记录里只报告事实。）

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

- [x] 首次请求无需模型探测即可知道最小有效环境；模型/Provider A→B 后，实际发往 B 的首个请求含正确变更事实，能力回复与 execute 使用同一来源。（单元用例断言切换后出现 `Changed: model.` 与新值、能力回复注入同一份事实；**实机**用真实 Electron 窗口 + 真实 DeepSeek 复现了"建立 → 切换 → 保持"三步，第二次请求由新 provider/model 作答并携带简报。）
- [x] 工作区 A→B 后，简报、提示、工具默认 cwd 与产物归属一致；保留的旧 A 信息明确属于历史，当前区域不同时声称 A 和 B 都是当前工作区。（简报/提示/工具 cwd 一致由 runner 级用例与实机场景覆盖：保存新默认工作区后不指定目录的请求交付在新目录、旧目录无同名文件、工具 `resourceKeys` 指向新工作区，见 CE-02。"旧 A 属于历史"的提示层措辞仍无机械断言——那是模型措辞，归 CE-12 的人工判断。）
- [x] 权限、网络或工具可用性变化时，模型能及时得知实际限制；工具目录稳定性与调用时授权仍按既有契约处理，不能用通知替代硬校验。（变化进入 `Changed: access, tools.`；授权仍由权限边界实时复核。）
- [x] 同一有效状态不重复追加“已切换”消息；连续快速修改只在请求边界合并为最终有效差异。已被某次模型请求观察到的中间状态保留历史，不回写或删除旧请求。（渲染是纯函数：与上次已观察状态相同则完全不输出；渲染发生在请求边界，中间状态不被回写。**实机**：切换后的第三次请求状态未变，真实请求里没有简报项。）
- [x] 简报以短字段表达，通常不超过 6 行，设置明确长度预算；较长路径优先保证当前目标完整准确，必要时省略旧值或低优先级字段，不截断成错误路径。（1 行表头 + 5 个字段行；路径整段渲染，不做截断。）
- [x] 不改写已发送的稳定前缀来反复通知；变更内容进入既有可回放上下文。后续请求复用已加入的事实而非不断复制；真实变化需要使过期事实失效时，以正确性优先。（走既有尾部账本与 runtime-tail 回放；同一 run 内不重复，下次 run 从回放里读上次状态。）
- [x] 重启、checkpoint 续接与上下文压缩后，最新有效环境仍可获得，已过期状态不会被恢复成当前状态；复用现有持久化/回放机制，不把每次切换写入长期用户记忆。（上一次状态从 `modelHistory` + `produced` 的 `runtime-context` 记录解析；早期记录保留为历史而非被改写。）
- [x] 多会话、并发 run、切换失败及请求发送失败重试均有定向覆盖：不跨会话串入目录或模型状态，不因“已标记通知”而漏掉模型实际未收到的事实。（**跨会话**：`runtime-context-notice.test.ts` 断言两个并发会话各自渲染自己的目录与模型，互不出现对方的值。**发送失败**：`packages/runner/src/run-context-notice-delivery.test.ts` 走真实 Runner——第一次请求在传输层失败，断言简报确实进了那次请求、但会话转录里**没有** `runtime-context` 记录（失败的 run 不写 produced），于是同一会话的下一次 run 重新投递同一份简报。这条正是"不因已标记通知而漏掉模型实际未收到的事实"的证据。）
- [x] 在 CE-12 中检查真实出站请求及后续行为，不能仅以 UI 已切换或模型口头复述作为验收；通知无需用户再发一句“我刚换了模型/目录”。（**实机证据**：同一会话三次请求——建立简报 → `POST /runtime` 切到 `deepseek-alt/deepseek-v4-pro` → 再发同一句话。第二次请求的 `replyProvenance` 是**新** provider/model（说明路由真的换了，不是 UI 说法），且携带 `runtime-context` 简报项；第三次请求状态未变、**没有**简报项，证明同一有效状态不会被重复宣告。用户全程没有多说一句"我刚换了模型"。）

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

## 实施记录｜2026-09-24 第十二轮（CE-08 预算耗尽的用户重试获得真实有界机会）

### 先看现场：这条到底怎么坏

`- [ ]` CE-08 第二条要求"预算耗尽后用户选择重试，保留累计历史并给出明确有界机会；重启后语义一致"。Runtime 侧的一次性绑定重试（`recover.ts` 的 `isBoundContinuationRetry`）已经存在，所以问题不在"要不要重试"，而在**重试的 run 继承了什么**。

`restoreContinuationContext` 把检查点的 `loopBudget` 整份还原，并把 `modelCallCount` 设为 `checkpoint.loopBudget.attemptsUsed`。于是一个因撞上限而升级的 run 留下的检查点，其 `attemptsUsed` 等于 `maxAttempts`、`toolLoopIterationsUsed` 等于 `maxToolLoopIterations`：用户下一次说"再尝试一次"时，新 run 一进主循环就在**第一次模型请求之前**撞回同一道墙。占位式复现（把本轮改动从 `runner.ts` 暂时移出后跑新用例）：轨迹 `[recover, execute, recover, ask_user]`，副作用为空，"工作"文件不存在，用户在每次重试后拿到的是**同一句**升级提问。

同一份还原还带来两个同源问题：

- `resumeState.lastError` 被还原成"本轮已发生的失败"。`decideRecovery` 会据此分类，于是续跑 run 还没失败就已经被判为预算耗尽；`durable-harness` 的 `!ctx.lastError || ctx.lastError.stage !== stageName` 守卫还会让**同 stage 的新失败**不被记录，真实失败被旧文案顶替。
- 历史投影同时排除了检查点的原始 inbound（`historyExcludeMessageIds: [state.inboundMessageId, ...]`）。等待用户回答的续跑里，本 run 的 inbound 是"用户的回答"，被续跑的原请求于是从模型上下文里消失：模型只看到 Runtime 的提问和"再尝试一次"，看不到自己在重试什么。

### 改动

- `packages/runner/src/run-checkpoint.ts` 新增 `continuationLoopBudget(previous, maxModelCalls)`：续跑继承**任务状态**，但模型调用数、工具循环次数、连续无进展计数与证据指纹归零，`maxAttempts` 取**当前配置**的 `maxModelCallsPerRun`（配置改了就对续跑生效），`maxToolLoopIterations` 保持 Runtime 常量。上限本身没变，所以续跑仍是"一轮有界的工作"，下一次重试依旧由用户决定，不会自转。
- `restoreContinuationContext` 用该函数写入 `loopBudget`、把 `modelCallCount` 置 0、并在一次 `writeFailureState` 里清空 `lastError` 与 `recoveryAttempts`。来源轮的失败与花费不丢：它们作为 `ConversationContinuationEvidence.handoff`（`previousFailure` + `runBudget`）持久化在续接证据里，而不是重新施加到新 run。
- 绑定续跑的历史投影只排除"本 run 自己那一轮 inbound"：等待回答的续跑保留原请求，仅排除已持久化的回答消息；被中断的 run 反过来，排除原消息本身。
- `packages/harness/src/index.ts` 导出 `MAX_TOOL_LOOP_ITERATIONS`，让 Runner 报告的额度与主循环用的是同一个常量。

### 验证

- `packages/runner/src/runner-continuation.test.ts` 新增"检查点已耗尽两组额度、无进展闩已合上、恢复额度已用满、lastError 为上轮预算文案"的样本，走真实 `runner.run` + 检查点控制器 + harness + 工具执行：断言 `status=ok`、轨迹 `[recover, execute, verify, finalize]`、`write` 副作用已结算、产物文件真实写盘、模型请求里同时出现原请求与提问且回答只出现一次、`handoff` 记录了来源轮的 9 次调用/20 次循环与本次按当前配置拿到的额度。该样本在本轮改动前失败（上面那条轨迹），改动后通过。
- `packages/runner/src/run-checkpoint.test.ts` 新增两条 `continuationLoopBudget` 单测：归零哪些字段、保留哪些上限、配置变了取新值、缺省工具循环上限回落到运行时常量。
- 定向：`packages/runner/src` 全量 59 文件 / 372 用例通过；`pnpm run typecheck` 通过（顺带修掉 `packages/app/src/main/runtime-config-change.test.ts` 里 `harness.current()` 的可空类型错误，它在 types 改动触发重建后才被编译到）。

### 剩余限制（不把本条写成"实机验收完成"）

- 本条的端到端证据止于"真实 Runner + 真实检查点 + 真实工具执行、仅 LLM 客户端为脚本替身"。**没有**真实模型证据，原因具体：要逼出"预算耗尽且已发布提问"的真实状态，需要一次真跑撞上模型调用上限或恢复上限，而 `/runtime` 路由不接受 `maxModelCallsPerRun`，只能改隔离数据根的 `config.json` 再重启；且真撞上模型调用上限后，`ask_user` 的措辞调用同样被上限拒绝，run 不会留下 `waiting_user` 检查点（走 CE-11 的可见失败路径），所以这条真实状态本身要靠**恢复额度耗尽**那条升级路径产生。CE-12 的人工/真实窗口验收仍是唯一交付门。
- CE-08 第一条（"再尝试一次 / 继续做吧"端到端绑定原任务、产物、工作区与权限）不因本轮改动打勾：本轮只修了它的前提（重试 run 能看到原请求并真的能干活），绑定判断本身的实机确认仍归 CE-12。

## 实施记录｜2026-09-24 第十一轮（CE-13 发送失败 + 收尾三条验收）

### CE-13 最后一条：没送到就不算送达

简报随追加式尾部在请求发出前持久化，因此存在一条危险路径：如果一次 run 记下了简报、而请求实际没送到 Provider，下一轮会从转录读到它、从而不再告知一个模型从未见过的环境。

核对结论：**不会发生**。`finalize.ts` 的每条失败路径都直接返回，不调用 `sessionManager.append(ctx.produced)`；只有成功收尾才写转录，所以"已渲染但未送达"的记录不会进入下一轮的 `modelHistory`。由 `packages/runner/src/run-context-notice-delivery.test.ts` 用真实 Runner 固定：第一次请求传输失败 → 转录无 `runtime-context` 记录 → 同一会话下一次 run 重新携带简报。跨会话隔离同时用 `runtime-context-notice.test.ts` 的并发两会话用例固定，并把 `RUNTIME_CONTEXT_TAIL_ID` 导出，避免测试硬编码 id。

### 收尾三条验收（都用真实证据结清）

- **CE-03 最后一条**：审计 8 个隔离数据根里的 **21 次真实 run、66 次 `exec`**——首个命令是 `Get-Location; Get-ChildItem | Select-Object Mode,Name` 这类 PowerShell 写法；18 次非零退出里**没有一条**是 shell 语法/解释器错误。报告里"首条命令因缺 shell 信息出错"的现象没有复现。
- **CE-04 同批部分成功**：新增用例固定"保留成功的一半、只重做失败的那条、成功副作用不被重发"。
- **CE-01 显式工具 cwd 与中文路径**：显式 `cwd` 按该调用重新求值（命令真在那个目录跑、边界按它判定、`ctx.cwd` 不变）；中文路径归一化不转写不转义。

### 剩余

`- [ ]` 只剩四条，全部需要人或在真实窗口里做：CE-01 的"历史记忆指向 A 而当前在 B"、CE-02 的项目绑定会话与配置持久化失败显示、CE-08 的两条续接绑定，以及 **CE-12 的人工试玩**（唯一必须由人完成的）。CE-12 的其余场景已在第九、十轮实机通过。

### CE-13：把"发送失败也算送达"这条路堵死

CE-13 只剩"多会话、并发 run、切换失败及请求发送失败重试均有定向覆盖"这一条未打勾。这一轮把它补上，并核实了一个此前只是推断的机制。

### 核实到的机制

简报随**追加式尾部**在请求发出前持久化（这是回放能读到"上次观察到的状态"的原因）。危险路径是：如果一次 run 记下了简报、而请求实际没送到 Provider，下一次 run 会从转录里读到它、从而**不再告知**一个模型从未见过的环境。

核对结论（代码 + 新用例）：**不会发生**。`finalize.ts` 的每条失败路径（`runtimeFailure`）都直接返回，**不调用** `sessionManager.append(ctx.produced)`——只有成功收尾才把 produced 写进会话。下一次 run 的 `modelHistory` 来自会话转录，因此读不到那份"已渲染但未送达"的简报，于是会重新渲染并投递。

### 新增覆盖

- `packages/runner/src/run-context-notice-delivery.test.ts`（真实 Runner）：第一次请求在传输层抛错 → 断言简报确实出现在那次请求里、而转录中**没有** `runtime-context` 记录 → 同一会话的下一次 run 再次携带简报。
- `runtime-context-notice.test.ts`：两个并发会话各自按自己的目录与模型渲染，互不出现对方的值（跨会话不串状态）。
- `RUNTIME_CONTEXT_TAIL_ID` 从 `@littlesheep/harness` 导出，测试用它的**真实** id 而不是硬编码字符串，避免 id 改名后测试静默失效。

### CE-13 现在的状态

除"工作区 A→B 后旧 A 明确属于历史"这一句措辞（属模型表达，归 CE-12 人工判断）外，CE-13 的验收条目已全部有证据：真实出站请求、变更与不重复、权限与工具变化、回放与重启、跨会话与发送失败。CE-12 仍是唯一未关闭的门（人工试玩）。

## 实施记录｜2026-09-24 第十轮（迭代预算耗尽仍要交付 + 全场景实机通过）

### 改动：预算耗尽不再连答案一起丢掉

第七轮修掉了"预算耗尽后重试同一个 run"的空转，但用户拿到的仍然是一句"预算耗尽，你想怎么办"——即使产物已经写到磁盘。真实运行（21–23 次工具调用、产物已落盘）就是这样收场的，而这正是任务书开头要解决的那类请求。

**改动**（`stages/execute/tool-loop.ts`）：迭代预算耗尽时，如果本轮已经有工具结果，允许**恰好一次**收尾请求（复用既有的"强制收尾"机制：目录与 `auto` 保留、被忽略的工具调用由本地拒绝），让模型说出已完成、已验证与仍缺什么；第二次越界仍按原样判失败，所以预算依旧封顶。没有可报告的工作（例如续跑进来时预算就已用尽）仍立刻失败，不发多余请求——这条由既有用例继续守着。

**验证**：新增两条定向用例（第十九轮留下一次迭代、第二十轮命中上限 → 只多发一次请求且不跑工具、`ok:true` 并产出模型自己的回答；预算在入口就已耗尽且无结果 → 仍 `ok:false` 且 0 次模型调用）。**诚实说明**：这一轮的实机运行并没有自己撞到上限（13 次请求），所以"实机证明该分支"这一步没有发生；该分支目前由用例固定，实机证据是前几轮那些撞到上限的运行。

### 全场景实机通过（首次）

`pnpm.cmd run verify:conversation-execution-reliability`（`sourceRevision 424151a` 之后的工作树、真实 Electron 窗口、隔离数据根、真实 DeepSeek）**9 个场景全部通过，`ok: true`**：

| 场景 | 结果 |
|---|---|
| 含空格外部工作区的"做一个小游戏吧" | `ok`，68.9 s，13 请求／13 工具，`star-catcher.html` 18,436 B，`unverified` |
| 同会话"继续做吧" | `ok`，96.9 s，11 请求／7 工具，另交付一件产物 |
| 独立新会话重跑同一请求 | `ok`，26.9 s，7 请求／7 工具，1 件产物 |
| 研究模式批准写入 / 拒绝写入 | `ok`／批准 1 次后落盘；拒绝 1 次后无文件且不谎报 |
| 完全访问下的核心源码目录 | `core_source_read_only`，目标不存在，回复 408 字 |
| 模型切换简报（A→B→A） | 首个请求带简报、切换后由新 provider 作答且带简报、状态未变时不重复 |
| 保存默认工作区后不指定目录 | 交付在新目录、旧目录无同名文件、`resourceKeys` 指向新工作区 |

三个交付场景这次都**没有**以提问收场，验证记录都是 `unverified`（已交付、判据需人工），符合契约。

### 仍未完成

- **人工试玩**：八份真实产物已收集到 `.codex_tmp/ce12-games/`（4 份 breakout、4 份 snake），机械校验全过（单文件、可解析、无外部脚本、含 canvas/循环/键盘/计分/重开）。"好不好玩、手感如何"仍需人来看。
- 受限模式实机批准、项目绑定会话的目录归属、显式切换会话目录、以及"预算耗尽"分支的实机复现。

## 实施记录｜2026-09-24 第九轮（CE-08 空转修复 + 工作区切换实机场景）

### 真实运行暴露的缺陷：预算耗尽后仍在重试同一个 run

CE-12 的验收断言"交付场景必须交付、不能以提问收场"之后，真实运行立刻把它抓了出来。两次"做一个小游戏吧"的实机运行（`sourceRevision 410d109`）都出现同一条链路：

```
enter > classify > execute > recover > execute > recover > execute > recover > execute > recover > ask_user > finalize
```

即 **execute 被整整重跑了 4 次**，每次都是同一个原因：`tool loop exceeded the persisted 20-iteration run budget`。这个上限是**记录在 run 上的**，重试同一轮不可能改变它，于是 4 轮 execute（各自消耗模型调用）全部注定失败，最后才落到同一个升级。这正是本专项要消除的"反复空转"。

**修复**（`recover/policy.ts`）：新增 `isExhaustedBudgetFailure()`，只匹配 Runtime 自己写下的预算文案（`tool loop exceeded…run budget`、`model call budget exhausted` 等）。命中时**第一次就升级**，`reasonCode = execution_budget_exhausted`，不再把预算浪费在注定失败的重试上；临时的 Provider 故障（`llm call failed: 502`）文案不同，仍然保留原来的重试。升级文案也改成说明"预算是本次运行的，重试同一个 run 不会有进展"。

用例：`recover.test.ts` 新增两条——预算耗尽第一次就升级（断言 0 次模型请求、原因类别为恢复预算耗尽、所需动作点名预算），以及形似模型错误的临时故障仍然重试。

### 工作区切换实机场景（CE-01/CE-02）

新增场景：`POST /runtime {workspace: <新的含空格目录>}` 保存默认工作区后，**请求里不指定任何目录**再发一次，断言：产物落在新目录、旧默认目录里没有同名文件、`write` 的 `resourceKeys` 解析到新工作区（证明工具 cwd 也跟着换了，不只是配置变了）。模型切换场景同时补上"切回去"的反向验证（A→B→A）。

### 关于"重复请求被追问"的一次澄清

同一轮里有一次独立重跑以提问收场。查证后确认**不是产品缺陷**：那条场景复用了已有产物的目录，"再做一个游戏"与"目录里已有游戏"构成真实歧义（覆盖还是新建），模型按契约提问是正确行为。**是我的场景设计有问题**——独立重跑本就该用干净目录，已改为 `repeat work space`，并在断言里禁止交付场景以提问收场。记录在此以免下次误判。

## 实施记录｜2026-09-24 第八轮（CE-13 实机出站请求核验）

CE-13 的最后一条要求"在 CE-12 中检查真实出站请求及后续行为，不能仅以 UI 已切换或模型口头复述作为验收"。这一轮把它做成可重复的场景。

### 场景与结果

验收脚本的隔离配置里现在有两个 provider（同一 endpoint、不同 id 与模型）：`deepseek/deepseek-v4-flash` 与 `deepseek-alt/deepseek-v4-pro`。同一个会话连发三次同一句"只回复 OK，不要调用工具"：

| 步骤 | 断言 | 实测 |
|---|---|---|
| ① 会话首个请求 | 携带建立简报 | `runtime-context` 项在场 |
| ② `POST /runtime {model: deepseek-alt/deepseek-v4-pro}` | 配置被接受 | 返回的 runtime payload 已是新 ref |
| ③ 同会话再发同一句 | 由**新** provider/model 作答，且携带变更简报 | `replyProvenance.provider=deepseek-alt`、`model=deepseek-v4-pro`，简报在场 |
| ④ 同会话第三次 | 状态未变 → **不得**再宣告 | 无简报项 |

一次完整运行为 `ok: true`，7 个场景全部通过（`sourceRevision 7708c29`、真实 Electron 窗口、隔离数据根、真实 DeepSeek）。同轮还复测了研究模式批准/拒绝、受保护核心目录拒绝等场景，结果与上一轮一致（批准后文件落盘；拒绝后文件不存在且不谎报；核心目录 `core_source_read_only`、目标不存在）。

**这一轮为什么有意义**：第③步证明的是**实际路由**换了（`replyProvenance` 来自 Provider 响应的真实记录），而不是界面参数变了；第④步证明的是真实请求里**没有**重复宣告。两者都不是模型的口头复述，也不是 UI 状态。

### 仍未完成

- **人工试玩**（CE-12 唯一必须由人完成的一项）。
- 受限模式实机批准、工作区切换（A→B 而非模型切换）、权限/网络切换的实机简报、项目绑定目录、受保护根以外的中断/重启续接。

## 实施记录｜2026-09-23 第七轮（CE-12 权限与核心目录实机场景）

这一轮把 CE-12 剩下两个**可机器验证**的场景补进验收脚本，并把上一轮记下的两条限制改成实测结论。

### 新增场景与结果

`scripts/verify-conversation-execution-reliability.mjs` 的客户端现在会应答 `approval_request`（同意/拒绝），并新增三条场景。一次完整运行（`sourceRevision 5490be3`、`deepseek/deepseek-v4-flash`、真实 Electron 窗口、隔离数据根）的结果：

| 场景 | 结果 | 关键证据 |
|---|---|---|
| 研究模式 + 容器内工作区，批准写入 | `ok`，2.7 s | 1 次批准请求并被同意（`granted=1`），文件确实落盘 |
| 研究模式 + 同一工作区，拒绝写入 | `ok`，3.0 s | 1 次批准请求并被拒绝（`denied=1`），`write` 状态 `approval_denied`，文件不存在，回复 179 字且没有谎称创建成功 |
| 完全访问 + 工作区指向 LS 核心源码根 | `ok`，2.9 s | `write` 的 `errorKind=core_source_read_only`，目标文件不存在，回复 626 字（中文，含可用去向） |

同一次运行的前三条常规场景（含空格工作区、同会话续接、独立重跑）依旧全部 `ok`，产出 `sheep-run.html` 21,348 B 与一件 11,484 B 产物；其中一次断流（1969 帧）后仍由持久日志恢复出成功终态。

### 这一轮改写的结论

- **CE-12「三档权限的拒绝和同意路径」**：从"只在自动化矩阵里覆盖"升级为**真实窗口里同意与拒绝都实测**。受限模式（逐次批准）仍未在真实窗口走过，已注明。
- **CE-05 最后一条**（核心目录不可写、提出可用去向）：从"只有拒绝文案"升级为**完全访问下的实机拒绝 + 模型中文说明**。
- **CE-04 最后一条**（先失败后纠正仍记为 `unverified`）：用 6 次运行里 4 次 `observation_missing` 写入失败全部在同 run 纠正、而验证记录仍是 `unverified` 的实机事实结清。

### 仍未完成（CE-12 不能关闭）

- **人工试玩**没有做，这是唯一真正需要人的一项。
- 受限模式实机批准、项目绑定目录、切换目录不重启、模型/Provider 与权限切换的变更简报、受保护根以外的中断/重启续接，仍未在真实窗口执行。

## 实施记录｜2026-09-23 第六轮（CE-12 真实模型 + 真实窗口验收）

### CE-12 实机验收记录

**运行方式**：新增 `scripts/verify-conversation-execution-reliability.mjs`（`pnpm.cmd run verify:conversation-execution-reliability`）。它按仓库既有做法复制真实凭据、tokenizer 与 Chromium `Local State` 到**隔离数据根**，启动**真实 Electron 窗口**，经 Local App API 发起真实 DeepSeek 请求，绝不触碰用户自己的数据根与工作区。运行环境：`sourceRevision 8114fa6`、`electronVersion 36.9.5`、`deepseek/deepseek-v4-flash`、权限 `full`、工作区为**含空格且位于数据根之外**的目录。

**两轮完整验收的结果（每轮都含一次独立重跑）**：

| 场景 | 结果 | 请求/工具 | 产物 | 验证记录 |
|---|---|---|---|---|
| 正常（含空格的外部工作区） | `ok`，49.2 s | 19 / 19 | `snake.html` 11,953 B ＋ `tests/snake.test.js` 4,036 B | `unverified` |
| 自然语言续接（同一会话，`继续做吧`） | `ok`，67.0 s | 21 / 21 | `snake2.html` 21,066 B ＋ 其测试 | —— |
| 独立重跑（新会话，同一请求） | `ok`，25.1 s | 6 / 4 | `game/index.html` 15,652 B | `fail`（一次 `read` 输入校验失败） |

另一轮（`run8`，同样的三场景）得到 `guess-number.html` 8,771 B、`snake.html` 12,223 B，全部 `ok`。两次运行的自然语言回复均为**中文**（587–735 字符）。

**本轮各任务的实机证据**：

- **CE-01/CE-03**：三次执行都在**含空格**的目录里完成写入与命令执行，路径引用未被空格破坏；模型全程使用 PowerShell 语法的 `exec` 调用（如 `cd '<路径>'; node test.js`）。
- **CE-04（真实样本）**：正常场景 6 次写入中 1 次 `observation_missing` 失败、续接场景 8 次中 2 次失败，**均在同一 run 内自行读出文件后改写成功**（`correctedInRun: true`），没有用户再说"继续"。
- **CE-06（真实样本）**：一轮运行里模型重复同一条 `exec` 被拒为 `side_effect_replay`，紧接着改用不同输入的命令完成同一目的——正是修复后的期望行为。
- **CE-06/CE-10 之外的额外发现（断流）**：6 次运行中有 4 次的 SSE 观察流在中途被服务端断开（770/985/1391/1925 帧），而 **run 本身继续并成功结算**（执行日志完整、产物落盘）。客户端因此必须能从持久记录恢复结论；验收脚本据此改为在断流后轮询 `GET /runs/:id` 换成持久日志，并在报告里区分"流被断"与"run 失败"。这是真实运行才会暴露的脆弱点，**尚未定位服务端成因**（`http.ts` 的 512 KiB 待写缓冲守卫是当前唯一已知能主动 `res.destroy()` 的路径，但未证明就是它），列为剩余问题。
- **CE-13**：每个场景都断言了首个真实请求里存在 `runtime-context` 简报项，否则验收失败。
- **CE-09**：终态全部可读——3 个场景的 `status`、`runId`、验证记录都能从持久日志重建（两条 run 正是靠这条路恢复的）。
- **CE-10（行为面）**：中文请求得到中文过程与交付；正常场景**没有**先追问游戏类型就直接开工并交付。

**没有做的（不得据此认为 CE-12 关闭）**：

- **人工试玩**没有进行。机械校验只证明产物可解析、无外部依赖、含 canvas/游戏循环/键盘输入/计分/重开信号；"玩起来如何"没人验证。
- 权限只走了 `full`：研究/受限模式的批准对话框未在真实窗口里走过（自动化矩阵已覆盖判定）。
- 项目绑定目录、切换目录后不重启、模型/Provider 切换、权限切换、受保护核心目录、预算耗尽续接、中途重启再续接这些场景**未在本轮实机执行**；它们的自动化证据分别在 CE-01/02/05/08 的记录里。
- 缓存只跑了仓库既有验收（`met`），未在两轮小游戏上做同目录复用/跨 run 回放的专项读数。

## 实施记录｜2026-09-23 第五轮（CE-10 合同侧）

### 核查与改动

**核实过程说明的真实来源**：用户能读到的过程叙述与最终交付由**主循环**授权（`publishUserFacingReply(ctx, 'execute_tool_loop', ...)`），只有能力回复与澄清走 `reply`/`ask_user`。语言与声音边界因此必须同时覆盖两条路径：

| 路径 | 语言规则 | SOUL | 声音边界声明 |
|---|---|---|---|
| 主循环 execute | `# Assistant Output Directives`（用户的语言，默认中文，术语保留英文；代码/路径/命令内联） | bootstrap 的 Project Context 注入 SOUL.md | 无独立声明（该契约本身即面向回答） |
| reply / ask_user | `buildUserFacingVoiceAddon` 的同一规则 | 同一 bootstrap + 声音 addon | 有（明确"措辞归模型、事实归 Runtime"） |

`stages/execute/prompt.test.ts` 新增用例断言主循环的提示里同时出现语言规则与运行时 SOUL 正文，并保留"代码、路径、命令内联"这条不翻译事实的约束。

**补上的合同缺口**：`# Assistant Output Directives` 原先只有"先消解省略与指代、再决定是否追问"，没有"目标清晰、细节有明显默认值就不要先问"这条——而**会话**契约（`responseDirectivesSection`）一直有等价规则（"Prefer a best-effort answer that states its assumption; ask one focused question only when a missing fact truly blocks…"）。这正是"做一个小游戏吧"落在执行路径上却先被追问的结构原因。新增一条：清晰、低风险、有明显默认值的目标 → 选合理默认、一句话说明选择、直接开工；只有缺关键事实、目标冲突、不可逆动作或缺权限时才提问，且一次只问该问题。安全契约未放宽（"不确定后果时先问用户"仍在）。

### 验证命令与结果

- `pnpm.cmd exec vitest run packages/prompt packages/harness/src/stages/execute` → 全绿；`packages/prompt/src/builder.test.ts` 断言新规则在场，`stages/execute/prompt.test.ts` 5 条含语言+SOUL 用例。
- 新规则位于**边界以下的** `output-directives` 段（volatile），不改变跨模式共享前缀，因此不触发缓存基线回退。
- `pnpm.cmd run typecheck` → exit 0。

### 本次未做

- 中文样本的实际措辞、"不再先问游戏类型"的行为结果都属 CE-12 真实模型验收，本轮只把合同补齐并核实来源，**不预先判定模型是否照做**。
- "必需澄清发出后，同轮内仍可继续独立安全工作"未实现也未改变：当前架构里模型一旦发起 `request_user_input` 就结束本轮。

### 顺带修好的验证环境（不属本清单任务，但影响后续验收）

全量测试此前长期有 1 项失败（`scripts/verify-web-live-llm-evidence.test.mjs`），根因是第二执行体系删除后留下的两处过期引用：`scripts/verify-web-live-llm-evidence.mjs` 与 `scripts/verify-web-llm-evidence.mjs` 仍在 import 已删除的 `packages/harness/dist/stages/execute/final-reply.js`，因此在 import 阶段就崩溃，连"无密钥时报告 skipped"这条契约都到不了；本机 `packages/harness/dist/` 里还留着 2026-09-21 的过期产物（`compact-explicit-tool-decision.js`、`compact-autonomous-read-task.js` 等，对应源码均已删除）。

处理：把两处 import 改成**惰性**并在缺失时抛出准确原因（不再以模块解析崩溃收场），并重建 `packages/harness/dist`（删除 `dist/` 与 `tsconfig.tsbuildinfo` 后由 `ensure:workspace-build` 重新生成），使构建产物与源码一致。**仍未做**：这两个脚本的 `llm-final-reply` 阶段需要一个新的实现（驱动主循环，或有界直接调用 + citation 契约）才能在**有密钥**时真正跑通；本轮只让它们在无密钥时按契约 skip、在有密钥时给出准确失败原因，没有假装该路径可用。修复后全量 `pnpm.cmd exec vitest run` → **494 文件 / 3536 项通过，2 跳过，0 失败**。

## 实施记录｜2026-09-23 第四轮（CE-09）

### CE-09 核查记录

**环境与覆盖范围（先说边界）**：本轮只做源码核对与自动化回归，**没有** Electron 实机窗口、没有真实模型、没有读取任何历史会话或执行日志（它们在数据根，不在仓库）。因此下面区分"源码可以证明"和"只有实机能证"。

**原 P8（空回复）：从源码不可复现，按回归保护关闭，不声称找到历史根因。** 现在每一条终态路径都有明确出口：

| 失败形态 | 用户可见结果 | 依据 |
|---|---|---|
| 模型请求失败 / 工具边界失败 | 回合 `failed`，`error` = Runtime 原因；输入与附件还给输入栏 | `run-actions.ts` catch 分支 + `finally` 复位 `loading` |
| 无合法 LLM 正文 | 正文为空，只有 Runtime 错误行 | `run-result-reducer.ts` 非 `ok` 时 `text: ''`；`reply.ts` 两次空输出即失败关闭 |
| 断流（SSE 结束但没有 result） | 抛错 → 同上 `failed` | `consumeRunStream` 末尾 `stream ended without result` |
| 服务端 `error` 帧 | `RunStreamServerError` → 同上 `failed` | `consumeRunStream` 的 error 分支 |
| `ok` 却没有已结算终稿 | 就地改成 `status: 'error'` + 明确原因 | `consumeRunStream` 的 settlement 校验 |
| 终态持久化异常 | Runner 返回 `runtimeStatus.status === 'failed'` 与具体 reason | `authoritative-reply.ts` / `run-failure-result.ts`，runner 用例已覆盖 |
| 刷新或重开会话 | 从持久化消息 + 执行日志重建同一状态；没有 assistant 消息的 run 也有一行状态 | `shared/history-activity.ts` 的 `buildHistoryMessages` + `history-activity.test.ts` |

没有任何一条会以"空 assistant 消息且界面无状态"结束——这正是原报告描述的现象，所以它**不可从当前源码复现**。**只有在真实窗口里才能排掉的残余风险**（本轮未测）：React 渲染层异常、SSE 心跳期间的界面卡顿、以及"用户看到的状态行是否足够醒目"。这些属于 CE-12。

**旧 TaskBook step 的工具拒绝能否发生**：不能。`task-execution` 的步骤执行器已随第二执行体系删除，当前只有单一主循环；旧检查点的 `taskBook`/`taskExecution` 是只读历史。但核查中发现**代码与自己写下的规则相反**：`runtimeExecutionEvidenceGap` 的两条步骤分支的注释写着"步骤证据只对本次 run 实际执行过的计划成立"，实现却对任何存在的 `taskBook`/`taskExecution` 生效。后果是旧检查点续跑时，继承来的计划被当成缺口，run 被打回 `execute` 去重规划一个没有执行器能跑的步骤集，直到重规划预算耗尽再升级成用户决策——属于本专项要消除的反复空转，而且先失败后通过的用例证明它确实会触发。

**修复**：两条步骤分支加上 `ctx.resumedFromCheckpointId === undefined` 前提（恢复的计划是只读历史），没有引入任何步骤执行器，也没有放宽其他缺口判定。三条用例先在修复前失败（`expected 'failed or missing task step evidence' to be undefined` / `expected 'task execution status is failed' to be undefined`），修复后 16 条全过；"计划属于本 run" 的那条仍照旧报缺口。

**修复在真实续跑用例上的可见结果**：`runner-continuation.test.ts` 的"预算耗尽后授予完全访问并重试"样本原先把请求数固定为 3 并断言 `status: ok` —— 那第 3 次请求其实是 `ask_user` 的措辞调用：VERIFY 把**继承的计划**判成缺口、交给 RECOVER，而已耗尽的预算立刻把它升级成一句"你希望我接下来如何处理？"。也就是说：用户刚回答过、工作也已经做完，run 却又问了一遍。修复后同一样本变成 2 次请求、轨迹 `[recover, execute, verify, finalize]`、交付模型自己写的回答。这条断言是按新事实**加强**（新增轨迹与回答断言），不是把失败改成通过。

**剩余未知**：原 P8 的空回复到底发生在哪一层（Runner 未落盘、事件流未送达、还是渲染层丢弃）无法回溯；本轮只能说明当前代码不存在这条路径。

### 验证命令与结果

- `pnpm.cmd exec vitest run packages/harness packages/app packages/runner packages/tools packages/llm packages/prompt` → **354 文件 / 2237 项通过，1 跳过，0 失败**。
- 新增/扩展用例：`packages/app/src/renderer/chat/run-actions.test.ts` 三条终态失败形态；`run-result-reducer.test.ts` 一条预览撤回；`packages/harness/src/stages/verify/evidence-gap.test.ts` 三条计划证据前提；`packages/runner/src/runner-continuation.test.ts` 把预算耗尽重试样本从"3 次请求"改为按新事实断言（2 次请求 + 轨迹 + 交付回答）。
- `pnpm.cmd run typecheck` → exit 0；`pnpm.cmd run check:repo` → ok。

### 本次未做

- 仍未做真实模型调用与 Electron 实机；CE-12 全部场景未执行，CE-09 的界面醒目度与渲染层异常不在本轮结论内。
- CE-10 未开始。

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
- CE-09、CE-10 未开始。
- CE-11 只补用例：畸形/截断标记的流式回归（四种形态）与文档示例惰性各一条，解析器与扫描器代码未动。与 CE-09 的界面衔接待 CE-09 完成后联验。

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
