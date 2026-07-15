# LittleSheep 架构评估与开发决策报告

最后更新：2026-07-15
评估范围：当前源码、正式文档与已记录的验证结果
执行状态：仓库基元化阶段 0-7 已完成；Context Engine、LLM Call Contract、记忆意图闸门和 29 项持续质量门已落地，真实 Provider 校准仍待完成

## 1. 给决策者的结论

LittleSheep 当前不是“只有 Prompt 的聊天壳”。它已经具备代码控制的 Harness、TaskBook、工具执行、索引优先记忆树、会话持久化、执行日志、Electron UI 和插件宿主，方向与“LLM 负责推理、Agent 负责兑现”基本一致。

所有后续架构取舍都应服务于同一项产品使命：**解放用户生产力，让用户着重于想法的产生，LS 负责让用户的想法落地。** 因此，检索、规划、执行、验证、整理和记忆维护应尽量由运行时承担；用户应保留目标取舍、风险接受、权限授予和关键判断权。模块化不是为了增加内部形式，而是为了让自动化更可靠、过程更可追溯、用户更少承担低价值的操作负担。

但当前更准确的描述是：

> **包级模块骨架、调用契约与仓库质量门已经稳定；工具执行、运行时连续性和 Mode Registry 仍需继续收敛。**

当前最重要的结构结论是：

1. Context Engine 已成为独立模块并接管模型请求准备路径；每次请求现在拥有版本化 `LlmCallContract`，Context segment、工具集合、输出预算和记忆策略在发送前失败关闭。tokenizer 能力矩阵与 unavailable 模型的保守请求前预算保护已经完成，当前缺口是三家真实 Provider 对账。
2. 每次 run 已有统一、不可变的运行决议，但 Behavior Mode 仍只是 profile 与策略 id 的组合结果，尚没有可注册、可迁移的 Mode Registry。
3. Tool Manager 只有注册与基础 wrapper，完整的授权、调用、超时、流式事件和执行证据仍主要位于 Harness/App。
4. Memory 子系统已经具备统一 `MemoryService`、T0-T3 注册协议、Summary Memory/附件的非复制式资源登记、项目记忆三层投影与控制面，以及稳定项目身份和可恢复路径重绑定。模型提出的记忆操作与运行时提交权现已分离，判定证据进入执行日志；`PHILOSOPHY.md` 作为按需理念资源接入。运行时事件账本的登记与 resolver 端口已经建立，但实时队列、真实长会话和正式用户迁移场景仍待验收。

因此，不建议立即把所有目录重新拆包，也不建议继续在现有大文件上叠加功能。当前应先完成真实 Provider 验收，再在已稳定的调用契约上收敛统一 Tool Execution Service；随后实现 RuntimeEventQueue、检查点与重启续跑。这样既保护当前可运行能力，也能让有界并行、MCP、插件和持续学习建立在稳定接口上。

## 2. 评估口径

本报告使用四种状态，不使用缺乏权重定义的总百分比：

| 状态 | 含义 |
| --- | --- |
| 稳定基础 | 责任较清楚，有真实实现和测试，可在原边界内继续开发。 |
| 基础可用 | 主路径已接通，但接口、场景验收或边界仍需收敛。 |
| 职责分散 | 能力存在，但横跨多个模块，继续叠加会增加维护风险。 |
| 尚未实现 | 只有类型、入口、占位或规划，不能按已完成功能决策。 |

证据以当前源码为准；[项目状态](project-status.md) 记录最近测试与构建结果。本报告不把未来目标写成当前事实。

## 3. 当前架构地图

```text
React Renderer
  -> Local App API / SSE
    -> Electron Main (product composition root)
      -> Runner (run lifecycle + core infrastructure composition)
        -> Harness (hard state flow)
          -> Context Engine (candidate ordering + budget + snapshots)
          -> LLM
          -> registered tools
          -> memory tree/write service
          -> session/execution logs
      -> PluginHost
        -> tool contributions
        -> optional channel contributions
```

当前主流程的优点：

- Harness 决定状态转移，模型不能跳过 VERIFY、权限和 FINALIZE。
- Runner 在每次 run 开始时装配会话、工作区、行为 profile、推理配置、工具和记忆根索引。
- 工具对象由注册表管理，插件工具可迁移到 Runner，渠道不再是核心依赖。
- 记忆读取已经采用根索引、分支索引、节点展开和分支内深搜的路径。
- TaskBook、步骤、工具调用、验证和最终结果可进入执行日志并由 UI 恢复。

当前主流程的结构性限制：

- Stage 仍负责构造语义消息，但模型请求已统一经过 Context Engine；System Prompt segment、摘要和附件清单已经可追溯，本地与 Provider token 账本也已分开保存。非图片附件通过 run-scoped 工具按需读取；tokenizer 能力矩阵和 unavailable 模型保守预算保护已完成，运行中事件候选仍未完成。
- Runner 的基础设施构建同时负责 LLM、session、memory、vector、skills、tools 和 Harness 装配，改动影响面大。
- Mode 的各组成项没有统一 schema 和解析顺序。
- 工具完整生命周期跨 `tools`、`harness` 和 `app`，难以保证未来 MCP/插件完全复用同一行为。
- Electron 的 Local App API、根 `App.tsx` 和全局 `styles.css` 是明显的变化集中点。

## 4. 模块评估矩阵

| 能力域 | 当前状态 | 当前真相来源 | 主要缺口 | 下一项关键决策 |
| --- | --- | --- | --- | --- |
| 公共契约 | 稳定基础 | `packages/types/` | 内部 v1 契约已齐，但 Context/Tools/Mode 的实际所有者尚未按契约收敛 | 保持内部版本，迁移生产者和消费者后再考虑公开 API |
| Workflow/Harness | 稳定基础 | `packages/harness/src/default-harness.ts`、`stages/` | stage 策略与默认 Harness 装配绑定，尚不能按 Mode 选择 | 固定安全脊柱，还是允许完全自定义图；建议前者 |
| Runner | 基础可用 | `packages/runner/src/runner.ts`、`infra.ts` | 同时承担生命周期、核心装配、记忆运行时启动和工具选择 | 把 Runner 保持为应用服务，逐步下沉子系统内部逻辑 |
| Context | 基础可用，阶段 1 待供应商验收 | `packages/context/`、`harness/context-candidates.ts`、`model-observability.ts`、`config/model-capabilities.ts` | 已有确定性候选、来源 segment、已知/未知窗口、显式 tokenizer 能力矩阵、可注入精确计数、不可展示的保守预算保护、预算淘汰、版本化摘要、附件清单、按需附件工具、压缩阈值设置和双账本 UI；缺真实 Provider 对账 | 完成 Context Engine 供应商验收 |
| Prompt | 基础可用 | `packages/prompt/`、stage prompt | 基础 Prompt 与 stage 专用 Prompt 并存，策略来源容易重复 | Prompt 只渲染模型需要知道的策略投影 |
| Behavior Mode | 职责分散 | `prompt/profiles.ts`、Runner、config、App | 不是统一配置组合，新增 Mode 仍需跨模块修改 | 建立类型化 Mode registry，并与权限正交 |
| Permission Policy | 基础可用 | `packages/app/src/main/run-policy.ts`、ToolContext | 产品层审批与工具执行边界仍需统一 | 权限作为独立 ceiling，不进入行为 profile |
| Tool Registry | 稳定基础 | `packages/tools/src/registry.ts` | 主要解决注册/查找，不是完整 Tool Manager | 保留 registry，增加统一 Tool Execution Service |
| Tool Execution | 职责分散 | `packages/tools/`、`harness/stages/execute.ts`、App 审批 | timeout、授权、事件、证据和重试缺少单一所有者 | 执行机制归 `tools` 服务，Harness 只编排 |
| Memory Tree | 基础可用，职责收敛进行中 | `packages/memory-tree/`、`memory-core/`、Runner | Memory Service 已接管首批消费者，Summary Memory、run-scoped 附件、运行时事件账本登记端口、项目记忆三层投影和稳定项目身份已统一；实时事件生产与通用资源治理尚未闭环 | 继续扩展现有门面，不新建总包 |
| Session | 基础可用 | `packages/session/` | 已有非破坏式版本化摘要和增量合并，但真实长会话、失败回退与 Provider 成本仍待验收 | 继续由 Context 策略驱动并补齐恢复场景 |
| Execution Log | 稳定基础 | `packages/runner/src/execution-log.ts` | 已记录运行决议、请求/Context 快照和派生工具证据，但工具生命周期仍由多处生成 | 随 Tool Execution Service 收敛实时证据，不把日志默认注入上下文 |
| LLM Provider | 基础可用 | `packages/llm/`、`packages/config/` | 真实模型能力、reasoning 和 usage 映射仍待验收 | 建立 provider capability descriptor |
| Plugin Host | 基础可用 | `packages/plugins/` | v1 已接通 `channel`/`tool`/声明式 `skill`；Skill 所有权跨 Host、Loader 和 Memory Service 协同 | 保持 owner-scoped 协议，新增贡献点前先实现完整消费方和生命周期 |
| External Channels | 基础可用 | `packages/channels/*` | 真实凭证和异常隔离场景仍需验收 | 保持纯适配器，不回到核心网关模式 |
| MCP | 尚未实现 | `packages/mcp/` | 只有骨架 | 必须复用 Tool Execution Service 后再实现 |
| Electron Main/API | 职责分散 | `packages/app/src/main/` | `local-app-api-server.ts` 路由和用例集中 | 先按 feature 拆 handler/service，不新建大量包 |
| Renderer | 职责分散 | `packages/app/src/renderer/App.tsx`、`styles.css` | 页面状态、导航、会话、设置和工作区编排集中 | 按 feature + shared primitives 渐进拆分 |

## 5. 关键问题分析

### 5.1 Context 是最高优先级的结构问题

当前 `buildRunContext()` 仍会读取最近会话、过滤工具消息、加载 bootstrap 文件并构建 `ToolContext`；`packages/prompt` 负责 System Prompt，各 stage 仍负责形成语义消息，Runner 负责注入记忆根索引。模型请求随后被映射为显式 Context 候选，并由 `@littlesheep/context` 统一排序、预算和生成脱敏快照。System Prompt 已能把基础策略、记忆根索引、bootstrap 文件、输出约束、Workflow/TaskBook、行为 profile 和 reasoning 分别登记为 segment；版本化 Summary Memory 也作为独立来源进入后续请求。

阶段 1 已形成主要数据链：Provider usage 会绑定到产生它的准确 Context 快照；UI 区分供应商实测、本地精确装配和 tokenizer 不可用；长会话压缩保留原始 JSONL，只在元数据中保存版本化摘要；压缩阈值已经接入 Local App API 与设置页；非图片附件通过当前 run 专属工具按需读取，未调用时不解析正文。新导入附件已进入独立受管缓存，run 只能使用经稳定 cache id、路径、普通文件、大小和哈希重新验证的缓存项，旧 workplace 与外部用户文件不属于自动清理范围；workplace 资源索引已使用有界目录批次、持久化游标、精确变更提示和资源树元数据入口，正文仍由显式文件工具读取。完整数据根迁移已接入启动前恢复路径，失败不切换活动目录。Provider reasoning/capability 契约回归、tokenizer 能力矩阵和 unavailable 模型保守预算保护已经完成；真实 Provider 校准、运行中事件队列和安全重入协议仍未完成。

系统现在已经可以从快照和执行日志回答大部分请求级问题，但仍需继续闭环：

- 这一轮究竟向模型发送了哪些内容；
- 每项内容来自哪里；
- 哪些内容因预算被舍弃；
- 记忆、历史、工具结果分别占多少；
- 上下文显示的 token 是供应商实测还是本地预检。
- 附件哪些只是已注册、哪些已读取正文、为什么介入，以及磁盘解析是否真的延迟到需要时；
- 运行中发生的新事件是否已被采纳，以及它修改了哪些未完成步骤。

现有 `ContextItem`、`ContextSnapshot`、`ContextBudget`、`TokenLedger`、`AttachmentManifest`、`RuntimeEvent` 与 Context Engine 应继续作为唯一演进基础，不再另造第二条装配路径。精确本地 ledger 和不可展示的保守安全估算用于请求前的不同场景，Provider usage 用于请求后服务端对账；三者必须保持类型和用途隔离，不能互相冒充。下一步完成真实模型校准和 Provider 对账，而不是增加第二条装配路径。

### 5.2 Mode 方向正确，但术语和实现需要统一

当前已经正确区分：

- 通用/编程：行为 profile；
- 完全访问/研究/受限：权限策略。

这条边界必须保留。未来的 Mode 可以组合 Prompt、Workflow、Tools、Memory、Context、输出和模型默认值，但它只能声明“候选能力与策略”，不能授予权限。

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

阶段 0 已消除 DECIDE 未接收 reasoning addon 的分歧，并由 `ResolvedRunConfig` 固化本轮选择。DECIDE 当前仍使用 `1800` 的规划输出上限，但该值会被 `ModelRequestSnapshot` 如实记录；阶段 1 应结合 Provider capability、模型上下文窗口和输出预算统一解析，而不是让各 stage 长期维护独立常量。

### 5.3 Tool Manager 不能只是一张注册表

当前 ToolRegistry 的边界清楚，`withToolTiming()` 也统一了基础异常处理；但真正调用工具时的参数处理、权限、超时、事件、结果持久化和步骤状态主要在 `EXECUTE` 中完成。

这在只有内置工具时尚可维护，但 MCP、插件工具和自动化加入后，会出现多条执行路径。正确方向不是让每种扩展自己实现审批，而是让它们都贡献工具描述和 handler，再由统一 Tool Execution Service 执行。

### 5.4 Memory 的问题不是“能力太少”，而是缺少消费门面

记忆树、仓库、兼容来源、写入服务、向量、经验、安全和快照已经拆成多个包。继续拆包不会自动改善结构，反而可能让调用链更难追踪。

下一步应定义少量稳定用例：

- `beginRun()` / `finishRun()`；
- `rootIndex()` / `navigate()` / `expand()` / `deepSearch()`；
- `writeIntents()`；
- `getManagementSnapshot()`；
- `invalidate()` / `recover()`。

首批收敛已经完成：Runner 的 run 生命周期、bootstrap 注册、Agent 记忆工具、结构化写入和 App 记忆控制面都优先通过 `MemoryService`。旧 `memoryTree`、`memoryRepository` 和 `memoryWriteService` 字段暂时留在 Infrastructure 中兼容测试和迁移调用，新的第一方功能不得继续直接依赖它们。内部仍可使用 memory-tree、memory-core、vector、experience、safety 和 snapshot。

版本化记忆注册表与 T0-T3 基础分级已经实现：T0 保持固定预算，普通记忆写入不能进入 T0；v1 文档在保留 T1-T3 数值的前提下迁移到 v2，并在原子切换前生成回滚备份；未知未来版本拒绝覆盖。资源注册表只保存来源元数据，`resources` 分支沿现有索引导航读取正文，UI 与运行时读取同一份注册表。Summary Memory 已按 session scope 登记并以会话元数据为正文权威来源；附件清单和单项附件按 run scope 登记，正文只存在于活动 run 内存或专用读取结果中，执行日志仅关联有界资源 ID。运行时事件账本同样使用 run scope，只登记事件数量、类型、顺序和状态；payload 值仍由未来的事件队列持有，resolver 展开只提供受控摘要。项目记忆三层策略也已落地：完整权威数据留在 LS 用户数据目录；用户明确启用后，项目目录只生成经过层级、敏感内容和路径白名单过滤的私有派生投影；共享 Markdown 使用独立、更严格的置信度白名单。控制面显示同步、缺失、冲突和 Git 忽略状态，覆盖与移除需要确认，且移除只作用于 LS 最后验证写入的文件。新项目 ID 已与路径解耦，旧 ID 保持兼容；持久化重绑定事务会在项目移动或重命名后迁移会话、归档、记忆、投影和工作区关联。仍未完成的是实时事件队列和其他资源类型的完整治理。

### 5.5 Workflow 可配置必须晚于契约稳定

现有硬状态机是 LS 的可靠性资产，不应为了“Mode 可配置”直接改成任意节点图。完全自由的 Workflow 会让权限绕过、验证缺失、恢复循环和插件注入更难控制。

推荐保留不可绕过的安全脊柱，再让 Mode 选择有限的 stage strategy 或受测模板。例如：聊天轻量流、标准任务流、长任务流可以不同，但权限、VERIFY、失败边界和 FINALIZE 仍由核心保证。

长任务还需要补齐连续执行协议：用户追加消息只在安全决策边界进入，生成 TaskBook 差异而不是替换整本任务书；无依赖、无资源冲突且权限明确的就绪步骤可以在硬并发上限内并行；暂停、中断、进程异常和应用重启通过版本化检查点恢复；所有并行分支、重试、验证和重规划循环同时受次数、时间、成本和无进展上限约束。当前 `AbortSignal` 和步骤级局部恢复可作为基础，但不能等同于活动 run 重启续跑或有界并行调度。

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

以下顺序描述 **跨模块职责收敛工作线**，不是产品全部任务的唯一阶段编号。Context、记忆注册、附件、运行中重入、检查点和后台执行使用 [Agent Runtime 连续性任务书 2026-07-14](agent-runtime-continuity-taskbook-2026-07-14.md) 的独立阶段号；全局执行顺序以 [项目状态](project-status.md) 的“推荐后续顺序”为准。每个阶段的当前进度以本节状态和项目状态为准，不能只因类型或入口存在就视为完成。

### 阶段 0：特征基线与核心契约

状态：已完成。现有仓库已具备基础模块依赖方向检查、Mode/Permission 正交测试、核心 TaskBook 场景测试，以及 Context、附件、RuntimeEvent、TaskBookPatch、RunCheckpoint、`ModeDefinition`、`ResolvedRunConfig`、`ModelRequestSnapshot`、`ToolInvocationRecord` 和 `ExecutionEvidence` 的内部 v1 契约。所有 Harness LLM 请求均接入有界脱敏快照；旧执行日志、会话、记忆和 workspace 恢复路径已有兼容矩阵与测试证据。

目标：在移动代码之前，先固定当前行为和未来接口。

建议产物：

- Context、Mode、Tool Invocation、Execution Evidence 的内部 v1 类型草案；当前已完成的运行决议、模型请求、工具调用和连续性契约位于 `packages/types/src/runtime-contracts.ts`；
- `AttachmentManifest`、`RuntimeEvent`、`TaskBookPatch` 和 `RunCheckpoint` 的内部契约草案；
- 当前 DECIDE/EXECUTE/REPLY 上下文组装的特征测试；
- Mode 与 Permission 正交的契约测试；
- 内置工具、插件工具的统一生命周期场景表；
- 扩充现有架构依赖规则检查，使后续新增 Context/Tool/Mode 模块也受到同一方向约束。

验收标准：只增加类型、测试和观测，不改变用户可见行为；现有测试、类型检查和构建保持通过。

### 阶段 1：Context Engine

状态：进行中。主要实现已存在，Provider reasoning/capability 契约回归、tokenizer 能力矩阵和 unavailable 模型的保守预算保护已经完成；真实 Provider 对账尚未完成。

目标：形成上下文候选、预算、装配、压缩和来源记录的单一所有者。

建议边界：

- 新建 `packages/context/` 的前提是 v1 契约已经稳定；
- Harness 提交当前 run 需求，不再自行拼接完整消息；
- Prompt 只负责纯渲染；
- Memory 和 Session 通过端口提供候选内容；
- 附件先以清单进入候选池，正文和图像按步骤需要有界读取；
- 在安全决策边界消费有界运行时事件，并记录是否触发 Context 刷新或 TaskBook 差异；
- 本地 tokenizer ledger 与 Provider usage 分层保存和对账；
- 生成可持久化但可脱敏的 `ContextSnapshot`。

验收标准：同一输入的装配顺序可重复；预算不会超模型上限；每个注入项可追溯；Provider usage 与预检计数不会混淆。

完成前必须补齐：

- 为存在可验证 tokenizer 的 provider/model 注册精确计数；其余模型明确标记 unavailable，并验证保守预算与 UI 不产生伪精确数字；
- 使用真实 OpenAI、DeepSeek、GLM 请求校准上下文窗口、reasoning、usage 与本地 ledger 差异；

### 阶段 2：Tool Execution Service

目标：让所有副作用共享一条执行管线。

建议边界：

- ToolRegistry 继续负责注册和来源；
- Tool Execution Service 负责解析、schema、权限、超时、中断、清洗、记录和错误分类；
- Harness 负责步骤编排，不直接实现工具机制；
- App 只提供审批交互和 Permission Policy，不重复判断工具内部行为。

验收标准：内置、插件及未来 MCP 工具使用同一种 `ToolExecutionRecord`；拒绝、中断、超时和异常都能稳定恢复并在 UI 重放。

依赖说明：Runtime 连续性工作线可以先完成 T0-T3 记忆注册、Summary Memory 和附件清单，但在进入“运行中用户事件重入”和“检查点恢复”之前，必须完成本阶段，避免恢复逻辑建立在分散的权限与副作用语义上。

### 阶段 3：Mode Registry 与运行决议

目标：新增一个 Behavior Mode 主要通过配置和策略注册完成。

建议边界：

- 基于现有 `ModeDefinition` 和 `ResolvedRunConfig` 建立注册表；现有 App 层 `ResolvedRunPolicy` 在迁移期间保持窄职责或随后重命名；
- Mode 引用已注册的 prompt/workflow/context/memory/tool 策略 id；
- Permission Policy 独立叠加，永远是权限上限；
- Provider capability 决定模型、reasoning 和参数的最终可用范围。

验收标准：新增测试 Mode 不修改 Runner/Harness 主流程；同一 Mode 在 UI、Prompt、工具选择和执行日志中解析一致；切换权限不改变行为 profile。

### 阶段 4：Memory Service 与长会话压缩

目标：让记忆和会话成为 Context Engine 可控、可追溯的来源。

状态：进行中。Memory Service、T0-T3 基础注册、v1→v2 安全迁移、资源索引分支、管理 UI、Summary Memory/run-scoped 附件统一注册、运行时事件账本登记/resolver 端口、项目记忆三层投影、稳定项目身份、路径重绑定、通用资源生命周期、插件/Skill 所有权迁移和大规模资源恢复验收已落地；长会话真实验收和实时事件队列仍待完成。

建议边界：

- 在现有 memory-tree 边界上先提供统一服务门面；
- 增加记忆资源注册表和 T0-T3 协议，以版本化迁移映射现有 T1-T3 数据；
- 保持已落地的项目记忆三层字段、同步、冲突、清理、Git 忽略、稳定身份和可恢复路径重绑定契约；通用资源沿用统一状态、重新定位、冲突保护和有界审计，插件/Skill 已由 owner-scoped 协议驱动，数据根迁移继续保持外部 locator 与活动元数据重绑定边界；
- 以现有 `packages/session/src/compaction.ts` 的非破坏式版本化摘要为基线，补齐真实长会话、失败回退、成本和恢复验收；
- 压缩摘要继续保留来源消息范围、版本、模型、关键约束和校验信息，不能删除原始会话事实；
- daily 到长期记忆的蒸馏走结构化写入闸门。

验收标准：长会话压缩后，任务约束、未完成步骤、关键用户偏好和来源不丢失；失败可回退到原消息；记忆 UI 与运行时仍操作同一份数据。

### 阶段 5：Workflow 策略化

目标：允许不同 Mode 选择受控工作流，而不牺牲硬安全边界。

建议边界：

- 固定 ENTER、权限闸门、VERIFY、RECOVER 上限和 FINALIZE 语义；
- 把可替换部分定义为 stage strategy 或受测模板；
- 工作流定义必须声明输入、输出、失败和恢复契约。
- 增加运行中事件队列、TaskBook 差异修订、版本化检查点和幂等副作用记录；
- 为 TaskBook 定义依赖、资源读写集合和有界并行调度；同一资源冲突写入和顺序验证保持串行；
- 为重试、验证和重规划统一设置次数、时间、成本与无进展上限。

验收标准：简单任务不承担复杂任务开销；复杂任务不能跳过 TaskBook/VERIFY；任何 Mode 都不能绕过权限和收尾；追加要求不会丢失已完成证据；并行执行不产生资源冲突且与串行执行得到等价验收结论；应用重启能从检查点继续且不重复副作用；循环和并发达到上限后有边界地停止。

### 阶段 6：Electron App 渐进拆分

目标：降低主进程 API 和 Renderer 根组件的变化冲突。

建议顺序：

1. 先拆 Local App API 的 route registration、validation 和 feature handlers；
2. 再拆 Renderer 的 navigation、conversation、composer、settings、workspace feature；
3. 最后收敛 shared overlay、motion、tooltip 和 icon primitives；
4. 保持现有视觉与持久化行为，用截图和恢复测试防止交互回退。
5. 为运行中事件、记忆更新、Context 双来源账本、后台任务和托盘状态提供渐进披露的统一控制面。

验收标准：根文件只负责组合；每个 feature 有明确状态所有者和 API；跨 feature 共享逻辑不复制；转场与恢复行为保持一致。

### 阶段 7：Plugin API v2、MCP 与生态

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
| D3 Workflow 自定义程度 | 任意状态图 / 固定安全脊柱 + 模板 | 固定脊柱 + 模板 | 保留 LS 的可靠性和权限边界 |
| D4 Tool 执行归属 | 留在 EXECUTE / 统一 Tool Execution Service | 统一服务 | MCP、插件和内置工具必须共享一条安全管线 |
| D5 Memory 门面 | 立即新建总包 / 先在现有 memory-tree 暴露门面 | 先扩展现有边界 | 当前包已经较多，先收敛消费者比继续拆包更有价值 |
| D6 App 拆分方式 | 多 workspace 包 / app 内 feature 目录 | app 内 feature | 降低发布和协议成本，等复用事实出现后再升包 |
| D7 Plugin SDK/Host | 立即拆分 / API v2 前保持同包 | 暂缓拆分 | 避免为仍在变化的接口承担兼容成本 |
| D8 Token 真相 | 单一估算 / Provider usage + 精确本地 ledger 分层 | 分层 | 用户展示必须真实，预算又需要请求前保护；未知 tokenizer 不生成伪精确数字 |

## 8. 现在做、暂缓做、不要做

### 现在做

- 给跨模块职责建立类型、来源和特征测试。
- 先解决 Context 可观测性，再做上下文压缩和 Mode 扩展。
- 把插件化后的真实架构作为回归基线，持续验证“无插件仍可运行”。
- 用真实 Provider 冒烟建立 usage、reasoning、工具调用和中断基线。
- 对大文件采用 feature 内渐进拆分，每次保持行为等价。

### 暂缓做

- provider、memory、workspace、automation、UI 等 Plugin API v2 贡献点。
- Plugin SDK 与 Host 拆包。
- 任意可编程 Workflow 图。
- 为每个逻辑概念创建新的 workspace 包。
- 在 Context 来源和压缩契约未稳定前扩大 RAG 注入范围。

### 不要做

- 用更长 Prompt 代替权限、重试、上下文或工作流机制。
- 让 App、渠道或插件直接写记忆内部存储。
- 为 UI 单独估算并展示无法追溯的“真实 token”。
- 让 MCP 或插件工具绕开统一审批和执行日志。
- 在缺少特征测试时一次性重写 Runner/Harness/Memory/App。
- 把“接口存在”“配置可选”写成真实能力已经验收。

## 9. 风险与控制措施

| 风险 | 可能后果 | 控制措施 |
| --- | --- | --- |
| 过早大重构 | 当前可用流程回退、用户数据恢复失败 | 特征测试、行为等价迁移、小步合并、旧路径短期适配 |
| 过度拆包 | 依赖和版本管理复杂度超过收益 | 新包准入标准；优先包内模块化 |
| Mode 与权限混合 | 行为切换意外扩大权限 | 独立类型、独立 UI、最终权限 ceiling |
| Context 来源不透明 | “不失忆”不可验证、token 显示失真 | ContextSnapshot、来源账本、Provider usage 分层 |
| Memory 自动写入失控 | 错误事实长期固化 | 索引写入闸门、来源、置信度、合并、恢复和用户管理 |
| 项目内记忆投影泄露私有数据 | 密钥、用户画像或执行日志被误提交 | 私有权威数据默认留在用户数据目录、字段白名单、显式启用、提交风险提示和可撤销同步 |
| 并行调度失控 | 冲突写入、重复副作用、资源泄漏和结果不稳定 | 依赖图、读写集合、硬并发上限、分支取消、幂等记录和稳定归并 |
| Plugin 扩展过快 | 核心被插件绑架、故障扩散 | 版本化 Host、默认不信任、错误隔离、无插件回归 |
| App 拆分破坏交互 | 动画、布局、恢复出现细小回退 | 持久化契约测试、截图/交互验收、逐 feature 迁移 |

## 10. 下一阶段推进条件

仓库基元化阶段 0-7 已完成，当前工作树质量门为绿色。建议先完成 Context Engine 的真实供应商校准，再进入统一 Tool Execution Service，而不是提前扩张新插件类型或 UI 范围。推进时持续遵守：

- 以 [架构原则](architecture-principles.md) 作为最高层工程规范；
- Behavior Mode 与 Permission Policy 保持正交；
- 保留固定安全脊柱，不把 Workflow 直接开放为任意图；
- 保护现有用户数据与插件化改动，不做破坏式迁移。

Context Engine 已完成候选端口、预算器、稳定装配顺序、来源分段、版本化摘要、附件清单优先、按需附件工具、双账本展示、tokenizer 能力矩阵和不可展示的保守预算保护；版本化 LLM Call Contract 进一步约束每次调用的目的、输入、输出、工具和记忆策略。Memory Service、T0-T3 注册基础、Summary Memory、run-scoped 附件、理念资源、记忆意图闸门、项目投影、稳定项目身份、路径重绑定和资源生命周期均已进入真实运行路径。下一步先完成真实 Provider 对账，再推进统一 Tool Execution Service；实时事件生产留给后续 `RuntimeEventQueue`。连续执行、有界并行、数据生命周期和 UI 透明度的具体阶段见 [Agent Runtime 连续性任务书 2026-07-14](agent-runtime-continuity-taskbook-2026-07-14.md)。

## 11. 报告维护规则

- 本报告用于阶段决策，架构稳定原则以 [architecture-principles.md](architecture-principles.md) 为准。
- 当前能力和验证数字只在 [project-status.md](project-status.md) 维护，本报告不复制测试数量。
- 目录和文件归属只在 [repository-guide.md](repository-guide.md) 维护。
- 每完成一个架构阶段，更新本报告对应矩阵、风险和下一决策；不要另建一次性总结文档。
- 若实施结果证明推荐方向不成立，应记录证据并修改建议，而不是为了维持文档一致而保留错误架构。
