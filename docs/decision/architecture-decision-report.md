# LittleSheep 架构评估与开发决策报告

最后更新：2026-09-24 17:52:04
评估范围：当前源码、常驻文档与已记录的验证结果
执行状态：控制流已收敛为唯一主循环。活动路由只产出 `execute` 与能力/状态 `reply` 两条路径；DECIDE、验证模型调用、恢复模型调用与 CAPTURE 已删除，`classify`、`decide`、`evolve`、`capture` 只作为历史 stage 名保留在类型与旧检查点读取路径中；ASK_USER 只能由主循环的 `request_user_input` 或 RECOVER 升级到达；持久化 TaskBook 是只读历史，步骤串行执行。请求装配由缓存边界与 append-only 尾部账本共同决定：system 消息就是边界之上的 prompt 段，边界之下的段各自作为独立消息追加。工具目录在一个会话区间内固定，某轮不得使用的能力在执行边界被拒绝；上下文淘汰按 `appended-only` 作用域运行。会话压缩是持久记忆的唯一写入方，模型侧 `memory_tree` 只读；VERIFY 不调用模型，窄结构形态记为 `pass`、其余已完成的 run 记为 `unverified`。权限仍为三档并与行为 profile 正交，容器是 Main 的路径分类与审批闸门而不是 OS 沙箱。Memory v3 阶段 0-26、统一 Tool Execution Service、运行时事件、TaskBookPatch、检查点续跑与桌面后台控制已形成工程基线。**当前未闭环的是缓存 95% 红线（实机负载未达标）、Pro 与其他 Provider 的模型专用校准、非字段事实与外部系统副作用验收、与成熟 Agent 产品可比较的任务效率基线、MCP 与发布流程。**

## 当前开发方向（2026-09-22，待实施）

Harness / Runner 冻结为 stable kernel，后续只为真实任务 correctness bug、删除复杂度或已证明缺失的硬 invariant 最小修改。下一 Runtime 主线是文件观察版本与写入前置校验，复用工具执行、权限和检查点，不新增 stage/planner/scheduler/manager。Memory 按用户最新修正，仅在明确要求或确有必要时通过现有主循环提出受控写入；压缩保留会话连续性，移除长期候选自动提炼和提交。普通聊天不默认沉淀，不恢复 CAPTURE/auto-evolution，不靠消息条数压缩触发学习。

这是新的开发顺序，覆盖下文历史阶段排序；当前源码仍是压缩唯一写入方，不提前宣称按需写入已实现。具体范围、必要性约束和验收见[Runtime 状态一致性与必要记忆任务书](../taskbooks/runtime-state-consistency-taskbook-2026-09-22.md)。缓存专项按用户确认已完成，后续按[现行验收条款](../reference/cache-95-acceptance.md#真实长任务现行红线2026-09-22)回归；不重开原清单。

## 1. 给决策者的结论

LittleSheep 当前不是"只有 Prompt 的聊天壳"：它已经具备代码控制的 Harness、单一主循环、统一工具执行、索引优先记忆树、会话持久化与压缩、执行日志、Electron UI 和插件宿主，方向与"LLM 负责推理、Agent 负责兑现"基本一致。

所有后续架构取舍都应服务于同一项产品使命：**解放用户生产力，让用户着重于想法的产生，LS 负责让用户的想法落地。** 因此检索、规划、执行、验证、整理和记忆维护应尽量由运行时承担；用户保留目标取舍、风险接受、权限授予和关键判断权。模块化不是为了增加内部形式，而是为了让自动化更可靠、过程更可追溯、用户更少承担低价值的操作负担。

但当前更准确的描述是：

> **包级模块骨架与既有调用契约已有稳定基础；控制流、请求装配、工具执行、压缩写入、验证判定与权限边界都已收敛为单一所有者。剩余工作不是在核心上继续叠加第二条路径，而是补齐真实 Provider 校准、缓存命中率、外部副作用与生态扩展。**

当前最重要的结构结论：

1. **控制流只有一条执行路径。** 活动路由不消耗模型请求，只决定本轮进入主循环 `execute` 还是能力/状态 `reply`；聊天轮与工具轮共享同一 system 提示与工具集，因此前缀可跨轮复用。DECIDE、VERIFY 模型调用、RECOVER 模型调用和 CAPTURE 已删除；ASK_USER 只能由主循环的 `request_user_input` 或 RECOVER 升级到达；持久化 TaskBook 不再触发第二个执行器。
2. **请求装配有唯一所有者。** system 消息就是缓存边界之上的 prompt 段；边界之下的段（bootstrap、runtime facts、检索意图契约、压缩摘要）各自作为独立消息追加，由 append-only 尾部账本持有，工具循环的第 N 次请求是第 N+1 次的字节前缀。工具目录在会话区间内固定，越权能力在**执行**边界被拒绝；上下文淘汰按 `appended-only` 作用域运行，已发送前缀超窗时请求显式失败。
3. **写入与判定各自只有一个权威。** 压缩路径是持久记忆的唯一写入方（摘要与覆盖区间原子提交，带 predecessor/source-hash 前置条件，失败保留上一份有效摘要）；模型侧 `memory_tree` 只读；VERIFY 不调用模型；用户可见文案必须来自真实模型调用并携带 provenance。
4. **权限与容器是独立 ceiling。** 三档模式只改变授权；容器是 Main 的路径分类与审批闸门（`inside`/`outside`/`unknown`），不是 OS 进程沙箱；核心源码是宿主级只读边界，完全访问与单次批准都不能绕过。
5. **缓存红线按稳态口径判定，实测未达标。** 红线数字、判定口径与冻结负载规程只在 [项目状态](project-status.md) 与 [缓存 95% 验收规程](../reference/cache-95-acceptance.md) 维护。

## 2. 评估口径

本报告使用四种状态，不使用缺乏权重定义的总百分比：

| 状态 | 含义 |
| --- | --- |
| 稳定基础 | 责任较清楚，有真实实现和测试，可在原边界内继续开发。 |
| 基础可用 | 主路径已接通，但接口、场景验收或边界仍需收敛。 |
| 职责分散 | 能力存在，但横跨多个模块，继续叠加会增加维护风险。 |
| 尚未实现 | 只有类型、入口、占位或规划，不能按已完成功能决策。 |

证据以当前源码为准；[项目状态](project-status.md) 记录最近验证结果。本报告不把未来目标写成当前事实，也不复制会随每次运行变化的测试数量与 token 读数。

## 3. 当前架构地图

```text
React Renderer
  -> Local App API / SSE
    -> Electron Main (product composition root)
      -> Runner (run lifecycle + core infrastructure composition)
        -> Harness (hard state flow: single main loop + capability reply)
          -> Context Engine (candidates + budget + cache-boundary split + tail ledger)
          -> LLM
          -> Tool Execution Service (registered tools, execution-scope admission)
          -> memory tree (read-only navigation; compaction owns writes)
          -> session / execution logs / checkpoints
      -> PluginHost
        -> tool contributions
        -> optional channel contributions
```

当前主流程的优点：

- Harness 决定状态转移，模型不能跳过权限、VERIFY 和 FINALIZE。
- 一次请求只有一条装配路径：缓存边界之上的段构成 system 消息，边界之下的段由同一个 append-only 账本追加，迭代只追加不重写。
- Runner 在每次 run 开始时装配会话、工作区、行为 profile、推理配置、工具和记忆根索引。
- 工具对象由注册表管理，所有副作用经统一 Tool Execution Service；插件工具与 run-scoped 工具走同一条管线。
- 记忆读取采用根索引、分支索引、节点展开和分支内深搜的路径；写入只发生在压缩路径。
- TaskBook、步骤、工具调用、验证和最终结果可进入执行日志并由 UI 恢复。

当前主流程的结构性限制：

- Runner 的基础设施构建同时负责 LLM、session、memory、vector、skills、tools 和 Harness 装配，改动影响面大。
- Mode 的各组成项没有统一 schema 和解析顺序。
- 工具运行时生命周期已收敛到 `@littlesheep/tools`，但网络资源权限、更强授权 token 和 MCP adapter 仍需在同一执行协议上补齐。
- Electron 的 Local App API、根 `App.tsx` 和全局 `styles.css` 是明显的变化集中点。
- 兼容 stage 名（`classify`/`decide`/`evolve`/`capture`）与旧检查点读取路径必须继续保留，直到不再需要读取历史记录。

## 4. 模块评估矩阵

| 能力域 | 当前状态 | 当前真相来源 | 主要缺口 | 下一项关键决策 |
| --- | --- | --- | --- | --- |
| 公共契约 | 稳定基础 | `packages/types/` | 内部 v1 契约已齐，Context 与 Tools 已有实际所有者；Mode Registry 仍未收敛 | 保持内部版本，迁移剩余生产者和消费者后再考虑公开 API |
| Workflow/Harness | 稳定基础；控制流已收敛为单一主循环 | `packages/harness/src/default-harness.ts`、`stages/`、`packages/types/src/agent.ts` | 兼容 stage 名与旧检查点读取路径仍在；权限、VERIFY 与 FINALIZE 仍是不可绕过的核心 | 保持兼容边界与单循环，不开放任意工作流图 |
| Runner | 基础可用 | `packages/runner/src/runner.ts`、`infra.ts` | 同时承担生命周期、核心装配和子系统启动 | 保持为应用服务，逐步下沉子系统内部逻辑 |
| Context | 基础可用；装配契约已收敛，命中率未达标 | `packages/context/`、`harness/context-candidates.ts`、`harness/run-tail-ledger.ts`、`harness/cache-prefix-split.ts`、`types/token-ledger.ts`、`model-observability.ts` | 缓存边界、尾部账本、固定工具目录、`appended-only` 淘汰与双账本已接通；实机命中率仍低于红线，Pro/其他 Provider 校准与持续成本基线未建 | 在安全契约不退化时继续压缩不可缓存部分，并按实际启用范围建立模型专用校准 |
| Prompt | 基础可用；缓存边界即 system 消息边界 | `packages/prompt/`、stage prompt、`harness/stages/reply.ts`、`harness/runtime-awareness.ts` | 边界之下的段全部改为独立追加消息；逐请求时钟、耗时和上一轮执行摘要已删除，时间由 `session_status` 按需返回 | 保持渐进披露：只向模型投影完成当前决策所需信息，并让边界之下的段保持追加语义 |
| Behavior Mode | 职责分散 | `prompt/profiles.ts`、Runner、config、App | 不是统一配置组合，新增 Mode 仍需跨模块修改 | 建立类型化 Mode registry，并与权限正交 |
| Permission Policy | 基础可用 | `packages/app/src/main/run-policy.ts`、`ToolContext`、`packages/tools/src/tool-execution-service.ts` | 统一服务已消费权限决议并执行单次批准；网络资源和更强授权 token 尚未建模 | 权限作为独立 ceiling，不进入行为 profile |
| Tool Registry | 稳定基础 | `packages/tools/src/registry.ts`、`packages/runner/src/run-tools.ts` | 注册、来源和 run-scoped 合并已保留到调用记录；插件/MCP 命名空间仍需版本化 | 保持 registry 只负责工具与来源，不吸收执行机制 |
| Tool Execution | 工程基线已完成 | `packages/tools/src/tool-execution-service.ts`、`tool-execution-{scheduler,control,records,result}.ts` | 已统一 schema、权限、批准、超时、中断、调度、清洗、事件和记录；某轮不得使用的能力在执行边界被拒绝 | Harness 保持编排，所有新工具复用此服务 |
| Memory Tree | 基础可用；读取只读、写入单一 | `packages/memory-tree/`、`memory-tool.ts`、Runner | `memory_tree` 五个只读动作；写入只经压缩路径；关系长期负载治理、Skill 治理与长尾表达待验收 | 继续扩展现有公共接口，不新建总包，也不新增模型侧写入工具 |
| Session | 基础可用 | `packages/session/`、`compaction.ts`、`compaction-store.ts` | 原子提交与前置条件已落地；真实 Provider 长会话质量、摘要失败与成本仍待验收 | 继续由 Context 策略驱动并补齐真实恢复场景 |
| Execution Log | 稳定基础 | `packages/runner/src/execution-log.ts` | 优先持久化统一服务产生的权威调用记录；旧日志才使用消息推断兼容路径 | 保持有界、脱敏和只读重放，不把日志默认注入上下文 |
| LLM Provider | DeepSeek 基础能力已实测 | `packages/llm/`、`packages/config/`、`packages/app/src/main/provider-calibration.ts` | 未配置的 OpenAI/GLM 不冒充已验收；Pro 工具协议与模型专用计数器未建立 | 保持 provider capability descriptor，按实际启用范围增加校准证据 |
| Plugin Host | 基础可用 | `packages/plugins/` | v1 已接通 `channel`/`tool`/声明式 `skill`；Skill 所有权跨 Host、Loader 和 Memory Service 协同 | 保持 owner-scoped 协议，新增贡献点前先实现完整消费方和生命周期 |
| External Channels | 基础可用 | `packages/channels/*` | 真实凭证和异常隔离场景仍需验收 | 保持纯适配器，不回到核心网关模式 |
| MCP | 尚未实现 | 当前无生产实现 | 原空骨架包已移除；统一工具执行前置条件已具备 | 从稳定 adapter 开始接入 Tool Execution Service，不建立独立执行管线 |
| Electron Main/API | 主要组合边界已分域 | `packages/app/src/main/` | `local-app-api-server.ts` 保持薄组合；窗口/托盘/关闭行为、活动任务聚合和生命周期路由已拆为独立模块，`index.ts` 仍承担全局启动装配 | 保持现有 feature 边界，继续缩小启动组合入口 |
| 开发环境管理 | 基础可用 | `packages/app/src/main/development-environments.ts`、设置页 | Electron 内置 Node 已可用，其他运行时的自动下载、签名校验和安装包分发未完成 | 先冻结导入/版本契约，再实现来源清单和按需下载 |
| Renderer | 职责分散 | `packages/app/src/renderer/App.tsx`、`styles.css` | 页面状态、导航、会话、设置和工作区编排集中 | 按 feature + shared primitives 渐进拆分 |

## 5. 关键问题分析

### 5.1 Context 与请求装配是最高优先级的结构问题

当前 `buildRunContext()` 读取最近会话、过滤工具消息、加载 bootstrap 文件并构建 `ToolContext`；`packages/prompt` 负责 system 提示，Runner 负责注入记忆根索引，`@littlesheep/context` 统一完成候选排序、预算、淘汰与脱敏快照。请求装配的当前契约是：

- system 消息**就是**缓存边界之上的 prompt 段（`stableText`/`stableSegments`）；边界之下的段——bootstrap、runtime facts、检索意图契约、压缩后的会话摘要——各自作为独立消息追加，由 append-only 尾部账本持有。
- 工具循环的第 N 次请求是第 N+1 次请求的字节前缀：迭代只追加，不重排、不改写本次 run 已经发出的内容。
- 上下文淘汰按 `appended-only` 作用域运行：只能丢弃本次请求追加的内容；若已发送前缀本身就超出模型窗口，请求显式失败，而不是被静默重编号。
- 工具目录在一个会话区间内固定。Provider 看到的是注册表目录，不随本轮措辞裁剪；某轮不得使用的能力在执行边界被拒绝——`admittedTools` 是执行范围，不是可见性范围。
- 逐请求时钟、耗时、当前轮工具计时和上一轮执行摘要不再注入；显式时间需求由 `session_status` 按需返回。

仍待闭环：Provider 侧的缓存命中率（实机负载低于红线）、Pro 与其他实际启用 Provider 的模型专用计数器与请求 framing 校准、持续成本基线，以及压缩用途与主循环前缀互不通用这一已知损失来源。现有 `ContextItem`、`ContextSnapshot`、`ContextBudget`、`TokenLedger` 与 Context Engine 继续作为唯一演进基础，不再另造第二条装配路径；精确本地 ledger、不可展示的保守安全估算和 Provider usage 三者必须保持类型与用途隔离。

### 5.2 Mode 方向正确，但术语和实现需要统一

当前已经正确区分：

- 通用/编程：行为 profile；
- 完全访问/研究/受限：权限策略。

这条边界必须保留。未来的 Mode 可以组合 Prompt、Workflow、Tools、Memory、Context、输出和模型默认值，但它只能声明"候选能力与策略"，不能授予权限。

权限策略还必须叠加一条独立的逻辑容器分类。产品语义上，活动完整应用数据根（默认 `.littlesheep`）是 LS 容器，`workplace/` 只是其中的默认工作区；用户主动选定的外部工作区仍是容器外，不能因为被选中就改变分类。完全访问从其他模式启用时先进行一次红色风险确认，之后对容器内外和 `unknown` 范围的普通读、写、改、删、执行免逐次批准；研究只对容器内读取免批准；受限所有操作都需批准。研究/受限在外部工作区启动时先跳过自动资源/文档索引，待具体访问获批后再继续，完全访问直接继续。当前实现由 Main、Safety、Harness、内置工具和终端共同执行权限策略，**不等同真实 Docker/OS 沙箱**；核心源码只读和危险命令硬拒绝高于所有策略。

建议把最终运行决议记录为一个不可变对象。当前 `packages/app/src/main/run-policy.ts` 已有一个范围较窄的 `ResolvedRunPolicy`，只解析行为 profile 与工具审批；它不是下面规划的完整运行决议，因此目标契约使用不同名称，避免同名异义：

```text
ResolvedRunConfig
  - behaviorModeId
  - permissionPolicyId
  - workflowStrategyId
  - contextStrategyId
  - memoryStrategyId
  - toolSelectionStrategyId
  - provider/model/reasoning
  - user/project overrides
```

所有消费者读取同一份决议，避免 UI、Runner、Prompt 和审批各自解释设置。

### 5.3 Tool Manager 不能只是一张注册表

ToolRegistry 只负责注册和来源。真正调用工具时的查找、参数 schema、权限与单次批准、超时、中断、资源冲突调度、输出清洗、事件和结构化记录已经迁入 `@littlesheep/tools` 的 `ToolExecutionService`。工具目录对模型固定，越权能力在执行边界被拒绝，因此"收窄能力"不再改变请求前缀。

Runner 继续自动发现实际 LS workspace 根，并把核心源码只读边界传给内置 `write`、`edit`、`exec`。统一服务在调用前执行宿主权限与批准决议，内置工具在实际动作前执行路径二次复核；一次批准通过 `approvalGranted` 传递，避免 `exec` 重复询问。

插件工具和 run-scoped 工具与内置工具走同一服务，并在 `ToolInvocationRecord` 中保留来源。未来 MCP 和自动化只能贡献工具描述、资源声明与 handler，再由统一服务执行；不得重新实现审批、超时、清洗或日志。

### 5.4 Memory 的问题不是"能力太少"，而是缺少消费接口

记忆树、仓库、兼容来源、向量、经验、安全和快照已经拆成多个包。继续拆包不会自动改善结构，反而可能让调用链更难追踪。

下一步应定义少量稳定用例：

- `beginRun()` / `finishRun()`；
- `rootIndex()` / `navigate()` / `expand()` / `deepSearch()` / `release()`；
- `getManagementSnapshot()`；
- `invalidate()` / `recover()`。

写入侧已经收敛：**压缩路径是持久记忆的唯一写入方**（`runner-finalize` → `compactSessionAfterRun` → `memoryService.write`，经 `resolveMemoryWriteEpistemic` 判定认识状态），模型侧没有写入工具，`memory_tree` 只有 `root_index` / `branch_index` / `expand` / `deep_search` / `release` 五个只读动作。摘要安装与覆盖区间是一次原子提交，带 predecessor / source-hash 前置条件，失败时保留上一份有效摘要；失败与重试的摘要尝试都计入 operation usage。

首批收敛已经完成：Runner 的 run 生命周期、bootstrap 注册、Agent 记忆工具、结构化写入和 App 记忆控制面都优先通过 `MemoryService`。旧 `memoryTree`、`memoryRepository` 和 `memoryWriteService` 字段暂时留在 Infrastructure 中兼容测试和迁移调用，新的第一方功能不得继续直接依赖它们。

版本化记忆注册表与 T0-T3 基础分级已经实现：T0 保持固定预算，普通记忆写入不能进入 T0；资源注册表只保存来源元数据，`resources` 分支沿现有索引导航读取正文。项目记忆三层策略已落地：完整权威数据留在可整体迁移的 LS 应用数据根，`workplace/` 只是默认工作区子目录；用户明确启用后，项目目录只生成经过层级、敏感内容和路径白名单过滤的私有派生投影；共享 Markdown 使用独立、更严格的置信度白名单。实体/关系 schema、方向语义、有界关系候选发现和证据封套已完成；仍未完成的是关系长期实际负载治理、实际 Provider 提案质量，以及 Skill 的语义去重、合并、收益治理和恢复队列。

### 5.5 Workflow 可配置必须晚于契约稳定

现有硬状态机是 LS 的可靠性资产，不应为了"Mode 可配置"直接改成任意节点图。完全自由的 Workflow 会让权限绕过、验证缺失、恢复循环和插件注入更难控制。

推荐保留不可绕过的核心安全约束，再让 Mode 选择有限的 stage strategy 或受测模板。例如：聊天轻量流、标准任务流、长任务流可以不同，但权限、VERIFY、失败边界和 FINALIZE 仍由核心保证。

长任务的连续执行协议已形成工程基线：用户事件在安全决策边界进入，普通追加消息、设置和工作区事件已接入 Renderer 生产入口；有界队列、确定性 `TaskBookPatch`、版本化 `RunCheckpoint`、Runner 显式续跑、应用启动恢复/放弃/查看现场、活动任务快照与控制、托盘、三档关闭策略和设置页"应用与后台"都已接通。**TaskBook 步骤不再并行调度**：步骤执行器与调度器已删除，持久化的 `task_book` 策略降级为 `bounded_loop` 并保留原 reason code，多步骤工作在唯一主循环内串行推进；工具调用级的有界并行仍是主循环内部能力。宿主工具调用默认超时 120 秒，配置上限 24 小时，并继续受 run 总超时、AbortSignal 和取消后的 1.5 秒有界清理约束；内置 `exec` 保留有界首尾输出并终止完整进程树。Local App API 的长连接使用有界待写缓冲与确定性资源清理；普通 Agent 观察连接断开不会取消 Main 持有的 run，终端主动命令仍在断连时取消。所有重试、验证和重规划循环必须继续受次数、时间、成本和无进展上限约束。

### 5.6 App 应按功能拆分，不应立即拆成更多 workspace 包

`local-app-api-server.ts`、`App.tsx` 和 `styles.css` 大，是维护风险，但它们大量逻辑仍只服务 Electron 产品。此时新建多个 workspace 包会增加构建、导出和协议成本。

优先在 `packages/app` 内形成：

```text
src/main/features/<feature>/
src/renderer/features/<feature>/
src/renderer/shared/
```

当某个模块同时被 CLI、插件或其他宿主复用，并拥有稳定公共接口时，再提升为独立 package。

## 6. 推荐实施顺序

以下顺序描述 **跨模块职责收敛工作线**，不是产品全部任务的唯一阶段编号。Context、记忆注册、附件、运行中重入、检查点和后台执行的原专项阶段号随《Agent Runtime 连续性任务书 2026-07-14》于 2026-09-24 退役（该任务书的机制多数已被单一主循环、只读记忆工具与"压缩唯一写入"取代，原文可取回：`git log --follow -- docs/taskbooks/agent-runtime-continuity-taskbook-2026-07-14.md`）；仍未闭环的方向已并入[项目状态](project-status.md) 的"未完成方向"，全局执行顺序以项目状态的"推荐后续顺序"为准。每个阶段的当前进度以本节状态和项目状态为准，不能只因类型或入口存在就视为完成。

### 阶段 0：特征基线与核心契约

状态：已完成。现有仓库已具备基础模块依赖方向检查、Mode/Permission 正交测试、核心 TaskBook 场景测试，以及 Context、附件、RuntimeEvent、TaskBookPatch、RunCheckpoint、`ModeDefinition`、`ResolvedRunConfig`、`ModelRequestSnapshot`、`ToolInvocationRecord` 和 `ExecutionEvidence` 的内部 v1 契约。所有 Harness LLM 请求均接入有界脱敏快照；旧执行日志、会话、记忆和 workspace 恢复路径已有兼容矩阵与测试证据。

目标：在移动代码之前，先固定当前行为和未来接口。

验收标准：只增加类型、测试和观测，不改变用户可见行为；现有测试、类型检查和构建保持通过。

### 阶段 1：Context Engine

状态：进行中。主要装配链路已完成：缓存边界之上的段构成 system 消息，边界之下的段由 append-only 尾部账本追加，工具目录会话内固定，淘汰限定在 `appended-only` 作用域，tokenizer 能力矩阵与 Provider/本地双账本已接通。阶段仍进行中，因为实机缓存命中率低于红线，Pro 与其他实际启用 Provider 的模型专用计数器、请求 framing 校准和持续成本基线尚未建立。

目标：形成上下文候选、预算、装配、压缩和来源记录的单一所有者。

建议边界：

- Harness 提交当前 run 需求，不再自行拼接完整消息；
- Prompt 只负责纯渲染，并明确声明哪些段在缓存边界之上；
- 边界之下的段一律走追加账本，不重排已发送内容；
- Memory 和 Session 通过端口提供候选内容；附件先以清单进入候选池，正文按步骤需要有界读取；
- 在安全决策边界消费有界运行时事件，并记录是否触发 Context 刷新或 TaskBook 差异；
- 本地 tokenizer ledger 与 Provider usage 分层保存和对账，并生成可持久化但可脱敏的 `ContextSnapshot`。

验收标准：同一输入的装配顺序可重复；迭代只追加；预算不会超模型上限，超窗时显式失败；每个注入项可追溯；Provider usage 与预检计数不会混淆。

完成前必须补齐：

- 保持 DeepSeek V4 官方 tokenizer、固定资源校验、最终请求 framing 和同请求 Provider 差值回归；其余模型只有在具备同等级证据时才注册 exact，否则保持 unavailable；
- 只在 OpenAI/GLM 实际配置并进入用户选择范围后，使用真实请求校准上下文窗口、reasoning、usage 与模型专用本地 ledger 差异；
- 按稳态口径追踪缓存红线，不用填充、预热或排除调用调整读数。

### 阶段 2：Tool Execution Service

目标：让所有副作用共享一条执行管线。

状态：工程基线已完成。统一服务已经接管内置、插件和 run-scoped 工具的查找、schema、权限、单次批准、超时、中断、调用级调度、结果清洗、事件和有界权威记录；Harness 只保留模型循环、TaskBook 编排和副作用检查点生命周期。工具目录对模型固定，越权能力在执行边界被拒绝。

建议边界：

- ToolRegistry 继续负责注册和来源；
- Tool Execution Service 负责解析、schema、权限、单次批准、超时、中断、调用级调度、清洗、记录和错误分类；
- 把现有核心源码只读校验提升为统一路径策略，使内置、插件和未来 MCP 工具共享宿主不可写边界；
- 逻辑容器边界基元已经接入：`containerRoot`、`inside/outside/unknown` 分类、动态命令 fail-closed、Main 终端复核和工具内部二次复核；后续仍需把网络权限和更强的单次授权 token 收入同一协议；
- Harness 负责步骤编排，不直接实现工具机制；App 只提供审批交互和 Permission Policy，不重复判断工具内部行为。

验收结论：内置、插件和 run-scoped 工具已使用同一种 `ToolInvocationRecord`；拒绝、中断、超时、未知工具、重复调用和异常均有稳定状态，记录有界且不保存完整输入输出。未来 MCP 复用同一服务、UI 完整重放和真实长任务恢复仍需各自验收。

### 阶段 3：Mode Registry 与运行决议

目标：新增一个 Behavior Mode 主要通过配置和策略注册完成。

状态：未开始。当前 Mode 仍是 profile 与策略 id 的组合结果，没有可注册、可迁移的 Mode Registry。

建议边界：

- 基于现有 `ModeDefinition` 和 `ResolvedRunConfig` 建立注册表；现有 App 层 `ResolvedRunPolicy` 在迁移期间保持窄职责或随后重命名；
- Mode 引用已注册的 prompt/workflow/context/memory/tool 策略 id；
- Permission Policy 独立叠加，永远是权限上限；
- Provider capability 决定模型、reasoning 和参数的最终可用范围。

验收标准：新增测试 Mode 不修改 Runner/Harness 主流程；同一 Mode 在 UI、Prompt、工具选择和执行日志中解析一致；切换权限不改变行为 profile。

### 阶段 4：Memory Service 与长会话压缩

目标：让记忆和会话成为 Context Engine 可控、可追溯的来源。

状态：主要工程闭环与正式迁移已完成，实际 Provider/长任务验收进行中。Memory v3 已接管统一 Repository facade、Memory Service、Runner 与 Harness；压缩契约已收敛为：run 结束后按压力触发（默认 `threshold 400`、`keepRecent 200`、`background false`），摘要与覆盖区间原子提交并带 predecessor / source-hash 前置条件，失败保留上一份有效摘要，压缩路径是持久记忆的唯一写入方。仍待验收的是真实 Provider 长会话质量、摘要生成失败、成本，以及关系长期负载治理。

建议边界：

- 在现有 memory-tree 边界上继续提供统一服务公共接口；
- 保持已落地的项目记忆三层字段、同步、冲突、清理、Git 忽略、稳定身份和可恢复路径重绑定契约；
- 压缩摘要继续保留来源消息范围、版本、模型、关键约束和校验信息，不能删除原始会话事实；
- 不新增模型侧记忆写入工具；需要写入时走压缩路径或用户明确操作；
- 默认本地生成 Embedding，Provider `/embeddings` 只在用户显式启用时允许；层级和 FTS 不依赖向量可用性。

验收标准：长会话压缩后，任务约束、未完成步骤、关键用户偏好和来源不丢失；失败可回退到上一份有效摘要；记忆 UI 与运行时仍操作同一份数据。

### 阶段 5：Workflow 策略化

目标：允许不同 Mode 选择受控工作流，而不牺牲硬安全边界。

状态：进行中。运行时事件队列、`TaskBookPatch`、版本化检查点、Runner 显式续跑、应用启动恢复控制面、活动任务控制、设置页入口、托盘、关闭策略和幂等副作用记录已经接通；TaskBook 步骤级并行已删除，步骤串行执行。仍缺受测工作流模板与统一的循环上限解析。

建议边界：

- 固定 ENTER、权限校验、VERIFY、RECOVER 上限和 FINALIZE 语义；
- 把可替换部分定义为 stage strategy 或受测模板；
- 工作流定义必须声明输入、输出、失败和恢复契约；
- 为重试、验证和重规划统一设置次数、时间、成本与无进展上限。

验收标准：简单任务不承担复杂任务开销；复杂任务不能跳过 TaskBook/VERIFY；任何 Mode 都不能绕过权限和收尾；追加要求不会丢失已完成证据；应用重启能从检查点继续且不重复副作用；循环达到上限后有边界地停止。

### 阶段 6：Electron App 渐进拆分

目标：降低主进程 API 和 Renderer 根组件的变化冲突。

状态：进行中。

建议顺序：

1. 先拆 Local App API 的 route registration、validation 和 feature handlers；
2. 再拆 Renderer 的 navigation、conversation、composer、settings、workspace feature；
3. 最后收敛 shared overlay、motion、tooltip 和 icon primitives；
4. 保持现有视觉与持久化行为，用截图和恢复测试防止交互回退；
5. 设置页"应用与后台"、活动任务列表和关闭策略已接入现有运行中事件、恢复 UI 和托盘；继续让记忆更新与 Context 双来源账本按渐进披露展示。

验收标准：根文件只负责组合；每个 feature 有明确状态所有者和 API；跨 feature 共享逻辑不复制；转场与恢复行为保持一致。

### 阶段 7：Plugin API v2、MCP 与生态

状态：未开始。

目标：在核心 Context/Tool/Mode/Memory 契约稳定后开放更广扩展。

建议顺序：

- 先让 MCP 工具复用 Tool Execution Service；
- 再评估 provider、memory、workspace、automation、renderer UI 贡献点；
- 最后决定 Plugin SDK 与 Host 是否拆包。

验收标准：插件停用或失败不影响核心；权限、数据目录、升级、卸载和错误隔离有明确语义；版本不兼容能够拒绝加载并给出可解释错误。

## 7. 需要用户决策的关键点

下面给出推荐默认项。只有到对应阶段时才需要最终确认，不要求现在一次性决定全部内容。

| 决策 | 选项 | 推荐 | 理由 |
| --- | --- | --- | --- |
| D1 Context Engine 放置 | 留在 Harness / 新建 `packages/context` | 已决定并实施：独立包 | Context 被 Runner、Workflow、Memory、Session 和观测共同使用，独立生命周期成立 |
| D2 Mode 定义形式 | 任意代码 / 类型化声明 + 注册策略 | 类型化声明 | 可检查、可展示、可迁移，且不会允许 Mode 绕过核心约束 |
| D3 Workflow 自定义程度 | 任意状态图 / 不可绕过的核心安全约束 + 模板 | 固定核心约束 + 模板 | 保留 LS 的可靠性和权限边界 |
| D4 Tool 执行归属 | 留在 EXECUTE / 统一 Tool Execution Service | 统一服务 | MCP、插件和内置工具必须共享一条安全管线 |
| D5 Memory 公共接口 | 立即新建总包 / 先在现有 memory-tree 暴露公共接口 | 先扩展现有边界 | 当前包已经较多，先收敛消费者比继续拆包更有价值 |
| D6 App 拆分方式 | 多 workspace 包 / app 内 feature 目录 | app 内 feature | 降低发布和协议成本，等复用事实出现后再升包 |
| D7 Plugin SDK/Host | 立即拆分 / API v2 前保持同包 | 暂缓拆分 | 避免为仍在变化的接口承担兼容成本 |
| D8 Token 真相 | 单一估算 / Provider usage + 精确本地 ledger 分层 | 分层 | 用户展示必须真实，预算又需要请求前保护；未知 tokenizer 不生成伪精确数字 |
| D9 Atom 动态层级 | 固定热层 / 后端连续 activation + 前端三层投影 | 后端连续、前端三层 | 文件、parent、披露深度和缓存压缩不能替代运行时价值；UI 使用滞回阈值保持稳定，不把三层写回后端 |
| D10 权限容器 | 真实 Docker/OS 沙箱 / 逻辑数据根边界 + 后续可叠加系统沙箱 | 逻辑数据根边界 | 先保证可迁移数据根、Main 复核、工具内复核和未知 fail-closed；不把尚未存在的进程隔离写成已完成能力 |
| D11 工具目录可见性 | 按本轮意图收窄 schema / 会话内固定目录 + 执行期拒绝 | 会话内固定 + 执行期拒绝（已实施） | 工具定义位于请求前缀内，随措辞变化的目录会让会话永远无法复用前缀；能力约束改由执行边界承担 |
| D12 缓存红线判定口径 | 含冷启动的总体值 / 稳态值（冷启动单独记录） | 稳态判定 + 冷启动单列并同时报告总体（已裁定） | 与同行做法一致，避免指标随会话长度而非实现质量波动；当前实机读数仍未达到红线 |

## 8. 现在做、暂缓做、不要做

### 现在做

- 先用冻结负载与稳态口径把缓存红线做成可复算判定，再据此决定压缩前缀的下一步。
- 按实际启用范围为 Pro 与其他 Provider 建立模型专用校准与成本基线。
- 在正式 V3 上继续验收真实会话写入、索引导航、验证反馈、向量维护与重启连续性。
- 给跨模块职责建立类型、来源和特征测试。
- 对大文件采用 feature 内渐进拆分，每次保持行为等价。
- 保持核心源码只读校验，直到隔离工作树、检查点、完整回归、用户审查和自动回滚全部具备后，再单独讨论受控自我修改。

### 暂缓做

- provider、memory、workspace、automation、UI 等 Plugin API v2 贡献点。
- Plugin SDK 与 Host 拆包。
- 任意可编程 Workflow 图。
- 为每个逻辑概念创建新的 workspace 包。
- 在 Context 来源与压缩契约未稳定前扩大 RAG 注入范围。

### 不要做

- 用更长 Prompt 代替权限、重试、上下文或工作流机制。
- 用填充上下文、重复预热、排除失败或辅助调用来抬高缓存比例。
- 让 App、渠道或插件直接写记忆内部存储。
- 为 UI 单独估算并展示无法追溯的"真实 token"。
- 让 MCP 或插件工具绕开统一审批和执行日志。
- 在缺少特征测试时一次性重写 Runner/Harness/Memory/App。
- 把"接口存在""配置可选"写成真实能力已经验收。
- 让 LS 直接修改正在运行的核心源码，或用完全访问模式绕过宿主级只读边界。

## 9. 风险与控制措施

| 风险 | 可能后果 | 控制措施 |
| --- | --- | --- |
| 过早大重构 | 当前可用流程回退、用户数据恢复失败 | 特征测试、行为等价迁移、小步合并、旧路径短期适配 |
| 过度拆包 | 依赖和版本管理复杂度超过收益 | 新包准入标准；优先包内模块化 |
| Mode 与权限混合 | 行为切换意外扩大权限 | 独立类型、独立 UI、最终权限 ceiling |
| Context 来源不透明 | "不失忆"不可验证、token 显示失真 | ContextSnapshot、来源账本、Provider usage 分层 |
| 缓存命中率长期不达标 | 成本与延迟高于预期，且容易用填充或预热掩盖 | 冻结负载、稳态口径、禁止做法清单与逐请求归因 |
| 请求前缀被逐轮改写 | 会话永远无法复用前缀，缓存收益归零 | 边界之上为 system 消息、边界之下走追加账本、工具目录会话内固定 |
| 记忆自动写入失控 | 错误事实长期固化 | 写入只经压缩路径、来源与认识状态校验、原子提交与失败保留上一份摘要 |
| 实体/关系误合并 | 跨项目、跨用户或跨权限信息污染 | 稳定实体 id、owner/scope、关系证据、D0-D3 披露和跨边界默认不传播 |
| Skill 自动治理误删 | 能力丢失、插件所有权破坏 | 合并建议先审查、停用优先、引用检查、保留期、版本回滚和来源文件保护 |
| Agent 自修改核心源码 | 运行版本损坏或无法启动 | 当前硬只读；未来仅允许隔离修改、完整验证、人工批准和自动回滚 |
| 项目内记忆投影泄露私有数据 | 密钥、用户画像或执行日志被误提交 | 私有权威数据默认留在用户数据目录、字段白名单、显式启用、提交风险提示和可撤销同步 |
| 插件扩展过快 | 核心被插件绑架、故障扩散 | 版本化 Host、默认不信任、错误隔离、无插件回归 |
| App 拆分破坏交互 | 动画、布局、恢复出现细小回退 | 持久化契约测试、截图/交互验收、逐 feature 迁移 |

## 10. 下一阶段推进条件

以下工程能力已完成既定验收，不再是阻塞项：仓库基元化阶段 0-7、Memory v3 阶段 0-26、单一主循环与两路径活动路由、缓存边界与 append-only 尾部账本、固定工具目录与执行期拒绝、统一 Tool Execution Service、原子压缩与唯一记忆写入方、无模型调用的 VERIFY 判定、运行时事件与 `TaskBookPatch`、检查点续跑与应用启动恢复、活动任务控制、设置页"应用与后台"、托盘与三档关闭策略。

当前首要验收项：缓存 95% 红线（实机负载未达标，压缩用途与主循环前缀互不通用）、Pro 与其他 Provider 的模型专用校准、非字段事实的普遍连续性、外部系统副作用、长期真实用户负载。在这些契约稳定前不扩张新插件类型或无关 UI 范围。推进时持续遵守：

- 以 [架构原则](../principles/architecture-principles.md) 作为最高层工程规范；
- Behavior Mode 与 Permission Policy 保持正交；
- 保留不可绕过的核心安全约束，不把 Workflow 直接开放为任意图；
- 保护现有用户数据与插件化改动，不做破坏式迁移；
- 不把接口存在、配置可选或旧检查点兼容路径写成已完成的当前能力。

## 11. 报告维护规则

- 本报告用于阶段决策，架构稳定原则以 [architecture-principles.md](../principles/architecture-principles.md) 为准。
- 当前能力和验证数字只在 [project-status.md](project-status.md) 维护，本报告不复制测试数量。
- 目录和文件归属只在 [repository-guide.md](../reference/repository-guide.md) 维护。
- 每完成一个架构阶段，更新本报告对应矩阵、风险和下一决策；不要另建一次性总结文档。
- 若实施结果证明推荐方向不成立，应记录证据并修改建议，而不是为了维持文档一致而保留错误架构。
