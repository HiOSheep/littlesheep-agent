# LittleSheep 项目状态

最后更新：2026-09-24 22:07:26

本文件是项目进度的正式来源，只记录**当前事实与可复现证据**。分轮开发记录、提交轨迹和一次性验收过程不保留在此处；需要追溯实现过程时使用 git 历史与对应任务书。

- 缓存实测规程、禁止做法与逐请求归因见 [缓存 95% 验收规程](../reference/cache-95-acceptance.md)；结构基线与前后对比见 [缓存请求形状基线](../reference/cache-baseline/README.md)。
- 核心流程与状态契约见 [Core Flow 状态契约](../reference/core-flow-state-contract.md) 与 [核心 Agent 流程规范](../principles/core-agent-flow-guidelines.md)。

## 核心流程（当前）

```text
ENTER → 活动路由 → ┬─ execute（唯一主循环：常规会话、工具工作、续接） → VERIFY → FINALIZE
                   ├─ 能力/状态询问 ──→ REPLY（最小 Runtime 事实契约） → FINALIZE
                   └─ （RECOVER 升级） → ASK_USER → FINALIZE
```

- **活动路由只产出两条路径**：`execute` 与能力/状态 `reply`。常规会话与常规任务都进入同一个主循环，聊天轮与工具轮因此共享同一份 system 提示与工具集，前缀可跨轮复用。规则识别出的读法（问候、直接回答约束等）只保留在 `type`/`reasonCode` 中供审计，不再据此分成两套提示形状。复杂、超长、需要检索或处于续接状态的请求同样在循环内完成，只保留解释性 reason code。
- **DECIDE 已删除**：stage 注册表中没有 `decide`。它只作为历史 stage 名保留在 `StageName`、`allowedTransitions` 与旧检查点中；恢复时 `resolveCheckpointResumeStage` 把入口为 `decide` 的检查点改派到主循环 `execute`，不重新规划。`classify` 同样只作为历史标签与检查点兼容保留，不再调用分类模型。
- **EXECUTE 是唯一主循环**：模型在同一循环内选择"直接回答"或"请求工具"，Runtime 负责权限、校验、执行与结果追加；多步骤工作在循环内串行推进。
- **持久化 TaskBook 是只读历史**：步骤执行器与调度器已删除，持久化的 `task_book` 策略降级为 `bounded_loop` 并保留原 reason code；已存在的计划不再触发第二个执行器。
- **VERIFY 不调用验证模型**：只断言 Runtime 证据能证明的事实。窄结构形态（单只读步骤、写后读回）判定为 `pass`；其余已完成的 run 记录为 `unverified`——证据完整、调用成功、存在模型回复，但需要人工判断的验收标准未经验证。记录到的失败、缺失步骤或截断证据不能变成 `pass`。
- **"不可用证据"与"已记录的负结果"按 Runtime 知道什么分界**：权限结果（`approval_denied` / `approval_unavailable` / `hard_denied`）是"还没人决定是否授权"，只有用户能决定，因此升级到 `ASK_USER`；Runtime 自己在执行前发出的拒绝（`validation_failed` / `unknown_tool` / `repeated_call_blocked`）是确定性结果——调用根本没跑——连同 `failed` / `timed_out` / `aborted` 一起留在记录里，让已交付的 run 停在 `unverified`，不把交付过的工作变成一句提问。
- **RECOVER 由 Runtime 路由，不调用恢复模型**：可重试失败回到产生失败的阶段（受次数上限约束）；权限拒绝升级到 `ASK_USER`；副作用未结算或运行被中止时显式停止并只呈现 Runtime 状态；已完成步骤不重复执行。
- **两类重试是不可能的，命中即不空转**：run 上的模型调用预算耗尽直接升级，不再重试同一件事；VERIFY 对已记录证据给出的结构性缺口（`structural` fail）第一次回到主循环让模型闭合它，第二次直接升级——重试 VERIFY 只会得到同一结论，缺口只能被"同一步骤里更晚的成功调用"顶掉。
- **一次越权调用不再废掉整轮**：请求准入范围以外的工具调用（`tool_not_admitted`）照样被拒并记进转录，但它是 Runtime 自己刚做出的范围决定，属可纠正失败——被准入的工具在下一轮仍然可用。此前这类调用因为"没有 invocation 记录"被判成未知边界，触发强制收尾，连本该可用工具也被锁死，两步任务的产物根本没生成。
- **迭代上限属于 run 自己的账**：单轮工具循环上限为 30 次迭代，耗尽时写入转录的收尾指令明确说明"不会再有任何工具调用执行，再调一次会让整个 run 失败"；执行契约同时规定交付优先——在本次 run 的额度内交付、反复重测同一个产物不算验证。
- **提问轮里的兄弟调用不执行**：模型在同一批里既提问又调用其它工具时，与提问同批的调用以带原因的拒绝结果记入转录，提问本身照常发布；不会因为同批带了别的调用就把整轮判失败。
- **CAPTURE 与自动记忆演化已删除**：运行结束不再自动沉淀，自动 merge/move/revise 编排与自动 Skill 创建一并移除。
- **ASK_USER 不是可路由活动**：它只由主循环内模型发起的 `request_user_input`，或 RECOVER 的权限拒绝/恢复预算耗尽升级到达。

## 请求装配与上下文

- **system 消息就是缓存边界之上的 prompt 段**（`stableText`/`stableSegments`）。边界之下的段——bootstrap、runtime facts、检索意图契约、压缩后的会话摘要——各自作为独立消息追加，由 append-only 尾部账本（`packages/harness/src/run-tail-ledger.ts`）持有。
- **尾部账本的"变化"按同 id 上一次发出的值判定，不按"这个值以前是否发过"**：反复切换 A→B→A→B 时最后那次 B 与更早的 B 字节相同，用"见过就不再发"的集合去重会丢掉它，模型读到的仍是被切回 A 的那一版，而 Runtime 早已在 B 上运行。
- **每次请求附带一块 ≤6 行的运行时环境简报**（`packages/harness/src/runtime-context-notice.ts`）：provider/model、工作区、真实 shell、权限与网络开关、可用工具数，取自本次请求实际生效的状态。它是纯函数：与上一次已观察状态相同就完全不输出，`Changed:` 行只列出真正变化的字段；上一次状态从转录里最后一条 `runtime-context` 记录解析，所以重启、检查点续接和压缩后仍是同一份事实。模型/工作区/权限切换因此对模型可见，而不是靠它猜。
- **工具循环的第 N 次请求是第 N+1 次请求的字节前缀**：迭代只追加，不重排、不改写本次 run 已经发出的内容。
- **上下文淘汰按 `appended-only` 作用域运行**（`packages/harness/src/stages/execute/tool-loop.ts`）：主循环只能丢弃本次请求追加的内容，绝不丢弃本次 run 已经发出的消息；若已发送前缀本身就超出模型窗口，请求显式失败，而不是被静默重编号。
- **任务区间本身不可被预算淘汰**（候选 `pinned`，`packages/context/src/context-engine/eviction.ts` + `packages/harness/src/context-candidates.ts`）：契约仍可按 kind 过滤，但预算淘汰不得动已发出的历史——`execute_tool_loop` 的阶段软目标（`maxPromptTokens: 24k`）曾让每回合静默剪掉一点历史，使跨 run 的请求不再是上一条的扩展（实测长任务修复前后 80.03% → 99.13%）。
- **回放的地板是压缩游标**（`packages/harness/src/context.ts`）：模型看到的是压缩摘要之后**全部**转录（工具配对、Runtime 尾部与控制消息按发送位置），不是"最近 N 条"；预算已知时也不做字符截断（96k 兜底只用于预算未知，且必须大到不会成为截断者）。
- **工具目录在一个会话区间内固定**：Provider 看到的是注册表目录，不随本轮措辞裁剪。某轮不得使用的能力在执行边界被拒绝——`admittedTools` 是执行范围，不是可见性范围。
- Context Engine（`packages/context/`）是请求装配的唯一所有者：确定性候选、来源 segment、预算与淘汰、版本化摘要与 token 账本都在这里完成。
- 逐请求时钟、耗时与上一轮执行摘要不再注入；显式时间需求由 `session_status` 工具按需返回。

## 会话压缩与记忆写入

- **压缩在 run 结束后触发，且优先看真实上下文压力**：模型窗口已知（`contextSnapshot.budget.status === 'known'`）时只有 `compressionRecommended`（占用达到 `contextCompressionThresholdRatio`）会启动压缩，消息条数阈值退化为"窗口不可知"时的兜底；默认 `threshold 400` / `keepRecent 200` / `background false`（`packages/config/src/schema.ts`）。
- **后果（2026-09-22 实测）**：登记窗口达 1M tokens 而真实长会话提示词只有 20k–30k，压力线不会被触及——四次 28 回合会话（169–222 个请求）的压缩调用数为 **0**（`compressionRecommended` 从未成立；验收数据根里的 `threshold: 100` 是冻结值，仓库默认仍是 400/200）。这不是缺陷，而是"消除消息条数阈值"的直接结果，但它意味着**在窗口远大于会话的配置下不再有压缩**。
- **摘要安装与覆盖区间是一次原子提交**，带 predecessor / source-hash 前置条件（`packages/session/src/compaction.ts`、`packages/session/src/compaction-store.ts`）；前置条件不满足或写入失败时保留上一份有效摘要。
- **压缩路径是持久记忆的唯一写入方**：`runner-finalize` → `compactSessionAfterRun` → `memoryService.write`，经 `resolveMemoryWriteEpistemic` 判定认识状态。失败与重试的摘要尝试都计入 operation usage。
- **由此产生的边界**：既然压缩只在真实压力下触发，而大窗口配置下压力不会出现，**持久记忆也就不会被写入**。要恢复写入需要一条与缓存无关的写入路径或显式的记忆触发条件；把消息条数阈值塞回缓存路径会重新引入每次压缩的前缀重建（诊断运行实测 6 次压缩重付约 288k tokens），不是正确修法。
- **模型没有可调用的记忆写入工具**：`memory_tree` 只有 `root_index` / `branch_index` / `expand` / `deep_search` / `release` 五个只读动作（`packages/memory-tree/src/memory-tool.ts`）。
- 记忆检索严格沿根索引 → 分支索引 → 展开推进；只有同一分支索引仍不足时才允许该分支内 `deep_search`。默认不跨树搜索，也不把向量召回直接注入上下文。
- 每轮常驻的只有受限长度的根索引，不自动加载整份长期记忆或最近 daily 正文。

## 澄清与回复发布

- 模型通过 `request_user_input` 提出的问题**按原文发布**，并绑定产生它的那次 request id；不再为同一句话发起第二次措辞调用。
- Runtime 升级（权限拒绝、恢复预算耗尽）只措辞一次；该调用没有可见输出时回合显式失败，Runtime 自撰草稿不会伪装成 Agent 回复。
- 用户可见的 Agent 文案必须来自真实 LLM 调用并携带 Provider provenance。发布前在会话级回复注册表中占用该 settlement 身份（run 与规范化文案指纹）：同一 settlement 只能发布一次，不同回合允许完全相同的措辞——重复提问的正确答案就是同一句话，因此不改写文案、也不为此额外调用模型。
- 空文案、来源缺失或注册表不可用时不发布任何固定模板，只显示 Runtime 错误/状态。按钮、状态、进度、路径、权限和工具事实由 Runtime 稳定提供，模型不可改写。

## 权限与数据边界

- 权限模式固定三档：**完全访问 / 研究 / 受限**。模式只改变授权，不改变 Agent 行为 profile、任务判断或系统提示词。
- 活动完整应用数据根（默认 `.littlesheep`，可整体迁移）是产品语义上的容器边界；`workplace/` 只是其中的默认工作区，用户选定的外部项目属于容器外资源。
- 当前"容器"是 Main 进程执行的**路径分类与审批闸门**（`inside` / `outside` / `unknown`），不是已部署的 Docker/OS 进程沙箱；Shell 仍运行在宿主系统，范围无法静态证明的命令按保守判定处理，审批结果在实际执行前由 Main 重新计算。
- **LS 核心源码是宿主级只读边界**：内置 `write`、`edit`、`exec` 不得修改自动发现的核心源码根，完全访问与单次批准也不能绕过。
- 外部或未知工作区在研究和受限模式下先跳过自动资源/文档扫描，待具体访问获批后继续；完全访问在一次性风险确认后直接继续。

## 缓存命中率现状

真实 Provider（`deepseek/deepseek-flash`，2026-09-22，`H_ui = ΣcacheRead / Σ(uncachedInput+cacheRead+cacheWrite)`，按会话累计、含冷启动）：

| 场景 | 会话累计 H_ui | 验收节点（第 16/22/25/28 回合） | 产物验收 |
| --- | ---: | --- | --- |
| 真实长任务 L1 第 10 次 | **99.13%**（179 请求） | 97.00 / 98.30 / 98.81 / 98.94% | 6/6 |
| 真实长任务 L1 第 11 次 | **99.21%**（222 请求） | 96.66 / 98.43 / 98.66 / 98.79% | 6/6 |
| 同上，第 14 回合**重启应用进程** | **98.99%**（169 请求） | 96.81 / 97.67 / 98.19 / 98.42% | 6/6 |
| 同上，第 14 回合前**空闲 45 分钟** | **99.05%**（183 请求） | 97.34 / 97.91 / 98.44 / 98.80% | 6/6 |
| 冻结六任务（12 次运行） | 平均 **87.07%**（回归口径） | — | 12/12 |

- **判定入口**：`pnpm run check:cache-acceptance`（规则在 `scripts/lib/cache-acceptance.mjs`，8 个单元测试）。长任务口径为"第 16 回合起所有冻结节点 ≥95%、至少两次运行达标"，前段节点按红线口径豁免（冷启动只能靠会话长度摊薄）；冻结短负载只作功能回归。当前结论 **met**（长任务 2/2）。
- **冷启动构成**：约 **4.25k tokens** = system 提示约 2.4k + 工具 schema 约 1.9k。短会话（3 回合 / 7–12 个请求）的结构上限约 **87–89%**；每步真实新增输入合计 1.7k–3.7k tokens，工具结果平均 500–800 字符、重复率 0.7%–2.1%（约占会话输入 0.3%），因此继续裁剪提示词或工具输出都没有可测收益——比例只能靠会话长度摊薄。
- **缓存有效期**：45 分钟空闲后首个请求仍 99.7% 命中，结论是"**至少 45 分钟内有效**"，不承诺无限期；更长停顿与真正的失效边界未测。

- **现行红线对齐 DeepSeek Harness 前端会话累计值，在真实长任务验收节点判定**，95% 为不可低于的红线、95%～99.5% 为目标工作范围；允许能力收缩。初始冷启动可低于红线，首次输入仍计入累计；独立辅助调用进入完整成本账本另列，不与主会话指标混称。完整口径见[验收规程现行条款](../reference/cache-95-acceptance.md#真实长任务现行红线2026-09-22)。表中"冻结六任务"一行是**短负载回归口径**：它按设计不期待达到红线（3 回合形状的结构上限约 87–89%，只能靠会话长度摊薄），当前结论以表中前四行真实长任务为准。
- **旧冻结短负载（历史读数，保留作回归）**：下面三组是 2026-09-21 的实现版本上的读数，其 shadow/next 双驱动路径**已删除**（`readDurableHarnessMode` 只读历史标签），数字早于后续全部缓存修复，**不代表当前实现**，也不能用来代替上表的真实长任务结果：共享会话对话 78.182%、连续工具工作 84.523%、开启压缩 63.228%（均为 next 总体，0 失败、0 重试、usage 完整）。
- 旧读数的压缩场景被拉低，是因为压缩用途与主循环前缀互不通用（`execute_tool_loop` 67.8%、`session_compaction` 33.8%）；该结论促使压缩成本单列并触发压力口径的重做。这两组数字与被删除的 shadow/next 读数同批，原文只在 git 历史（`git log --follow -- docs/reference/cache-95-acceptance.md`）。
- 离线结构基线（不调用 Provider，只统计请求字符与共享前缀）：可复用前缀 3,574 字符、工具循环复用比 1.000、聊天/工具共享前缀 3,557、稳定头 3,444。见 [缓存请求形状基线](../reference/cache-baseline/README.md)。
- 不允许通过填充上下文、重复预热、隐瞒失败/辅助成本或迁出主会话调用、延长会话或只统计热缓存子集来抬高比例；完整规程见 [缓存 95% 验收规程](../reference/cache-95-acceptance.md)。

## 总体判断

LittleSheep 当前是一个**可运行的本地 Agent alpha 原型**：硬控制流 Harness（单一主循环）、索引优先记忆树、版本化会话摘要、统一 Tool Execution Service、桌面聊天与拓展工作区、可迁移数据根和可选外部渠道已经形成工程骨架。DeepSeek 的 chat、continuity、tool、abort 四项真实校准、真实两步 `write -> read` 副作用与重启恢复、跨重启回答级记忆连续性、多轮摘要续答、短时并行压力和长时间持续任务均已实测通过。

它还不是可直接宣称"生产就绪"的发行版。缓存红线在**真实长任务**上已按现行口径达成（第 16 回合起各验收节点 ≥95%，含重启与 45 分钟空闲两种中断；判定由 `pnpm run check:cache-acceptance` 执行），但仍未闭环的是：3 回合形状短负载的结构上限（87–89%，只能靠更长的会话摊薄）、压缩在"窗口远大于会话"配置下不触发带来的记忆写入缺口、Pro 工具协议与其他实际启用 Provider 的模型专用校准、非字段事实的普遍连续性、外部系统副作用验收、MCP、安装包发布、与成熟 Agent 产品可比较的任务效率基线和长期真实用户负载。未配置的 Provider 不视为产品故障，但也不能冒充已校准。

## 能力总览

| 能力域 | 状态 | 当前结论 | 主要位置 |
| --- | --- | --- | --- |
| 架构治理 | 仓库基元化阶段 0-7 已完成 | 所有 workspace package 与领域目录均有所有权 README；关键组合入口收敛为 facade；`check:repo` 校验文档、模块与 TypeScript references；`verify:changed` / `verify:core` / `verify:full` 提供三级验证 | `docs/reference/repository-guide.md`、`docs/reference/module-split-map.md`、`scripts/check-repository-hygiene.mjs` |
| 核心流程与状态机 | 已收敛为单一主循环 | 活动路由只产出 `execute` 与能力/状态 `reply`；DECIDE、验证模型调用、恢复模型调用与 CAPTURE 已删除；`classify` 仅作历史标签与检查点兼容；ASK_USER 由主循环或 RECOVER 升级到达 | `packages/harness/src/stages/classify.ts`、`stages/execute/tool-loop.ts`、`stages/verify.ts`、`stages/recover.ts`、`packages/types/src/stage-transitions.ts` |
| Context 与请求装配 | 主要数据链已实现；真实长任务红线 `met`、3 回合短负载有结构上限 | 边界之上为 system 消息、边界之下由 append-only 尾部账本追加；工具目录会话内固定；淘汰按 `appended-only` 作用域；tokenizer 能力矩阵与双账本已接通；会话累计命中率见"缓存命中率现状" | `packages/context/src/engine.ts`、`packages/harness/src/run-tail-ledger.ts`、`packages/harness/src/cache-prefix-split.ts`、`packages/types/src/token-ledger.ts` |
| 工具执行 | 工程基线已完成 | `ToolExecutionService` 是查找、schema 校验、权限/单次批准、超时、中断、调度、清洗、事件与调用记录的唯一宿主边界；内置、插件和 run-scoped 工具共享该服务 | `packages/tools/src/tool-execution-service.ts`、`packages/runner/src/run-tools.ts` |
| 权限与数据边界 | 已实现基础闭环 | 三档权限与行为 profile 正交；容器是 Main 的路径分类与审批闸门；核心源码宿主级只读 | `packages/safety/src/permission-boundary.ts`、`packages/app/src/main/run-policy.ts`、`packages/runner/src/core-source-protection.ts` |
| 记忆树与 Memory v3 | 正式 backend 已切换；长尾验收进行中 | 索引优先检索、稳定实体与有向关系、动态 activation、写入认识边界与压缩后任务锚点恢复均已落地；`memory_tree` 只读，写入只经压缩路径 | `packages/memory-tree/`、`packages/memory-tree/src/memory-tool.ts`、`packages/runner/src/session-continuity.ts` |
| 会话压缩 | 本地契约已完成 | 压力触发、默认 400/200/background false、摘要与覆盖区间原子提交且失败保留上一份、压缩为唯一记忆写入方 | `packages/session/src/compaction.ts`、`packages/session/src/compaction-store.ts`、`packages/config/src/schema.ts` |
| 执行记录与恢复 | 已实现 | 已完成 run 的步骤、权威 `ToolInvocationRecord`、验证、调用契约与 Context 快照可持久化并重放；活动 run 的续跑由版本化 `RunCheckpoint` 负责，两者不互相冒充 | `packages/runner/src/execution-log.ts`、`packages/runner/src/run-checkpoint-control.ts` |
| 运行时事件与后台控制 | 已实现基础闭环 | 有界事件队列与安全消费、`TaskBookPatch`、暂停/继续/中断、Runner 显式续跑、应用启动恢复、托盘与三档关闭策略已接通 | `packages/runner/src/active-run-registry.ts`、`packages/app/src/main/desktop-shell.ts` |
| 桌面应用与拓展工作区 | 已实现基础形态 | Local App API + SSE、Markdown、附件、审批、中断、文件树与编辑器、Git 审阅、受控终端、内置浏览器与产物索引 | `packages/app/src/main/`、`packages/app/src/renderer/` |
| 插件与渠道 | 已实现基础闭环 | 插件发现、manifest 校验、启停、错误隔离与 `channel`/`tool`/声明式 `skill` 贡献；外部渠道为可选适配器插件，未配置时不加载 | `packages/plugins/`、`packages/channels/`、`packages/skills/` |
| 开发环境管理 | 管理基础已实现，分发未完成 | 设置页可检测、偏好、导入和移除本地工具链；Electron 内置 Node 随应用提供，其他运行时经安全导入进入数据根 | `packages/app/src/main/development-environments.ts` |
| 发布与安装 | 未完成 | 目前只有源码构建流程；签名、升级、卸载、原生依赖分发与回滚未闭环 | `scripts/`、`package.json` |

## 当前验证结果

- 仓库卫生门 `node scripts/check-repository-hygiene.mjs`：通过（38 项通过，0 项失败，含模块拆分地图计数比对与受控超限复查到期）；缓存验收门 `pnpm run check:cache-acceptance`：通过（长任务达标 2/2，冻结 12 次运行通过回归口径）。
- 全量证据命令固定为 `pnpm.cmd test`、`pnpm.cmd run typecheck`、`pnpm.cmd run build`、`pnpm.cmd run verify:app-recovery`，按影响范围还有 `pnpm.cmd run verify:changed`、`verify:core`、`verify:full`。
- 会随每次运行变化的测试数量、耗时与 token 读数不写入本文件；它们以命令输出、[缓存 95% 验收规程](../reference/cache-95-acceptance.md) 与 [缓存请求形状基线](../reference/cache-baseline/README.md) 为准。
- 真实供应商冒烟、真实 Electron 场景、Memory v3 隔离门与缓存冻结负载是独立验收门：本地质量检查全绿不代表它们已完成。
- **对话执行交付门**（`pnpm run verify:conversation-execution-reliability`）在隔离数据根上启动真实 Electron 窗口、经 Local App API 发真实模型请求，覆盖正常交付与自然语言续接、独立重跑、工作区切换与历史目录边界、研究模式下批准与拒绝、受保护核心目录拒绝、审批拒绝后的重试、预算耗尽后重启再续接、未结算副作用的诚实终态等场景，并**把生成的游戏产物放进随包 Electron 引擎里真跑一遍**（`pnpm run probe:game-artifacts` 同源探针：启动、等帧、按键、重开、加载期与运行期异常），产物只有在"能跑"时才算通过。
- **交付门中的人工项已完成**：真实产物在真实窗口里人工试玩过 5 局（4 款贪吃蛇 + 1 款小羊快跑类），启动、输入、计分/核心规则、重新开始均正常。探针另检出 1 个模型产物自身的加载期异常（`snake-C.html`：`resize()` 早于 `reset()`，第一次 `draw()` 抛 `TypeError`）——人工游玩未看到可见症状，但它作为产物缺陷留在记录里，不是 Runtime 路径问题。
- **本文件涉及的两条修复的定向证据**：尾部账本按"上一次发出的值"判变化、配置保存事务区分"已保存/已生效"，各有在旧实现下失败的回归用例（`packages/harness/src/run-tail-ledger.test.ts`、`packages/app/src/main/runtime-config-change.test.ts`）。

## 能力明细

### Agent 核心

- 活动路由确定化，不消耗模型请求；未命中规则的输入直接进入主循环，由模型决定直接回答还是请求工具。
- 缺少关键路径、权限或不可逆操作确认时使用结构化 `ClarificationRequest`，不把不确定性伪装成普通错误。
- 复杂任务可以生成目标、步骤、工具、产物和验收标准组成的 TaskBook；简单任务保持轻量，已持久化的 TaskBook 只作为可读历史。
- EXECUTE、VERIFY 和 RECOVER 以步骤为边界保存证据，支持局部重规划和有限重试；循环、重试与重规划都受次数、时间和无进展上限约束。
- 每次模型调用使用独立契约；工具、输出预算和 Context 来源越权在请求发送前默认拒绝。
- 运行事件包含步骤、工具、验证和最终回复，UI 可实时展示，历史也能重建同一过程。

### 记忆与持续能力

- 根索引、分支索引、节点展开和同分支深搜构成默认检索路径；未命中索引时不默认跨树搜索，也不直接把向量召回塞进上下文。
- 分支与单次 run 受预算、去重、来源记录和安全封套约束；访问频率本身不提升可信度，错误、冲突和过期结果产生可审计负反馈。
- v3 已登记 user/project/file/session/task/skill/tool/rule/concept 等稳定实体与有向关系；名称、路径、共现和向量相似只用于候选导航。
- 项目记忆三层：完整权威数据留在可整体迁移的 LS 应用数据根；项目内私有投影需显式启用并经白名单过滤；共享导出使用更严格的 Markdown 白名单。
- 用户侧"记忆树"只展示数据根中的记忆文件目录，当前仅 `SOUL.md` 可由用户直接编辑；Atom、关系、向量与审计结构属 Runtime 内部数据。
- Skill 按 builtin、user、external、plugin owner/source 治理；合并、停用、归档或删除前必须验证语义、依赖、权限与回归。

### 桌面应用与数据版本

- Electron 主进程内嵌 Runner；Renderer 通过 loopback 随机端口的 Local App API 通信；长生命周期 SSE 使用 15 秒心跳与 512 KiB 单连接待写上限，普通观察连接断开不取消 Main 持有的 run。
- 聊天支持流式回复、Markdown、附件、工作区选择、权限审批与中断；过程按渐进式披露展开，失败、风险与权限拒绝始终可见。
- 活动任务控制面：有界活动快照、暂停/继续/中断、Runner 显式续跑、应用启动恢复/放弃/查看现场、托盘与三档关闭策略。
- LS 数据根与用户工作区使用不污染既有 `.git` 的独立 shadow Git；`RunCheckpoint` 有界保存 TaskBook、步骤、事件、权限与副作用状态。
- **每个 run 的工作区事实只有一个来源**：Runtime 在 run 入口解析一次规范工作区，提示、工具 `cwd`、权限分类与产物归属共用同一个值。独立会话按"请求指定 → 保存的默认目录 → `workplace`"解析，项目会话固定用它自己的（或项目的）目录，不会因为保存的默认目录变化被搬走；显式换目录走 `PATCH /sessions/:id { workspacePath }`。历史记忆里指向旧目录的路径只是历史来源，不覆盖当前目录，也不成为跨目录操作授权。
- **选中会话不等于全局默认工作区**（2026-09-24）：点开会话只改变**当前视图**的有效工作区与本次 run 的请求工作区（渲染器侧 `selectedSessionWorkspaceRef`），不落盘默认目录、也不重建 Runner；切回独立会话或新建会话恢复持久化的默认工作区。此前切换会话会 `updateRuntime({ workspace })`，同时改写全局默认目录并重建 Runner，还会让下一次发送落到上一个项目的目录里。
- **恢复期不等于整个 API 不可用**（2026-09-24）：Local App API 的请求入口不再等待 `RunRouter.create()`；元数据、Runtime、会话索引与工作区路由在旧任务恢复期间立即应答，Run/Checkpoint/审批在路由未就绪时明确 503。历史事件分区的兼容扫描移出启动关键路径、转后台执行，现代租约与收件箱中的待恢复任务仍在执行就绪前处理。细节见 `packages/app/src/main/local-app-api/README.md`。
- **保存配置与生效配置是两件事**：配置保存事务按 `normalize → persist → 重建 Runner` 串行执行，字段比较在持久化**之前**完成；持久化失败拒绝调用方并保留旧 Runner。一次 Runner 重建失败会被记成"已落盘但未生效"，**再次保存同一个版本仍会重建**，不会对着已保存的副本比较出"无变化"并返回一个没人使用的"保存成功"。
- 完整数据根迁移由外部 locator 登记并在启动阶段原子提交，失败继续使用旧目录；正式用户数据的迁移仍需用户明确确认后执行。

### 插件、渠道与网络检索

- `PluginHost` 在 Runner 之后独立启动；本地插件代码只有在用户显式信任后才在 Electron 主进程运行，该开关不是代码沙箱。
- 外部渠道（Webhook / Telegram / 飞书 / QQ Bot）是可选适配器插件，只负责消息进出；本地 UI 不依赖渠道服务启动。
- 网络检索只经 Runtime 选择的已配置 SearchProvider（当前 MVP 为 Tavily）发现与排序，以及匿名公共 HTTP(S) GET；模型不能指定 Provider endpoint、密钥或任意 header。
- 网页与搜索摘要永远标记为 `external_untrusted`：外部文本不能改变工具、权限、状态机或记忆写入策略；durable 记录只保存有界、脱敏的 citation projection。

### 工程治理

- 文档分工：长期约束见 [架构原则](../principles/architecture-principles.md)，当前事实见本文件，演进顺序与取舍见 [架构决策报告](architecture-decision-report.md)，目录与模块归属见 [repository-guide.md](../reference/repository-guide.md)，插件边界见 [plugin-development.md](../reference/plugin-development.md)。
- 新增核心协议必须有唯一权威来源；workspace 运行时依赖环、未公开深层 import 和未登记的大型文件会直接使质量检查失败。
- 不把 API key、会话、记忆、执行日志或工作区产物复制进源码仓库。

## 未完成方向

### P0：缓存红线与 Provider 校准

- **真实长任务红线已按现行口径达成**（第 16 回合起各验收节点 ≥95%，至少两次运行；判定入口 `pnpm run check:cache-acceptance`）。仍未闭环的是：3 回合形状短负载的结构上限（87–89%，只能靠更长的会话摊薄）、"窗口远大于会话"配置下压缩不触发导致的持久记忆写入缺口（见"会话压缩与记忆写入"）、以及更多 Provider 与更大负载下的复现。
- Pro 工具协议与其他实际启用的 Provider 需要各自建立模型专用校准门；未配置的 Provider 保持 unavailable，不显示伪精确 token。
- **休眠但未修复的前缀稳定性问题**：曾观测到稳定 system 提示自身在任务中途变化（date-time/记忆索引段）而使整段前缀失效；`packages/prompt/src/builder.ts` 仍把 `date-time` 段以 `required: false` 放在缓存边界之上，两条候选修法（区间内字节稳定或下移到边界之后）都没有实施也没有撤回。28 回合长任务实测 0 次 provider 矛盾，属休眠状态，不是已解决；改动时间文案、时区或记忆索引聚合时需重测该场景（记录见[缓存 95% 验收规程](../reference/cache-95-acceptance.md)）。

### P0：记忆与长任务验收

- 实际 Provider 下的长会话质量、摘要生成失败、跨陈述语义重写与超大子树治理仍待验收；本地 activation、反馈演化和摘要证据门已通过，不能替代真实模型判断质量。
- 长期真实用户负载的观测样本量仍不足，不据此调整 activation 参数。

### P0：运行连续性与数据边界

- 外部系统副作用对账、真实网络中断和更长期真实用户负载待验收；正式数据根迁移待用户确认。
- **并发负载门在"强杀重启后并发恢复检查点"处仍失败**：3 个并发真实 run 强杀重启后恢复时报 `run checkpoint resume conflict: checkpoint has an active resume lease`，而检查点在恢复前刚被判为 `resumable`。这是重启后租约状态的竞态/未释放问题，属运行状态一致性方向，不是对话执行路径的缺陷。
- **受限模式的批准对话框仍未在真实窗口里走过**：三档权限的判定矩阵与"研究模式批准/拒绝"已有真实窗口证据，受限模式只有自动化覆盖。

### P1：效率基线

- **与成熟 Agent 产品可比较的任务效率基线尚未建立**：需要简单/标准/复杂/长任务四档任务集，冻结相同输入、产物质量检查、任务终点与允许成本，并分别记录完成率、首次成功率、总耗时、用户打断次数、重复工具调用、恢复成本、Context 消耗、并行加速比、调度开销和无价值输出；对比裸模型、当前 LS 与条件允许时的成熟 Agent 同类任务，结论要能说明差距来自模型、Runtime、工具、Context 还是数据。工具准入本身仍按收益、权限面、Context 成本、维护成本和移除条件评审（见[架构原则](../principles/architecture-principles.md)）。只比较功能数量、或在前述能力形成可重复闭环前给出主观排名，都不算通过。该方向由已退役的《Agent Runtime 连续性任务书 2026-07-14》阶段 7 并入（原文可取回：`git log --follow -- docs/taskbooks/agent-runtime-continuity-taskbook-2026-07-14.md`）。

### P1：桌面与生态

- 开发环境运行时分发（来源锁定、签名校验、按需下载、取消与恢复）未完成。
- MCP 尚无生产实现：需先明确服务器生命周期、权限、命名冲突、超时与批准策略，再从复用统一 Tool Execution Service 的 adapter 开始。
- 插件 API v2 贡献点（provider / memory / workspace / automation / renderer UI）与 Skill 治理队列仍在规划；发布、签名、升级与卸载流程未闭环。

**验收标准**：每个能力域都有可复现命令与明确边界；未达标项如实标记，不用局部读数代替整体结论；用户数据迁移可验证、可回滚；后台运行始终可见、可终止。

## 推荐后续顺序

1. **真实长任务红线（已完成，转入回归）**：目标、初始状态与整任务账本已按[缓存 95% 验收规程](../reference/cache-95-acceptance.md)与[缓存基线批次历史](../reference/cache-baseline/README.md)冻结（原任务书已于 2026-09-24 退役），跨 run 续接、新增输入、压缩触发与恢复成本都已优化并实测（长任务 99.13% / 99.21%，重启 98.99%，空闲 45 分钟 99.05%）；后续只需保持 `pnpm run check:cache-acceptance` 与冻结清单回归，并在 3 回合形状上不再期待红线。每项真实长任务在预先冻结的业务节点按会话累计值验收，初始冷启动低值不误报，全部用途成本仍完整核验，不用填充、预热或排除调用换比例；其他 Provider 在实际支持范围内另行校准。
2. **继续记忆与长任务验收**：在正式 V3 上验收真实会话写入、索引导航、验证反馈、本地向量维护与重启连续性，并积累观测样本。
3. **在统一工具服务上扩展**：补齐网络资源声明、更强授权 token 与 MCP adapter；不再建立第二条工具执行路径。
4. **保持已完成的连续性与后台控制**：运行时事件、TaskBookPatch、Runner 续跑、应用启动恢复、活动任务控制、托盘与关闭策略继续作为回归门，再验收真实网络中断、外部系统副作用与更长期负载。
5. **最后推进分发与生态**：开发环境正式分发、Mode Registry、插件 API v2 与发布安装流程，在所有前置契约稳定后再展开。任务效率基线（四档任务集与成熟 Agent 对比）是独立测量项，随上述各阶段进展积累样本，不与功能收尾绑定。

## 维护规则

- 本文件只记录当前事实和可复现证据；完成一项能力时同步更新测试、构建证据与本文件。
- 不把分轮开发记录、提交轨迹或一次性验收过程写回本文件；实现过程用 git 历史与任务书追溯。
- 会随每次运行变化的数字（测试数量、耗时、token 读数）不写入本文件，只保留判定口径与命令入口。
- 任何"已完成"都要说明范围：基础形态、配置层、连接器层与真实场景验收不能混为一谈。
- 不把用户密钥、用户会话、记忆树或工作区文件复制到仓库；运行时数据只在用户数据目录中维护。
- **回滚锚点**：`freeze-2026-09-02` tag 仍指向原冻结提交 `a925a508c009505c474faecd5419f9256bc89f5f`；其后的 Harness 与缓存增量都在 `main` 上继续开发，当前工作树**没有**重新冻结，不能把 `main` 的 HEAD 当作冻结版本引用。需要回滚或对比旧行为时用该 tag，而不是某次任务的起点提交。
