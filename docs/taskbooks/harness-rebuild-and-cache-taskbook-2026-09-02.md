# LittleSheep 新 Harness 重建与 Prompt Cache 收敛任务书 2026-09-02

状态：规划已定稿，阶段 0 冻结已完成，阶段 1 开源底座评估已完成；阶段 2 观测与后续重构仍在进行

最后更新：2026-09-11 16:46:00

本文是新 Harness 重建和上下文缓存专项的唯一执行入口。它记录目标架构、开源底座评估、迁移顺序、回滚边界、缓存观测与验收；当前事实和最新质量门仍以[项目状态](../decision/project-status.md)为准。

## 0. 冻结基线

在开始新 Harness 实施前，当前 LittleSheep 已完成一次可回滚冻结：

| 项目 | 已确认值 |
| --- | --- |
| 冻结提交 | `a925a508c009505c474faecd5419f9256bc89f5f` |
| 冻结 tag | `freeze-2026-09-02` |
| 远端 | `origin/main` 和远端冻结 tag 均已回验指向该基线 |
| 提交内容 | 当前工作树已暂存的源码、测试、配置和正式文档，共 333 个文件 |
| 未纳入内容 | 发布暂存目录、构建输出、`.codex_tmp`、一次性调试脚本、密钥、用户数据和其他被忽略产物 |
| 冻结前门禁 | `check:repo`、TypeScript project references、全量验证与冻结前定向回归已通过；历史 warning 仍按项目状态保留，不改写为无告警 |

冻结 tag 是新 Harness 的回滚锚点。任何新 Harness 的代码、依赖、数据迁移或配置变更，都不能覆盖或移动该 tag。若新路径质量门失败，回退到该基线和旧 Harness 兼容路径，不删除用户数据，不重放不确定副作用。

## 1. 为什么要重建

当前 Harness 能完成大量功能，但其控制流和用户可见输出仍有结构性风险：

- 旧路径围绕可变 `RunContext` 的多阶段循环，普通 checkpoint 主要在 `harness.run()` 返回后统一生成；模型请求中途崩溃或进程退出时，已产生的意图、工具证据和最终结算不一定有同一条可重放的权威流水。
- 流式 delta、执行最终回复、VERIFY `final_delta` 和 Renderer 归并仍可能形成多条用户可见输出来源；这会导致重复、顺序不稳定、断线后无法确定最终状态，以及 Runtime 错误被成功回答覆盖。
- 工具副作用已经有权限和调用服务，但旧 Harness 仍需要更清楚地分开“准备执行的 effect intent”和“已确认的 effect settlement”；未知副作用状态不能被当成失败后安全重试。
- `FINALIZE` 的会话持久化失败、历史工具时间近似计算等问题说明，交付状态、事实证据和持久化结算还没有全部由一个 Runtime 权威点收口。
- 上下文注入导致的 Provider prompt-cache 低命中率尚未有可比较的真实基线。现有 `prompt_cache_hit_tokens`/`cached_tokens` 解析、Context boundary marker 和本地 token ledger 不能证明是哪一段前缀不稳定。

因此本专项不是“换一个模型调用库”，而是重建一个可恢复、可审计、单一结算来源的 Harness，并在同一过程中把上下文缓存问题变成可测量、可定位、可回滚的工程问题。

## 2. 目标

1. 评估并适配一个成熟的开源 Agent runtime，优先复用其已经验证的 Agent/session、streaming、tool loop 和 session lifecycle；LS 的权限、状态机、记忆和数据根边界仍由 LS Runtime 掌握。
2. 用 append-only event log、持久 inbox、cursor replay 和幂等 projection 支撑进程退出、连接断开、重启和局部失败恢复。
3. 用 effect intent/settlement 管理所有可能产生外部影响的工具；已结算的 effect 不重放，未知状态不自动重做。
4. 让用户可见的 Agent 自然语言回复只有一个 authoritative final settlement 来源；流式内容只能是同一 settlement 的临时投影，Renderer 不再拼接多条“最终回复”。
5. 建立 Provider prompt-cache、LS Context cache、Memory/Embedding cache 三套独立账本，并用脱敏前缀指纹和 Provider 实测 usage 找到真实低命中原因。
6. 在新旧路径并行比较、可观测、可切换的前提下迁移，不以一次大重写牺牲现有 Memory v3、权限、工具服务、连续性和 UI 证据。

## 3. 非目标与硬约束

- 不在没有许可证、依赖来源、漏洞和维护状态证据时引入开源底座；不能因为 API 形状相似就复制代码或假定许可证允许二次分发。
- 不把 Pi、DeepSeek 或其他项目的示例 `AgentHarness` 类直接视为生产 runtime。候选必须以固定 commit、真实入口和可运行测试为准。
- 不先假定低 cache 命中率由 `packages/context` 单独造成；在真实观测前不得盲目减少记忆、历史、工具 schema 或验证请求。
- 不承诺 Provider 一定命中缓存。Provider 未返回权威 cache usage 时，状态必须是 `unavailable` 或 `unknown`，不能用本地 token 估算成命中率。
- 不改变现有三档权限、核心源码只读、容器逻辑边界、SSRF/工具安全闸门、Memory Write Gate、渠道脱敏和 `respond / execute / clarify` 产品语义。
- 不把原始 prompt、用户正文、网页正文、密钥、Cookie、Authorization、完整工具输出或模型私有诊断写入普通缓存观测、执行列表或 UI。
- 不在 shadow/对比路径向用户发送第二份 Agent 文案，不让旧、新路径同时执行真实不可逆副作用。
- 不删除冻结 tag、旧 checkpoint、旧 session 或无关未跟踪文件；回滚只恢复受管文件和受管配置。

## 4. 现有证据与已知缺口

### 4.1 可复用能力

- `@littlesheep/tools` 已提供统一工具查找、schema、权限、超时、取消、结果清洗、调用记录和资源冲突调度。
- Runner 已有 `RunCheckpoint`、execution log、活动任务控制、暂停/继续/中断、启动恢复、shadow Git 和数据根回滚基元。
- Memory v3 已有索引优先导航、working set、KnownState、版本化摘要、Atom 证据、访问账本和本地向量目录。
- `@littlesheep/llm` 已解析 `prompt_cache_hit_tokens` 与 `prompt_tokens_details.cached_tokens`，并保存 `cachedPromptTokens`；但没有脱敏 stable-prefix 指纹和跨请求可比较的缓存证据。
- 当前前端已有回答来源、连续性、Provider usage 和 Context 使用量的部分投影，可作为新 settlement 和 cache observation 的兼容适配层。

### 4.2 旧路径缺口登记

| 编号 | 缺口 | 重建要求 | 验收证据 |
| --- | --- | --- | --- |
| H-OLD-01 | 多阶段可变 `RunContext` 使事件边界和重放边界不清 | Harness kernel 只通过版本化 command/event/projection 推进 | 崩溃注入后 cursor replay 与 live 结果一致 |
| H-OLD-02 | checkpoint 偏晚，模型/工具中途状态难以恢复 | inbox、model request、effect intent 和 settlement 在关键边界先持久化 | 每个恢复场景说明最后一个已确认事件 |
| H-OLD-03 | 多个用户可见回复来源 | `FinalReplySettled` 是唯一最终文案来源 | 流式断线、重连、VERIFY 失败、重复改写均只有一条最终回复 |
| H-OLD-04 | 副作用意图与结果未完全分离 | intent 有幂等键、租约和 owner；settlement 有状态与证据 | 已完成 effect 不重做，未知 effect 停止并请求用户决定 |
| H-OLD-05 | 历史工具时间存在近似值 | 只使用 Runtime 发出的开始/结束事实 | activity/history 与 execution log 时间一致或明确缺失 |
| H-OLD-06 | FINALIZE 持久化失败可能仍报告成功 | final settlement、会话写入和发布状态形成原子成功门 | 持久化失败只显示 Runtime failure，不发布成功文案 |
| H-OLD-07 | prompt-cache 低命中率没有原因链 | 先完成 CACHE-01 至 CACHE-10，再决定修改点 | 每次 miss 都能给出可脱敏的 invalidation reason 或 `unknown` |
| H-OLD-08 | 同一 data root 的并发 run 同时执行 versioning Git checkpoint 会争抢 `index.lock` | 快照层必须串行化同一仓库的 Git mutation，或让并发 run 显式排队 | 并发不同 session 的 runner 夹具在 versioning 开启时通过；同一 `gitDir` 的进程内队列与跨进程文件锁已覆盖（2026-09-09 修复） |

### 4.3 用户提供的真实对话夹具：能力询问与“必须查询”

用户提供的对话记录（原始文本保存在用户侧附件，不复制进仓库）固定了以下复现序列：

1. 用户多次询问“你能调用网络了吗/现在呢”，旧 Harness 每次都重复注入相同能力清单，并把“思考”“轻量任务 · 1 步”“目标”“验收标准”“完成”“验证通过”等内部过程直接显示在对话区。
2. 用户追问“你查询过了？”后，模型才承认没有执行查询，只是依据能力清单声明；随后又提出可以用 `exec` 试探，但没有先由 Runtime 返回真实工具注册/权限事实。
3. 用户明确说“基于事实，因此你需要查询”和“权限给你了”，旧路径仍反复复述旧清单；权限授予没有形成可验证的 runtime permission event 或 capability epoch 变化。
4. 在用户允许尝试后，输出出现了 `RuntimeError: exec is not permitted by the runtime policy`、`Network I/O is disabled` 等仿佛工具返回的文本，但记录中没有与之对应的权威 tool-call、参数、拒绝原因、时间和 settlement 事件。

这条夹具不证明当时网络“能用”或“不能用”；它证明的是 Harness 结构问题：

- 内部 reasoning、TaskBook/验收状态和 Agent 最终文案没有分层，UI 将 Runtime 状态伪装成 Agent 语言。
- 能力清单是可能过期的 prompt 文本，不是带 revision/epoch 的 Runtime capability snapshot；权限声明、工具注册和实际执行结果没有同一事实链。
- “查询”这一用户意图没有强制产生一次真实、可回查的 probe/tool event；模型可以在没有执行的情况下生成“验证通过”或具体 Runtime 错误。
- 多轮相同回答没有会话级文案指纹占用和重复原因，既增加请求成本，也会让用户无法判断状态是否真的变化。

新 Harness 必须把该记录变成跨旧/新路径都运行的回归夹具，最低完成门如下：

- 对能力边界问题，默认只产生一条简洁的 Agent 最终回答；内部 route、目标、验收和 Runtime 状态走独立非消息 projection，不进入自然语言消息。
- 用户要求“查询/实测”时，只有真实工具或 provider probe 的权威事件才能产生“已查询”或具体错误；未执行只能说“尚未查询”，不能伪造工具输出、网络错误、完成或验证通过。
- 用户在聊天中表示“权限给你了”不会绕过 Main 的权限边界；Runtime 必须返回当前 permission mode、capability epoch 和实际 allow/approval/deny 结果。若聊天授予需要 UI/系统确认，必须显示待确认状态，而不是假定权限已变更。
- 能力清单、Provider 状态、网络开关和权限变化都通过版本化 snapshot 与显式 invalidation reason 更新；同一 snapshot 未变化时可以返回“状态未改变”，但不重复发送完全相同的 Agent 文案。
- 断线、重试或 Renderer 重连只能重放同一 `FinalReplySettled`/Runtime status projection；不能由模型重新叙述一遍工具错误或内部思考。

建议夹具事件序列（事件名可按实现适配，但语义必须保留）：

```text
UserInputAppended(capability-question)
  -> CapabilitySnapshotRead(epoch=N)
  -> RouteDecided(respond | execute-probe | clarify)
  -> [若用户要求实测] ProbeIntentCreated -> ProbeSettled
  -> FinalReplyProposed
  -> FinalReplySettled 或 RuntimeStatusSettled
```

该夹具还要断言 stable-prefix fingerprint 在只改变当前时间、run id、重复询问次数和 probe 耗时后不变；能力注册、权限 mode、Provider 状态或工具 schema 真正变化时才按 CACHE-05 产生对应失效原因。

## 5. 候选开源底座评估

### 5.1 候选范围

第一轮至少评估以下三类，不预先承诺采用：

| 候选 | 当前可借鉴点 | 已知边界 | 必须核验 |
| --- | --- | --- | --- |
| Pi Agent runtime | `Agent + AgentSession` 是真实可运行的核心底座，适合观察 session、streaming 和 tool loop | 新的 `AgentHarness` 入口偏 scaffold，不能当成完成的 durable harness | 固定 commit、license、session 持久化、工具取消/恢复、依赖树和 Windows/Electron 适配 |
| DeepSeek Harness | append-only `SessionEvent`、持久 inbox、事件 projection、插件策略等设计输入 | developer preview；稳定性、生态和发布责任不能由文档推断 | 固定版本、license/notice、crash recovery、供应链、性能、API 变更和真实测试 |
| 其他开源 Agent runtime | 可能提供更成熟的 event sourcing、session、tool orchestration 或 provider adapter | 可能把权限、prompt、memory 或 UI 绑定到其产品假设 | 运行入口、许可证、维护活跃度、依赖风险、可抽换边界和迁移成本 |

### 5.2 评估矩阵

每个候选都要建立一份可审计记录，至少包含：

- 仓库 URL、固定 commit/tag、发布日期、维护者、release/issue 活跃度和已知安全公告。
- LICENSE、SPDX 标识、NOTICE、transitive dependency license、代码生成物来源和再分发义务。未知许可证不能进入生产依赖。
- 真实可运行的最小路径：创建 Agent/session、发送一轮消息、streaming、工具调用、取消、session reload 和错误恢复。
- 是否支持 append-only event、持久 inbox、cursor/idempotency、projection rebuild、effect intent/settlement；没有的能力由 LS adapter 补齐还是直接淘汰。
- provider/model/tool schema 的扩展点、请求序列化控制权、流式事件顺序、token usage 和缓存 usage 是否可获取。
- 与现有 `@littlesheep/safety`、Tool Execution Service、Runner、Memory Service、Local App API、Electron 主进程和渠道 facade 的依赖方向。
- 包大小、安装脚本、原生依赖、网络访问、动态代码、遥测、凭证读取和供应链锁定方式。

### 5.3 采用门

候选只有在以下条件全部满足后才可成为依赖：

1. 固定版本的许可证、NOTICE、依赖和漏洞快照已保存到供应链审查记录。
2. 最小运行路径在隔离数据根和禁止外网的测试中通过，未隐式读取 LS 凭证或绕过 Runtime 工具入口。
3. session 生命周期、streaming、工具取消和错误恢复的所有权已写入 adapter 契约。
4. 引入它不会让 App/渠道反向依赖 Harness 内部实现，也不会把 LS 的权限和 Memory 写入策略交给模型或第三方代码。
5. 若候选只适合做参考，必须明确记录“借鉴设计、不引入依赖”。

## 6. 目标运行时模型

### 6.1 控制流

```text
Ingress
  -> Command validation
  -> Durable inbox append
  -> Harness kernel
       -> route/respond/execute/clarify
       -> model request or effect intent
       -> event append
       -> projection/checkpoint
       -> verify
       -> final reply settlement
  -> UI/channel projections
```

模型只负责受限语义活动和自然语言表达。Runtime 负责命令校验、权限、工具、状态迁移、预算、重试、验证、结算、审计和最终发布。

### 6.2 事件与 projection

最小事件集合应覆盖 `RunAccepted`、`UserInputAppended`、`RouteDecided`、`ModelRequestStarted`、`ModelResponseReceived`、`ToolCallProposed`、`EffectIntentCreated`、`EffectSettled`、`VerificationRecorded`、`CheckpointWritten`、`FinalReplyProposed`、`FinalReplySettled`、`RunFailed`、`RunInterrupted` 和 `RunCompleted`。实际名称可以适配底座，但语义不能丢失。

- 事件按 session/run 分区、单调 cursor、append-only 写入；每个 payload 有大小上限、schema version、敏感字段清洗和 owner。
- inbox 以稳定 `eventId + idempotencyKey` 去重；重复投递只能得到 `duplicate`，不能重复工具、副作用或用户文案。
- projection 可以从事件重建，不能把 projection 当成唯一事实；重建后要与 checkpoint、execution log 和会话索引进行一致性检查。
- cursor replay 必须能从任意已确认 cursor 继续；中途失败保留未处理事件，不跳过未知事件，不把截断输出当完整事实。

### 6.3 Effect intent 与 settlement

- 每个写入、执行、外部请求或其他可能产生影响的操作，先 append `EffectIntentCreated`，包含工具、参数摘要、权限结果、资源范围、幂等键、超时和 owner。
- Tool Execution Service 成功返回后 append `EffectSettled`，包含 `success / failed / cancelled / unknown`、有界结果摘要、调用证据和清洗/截断状态。
- 进程退出时有 intent 无 settlement，恢复逻辑必须先查询可验证的操作状态；无法证明未执行时标记 `unknown` 并请求用户决定，禁止盲目重试。
- 已有 settlement 的 effect 重放只重建 projection，不再次调用工具。重试只针对明确可重试且没有已确认副作用的错误。

### 6.4 Authoritative final settlement

- 真实 LLM 生成的最终文案先作为 `FinalReplyProposed`，绑定 `modelRequestId`、request index、provider/model、Context snapshot 和连续性评估证据。
- 通过唯一性注册表、回答级连续性、citation/evidence、Runtime 状态和持久化会话写入闸门后，原子 append `FinalReplySettled`。
- Renderer、CLI、Webhook 和其他渠道只消费同一个 settlement projection；stream delta 是临时显示，不是第二条消息。断线重连只能 replay 已有 settlement。
- settlement 未落盘、来源无法回查、文案为空/重复、Provider usage 不可对账到需要对账的门时，只发布 Runtime error/status，不用固定模板伪装成 Agent 回复。
- 按钮、状态、进度、权限、路径、工具事实由 Runtime 投影，模型不能改写。

## 7. Context 与 Prompt Cache 设计原则

### 7.1 三套缓存分开记账

| 缓存 | 权威来源 | 可回答的问题 | 不可替代之处 |
| --- | --- | --- | --- |
| Provider prompt-cache | Provider 请求后返回的 `cachedPromptTokens`/等价字段 | 这一次请求有多少输入 token 被 Provider 认定为缓存 | 不证明 LS 组装是否命中，也不证明 Memory/Embedding 命中 |
| LS Context cache | Context Engine 的候选、排序、装配和 snapshot 计时/命中 | 本地是否复用了候选或序列化结果 | 不得推算 Provider 命中率 |
| Memory/Embedding cache | Memory repository、FTS、向量目录和 embedding pipeline | 检索/向量是否复用、是否重新计算 | 不得把召回成功写成 prompt-cache 命中 |

每个报表同时给出 request count、token count、hit/miss/partial/unavailable/unknown 计数、scope、provider/model、时间窗和样本数。三套账本不共用一个“缓存命中率”字段。

### 7.2 稳定前缀与动态后缀

新 Prompt assembler 必须输出一个版本化的 `StablePrefixV1` 和明确的 boundary marker：

- 稳定前缀只放本 request kind 所需的版本化系统策略、固定行为契约、确定性 capability/tool schema、固定输出协议和经过明确版本登记的静态 profile 内容。
- 当前用户消息、最近历史、memory root index、KnownState、Atom evidence、附件 manifest、TaskBook/步骤进度、工具结果、runtime awareness、时间、run ID、revision、重试计数、错误和请求级诊断必须在 boundary marker 之后。
- stage 名称、阶段计数、工具耗时和动态权限状态不能因为方便拼接而进入稳定前缀。若 Provider 需要按 request kind 区分，kind 必须成为显式、稳定且可解释的 prefix partition。
- `SOUL.md`、用户设置、工具 schema、模型能力和系统策略的版本变化必须使对应 prefix version 变化，并记录失效原因；不能静默复用旧前缀。
- 稳定前缀、动态后缀、消息数组、工具定义和 JSON 结构都必须采用固定 Unicode normalization、换行、数字格式、键排序、数组顺序和 null/empty 规则。

## 8. CACHE-01 至 CACHE-10

这些条目是 P0 级专项门。任何一项未完成，都不能宣称“缓存问题已解决”；可以先以 `observed / blocked / unavailable` 状态继续其他 Harness 工作，但不得用估算补齐缺失证据。

### CACHE-01：指标和定义

- 定义 Provider token hit ratio：仅当同一请求有有效 `promptTokens` 与 `cachedPromptTokens` 时计算 `cachedPromptTokens / promptTokens`；同时记录 request-level hit、partial 和 unknown。
- 保存 provider、model、adapter、request kind、usage schema version、request index 和 `modelRequestId`；无权威 usage 时为 `unavailable`。
- 明确 `promptTokens`、`cachedPromptTokens`、completion、reasoning、total 的来源和整数校验，禁止负数、缓存超过 prompt、跨请求拼接。
- 验收：fake provider、DeepSeek 真实 usage（如凭证和网络前置允许）和缺字段 provider 各有正/负夹具；UI/日志不把 local estimate 显示成实测。

### CACHE-02：脱敏前缀/后缀指纹

- 在 Provider 请求前生成 stable-prefix、dynamic-suffix、完整规范化请求的脱敏指纹；默认使用设备本地密钥的 HMAC-SHA-256，并绑定明确的 cache scope、schema version 和 provider/model partition。
- 指纹不得可逆推出 prompt、正文、URL、密钥或工具参数；普通日志只保存前缀版本、短指纹、长度/计数和失效原因，不保存原始字节。
- 指纹生成必须在发送前完成并绑定 request snapshot；重试和 replay 复用同一 request identity，真正重建时明确标注 `replayed`。
- 验收：相同规范化前缀得到相同指纹；一字节、一个 schema key、一个 scope 或一个版本变化得到可解释的不同结果；跨 session/workspace/permission scope 不误合并。

### CACHE-03：确定性 Context 与序列化

- 候选排序、裁剪、消息顺序、工具 schema 顺序、JSON key 顺序、空值、Unicode、换行和数字格式都必须有确定性实现与测试。
- 同一 `ContextInput`、同一版本和同一 scope 在重启、不同 worker、不同并发顺序下生成相同 stable prefix 和相同 suffix 序列化。
- 不允许 Map/Set 插入顺序、文件扫描顺序、Promise 完成顺序、当前时间或随机 ID影响稳定段。
- 验收：100 次重复装配、并发反转、重启重放、Windows 路径大小写夹具的字节级结果一致；差异可定位到字段。

### CACHE-04：动态字段隔离

- 把 runtime clock、elapsed、run ID、revision、阶段计数、工具耗时、实时状态、记忆采用/释放、重试、错误和用户输入全部隔离在 boundary marker 后。
- stage 之间共享稳定 prefix 版本，stage-specific 指令进入有界 suffix；若确实不能共享，必须记录 request kind partition 和成本理由。
- 不得为了显示“当前时间”而重建稳定 prefix；每次请求仍生成最新 dynamic suffix。
- 验收：只改变一个动态字段时 stable-prefix fingerprint 不变；只改变静态策略/工具 schema 时 fingerprint 改变且给出 invalidation reason。

### CACHE-05：显式缓存失效原因

至少提供以下稳定枚举，并允许 `unknown`：`model_changed`、`provider_changed`、`adapter_changed`、`prompt_version_changed`、`system_policy_changed`、`soul_changed`、`user_profile_changed`、`tool_schema_changed`、`memory_revision_changed`、`workspace_changed`、`permission_changed`、`session_reset`、`summary_compacted`、`locale_changed`、`request_kind_changed`、`manual_clear`、`replayed`。

- 一次请求可以有多个原因，但必须有排序稳定的 primary reason；原因来自 Runtime 比较，不由模型填写。
- cache miss 没有可证明原因时记录 `unknown` 并进入诊断队列，不擅自归因于 Context 或 Provider。
- 验收：每个原因有最小复现夹具、预期 prefix 变化和不应变化的字段；历史日志缺字段保持缺失而不是补猜。

### CACHE-06：session/workspace/permission 安全隔离

- cache key、fingerprint partition、Context snapshot 和本地缓存条目必须绑定 session/workspace/permission scope；不能因为 prefix 相同就跨用户、跨工作区或跨权限复用敏感 suffix/evidence。
- Provider 共享前缀只允许共享不含用户数据和权限事实的稳定公共部分；任何实际注入前都要重新做 scope 和权限校验。
- workspace 外资源、受限模式、外部证据、附件和 secret-bearing tool result 默认不进入可跨 scope 的缓存。
- 验收：双 session、双 workspace、三档权限、重启和并发交叉读取夹具均不能观察到对方的消息、路径、Atom、工具结果或指纹关联；越界访问在缓存命中前拒绝。

### CACHE-07：Provider usage 对账

- 每个实际 Provider 请求都关联 `ModelRequestSnapshot`、prefix/suffix fingerprint、发送时间、provider/model、usage、HTTP/stream 状态和最终 settlement/retry 关系。
- 本地 tokenizer 只能作为请求前预算和校准输入；Provider usage 是请求后权威值。两者差异要记录 `exact_match / within_tolerance / mismatch / unavailable`，不能静默覆盖。
- streaming、abort、timeout、rate-limit、connection reset、duplicate rewrite、continuity repair 和 retry 各自记录是否真正到达 Provider；未到达的请求不生成虚假 usage。
- 验收：同一 request 的本地和 Provider 账本可逐字段对齐；中断、重试和 settlement 失败的调用数、token 数与事件流水一致。

### CACHE-08：请求形态和生命周期矩阵

至少覆盖以下场景，并分别记录 prefix fingerprint、cache status、调用数、token、延迟、回答质量和失败状态：

- 相同输入重复请求、相同输入跨 stage、不同用户消息、最近历史变化。
- memory root index/Atom 注入、释放/采用、KnownState revision、摘要压缩和附件 manifest 变化。
- 工具 schema 增删、顺序变化、工具结果变化、工具循环续轮和多工具乱序结果。
- 模型切换、Provider/adapter 切换、配置热重载、session 重启、checkpoint replay、streaming、abort、retry、continuity repair、duplicate rewrite。
- 并发相同请求、并发不同 session、Provider 返回 cache usage 缺失、partial、rate-limit、timeout 和 5xx。

验收不以某个固定百分比为先验目标；先证明观测完整，再以冻结基线和代表性任务形成可重复对比。

### CACHE-09：成本、延迟、请求数和质量

- 每个优化候选必须同时报告 Provider prompt/completion/reasoning/cache token、请求数、P50/P95 延迟、取消率、失败率、内存/磁盘成本和回答级质量/连续性。
- 减少 token 但造成漏答、错误工具参数、citation 丢失、记忆断档、VERIFY 变弱或副作用恢复不安全，不算优化。
- 将“Context cache 命中”与“Provider cache 命中”分栏；禁止用单一总分掩盖其中一项下降。
- 验收：固定夹具在旧 Harness、新 Harness、shadow 和 cutover 四种模式下可重跑，统计窗口、模型、配置和网络条件写入报告。

### CACHE-10：无指标降级和发布门

- Provider 不返回 cache usage、返回格式未知、请求被取消、连接未建立或账本无法绑定时，显示 `unavailable/unknown`，保留原因和 request identity，不显示命中率数字。
- 观测系统自身失败不能阻断普通安全请求，也不能让请求改走未审计 Provider；只将 cache quality 标记为 unavailable 并产生 Runtime 诊断。
- 新 Harness 只有在 CACHE-01 至 CACHE-09 的离线/真实可用范围门、双路径对比、跨重启和安全隔离全部通过后，才可把缓存专项状态改为 `ready`。
- 任何真实 Provider 证据受凭证、网络、配额或模型不可用阻断时，任务书必须保留 `blocked`/`unavailable`，不能用 fake provider 的命中率替代发布结论。

## 9. 阶段计划

### 阶段 0：冻结当前基线

状态：已完成（`a925a50`、`freeze-2026-09-02`）。

完成门：冻结提交可在远端找到，工作树干净，旧 Harness、旧 session/checkpoint 和现有质量门可回验。

### 阶段 1：开源底座与边界评估

状态：已完成（保留自有 kernel，仅吸收已核验的 durable event/session/stream 设计）。

工作项：固定候选 commit；完成许可证/NOTICE/依赖/漏洞/维护性审查；运行最小 Agent/session/tool/stream/cancel/reload 夹具；绘制 LS adapter 边界和不采用理由。

完成门：至少一个候选通过采用门，或者有证据决定保持自有 kernel、只吸收可验证设计；没有未登记的 transitive dependency、遥测、凭证读取或权限旁路。

证据：候选固定版本、许可证、供应链缺口、最小运行能力、LS adapter 边界和不采用理由已记录在[开源底座评估记录](../reference/harness-open-source-evaluation-2026-09-02.md)。三个候选均未同时满足生产采用门，因此本阶段不新增第三方 Harness 依赖。

### 阶段 2：CACHE-01 至 CACHE-07 观测基础

状态：进行中，优先级 P0。

工作项：实现 request snapshot 关联、三套 cache ledger、脱敏 HMAC 指纹、stable/dynamic boundary、Provider usage reconciliation 和失效原因枚举。先接入旧 Harness 的只读观测适配，不改变旧请求语义。

当前增量：已接入 request-bound HMAC 观测、prompt source 失效原因、稳定/动态 addon 分层和 Provider usage 对账；本轮又把 Runtime capability snapshot/probe 接入版本化 durable event 链，并用真实对话回归夹具验证 capability question、capability probe 与 Web query 的分层。新增 CACHE-03/04/05 确定性矩阵夹具：100 次字节级重复、并发顺序反转、同 key 重启、Windows 路径大小写、动态字段隔离、静态字段/工具 schema 失效原因均已通过；本轮修正了 LS Context ledger 的语义，Context 组装在没有真实 cache observation event 时只发布 `unavailable/context_cache_event_not_observed`，不再把组装误报为 `miss`；模型解析重试、重复文案重写、连续性/引用修复和执行回复修复均记录显式 `retryOf`，durable projection 会拒绝自指或未知 parent。`CacheObservationStore` 已接入真实 Runner production observation path：每个实际模型请求在 prepared、Provider usage 或失败状态边界持久化经过 codec 校验的脱敏 observation，按 session/workspace/permission/HMAC scope 隔离，并通过真实 Runner 回归验证重启查询、跨 scope 不命中、usage 缺失保持 `unavailable`、持久化失败不阻断正常回答和文件无 prompt/正文/工具参数/Provider 原始 JSON。它仍只是可回查的观测存储，不是 Context prompt payload 复用器，也不能把 observation hit 当作 Context 或 Provider 命中。本轮进一步把本地精确 tokenizer 校准写入 durable provider usage projection：`localCalibration` 现在与同一请求的 provider prompt tokens 做字段级校验（difference、relative difference、status 与 reconciliation 映射），并新增 exact_match / within_tolerance / mismatch 及篡改拒绝夹具；真实 Provider usage 对账仍待凭证/网络可用时完成。本轮补齐 CACHE-06 observation-store 隔离矩阵：2 session × 2 workspace × 3 权限共 12 个 scope 的 partition/fingerprint 唯一性、并发交叉读取、重启后隔离、嵌入 scope 篡改拒绝和落盘脱敏均已验证。本轮还补齐 CACHE-05 的 `manual_clear`、`replayed` 与 `adapter_changed` 失效原因：Runtime 可通过显式输入标记本地缓存清理、重建和适配器变化，三个原因都有最小复现夹具；生产端手动清理/重建调用方仍待接线。effect intent/settlement 的耐久性语义已修正并有 42 项执行回归。durable `model request` projection 现在携带事件 envelope 的 `startedAt`/`respondedAt`/`settledAt`，并提供脱敏的 `summarizeModelRequestLatency`（nearest-rank P50/P95/max 与 received/pending/aborted/failure 计数，缺失、非法或负时长保持 `unavailable`）；这是 CACHE-07 发送时间和 CACHE-09 延迟报告的基础。本轮新增 `buildCacheQualityReport`：分别汇总 Provider/Context/Memory 三套 ledger 的 status、token、hitRatio 和 reason，加上 invalidation reason 分布与 durable 延迟摘要；release gate 只返回 `blocked`/`unavailable`，真实 Provider 对账未验证时永不 `ready`。本轮进一步把报告接到 `CacheObservationStore.report()`：按 session/workspace/permission/HMAC scope 授权后扫描，跨 scope 条目不会返回，损坏或嵌入 scope 不匹配的条目只把 gate 降级为 `cache_entries_unreadable`，不会当作命中；本轮新增 `since`/`until` 时间窗，只返回窗口内条目。本轮把该能力接到 Local App API `GET /runtime/cache-quality`：要求显式 session/workspace/permission，接受 ISO 或 epoch 毫秒时间窗，缺少 scope 或 key 时返回 `unavailable`，不泄露跨 scope 内容。本轮新增 `CacheObservationStore.latest()` 和 Runner 的 `previousCacheObservation`：首次模型请求会与同一 scope 的上一条跨 run 观测比较，配置热重载或模型切换现在能解释为 `model_changed`/`provider_changed`/`adapter_changed`。本轮对默认 DeepSeek 执行一次极小无工具真实探针，Provider 返回 401 Authentication Fails，当前环境密钥无效/过期；未保存 prompt、回复正文或密钥，CACHE-07 真实对账保持 blocked。CACHE-06 的 observation-store、KnownState 注入和 working-set 释放隔离已覆盖；跨 Atom 检索/重排的完整隔离仍需在 CACHE-08 memory 矩阵中继续验证；CACHE-07 真实 Provider usage 对账、CACHE-08/09/10、生产级 effect crash/replay 仍待完成，不能据此宣称缓存问题已解决。

完成门：同一请求可在不暴露 prompt 的前提下解释 prefix/suffix、Provider usage、local ledger、scope 和 invalidation reason；缺指标时安全降级；没有因观测而增加第二份用户文案或 Provider 请求。

本轮能力事实链增量（2026-09-03）：`capability_snapshot_read` 和 `capability_probe_settled` 已纳入 durable event protocol、append-only store、inbox codec 和 projection reducer。能力路由必须先记录脱敏 snapshot；probe 只能引用同一 capability epoch，且 capability probe 不得放行 `web_search`/`web_fetch`。附件中的“你能调用网络了吗/现在呢/你查询过了吗/基于事实，因此你需要查询/权限给你了啊”序列已形成固定回归，断言内部 reasoning、TaskBook、验收和伪造网络错误不会进入聊天区；这只证明事实分层与审计链行为，不证明真实 Provider 可用或缓存专项完成。

### 阶段 3：确定性 Context 与请求形态矩阵

状态：进行中，优先级 P0。

工作项：完成 CACHE-03、CACHE-04、CACHE-08 的确定性序列化、候选裁剪和 stage/request kind 规划；用 fake provider 覆盖 memory、summary、tools、retry、streaming、restart、concurrency；再在凭证/网络可用时运行真实 Provider usage 对账。当前已完成第一批 CACHE-03/04/05 夹具和字段级差异断言，本轮补齐工具结果与两轮工具循环夹具：工具调用和工具结果始终进入 dynamic suffix，stable-prefix fingerprint 不变且无 invalidation reason，序列化不含工具参数和结果正文；工具 schema 增删仍按 `tool_schema_changed` 失效。本轮补充 KnownState 注入端到端夹具：注入内容只改变 dynamic suffix，不改变 stable-prefix fingerprint，序列化观测不含 atom id 或 KnownState 正文。本轮补充 working-set 释放端到端夹具：释放 Atom 后系统消息移除该 Atom 正文，stable-prefix fingerprint 不变，dynamic suffix 变化，失效原因明确为 `memory_revision_changed`，序列化观测不含 Atom 正文。本轮补充附件 manifest 端到端夹具：附件只进入 dynamic suffix，stable-prefix fingerprint 不变且无 invalidation reason，序列化观测不含附件名或路径。本轮补充 Provider 请求进行中中止的 runner 夹具：durable model request 记录 aborted/not_reached/unavailable/aborted，cache observation 记录 `provider_request_aborted`，不生成伪造 provider usage。本轮补充 Provider 5xx 场景：记录为 failed/unknown/failed/unavailable，不生成伪造 provider usage。本轮补充 duplicate rewrite 的 durable lineage：exact-reply 重写请求记录 `retryOf` 指向同一 run 的前一条请求。尚未覆盖完整 CACHE-08 请求形态矩阵。

本轮新增并发 session 缓存隔离夹具；该夹具在 versioning 开启时复现了 H-OLD-08 的 `index.lock` 争抢，现已修复：`ShadowGitRepository` 按解析后的 `gitDir` 在进程内共享 mutation 队列，并用 `@littlesheep/session` 的跨进程文件锁串行化同一仓库的初始化、add/commit/restore；并发不同 session 的 runner 夹具已恢复 versioning 并通过，snapshot 层新增两个 coordinator 共享 data root 的并发 checkpoint 夹具和 mutation-lock 等待夹具。本轮继续补齐 CACHE-08 生命周期：checkpoint resume 的首个模型请求在生产路径标记 `replayed`，runner continuation 夹具断言该原因；配置热重载通过 `system_policy_changed` 解释；多工具乱序结果只改变 dynamic suffix、不触发 stable-prefix 失效且不泄漏工具参数/结果；continuity repair 的修复请求由 `retryOf` 显式关联到首个 reply 请求，reply 夹具已断言。并补充 next 模式 streaming + partial provider usage 端到端回归，确认 model response/settlement/final reply/run_completed 都正常结算。D1 Atom 注入夹具已切到 next，验证 Initially Selected Memory Atoms、KnownState、working set 和记忆访问账本在新路径同样成立。离线/fake provider 的 CACHE-08 请求形态矩阵已覆盖上述组合；真实 Provider usage 对账和成本/质量对比仍受凭证与网络条件限制。

完成门：所有前缀变化可由字节差异和失效原因解释；未发现原因的 miss 明确标 `unknown`；只有在数据支持时才决定修改 Context Engine、Prompt assembler、Provider adapter 或请求数量。

### 阶段 4：Durable Harness kernel

状态：进行中，优先级 P0。

工作项：实现 append-only event store、持久 inbox、cursor replay、幂等 projection、事件版本和 crash recovery；为旧 `RunContext` 建立只读 projection，不让新 kernel 直接改旧数据结构。当前已新增独立 `createNextHarness` 阶段驱动、`stage_transition_recorded` 审计事件和 Runner `durableHarnessMode: 'next'` 真实选择路径；Runner 已增加统一 authoritative publication boundary，Local App 普通 POST/SSE、checkpoint resume SSE、CLI、ChannelManager 和通用 `/runs/:id` replay 均只发布 durable settled reply 或 Runtime status，未结算 proposal 不再从结果、历史或 execution-log replay 泄露。effect intent/settlement 已补齐“intent 未耐久则零调用、settlement 已耐久但 checkpoint 失败不降级 effect、settlement 耐久性不确定不补写冲突 settlement”的基础语义和定向回归；已新增真实 Tool Execution Service 端到端未知副作用夹具：自定义写工具实际写入后抛错，工具只执行一次，side effect 结算为 `unknown`，durable projection 产生 `unknownEffectIds`，next 路径返回需要用户决定的 Runtime 错误而不发布成功文案。本轮修复终态恢复缺口：当 effect settlement 落盘失败、Runner 已发布 `run_failed`/Runtime status 后，重启恢复不再因终态提前返回，仍会把 pending effect/model request 审计性结算为 `unknown`/`missing`；未知 effect 不会把已终态 Run 回退成第二个 `waiting_user`。新增 durable kernel 终态审计关闭夹具，以及真实 Runner + Tool Execution Service 的“工具已写入→settlement 落盘失败→重启恢复”端到端夹具，确认工具只执行一次、`unknownEffectIds` 保留、无成功文案。本轮继续收紧 durable inbox 的跨进程领取语义：每次 claim 生成唯一 owner token，租约过期重领会轮换 token，旧 worker 的 complete/fail 会被拒绝；kernel 失去 claim ownership 后不再覆盖新 owner 的结算。旧 version 1 已领取命令若没有 token，保留到下次重领前的兼容读取。生产 next Runner 的 `run_accepted`/`user_input_appended` 已先写 command inbox，再 materialize 到 event store；command-only 与 event-without-completion 两个真实文件重启点均可恢复，启动扫描也会合并 inbox-only run。未到期 claim 会从可立即恢复和 event-store 启动恢复集合排除，避免并发进程抢先关闭仍活跃的 run；应用会为它安排单一、可取消的最近 lease wake-up，到期后只重扫 inbox 并尝试由新 owner 接管，不再要求第二次重启。本轮补充真实 OS 进程 kill：子进程领取 ingress 后被强制终止，新实例等待 lease、重领并恢复，command attempts=2 且 event 仍只有一条。本轮还覆盖 loopback Webhook 重复投递和 next Provider timeout。Harness + Runner + App recovery 完整受影响回归当前为 94 个文件、826 项通过。模型/effect 边界的真实进程杀死、长运行 run/effect lease、真实外部 Webhook 重连和旧/新完整双路径门仍未完成。

本轮进一步把 durable inbox 接入 next Runner 的真实 ingress 链：`run_accepted` 与 `user_input_appended` 先持久化 command，再按精确 command 过滤领取，随后 append event 并以同一 claim token 完成；内部 stage/model/effect/settlement 事实继续直接写 append-only event store，避免把 inbox 错用成无界 event outbox。事件 source 与显式时间戳跨 inbox 保留，shadow 路径不增加 inbox 写入。生产 Runner 夹具断言两个 ingress event 与 completed inbox command 一一对应，内部 route event 不进入 inbox；跨 run filter 夹具证明一个 drain 不会顺带领取另一 run。为避免继续扩大 kernel 热点，claim/materialize/fencing 已拆入独立 inbox processor。Harness + Runner 91 个文件、818 项通过。

重启恢复证据继续覆盖两个 inbox 崩溃点：“command 已落盘但 event 未生成”在重启后生成并完成一条 event；“event 已生成但 completion 未落盘”在租约过期重领后只重放同一 event，事件数保持 1、command attempts 增至 2 并完成。Inbox 现在提供最多 256 个、可显式限制的未结算 run 身份枚举，Local App 启动发现会合并 event store 与 inbox run 并去重；`recoverRun` 先处理该 run 的 queued ingress，再重建 projection。只有 `run_accepted` 而缺少后续用户输入/结算的崩溃态会明确收口为 `waiting_user/run_incomplete_after_restart`，不再因为没有 event partition 而静默消失。重复的 completed ingress 不再授予第二个 worker 执行权：同一真实 store 的第二个 next recorder 在模型/工具调用前失败关闭；同 turn 并发仍由请求 coordinator 合并，合法重启继续走 request replay/recovery。当前 Harness + Runner 完整回归为 92 个文件、822 项通过。

当前增量（2026-09-10 19:43:41）：上方早先登记的“长运行 run lease”缺口已关闭。next Runner 已接入独立持久 run owner、半租期 heartbeat、所有权丢失 abort、终态 release 和 recovery acquire；App 会排除活动 owner，并在过期后恢复。真实子进程在至少一次续租后被强制杀死，新实例等待 lease 后以新 token/attempt 接管。effect 自身的 lease、模型/effect 边界 kill 和真实连接断开仍是本阶段缺口。完整受影响回归为 99 个文件、837 项通过。

当前增量（2026-09-10 20:21:40）：effect 自身的 owner/lease 缺口已关闭。next Runner 在 effect intent 前取得独立跨进程 lease，以半租期 heartbeat 续租；intent/checkpoint 只保存 owner token 摘要与到期时间，租约文件只保存派生 effect key。工具返回后必须先用原 fencing token 再续租确认 owner，settlement 绑定同一 owner evidence；失去 owner 的旧 worker 只能保持 `unknown`，不能提交成功。settlement 落盘后释放 effect lease，Runner 收尾先清 effect owner 再清 run owner。真实 production tool 挂起期间已验证 active lease，结束后验证 released；真实子进程续租后被 `SIGKILL`，新进程等待到期后以 attempts=2/new token 接管。并行 effect ledger 的异步合并竞态也已修复。当前完整受影响回归为 104 个文件、850 项通过；workspace typecheck、`check:repo` 33/33 和 diff 门通过。仍缺完整 Runner 在真实工具调用中被杀死后的外部状态查询/对账，以及真实连接断开。

完成门：随机断电/进程杀死/连接断开/重复投递后，run、session、checkpoint、execution log 和最终状态可重建；已完成工具和 settlement 不重复执行；未知事件不被静默丢弃。

### 阶段 5：Effect lifecycle 与 authoritative settlement

状态：进行中，优先级 P0。

工作项：把工具/副作用接入 intent/settlement；实现 single final reply settlement、stream 临时投影、唯一性注册、continuity/citation/VERIFY 闸门和渠道投影；补齐 FINALIZE 持久化失败语义。基础 final-reply settlement、恢复时的 Runtime status、统一渠道/CLI/App/replay publication boundary 和 proposal 历史过滤已接入并有定向回归；本轮修正 effect settlement 与 post-effect checkpoint 的先后和失败语义，并进一步区分执行前拒绝与执行后结果不明：intent 已耐久但 pre-effect checkpoint 失败时工具零调用，effect 现在结算为 `failed` 而不是 `unknown`，不会误入 `waiting_user`；工具实际执行后返回非成功结果仍保持 `unknown`。本轮补齐 `cancelled`：Run 在 effect intent 已耐久、但工具尚未调用前已中止时，工具零调用，effect 结算为 `cancelled`；checkpoint store 接受该终态，projection 不会把它当作 uncertain。本轮进一步保证终态后的审计关闭：pending effect 只能补记为 `unknown`，不能重开 Run 或产生第二份用户决定状态；真实 Runner 重启夹具同时证明工具不重放。本轮补齐 FINALIZE 会话正文持久化失败全链路：真实 Runner 夹具让 assistant finalize 写入失败，确认 Run 失败、`result.reply` 不泄露未落盘文案、durable projection 只保留 `runtime_status`；结合 execution log、session summary、final-reply registry、durable event 失败夹具，FINALIZE 主要持久化分支均已 fail-closed。全仓当前工作树 411 个文件、2,898 项通过、1 项 skipped；workspace typecheck 与 `check:repo` 33/33 通过。与真实 Tool Execution Service 的其余生产级故障对账和真实渠道重连仍待完成。

当前增量（2026-09-10 20:21:40）：effect intent/settlement 已绑定跨进程 owner/lease。active owner 冲突在工具零调用前失败；工具结束后需重新确认 fencing token 才能 append settlement，owner 丢失时不发布成功；durable settlement 后才 release。checkpoint codec 保留脱敏 owner/lease，durable reducer 拒绝 tool settlement 的 owner mismatch，同时兼容旧的无 lease 历史事件和 Runtime recovery settlement。lease store、coordinator、生产 Runner 挂起工具和真实 OS-process kill/reclaim 均有证据。尚未完成的是“整个 Runner 在真实外部 effect 调用中被杀死后，依据外部系统状态查询决定 success/failed/unknown”的业务级恢复对账，以及真实渠道重连。

当前增量（2026-09-11 00:08:07）：恢复路径已把业务级对账的 kernel 能力补上：`queryEffectOutcome` 回调会在 pending effect 被标记 `unknown` 前先让宿主查询外部系统，明确 `known` 且为 `succeeded/failed/unknown` 时才按查询结果结算；查询不可用或抛错保持保守 `unknown`，不重放 effect 或模型。恢复 action 记录实际终态，`createDurableRunRecovery` 会在 run/effect 两级租约均接管后把回调透传给 kernel。新增已知结果、不可解析和查询抛错三项 kernel 回归，以及 adapter 透传夹具。仍未完成的是把生产调用方接到具体外部工具/渠道的真实状态对账。

当前增量（2026-09-11 00:43:21）：生产 Runner 已接上该回调：`createRunner({ queryDurableEffectOutcome })` 透传到 lease-aware 恢复适配器；内部重试恢复也改为复用同一适配器，不再直接调用 kernel 绕过 owner。新增 Runner 端到端夹具验证真实工具结算丢失后重启，宿主查询把 effect 结算为 `succeeded` 并保留外部 evidence，工具零重放、不发布伪造回复。仍未完成的是真实外部系统 API 客户端对接（例如具体渠道/服务端的幂等查询）。

当前增量（2026-09-11 00:52:53）：工具契约新增可选 `reconcileEffect`，能权威查询自身副作用的工具可在恢复时返回 `succeeded/failed/unknown`，只观察不复做。Runner 恢复默认按 `effect.toolName` 查注册表内工具的 reconciler，宿主回调优先，未注册或抛错保持保守 `unknown` 并记 bounded warn。新增 Runner 端到端夹具证明注册表 reconciler 生效且工具零重放。仍未完成的是真实外部服务（渠道/API）的幂等查询客户端实现。

当前增量（2026-09-11 01:09:15）：恢复 action 上报改为幂等。`recoverRun` 统一通过 `appendRecoveryEvent` 判定 append outcome，只有真正新落盘的事件才计为 action；并发或重复恢复遇到同一幂等事件时返回空 action，不会把同一结算重复计入，`conflict` 仍失败关闭。事件日志本身此前已由幂等键保证单条，本轮补齐的是可观测结果的一致性。新增并发两次恢复与后续幂等恢复的回归。

当前增量（2026-09-11 01:24:52）：关闭跨进程读到的 `.tmp` 竞争缺陷。原子写期间的临时文件现在被读取路径识别并跳过，只有完整 `.json` 才是权威事件；未知文件名仍 corrupt。新增「最终 cursor 已提交且 mtime>1h」的有界孤儿临时文件清理，避免误删并发活写入。新增真实双子进程并发追加夹具（各 25 条，cursor 1..50 连续、无重复 eventId），补齐 H-OLD-01「崩溃/并发后 cursor replay 与 live 结果一致」的底层证据。

当前增量（2026-09-11 01:33:06）：把该竞争根因收敛到一处。`writeJsonAtomically` 现在由写方在 finally 清理自己的临时文件，并导出共享 `isAtomicWriteTempFile`；event/inbox/run-lease 三个 store 的读取路径统一跳过 in-flight 临时文件，未知文件名仍 corrupt。新增 inbox、run-lease 的忽略与失败关闭回归；event store 的一次性孤儿清理特殊分支已删除。harness+runner 107 个文件、864 项通过。

当前增量（2026-09-11 01:54:52）：CACHE-09 新增 compareHarnessPaths 确定性路径对比报告器，把 shadow/next/legacy/cutover 的 CacheQualityReport 归一成请求数、token、命中率、P50/P95/max 延迟、成功率与 VERIFY passRate 并计算 delta；缺证据的指标保持 undefined 并进入 incomplete。同时从 @littlesheep/harness 正式导出 buildCacheQualityReport 及报告类型。新增 harness 单测与 Runner 端到端双路径夹具，证明同一输入在 shadow/next 下可生成可对比的 CACHE-09 报告且 release gate 仍为 blocked。harness+runner 108 个文件、867 项通过。

当前增量（2026-09-11 02:09:28）：补齐 projection rebuild / cursor replay 的直接证据。kernel 侧用完整事件序列验证 rebuildProjection 两次结果与 live 相等、replayAfter(midCursor) 恰为日志尾部；文件侧用全新 kernel+store 实例从磁盘重建，reduce 与 rebuild 与 live 三者逐字段相等、cursor 1..7 连续。harness+runner 108 个文件、869 项通过。

当前增量（2026-09-11 02:24:13）：补齐 App 恢复失败隔离证据：一个 run 的事件日志损坏时其它 run 仍按稳定顺序恢复、启动不中断；discovery 本身失败时记录诊断并继续启动。全量门复跑 passed，全仓 429 个文件、2,955 项通过。

当前增量（2026-09-11 02:38:22）：durable Harness 灰度再细化到行为 profile。新增 durableHarnessProfileOverrides（general/coding → shadow/next），优先级 session > origin > profile > 全局；profile 在单 run 内稳定，不切割 stable prefix，符合 CACHE-04。已接入 config、Runner、App/CLI 传参与 Local App API 校验，并有四级优先级、真实 run 与 API 夹具。全量门复跑 passed，全仓 429 个文件、2,957 项通过。

当前增量（2026-09-11 02:50:11）：补齐恢复中途崩溃的幂等证据：故障注入让恢复写第一条事实后死亡，下一次进程从同一目录继续只补写剩余事实，不重复已落盘事实；每类结算事件恰好一条，第三次恢复为空 action。全量门复跑 passed，全仓 429 个文件、2,958 项通过。

当前增量（2026-09-11 03:12:00）：实测确认「真实工具对账」在当前持久面上不可实现——结算失败而中止的 run，会话 transcript 不含 assistant tool-call，execution log 只留 inputSummary。因此在「不新增 durable 字段」与「不改变失败 run 是否写 tool-call 消息」两个约束下，reconcileEffect 拿不到权威入参。本轮试探性改动（toolInput 上下文、write 内容核对、transcript 反查）已全部撤回，write.ts/write.test.ts 恢复到 HEAD 字节级一致，全树无 EOL 噪声。该缺口转为待用户决策：A 在 effect intent 持久化工具申报的有界脱敏对账 key；B 工具执行前写入 tool-call 消息。全量门复跑 passed，全仓 429 个文件、2,958 项通过。

当前增量（2026-09-11 03:28:00）：新增 user-facing-reply 契约测试 7 项，锁定「可见回复只能来自真实 LLM 调用」：注册表失败/空文案/缺 provenance/重复超限/重生成失败全部 fail closed 且不写 reply，Runtime 不产出模板文案。全量门复跑 passed，全仓 430 个文件、2,965 项通过。

当前增量（2026-09-11 03:39:00）：为 durable-verification-codec（14 项）、durable-kernel-guards（7 项）、final-reply-identity（3 项）补边界单测，锁定「校验必失败关闭」「终态与 audit closure 的精确边界」「回复身份稳定」三条契约。全量门复跑 passed，全仓 433 个文件、2,988 项通过。

当前增量（2026-09-11 03:42:00）：补跑 verify:core（3 executed / 3 skipped，13,308 ms，145 项），并核验 releaseGate 无条件附加 real_provider_reconciliation_not_verified，本地夹具无法把缓存专项刷成 ready。两条质量门现在都有当前树证据。

完成门：每个用户可见回合只有一个 authoritative final settlement；Renderer/CLI/Webhook 重连只 replay 同一结果；effect 未知时停下请求决定，不能伪造成功或自动重做。

### 阶段 6：选定底座适配与双路径

状态：进行中（阶段 1 未采用第三方 runtime，当前对比自有 legacy/shadow 与 next kernel）。

工作项：在阶段 1 选定的 runtime 上实现 `Agent + AgentSession` 或等价 adapter；把 session、stream、tool loop、cancel、usage、event cursor 映射到 LS kernel；旧 Harness 与新 Harness 使用同一 Tool Execution Service、Memory facade 和权限边界。本轮新增确定性 shadow/next 对比夹具：同一输入两条路径都只产生一条回复和一次 final settlement；next 额外记录 `stage_transition_recorded`；request kind 和请求数一致；两路径 stable prefix 指纹不同，证明 cutover 不能共享 Provider 前缀缓存，成本必须按路径分别度量。本轮补充 shadow/next 工具/副作用对比：同一写入任务两条路径各执行一次工具、各产生一条回复和一个 succeeded side effect；next 有 stage transitions，shadow 无。该夹具同时发现并修复 VERIFY 通过时 `failedStepIds: undefined` 被 durable event JSON 校验拒绝、导致 next run 失败的缺陷。双路径对比再加入 Context safety estimate 成本门：next 估算 prompt tokens 不得超过 shadow 的 1.5 倍。代表性真实任务和完整成本对比仍未完成。

完成门：确定性夹具和代表性真实任务在 `legacy`、`next`、`shadow` 三种模式下得到可解释的 event、tool、settlement、cache 和成本差异；shadow 不产生第二份外部副作用或用户回复。

### 阶段 7：迁移、回滚与逐步切换

状态：进行中，优先级 P0。

工作项：实现旧 checkpoint/session 到新 event/projection 的只读兼容读取；按 session 或 request kind 小范围启用；保留旧路径 kill switch、数据备份、回滚演练和运行中租约处理。本轮把 `durableHarnessMode` 从内部 `createRunner` 选项提升为 `agents.defaults.durableHarnessMode` 配置（默认 `shadow`），并在 Local App API `/runtime` 暴露可校验的 `shadow`/`next` 切换；app 与 CLI 创建 Runner 时使用该配置，非法值返回 400。本轮进一步补齐 `durableHarnessSessionOverrides`：Runner 解析每次 run 的有效模式，并把 `durableHarnessMode` 写入 `RunnerResult`；App/CLI 的 publication、session replay 和 execution-log replay 都使用有效模式，未列出的 session 继续使用全局 shadow/next。本轮把 session 覆盖接到 Local App API：`GET/POST /runtime` 可读取和更新 `durableHarnessSessionOverrides`，校验非空 session id、shadow/next 值和 256 条上限。本轮新增 next → shadow → next 回滚演练：同一 session 三回合分别使用 next/shadow/next，验证回复顺序无重复、第一回合 settlement 与 run_completed 仍完整、第三回合重新走 authoritative settlement。本轮修正渠道发布遗漏：`DefaultChannelManager` 也使用 `result.durableHarnessMode ?? runner.durableHarnessMode`，全局 shadow 下的 per-run next 渠道会发布 authoritative settlement。本轮修正 Runner 内部完成请求重放的遗漏：`prepareInternalAuthoritativeResult` 也按 `result.durableHarnessMode` 或 session override 解析有效模式。本轮新增 origin 级灰度：`durableHarnessOriginOverrides` 可按 `app`/`cli`/`channel` 等请求来源启用 next，优先级为 session override > origin override > 全局模式；同一能力已接入 Local App API `GET/POST /runtime`。本轮新增 next 模式完成请求重启重放夹具：同 requestKey 重启后返回同一 run/reply，模型零调用，`finalReplySettlement` 保持 settled，用户输入只持久化一次；本轮补充 next 模式并发同 turn 重试夹具，两个并发请求只形成一个 run、一次用户输入和一条回复；本轮补充 origin override 的真实 run 夹具，app 来源走 next 并产生 settled final reply，cli 来源继续 shadow，全局默认不变。durable inbox 已完成 owner fencing、启动发现和旧 claim 到期后的自动接管 wake-up；长运行 run/effect 的续租与进程级 lease 接管仍未完成。按更细的 request kind 切换也仍未完成。

当前增量（2026-09-10 19:43:41）：上方早先登记的 run/effect lease 缺口现已缩小为 effect lease；run owner 已具备持久 acquire/reclaim/renew/release、进程杀死接管和 App 到期唤醒证据。按 request kind 的更细切换仍未完成。

当前增量（2026-09-10 20:21:40）：run/effect 两级 lease 均已具备持久 acquire/reclaim/renew/release 与真实进程杀死接管证据；effect settlement 还会在提交前重新确认原 fencing token。更细的 request-kind 切换、外部 effect 状态查询式恢复和真实渠道重连仍未完成。

当前增量（2026-09-11 10:10:00）：本轮收口 DeepSeek 官方 V4.1 Flash 更名：`deepseek-flash` 成为规范模型名，`deepseek-v4-flash`/`deepseek-v4-pro` 仍可解析为兼容名，但不再复用 V4 精确 tokenizer —— V4.1 改变了 DSML 标签、reasoning effort 渲染和中途 system 消息，能力来源分别指向官方更新日志与 V4.1 encoding 仓库，未校准前一律按 `unavailable` 处理。同时新增用户自定义模型供应商能力（发布前置：真实 Provider 对账长期缺凭证，用户需要能自行接入任意 OpenAI 兼容服务）：`ModelProviderSchema` 新增 `api`/`headers` 与带元数据的模型条目；用户声明的上下文窗口、输出上限和推理档位只在 LS 没有内置事实时生效，未声明即保持未知，用户声明模型的 tokenizer 明确为 `unavailable`；设置页“模型供应商”具备添加/编辑/删除与模型编辑，明文密钥经 Main 写入系统密钥库，配置文件只保留 `$<ID>_API_KEY` 引用。为守住 600 行边界，模型供应商路由下沉到 `provider-routes.ts`、运行时投影下沉到 `runtime-payload.ts`、启动文件模板下沉到 `bootstrap-templates.ts`，并为 `config/src/model-capabilities.ts` 补职责头注释。证据：`check:repo` 33/33、workspace typecheck、`configured-models`（6 项）、`model-provider-api`（6 项）、`model-provider-draft`（6 项）等新增夹具。真实 Provider usage 对账、成本/回答质量对比、真实外部服务对账和最终发布决定仍未完成。

当前增量（2026-09-11 10:28:00）：V4.1 更名的收尾回归暴露出两处仍按 V4 语义断言的旧夹具：`packages/harness/src/cache-provider-usage-reconciliation.test.ts` 与 `packages/harness/src/model-observability.test.ts` 仍用 `deepseek-v4-flash` 断言 local calibration `exact_match`，已改为唯一仍持有 V4 精确计数器的 `deepseek-v4-pro`，并补上“`auto` 永不发送 Provider reasoning effort”的用户声明模型用例；Renderer 样式守卫（默认光标、语义圆角 token）在新增设置页样式后同步收敛。全量发布门重跑 `pnpm.cmd run verify:full`：5 executed / 1 skipped，321,539 ms；`check:repo` 33/33、全仓 437 个文件 3,012 项通过 / 1 项 skipped、workspace typecheck、App build 和 recovery 源检查通过（recovery 仍保留 3 条历史 warning）。真实 Provider usage 对账、成本/回答质量对比、真实外部服务对账和最终发布决定仍未完成。

当前增量（2026-09-11 11:20:00）：本轮先用真实 Electron 渲染定位并修掉“模型供应商”设置页的显示缺陷：编辑面板原本按浮层叠加在卡片列表上，但设置壳已经约定面板内的 `.dialog` 是平面容器（`width: min(1040px,100%)`、`background: transparent`），因此编辑内容和卡片列表互相透视、错位。现改为设置页自己的“一页一面板”：列表 ⇄ 编辑面板互换，`取消/×` 返回列表；同时补上模型行的列标题。新增真实渲染回归 `pnpm run verify:model-provider-ui`（隔离数据根启动真实 Electron，断言列表态无编辑面板、卡片不重叠、无横向溢出，编辑态只剩面板且宽度正常，并输出两个状态截图）。该回归同时暴露一个既有行为（非本次改动引入）：设置壳的淡入由 rAF 链驱动（`presence-entering` → `presence-open`，`opacity` 0→1），在自动化环境里可以长时间停在中间态，此时设置面半透明、下层界面会透出来，在这个窗口里截图或观察都会看到“重影”；回归脚本因此改为等待 `presence-open` 且 `opacity ≈ 1` 之后再测量与截图。本轮未修改该全局动画契约，仅列为待决 UX 项。

真实 Provider 对账（首次拿到可用凭证）：`deepseek-flash`（V4.1 Flash，规范名，实测返回 `model=deepseek-flash`）普通请求 `usage` 已确认字段 `prompt_tokens`、`completion_tokens`、`total_tokens`、`prompt_tokens_details.cached_tokens`、`completion_tokens_details.reasoning_tokens`、`prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`；默认 thinking 打开时 `max_tokens=16` 会被 `reasoning_tokens` 全部吃掉（`finish_reason=length`、`content` 为空），因此 LS 的 `auto` 路径发送 `thinking: disabled` 是必要的。用校准过的 V4 计数器对同一请求做本地计数：`deepseek-flash` + `thinking disabled` 本地 17 / Provider 18（delta -1）；`deepseek-flash` + `reasoning_effort high` 本地 17 / Provider 43（V4.1 的 reasoning effort 渲染会额外占用 prompt token）；对照组 `deepseek-v4-pro`（今天仍服务 V4 Pro）本地 17 / Provider 17（delta 0）。这组实测支持当前注册表决定：V4.1 名字一律 `unavailable`，只有 `deepseek-v4-pro` 保留精确 V4 计数器。真实 Provider 对账脚本本身仍缺 V4.1 夹具（`verify-deepseek-v4-tool-tokenizer` 的工具协议校准目前只认 `deepseek-v4-flash`，而该名字现已由 V4.1 服务，需要按 V4.1 重新校准或改为按架构选名）。

当前增量（2026-09-11 11:35:00）：按用户要求把“模型供应商”页从“罗列全部内置预设”改为“只显示已配置的供应商”：有密钥、本身不需要密钥（本地自建端点）或用户自建即算已配置；未配置的 OpenAI/DeepSeek/GLM 预设从列表移入“添加提供方”，与 OpenRouter/Moonshot/百炼/硅基流动等模板并列，选择后直接进入编辑面板。列表为空时给出空态引导，输入栏模型选择器在无可用模型时提示“设置 → 模型供应商”。真实渲染回归同步收紧并扩展到四个断言面：只渲染已配置卡片（夹具里 1 张）、未配置预设不得出现、列表态无编辑面板、编辑态只剩面板；夹具同时改用无需密钥的本地端点，避免环境里的供应商密钥污染“已配置”判定。证据：`pnpm run verify:model-provider-ui` 通过（含 `presence-open` 淡入等待与两份状态截图）、workspace typecheck、设置页与样式回归 27 项、`check:repo` 33/33。

当前增量（2026-09-11 13:55:00）：② 收尾完成——V4.1 精确计数已接线并通过真实 Provider 矩阵。`@littlesheep/context` 新增 `deepseek-v4.1` tokenizer 资产规格（`deepseek-ai/DeepSeek-V4.1-Flash` @ `dba1be0a…`，`tokenizer.json` 6,367,257 字节 / `c90dfa01…476b`）与按家族参数化的计数器（V4 家族 = `deepseek-v4-pro` + V4 framing；V4.1 家族 = `deepseek-flash`/`deepseek-v4-flash` + V4.1 framing），`@littlesheep/config` 新增 `DEEPSEEK_V41_TOKEN_COUNTER_ID` 并把两个 V4.1 名字从 `unavailable` 翻为 `exact`。过程中修掉三处只有实测才能发现的 framing 细节：V4.1 的 reasoning budget 按别名的真实数值渲染（`high`=75，不再沿用 V4 Flash 的"总是 max"规则）、无 system 消息时 numeric budget 仍包在 `<｜System｜>` 帧内、以及"保留工具历史但去掉工具 schema"的形状实测差 1 token —— 最后这一项选择**显式不覆盖**而不是给出近似值。真实矩阵（`pnpm run verify:deepseek-v4-tool-tokenizer -- --model=deepseek-flash`）：**12/12 覆盖形状 delta=0**，3 个 history-only 形状报 `not_covered`，整体 `ok: true`；tokenizer 资产已按 sha256 校验落到数据根 `models/tokenizer/deepseek-v4.1/<revision>/`。受影响的注册表/用量/计数器测试同步从 `unavailable` 改为 `exact` 断言。当前增量（2026-09-11 13:10:00）：② 取得决定性结果。锁定 V4.1 tokenizer 资产：`deepseek-ai/DeepSeek-V4.1-Flash` @ `dba1be0a40aa45a94ad051997016db3960a90277`，`tokenizer.json` 6,367,257 字节 / sha256 `c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b`，`tokenizer_config.json` 801 字节 / sha256 `6ac8c8dc065ed118161d02dd532749ae3f52c243deac27872134fae2f50d8547`（与 V4 同哈希，说明只换了主词表）。用 V4.1 词表 + V4.1 framing 重跑矩阵：**plain 18/18、plain-high 43/43、plain-max 43/43、single-tool 295/295、multi-tool 349/349，五个形状全部 0 误差**。对照组固定了结论：V4 框架+V4 词表 −1/+9/+9，V4.1 框架+V4 词表 +4/+3/+3，V4 框架+V4.1 词表 −1/+9/+9 —— framing 与词表两半缺一不可，且 `<｜System｜>` 在 V4 词表下被拆成 5 个 token（V4.1 词表下 1 个）。**本轮只做到"校准通过"**：framing 已进编码器并有测试，V4.1 资产已固定；把 V4.1 counter 接进 `@littlesheep/context`、翻转 `@littlesheep/config` 的能力注册表（`deepseek-flash`/`deepseek-v4-flash` → exact，`deepseek-v4-pro` 在 2026-09-14 路由切换后再定）、并把 `verify-deepseek-v4-tool-tokenizer` 扩到 V4.1 是下一步；在此之前产品仍按 `unavailable` 处理，状态保持一致。当前增量（2026-09-11 12:40:00）：② DeepSeek V4.1 工具协议校准完成第一轮。按官方 `encoding/README.md` 实现 V4.1 framing：DSML 标签名带前导空格（`<｜DSML｜ calls>` / ` invoke` / ` parameter`）、numeric reasoning budget（`Reasoning Effort: 75 (range 1-100, …)`，low=50/high=75/max=100，仅 thinking 且 index 0）、`<｜System｜>` 与对话中途 system 消息（按官方语义等同 user 追加 assistant header）；framing 通过显式 `framing: 'v4' | 'v4.1'` 选项切换，默认仍是 `v4`，V4 官方向量测试不变；新增 5 个 V4.1 用例固定上述规则。实测（pinned V4 tokenizer + 真实 Provider）：plain V4 17 / V4.1 22 / Provider 18；single-tool V4 304 / V4.1 298 / Provider 295；multi-tool V4 358 / V4.1 352 / Provider 349。**结论：framing 只把工具协议差额从 +9 缩到 +3，无法单独恢复精确计数** —— `<｜System｜>` 在 V4 tokenizer 下被拆成多 token，V4.1 必须有自己的 tokenizer 资产。另外确认 `assertCalibratedRequestShape` 本来就拒绝 `deepseek-v4-pro` 的工具协议计数，因此 V4.1 迁移后**没有任何在用模型**保留已校准的工具协议计数器，注册表继续对 V4.1 名字报 `unavailable` 是正确的，不能回退成"旧证据仍有效"。下一步：固定 V4.1 tokenizer revision + sha256 并重新跑本矩阵。当前增量（2026-09-11 12:10:00）：**首次真实双路径成本/质量对比已完成**。新增 `scripts/verify-harness-path-comparison.mjs`（`pnpm run verify:harness-paths`）：用隔离数据根各启动一次真实 Electron 应用，分别在 `shadow` 与 `next` 下顺序跑同一组 6 个固定任务（同一 session、`deepseek/deepseek-flash`、`reasoning: auto`），再从生产路由 `GET /runtime/cache-quality` 取报告并交给 `compareHarnessPaths`。实测（授权 scope `permission=research`）：shadow 14 次请求 / prompt 24,884 / cached 9,600 / 命中率 38.6% / P95 1,425ms；next 16 次请求 / prompt 33,390 / cached 16,384 / 命中率 49.1% / P95 1,397ms；两侧 received 率 1.0、失败率 0、VERIFY passRate 1.0，release gate 仍为 `blocked`（无条件附加真实 Provider 对账原因）。结论按样本如实记录：next 在这组任务上多 2 次请求、每请求 prompt 从 1,777 升到 2,087，但 Provider 缓存命中率 +10.5pp、延迟略低；`reasoningTokens` 一侧缺失记为 `incomplete` 而非 0。样本仍小（6 任务、每路径 1 session、1 次运行），要作为发布依据需扩大任务集并重复运行。当前增量（2026-09-11 11:50:00）：按用户决定落三项：(1) **effect 对账采用方案 A 并已实现** —— `AgentTool` 新增 `reconciliationKey` 投影，`packages/types` 提供有界校验（标量/标量数组/单层标量对象，串长 ≤200、字段 ≤16、序列化 ≤512 字节、拒绝循环与自定义原型），harness 侧在效果外壳里计算并把键写进 `effect_intent_created`，投影读取对不合规键直接拒绝，Runner 把键透传进 `EffectReconcileContext`，`write` 工具接线为“路径 + 内容 sha256”（对账只读：内容匹配=succeeded，目标缺失=failed，内容被他人改写=unknown，无键/相对路径=unknown），未声明键的工具保持保守 `unknown`；新增测试覆盖有界规则、外壳持久化、投影读取、重启后 Runner 端到端透传和 `write` 的四种对账结论。B 方案（执行前写 tool-call 消息）按决策放弃，因为它会改变模型可见历史与缓存前缀。(2) **渠道插件移出核心发布门**：webhook/telegram/feishu/qqbot 归类为可选拓展，只有真实接入某渠道时才验收该渠道，阶段 8 的扫描项已改为 Electron 与依赖/产物。(3) **暂不发布**：阶段 8 保持进行中，先把真实成本/质量对比做完再决定；发布就绪记录已同步更新。

完成门：新路径失败可在不丢输入、工具证据、权限结果或用户数据的情况下切回旧路径；切换/回退不会重复 effect、重复 Agent 文案或污染 cache ledger；跨重启和中断恢复仍可回查。

当前增量（2026-09-11 16:46:00）：按上一轮对“新 Harness + 前后端对账”的审查结论修掉五项状态一致性缺口，代码与测试同批落地，仍未发布、默认 shadow。
(1) 历史归属：执行日志的 settled reply 原会覆盖同一 run 的所有关联消息，用户原话和中间工具消息都会显示成答案；现在只有 `finalize` 阶段或带 settlement 的最终 assistant 消息接受权威回复，其余保持原文，并有回归锁定。
(2) 统一结算投影：历史接口与诊断回放都改为经 `prepareAuthoritativeExecutionLog`；run 实际模式写入 `run_accepted` payload 与执行日志，`durable-run-mode.ts` 优先读取，缺失字段但存在 durable 事实的旧 run 保守按 next 复核——按 origin/profile 启用过、之后回滚 shadow 的历史记录不会再被按当前配置解释。崩溃后只剩用户输入、没有执行日志或 assistant 消息的 run 也会生成 Runtime 状态行。
(3) 恢复对账权限：`EffectReconcileContext.authorizeRead` 由 Runner 的 `authorizeDurableEffectRead` 接到 Main，重新计算容器边界与权限模式；`write` 未授权时不再读取对账路径，拒绝或缺失一律保留 `unknown`；写目标缺失由 `failed` 改为 `unknown`（文件可能被他人删除，不能据此判定 effect 未执行）；启动恢复没有交互批准通道，需要批准的模式保持 unknown。
(4) 步骤/工具状态校正：`run-result-reducer` 按 `stepId`/`callId` 用最终证据覆盖流式状态、清零 `activeTools` 并结束未闭合工具；工具记录改吃 `ToolInvocationRecord`（此前前端把 `toolName/status/outputSummary` 误声明成 `name/ok/output`）。修正过程中发现 `outputSummary` 只是 `output present (N characters)` 摘要，因此显示文本仍取实时流或执行日志的真实输出，durable 记录只覆盖状态、结束时间和错误。
(5) 待用户决定与暂停分离：新增 `waiting_user` 活动状态贯穿共享契约、实时归并、历史回放与任务进度标签，保留 Runtime 原因与 `runCheckpointId`；实时与历史对同一 run 显示一致，不再显示成普通暂停或加载后变失败。
验证：受影响的 12 个测试文件 103 项通过，workspace typecheck 与 check:repo 33/33 通过。runner.ts 同步下沉 effect 对账查询与 run 模式读取到 `durable-effect-query.ts` / `durable-run-mode.ts`，受控上限由 2620 收到 2610。

### 阶段 8：性能、质量与发布决定

状态：进行中，优先级 P0。

工作项：完成 CACHE-09、CACHE-10；运行 `check:repo`、受影响包测试、`verify:core`、`verify:full`、crash/replay、Electron 和依赖/产物扫描（渠道插件 webhook/telegram/feishu/qqbot 属于可选拓展，不属于本阶段核心发布门；只有真实接入某个渠道时才验收该渠道）；形成旧/新成本、延迟、请求数、回答质量、连续性、资源和回滚报告。当前已完成 `buildCacheQualityReport` 基础：三套 ledger 分栏、Provider hit ratio 只在完整 usage 下计算、invalidation reason 分布、延迟摘要和保守 release gate，并已通过 `CacheObservationStore.report()` 接入 scope-authorized 存储查询、`since`/`until` 时间窗和 Local App API `GET /runtime/cache-quality`；已把 CACHE-09 的 latency/outcome 从可选字段接到真实 session durable model request 投影：Runner `Infrastructure.loadSessionModelRequests` 按 session 读取最近 64 个 run 的 durable projection，`CacheObservationStore.report()` 只对授权 observation 的 requestId 求延迟、取消和失败摘要，Local App API 显式透传。Provider prompt/completion/reasoning/total/cached token 总量和 received/pending/aborted/failure 计数与比率已进入报告；任一请求缺 usage 时只标 `provider_token_totals_incomplete`，不补零。durable `verification_recorded` 已纳入 `DurableRunProjection`，只保留 attempt、verdict、source、reason hash/length 和 failed step ids；cache-quality 报告新增 pass/needs_replan/fail 计数与 passRate，缺失时标 `quality_continuity_not_observed`，存在 fail 时标 `verification_failures_present`。此前新增真实 Runner 两轮请求到 cache-quality 报告的端到端夹具，覆盖 Provider hit ratio、token 总量和 outcome rate；该夹具发现并修复 Provider usage 缺 `cachedPromptTokens`/`reasoningTokens` 时 next 路径把 `undefined` 写入 durable event、导致 `finalize_model_lifecycle_failed` 的真实缺陷；并补充 next 模式 Provider usage 完全缺失的回归，确认所有模型请求仍以 received/unavailable 结算且 run 完成。本轮完成当前工作树的全量发布门 `pnpm.cmd run verify:full`：`check:repo` 33/33、全仓 434 个文件 2,993 项通过/1 项 skipped、workspace typecheck、App build 和 recovery 源检查均通过；gate 为 5 executed / 1 skipped，耗时 383,189 ms。recovery 保留历史 warning：已迁移前的 runtime workspace 路径缺失、3 个抽样 runId 缺执行日志、layout 使用非默认 roots；这些 warning 未改写为无告警。真实 Provider 对账、成本/回答质量对比、真实外部服务对账客户端和最终发布决定仍未完成。

完成门：没有 P0 安全、数据丢失、重复副作用、重复最终回复、缓存跨域泄露或未解释的 Provider usage 差异；只有达到发布门才把新 Harness 设为默认，否则继续双路径或回退。 当前发布就绪、双路径对比和阻断条的汇总见 [Harness 发布就绪与双路径对比记录 2026-09-11](../reference/harness-rollout-readiness-2026-09-11.md)。

## 10. 迁移与回滚契约

- 旧 Harness 在阶段 7 完成前保持可运行、可测试、可回滚；新代码不得直接删除旧 stage、checkpoint、session 或 execution log 读取器。
- 新 event store 与旧 store 的写入必须有明确 owner；同一事实不能由两个路径各写一份可竞争的权威记录。
- 回滚优先停止新路径领取新 run，再等待或安全中止当前 non-effect 边界；有 intent 无 settlement 的 run 必须进入 `unknown`/人工决定，不允许用旧路径盲重做。
- 回滚后 UI、渠道和 API 仍显示真实状态来源；不能因为切回旧 Harness 就把新路径的失败写成成功。
- 数据迁移采用隔离副本、校验 hash、原子提交和可恢复 staging；失败继续使用旧数据根，保留冻结 tag 和用户无关未跟踪文件。

## 11. 测试与证据要求

每个阶段都要同时提供代码、测试、运行输出和失败边界；“代码存在”不等于阶段完成。

- 单元/契约：event schema、idempotency、projection、fingerprint、canonical serialization、invalidation reason、usage 校验和 settlement reducer。
- 集成：真实 Tool Execution Service、Memory facade、Runner checkpoint、Local App API、Renderer、CLI、Webhook 和 session recovery。
- 故障注入：进程退出、磁盘写入失败、inbox 重复、stream 断开、Provider timeout/rate-limit、工具未知副作用、响应丢失、projection rebuild 和并发切换。
- 真实 Provider：只在用户提供隔离凭证且网络/配额条件满足时执行；输出仅保存脱敏计数、hash、状态和 request identity，不保存 prompt/正文/密钥。
- 质量门：按影响范围运行 `pnpm.cmd run check:repo`、受影响 package typecheck/test、`pnpm.cmd run verify:core` 或 `pnpm.cmd run verify:full`；桌面和渠道改动还要做真实 Electron/loopback 验收。
- 报告：明确 `passed / failed / blocked / skipped / unavailable`，区分 fake provider、历史证据、当前工作树和真实 live 证据，不能把 partial/truncated/unknown 表达成完成。

## 12. 当前执行顺序

1. 保留冻结 tag，完成候选开源底座和供应链评估，不先添加依赖。
2. 先把 CACHE-01 至 CACHE-07 的脱敏观测接到旧 Harness，取得真实可比较的 prefix、usage 和失效原因基线。
3. 根据 CACHE-03/04/05/07 的证据，选择修改 Context Engine、Prompt assembler、Provider adapter、stage/request 数量或保持现状；每个选择都写入结果和回滚点。
4. 构建 event/inbox/replay kernel、effect lifecycle 和 authoritative settlement，并通过 crash/replay 和重复发布门。
5. 接入选定开源 runtime，先 shadow，再按 request kind/session 小范围切换；任何质量或安全回退立即使用旧路径。
6. 完成 CACHE-08 至 CACHE-10、跨重启/并发/streaming/重试/模型切换矩阵和成本质量报告后，才决定是否让新 Harness 成为默认。

## 13. 任务书维护规则

- 每个阶段只在对应完成门和证据存在时改为“已完成”；局部代码或单元测试不能升级整个阶段。
- 任务书不复制易过期的全仓测试总数；最新数字只写入项目状态和当次验证产物。
- 发现新缺口时优先补充编号、影响、复现、回滚和完成门，不用一段叙述掩盖未决风险。
- 任何涉及用户数据、外部副作用、Provider 配额、许可证或发布包的动作，都要在执行前写清范围和保留期限，并在执行后保留可回查证据。
