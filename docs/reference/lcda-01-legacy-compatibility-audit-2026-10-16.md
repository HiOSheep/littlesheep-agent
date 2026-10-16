# LS LCDA-01 — 全仓历史兼容与遗留代码审计

日期：2026-10-16（Asia/Hong_Kong）
审计基线：本地 `main`，HEAD `2375785a478d253ea2151228cf3c33b76b344218`；工作树干净；相对 `origin/main` ahead 12。结论只适用于该本地快照，不代表远端分支。

## 范围与证据边界

对 `packages/`、`scripts/`、`docs/` 做了全仓符号/关键词清点，并深入追踪 Harness、Runner、checkpoint、权限、Memory、Tools/Plugins/Web、Renderer 与对应 schema、脚本、测试和文档中的生产/消费链。本文使用源码静态证据；未运行测试、Electron、真实 Provider 或迁移；未读取用户数据根、用户配置、浏览器 LocalStorage 或运行日志。因而“实际数据是否仍存在”和仓库外 Local App API 调用方数量均为未知，不以源码无引用推导它们不存在。

本批只增加本审计文档与参考索引，不更改生产代码。LCDA-02 是建议计划，不是本批授权的清理执行。

## 结论摘要

1. 当前没有第二个活动 Harness / TaskBook 执行器。`createDefaultHarness()` 把所有运行交给同一个 `createDurableHarness()`；当前注册的生产 stage 是 `enter / classify / execute / recover / reply / ask_user / finalize`。DECIDE、独立 VERIFY、EVOLVE、CAPTURE 的执行实现已删除。
2. **旧执行器不等于只读兼容。** 旧 TaskBook、执行记录、verification history 仍可从 checkpoint/log 恢复和呈现；旧 TaskBook patch 还被 Local App API 接受，并在 RunContext 有既存 TaskBook 时由 Harness 校验应用。没有找到当前代码创建新 TaskBook 或运行旧逐步执行器的生产者；API 外部调用方和真实使用量未知。
3. 旧 checkpoint stage、旧权限标识、Memory 旧来源和无 lease 的旧 run 恢复，仍接触持久用户数据或安全/恢复决策，不应直接删除。
4. 确定的低风险清理点包括：checkpoint 中没有读者的旧 Replan 计数投影；Memory V3 Provider 验收脚本错误地要求已经移除的 `verify` stage；若干文档的过期状态描述。整个脚本不能删除，因为它仍包含真实 Memory 写入、重启召回和负向授权断言。
5. `browserFallback` 是用户可配置并贯穿 API/设置投影的字段，但本次生产源码检索没有找到根据该值启动浏览器或改变 Web 请求的分支，是“看起来可配置但当前无行为”的 D 项。

## 排序总表

排序综合真实无用程度、维护复杂度、运行路径影响、清理风险和当前在研冲突。高在研冲突表示 LCDA-02 应等 RCD、CMv2、Permission V2 或发布专项稳定后再触碰相邻契约。

| 排序 | 发现 / 分类 | 真实无用程度 | 维护复杂度 | 运行路径影响 | 清理风险 | 在研冲突 |
|---|---|---:|---:|---:|---:|---:|
| 1 | Provider 验收脚本错误要求 VERIFY；修复该断言与过期说明（A） | 高 | 低 | 中（验证可信度） | 低 | 中（Memory/发布验收） |
| 2 | `replanAttempts` / `maxReplanAttempts` 无运行时读者（A） | 高 | 低 | 无 | 低；保留旧 JSON 字段即可 | 高（checkpoint / RCD） |
| 3 | `WorkPolicyUpgradeRequest` 只在 checkpoint 投影/恢复，无现行生成者和消费者（B） | 高 | 中 | 低；旧 checkpoint 字段 | 中 | 高（checkpoint / RCD） |
| 4 | `browserFallback` 有配置与 UI，无浏览器 fallback 执行分支（D） | 高 | 中 | 当前无；设置呈现误导 | 低至中（外部 API 使用未知） | 中（Web / 发布） |
| 5 | TaskBook 逐步执行已删除；旧数据和 patch API 尚在（B/D） | 高（执行器已清） | 中 | checkpoint、Run event、历史 UI | 高 | 高（RCD） |
| 6 | 旧 stage / permission checkpoint 兼容（C） | 中 | 中 | 恢复、安全决策 | 高 | 高（RCD / Permission V2） |
| 7 | Memory 旧来源与 V2 repository（B/C） | 低（仍有活跃数据根） | 高 | Memory 读写、迁移、回滚 | 很高 | 很高（CMv2 / Memory 发布） |
| 8 | pre-lease event-only Runner 恢复扫描（C） | 中 | 低 | durable run 恢复与副作用重放防护 | 高 | 高（RCD） |
| 9 | Renderer 旧 LocalStorage workspace layout 与旧 activity 事件（B/D） | 中 | 中 | 用户布局、草稿、历史活动 | 高 | 中（前端在研） |
| 10 | 历史调用目的、verification、插件与文件格式支持（B/C） | 低 | 低至中 | 历史日志/用户内容 | 中至高 | 中 |

## 详细发现

### 1. Provider Memory V3 验收脚本要求已删除的 `verify` stage（A）

- **当前实现及来源：** `packages/harness/src/default-harness.ts:42-80` 注册当前 stage；`packages/types/src/stage-transitions.ts` 将 `verify` 列为 historical stage。`scripts/lib/memory-v3-provider-acceptance.mjs:500-512` 的 `assertCurrentTrace()` 却要求成功 trace 必须含 `verify`。当前脚本对 isolated Memory V3 run 的实际 trace 不会产生这个 stage。`package.json:81` 仍公开 `verify:memory-v3-provider` 命令。
- **原本目的：** 真实 Provider 验收受控 Memory V3 写入、重启后持久性、上下文召回，以及无用户记忆指令时拒绝强迫写入。
- **生产者/消费者：** 命令消费者是运行验收的人/发布门；helper 会调用 Runner 和真实 Provider。旧 `verify` 不再有生产者；脚本仍检查 `decide/evolve/capture` 不出现。
- **持久化/安全/恢复：** 测试数据位于隔离临时目录；无产品持久化影响。真实记忆写入授权的正负向断言是安全证据，不能一并删除。
- **替代/删除/迁移：** 当前执行 trace 和 EXECUTE evidence settlement 是替代。可直接移除 `verify` 必须出现的断言并更新 helper 注释、`docs/decision/project-status.md:34` 的失效原因；保留 Memory 工具写入/恢复/拒绝断言。无需数据迁移。
- **回归与复杂度：** 若只放宽 stage 断言而不保留实际写入/负向拒绝门，可能把 Provider 验收误报为通过；若照现状执行则该门因 stage 不存在而错误失败。清理复杂度低、验证可信度收益高。本审计未运行该 Provider gate，属于源码确定的契约矛盾，不声称本轮复现运行日志。

### 2. 旧 Replan checkpoint 计数无现行运行时读者（A）

- **当前实现及来源：** `RunCheckpointResumeState.replanAttempts/maxReplanAttempts` 定义在 `packages/types/src/runtime-contracts.ts:830-831`；`packages/runner/src/run-checkpoint-codec.ts:194-199,226-227` 只做校验并复制。全仓源码未找到对这两个运行时值的读取或新写入。
- **原本目的：** 限制旧模型驱动的 replan 次数。
- **生产者/消费者：** 新 checkpoint writer 不写这两个字段；现有 reader 接受旧 v1 checkpoint。没有执行器消费者。旧 Replan 语义已由单一主循环和有界 Runtime RECOVER 取代。
- **持久化/安全/恢复：** 字段可能真实存在于旧 checkpoint JSON；不能因此删除整个 checkpoint，也不能拒绝它。计数本身不再约束当前恢复。
- **替代/删除/迁移：** 可在保留未知旧属性可被 codec 忽略的前提下，直接移除类型投影、数值校验和返回对象复制；不必改写或删除磁盘文件。若 `@littlesheep/types` 对外发布，还需确认外部 TypeScript 消费者的兼容政策。
- **回归与复杂度：** 可能影响仍读取旧字段的外部类型消费者，或过度严格解析未知 checkpoint 字段；通过保留 raw JSON 容忍及现有 checkpoint fixture 可控。代码减少小，但删除一个已经失效的执行限制能降低语义混淆。此项与 RCD checkpoint 契约有文件重叠，等 RCD checkpoint 工作冻结后再做。

### 3. `WorkPolicyUpgradeRequest` 是 checkpoint-only 的过渡字段（B）

- **当前实现及来源：** 类型在 `packages/types/src/task.ts:112`；恢复 codec `packages/runner/src/run-checkpoint-work-policy-codec.ts` 约 80 行；`run-checkpoint-codec.ts`、`run-checkpoint.ts` 和 `runner.ts` 只验证、保存、恢复。全仓未找到设置该字段的当前生产调用或读取它来选择执行策略的分支。
- **原本目的：** 在旧设计中将运行中的 bounded loop 提升为 TaskBook，并携带剩余目标、已结算副作用和预算。
- **生产者/消费者：** 现有生产者与策略消费者均未发现；当前只在 checkpoint wire format 上有读写投影。外部写入 checkpoint 的情况未知。
- **持久化/安全/恢复：** 字段可能在旧 checkpoint 中持久存在，内部包含工具调用 idempotency keys 和执行预算事实；当前运行不使用它，但整段 codec 删除会丢弃读回/重写时可见的历史状态。
- **替代/删除/迁移：** 单一 bounded loop 与已删除的 TaskBook 升级路径是替代。建议先只读统计受支持数据根中的字段出现数；若保留检查点只是审计需要，则迁到只读历史扩展或归档原 checkpoint 后移除类型、codec、checkpoint 复制字段。不能只凭源码无生产者就丢掉字段。
- **回归与复杂度：** 删除后旧 JSON 可以选择忽略该字段，但重写 checkpoint 会丢失它；外部工具可能依赖类型。消除一个复杂 codec 的维护收益中等，恢复风险中等，需确认当前 RCD 不准备重新采用该协议。

### 4. `browserFallback` 可见但当前没有执行消费者（D）

- **当前实现及来源：** schema `packages/config/src/schema.ts:196` 接受 `disabled / approval_required / full_only`；`packages/types/src/web-retrieval.ts`、`packages/runner/src/run-config.ts`、Main runtime payload/routes、Renderer 的 `settings/web.tsx` 和 search index 持久化、展示和传递它。全仓生产引用中没有根据此值执行 browser fallback 的分支。
- **原本目的：** 看起来是 Web 请求失败时可选的浏览器后备策略。
- **生产者/消费者：** 设置 UI 与 Main API 是字段生产者/传递者；Web fetch/search runtime 未使用该配置采取不同动作。用户能保存选择，但行为没有实现。
- **持久化/安全/恢复：** 配置文件会保存该值；当前未发现它改变网络或浏览器副作用。没有对应的数据迁移或恢复契约。
- **替代/删除/迁移：** 当前没有浏览器 fallback 实现作为替代。若产品未计划短期实现，可先从 UI 隐藏并保留 schema/API 读取兼容，随后在配置版本/公开 Local API 迁移后删除字段；若这是预留功能，应在 UI 明确 unavailable 或补齐真实实现。
- **回归与复杂度：** 直接删字段会改变配置回读和 API response shape，外部客户端使用未知，故列 D。单独移除无效 UI 选项可降低用户误解，整体 plumb-through 清除可减少低到中等复杂度。

### 5. TaskBook 执行器已删除，TaskBook 数据/patch 是另一条兼容路径（B + D）

- **当前实现及来源：** `packages/harness/src/default-harness.ts:50-61` 明确标记旧 DECIDE/EVOLVE/CAPTURE 删除；`stages/execute.ts` 把任务交给统一主循环。checkpoint/log 仍保存 `taskBook`、`taskExecution` 与历史 `verificationHistory`；`runner.ts` 恢复并展示，Renderer 的 history/activity 层读取。没有发现新运行创建 TaskBook 或旧逐步 executor 运行步骤的生产者。
- **原本目的：** 旧执行器将 TaskBook 拆成有序步骤，按步骤限制工具、调度并行分支和阶段验证。
- **生产者/消费者：** 当前 RunContext 可从旧 checkpoint/log 恢复 TaskBook；`runner.ts` 有条件注册动态 `taskbook` skill（只在恢复数据有 taskBook/plan 时）；Renderer 将旧 TaskBook/step/verification history 呈现给用户。Local API 仍接受 taskBook patch，Harness 的 `runtime-control-boundary.ts` 会对既存 TaskBook 做有界修订；patch 不会复活旧 step executor。
- **持久化/安全/恢复：** 这些字段出现在用户 checkpoint、execution log 和历史记录；有副作用结果、已完成步骤及验证状态。新 `EXECUTE` evidence settlement 也会写 `VerificationRecord`（`packages/harness/src/stages/execute/evidence-settlement.ts:136-179`），当前 `unverified/fail` 与旧 `pass/needs_replan` 的含义不同。不能把验证类型一概当作旧数据删除。
- **替代/删除/迁移：** 旧逐步执行被单一 Execute loop 取代；历史 UI/记录没有直接替代。Step executor 的生产代码已不在当前树里，无需再删一个“旧 executor”。若要清除旧 TaskBook 数据，要先定义 checkpoint/log 留存或导出迁移；verification `pass` 必须降为历史标签，不能映射为当前任务已验收。
- **回归与复杂度：** 删除恢复/投影可能隐藏用户已完成工作、历史证据或检查点续接信息。历史结构会带来中等维护成本，但其数据和 UI 读者仍存在，先保留。

**单独的 D 项——TaskBook patch API：** `packages/app/src/main/local-app-api/runtime-event-request.ts:40-43` 接受 `taskBookPatch` / `patch`，`packages/harness/src/runtime-control-boundary.ts:123-200,314` 校验并提交。当前仓库内没有 UI/模型生产者；外部 Local App API 客户端是否发送未知，且 patch 仅对已有 TaskBook 有效。原目的为 Runtime 安全地小幅修订任务清单。若要移除，先查 API 调用记录/版本承诺，退役 route/event 后再删 patch 类型和校验；不能以 Renderer 无引用为由直接删。

### 6. 旧 stage 与 Permission V1 checkpoint 值仍是恢复/授权契约（C）

- **当前实现及来源：** `packages/types/src/stage-transitions.ts` 将 `decide/verify/evolve/capture` 列为历史 stage；`run-checkpoint-codec.ts` 仍接受这些名字。`checkpoint-resume.ts:17-20` 将旧 `decide → execute`、`verify → recover`；RECOVER 会对旧 verify checkpoint 重新评估 evidence，并在缺失时保守升级。`PermissionModeId` 和 checkpoint codec 仍接受 `full/research/restricted`；Main 对普通新 API 拒绝旧权限参数，SessionIndex 丢弃没有 V2 版本标记的旧权限行，但聊天记录不会因此删除。
- **原本目的：** 让旧恢复点能进入现行流程，并保留可解释的历史授权上限。
- **生产者/消费者：** 旧 App/Runner 版本写入 checkpoint；当前 Runner 恢复，Main 按当前会话权限再次封顶授权。新的活跃 stage 不再产生这些旧值。
- **持久化/安全/恢复：** 真实 checkpoint 与历史执行记录可含旧 stage/permission 值；权限映射和 verify→recover 重新结算属于安全和恢复边界。
- **替代/删除/迁移：** 新执行由唯一 DurableHarness 与当前 RECOVER/evidence settlement 处理。只有在受支持数据根完成 checkpoint 迁移或明确过期、旧权限字段不再用于授权且旧 checkpoint 恢复有明确失败/导出路径后，才可删历史解析。
- **回归与复杂度：** 直接删除可能导致 checkpoint 无法恢复、把旧 verify 状态错误地当成完成，或在授权降级时失去 fail-closed 事实。当前保留成本低于恢复/安全回归风险。Permission V2 与 RCD 专项在研，本批不改。

### 7. Memory V2 backend 仍是有效实现；V2→V3 迁移需保留（C）

- **当前实现及来源：** `packages/config/src/schema.ts:216` 将 `repositoryBackend` 默认设为 `v2`，`MemoryRepository` factory 默认也选 V2。V3 需要显式隔离标记或 locator；Main 只在存在 locator 时将 config 与活动 backend 同步。`v2-backend.ts` 仍实现 repository 的完整读写接口。
- **原本目的：** V2 是默认/既有数据格式，V3 是显式迁移后的后端；locator、snapshot、验证、事务提交和回滚用来防止数据丢失。
- **生产者/消费者：** 未迁移默认数据根与显式配置 V2 的 Runner 仍会使用 V2；V3 migration manager 直接读取 V2 源。用户数据根中的 V2 store 是真实持久化数据。
- **持久化/安全/恢复：** V2 资料、备份、migration snapshot、locator 和 rollback 状态都是用户数据/恢复契约。
- **替代/删除/迁移：** V3 仅替代已迁移数据根。只有将所有支持数据根切到 V3、默认 config/新建根切换完成、迁移和 rollback 期限结束、V2 raw source 的保留策略明确后，才可移除 V2 backend。
- **回归与复杂度：** 直接删除会使默认配置和旧数据根无法启动/读写，且破坏回滚。本项仍属 C。`packages/memory-tree/src/memory-repository/README.md:29` 的“正式活动后端已经切换为 v3”应加上“已具 locator 的数据根”，否则与 config 默认值/boot code 表面矛盾。

### 8. 旧 Memory 文件来源只在迁移完成后停止读取（B）

- **当前实现及来源：** `migrateLegacyMemorySources()` 在 `packages/memory-tree/src/legacy-memory-branches.ts:394-` 导入旧 long-term、daily、experience 内容；`packages/runner/src/infra.ts:426-451` 在迁移未完成或失败时继续注册 `LegacyLongTermBranch`、`LegacyDailyBranch`、`LegacyExperienceBranch`。
- **原本目的：** 防止 Memory 树迁移期间漏读旧数据或双重注入；原始旧文件在复制后仍被保留。
- **生产者/消费者：** 迁移函数读旧 Store 并写当前 repository；迁移失败时 Branch 仍提供检索读取。ExperienceStore 仍由 CLI `import-repo` 写入，因此并非所有来源都能简单认为只读。
- **持久化/安全/恢复：** 旧长期记忆、每日记忆、经验记录与迁移 ledger 是用户持久数据；索引缺失/队列未完成时的 fallback 是数据可见性保护。
- **替代/删除/迁移：** 已完成且 ledger 标记完成、queue 为零的单个 data root 会停止注册 legacy branches。全局删除还要求所有受支持 data roots 均达到该条件、迁移计数和拒绝记录可复核、源文件/备份与回滚保留期明确。
- **回归与复杂度：** 过早删除会令未迁移用户记忆从搜索/注入中消失；同时误删原文件会造成不可逆数据损失。条件满足前维持 B。

### 9. pre-lease event-only run recovery 扫描仍保护旧 durable runs（C）

- **当前实现及来源：** `packages/app/src/main/run-recovery.ts:123-138,165-` 在现代 lease/inbox queue 恢复后继续做 event-only compatibility scan；只有无旧 lease 的 event run 才会进入恢复，代码按 lease 重新检查以防重复拥有/重放。
- **原本目的：** 恢复引入 lease store 之前写下的 durable event runs，同时避免现代 queue 路径与旧扫描并发恢复同一 run。
- **生产者/消费者：** 旧版本只写 events；当前 Runner 恢复事件。现代 lease/inbox 是新替代路径。
- **持久化/安全/恢复：** durable event partitions 和副作用/运行日志是持久状态；重复恢复可能重放副作用，因此 lease 检查是安全恢复契约。
- **替代/删除/迁移：** 新 run 使用 lease/inbox。只有所有受支持数据根确认不再有 pre-lease run，或先迁移这些 event streams 并验证无未结副作用后，才可关闭兼容扫描。
- **回归与复杂度：** 删除会把旧 run 留在永远不可恢复的状态，或诱发人工重启后重复工作。实现成本较小但运行风险高；当前保留。

### 10. Renderer 旧 workspace layout 与旧 activity 事件（B/D）

- **当前实现及来源：** `readLegacyWorkspaceSessionLayout()` 仍从旧 LocalStorage 键读取 tabs、drafts、panel state，`use-workspace-session-layouts.ts:397-` 在新 session-scoped layout 不存在时导入。Renderer API/handler/types 仍承认 `task_book`、`step_*`、`verification_start` 等旧 activity 事件。
- **原本目的：** 在布局存储改为 workspace/session-scoped 后保留旧用户窗口状态，并让旧 stream/activity 能显示。
- **生产者/消费者：** 旧 Renderer 版本写 LocalStorage；当前 Renderer 在新 key 缺失时读取。旧活动事件没有在当前 Runner 找到生产者，但 Renderer 仍解析；外部/旧 server 事件来源未知。
- **持久化/安全/恢复：** open tabs、文件 drafts 以及面板状态储存在用户 LocalStorage；drafts 可能含未保存编辑，不能清除。历史 TaskBook/verification 记录也会被 Renderer 恢复显示。
- **替代/删除/迁移：** 新 session layout key 是布局替代；只有在旧键已可靠导入新 key、drafts 未丢失且可回滚后才能停止读取。旧 activity 消息需等 stream/API 版本或历史转换方案确认后退役。
- **回归与复杂度：** 删除旧读路径可能丢失草稿和 workspace 布局；删除旧事件类型可能令历史活动消失。维护收益中等，清理风险中高，按 B（LocalStorage）/D（外部事件消费者未知）处理。

### 11. 历史模型 purpose 与文档/测试不可一概清理（B/C）

- **当前实现及来源：** `packages/types/src/runtime-contracts.ts` 的 purpose 类型保留 `decide/verify/evolve/capture`；`definitions.ts` 仍有部分旧 purpose templates，但 `verify` template 已不存在，`definitions.test.ts` 明确要求解析 `verify` 失败。对应 README 仍把 `verify` 列作兼容模板，是过期描述。历史 verification verdict `pass/needs_replan` 仍需和新 `unverified/fail` 区分。
- **原本目的：** 读取旧 execution log、model request snapshot、checkpoint 和历史 UI，而非重新启用模型调用。
- **生产者/消费者：** 旧版本可写入旧 purpose；`ModelRequestSnapshot` 持有该字段且 Runner execution log 持久化 `modelRequests`，context-usage projection 消费这些 snapshots。部分历史 purpose 仍可由 registry resolve；`verify` purpose 当前不可 resolve。是否仍有存量日志或外部重放消费者未知。
- **持久化/安全/恢复：** purpose 和 verification history 存在用户日志/会话数据；`pass` 只表示旧任务协议，不可拿来给当前任务补造 acceptance pass。
- **替代/删除/迁移：** 当前 model observability 和 EXECUTE evidence settlement 是现行路径。可立即修正文档中 `verify` template 的错误说法；purpose 类型与旧日志 reader 需等 execution-log 保留期限、外部 log export/API 兼容及旧数据读取策略冻结后再删。
- **回归与复杂度：** 删除会使旧日志无法显示或将旧 pass 错解释为新验收。维护复杂度低，暂时保留。

### 12. Tools / Plugins / Web 的误判排除与真实后续项

- 当前 Plugin 包主要是 manifest、local loader、host 与 channel manager；本次没有发现第二套 legacy plugin executor/API。`tavily-search-v1` 是当前 Provider id，Cloudflare DoH 的 compatibility 标记是明确受限 DNS 路径，不能因为 `v1/compat` 名称清理。
- Builtin `grep` 的 naive fallback 是 ripgrep 不可用时的实际替代实现；Office preview 对老式文档的 binary fallback 读取用户文件。这些具有真实消费者，不属于死代码；旧格式删除需要产品文件兼容周期与转换方案。
- CLI 的 `memory archive` 留有退休提示，避免旧命令静默失败；外部脚本调用情况未知。若退役，先保留清晰的迁移消息或明确 CLI 版本策略。
- `LEGACY_SETTINGS_PAGE_GROUPS` 仍驱动当前页面分组，且页面 id 本身没有改名；表名虽旧但不是未使用实现。可在未来重命名为当前导航数据，但不要删掉分组定义或路由 fallback。
- `docs/decision/project-status.md:11` 将旧 TaskBook 与 verification record 统称为“只保留历史读取”，范围说得过宽：已恢复的 TaskBook 仍可经 Runtime event patch 修订；EXECUTE evidence settlement 仍写新的 `unverified/fail` VerificationRecord。应改成“旧 step executor/VERIFY stage 退役；持久结构用于历史恢复/展示，verification history 还承载当前 evidence settlement”。
- `docs/decision/project-status.md:34` 给 Memory V3 Provider gate 的失效原因写成“要求已移除的 EVOLVE/CAPTURE 字段”；helper 实际要求 `verify` 出现在 trace，并要求 `decide/evolve/capture` 不出现。结论“当前不能作为有效验收证据”成立，具体根因需更正。

## LCDA-02 建议清理批次

### 批次 0：确认数据与接口边界

只读盘点受支持 data roots 中 checkpoint / execution log / Memory legacy files / repository locator / LocalStorage migration 状态；只统计类型、数量、版本和 hash，不输出记忆正文或草稿。盘点当前 CLI 与 Local App API 的对外版本/调用方；确认当前 RCD、CMv2、Permission V2、Memory 发布专项完成后哪些文件已稳定。此审计没有访问用户数据，因此该批条件尚未满足。

### 批次 1：可立即清除的失效契约（A）

1. 修正 `verify:memory-v3-provider` 的 current trace assertion：移除强制 `verify`，保留真实 `memory_write`、重启、召回、拒绝自授权和“不运行 decide/evolve/capture”断言；同步修正 `project-status.md` 的确切失效原因。
2. 移除旧 `replanAttempts/maxReplanAttempts` 的类型投影、解析校验和 copy；解析器继续接受并忽略旧 JSON 未知属性，不能拒绝或改写现存 checkpoint。先等 RCD 当前 checkpoint 变更冻结。
3. 清理明显过时的文档表述/注释：Harness 公共 index 的“10 stages”计数；llm-call-contract README 中与模板集合不一致的 `verify` 描述；Memory Repository 对 V3 活动 backend 的无条件表述；未来 TaskBook/Subagent proposal 对 VERIFY 当前路径的陈旧说法。对仍列为进行中的 taskbook 只更正契约，不删除计划。

### 批次 2：checkpoint schema 收口（B）

1. 查明 `WorkPolicyUpgradeRequest` 在存量 checkpoint 的出现数。若无数据，移除类型、独立 codec、snapshot/restore 字段及测试夹具；若有，先归档/迁移历史对象，再删投影。`task_book` WorkPolicy 值同理保留读取兼容，直到旧 checkpoint 清空或有显式 migration。
2. 对 `TaskBookPatch` 做 API 版本决策：若无外部调用且不再保留旧 TaskBook 修订能力，先退役 runtime-event API 和协议字段，再移除 patch validator、idempotency bookkeeping 与测试。不要与旧 step executor 混成一次删除。
3. 明确旧 `TaskBook/taskExecution/verificationHistory` checkpoint 与 execution-log 留存/导出策略；保持旧 `pass/needs_replan` 作为历史结果，不能映射为当前验收成功。

### 批次 3：数据迁移后清理（B/C）

1. Memory 每个 data root 完成旧 long-term/daily/experience 导入、migration ledger 成功、queue 为零、V3 read path 可见且有可用备份/回滚窗口后，才停止 legacy branches；所有支持根满足后再评估删除 legacy readers。Memory V2 backend 在默认值或迁移支持窗口变化之前继续保留。
2. V2→V3 迁移、snapshot、locator、恢复和 rollback 独立作为当前 Memory/CMv2 工作处理；LCDA 不合并修改，避免破坏在研迁移/权限证据。
3. 旧 checkpoint stage 与旧权限解析需在存量 checkpoint 完成迁移/过期、当前权限重新判定仍 fail closed、恢复不得跳过证据结算/重复副作用之后再评估删除。
4. event-only run scan 需在旧 run/event streams 全部迁入 lease/inbox 或过期、无 pending side effect 后再退役。
5. Renderer 旧 LocalStorage reader 需确认新 key 对所有旧 layout/draft 完成导入且保存；旧活动事件需确认没有旧 stream/API consumer。

### 批次 4：有真实实现或外部依赖未知的项目（C/D）

1. 对 `browserFallback` 选择其一：实现受限且可测试的真实行为；或先从 UI 隐藏并保留 config/API 读取兼容，确认外部使用/版本策略后再移除。
2. Permission 旧模式字段只有在 Main 内部调用和 checkpoint authorization snapshot 都完成 V2 类型迁移后才删除；需保留当前 hard deny、session 权限降级和 Main 唯一授权边界。
3. 插件/Office/grep 现行路径不在 LCDA 清理批次；需要新证据表明没有现行消费者且有替代/数据转换方案才可重新评估。

## 本批停止点与未完成事项

- 本批没有删除生产代码，也没有运行测试或 provider/Electron 验收。
- 没有读取用户 checkpoint、Memory 文件、配置或 LocalStorage，因而无法给出存量计数；LCDA-02 批次 0 必须补此证据。
- 没有向外部 API/插件消费者查询使用情况；TaskBook patch 与 `browserFallback` 保持 D。
- 不改动 RCD、CMv2、Permission V2 或发布专项的在研代码。本批在审计和方案交付后停止。
