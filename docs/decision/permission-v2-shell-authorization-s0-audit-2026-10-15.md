# Permission V2-S Shell 授权契约：S0 审计与实施边界

**状态：S0 源码审计、S1 Main 统一审批、S3 旧权限数据破坏性退役和 S2 精确命令重复授权均已实施。** S2 已单独修订 P3 决策并完成专项测试；用户于 2026-10-15 明确要求移除所有授权查看、列表和手动撤销入口，因此本文的早期“必须提供撤销入口”审计建议由更新后的 P3 决策取代。P3 OS Shell 沙箱生产集成继续冻结。

## 审计结论

Permission V2 的常规 Agent 执行链已经通过 Main 创建的权限快照和逐次 Shell 审批工作；`workspace-write` 当前不会让 Shell 自动执行。S1 的有限批次审批可以保持同一安全政策，但必须把用户明确看到并确认的每条命令绑定到自己的 invocation，并在启动进程前核对实际执行描述。

审计发现一个需要先处理的旧授权入口：`exec` 内置工具仍使用 `approval.ts` 的命令前缀白名单和 `approvalMode`。正常 Runner 路径会先经过 `ToolExecutionService`，所以这套白名单不能替代该路径上的 V2 Main 审批；然而导出的 `createExecTool().execute()` 在没有运行时权限快照的情况下，可以让前缀白名单替它放行。现有测试直接以不含权限快照和审批回调的 `baseCtx` 运行白名单 `echo`，证明这不是纯粹未接线的遗留代码。追加命令是否会越过白名单的具体安全后果由 `startsWith` 匹配逻辑推导；目前没有相应的恶意后缀回归测试。

此外，危险命令 blacklist 在 `exec` 中发生于 `authorizeToolAccess()` 之后。V2 Shell 会先触发 Main 审批，再由内置工具拒绝 blacklist 命令；虽然进程不会启动，但用户仍会看到一个本应被硬拒绝的审批请求。这不符合“硬拒绝优先于审批”的契约顺序。

## 当前执行与审批路径

1. Main 的 run route 解析会话、工作区、`runId`，再调用 `resolveRunPolicy()`；V2 快照从 Main 解析的数据根、工作区根、受保护根及实际可用能力构建。当前快照把 `shellIsolation` 固定为 `unavailable`，因此不能据此自动执行 Shell。
2. Harness 将模型返回的工具调用交给 `ToolExecutionService.executeBatch()`。该服务逐条校验 schema、计算权限决定、等待批准、记录 invocation，再调度执行；审批回调由队列串行化。一个模型响应里若有多条 Shell 调用，当前会逐条请求用户决定，并非一个预先冻结的批次清单。
3. `resolvePermissionDecision()` 保留 `allow / approval / deny / unavailable` 四种决定，先处理硬拒绝、不可用和强制审批，再看所选权限。`workspace-write` 的 Shell 在隔离能力不可用时进入审批。
4. Main 的 `createPermissionApprover()` 再基于本次 action/detail 和当前 run 快照检查权限，然后交给该 run 的审批 broker。broker 生成随机 ID，等待 Renderer 的布尔决定；等待最多 120 秒，run 取消、服务关闭或审批传输异常均以拒绝结算，ID 结算后不能再次使用。
5. Renderer 对 V2 Agent `exec` 禁止会话级复用，只提供“拒绝”与“仅本次”。Main 强制审批也不能通过 Renderer 的会话 grant 复用。一般旧模式仍保留按会话、来源和 action 复用的既有行为。
6. `exec` builtin 在进程启动前再次调用 `authorizeToolAccess()`，随后执行旧 `checkApproval()`，再用平台 Shell 启动进程。ToolExecutionService 为获批 builtin 提供 invocation-scoped callback，因此这次防御性复核不会再次弹出同一审批；它不是第二份可复用授权。

入口与主要证据：[run route](../../packages/app/src/main/local-app-api/run-routes.ts#L213)、[Main 权限策略与快照](../../packages/app/src/main/run-policy.ts#L71)、[Main 决策与 broker 请求](../../packages/app/src/main/run-policy.ts#L116)、[ToolExecutionService 批次入口](../../packages/tools/src/tool-execution-service.ts#L157)、[ToolExecutionService 审批](../../packages/tools/src/tool-execution-service.ts#L336)、[exec builtin 与进程启动](../../packages/tools/src/builtin/exec.ts#L70)、[Renderer grant 范围](../../packages/app/src/renderer/approval-grants.ts#L16)、[Renderer 审批控制器](../../packages/app/src/renderer/approval/use-approval-controller.ts#L42)。

## 已证实事实与边界

| 项目 | 当前源码事实 | 对契约的影响 |
|---|---|---|
| V2 Shell 决策 | V2 快照把 Shell 隔离能力标为不可用；`workspace-write` 对 Shell 请求审批。对应 Main 策略及工具服务测试已有覆盖。 | 批次只能把已知 invocation 的明确用户决定合并呈现，不能扩展为未知未来命令的放行。 |
| 四态决策 | 安全策略区分允许、审批、拒绝、不可用；硬拒绝和不可用不会被普通模式转换成允许。 | S1 继续使用这组类型语义，Renderer 的确认结果不能覆盖 Main 硬拒绝或强制策略。 |
| 双层检查 | 工具服务先对调用作出决定；builtin 又调用共享权限 helper。Service 对同一已批准 builtin invocation 提供局部回调，避免重复弹窗。 | S1 应复用现有 Main/ToolExecutionService 路径，不增加第二套 Shell executor 或用户批准缓存。 |
| 前缀白名单 | `checkApproval()` 使用 `trim + lowercase + startsWith`；默认名单包含 `git status`、`git diff`、`echo` 等。`exec` 实际调用它，配置也允许修改 whitelist、blacklist 与 `auto-approve`。 | 它不能作为精确授权规则。普通 Runner 上游审批仍是必要门；所有 direct/builtin 入口也必须 fail closed，不能靠这套旧规则补 Main 缺失。 |
| 硬拒绝时序 | `exec` 先做 `authorizeToolAccess()`，之后才执行 blacklist；例如默认 blacklist 命中时，Main 可能已经询问用户。 | 黑名单或其它已审查的硬拒绝必须移到 Main 可先判定的共享硬策略，或在 UI 之前由 Main 统一拒绝；审批不能改变其结果。 |
| 单次等待 | Main broker 为单条 callback 建立随机 ID 和 promise；结算、超时、取消、关闭都会清理；pending 审批只存在当前进程内。 | 适合作为 L0 生命周期基础，但目前没有带多条 immutable invocation 的批次请求/结算 API。 |
| 批次能力 | `executeBatch()` 接收多个工具调用，但其循环中每个调用各自等待 `approve()`；审批队列只负责串行弹窗。 | 当前“批次”是工具调度批次，不是用户已确认的固定命令清单。不能将其描述成已经实现 L1。 |
| 命令与进程参数 | `ExecInput` 有 command、cwd、timeout；运行时再解析 cwd。Windows 使用 `powershell.exe -NoProfile -Command`，POSIX 使用 `/bin/sh -c`。`spawn()` 未传固定 `env`，因此继承宿主进程环境；Windows Shell 标识不是绝对路径。 | 单次审批绑定仍依赖调用输入保持一致；精确复用前还需定义实际解释器身份、有效环境、最终 cwd 和 timeout 的 Main 侧描述与启动前复核。 |
| 会话与运行身份 | invocation 记录含 run/session ID；Main pending map 的随机 ID 由每次 run 的闭包持有，但当前 `RunApprovalRequest`/Renderer 请求体不显式包含 `sessionId`、`runId` 或独立 invocation ID。 | L1 的展示、取消、切换会话、部分拒绝与审计记录需要显式的 batch/run/session/invocation 关联。不能依靠当前选中的 Renderer 会话补造身份。 |
| 恢复与缓存 | Renderer 会话 grant 是内存态；checkpoint 记录权限模式而不含审批 grant。恢复路由会受 checkpoint 原权限上限及当前会话权限限制。 | 当前没有可跨 checkpoint 恢复的精确授权。S2 若获批准，应只存在 Main 当前进程内并在重启时失效，不能从 checkpoint 或模型上下文还原。 |
| 风险披露 | 当前审批风险说明已明确 Agent Shell 以当前宿主用户运行、没有 OS 级 Shell 沙箱，并可能访问宿主可访问文件、联网或启动子进程；详情区域显示调用参数。 | S1 保留并延续这些说明，同时明确展示实际 Shell 类型、工作目录、工作区、完整命令和本次/批次授权范围。 |

## 审计发现及处置优先级

### A1：无 Main 策略上下文时，内置 exec 仍能通过前缀白名单执行

`authorizeToolAccess()` 在没有 Runtime 权限上下文时，只有 descriptor 自身标为强制审批才要求审批；`exec` 的一般 opaque/dynamic 命令 descriptor 默认不会由此自动变成硬审批。随后 builtin 调用前缀 `checkApproval()`。`exec.test.ts` 的 `baseCtx` 只有 session/run/cwd，既没有权限快照也没有 `approve`，但白名单 `echo` 仍成功执行。因为 `createExecTool()` 和默认 `execTool` 都从 tools 包导出，这条路径不是 Main 审批 broker。

这是 S1 前必须关闭的权限入口。候选修复方向是：Shell 只能通过 ToolExecutionService 持有的 Main invocation authorization 进入启动阶段；缺失 Main 决策时返回 `unavailable/deny`。旧配置中的 whitelist/auto-approve 不能继续提供有效授权。本文只记录审计结果，不修改生产代码。

证据：[无策略时的 authorize fallback](../../packages/safety/src/permission-boundary.ts#L315)、[前缀匹配](../../packages/tools/src/approval.ts#L25)、[builtin 执行路径](../../packages/tools/src/builtin/exec.ts#L112)、[公开导出](../../packages/tools/src/index.ts#L64)、[无策略 baseCtx 与成功执行测试](../../packages/tools/src/builtin/exec.test.ts#L15)。

### A2：黑名单在 Main 审批之后才拒绝

执行顺序是先 Main/共享权限审批，批准后 builtin 才检查 blacklist。该顺序不会执行被 blacklist 拒绝的命令，但会产生可避免的审批打断，也让“硬拒绝不可被用户授权覆盖”的事实没有在审批 UI 前表达清楚。下一阶段应将已验证的硬拒绝规则整理为 Main 优先判定，保留拒绝覆盖顺序，并补充集成测试证明 UI broker 未被调用、进程未启动。

证据：[exec 授权与 blacklist 顺序](../../packages/tools/src/builtin/exec.ts#L112)、[blacklist 与普通审批共用的旧决策器](../../packages/tools/src/approval.ts#L43)、[四态优先级](../../packages/safety/src/permission-boundary.ts#L196)。

### A3：当前 approval payload 不足以支持精确复用或批次审计

当前 L0 请求由 Main callback 闭包和随机 ID 临时关联，适用于一次等待；但待审批数据没有显式 run/session/invocation 身份，也没有把 Main 当时展示的命令描述与即将交给 `spawn()` 的完整执行事实组成不可变对象。当前执行时 Shell 名称、参数、解析后的 cwd、继承环境和有效 timeout 分别从执行代码与进程状态得出。

S1 应先为每条调用生成 Main 校验的版本化描述：原始 command 字符串、实际 Shell 身份与参数、规范化 cwd 及目录身份、可信 workspace 身份、session/run/invocation、权限快照版本、受控环境的无密钥指纹、有效 timeout、来源。比较 command 时保持原文严格匹配；摘要只用于索引，Main 仍须比较完整描述并在进程启动前复核。批准后不允许 Renderer、Agent 或其它调用层替换任一字段。Shell 仍以宿主用户执行，不得把上述描述包装成隔离证明。

证据：[exec 输入和 Shell 常量](../../packages/tools/src/builtin/exec.ts#L19)、[实际 spawn 参数](../../packages/tools/src/builtin/exec.ts#L147)、[Main approval 请求类型](../../packages/app/src/main/run-policy.ts#L25)、[pending 结算与超时](../../packages/app/src/main/local-app-api/run-routes.ts#L454)。

## S1 建议契约：只合并交互，不复用授权

### S0 复核补充：批准回调的输入绑定与重复执行控制

当前 `ToolExecutionService.invokeTool()` 的局部批准回调使用 `approvalGranted && action === toolName && (registration.source === 'builtin' || hashToolInput(detail) === hashToolInput(input))`。因此 builtin 分支只验证工具名称，不比较批准前后的 detail；这用于兼容 builtin 重新解析参数后进行的防御性检查，但不能作为“同一完整执行描述”的证明。它也不能单独证明当前 Agent 能替换可信 builtin 的局部参数；这里记录的是静态约束缺口，不是已复现的正常 Runner 命令替换漏洞。S1 必须以 Main 核验的执行描述绑定最终启动事实，不能直接把这个 callback 扩展为批次凭据。验收应增加同名但不同 command/cwd 的二次请求，证明旧批准不能被消费。

证据：[builtin 局部批准条件](../../packages/tools/src/tool-execution-service.ts#L633)。

此外，`exec` 当前工具说明声明相同成功调用会被当作 replay 拒绝。S2 的授权匹配与执行账本的重复副作用控制是两个独立决定：精确授权不能据此绕过账本拒绝。当前实现已核对账本限制、限定固定模板与重复执行语义，并独立测试。

源码中的四态名称为 `allow / approval / deny / unavailable`，本提案的 `ask` 应在协议设计时明确映射到 `approval`，不应无计划地新增第五种有效状态。`action: exec` 表示工具调用身份；安全 descriptor 的 `action: execute` 表示权限动作，两者也必须显式映射，不能按名称相同推断可信 builtin 身份。

S1 可以仅改变已知命令的呈现方式：把同一模型响应中、已完成 schema 验证且 descriptor 已冻结的有限 `exec` invocation 收集为一份清单；显示清单里的每一条完整命令，由用户明确确认每条命令。批次 UI 可以提供“一次确认清单内全部命令”的动作，但 Main 必须为每个 invocation 分别做策略检查并签发只能消费一次的批准状态。该状态只绑定本批次已列出的具体 invocation，不延伸到之后生成的命令、同一命令的下一次调用或另一会话。

批次一旦展示不得追加、重排或替换命令；任何命令或执行环境变化都使对应批准失效。用户可拒绝整个批次；若产品允许部分执行，必须让用户逐项明确选择。批次结束、run 取消、超时、审批 UI 异常、应用退出后，未消费的批准立即失效。发生会话切换时继续绑定原 session/run 并展示归属，不可把审批迁移到当前选中会话。Shell 启动仍经现有 ToolExecutionService；未知能力、缺失 broker、不可验证身份和硬拒绝都失败关闭。

该语义仍是“每个 invocation 获得明确用户同意”，没有 Shell 自动放行，也没有 Session grant。P3 决策目前冻结 V2 Shell 自动放行和生产沙箱集成；S1 不改变该安全结论。为避免把“逐次审批”误读为“必须逐个打开弹窗”，建议在 S1 实施时仅补充决策说明：同屏确认清单不改变每个 invocation 独立批准的语义。若产品决策坚持每条命令必须独立交互，则应以 ADR 决定为准，不启用批次按钮。

“本对话记住精确命令”会建立重复执行预授权，是对现有逐次 Shell 政策的例外。S2 需要修订 P3 决策并完成独立威胁模型、固定命令模板审查、Main 持有的会话/工作区绑定、次数/时限、失效测试和真实桌面验收。原契约要求可见撤销入口；用户后来明确要求彻底移除授权查看、列表与手动撤销入口，相关产品限制和自动失效边界已记入更新后的 P3 ADR。

## 后续安全验收表

| 范围 | 必测场景 | 通过条件 |
|---|---|---|
| 入口与权限 | 正常 Agent 工具循环、直接调用 builtin、插件同名伪装、缺 Main 快照/回调、`workspace-write`、legacy `full` | 只有 Main/ToolExecutionService 的真实有效决定能启动 Shell；任何缺失能力均拒绝或重新审批；V2 `workspace-write` 不自动执行 Shell。 |
| 精确命令 | 原命令后追加 `;`、换行、管道、重定向、命令替换；参数、空格、引号、大小写、Shell 和 cwd 改变 | L0/L1 中清单外或描述不完全相同的执行不匹配、不启动；Windows PowerShell 与 POSIX sh 均覆盖转义样本。 |
| 执行一致性 | 审批后替换 command、shell、argv、cwd、工作区身份、权限 snapshot、受控环境或有效 timeout | Main 启动前比较完整描述；任何变化都拒绝/重新审批；环境日志不包含密钥原文。 |
| 硬拒绝 | 受保护目录写入、已审查危险模式、`approvalPolicy=deny`、不可用的强制安全能力 | 硬拒绝在展示审批 UI 之前结算；批准或缓存状态均不能改变结果；进程启动次数为零。 |
| 一次性与批次 | 重复提交同 ID、同一条 invocation 重复消费、批次展示后追加命令、部分拒绝、批次取消 | ID 仅能结算一次；清单不可变；未批准条目绝不启动；结束后所有未消费条目失效。 |
| 会话与权限变化 | 会话 A/B、项目/工作区切换、权限降级、protected root 或策略版本变化 | 授权不跨范围；降级后按当前 Main 快照重新决定；Renderer 当前选择不能伪造旧 run 的权限。 |
| 竞态与生命周期 | 等待时取消 run、120 秒超时后延迟点击、会话切换、同命令并发、UI 关闭、Main 退出、断点恢复 | 无未经批准启动、无重复消费、无跨会话泄漏；重启/恢复不恢复旧授权。已启动的宿主进程不声称可被 UI 撤销成 OS 隔离。 |
| 真实桌面 | 隔离数据根与专用工作区中的真实 Windows Electron；POSIX Shell 权限专项测试 | 审批显示完整命令、Shell、cwd/workspace、宿主用户与无 OS 沙箱风险；一次确认仅覆盖显示清单；文件工具仍走文件守卫。 |
| 体验指标 | 固定的安全 coding 任务，分别记录调用数、用户操作数、重复审批等待时长、重新审批和拒绝数 | 先建立基线；S1 在安全门全过的前提下降低弹窗/等待，不增加已批准命令集合。诊断只记录计数、耗时、状态和必要摘要，不持久保存命令正文或环境密钥。 |

S0 审计时的测试覆盖 V2 Shell 隔离不可用时不自动执行、单次审批 callback、取消等待、并发审批串行化、硬决策优先级、Renderer 对 V2 Agent Shell 只提供单次操作，以及 Main 将 V2 preset 传入审批事件。当时**尚未证明**固定命令批次、审批后启动描述一致性、Shell blacklist 在 Main 审批前硬拒绝、真实 Electron 批次流程、Shell 环境身份、S2 失效或体验收益；后续 S1/S2 专项验收结果见本文末尾，不能由 S0 单测替代。

相关测试入口：[permission boundary tests](../../packages/safety/src/permission-boundary.test.ts#L150)、[ToolExecutionService tests](../../packages/tools/src/tool-execution-service.test.ts#L50)、[Main approval recheck tests](../../packages/app/src/main/run-approval.test.ts#L5)、[Renderer grant tests](../../packages/app/src/renderer/approval-grants.test.ts#L10)、[Main approval route tests](../../packages/app/src/main/local-app-api/run-routes.test.ts#L226)。

## 范围与验证记录

- 在 2026-10-15 的 S0 审计回合中，本文件是唯一新增内容；当时没有修改权限策略、Shell 执行器、审批 API、checkpoint 或迁移逻辑。
- 仓库当前已有多处与本审计无关的未提交工作。`run-routes.ts` 和 Renderer approval prompt 等文件含既有修改；本次保留原样。权限核心策略、`ToolExecutionService`、旧 `approval.ts`、`exec.ts` 与 P3 决策文件没有被本次修改。
- S0 审计时 S1 仍需独立实施；后续 S1 实施状态及当前门禁见本文“S1 实施状态”。S2 仍需独立 P3 ADR 决策。

### 本轮 S0 复核验证（2026-10-15）

- 本轮开始时本文件已经存在且未跟踪；本轮仅补充上述输入绑定、账本与协议映射分析，没有新增或修改生产授权代码，也没有改动 P3 ADR。
- 使用本地 Vitest 入口执行 `exec`、ToolExecutionService、permission-boundary、Main run-approval、Renderer approval-grants 和 Main run-routes 六个现有测试文件：6 文件、97 测试全部通过。其中无 Runtime 权限上下文的白名单 echo 确实成功执行，验证了 A1 所述现存行为；通过不表示该行为符合 V2-S 新契约。
- `check:repo` 对应的两个检查入口分别执行：仓库卫生 35 项通过、3 项 advisory、0 失败；TypeScript project references 检查通过（27 packages）。项目引用检查不是 workspace TypeScript 类型检查。
- 本轮没有运行真实 Electron、POSIX sh、S1 批次、S2 授权、完整 workspace typecheck 或全量门禁；未建立审批等待时间及交互次数的体验基线。本文是 S0 审计证据，不能作为 S1/S2 安全验收通过记录。

### S1 实施状态

- `ToolExecutionService` 在 Main 授权前复制 invocation 身份并冻结所有已验证 builtin `exec` 输入。单个模型响应里的最多 32 条命令作为完整清单提交；列表不可追加或替换，Main 硬拒绝任意成员时拒绝整个批次。用户只能批准已展示的全部命令或拒绝整个批次。
- Main 用进程内私有状态签发每项独立、最多 120 秒、只能消费一次的 invocation 凭据。取消、超时、拒绝、批次结束和 Main 重建均不会留下可恢复授权；checkpoint 不保存凭据。Render 只显示具体描述，ID/hash 均不构成授权。
- `exec` 不再把旧前缀白名单或 `auto-approve` 配置当作权限来源；direct builtin、缺 Main capability 和非 builtin 同名 `exec` 均不能启动 Shell。经过 Main 后，在最终 `spawn()` 前复核 session/run、Main 权限/工作区事实、原文 command、Shell 绝对路径及文件身份、cwd/workspace 目录身份、受控环境 HMAC 指纹和有效 timeout；启动时采用已审核的 Shell/参数/cwd/env。
- 审批 UI 展示清单内完整命令、真实 Shell、工作目录、工作区、宿主用户、每项执行上限、会话/run、范围和过期时间，并保留宿主执行与无 OS 沙箱风险披露。会话或权限模式切换会先拒绝当前 Renderer pending approval，Main 另行复核 SessionIndex/ProjectIndex。
- 体验测试在相同三条测试命令上测得审批操作由 3 次减至 1 次；这是确定性工具链 fixture 的操作数，不代表真实用户反应时间。真实 Electron 测试加入两条命令清单和实际进程结果检查。
- 验证结果：授权和调用链 9 个 Vitest 文件、131 项测试通过；workspace TypeScript `tsc -b` 通过；`check:repo` 35 项通过、0 失败及 3 项规模/模块地图提示。Windows Electron 44.4.5 真实窗口门 21 项断言通过，覆盖完整批次展示与实际进程结果、逐次审批、权限降级、checkpoint 恢复重新审批及文件守卫；WSL Ubuntu-26.04 的真实 `/usr/bin/dash` 专项通过，清单内两项各经批准执行，修改命令未启动。真实窗口使用隔离数据根和本地 Provider。
- S1 最终门禁：`pnpm run verify:full` 全部通过；仓库检查 35 项通过，Vitest 657 个文件通过（4,774 passed、2 skipped），workspace TypeScript、应用构建与恢复来源检查均退出码 0。恢复检查和全量测试使用临时隔离数据根。其后新增同名插件伪装回归断言，Shell/Main 4 个定向文件 91 项测试再次通过。
- 固定命令夹具将同一组三条命令的用户审批操作从 3 次降至 1 次。该指标仅代表确定性夹具的交互次数，不代表真实用户等待时长；尚未采集固定 Coding Agent 任务的累计等待时间和真实用户基线。
- S1 完成时，S2 精确重复授权和期限/次数机制尚未实现；后续实施及 P3 决策见本文末尾。Shell 仍是当前用户身份的宿主进程，路径与文件身份检查不等同 OS 隔离。

### S3 旧权限数据破坏性退役状态

- Renderer 权限菜单只提供 `read-only`、`workspace-write`、`full-access`。`research`、`restricted`、旧 `full` 及无版本的旧 `full-access` 不作为当前会话格式。
- 用户明确要求按破坏性更新处理旧权限数据。SessionIndex 只接纳 `permissionVersion: 2` 且使用当前三种预设之一的条目；其它记录从 `sessions.json` 会话索引移除，不再降权兼容、挂迁移标记或阻止用户等待确认。会话 JSONL 聊天记录不会因此删除，但旧索引条目不再通过当前会话列表访问。
- 旧运行字段不能设定当前权限。命名会话缺少 Main 权限记录时拒绝执行。无 Main invocation grant 和审批 broker 的旧 Agent terminal command/stream 入口会拒绝执行，因此不能把 V2 `full-access` 转译为旧 `full` 自动 Shell 放行。
- 当前版本化 `full-access` 继续由 Main 策略解释；不再读取历史无版本的 `full-access`。S3 验收时 Shell 在三种 V2 preset 下由 Main 逐次审批；后续仅增加 P3 ADR 明确批准的精确命令例外，P3 OS 沙箱状态没有改变。
- S3 完整门禁：`pnpm run verify:full` 通过，仓库检查 35 项通过、3 项提示，657 个测试文件通过（4,778 passed、2 skipped），workspace TypeScript、应用构建与恢复来源检查均通过。恢复检查使用新建的隔离数据根与测试工作区。
- S3 早期真实桌面验收：Windows Electron 44.4.5 的 `pnpm run verify:desktop-permission-v2` 通过 23 项断言，当时覆盖旧 `full` 会话的迁移确认流程。该流程现已按用户后续决定删除。最新破坏性更新后的真实桌面验收已通过：旧权限索引记录被丢弃、不出现迁移提示；当前 V2 Shell 审批、精确命令复用、权限降级、checkpoint 恢复和原生文件守卫均重新验证。
- S3 验收时 S2 尚未实现。S2 后续状态见下节；Shell 仍以当前宿主用户权限执行，S2 不构成 P3 OS 沙箱。

### S2 精确重复授权及用户决定的管理界面修订

- S2 仅为 Main 审查的固定 `pwd` 模板提供“本对话允许这条命令”选项。授权由 Main 进程内存持有，绑定当前会话、工作区对象、工作区根目录、Shell 可执行文件身份及参数、用户、完整权限快照、有效环境指纹和 timeout。原文必须严格等于 `pwd`；不接受参数、前后缀或命令组合。
- 每个 invocation 仍先经过当前 Main 权限、硬拒绝及强制审批判断。复用需重新核对最终启动描述。授权最多存续 30 分钟或供 20 次后续匹配消费，两者先到即失效；会话/工作区/权限事实变化、Main 重建或无法证明连续性时清除。Checkpoint 与 Agent 上下文均不保存此授权。
- 用户于 2026-10-15 明确要求移除授权查看、列表及手动撤销入口。实现已删除 Renderer 列表、Local App API 查询/删除路由和 store 列表接口；Main 仍保留进程内自动失效及首次启动失败回滚。此选择意味着用户无法在过期或范围变化前主动查看或撤销授权，属于经用户明确选择的产品限制。
- 本轮桌面验收确认授权查询/撤销 API 返回 404、权限菜单无查看/撤销控件，Shell 精确命令第二次调用无提示且降权后重新审批；另确认旧权限索引记录被清理、无迁移提示，checkpoint 恢复使用当前权限并重新审批。Shell 仍以当前用户权限在宿主执行，没有 OS 级沙箱。性能证据目前限于一个连续真实 Electron 场景：同一工作区内连续两次 `pwd` 仅第一次触发审批；这不能代表完整 Coding Agent 任务的总体等待时间收益。
- 最新 `pnpm run verify:full` 未通过，失败阶段为全量测试：唯一失败是当前新改动中的 `appearance-preferences.test.ts:95`，断言 `APPEARANCE_DEFAULTS.chatFontSize` 应为 `14`，实际仍为 `15`。这是该新外观改动自身的预期与实现不一致，不是 Permission V2-S 测试失败；本轮未修改外观实现。全量门禁的仓库检查和 TypeScript 前置阶段通过，但因测试失败，构建与恢复阶段未执行，不能将本轮完整门禁记为通过。
