# LittleSheep 架构评估与开发决策报告

最后更新：2026-08-04 05:59:33
评估范围：当前源码、正式文档与已记录的验证结果
执行状态：Memory v3 阶段 0-26 的工程实现、隔离演练和正式用户数据迁移已完成；正式 backend/config 为 v3，40 个业务 atom、5 个内部根、11 个资源和 45 条 BGE 512 维向量已通过既有真实数据根、Electron 重启、Catalog v9 integrity 与恢复源检查。`respond / execute / clarify` 活动语义、直接回应 Context 瘦身、统一 Tool Execution Service、自包含单只读工具的 `decide_explicit_tool`、用户只表达目标时由 LLM 自主选择 builtin `glob / grep / read` 的紧凑只读路径、完整显式多工具提议、完全访问下受限内置 `exec` 直接执行、TaskBook 步骤级有界并行、活动任务控制、托盘、三档关闭策略和设置页“应用与后台”已形成工程基线。显式与自主单只读路径当前均固定为 2 次 API、1 次工具；显式 Prompt 为 `796`，自主 Prompt 为 `1,120`、总回归上限 `1,400`。自主 DECIDE 同时提交工具、参数、步骤摘要与验收标准，Runtime 直执行前继续重验权限、schema、路径和副作用；两条路径均保留工具证据和结构 VERIFY。DeepSeek V4 Flash 普通请求与工具协议已在 disabled/high/max 三档完成 `15/15 exact_match`，Pro 工具协议和其他 Provider 仍失败关闭。确定性 Electron 七场景、真实 DeepSeek 后台九场景、当前 120 秒持续任务、完整退出/重启后的回答级记忆连续性、真实两步 `write -> read` 恢复、短时并行压力、摘要深度 `1 -> 2 -> 3 -> 3` 的五字段续答、主动网络断线恢复和正式 2 小时持续任务已经通过。FINALIZE 以 LS 最终回答和真实因果 Context 判断是否连续，能从近期历史、Runtime 精确保真摘要和 active/adopted Atom 发现被追问的任意明确字段；保存、检索或摘要存在不能替代回答证据。Local App API 的长连接已经统一使用 15 秒 SSE 心跳、512 KiB 缓冲上限和确定性资源清理。OpenAI/GLM 同等能力矩阵、Pro 工具协议、非字段事实、真实外部系统副作用和长期用户负载仍未完成。

## 1. 给决策者的结论

LittleSheep 当前不是“只有 Prompt 的聊天壳”。它已经具备代码控制的 Harness、TaskBook、工具执行、索引优先记忆树、会话持久化、执行日志、Electron UI 和插件宿主，方向与“LLM 负责推理、Agent 负责兑现”基本一致。

所有后续架构取舍都应服务于同一项产品使命：**解放用户生产力，让用户着重于想法的产生，LS 负责让用户的想法落地。** 因此，检索、规划、执行、验证、整理和记忆维护应尽量由运行时承担；用户应保留目标取舍、风险接受、权限授予和关键判断权。模块化不是为了增加内部形式，而是为了让自动化更可靠、过程更可追溯、用户更少承担低价值的操作负担。

但当前更准确的描述是：

> **包级模块骨架和既有调用契约已有稳定基础；Memory v3 动态 activation、活动路由、直接回应 Context、统一 Tool Execution Service、显式单/多工具提议路径、LLM 自主单只读工具路径、运行时事件、检查点恢复、步骤并行、桌面后台控制与设置页入口的工程门已经完成。自主单只读路径已从三次 Provider 工具循环收敛为 `DECIDE 提议 -> Runtime 直执行 -> 实时最终回复` 两次 API，并保留全部安全与证据闸门。确定性 Electron 七场景、真实 DeepSeek 跨重启回答门、多轮五字段摘要回答门、主动断线恢复、基础两步副作用任务、短时并行压力、6 分钟诊断门、正式 2 小时门、当前 DeepSeek 四项能力和 Flash 普通/工具协议 V4 精确本地 token 对账也已通过。记忆连续必须由 LS 最终回答准确承接历史值并能追溯到真实 Context 来源，内部保存、摘要、Atom 或检索成功不能代替。下一步推进 Pro 工具协议、非字段事实、真实外部系统副作用和长期真实用户负载，并在安全契约不退化时继续优化 Context。**

当前最重要的结构结论是：

1. Context Engine 已成为独立模块并接管模型请求准备路径；每次请求现在拥有版本化 `LlmCallContract`，Context segment、工具集合、输出预算和记忆策略在发送前失败关闭。tokenizer 能力矩阵与 unavailable 模型的保守请求前预算保护已经完成；DeepSeek V4 官方 tokenizer、最终请求 framing、本地精确 ledger 与 Provider usage 同请求对账已闭环。剩余缺口是 OpenAI/GLM 等实际启用模型的专用计数器/校准矩阵和持续成本基线。
2. 每次 run 已有统一、不可变的运行决议，但 Behavior Mode 仍只是 profile 与策略 id 的组合结果，尚没有可注册、可迁移的 Mode Registry。
3. Tool Registry 只负责注册与来源；统一 `ToolExecutionService` 已接管查找、schema、权限/单次批准、超时、中断、调度、清洗、事件和权威调用记录；Harness 只保留模型循环、TaskBook 编排和副作用检查点生命周期。
4. 正式 Memory v3 已通过同一 Repository facade 接管 Memory Service、Runner、Harness、工具和 UI；迁移前的 V2 源与 snapshot 继续保留为来源和受约束回滚证据。v3 已实现语义 atom、稳定 parent、认识状态、实体引用、可重建 Catalog v9、真实本地 Embedding、统一检索、版本化 KnownState、有界维护、事务恢复、动态 activation，以及当前请求自足/多轮指代/否定条件/任务转向/版本化摘要回退共用的有界任务语义。

因此，不再在集中式 Memory v2 文档上叠加新能力。Memory v3 阶段 0-26 已完成 Runtime 同源 D0-D3 读取、正式迁移/回滚生命周期、本地向量资产、Atom 高级治理、working set、release、反馈、动态 routing、关系引导候选发现、多轮任务语义、压缩后任务锚点恢复、写入认识元数据、自动实体/关系投影、冲突/替代调和、TaskBook 二次选择、跨持久记忆与语义缓存的连续 activation、前端三层只读投影、真实负载观测、daily 提升、重复 Atom 合并、叶子/非叶子层级调整、同陈述修订和有证据事实替代。首次与二次选择仍受 scope、任务价值、证据和 token 预算约束；关系只在同 branch/scope/subtree 内做有方向、有证据的一跳扩展。固定 `T0-T3` 只表示注入策略类别，不承担动态热度语义。普通 GUI 只展示六份记忆文件并仅允许编辑 `SOUL.md`。当前未完成的是实际 Provider 提案质量、长期用户负载校准、活动长任务和跨陈述语义重写，而不是阶段 17 的 activation 工程基元。

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

- Stage 仍负责构造语义消息，但模型请求已统一经过 Context Engine；System Prompt segment、摘要和附件清单已经可追溯，本地与 Provider token 账本也已分开保存。非图片附件通过 run-scoped 工具按需读取；tokenizer 能力矩阵和 unavailable 模型保守预算保护已完成。运行中事件已有有界队列、Local App API ingress、安全边界消费、TaskBookPatch、延迟事件重规划、Renderer 生产/反馈入口和应用启动恢复控制面；基础跨重启回答、多轮五字段摘要回答、主动断线恢复、两步副作用任务、短时并行压力、6 分钟诊断门、正式 2 小时门与桌面生命周期门已完成，当前缺口是非字段事实、真实外部系统副作用和长期真实用户负载验收。
- Runner 的基础设施构建同时负责 LLM、session、memory、vector、skills、tools 和 Harness 装配，改动影响面大。
- Mode 的各组成项没有统一 schema 和解析顺序。
- 工具运行时生命周期已收敛到 `@littlesheep/tools`，但网络资源权限、更强授权 token 和 MCP adapter 仍需在同一执行协议上补齐。
- Electron 的 Local App API、根 `App.tsx` 和全局 `styles.css` 是明显的变化集中点。

## 4. 模块评估矩阵

| 能力域 | 当前状态 | 当前真相来源 | 主要缺口 | 下一项关键决策 |
| --- | --- | --- | --- | --- |
| 公共契约 | 稳定基础 | `packages/types/` | 内部 v1 契约已齐，Context 与 Tools 已有实际所有者；Mode Registry 仍未收敛 | 保持内部版本，迁移剩余生产者和消费者后再考虑公开 API |
| Workflow/Harness | 稳定基础；活动语义迁移已完成 | `packages/harness/src/default-harness.ts`、`stages/`、`packages/types/src/agent.ts` | 代码级 stage 与安全脊柱仍固定；语义活动已迁移为 `respond / execute / clarify`，兼容字段尚未退役 | 保持兼容边界，再继续评估 Mode 策略化；不开放任意工作流图 |
| Runner | 基础可用 | `packages/runner/src/runner.ts`、`infra.ts` | 同时承担生命周期、核心装配、记忆运行时启动和工具选择 | 把 Runner 保持为应用服务，逐步下沉子系统内部逻辑 |
| Context | 基础可用，DeepSeek V4 Flash 普通请求、Provider 工具协议、显式与自主单只读工具路径已按形态实测 | `packages/context/`、`context/tokenizers/`、`types/token-ledger.ts`、`harness/context-candidates.ts`、`harness/compact-autonomous-read-task.ts`、`model-observability.ts`、`config/model-capabilities.ts` | 已有确定性候选、来源 segment、显式 tokenizer 能力矩阵、不可展示的保守预算保护、预算淘汰、版本化摘要、附件清单、按需附件工具、压缩阈值设置和双账本 UI。显式单 `glob` 的 DECIDE/final prompt 为 `417/379`，全程 `796`；自主路径由 LLM 选择一个只读工具并给出有界参数，Runtime 直执行后再实时生成最终回答，DECIDE/final prompt `744/376`、合计 `1,120`、总上限 `1,400`。两条路径均固定 2 次 API、1 次工具，逐请求为 `exact_match`，并保留权限、schema、工具证据、结构 VERIFY 和调用审计。Flash 的普通请求、工具 schema、单工具续轮、仅历史工具消息和多工具乱序结果在 disabled/high/max 共 `15/15 exact_match`；Pro 普通请求保持 exact，Pro 工具协议失败关闭。最新多轮摘要续答最终 prompt `1263/1265` 仍为 `within_tolerance`，不能与工具协议校准混写 | 为 Pro 与实际启用的其他 Provider 分别建立模型专用校准门；自主路径只在安全契约不退化时继续缩短 Prompt |
| Prompt | 基础可用；直接回应路径已收敛 | `packages/prompt/`、stage prompt、`harness/stages/reply.ts` | 完整执行 Prompt 与紧凑 `respond` Prompt 已分路；后者不含 Workflow、workspace、reasoning 和无关 bootstrap，并限制历史与记忆索引。普通回应只注入紧凑时钟，明确追问才恢复上一轮有界执行摘要 | 保持按活动渐进披露，只向模型投影完成当前决策所需信息 |
| Behavior Mode | 职责分散 | `prompt/profiles.ts`、Runner、config、App | 不是统一配置组合，新增 Mode 仍需跨模块修改 | 建立类型化 Mode registry，并与权限正交 |
| Permission Policy | 基础可用 | `packages/app/src/main/run-policy.ts`、`ToolContext`、`packages/tools/src/tool-execution-service.ts` | 统一服务已消费权限决议并执行单次批准；网络资源和更强授权 token 尚未建模 | 权限作为独立 ceiling，不进入行为 profile |
| Tool Registry | 稳定基础 | `packages/tools/src/registry.ts`、`packages/runner/src/run-tools.ts` | 注册、来源和 run-scoped 合并已保留到调用记录；插件/MCP 命名空间仍需版本化 | 保持 registry 只负责工具与来源，不吸收执行机制 |
| Tool Execution | 工程基线已完成 | `packages/tools/src/tool-execution-service.ts`、`tool-execution-{scheduler,control,records,result}.ts` | 已统一 schema、权限、批准、超时、中断、调度、清洗、事件和记录；网络权限、MCP adapter 与更强恢复场景待补 | Harness 保持编排，所有新工具复用此服务 |
| Memory Tree | 基础可用，职责收敛进行中 | `packages/memory-tree/`、`memory-core/`、Runner | Memory Service 已接管首批消费者，Summary Memory、run-scoped 附件、运行时事件账本登记端口、项目记忆三层投影和稳定项目身份已统一；Renderer 普通事件生产入口已接通，当前缺口是关系长期真实负载治理、Skill 治理和更通用的资源生命周期 | 继续扩展现有门面，不新建总包 |
| Session | 基础可用 | `packages/session/` | 已有非破坏式版本化摘要、增量合并和压缩后任务锚点恢复门，但真实 Provider 长会话、摘要失败、工具副作用恢复与成本仍待验收 | 继续由 Context 策略驱动并补齐真实恢复场景 |
| Execution Log | 稳定基础 | `packages/runner/src/execution-log.ts` | 新日志优先持久化统一服务产生的权威调用记录；旧日志才使用消息推断兼容路径 | 保持有界、脱敏和只读重放，不把日志默认注入上下文 |
| LLM Provider | DeepSeek 基础能力已实测 | `packages/llm/`、`packages/config/`、`packages/app/src/main/provider-calibration.ts` | 当前 `deepseek-v4-flash` 的 chat、continuity、tool、abort、reasoning 续接和 usage 已通过运行中 Main 校准；未配置的 OpenAI/GLM 不冒充已验收 | 保持 provider capability descriptor，按实际启用范围增加校准证据 |
| Plugin Host | 基础可用 | `packages/plugins/` | v1 已接通 `channel`/`tool`/声明式 `skill`；Skill 所有权跨 Host、Loader 和 Memory Service 协同 | 保持 owner-scoped 协议，新增贡献点前先实现完整消费方和生命周期 |
| External Channels | 基础可用 | `packages/channels/*` | 真实凭证和异常隔离场景仍需验收 | 保持纯适配器，不回到核心网关模式 |
| MCP | 尚未实现 | `packages/mcp/` | 只有骨架；统一工具执行前置条件已具备 | 以 adapter 接入 Tool Execution Service，不建立独立执行管线 |
| Electron Main/API | 主要组合边界已分域 | `packages/app/src/main/` | `local-app-api-server.ts` 保持薄组合；窗口/托盘/关闭行为、活动任务聚合和生命周期路由已拆为独立模块，`index.ts` 仍承担全局启动装配 | 保持现有 feature 边界，继续缩小启动组合入口，不新建无复用价值的包 |
| 开发环境管理 | 基础可用 | `packages/app/src/main/development-environments.ts`、`development-environment-files.ts`、设置页 | Electron 内置 Node 已可用，其他运行时的自动下载、签名校验和安装包分发未完成 | 先冻结导入/版本契约，再实现来源清单和按需下载 |
| Renderer | 职责分散 | `packages/app/src/renderer/App.tsx`、`styles.css` | 页面状态、导航、会话、设置和工作区编排集中 | 按 feature + shared primitives 渐进拆分 |

## 5. 关键问题分析

### 5.1 Context 是最高优先级的结构问题

当前 `buildRunContext()` 仍会读取最近会话、过滤工具消息、加载 bootstrap 文件并构建 `ToolContext`；`packages/prompt` 负责 System Prompt，各 stage 仍负责形成语义消息，Runner 负责注入记忆根索引。模型请求随后被映射为显式 Context 候选，并由 `@littlesheep/context` 统一排序、预算和生成脱敏快照。完整执行路径把基础策略、记忆根索引、bootstrap、输出约束、Workflow/TaskBook、行为 profile 和 reasoning 分别登记为 segment；当前工作树新增的 `respond` 路径只登记直接回答所需的紧凑策略、能力、用户资料、记忆证据、摘要和最近历史。版本化 Summary Memory 继续作为独立来源进入后续请求。

阶段 1 已形成主要数据链：Provider usage 会绑定到产生它的准确 Context 快照；UI 优先显示本地精确装配并单独显示供应商实测、差值和校准状态；长会话压缩保留原始 JSONL，只在元数据中保存版本化摘要。概率语义摘要与 Runtime 精确字段封套已分离：最多 24 项明确 `label: value` 按最新赋值有界重建，旧摘要和历史消息在摘要请求中被声明为惰性数据，模型伪造或残缺封套会在持久化前移除；该保真层不替代 FINALIZE 的回答级连续性门。FINALIZE 会根据请求和真实来源动态发现被追问字段，并逐项核对最终回答，不再局限于预置标签词表。压缩阈值已经接入 Local App API 与设置页；非图片附件通过当前 run 专属工具按需读取，未调用时不解析正文。新导入附件已进入独立受管缓存，run 只能使用经稳定 cache id、路径、普通文件、大小和哈希重新验证的缓存项，旧 workplace 与外部用户文件不属于自动清理范围；workplace 资源索引已使用有界目录批次、持久化游标、精确变更提示和资源树元数据入口，正文仍由显式文件工具读取。完整数据根迁移已接入启动前恢复路径，失败不切换活动目录。Provider reasoning/capability 契约回归、tokenizer 能力矩阵和 unavailable 模型保守预算保护已完成；DeepSeek V4 使用固定官方 revision、大小和 SHA-256 资源。Flash 普通请求与 Provider 工具协议已完成 disabled/high/max 三档 `15/15` 零差值对账；Pro 普通请求保持精确，Pro 工具协议和 OpenAI/GLM 仍按模型独立失败关闭。用户未点名工具的自包含只读目标由 LLM 选择一个 builtin `glob/grep/read` 并提交有界参数，Runtime 直执行后再实时生成最终回答；最新真实路径固定 2 次 API、1 次工具，Prompt `1,120`，不加载历史或未采用记忆；实际记忆介入、附件、续接或恢复态会回退完整路径。运行中事件队列、ingress、安全消费、TaskBookPatch、Renderer 事件生产、步骤级有界并行、应用启动恢复、活动任务控制、托盘、关闭策略和设置页活动任务入口已形成运行时闭环；真实 DeepSeek 的多轮五字段摘要续答、三级压缩深度上限、原始 JSONL 保留、主动断线恢复、当前 120 秒持续门和正式 2 小时门已经通过。剩余缺口是 Pro/其他 Provider 校准、非字段事实、真实外部系统副作用和长期真实用户负载；自主路径仅在安全契约不退化时继续优化。

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

权限策略还必须叠加一条独立的逻辑容器分类。产品语义上，活动完整应用数据根（默认 `.littlesheep`）是 LS 容器，`workplace/` 只是其中的默认工作区；用户主动选定的外部工作区仍是容器外，不能因为被选中就改变分类。完全访问从其他模式启用时先进行一次红色风险确认，之后对容器内外和 `unknown` 范围的普通读、写、改、删、执行免逐次批准；研究只对容器内读取免批准；受限所有操作都需批准。研究/受限在外部工作区启动时先跳过自动资源/文档索引，待具体访问获批后再继续，完全访问直接继续。当前实现由 Main、Safety、Harness、内置工具和终端共同执行权限策略，不等同真实 Docker/OS 沙箱；核心源码只读和危险命令硬拒绝高于所有策略。

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

阶段 0 已消除 DECIDE 未接收 reasoning addon 的分歧，并由 `ResolvedRunConfig` 固化本轮选择。当前工作树把 DECIDE 模型调用拆到 `stages/decide/model-call.ts`，规划输出上限为 `1400`；直接 REPLY 与重复改写上限为 `1200`。这些值会被 `ModelRequestSnapshot` 如实记录，但仍属于 stage 局部常量；后续应结合 Provider capability、模型上下文窗口和输出预算统一解析。

### 5.3 Tool Manager 不能只是一张注册表

ToolRegistry 继续只负责注册和来源。真正调用工具时的查找、参数 schema、权限与单次批准、超时、中断、资源冲突调度、输出清洗、事件和结构化记录已经迁入 `@littlesheep/tools` 的 `ToolExecutionService`。

Runner 继续自动发现实际 LS workspace 根，并把核心源码只读边界传给内置 `write`、`edit`、`exec`。统一服务在调用前执行宿主权限与批准决议，内置工具仍在实际动作前执行路径二次复核；一次批准通过 `approvalGranted` 传递，避免 `exec` 重复询问。

插件工具和 run-scoped 工具现在与内置工具走同一服务，并在 `ToolInvocationRecord` 中保留来源。未来 MCP 和自动化只能贡献工具描述、资源声明与 handler，再由统一服务执行；不得重新实现审批、超时、清洗或日志。

### 5.4 Memory 的问题不是“能力太少”，而是缺少消费门面

记忆树、仓库、兼容来源、写入服务、向量、经验、安全和快照已经拆成多个包。继续拆包不会自动改善结构，反而可能让调用链更难追踪。

下一步应定义少量稳定用例：

- `beginRun()` / `finishRun()`；
- `rootIndex()` / `navigate()` / `expand()` / `deepSearch()`；
- `writeIntents()`；
- `getManagementSnapshot()`；
- `invalidate()` / `recover()`。

首批收敛已经完成：Runner 的 run 生命周期、bootstrap 注册、Agent 记忆工具、结构化写入和 App 记忆控制面都优先通过 `MemoryService`。旧 `memoryTree`、`memoryRepository` 和 `memoryWriteService` 字段暂时留在 Infrastructure 中兼容测试和迁移调用，新的第一方功能不得继续直接依赖它们。内部仍可使用 memory-tree、memory-core、vector、experience、safety 和 snapshot。

版本化记忆注册表与 T0-T3 基础分级已经实现：T0 保持固定预算，普通记忆写入不能进入 T0；v1 文档在保留 T1-T3 数值的前提下迁移到 v2，并在原子切换前生成回滚备份；未知未来版本拒绝覆盖。资源注册表只保存来源元数据，`resources` 分支沿现有索引导航读取正文，UI 与运行时读取同一份注册表。Summary Memory 已按 session scope 登记并以会话元数据为正文权威来源；附件清单和单项附件按 run scope 登记，正文只存在于活动 run 内存或专用读取结果中，执行日志仅关联有界资源 ID。运行时事件账本同样使用 run scope，只登记事件数量、类型、顺序和状态；有界 `RuntimeEventQueue` 保存受限 payload，Context resolver 只提供类型、来源、序号和 payload key 摘要。项目记忆三层策略也已落地：完整权威数据留在可整体迁移的 LS 应用数据根，`workplace/` 只是默认工作区子目录；用户明确启用后，项目目录只生成经过层级、敏感内容和路径白名单过滤的私有派生投影；共享 Markdown 使用独立、更严格的置信度白名单。控制面显示同步、缺失、冲突和 Git 忽略状态，覆盖与移除需要确认，且移除只作用于 LS 最后验证写入的文件。新项目 ID 已与路径解耦，旧 ID 保持兼容；持久化重绑定事务会在项目移动或重命名后迁移会话、归档、记忆、投影和工作区关联。实体/关系 schema、方向语义、有界关系候选发现和证据封套已经完成，Renderer 普通事件生产入口也已接通；仍未完成的是关系长期真实负载治理，以及 Skill 的语义去重、合并、收益治理和恢复队列。

### 5.5 Workflow 可配置必须晚于契约稳定

现有硬状态机是 LS 的可靠性资产，不应为了“Mode 可配置”直接改成任意节点图。完全自由的 Workflow 会让权限绕过、验证缺失、恢复循环和插件注入更难控制。

推荐保留不可绕过的安全脊柱，再让 Mode 选择有限的 stage strategy 或受测模板。例如：聊天轻量流、标准任务流、长任务流可以不同，但权限、VERIFY、失败边界和 FINALIZE 仍由核心保证。

长任务的连续执行协议已形成工程基线：用户事件可在安全决策边界进入，普通追加消息、设置和工作区事件已接入 Renderer 生产入口；有界队列、确定性 `TaskBookPatch`、延迟重规划、版本化 `RunCheckpoint`、Runner 显式续跑、应用启动恢复/放弃/查看现场和 TaskBook 步骤级硬上限并行都已接通。宿主工具调用默认超时仍为 120 秒，配置上限已扩展到 24 小时，并继续受 run 总超时、AbortSignal 和取消后的 1.5 秒有界清理约束；内置 `exec` 保留有界首尾输出并终止完整进程树。Local App API 的长生命周期 SSE 使用 15 秒心跳和 512 KiB 单连接待写上限；普通 Agent 观察连接断开不会取消 Main 持有的 run，终端主动命令仍在断连时取消。隔离 Electron 已完成托盘、暂停/继续、强制终止恢复、模型热切换、中断 Checkpoint、跨重启回答验收、多轮五字段摘要回答、主动断线恢复、真实 DeepSeek 两步副作用恢复、6 分钟诊断门和正式 2 小时门。所有并行分支、重试、验证和重规划循环必须继续受次数、时间、成本和无进展上限约束。

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

以下顺序描述 **跨模块职责收敛工作线**，不是产品全部任务的唯一阶段编号。Context、记忆注册、附件、运行中重入、检查点和后台执行使用 [Agent Runtime 连续性任务书 2026-07-14](../taskbooks/agent-runtime-continuity-taskbook-2026-07-14.md) 的独立阶段号；全局执行顺序以 [项目状态](project-status.md) 的“推荐后续顺序”为准。每个阶段的当前进度以本节状态和项目状态为准，不能只因类型或入口存在就视为完成。

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

状态：进行中。主要实现、Provider reasoning/capability 契约、tokenizer 能力矩阵和 unavailable 模型的保守预算保护已经完成；DeepSeek V4 普通请求与显式单/多工具提议路径的精确本地计数及真实 Provider 同请求对账已完成。阶段仍进行中是因为含历史 Provider 工具消息的普通续轮 framing、其他实际启用 Provider 的模型专用能力矩阵和持续真实负载尚未收敛。

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

- 保持 DeepSeek V4 官方 tokenizer、固定资源校验、最终请求 framing 和同请求 Provider 差值回归；其余模型只有在具备同等级证据时才注册 exact，否则保持 unavailable；
- 只在 OpenAI/GLM 实际配置并进入用户选择范围后，使用真实请求校准上下文窗口、reasoning、usage 与模型专用本地 ledger 差异；

### 阶段 2：Tool Execution Service

目标：让所有副作用共享一条执行管线。

状态：工程基线已完成。统一服务已经接管内置、插件和 run-scoped 工具的查找、schema、权限、单次批准、超时、中断、调用级调度、结果清洗、事件和有界权威记录；Harness 只保留模型循环、TaskBook 编排和副作用检查点生命周期。

建议边界：

- ToolRegistry 继续负责注册和来源；
- Tool Execution Service 负责解析、schema、权限、单次批准、超时、中断、调用级调度、清洗、记录和错误分类；
- 把现有核心源码只读闸门提升为统一路径策略，使内置、插件和未来 MCP 工具共享宿主不可写边界；
- 逻辑容器边界基元已经接入：`containerRoot`、`inside/outside/unknown` 分类、动态命令 fail-closed、Main 终端复核和工具内部二次复核。后续仍需把网络权限和更强的单次授权 token 收入同一协议；
- Harness 负责步骤编排，不直接实现工具机制；
- App 只提供审批交互和 Permission Policy，不重复判断工具内部行为。

验收结论：内置、插件和 run-scoped 工具已使用同一种 `ToolInvocationRecord`；拒绝、中断、超时、未知工具、重复调用和异常均有稳定状态，记录有界且不保存完整输入输出。未来 MCP 复用同一服务、UI 完整重放和真实长任务恢复仍需各自验收。

依赖说明：本阶段前置条件已经满足。运行中用户事件、检查点恢复控制面和 TaskBook 步骤级并行应继续建立在该服务的稳定调用记录与副作用语义上。

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

状态：主要工程闭环与正式迁移已完成，真实 Provider/长任务验收进行中。v3 阶段 0-26 已实现投影变更记录、atom projections、journal、Catalog v9、FTS、本地 Embedding、实体关系、Repository transaction、认识状态分类与来源对账、统一检索、动态 routing、关系引导的一跳候选发现、自动关系投影、提交后激活、启动补偿、冲突/替代调和、TaskBook 二次注入、语义向量哈希、D0-D3、版本化 KnownState、连续 activation、前端三层投影、真实负载观测、daily 提升和有证据约束的合并/修订/层级调整/事实替代；用户 GUI 已收敛为六份记忆文件视图，当前正式数据和 45 条本地向量均由 v3 接管。

建议边界：

- 在现有 memory-tree 边界上先提供统一服务门面；
- 增加记忆资源注册表和 T0-T3 协议，以版本化迁移映射现有 T1-T3 数据；
- 保持已落地的项目记忆三层字段、同步、冲突、清理、Git 忽略、稳定身份和可恢复路径重绑定契约；通用资源沿用统一状态、重新定位、冲突保护和有界审计，插件/Skill 已由 owner-scoped 协议驱动，数据根迁移继续保持外部 locator 与活动元数据重绑定边界；
- 以现有 `packages/session/src/compaction.ts` 的非破坏式版本化摘要和阶段 12 的任务锚点回退门为基线，补齐真实 Provider 长会话、摘要失败、工具副作用、成本和恢复验收；
- 压缩摘要继续保留来源消息范围、版本、模型、关键约束和校验信息，不能删除原始会话事实；
- daily 到长期记忆的蒸馏走结构化写入闸门。
- 按 [原子记忆与内置向量目录任务书 2026-07-17](../taskbooks/memory-atom-vector-catalog-taskbook-2026-07-17.md) 以只追加对话原始来源保存用户输入与对话区可见信息，以投影变更记录保障幂等与恢复，以语义 atom 形成可治理投影，并用可重建 SQLite catalog 管理 parent、实体、有向关系、FTS、向量和恢复投影；用户 GUI、Runtime 与 LLM Context 使用分离的披露视图；
- Skill 治理按 owner/source 生成可审查的合并、停用、归档或删除方案；相似度和使用次数都不能直接触发覆盖或删除；
- 默认本地生成 Embedding，Provider `/embeddings` 只在用户显式启用时允许；层级和 FTS 不依赖向量可用性。

验收标准：长会话压缩后，任务约束、未完成步骤、关键用户偏好和来源不丢失；失败可回退到原消息；记忆 UI 与运行时仍操作同一份数据。

### 阶段 5：Workflow 策略化

目标：允许不同 Mode 选择受控工作流，而不牺牲硬安全边界。

建议边界：

- 固定 ENTER、权限闸门、VERIFY、RECOVER 上限和 FINALIZE 语义；
- 把可替换部分定义为 stage strategy 或受测模板；
- 工作流定义必须声明输入、输出、失败和恢复契约。
- 已有运行中事件队列、TaskBook 差异修订、版本化检查点、Runner 显式续跑、应用启动恢复控制面、活动任务控制、设置页入口、托盘、关闭策略和幂等副作用记录；下一步补真实场景验收；
- TaskBook 已按依赖、资源读写集合和副作用实现有界并行调度；同一资源冲突写入和顺序验证保持串行；
- 为重试、验证和重规划统一设置次数、时间、成本与无进展上限。

验收标准：简单任务不承担复杂任务开销；复杂任务不能跳过 TaskBook/VERIFY；任何 Mode 都不能绕过权限和收尾；追加要求不会丢失已完成证据；并行执行不产生资源冲突且与串行执行得到等价验收结论；应用重启能从检查点继续且不重复副作用；循环和并发达到上限后有边界地停止。

### 阶段 6：Electron App 渐进拆分

目标：降低主进程 API 和 Renderer 根组件的变化冲突。

建议顺序：

1. 先拆 Local App API 的 route registration、validation 和 feature handlers；
2. 再拆 Renderer 的 navigation、conversation、composer、settings、workspace feature；
3. 最后收敛 shared overlay、motion、tooltip 和 icon primitives；
4. 保持现有视觉与持久化行为，用截图和恢复测试防止交互回退。
5. 设置页“应用与后台”、活动任务列表和关闭策略已经接入现有运行中事件、恢复 UI 和托盘；活动列表使用 SSE 更新并限制监听器、请求与重连生命周期。继续让记忆更新与 Context 双来源账本按渐进披露展示。

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
| D9 Atom 动态层级 | 固定热层 / 后端连续 activation + 前端三层投影 | 后端连续、前端三层 | 文件、parent、披露深度和缓存压缩不能替代运行时价值；真实有效使用升温，低频衰减，任务相关度仍是首要准入门。UI 使用滞回阈值保持稳定，不把三层写回后端 |
| D10 权限容器 | 真实 Docker/OS 沙箱 / 逻辑数据根边界 + 后续可叠加系统沙箱 | 逻辑数据根边界 | 当前 Electron 运行方式先保证可迁移数据根、Main 复核、工具内复核和未知 fail-closed；不把尚未存在的进程隔离写成已完成能力 |

## 8. 现在做、暂缓做、不要做

### 现在做

- 给跨模块职责建立类型、来源和特征测试。
- 先解决 Context 可观测性，再做上下文压缩和 Mode 扩展。
- 把插件化后的真实架构作为回归基线，持续验证“无插件仍可运行”。
- 用真实 Provider 冒烟建立 usage、reasoning、工具调用和中断基线。
- 对大文件采用 feature 内渐进拆分，每次保持行为等价。
- 保持核心源码只读闸门，直到隔离工作树、检查点、完整回归、用户审查和自动回滚全部具备后，再单独讨论受控自我修改。

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
- 让 LS 直接修改正在运行的核心源码，或用完全访问模式绕过宿主级只读边界。

## 9. 风险与控制措施

| 风险 | 可能后果 | 控制措施 |
| --- | --- | --- |
| 过早大重构 | 当前可用流程回退、用户数据恢复失败 | 特征测试、行为等价迁移、小步合并、旧路径短期适配 |
| 过度拆包 | 依赖和版本管理复杂度超过收益 | 新包准入标准；优先包内模块化 |
| Mode 与权限混合 | 行为切换意外扩大权限 | 独立类型、独立 UI、最终权限 ceiling |
| Context 来源不透明 | “不失忆”不可验证、token 显示失真 | ContextSnapshot、来源账本、Provider usage 分层 |
| 高频 Atom 自增强 | 常见但错误或无关的信息长期挤占 Context | 仅真实采用与验证收益升温；原始访问不计分；task relevance、scope 和证据先于 activation |
| Memory 自动写入失控 | 错误事实长期固化 | 索引写入闸门、来源、置信度、合并、恢复和用户管理 |
| 实体/关系误合并 | 跨项目、跨用户或跨权限信息污染 | 稳定实体 id、owner/scope、关系证据、D0-D3 披露和跨边界默认不传播 |
| Skill 自动治理误删 | 能力丢失、插件所有权破坏 | 合并建议先审查、停用优先、引用检查、保留期、版本回滚和来源文件保护 |
| Agent 自修改核心源码 | 运行版本损坏或无法启动 | 当前硬只读；未来仅允许隔离修改、完整验证、人工批准和自动回滚 |
| 项目内记忆投影泄露私有数据 | 密钥、用户画像或执行日志被误提交 | 私有权威数据默认留在用户数据目录、字段白名单、显式启用、提交风险提示和可撤销同步 |
| 并行调度失控 | 冲突写入、重复副作用、资源泄漏和结果不稳定 | 依赖图、读写集合、硬并发上限、分支取消、幂等记录和稳定归并 |
| Plugin 扩展过快 | 核心被插件绑架、故障扩散 | 版本化 Host、默认不信任、错误隔离、无插件回归 |
| App 拆分破坏交互 | 动画、布局、恢复出现细小回退 | 持久化契约测试、截图/交互验收、逐 feature 迁移 |

## 10. 下一阶段推进条件

仓库基元化阶段 0-7、Memory v3 阶段 0-26、`respond / execute / clarify` 活动语义、直接回应 Context、统一 Tool Execution Service、显式单/多工具提议路径、LLM 自主单只读工具路径、运行时事件产品入口、TaskBook 步骤级有界并行、应用启动恢复、活动任务控制、设置页“应用与后台”、托盘和三档关闭策略已完成既定工程门；阶段 17 的连续 activation、阶段 18-19 的真实负载观测和阶段 20-26 的旧写入退役、daily 提升及受约束 Atom 治理均已落地。当前 DeepSeek 凭证、四项基础能力、Flash 工具协议 `15/15 exact_match`、确定性 Electron 七场景、真实 DeepSeek 跨重启回答门、多轮五字段摘要回答门、主动断线恢复、显式/自主单工具两请求效率门、基础两步副作用恢复门、6 分钟诊断门和正式 2 小时持续任务门已实测通过，不再是阻塞项。当前第一工程门是验证非字段事实、真实外部系统副作用和长期真实用户负载；并行效率线是校准 Pro 工具协议，并在安全与证据契约不退化时继续优化自主只读 Prompt。在这些契约稳定前不扩张新插件类型或无关 UI 范围。推进时持续遵守：

- 以 [架构原则](../principles/architecture-principles.md) 作为最高层工程规范；
- Behavior Mode 与 Permission Policy 保持正交；
- 保留固定安全脊柱，不把 Workflow 直接开放为任意图；
- 保护现有用户数据与插件化改动，不做破坏式迁移。

Context Engine 已完成候选端口、预算器、稳定装配顺序、来源分段、版本化摘要、附件清单优先、按需附件工具、双账本展示、tokenizer 能力矩阵和不可展示的保守预算保护；DeepSeek V4 官方 tokenizer 与 Provider 校准后的 framing 已接入，token 账本公共契约已独立到 `packages/types/src/token-ledger.ts`，本地计数缓存固定为 64 项并按 run 绑定 Context Engine。版本化 LLM Call Contract 约束每次调用的目的、输入、输出、工具和记忆策略。Memory v3 已接管统一 Repository facade、Memory Service、Runner 与 Harness，并完成阶段 0-26 的工程能力。`respond` 紧凑 Prompt、活动路由兼容映射、上一轮摘要选择性介入、摘要精确字段保真、统一 Tool Execution Service、`decide_explicit_tool`、`compact-autonomous-read-task`、完整显式多工具提议、运行时事件前端生产、TaskBook 步骤并行、应用启动检查点恢复、桌面后台控制和设置页入口已通过回归与隔离 Electron 验收；凭证保存、加载和注入已共用规范化边界，损坏密文失败关闭。当前 DeepSeek 模型的 chat、continuity、tool、abort 四项脱敏真实校准、Flash 普通/工具协议 `15/15 exact_match`、显式单工具 Prompt `796`、自主单工具 Prompt `1,120`、完整退出/重启后的回答级连续性、多轮五字段摘要回答、主动断线恢复、基础两步副作用恢复、当前 120 秒诊断门和正式 2 小时门已通过；Pro 工具协议、非字段事实、真实外部系统副作用和长期真实用户负载继续按独立质量门推进，自主路径只在安全契约不退化时继续优化。

## 11. 报告维护规则

- 本报告用于阶段决策，架构稳定原则以 [architecture-principles.md](../principles/architecture-principles.md) 为准。
- 当前能力和验证数字只在 [project-status.md](project-status.md) 维护，本报告不复制测试数量。
- 目录和文件归属只在 [repository-guide.md](../reference/repository-guide.md) 维护。
- 每完成一个架构阶段，更新本报告对应矩阵、风险和下一决策；不要另建一次性总结文档。
- 若实施结果证明推荐方向不成立，应记录证据并修改建议，而不是为了维持文档一致而保留错误架构。
