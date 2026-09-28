# LittleSheep 项目状态

最后更新：2026-09-29 00:22:02

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
- **持久化 TaskBook 是只读历史**：步骤执行器与调度器已删除，没有任何生产路径再创建计划或步骤执行结构，也没有活路由指向退休 stage（`packages/harness/src/stages/current-path-contract.test.ts` 扫描生产源码挡住重新接入）。**旧数据里 `task_book` 这个执行模式仍按旧边界读取，但不再"降级"**（2026-09-27，HC-02 更正）：它由 `PersistedExecutionWorkMode`/`PersistedWorkPolicy` 表达，只被恢复校验 `isSupportedPersistedWorkPolicy` 接受，运行路径不读取它；原先的降级代码与它依赖的两个 helper 已随消费者核实删除，未知模式一律拒绝而不是静默执行。
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
- **压缩只产生会话摘要，不再是记忆写入方**（2026-09-27 起，RS-05）：`runner-finalize` → `compactSessionAfterRun` 只维护会话摘要；它不再生成或结算长期候选，升级前留下的 pending 候选会被终止并留档（`rejected` 结果 + `terminatedAt`/`terminationReason`，文件保留）。失败与重试的摘要尝试仍计入 operation usage。
- **模型有受控的记忆写入接口**：写入口 `memory_write`（需批准，每次 run 上限 4 条；`user-request` 必须引用真的写了记忆指令的用户消息并由 Runtime 读原文核对，`necessary` 必须说明用途与不保存会失去什么；来源必须存在于本会话，被截断/清洗的来源不能支撑 durable 事实；写入身份由会话+分支+作用域+规范化内容+来源哈希而来）与管理口 `memory_manage`（用户亲口"忘记这条"/纠正；纠正按"写替代 → 记关系 → 才 supersede"三步提交，失败如实报告停在哪里）。常驻验收：`pnpm run verify:memory-controlled-writes`（隔离数据根、真实 runner 与存储，10 个场景）。
- `memory_tree` 仍是只读导航：`root_index` / `branch_index` / `expand` / `deep_search` / `release`（`packages/memory-tree/src/memory-tool.ts`）；相似度只能提名、不能决定，值不同/恰有一侧否定/实体不相交的相似记忆一律拒绝合并（`packages/memory-tree/src/memory-repository/merge-guard.ts`）。
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

它还不是可直接宣称"生产就绪"的发行版。缓存红线在**真实长任务**上已按现行口径达成（第 16 回合起各验收节点 ≥95%，含重启与 45 分钟空闲两种中断；判定由 `pnpm run check:cache-acceptance` 执行），但仍未闭环的是：3 回合形状短负载的结构上限（87–89%，只能靠更长的会话摊薄）、压缩在"窗口远大于会话"配置下不触发（只影响新会话摘要的产生，持久记忆写入已由受控工具承担，见"会话压缩与记忆写入"）、Pro 工具协议与其他实际启用 Provider 的模型专用校准、非字段事实的普遍连续性、外部系统副作用验收、MCP、安装包发布、与成熟 Agent 产品可比较的任务效率基线和长期真实用户负载。未配置的 Provider 不视为产品故障，但也不能冒充已校准。

## 能力总览

| 能力域 | 状态 | 当前结论 | 主要位置 |
| --- | --- | --- | --- |
| 架构治理 | 仓库基元化阶段 0-7 已完成 | 所有 workspace package 与领域目录均有所有权 README；关键组合入口收敛为 facade；`check:repo` 校验文档、模块与 TypeScript references；`verify:changed` / `verify:core` / `verify:full` 提供三级验证 | `docs/reference/repository-guide.md`、`docs/reference/module-split-map.md`、`scripts/check-repository-hygiene.mjs` |
| 核心流程与状态机 | 已收敛为单一主循环 | 活动路由只产出 `execute` 与能力/状态 `reply`；DECIDE、验证模型调用、恢复模型调用与 CAPTURE 已删除；`classify` 仅作历史标签与检查点兼容；ASK_USER 由主循环或 RECOVER 升级到达 | `packages/harness/src/stages/classify.ts`、`stages/execute/tool-loop.ts`、`stages/verify.ts`、`stages/recover.ts`、`packages/types/src/stage-transitions.ts` |
| Context 与请求装配 | 主要数据链已实现；真实长任务红线 `met`、3 回合短负载有结构上限 | 边界之上为 system 消息、边界之下由 append-only 尾部账本追加；工具目录会话内固定；淘汰按 `appended-only` 作用域；tokenizer 能力矩阵与双账本已接通；会话累计命中率见"缓存命中率现状" | `packages/context/src/engine.ts`、`packages/harness/src/run-tail-ledger.ts`、`packages/harness/src/cache-prefix-split.ts`、`packages/types/src/token-ledger.ts` |
| 工具执行 | 工程基线已完成 | `ToolExecutionService` 是查找、schema 校验、权限/单次批准、超时、中断、调度、清洗、事件与调用记录的唯一宿主边界；内置、插件和 run-scoped 工具共享该服务 | `packages/tools/src/tool-execution-service.ts`、`packages/runner/src/run-tools.ts` |
| 权限与数据边界 | 已实现基础闭环 | 三档权限与行为 profile 正交；容器是 Main 的路径分类与审批闸门；核心源码宿主级只读 | `packages/safety/src/permission-boundary.ts`、`packages/app/src/main/run-policy.ts`、`packages/runner/src/core-source-protection.ts` |
| 记忆树与 Memory v3 | 正式 backend 已切换；长尾验收进行中 | 索引优先检索、稳定实体与有向关系、动态 activation、写入认识边界与压缩后任务锚点恢复均已落地；`memory_tree` 只读；写入经受控 `memory_write`/`memory_manage`，压缩不再写入 | `packages/memory-tree/`、`packages/memory-tree/src/memory-tool.ts`、`packages/runner/src/session-continuity.ts` |
| 会话压缩 | 本地契约已完成 | 压力触发、默认 400/200/background false、摘要与覆盖区间原子提交且失败保留上一份、压缩只产生摘要，不再写入记忆 | `packages/session/src/compaction.ts`、`packages/session/src/compaction-store.ts`、`packages/config/src/schema.ts` |
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
- **开发本仓库的短规则只有一个版本化 owner**：[仓库指南](../reference/repository-guide.md) 的「开发约定（coding agent 的唯一短规则）」——四条硬边界（保留既有改动、敏感材料不入库、不绕过安全边界、如实报告结果）加两条原则（可自主传播范围、验证与风险匹配），以及同指南第 9 条的 L1～L4 验证分档。入口文档（根 README、[文档决策入口](../README.md)）只做导航，不再各自维护启动读序。本机 `AGENTS.md` 由 `.git/info/exclude` 排除，不是版本化规则，也不得被当作公开治理已完成。
- 新增核心协议必须有唯一权威来源；workspace 运行时依赖环、未公开深层 import 会直接使质量检查失败。
- 不把 API key、会话、记忆、执行日志或工作区产物复制进源码仓库。
- **文档新鲜度不再由机器强制**：README 与正式文档的秒级 `最后更新` 格式义务、"目录源码提交晚于 README 即失败"的 chronology 比较都已删除（2026-09-29），因为两者只证明文档被触碰、不证明文档仍与代码一致。仍然机器检查：每个 package 与独立领域目录必须有 README、正式文档必须能从分层入口定位、任务书文件名与标题日期一致（正文日期行可只到日）。**README 是否跟上语义变化留给 code review**，详见下节。
- **结构增长是提示，结构完整性仍是硬门**：任务书数量预算、组合热点超过登记上限、600 行文件超过受控上限、拆分地图里手写的行数改以 `[ok-advisory]` / `[advisory]` 输出（摘要写作 `N passed (+M advisory ok), K failed`），不再让一次无关任务为了变绿去重构。**仍是硬失败**的是记录本身坏了：`300 行以上生产文件已登记`、热点登记的文件不存在、600 行登记的缺登记／所有者或原因为空／`本轮复查到期` 缺失或已过期／复查日期不写"同上"、拆分地图登记的文件不存在。仓库没有 `.github` workflow、tracked hook 或配置的 `core.hooksPath`，因此 `check:repo`、`verify:*` 都只是**被调用时生效的本地编排**，不是远端强制门；在接入 CI 之前，任何"机器已兜底"的说法都不成立。

## 对话连续性（2026-09-27）

原「对话任务连续性 P0 专项任务书 2026-08-13」于 2026-09-27 退役，仍然成立的事实归入本节（原文见 git 历史）。

- **新 run 不把任务停在问题上**：当前架构里一次 run 不会为了自己提出的问题而挂起——问题是普通回复，下一条消息是**同一会话**里的下一次 run。因此"等待用户输入的原任务被当成独立新任务重新分类"这条历史故障链**已不可复现**；`run-checkpoint-controller.resolveWaitingUserHead` 的绑定/claim/disposition 解析作为**旧检查点兼容路径**保留，并由单元与 Electron 连续性场景持续覆盖（唯一 head、原子 claim、冲突失败关闭、disposition 分流、资源与权限重验、副作用幂等）。
- **连续性由会话转录承载**：同一 `sessionId` 内每条用户消息恰好持久化一次；真实流程中 `conversationContinuation.resolution` 为 `none`，即没有隐藏的自动续接绑定在替用户接线。
- **回答连续有交付物级硬门**（CTC-P0-12）：`pnpm run verify:conversation-continuity-live` 用真实 DeepSeek 执行"研究模式下缺权限被挡 → 用户答'给你权限和相关工具了，你再试试' → 完全访问下完成原任务"：第一轮必须**不**产出交付物并说明缺什么；第二轮必须产出可重新打开的 PDF、正文为中文、且最终回复**点名交付物**并**不**重复原问题（有界拒绝泛化追问）。跨重启的真实窗口回答连续由 `verify:electron-deepseek-reply-continuity` 覆盖。
- **未覆盖 / 边界**：该门驱动的是应用 `/run/stream` 入口（桌面输入框使用的同一表面），不是窗口本身；回复检查是"交付物存在且校验通过 + 有界拒绝重问"，不是对措辞的语义评判，真实模型的表达波动会被如实记录为模型行为；`waiting_user` 的真实旧检查点迁移在本环境没有可用的历史数据根，只有夹具级证据。
## Harness 当前语义（2026-09-27）

原「Harness 当前语义与历史复杂度收口任务书 2026-09-25」于 2026-09-27 退役，HC-00～HC-06 全部落地，事实归入本节（原文见 git 历史）。

**唯一入口与唯一循环（HC-00/HC-01）**：产品入口是 `createDefaultHarness`（装配阶段注册表），它调用唯一驱动 `createDurableHarness`；主循环入口是 `executeMainLoop`（`packages/harness/src/stages/execute/main-loop.ts`），单轮工具循环仍是 `runToolLoop`（`tool-loop.ts`）。此前 `createNextHarness`/`executeLegacyLoop`/`runners.ts` 是历史暗示，且 Runner **每次启动构建两个完全相同的 harness**、真正被驱动的是 `infra.nextHarness` 而 `infra.harness` 从未被读取——现在只构建一个，并删除零消费者的 `HarnessRegistryImpl`/`createHarnessRegistry` 与 types 的 `HarnessRegistry` 接口。

**当前执行值与历史可读值分开（HC-02）**：`ExecutionWorkMode` 只有 `bounded_loop`；旧构建写下的 `task_book` 属于 `PersistedExecutionWorkMode`/`PersistedWorkPolicy`，只由恢复校验接受。阶段图同样分开——`allowedTransitions` 只含已注册 stage（`inspectStageTransition` 对它校验，遇到退休 stage fail closed 并区分 `not-an-edge`/`retired-stage`），`historicalStageTransitions` 只供读取旧记录与图工具。每个保留值都在声明处写明支持版本、消费者与移除条件。

**VERIFY 只读本次 run 自己的证据（HC-03）**：两个窄结构 `pass` 此前要求 `taskBook`/`taskExecution`，而没有任何生产路径创建它们，因此真实 run 永远走不到；现在单只读通道要求"整轮恰好一次只读内置调用 + 成功 + 输出完整 + 无副作用 + Provider 回复 + 结果完整"，写后读回通道要求"恰好 write→read 两次 + 路径归一后相同 + 读回与写入内容逐字节相同 + 恰好一条成功 write 副作用"，参数取自本次 run 自己记录的工具调用（`ctx.produced` → `ctx.modelHistory` → `ctx.history`）。随消费者核实删除：局部重规划分支与六个步骤专属辅助函数。**行为变化**：这些窄通道从"测试专属"变为真实可达；其余判定不变，任何记录到的失败、缺失证据或未知副作用仍不能成为 `pass`。

**重复调用的"新执行 vs 恢复重放"（HC-04）**：账本默认拒绝同一 `tool:<name>:<inputHash>` 成功后再调用；当**工具声明** `reRunnableAfterResourceChange`、效果种类非 `unknown`、且账本中存在**晚于该次结算**的同写资源成功变更时，Runtime 发放 `:retryN` 新身份并在持久意图事件写入 `warrant:resource-changed:<前序效果>` 审计，原结算保留。`write`/`edit` 声明该能力，`exec` 等不透明工具不声明（Shell 文本不能证明范围），模型重复请求或换理由都不构成凭据。真实模型验收 `verify:ledger-reexecution-live` 两场景通过。

**运行期事件重入有界（HC-02 附带修复）**：延迟的用户补充/任务事件每个事件只交给主循环一次，之后按主循环的决定收尾；此前"没有阶段消费该事件"会让 run 无法结束并耗尽内存（实测 `default-harness.test.ts` 124 秒后 OOM，现该文件 12 项 6 秒通过）。

**回归约束（HC-05）**：`packages/harness/src/stages/current-path-contract.test.ts` 扫描生产源码，禁止重新接入退休执行体系（TaskBook 字面量、`executionMode: 'task_book'`、退休入口名、已删除的步骤辅助函数、指向退休 stage 的活路由），并断言"可重跑"能力只由拥有写资源的文件工具声明；同一文件用真实 harness run 证明该能力的端到端接线。兼容夹具只出现在标题点明 legacy/inherited 的分组里：**读旧值可以，造旧值不行**。

**仍保留的兼容项与消费者**：`PersistedWorkPolicy`（恢复校验 `runner.ts`）、`historicalStageTransitions`/`historicalStageNames`（读取旧 trace 与图工具）、`RunCheckpoint` 的阶段名校验表与 `Message.stage`（旧转录与检查点）、`decide`→`execute` 归一（`checkpoint-resume.ts`）、旧输入哈希身份（账本保守读取）。**未由本批承接**：`model-observability.ts` 与 `stages/execute/tool-loop.ts` 的拆分仍只归模块拆分地图队列；`exec` 这类不透明工具的对象范围仍是已知缺口（需要工具声明资源才能真正发放凭据）。
## 文件一致性与受控记忆（2026-09-27）

原「Runtime 状态一致性与必要记忆任务书」于 2026-09-27 退役，其仍然成立的事实归入本节（原文见 git 历史）。三项完成记录：**实现完成**、**真实验收完成**、**缓存回归完成**。

**文件侧——观察后才允许覆盖**（`packages/tools/src/file-observation.ts`、`read`/`write`/`edit`/`document_create`）：

- 每次完整且未被清洗/截断的读取才产生 observation（内容哈希 + `coverage: full|partial`）；二进制预览、截断与脱敏**不产生**观察，所以"看过一部分"不能换来完成覆盖。
- 覆盖已有文件前**按内容哈希**校验：文件被改过 → `observation_stale`；只读过一部分 → `observation_missing`；没有观察端口 → 拒绝而不是猜测。同大小、保留 mtime 的改写同样会被识别。
- `document_create` 首版只创建新文件：目标已存在即 `target_exists` 拒绝（不为二进制文档扩展覆盖协议）；`exec` 之后相关观察保守失效，后续编辑按陈旧处理。
- 判断一致性的依据是**最终字节**，不是"有备份"：`pnpm run verify:file-consistency-faults`（11 场景，真实文件与故障注入：同大小改写、其它区域变化、部分读取、截断、目录改 junction 的路径重定向、删除重建、并发创建、跨会话提交、审批被拒、exec 部分失败、进程重启）与 `pnpm run verify:desktop-file-consistency`（14 项检查，真实窗口内"读→用户保存→被拒→重读成功"，并用应用自己的 shadow 版本仓库重建每个历史版本与最终文件对账）。
- **未覆盖**：回滚检查点失败属桌面入口，未纳入脚本；Windows 上以目录 junction 代替符号链接验证路径重定向。

**记忆侧——受控写入与"相似度只提名"**（详见「会话压缩与记忆写入」一节与 `packages/memory-tree/README.md`）：

- 压缩只产生会话摘要（RS-05）；旧 pending 候选被终止并留档，`pnpm run verify:legacy-data-root-upgrade` 断言每个候选 `rejected` + `terminatedAt` + 点名原因、长期原子 0 → 0、重复压缩不重复结算、无隔离标识/迁移 locator 的数据根受控拒绝（审计可能最终落在 `failed/`，见 `packages/session/README.md`）。
- 查询向量只在 `deep-search` 边界准备（RS-06A）：D1 索引、`nodeId` 展开与 `expand(query)` 都不走向量，回归见 `packages/memory-tree/src/memory-repository/v3-backend.test.ts`。
- 常驻验收：`verify:memory-controlled-writes`（10 场景，隔离数据根 + 真实 runner/存储）、`verify:memory-live-model`（真实 DeepSeek `deepseek-flash`，**5/5**：明确记住、新会话召回、自然语言纠正、闲聊不写、忘记生效）。
- **未覆盖**：真实模型下的"必要决定按需写入"与"含糊指代/跨 scope 拒绝"目前只有确定性验收；真实模型那一轮的纠正行为在描述修正前后各出现过一次失败（见 `packages/memory-tree/README.md`）。

**缓存回归**：本轮变更后的构建上 `pnpm run check:cache-acceptance` 结论 `met`，长任务 `>=95%` 达标 2/2，冻结清单 12 次运行全部通过。
## 应用层 UI 与工作区（2026-09-26）

《应用层 UI / UX 优化与统一任务书 2026-09-22》（原 `docs/taskbooks/application-ui-ux-taskbook-2026-09-22.md`，已退役）的 UX-32～UX-39 已完成，仍然成立的事实归到本节；逐条实现与逐次实测数字留在 git 历史（`git log --follow -- docs/taskbooks/application-ui-ux-taskbook-2026-09-22.md`），每个门证明不了什么写在各门自己的 `limits`。

- **终端会话（UX-30 / UX-32 / UX-37）**：渲染器最多同时持有 8 个会话，判定发生在向 Main 创建**之前**，被拒时给出可见提示且不产生 Main 孤儿会话。**同一时刻只读一个会话**（当前显示的那个）：切换标签会中止旧流，由 Main 的 `replayTo` 把有界历史送回。此前"每个会话一条流"在 6 个会话时耗尽浏览器对同一 origin 的 6 条 HTTP/1.1 连接，之后的创建/输入/尺寸请求全部排队不返回，界面既不报错也不拒绝（实测点了 8 次创建只 settle 6 次）。隐藏面板保活，关闭终端标签关闭该面板全部会话。切回的会话若已 `ready` 立即接受输入（否则空闲 shell 不再输出，键盘会永久失效）。**重放必须剥掉由终端回答的设备查询**（`CSI c` / `CSI > c` / `CSI 5n` / `CSI 6n`，`stripTerminalDeviceQueries`）：否则终端把答案当用户输入发给 shell，实测切回标签后的命令以 `\x1b[?1;2cSet-Content …` 到达并被 PowerShell 拒绝。最近命令列表带命令所在会话的真实 Shell 名（旧记录与 Agent 运行命令省略，不猜）。Shell 探测从 PATH 里 `Git\cmd\git.exe` 反推非默认安装根（本机 `D:\Git`）；显式指定的未知或不可用 shellId 返回 400，只有未指定 id 才选默认 Shell。**终端标签不跨重启持久化**（已决定不做），界面也不暗示旧进程仍在运行。
- **对话区（UX-33 / UX-38）**：验证结论在两种显示模式都可读——紧凑模式由 `.agent-transcript-attention` 承载，普通模式由 `activityVerificationLine` 单独渲染一行（`data-transcript-verification`，中性样式，不带危险色）。活动状态只有 `running / done / failed / aborted / paused / waiting_user`，**没有 `partial`**：需要"没做完"的说法时用 `aborted`、`paused` 或 `needs_replan`，不为清单虚构状态。切回会话按当前产品行为**跳到最新**（`gap ≤ 1`、无"回到最新"按钮），不恢复上次阅读位置。`回到最新` 按钮在普通/紧凑、800×660 最小窗口与 DPR 2 下可达、命中自身且不压输入栏。复制按钮写入剪贴板的文本等于持久化 settlement；同一夹具在紧凑模式、以及重载后重开同一会话时渲染同一结算。顶部/中部/底部三种起始位置都按 `data-message-key` 锚定（容差 1 px），底部按贴底判定。
- **文件树（UX-36）**：目录筛选下推到 Main，在排序之后、320 项截断**之前**执行，因此排在前 320 之外的文件仍可按名称筛到；未展开目录不递归扫描。逐键筛选实测约 160–240 ms，320 行 Tab 导航可达最后一行，滚动为同步布局成本、无长帧；决定不做虚拟化（未截断时的创建/布局成本随行数单调上升，记录在门里）。
- **Git 审阅（UX-35）**：一致性指纹是 `HEAD` + `.git/index` 的元数据 + **同参数** `status --porcelain -z`，属**集合级**校验——一个本来就脏的文件再次保存、而 porcelain 文字不变时检测不到，界面不得把它说成当前文件的原子快照。Diff 连续 409 的自动刷新最多两次，之后停止并提示手动重试；持续 Git 状态变化时快照标 `unstable` 并显示"仓库在读取期间仍在变化"。
- **地址栏与用户项目服务（UX-39）**：裸 `localhost:5173`、`127.0.0.1:5173`、`[::1]:5173`、`*.localhost` 被读成 **http**，其它裸主机保持 https 假设；LS **不替用户启动项目脚本**，唯一"起服务 + 开 URL"是 LS 自有的有界静态预览服务。
- **打包与门**：`verify:html-preview-baseline` 支持 `--app=packaged`，对 `release/win-unpacked` 跑同一条 walkthrough 并记录 `packagedExecutable` 与 `app.asar` 的 sha256（打包产物须先用 `pnpm run package:win` 重新生成，否则测的是旧字节）。命令与覆盖范围见 [scripts/README.md](../../scripts/README.md)，实现边界见 `packages/app/src/main/README.md`、`packages/app/src/renderer/workspace/README.md`、`packages/app/src/renderer/chat/README.md`。

### 同一批验收记录的开放边界

- 安装包（NSIS）实机安装与干净机器首次启动仍未验证；打包变体只覆盖解包目录，并靠证据里的 asar 摘要说明测的是哪一份字节。
- `scripts/` 没有录屏能力：对话区"修复前后"的验收口径是逐帧 DOM 采样 + 前后 PNG，写进对应门的 `limits`，不用它冒充视频。
- 用户报告的"流式文字变色"在固定输入下**未能复现**（每类块全程只有一个样式签名）；继续追需要复现输入（推理/工具混合输出、更长代码块的高亮 chunk 时机、主题/缩放切换瞬间）或用户录屏，不据猜测改样式。
- 重载后重开会话这一步实测：点击**已经是当前会话**的侧栏行会再起一次历史读取，60 s 内停在"加载历史消息"；门因此不点活动行，这条路径记为未验证而不是通过。
- 面板全屏：门断言应用状态可达（`fullscreen` + shell fullscreen 类），但实测 aside 宽度仍是 ~0.8 px、面板表面维持拖动后的 409 px，**视觉加宽没有证据**，需要单独排查。
- `waiting_user` 仍不能由**运行中**的路径产生（澄清活动与派生状态已删除，`run-checkpoint-controller.ts` 说明新 run 不会再停在自己的提问上），但它不是"无法取证"：`verify:transcript-state-visibility` 第 8 类在独立数据根上先跑完一轮（会话因此进入索引、侧栏可达），第二轮模型请求在途时强杀进程、同根重启，Runtime 自己的恢复（`runtime_status_settled`，reason `model_response_missing`，发生在被杀进程 30 s run 租约到期后）把该 run 结算成 `waiting_user`，普通与紧凑两种显示模式都读作 `等待你决定后继续`（触发行 `等待处理`，答案位置是 Runtime 状态而不是模型回复）。运行中的"等用户决定"（写审批）仍由同一条门的第 4 类以**待批准**形态取证。**同一夹具观察到一处文案问题（未修）**：这条恢复状态的正文是 `packages/runner/src/authoritative-reply.ts` 里的英文硬编码（`Runtime is waiting for user action; no final reply was published. Reason: …`），中文界面下用户看到的是英文 Runtime 状态。
- **第二个工作区根的跨工作区/重启归属已验收**（UX-39 第 3 条与 UX-33 的"跨重启会话级现场"）：`verify:electron-ui-state-continuity` 现在建两个工作区根，走"root A → 项目 root B → B 内新建会话 → 重启应用 → 回到 A"的往返，并断言：B 的文件树只列 B 自己的文件（`bravo-only.txt` / `bravo-only-dir`）、`GET /workspace/review` 对**非活动**根返回 **403** 而活动根 200、终端在两个根切换后都是 0 个会话、重启后仍停在 B 且**未保存草稿 `draftRestored: true`**、文件标签仍是 `dirty`、浏览器标签与展开目录都还在。这一轮为它修掉三处验收脚本缺陷（输入草稿落进文件导航的筛选框把树筛空、Monaco 只读表面未等待就打字、`Page.reload` 之后 CDP 执行上下文失效而不重连），它们都是脚本问题，不是产品缺陷。

## 未完成方向

### P0：缓存红线与 Provider 校准

- **真实长任务红线已按现行口径达成**（第 16 回合起各验收节点 ≥95%，至少两次运行；判定入口 `pnpm run check:cache-acceptance`）。仍未闭环的是：3 回合形状短负载的结构上限（87–89%，只能靠更长的会话摊薄）、"窗口远大于会话"配置下压缩不触发（只影响会话摘要的产生；持久记忆写入已由受控工具承担，见"会话压缩与记忆写入"）、以及更多 Provider 与更大负载下的复现。
- Pro 工具协议与其他实际启用的 Provider 需要各自建立模型专用校准门；未配置的 Provider 保持 unavailable，不显示伪精确 token。
- **休眠但未修复的前缀稳定性问题**：曾观测到稳定 system 提示自身在任务中途变化（date-time/记忆索引段）而使整段前缀失效；`packages/prompt/src/builder.ts` 仍把 `date-time` 段以 `required: false` 放在缓存边界之上，两条候选修法（区间内字节稳定或下移到边界之后）都没有实施也没有撤回。28 回合长任务实测 0 次 provider 矛盾，属休眠状态，不是已解决；改动时间文案、时区或记忆索引聚合时需重测该场景（记录见[缓存 95% 验收规程](../reference/cache-95-acceptance.md)）。

### P0：记忆与长任务验收

- 实际 Provider 下的长会话质量、摘要生成失败、跨陈述语义重写与超大子树治理仍待验收；本地 activation、反馈演化和摘要证据门已通过，不能替代真实模型判断质量。
- **`pnpm run verify:memory-v3-provider` 目前不可作为验收证据**（2026-09-27 核对）：脚本仍要求已删除的 `EVOLVE`/`CAPTURE` 记忆意图与 stage（`scripts/lib/memory-v3-provider-acceptance.mjs:99,100,107,275`），当前实现下必然失败。所有者是它在[仓库指南](../reference/repository-guide.md)测试与脚本清单里的条目（实现为 `scripts/verify-memory-v3-provider.mjs` 与 `scripts/lib/memory-v3-provider-acceptance.mjs`）；脚本修正前不得引用它的结论。
- 长期真实用户负载的观测样本量仍不足，不据此调整 activation 参数。

### P0：运行连续性与数据边界

- 外部系统副作用对账、真实网络中断和更长期真实用户负载待验收；正式数据根迁移待用户确认。
- **并发负载门在"强杀重启后并发恢复检查点"处仍失败**：3 个并发真实 run 强杀重启后恢复时报 `run checkpoint resume conflict: checkpoint has an active resume lease`，而检查点在恢复前刚被判为 `resumable`。这是重启后租约状态的竞态/未释放问题，属运行状态一致性方向，不是对话执行路径的缺陷。
- **受限模式的批准对话框仍未在真实窗口里走过**：三档权限的判定矩阵与"研究模式批准/拒绝"已有真实窗口证据，受限模式只有自动化覆盖。

### P1：效率基线

- **与成熟 Agent 产品可比较的任务效率基线尚未建立**：需要简单/标准/复杂/长任务四档任务集，冻结相同输入、产物质量检查、任务终点与允许成本，并分别记录完成率、首次成功率、总耗时、用户打断次数、重复工具调用、恢复成本、Context 消耗、并行加速比、调度开销和无价值输出；对比裸模型、当前 LS 与条件允许时的成熟 Agent 同类任务，结论要能说明差距来自模型、Runtime、工具、Context 还是数据。工具准入本身仍按收益、权限面、Context 成本、维护成本和移除条件评审（见[架构原则](../principles/architecture-principles.md)）。只比较功能数量、或在前述能力形成可重复闭环前给出主观排名，都不算通过。该方向由已退役的《Agent Runtime 连续性任务书 2026-07-14》阶段 7 并入（原文可取回：`git log --follow -- docs/taskbooks/agent-runtime-continuity-taskbook-2026-07-14.md`）。
- **开发侧治理成本的 coding-agent 配对试验仍未完成**（2026-09-29）：本轮只做了 1 对夹具 × 3 个场景的确定性门禁试点（见「仓库开发 Agent 约束瘦身」），没有会话级完成率、耗时或 token 读数，因此"纯治理耗时／工具调用下降 ≥20%"既未证明也未否证。要采用或撤回 B 规则包，需按退役任务书第 5 节在独立 checkout、冻结预算与固定模型版本下跑先导 12 次；在拿到这些读数之前，短规则的采用依据只是"保护未减弱 + 维护面下降"的定性判断，不得表述为已证明的效率提升。

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

## 整仓瘦身与冗余收口（2026-09-27，任务书已退役）

任务书 `docs/taskbooks/repository-slimming-taskbook-2026-09-27.md` 已完成并退役，全文留在 Git 历史。基线账本见 [repository-slimming-baseline-2026-09-27.md](../reference/repository-slimming-baseline-2026-09-27.md)（绑定 HEAD `ec527a7e`，只写实测）。以下仍成立的事实由本节拥有。

### 已实施并有测量证据

| 项 | 结果 | 测量口径 |
| --- | --- | --- |
| 误入库的测试/编译生成物 | 删除 **111** 个（110 个 `cache-scope-matrix-*/*.json` + 1 个 `vitest.config.ts.timestamp-*.mjs`，**271,959 字节**）；跟踪清单中该类产物现为 **0** | `git ls-files` 与逐文件长度 |
| 生成物来源 | 两个测试的暂存目录改到系统临时区（`mkdtemp(join(tmpdir(), …))`）；中断实测：仓库根不再新增可入库文件 | 杀掉进程后重跑 |
| 防回流 | 门禁拒绝 4 种生成形状，并校验 4 条忽略规则存在；新增"把门禁拷进临时仓库"的失败用例 | `check:repo` + `scripts/check-repository-hygiene.test.mjs` |
| 无效依赖边 | 净减少 **6** 条：`packages/tools` 去掉 `@littlesheep/experience`、`@littlesheep/vector`、`@littlesheep/memory-core`；`packages/harness` 去掉 `@littlesheep/safety`；`packages/experience` 去掉 `zod`、`@littlesheep/types` | 逐包 import 计数（0 引用才删）；F-02 四条候选全部处理完 |
| ⚠️ F-02 候选的核对更正 | 第一轮把扫描结果**配错了包**：F-02 的候选是 `tools → memory-core` 与 `harness → safety`，而第一轮引用的是无关的另一对边。重新取证后两条候选均**确实无引用**（各自唯一出现即声明行 `tools/package.json:17`、`harness/package.json:26`；无静态引用、无动态 `import()`、无裸名 specifier、无传递需要），故**已删除** → F-02 四条候选至此全部处理完 | 逐包 grep（记住：`tools → safety` 13 个文件与 `harness → memory-core` 1 个文件是另外两条**应当保留**的边） |
| 未装配工具 | 删除 `createRecordExperienceTool`（250 行，净 −229 生产行，导出 10→8）；`ExperienceStore` 与 CLI `import-repo` 的消费者保持 | 全仓消费者搜索 |
| `packages/vector` | **已退役**（用户裁定）：无生产/CLI/迁移/脚本消费者；用户 v2 数据库原样留在磁盘，读取实现留在 Git 历史；`sync:tsconfig` 由 28 个引用降为 **27** | 消费者搜索 + 项目图 |
| 空正文动态 Skill | 普通 run 不再广告 `taskbook`（改前会广告且正文为 `undefined`）；旧 checkpoint 仍读出计划，`execute` 恰好一次、无 `decide` | 在模型请求内读实时描述与 `loadBody` |
| 脚本重复实现 | 净 **−429 行 / −3 文件**：`CdpClient` 5→1、`reservePort` 5→1、私有 `waitForExit` 8→5、私有 `startElectron` 6→3；三个孤立诊断脚本退役且独有读数已迁移 | 证据表 `scripts/acceptance-matrix.md` |
| 文档漂移 | 14 个文件改为"受控工具写入 + 压缩只产摘要"；入口文档历史段 19 段 → 1 行规则 + 10 行归属表，25 个链接无丢失 | 每处先在代码核对行号 |
| 跟踪清单 | **1,930 → 1,820** 项（净 −110） | `git ls-files` |

### 仍开放（带 owner 与原因）

| 项 | 原因 | 下一步 |
| --- | --- | --- |
| **发布载荷收窄**（原 SL-04） | **已完成**（2026-09-27，真实 `package:win-installer` 重打包实测）：unpacked **1175.01 → 569.62 MiB（−51.5%）**、`app.asar` **444.90 → 66.46 MiB（−85.1%）**、`app.asar.unpacked` **361.26 → 134.31 MiB（−62.8%）**、安装包 **273.51 → 158.22 MiB（−42.2%）**；解包差值精确等于非目标切片（`onnxruntime-node` −223.10 + `node-pty` −3.85 MiB，与本节上方测得的 223.1 MiB 一致）。收窄写在 `electron-builder.yml` 的两组 negation；打包输出改由 `scripts/lib/release-artifacts.mjs` 解析，仓库内不再产生发布产物。**仍开放**：embedding 模型**下载**路径（本机 Node 出网被阻断，已用 SHA-256 校验文件验证加载与离线复用）、Mermaid 渲染（无门禁断言）、干净机器 NSIS 安装与旧数据根升级 |
| `verify:memory-v3-provider` 真实 provider 复跑 | 该门已重写到当前语义并通过脚本化客户端验证（负例可失败），但实跑缺两个前置：`DEEPSEEK_API_KEY` 未导出，且数据根缺本地 BGE 模型（`<data-root>/models/embedding`） | 装 BGE 模型并导出 key 后 `pnpm run verify:memory-v3-provider` |
| 本地磁盘回收 | 用户裁定只出清单不删除；清单与保留理由已在退役的任务书中，移出物在仓库之外的 `littlesheep-repo-cache-2026-09-27/`（含 `MANIFEST.md`） | 确认无可再生证据后删除该目录 |
| 门禁健壮性 | 已修：缺失文件时报具名失败而非崩栈 | — |

**口径提醒**：以上"字节/行数"只用于源码维护成本；发布载荷收益现已由重新打包实测给出（见上一行），不再需要外推。

## 仓库开发 Agent 约束瘦身（2026-09-29，任务书已退役）

原「仓库开发 Agent 约束瘦身任务书 2026-09-28」已完成并退役（工作树与索引中都已删除）。**取回方式**：退役删除尚未提交，因此不能声称"全文留在 Git 历史"——文本目前以**悬挂 blob** `29993cab6de22dee726fd0c41d50f6a302367b61` 存在（`git cat-file -p 29993cab…` 可读，但在一次提交引用它之前可能被 gc 回收），另有一份工作副本在 `%TEMP%\littlesheep-retired-taskbooks\`（38,895 字节）。把这次退役删除纳入一次提交后，`git log --follow -- docs/taskbooks/repository-agent-constraints-slimming-taskbook-2026-09-28.md` 才会像上一份退役任务书那样可用。它审计的是**开发本仓库源码的 coding agent** 所受到的规则约束，不改变 LS 产品运行时的权限、核心源码只读保护、工具安全、Memory、状态机或用户数据边界。以下仍成立的事实由本节拥有，短规则与验证分档由[仓库指南](../reference/repository-guide.md)拥有。

### 已落地的治理改动

| 批次 | 结果 | 证据 |
| --- | --- | --- |
| GA-00 冻结基线 | 审计锚点 HEAD `7913335b`；`check-repo` 全绿（38 项通过） | `node scripts/check-repository-hygiene.mjs` |
| GA-02 去掉伪新鲜度 | 删除"每份 README／正式文档必须带秒级 `最后更新`"与"目录源码提交晚于 README 即失败"两条检查；保留 README 存在、文档可定位、任务书文件名与标题日期。任务书要求的"行为级评审用例检出公共入口变了但说明错误"由仓库指南的 README 同步口径 + 公共入口变化的评审清单承担，**不由机器断言**，也不声称机器已自动验证文档语义 | `scripts/check-repository-hygiene.mjs`、`scripts/check-repository-hygiene.test.mjs`（5 个用例，含固定时钟的临时仓库） |
| GA-01 单一入口与软规则 | 新增[仓库指南](../reference/repository-guide.md)「开发约定（coding agent 的唯一短规则）」6 条 + 第 9 条 L1～L4 验证分档；根 README、[文档决策入口](../README.md)只做导航；架构原则第 17 节"七点论证"任务级化为公共契约／durable／安全边界变更；第 14 节生命周期验收收窄为持有监听、进程、异步请求或外部句柄的模块；`local-app-api`／`preload`／`harness`／`plugin-development` 的"每次改动全量验证"改为按风险分级 | 各文档 diff；产品契约描述未改 |
| GA-03 结构阈值提示化 | 降级为提示的是**行数类判断**：任务书数量预算、组合热点超过登记上限、600 行文件超过受控上限、拆分地图里手写的行数（摘要写作 `N passed (+M advisory ok), K failed`）。**仍是硬失败的是结构完整性**：`300 行以上生产文件已登记`、热点登记文件不存在、600 行登记的缺登记／所有者或原因为空／`本轮复查到期` 缺失或过期／复查日期不写"同上"、拆分地图登记的文件不存在 | 门禁输出与新增用例（含"结构坏了仍是失败""超基线只是提示"两半） |
| GA-05 落地与退役 | 本机 `AGENTS.md` 曾由 `.git/info/exclude` 排除、不是版本化规则，其 README 秒级时间戳段落已按新口径同步（本机未跟踪副本）；未引入版本化 `AGENTS.md`／`CLAUDE.md` 自动发现适配（缺真实客户端加载验证，属有条件工作） | `.git/info/exclude`、本文件 |

### GA-04 治理成本试点（不是完整 A/B 对照）

真实多会话 coding-agent 配对试验（任务书第 5 节：先导 12 次、正式 36 次）**未执行**——成本与客户端限制不允许在本轮完成，因此第 5 节的"纯治理耗时／工具调用下降 ≥20%"采用门槛**本轮没有被证明**，也没有被否证。作为替代，本轮做了两项可复核的确定性测量：

- **静态治理面**（`node scripts/report-governance-cost.mjs`，试点入口、不是产品门禁）：入口导航 31 份文档 / 937,506 字节；仍带秒级时间戳的 tracked 文档 88 份 / 1,450,171 字节（docs 31 + packages 57）。这两个字节数是**编辑中途的工作树读数**，没有绑定 revision；在同一工作树稳定后复跑得到 904,872 / 1,457,044 字节，按 HEAD `7913335b` 内容算是 1,441,645 字节——口径是"当前工作树"，要比较必须在同一 revision 上取。格式面不再被门禁强制，这些行只作为历史痕迹保留，不再需要逐任务维护。
- **配对门禁试点**（同一冻结提交 `7913335b` 的两个独立 worktree，同一夹具，只替换门禁及其测试）：`packages/harness` 下只改私有 helper 与它的测试并单独提交时，旧规则 exit 1（`package README 与源码同步更新`），候选 exit 0；删除 `packages/harness/README.md` 时两臂都 exit 1（`workspace package README 完整`）；README 只重新盖章、不刷新任何职责描述时**两臂都 exit 0**——这条直接证明新鲜度检查与语义漂移无关，"README 是否跟上了代码"只能留在评审。

**样本边界**：以上是 1 对夹具 × 3 个场景的确定性读数，不是会话级对照，没有完成率、墙钟耗时或 token 数字，不得据此宣称效率提升或统计显著。要做采用结论，仍需按任务书第 5 节在独立 checkout 与冻结预算下跑先导 12 次。

### 本批验证结果与两个环境事实

- `node scripts/check-repository-hygiene.mjs`：`ok (34 passed (+4 advisory ok), 0 failed)`；`node scripts/sync-typescript-projects.mjs --check`：`ok (27 packages)`；`npx vitest run scripts/check-repository-hygiene.test.mjs scripts/report-governance-cost.test.mjs`：2 个文件 / 11 个用例通过；`pnpm run verify:core`：`passed`（`check:repo` + 全 workspace typecheck + `test:core-eval` 73 个用例全过）。
- `pnpm run verify:changed` 的 `check:repo`、selector、受影响 typecheck、related 测试四段都 `executed` 且 exit 0，但 **build 段失败**：`[vite:define] remove …\Temp\esbuild-<hash>: Access is denied.`。**该失败与环境有关，不是本批改动造成**：把工作树改动整体 stash 回冻结提交 `7913335b` 后，同一条 `ensure:app-build` 以同一错误失败，而本批对 `packages/app/src/**` 只改了 README。可归因方向是这台机器上 esbuild 的临时产物无法被删除（临时目录已积累约 7,900 项），与治理规则无关，未在本批范围内处理。
- **selector 目前把 `packages/app/src/**` 下的一切非测试文件都判为 App 构建敏感**，包括 `packages/app/src/main/local-app-api/README.md`、`packages/app/src/preload/README.md` 这类文档，因此"只改文档"也会要求一次 App 构建。本批没有改这个判定（它属于构建输入影响面，改它需要单独证据），只把它记为观察到的事实：在 App 构建本身失败的环境里，这条会把 `packages/app/src/` 下的文档改动一起拖红。
- **独立复核发现并已修正的四处记账错误**（两名复核者对同一 diff 的报告）：① 原先把"组合热点／600 行受控"整条降级为提示，连带把**结构完整性**（热点文件不存在、登记缺失、所有者空缺、复查到期缺失或过期）也放进了提示——已拆成"行数类=提示、结构类=硬失败"，并补了对应测试；② 归档曾写"300 行登记已提示化"，实际代码里它一直是硬失败（方向相反），已按代码更正；③ `advisory()` 通过时计入 `passes`，摘要里的 `36 passed` 把 4 条非硬门项混进了硬门计数，现已分开打印并写作 `34 passed (+4 advisory ok)`；④ `module-split-map.md` 缺失早退分支的注释曾称它在 `checkCanonicalFiles` 的 required 列表里，实际不在，已更正并保留显式 `[fail]`。

## 前端任务书执行与退役（2026-09-29）

《前端简洁高效化任务书（2026-09-27）》共 22 项，本次执行按"每项必须有自己的验收证据、未取证不勾选"推进，执行情况与未完成原因如实记录如下；任务书本体随后退役，稳定事实以本文件为准。

### 已验收（4/22）
| 项 | 证据 |
| --- | --- |
| O1 结果与异常层级 | 2026-09-28 实机验收：`verify:transcript-state-visibility` ok，59 项断言 |
| S1 信息架构重整 | 实机：四组按字面顺序渲染、14/14 常用条目两跳可达 |
| V1 材质与层级收敛 | 实机：三个玻璃家族条纹夹具重测、150%/200% 逐像素对比度、焦点环与阴影 |
| O5 跨日用量聚合与数据契约 | 13 项测试覆盖五项要求，并经**判别实验**：把折叠键 `requestId` 改为每次唯一 → 相关 2 项转红（2 failed / 11 passed），字节还原后 13/13 绿；另有同一区域的**独立**证据两份（真实 runner 事件驱动的 `provider-usage-daily-real-run.test.ts`，以及证明"绕过去重则数字翻倍"的 `provider-usage-daily-dedup-control.test.ts`），本地实跑 2 files / 5 tests 通过 |

### 部分完成（2 项，均不勾选）
**V3 状态与反馈视觉** —— 三个子项中两个已完成并留证：
- 禁用原因可查：两段式控件（`workspace/terminal-shell-picker.tsx`，提交 `0dd4ba52`，4/4 判别测试）与网络检索的"检查 Tavily 连接"（`settings/web-state.ts` + `settings/web.tsx`，五条叠加原因由同一纯函数导出为可见说明行 + `aria-describedby` + `title`，另有 32 组合真值表）。
- "不可用 vs 空"（差距清单 #20）**已关闭**：四态原语消费者 0 → 5 个页面；`.settings-module-empty` 零消费者、零规则；已安排 = `state-view[data-state=unavailable][role=status][aria-disabled=true]` + 必填可见原因行，插件 = `state-view[data-state=empty][role=status]`；实测区分点 = `data-state`、`aria-disabled`、字形剪影、图标色调与边框、文案、原因行有无；接入检查改动前 3 failed / 1 passed → 改动后 4 passed；真机 13 项读数 allPass。
- **仍未完成（故 V3 不勾）**：①聊天区"空会话"与"发送被阻断"疑用同一条 readiness 文案（判据应为"动态文案是否在两处重复"，落点尚未定位到，`chat/**`）②设置模块搜索输入框的焦点指示（#19 ④）③`ui/README.md` 点名的其余未接入面 ④冷启动视觉门禁的期望需随"标题栏透明"这一用户决定更新。

**I5 联合体验验收** —— 实施前视觉基线存在（渲染器 5 张 + 启动页 2 张，2026-09-27 21:48），本次补足了**让门禁能真正跑起来**的两条环境前提（见下），并把该门禁中"整窗一个统一表面"的旧期望改为用户实际要的契约（条与顶栏行同色、背景可为透明）。**仍未完成**：`readiness-*.png` 五张仍是 2026-09-24（门禁最后一次运行仍在断言处失败），窄窗口/高 DPI/键盘/减少动态效果/长对话/多产物/故障场景七类未采集。

### 未实施（16 项）
O2 长内容阅读 · O3 产物与引用 · O4 消息辅助操作 · O6 Token 用量热力图 · S2 页面布局与密度 · S3 字段级搜索 · S4 编辑与生效状态 · S5 说明与高级信息 · S6 外观设置与字号偏好 · V2 图标语义与可发现性 · V4 深浅主题与跟随系统 · V5 自定义颜色与可读性保护 · I1 输入与选择流程 · I2 工作区操作闭环 · I3 弹层与操作反馈 · I4 动效体系与生命周期（其中"侧栏展开/折叠单一时钟"已于 2026-09-28 完成并入库：同瞬最大进度差 0.326 → 0.005）。

### 未完成原因（如实）
1. **构建资源争用**：`packages/app/out` 与其指纹 sidecar 是单写者资源；本会话有并发写者持续重建，出现连续多次 `App build inputs changed while the build was running; refusing to record stale artifacts`。守卫拒绝把过期产物登记为最新是正确行为，全程未使用任何绕过开关。
2. **子代理反复夭折**：本会话内多次派出的执行包在产出前即不可寻址，窄包成功率高于宽包；后期改为由主线自己读源码、做判别实验。
3. **主线自身两次返工（自述）**：①按"未跟踪 + 疑似临时"的判据删除过一个**活包**正在写的验收测试；②用 `git checkout HEAD --` 回滚自己的错误改动时，连带抹掉了**在写者**对同两个文件的接入改动。此后确立规矩：动文件前先查 mtime 与在写者，"改动是我做的"不等于"文件归我"。
4. **一次被纠正的错误要求**：主线曾要求某包断言"不可用与空的 `role` 不同"；该包查明四态表**有意**让两者同为 `role="status"`（仅 failure 为 alert），并指出"若谁断言两者 role 不同，那是在断言原语故意不做的事"。此纠正已记入 `docs/reference/ui-ux-gap-audit-2026-09-27.md`。

### 环境事实（两次独立复现，供后续复用）
- 本会话中 Electron 必须 `--no-sandbox`（或以 `ELECTRON_DISABLE_SANDBOX=1`）：否则连 `--version` 都退出 `0x80000003 STATUS_BREAKPOINT`，这正是多轮"真机门禁在任何断言之前就失败"的原因。
- 构建必须把 `TEMP`/`TMP`/`TMPDIR` 指到仓库内（esbuild 对 >1 MiB 输入写 `os.tmpdir()` 后删除被拒：`[vite:define] remove …: Access is denied`）。
- 停屏外窗口不得用于像素或原生断言（回答 `HTCLIENT`、`-32000` 返回缩放边框码、`visibilityState` 为 hidden 时焦点既非 `:focus` 也非 `:focus-visible`）。

> 退役说明：本记录即任务书《前端简洁高效化任务书（2026-09-27）》的稳定事实收口。**任务书本体的删除被有意延后**：截至 2026-09-29 06:39 它仍被另一条工作线在编辑（最后修改 7 分钟前），而本会话已有两次"动在写文件导致他人改动被抹掉"的返工。删除应在该线落定后进行，届时同步更新 `docs/README.md` 的分层入口与索引。

### O5 的独立第二线证据（2026-09-29，补入）

除 13 项既有测试与折叠键判别实验外，O5 另有一份**独立**证据（真事件形状、非手写字面量），五项要求各有"错则红"的对照：

- **只计一次**：真实 `createRunner` + 脚本化 `LlmClient`，真实重试（首答为空 → `stages/reply.ts` 生成 request id 2 并带 `retryOf` + `retryReason: 'empty_output'`；实测 2 starts、2 次 `model_response_received`、2 次 settlement、3 次 provider 调用）。绿：日总计 `{total: 286, input: 230, output: 56, requests: 3}`，coverage `{indexedRuns: 4, indexedSessions: 2, attempts: 3, duplicateAttempts: 3}`；重放每次都被答 `duplicate` 且存储事件数不变；重启后由事件重建出可比一致的序列；经产品自身路由 fork（`POST /sessions/:id/branch`）后 `listRunPartitions()==1` 且序列可比一致。**对照红**：去重被绕开（同一夹具）→ `{requests: 6, total: 572}`，原断言原样抛错（`expected { total: 572 … } to match { requests: 3, total: 286 }`）；把副本里的 Provider request id 重新签发 → 同样 6 / 572。
- **无事件日 ≠ 零用量日**：真实运行报告 0/0（`usageStatus: 'available'`）→ 该日 `state: 'recorded'` 且 `missingResponses 0`；前一无事件日 `state: 'empty'`。
- **有界响应**：400 天 → 200 且 `days.length 400`、`bounds {maxRangeDays 400, maxIdentities 64}`；401 天 → **400 拒绝**（不是截断）；默认 366 天。
- **回填可取消可续接**：取消后 `status 'cancelled'` + cursor 仍在 + 部分投影 ≤ 145；以预算 1 续接 → `{requests: 3, total: 145, duplicateAttempts: 0, backfill complete}`，全量重扫 `indexed 0` 且总计一致。
- **仅凭事件重建**：删掉 `usage-index/` 后由事件重建 → 与删除前可比一致，且与 provider 自报一致。

**边界（该包明确不主张的部分）**：LS 的 fork 复制的是**消息**而非事件日志（`Message` 无 usage 字段），所以"fork 不重复计数"成立的原因是**fork 不复制事件**；跨 run 去重守卫由"逐字复制的事件日志"来检验，对照证明该守卫**确有负载**。**留给台账的告诫**：若将来 fork/导入**真的复制 durable 事件**，必须保留 Provider request id，否则聚合会翻倍（实测 572 vs 286）。另有两条不主张：LlmClient 内部的传输层重试只产生一条响应事件，早先被计费的物理尝试无法单独计数；该包**未使用 Electron 窗口**，故不主张任何像素或原生断言。

### V3 阻塞①核实结论：**不是缺陷**（2026-09-29，已证伪）

台账原记"聊天区'空会话'与'发送被阻断'疑用同一条 readiness 文案"。落实后**证伪**：两处指示器都由 `useRuntimeReadiness()` 驱动，但**按状态互斥**，各有独立职责：

- `runtime-readiness/composer-readiness-hint.tsx:21` —— `if (!reason || readiness?.state !== 'starting') return null`：**仅在 `starting`（启动过场）时**显示 Runtime 的阶段句，执行就绪即消失；
- `composer/send-block-notice.tsx:26` —— `if (executionReason || !modelReason) return null`：**仅在模型未配置且无执行原因时**显示阻断原因，`role="status"` + `title`。

该组件自己的头注释已把分工写死（"只有 `starting` 用这个面；失败不是过场阶段，它保留全窗提示条与重试控件，因为只禁用发送按钮会让原因不可见"）。**因此不改文案、不加检查**——为一个不存在的重复去改动用户可见文本，只会制造无收益的变更。V3 的其余三项阻塞（设置模块搜索焦点指示 #19 ④、`ui/README.md` 点名的其余未接入面、冷启动门禁期望已改但未获一次绿运行）状态不变。

### O5 证据入库与未证明边界（2026-09-29，核验方交回）

三份证据文件此前是**未跟踪**状态（不入库即等于没交），现已随本提交入库，并记录其最终摘要与证伪矩阵位置：

- `packages/runner/src/provider-usage-daily-real-run.test.ts` — sha256 前 16 位 `D75ABE95523CA405`，3 用例全过；
- `packages/runner/src/provider-usage-daily-dedup-control.test.ts` — `A54920E37A7A2E7C`（证伪时用的是 06:27 版 `BF719B45C5FA74D7`），2 用例全过；
- `packages/app/src/main/local-app-api/usage-daily-real-events.test.ts` — `9D87FF5E034D40B4`，2 用例全过。
- 证伪矩阵（仓库外 scratch 副本，checkout 全程未被改动）：control exit 0（4 文件/20 用例全过，夹具本身是绿的）→ m1（fold 的 entries 按 runId 分键）2/18 失败；m2（把 `retryOf` 当重复丢掉）2/18；m3（过去的日子一律零填充标 `recorded`）5/15；m4（删掉区间天数上限）2/18；m5（删掉 facet 的 `slice(0,64)`）1/19；m6（增量索引只重读"已认识"的分区 = 把缓存当权威）**16/4**；m7 2/18；m8（取消短路 + 累加替换 + 按 runId 分键三缺陷同上）4/14。报告与逐 mutant 日志：`%TEMP%\littlesheep-run-artifacts\o5-usage-daily\`。
- 干净复跑：`tsc -b` exit 0；`vitest run packages/runner packages/types packages/app/src/main` = **176 文件 / 887 用例通过，exit 0**（基线 173/880，差值 +3 文件/+7 用例正好等于新增证据）；`check:repo` = `ok (34 passed, 2 advisory, 0 failed)`。中途一次 exit 1 是负载抖动（`runner.test.ts` 单独复跑 75/75 通过），不是回归。

**仍未证明（逐条保留）**：①**facet 上限缺 wire 级证据** —— app 层那句 `identities.providers.length <= 64` 在单身份夹具下**永远不会失败**，m5 只有既存 unit 用例（70→64）能抓；②**durable inbox 重投路线无 O5 证据**（现有只覆盖"重复 append 被答 duplicate"与"复制日志"，inbox 崩溃重投的幂等由 O5 之外的 `durable-inbox-recovery.test.ts` 覆盖）；③**取消落在"步骤在途"时未取证** —— `runPass` 在步骤末尾才写进度，故 cancel 与在途步骤重叠时持久化状态可能读作 `partial`（循环确实停下、cursor 保留、续接数字不受影响），属**标签精度**问题而非重复计数问题；④**跨午夜/跨年/闰日/夏令时/清空/永久删除保留**只有 unit 级证据（人工设定 `occurredAt`），无真实 run 证据，`clearThrough` 的"重建不复活"同理；⑤**渲染器不消费该接口**（`grep usageDaily packages/app/src/renderer` 无命中）⇒ O5 **不需要**真机 Electron 窗口，确定性测试即充分；O6 才是首个消费者，仍未验证。
