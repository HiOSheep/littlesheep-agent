# 系统提示词与请求前缀精简任务清单

日期：2026-09-21。
状态：问题定位与离线复现已完成；以下实现任务均未开始。用户本轮要求查明问题并出具清单，本轮不修改运行实现。
目标：减少长任务中不必要的模型输入和请求前缀变化，继续以真实总体缓存命中率 >=95% 为验收目标；本清单不承诺仅完成这些改动就必然达标。

## 一、查明的问题

当前普通聊天与工具工作已经进入同一个 execute 循环，DECIDE、VERIFY、RECOVER 的独立模型调用已移除。问题并非这些旧阶段仍全部存在，而是请求还由多处逻辑临时拼装；“单一执行循环”尚未形成完整的“同一消息序列持续追加”。

### 1. 主循环的动态摘要实际仍在历史消息之前

- `packages/harness/src/stages/execute/runners.ts:36` 使用完整 `systemPrompt.text`。
- `packages/harness/src/stages/execute/guidance.ts:123` 将它放在会话历史之前。
- `packages/prompt/src/builder.ts:232` 把 sessionSummary 标成 volatile，但它仍属于完整 system 字符串。
- `packages/harness/src/context-candidates.ts:65` 只移出三类 guidance；不会自动移出摘要、初始记忆和 bootstrap。
- `splitSystemPromptForCache` 当前没有生产调用方，只有定义与测试；`CACHE_BOUNDARY_MARKER` 是本地文本标记，不是发给供应商的缓存控制指令。

因此摘要更新会改变历史之前的请求内容，已有历史不能继续完整匹配旧前缀。压缩边界允许有意重建上下文；需要消除的是边界不明确、重建方式不一致和非压缩场景的隐式前插。

### 2. 同一工具循环的尾部被重新搬动

`tool-loop.ts:108–130` 每轮从原始 messages 构建请求；`model-observability.ts:435–453` 临时追加记忆释放、KnownState 和运行状态，准备后的注入不进入原始消息序列。`context-candidates.ts:189` 还会把检索约定重放在新尾部。

离线实际输出的排列为：

```text
请求 1：固定提示，运行事实，用户输入，检索约定，记忆/运行状态
请求 2：固定提示，运行事实，用户输入，工具调用 1，结果 1，检索约定，记忆/运行状态
请求 3：固定提示，运行事实，用户输入，工具调用 1，结果 1，工具调用 2，结果 2，检索约定，记忆/运行状态
```

每轮尾部移到新位置，旧请求不是新请求的完整前缀。分歧前内容仍然稳定；不能据此说整个缓存失效，也不能说 system 消息数量持续膨胀。

| 合成夹具场景 | 每轮 system 块数 | 每轮 system 字符 | 分歧后重复的相同 system 字符 |
| --- | ---: | ---: | ---: |
| 仅检索约定 | 3 | 361 | 112 |
| 检索约定 + 释放说明 + 运行状态 | 5 | 719 | 470 |
| 检索约定 + 12 条 KnownState 引用 | 4 | 7,091 | 6,842 |

这是三轮离线调用当前源代码的字符量，不是生产 token 浪费量或真实命中率。KnownState 重发包含更新时间、引用元数据与固定规则，说明其精简空间值得单独处理。

### 3. 仍有额外请求形状与工具集合切换

- 能力回复使用 respond 提示、澄清使用 ASK_USER 提示、压缩使用独立 JSON 摘要提示；它们和 execute 的内容及工具集合不同。不同用途并不意味着之前的缓存必然被供应商清除。
- 主循环已生成并校验的 `request_user_input.prompt`，在 `execute/runners.ts:58–72` 又跳到 ASK_USER，随后再次请求模型措辞。
- `retrieval-intent.ts:36–53` 按本轮检索意图筛选 Web 工具；`execute/runners.ts:28–40` 的显式工具集合还能覆盖常规集合。主循环的工具定义尚未在整个会话区间内固定。
- 所有用途都经过 `injectRuntimeAwareness`；压缩也收到工具、网络、权限等能力播报。这些内容不是压缩摘要所必需的输入。
- 强制收尾时保留 tools、仅设置 `tool_choice:'none'` 已经实现，不列为待修复缺陷。

### 4. 测试与归因存在缺口

- `execute.test.ts:545–555` 中名为“strict extension”的测试先剔除尾部 system 再比较。因此该测试当前通过，也不能证明完整请求只追加。
- `cache-observability.ts:172` 将 requestKind 纳入本地指纹；`packages/llm/src/client.ts:118–130` 的实际请求体不含该字段。本地用途标签改变不能独立证明供应商前缀改变。
- `docs/reference/cache-95-acceptance.md` 中存在历史结论、更正与最新读数并存的情况。当前未提交的压缩提示修复与其证据必须保留，不能把旧读数冒充本轮验证。

参考：[DeepSeek 当前缓存说明](https://api-docs.deepseek.com/guides/kv_cache/) 要求匹配已持久化的前缀单元。公共前缀稳定是必要工程条件，具体命中还受供应商缓存状态影响；离线长度比较不替代真实 usage。

## 二、按顺序执行的任务清单

### SP-01：先补完整请求的回归检查（P0）

- [x] 将本轮三种复现场景纳入正式测试，比较模型客户端真正收到的 messages 与工具定义，禁止跳过尾部 system。
- [x] 覆盖至少三轮工具循环、无变化的运行状态、记忆展开→释放→再次展开、连续用户回合与重启续接。
- [x] 增加压缩区间边界用例：区间内必须保持既有消息不变；区间切换允许一次明确重建，并记录原因。

入口：`stages/execute.test.ts`、`context-candidates.test.ts`、`memory-context-working-set.test.ts`、Runtime 注入相关测试。
验收：测试必须在当前问题路径上失败，在修复后通过；原有工具调用/结果配对、权限和取消测试继续有效。

**2026-09-21 执行记录（SP-01 完成，并顺带落地 SP-03 的核心不变量）：**

- 新增 `packages/harness/src/request-prefix-append-only.test.ts`（7 项）：比较模型客户端**真正收到**的完整 `messages` 与 `tools`，不做任何尾部剔除。首轮在真实缺陷上失败（`request 1 -> 2: message 4 (system) was rewritten`），修复后通过。
- 新增 `packages/harness/src/run-tail-ledger.test.ts`（4 项）：直接锁定 ledger 语义——同一事实只发一次、变化追加为新条目、A→B→A 产生两条独立记录、prompt 中标记为 tail 的段落参与而稳定段落不参与。
- **实测根因（与清单第 2 节的推断一致，并补充一个此前未记录的关键点）：** 尾部不只是"每轮重新搬动"，首轮的尾部位置本身就在**第一轮工具调用之前**。离线复现排列为 `…用户输入, 检索约定, 记忆/运行状态, 工具调用 1, 结果 1`，因此第二轮请求的第 4 条消息被工具调用占用，前缀在历史之后立即断裂。修复办法不是"把尾部挪到最后"，而是**让尾部在首轮就落在它此后不再改变的位置**（用户输入之后），后续工具轮追加在它之后。
- 关键实现：
  - 新增 `packages/harness/src/run-tail-ledger.ts`：尾部条目按「语义 id + 内容哈希」记账，只追加、不重写；渲染复用既有 `renderRuntimeFacts` / `renderVolatileRunState` / `renderKnownStateText` / `memoryReleaseNoteText`，未复制第二份规则。
  - `context-candidates.ts` 新增 `trailingOwnership: 'caller'` 与 `tailMessages`：前者阻止调用方已拥有的尾部被再次射出，后者让尾部消息保留 `runtime_event` Context 种类；系统候选现在始终携带 source-aware segments，解决"调用方自带 system 文本 → 契约找不到 `system_prompt` 种类"的既有隐患。
  - `model-observability.ts` 新增 `skipRuntimeTail`：主循环自己拥有追加式尾部时，请求记录器不再逐轮重新注入并重新定位。
  - `prompt/builder.ts` + `profile-prompt.ts` + `execute/prompt.ts`：`retrieval-intent-contract` 标记 `placement: 'trailing'`，由尾部所有者发射一次。
- 验收证据：`request-prefix-append-only`（7）、`run-tail-ledger`（4）、`stages/execute`（40）、`context-candidates`（5）全绿；`packages/harness` + `packages/context` + `packages/prompt` 共 606 项通过；连带 `packages/runner` 共 960 项通过。全仓库 `vitest run`：3110 通过，仅 2 项既有失败（`scripts/measure-verification-baseline.test.mjs`、`scripts/verify-web-live-llm-evidence.test.mjs`），已在干净工作树上复现确认为既有问题，与本轮改动无关。
- 追认：`model-request-characterization.test.ts` 的基底顺序断言按新契约更新（主循环尾部在对话之后；单请求阶段如 REPLY 仍是紧随 system 的稳定事实块）。

### SP-02：收敛主循环提示组装入口（P0，依赖 SP-01）

- [x] 主循环只保留一个精简的固定规则提示；清除已经无效的阶段说明、TaskBook 步骤规则与重复能力介绍，删除无调用方的 split/helper，而非继续增加另一套 builder。
- [x] 由一个入口负责固定规则、会话区间基线和追加事件的顺序。消除 `text/stableText/trailingSegments` 在调用方使用不一致的问题。
- [ ] SOUL/USER/工作区约定按配置版本进入区间基线；摘要只在明确压缩切换时替换；初始检索事实、根索引变化和任务约束以有界事件处理，不能在普通续接时悄悄改写旧头部。
- [ ] 配置或权限变化必须立即体现，必要时开启新区间；不能为了缓存冻结已经失效的授权或记忆事实。

入口：`prompt/builder.ts`、`profile-prompt.ts`、`execute/prompt.ts`、`execute/runners.ts`、`context-candidates.ts`。
验收：同一区间聊天与工具轮的固定提示相同；摘要不会在非压缩路径被前插或更新；旧阶段规则与无用入口有实际净删除。

**2026-09-21 SP-02 执行记录（三条验收中两条达成，第四条仍缺）：**

- **实测（改前）：** 同一份上下文下，EXECUTE 的固定提示 5,208 字节、REPLY 3,297 字节，**第 324 字节即分歧**——也就是只有 identity 一行共享。根因是两个只在单一模式生效的分支：`coreFlowSection(stage)` 会给 REPLY 渲染 "This run is at the REPLY stage" 变体，`memoryAwarenessSection` 给 REPLY 渲染另一段记忆索引说明；此外 `appendSystemPromptBundleAddons` 不重算 `stableText`/`trailingSegments`，于是 REPLY 发"整份提示"作 system、EXECUTE 发"稳定半份"，两条路径的字节布局从根上就不一致。
- **改后：** 共享前缀 **324 → 3,369 字节**，且分歧点**恰好落在 `<!-- LITTLESHEEP_CACHE_BOUNDARY -->` 标记处**——即压缩边界，也就是两种模式"应该"分歧的唯一位置（`shared-fixed-prompt.test.ts` 断言共享段 ≥3,300 字节且必须在标记处切开，同时断言稳定半份里不再出现 `This run is at the`）。
- **收敛为一份的段落：** `coreFlowSection()` 去掉 stage 参数与 `CORE_FLOW_STAGE_BULLETS`；`memoryAwarenessSection` 删除，两种模式统一用 `memoryTreeSection`（并在共享段内恢复 2,400 字符上限——合并后 REPLY 一度失去截断，`reply.test.ts` 的 12k 守卫抓住了这个真实回退）。
- **净删除（实际删除，不是新增一层）：** 删除 `packages/prompt/src/shared-head.ts` 与其测试（`buildSharedPromptHead`/`sharedPromptHeadPrefixLength` 全仓库无生产调用方）；删除 `CORE_FLOW_STAGE_BULLETS`、`renderStagedCoreFlow`、`memoryAwarenessSection`；`PromptInput.coreFlowStage` / `RuntimeFacts.coreFlowStage` 从 API 与 `reply.ts` 调用处移除。
- **`text`/`stableText`/`trailingSegments` 不一致已修：** `rebuildBundle` 现在重算这三个字段；EXECUTE 与 REPLY 都改用 `systemPrompt.stableText ?? systemPrompt.text` 作为 system 消息。连带修掉一个既有隐患：`buildRunRequestCandidates` 现在按段落 id 去重，调用方重复提供同一段落不再触发 `Duplicate context candidate id` 契约失败。
- [x] 同一区间聊天与工具轮的固定提示相同（稳定半份逐字节相同）。
- [ ] 摘要不会在非压缩路径被前插或更新：`sessionSummary` / `bootstrap` / `initialMemoryContext` 仍在 history 之前（`prompt/builder.ts` 的下边界段落），本轮未移动。下一次压缩边界才会替换摘要，run 内不会变，但"区间的显式边界"仍未表达。
- [ ] 旧阶段规则与无用入口的净删除：已删除上列四项；`guidance.ts` 的 `renderStepGuidance`（TaskBook 步骤执行器已随第二执行体系删除，现仅测试引用）与 `taskbook-skill.ts` 的引用链尚未处理，留待与 SP-05 一起判定。
- [ ] 配置或权限变化开启新区间：未处理。

### SP-03：让最终发送消息成为可续接的序列（P0，依赖 SP-02）

- [ ] 工具循环续接基于上一轮已发送的规范消息及新增模型/工具结果，避免每次从原始数组重新搬动尾部注入。
- [ ] 检索约定只在建立任务约束或约束变化时追加；无变化的 Runtime 状态、释放说明和记忆状态不再次发送。
- [ ] 增量事件按状态变更记录，不能用全会话文案去重：A→B→A 仍是有效变化；释放后重新展开的记忆必须恢复其正确状态。
- [ ] 复用现有持久会话和检查点边界，保存必要的消息/事件位置；重启不能再次注入已记录内容，也不能重复执行副作用。
- [ ] Context 裁剪不得隐式重排已发送前缀；超预算由明确压缩或可见失败处理。网页、工具和记忆正文保持原有不可信来源标记，不因移动消息而提升为指令。

入口：`execute/tool-loop.ts`、`model-observability.ts`、`context-candidates.ts`、`memory-context-working-set.ts`、相关 session/continuity 存储边界。
验收：正常未压缩轮次的完整旧 messages 是新请求的前缀；不靠排除尾部通过检查；取消、释放、再次展开和恢复语义正确。

**2026-09-21 部分进展（未完成）：** 前四条已落地并由 `request-prefix-append-only.test.ts` 与 `run-tail-ledger.test.ts` 锁定：

- [x] 工具循环续接基于上一轮已发送的规范消息及新增模型/工具结果，不再每轮从原始数组重新搬动尾部注入（尾部由 `RunTailLedger` 记账，`skipRuntimeTail` 关闭记录器自身的再注入）。
- [x] 检索约定只在建立时追加一次；无变化的 Runtime 状态、释放说明与 KnownState 不再次发送（单元测试直接断言第二轮 delta 为空）。
- [x] 增量事件按状态变更记录：A→B→A 产生两条独立条目；释放后重新展开会追加新的权威说明而不会重写旧消息。
- [ ] 持久会话/检查点边界的位置保存与重启去重尚未处理（当前仍依赖 `ctx` 内存态与既有检查点语义）。
- [ ] Context 裁剪重排前缀的防护尚未处理（超预算仍走既有 evict 路径）。

### SP-04：删除或缩小重复状态内容（P1，与 SP-03 一起落地）

- [x] 审查 KnownState 中每个字段是否影响模型当前判断。引用审计、计数、更新时间等优先留在 Runtime，不把完整内部状态变成每次请求的提示。
- [x] 模型确实需要的采用/排除/冲突/过期和引用事实只发送最小变化；已在工具结果中明确表达的事实不再全文复制。
- [x] 固定解释规则只在 SP-02 的稳定提示中出现一次；运行耗时和 UI 状态由 Runtime 展示，按需才提供给模型。

入口：`memory-known-state.ts`、`runtime-awareness.ts`、`memory-context-working-set.ts`。
验收：相同状态连续两轮不增加重复状态字符；完整审计仍可追溯；已释放、冲突或过期证据不因精简被误当成有效依据。收益同时报告输入字符/token 与实际 usage，不预填节省百分比。

**2026-09-21 SP-04 执行记录（完成，收益只报字符）：**

- **实测（改前）：** 每个 KnownState 条目里重复 659 字节的 `KnownState rules` 规则块；条目在引用变化时整体重发，所以每次记忆工具轮都要再付一次这块规则。另有审计与排序簿记（`revision`/`updated_at`/`references 计数`/`firstSeenAt`/`reactivatedCount`/`stages`/`usefulness`/`task`/`routing`/`relation`/`activation`）在"模型读到的内容没变"的轮次也会变，一变就整块重发。
- **字段审查结论（按"是否影响当前判断"分类）：** 保留 decision / disclosure / branch / scope / tier / parent / statement / epistemic / authority / confidence / importance / retrievalPath / relationRoute / conflict / expired / truncated / matchReason / decisionReason / sources / evidence；其余留在 Runtime。**投影改为显式白名单构建**，因此以后给契约加字段不会静默漏进提示词。
- **规则只出现一次：** 新增 `knownStateRulesSection()`，作为尾部自己的稳定槽位（`memory-known-state-rules`）发送一次；单请求注入路径（`injectMemoryKnownState`）没有区间槽位，仍在条目内联。
- **实测收益（仅字符，未涉及供应商 usage，也未折算 token 或成本）：** 单条引用 **1,295 → 1,080** 字符；12 条引用 **6,634 → 5,020**，即 **503 → 368 字符/引用（-27%）**。此外"只改 revision"一类轮次现在**完全不重发**（改前必重发）。
- **验收证据（`known-state-projection.test.ts`，4 项）：** 规则只出现一次且差价 >600 字节；revision 跳变 / 时间戳移动 / reactivated 自增 / stages 变化后字节完全相同；decision 或 evidence 变化仍会重发并带上新理由；保留字段逐一断言存在、丢弃字段逐一断言不存在；conflict/expired 为真时才显式声明（改前是恒定的 `false` 噪声）。
- **未处理：** `runtime-awareness.ts` 的运行耗时/UI 状态本就不注入（已核对，保持原样）；"完整审计仍可追溯"由 `ctx.memoryKnownState` 与 Context 快照继续承载，未删字段。

### SP-05：固定主循环最小工具目录（P1，依赖 SP-02）

- [x] 删除确实不需要的工具后，在一个会话区间内固定工具名、schema 和顺序。
- [x] 将每轮意图和显式工具指令转为执行范围约束；若改变现有模型可见性筛选，必须同时在实际调用处保留等价限制，不能只删除筛选。
- [x] Web 开关、来源校验、审批、具体 URL 范围和宿主安全检查继续生效；工具注册/模型配置确实变化时记录一次新区间。

入口：`retrieval-intent.ts`、`execute/runners.ts`、工具执行服务与请求契约。
验收：本地→Web→本地的主循环 schema 稳定；关闭网络、错误来源、越权工具和超出显式范围的请求仍被拒绝。能力回复与压缩无须为形式统一附带整套工具。

**2026-09-21 SP-05 执行记录（完成）：**

- **实测（改前）：** 工具目录随每轮措辞变化——`toolsForRetrievalIntent` 把 Web 工具从**模型可见目录**里增删，所以 `本地 → Web → 本地` 三轮产生三份不同的 schema，每次意图变化都让会话缓存前缀失效。
- **改法（可见性与执行范围分离）：** 模型看到的是注册目录（`ctx.tools`，按名排序后顺序固定）；每轮意图只决定**这一轮能执行什么**（`admittedTools`）。新增执行边界：`ToolLoopOptions.admittedTools` + `withheldToolContract`，被扣留工具的调用在到达工具之前被拒绝并返回 `ok: false` 的权威拒绝（含意图契约文本），不执行、不尝试副作用。
- **拒绝语义与未知工具区分开：** 只有"已注册但本轮被扣留"才走 `Runtime scope:` 拒绝；未注册的名字仍由执行边界报 `unknown tool`（`execute.test.ts` 的两条既有用例正是在守这条边界，本轮实现后它们仍然通过）。
- **验收证据（`tool-catalog-stability.test.ts`，9 项）：** 四种不同意图的目录字节完全相同（且意图集合确实不止一种）；local 轮的 `web_search` 可见但被 `Runtime scope` 拒绝且 `tool.calls` 为空；同一 local 轮的 `read` 正常执行（扣留 Web 不缩小其余范围）；网络关闭时 Web 调用仍被拒且拒绝原因是 `network retrieval is disabled`（不是 scope）；能力回复与压缩不附带整套工具这一点未变（它们本就不走主循环目录）。
- 净删除：`runDirectToolProposal`（DECIDE 提案执行入口，DECIDE 已删除，全仓库无调用方）；提示中的能力摘要改为渲染注册目录，不再随意图变化。

### SP-06：删除澄清的重复模型调用及修复请求变形（P1）

- [x] 主循环通过 schema 校验的模型提问直接按既有 settlement 与来源校验发布，删除 ASK_USER 二次措辞请求。
- [x] Runtime 恢复升级且没有模型问题文案时才生成一次用户说明；空输出或无来源时显示 Runtime 错误，删除 `ask_user.ts` 的固定文案伪装 Agent 回复兜底。
- [ ] 连续性纠正不再改写首条 system、抛弃原请求形状；仍必要的纠正作为有界反馈在原循环追加，并使用原工具目录及受控 `tool_choice`。能力回复保留现有最小事实契约。

入口：`execute/runners.ts`、`stages/ask_user.ts`、`reply/continuity-repair.ts`、`user-facing-reply.ts`。
验收：一次模型提问不再产生第二次模型请求；长会话、重启和并发发布仍防止同一 settlement 重发；缺失来源/空输出不能伪装成模型回复；历史连续性验收继续有效。

**2026-09-21 SP-06 执行记录（前两条完成，第三条未做）：**

- **改前：** 模型经 `request_user_input` 提问后，请求被路由到 ASK_USER，ASK_USER 再发**第二次** Provider 请求把同一个问题重新措辞一遍。模型提问本身就是 user-facing 文本，且已经有 Provider 请求作为来源。
- **改法：** `ClarificationRequest` 新增 `copyModelRequestId`，把「这句措辞是谁写的」从 execute 一路带到发布阶段；主循环的 `userInputRequest` 返回此前**丢掉了 `modelRequestId`**（所以引用无据可依），现已补上。`createReplyProvenance` 支持按请求 id 精确锁定来源（未给出 id 时才退回按 purpose 匹配），并校验该 purpose 确实有权署名 user-facing 文本。ASK_USER 现在分两条路：模型已提问 → 原样发布（Provider 调用数 0）；Runtime 升级 → 仍只发一次措辞请求。
- **删除伪装兜底：** `composeClarificationMessage` 原本在模型两次都无可见文本时返回 Runtime 草稿，stage 再把这个草稿当模型回复发布。现在它返回空、stage 明确失败：没有模型措辞的回合显示 Runtime 错误，而不是把固定文案挂在 Agent 名下。草稿本身仍是 Runtime 事实（请求自带的 `blockingReason` 与问题文本），UI 可按状态展示。
- **验收证据（`clarification-single-call.test.ts`，4 项）：** 模型提问路径 `llm.chat` **未被调用**且 provenance 指向 `request-that-asked`、`rewriteCount=0`；升级路径恰好 1 次调用且 `purpose='ask_user'`；两次空响应 → `ok: false`、无 `reply`、无 `replyProvenance`、`lastError.stage='ask_user'`；execute 路由写入的 `copyModelRequestId` 确实存在于 `modelRequests` 记录中。
- **未做：** 第三条（连续性纠正不再改写首条 system、改为在原循环追加有界反馈并使用原工具目录与受控 `tool_choice`）本轮未动。

**2026-09-21 SP-06 第三条执行记录（部分完成，剩余缺口已断言）：**

- **实测（改前）：** 纠正请求（1）把 `Continuity correction contract` 追加进 **system 提示词**，所以第一条消息就不同；（2）走 `reply` 调用契约，而该契约 `toolMode: 'none'`，所以**工具目录为 0**（草稿请求有 1 个工具）；（3）重建消息数组，丢掉主循环的尾部位置。
- **改法：** `repairDiscontinuousReply` 改为接收**请求形状**（purpose / 逐字消息 / 工具目录 / 采样参数），把纠正作为**追加的有界反馈**（草稿 + 一条契约消息）而非重写 system；工具目录保留并用 `tool_choice: 'none'` 禁止调用（与强制收尾同一手法）。工具循环现在回传它实际发出的消息与目录（`requestMessages` / `requestTools` / `requestTailMessages`），两条调用方各自传入自己的请求。`buildRunRequestCandidates` 新增 `primaryUserIndex`，让"在已装配请求后追加"的调用方把追加的那条标为本轮用户输入。`SystemPromptBundle` 新增 `stableSegments`（此前只有 `stableText` 与 `trailingSegments`）。
- **已完成并可验证（`continuity-correction-prefix.test.ts`，6 项）：** 纠正不再改写 system 提示词；工具目录与草稿请求**逐字节相同**且 `tool_choice='none'`；所有对话消息保持原顺序；已连续的回复不发纠正请求；对话路径行为一致。
- **剩余缺口（已用断言钉住，不会静默漂移）：** 纠正请求的**首条 system 消息仍与草稿请求不一致**——请求记录器会按提示词的分段列表重新装配 system，而不是复用被扩展的那条请求；实测草稿 4,058 字符、纠正 2,323 字符（纠正丢掉的是主循环作为尾部单独发送的边界以下段落）。因此纠正的复用上限仍被钉在该字节处。
- **顺带修正的一处真实语义漂移：** 修 `stableSegments` 过程中发现，把**整份** `segments` 交给装配器会让它用**边界以下**的段落重建 system 消息，等于把这些段落悄悄移到边界之上。`stableSegments` 让调用方能只交出一半。本轮**未**改 execute 路径的这一处（改动会连带把 bootstrap/指令从 system 消息移到尾部，超出本项范围），已在代码注释中记录。

### SP-07：压缩只携带必要输入（P1）

- [x] 保留当前摘要长度及 branch/scope 契约修复，移除压缩请求无关的能力快照、检索规则和主循环状态注入。
- [x] 保留最小专用摘要契约、真实待压缩消息、必须保真的目标/决定/产物与引用。压缩仍是当前唯一持久记忆写入方，不能在此次精简中误删该能力。
- [ ] 明确摘要安装与消息截断为一次原子区间切换；失败继续使用旧的有效摘要，所有失败与重试计入成本。不要在本任务中顺带改变冻结基准的压缩频率。

入口：`runner/session-continuity.ts`、`model-observability.ts`、`runtime-awareness.ts`、压缩操作存储与恢复测试。
验收：压缩请求无无关播报；合法记忆候选与摘要保真通过；中断/失败不丢失旧摘要和未完成目标；保留已有未提交修复及其回归测试。

**2026-09-21 SP-07 执行记录（前两条完成，第三条未做）：**

- **实测（改前）：** 压缩请求经 `prepareModelRequest` 走通用注入，实测形状为 `ssu`：系统摘要契约 + 中间夹入的 `# Runtime Facts`（能力快照、权限、工作区、网络、注册工具）+ 用户载荷。按字节：**355 字节的 Runtime 事实块对 32 字节的待压缩内容**——无关播报是被压缩内容的 11 倍，而且两次尝试每次都重付。
- **改法：** 压缩调用传 `skipRuntimeTail: true`，请求记录器不再注入 Runtime 尾部。记忆片段注入本就未生效（`session_compaction` 调用契约不允许 `memory_fragment` 这种 Context 种类），所以这次是关掉剩余的注入，而不是开一个新的豁免。
- **刻意不动：** 摘要长度上限（1200 字符）与 branch/scope 配对规则（既有 `session-compaction-prompt.test.ts` 正在守）、1800/2200 token 预算、尝试次数、压缩频率。压缩仍是唯一的持久记忆写入方。
- **验收证据（`session-compaction-input.test.ts`，3 项）：** 源码级断言压缩请求被标记为 summary-only；摘要契约与保真优先级仍在；真实 runner 运行中，摘要请求只带提示词与转录，**不含** `# Runtime Facts` / 检索契约 / `# Runtime State` / `capability_epoch` / `permission_policy`，同时该 run 仍正常发布摘要（`metadata.compaction.summary` 正确）。
- **未做：** 第三条（摘要安装与消息截断作为一次原子区间切换的显式化；失败继续使用旧摘要并把所有失败与重试计入成本）。现有实现已有"scheduler 单飞 + 失败保留旧摘要"的行为，但区间切换的原子性未被显式断言。

### SP-08：按真实请求和成本验收（P0 建立基线，最后收口）

- [x] 先在同一代码/构建与冻结负载下保存旧实现基线，再做修复后对比。基线记录版本、模型、调用用途、轮数、工具集合、压缩配置和 usage 完整性。
- [x] 将本地 stage/requestKind 指纹变化与实际 messages/tools 变化分开报告；缓存边界标记不能当作供应商命中证据。
- [ ] 修正验收文档中过时汇总与未经证实的因果归因；正文保存有界脱敏汇总，原始提示、会话和密钥不进入仓库。
- [ ] 两组冻结负载均报告总体及冷启动/连续工具/压缩/澄清等分项，包含全部辅助请求、失败和重试。公式固定为缓存输入 token 总和 ÷ 输入 token 总和，usage 缺失不得按零补齐。
- [ ] 同时报告每任务未缓存输入、总输入/输出、请求数、任务时延、失败与正确性。禁止增加无用上下文或重试来抬高比例。

验收：保留范围的任务正确性通过；两组完整总体命中率均 >=95% 才标记缓存目标达成。否则分别记录“结构修复完成”“精简收益”和实际未达差距，不改小目标或挑选热缓存子集。

**2026-09-21 SP-08 执行记录（基线已建立并完成两组冻结负载对比；第 3–5 条未做）：**

- **基线已补齐（此前错位，本轮补做）：** 新增 `packages/harness/src/probe/frozen-load.ts` + `baseline.test.ts`。探针用**脚本化模型**跑冻结负载，逐请求记录：请求字符数、与前一条请求的**共享前缀字符数与占比**、缓存边界以上的**稳定头字节数**、以及**工具目录名与 schema 摘要**。全程**不调用供应商**。
- **对比方式：** 把同一探针原样复制进 `git worktree`（`cd6cabc`，本工作开始前的提交）运行，产出 `docs/taskbooks/cache-baseline/pre-fix-cd6cabc.md`；当前实现产出 `baseline-git-0af62a7.md`。两者模型名、工具集合、压缩配置、负载完全相同。对比分析见 `docs/taskbooks/cache-baseline/README.md`。
- **实测（结构，字符数）：**

  | 指标 | 改前 | 改后 |
  | --- | ---: | ---: |
  | 负载 A（本地→Web→本地）每轮可复用前缀 | 2311 | **5585** |
  | 负载 A 出现的不同工具目录数 | 3 | **1** |
  | 负载 B（四轮工具循环）复用比 | 0.93（每轮在 438 字符处分歧） | **1.000**（首处分歧即新追加内容） |
  | 负载 C 聊天/工具共享前缀 | 360（仅 identity） | **3591** |
  | 负载 C 聊天路径稳定头 | 1916 | **3446** |
  | 压缩请求的 Runtime 事实块 | 355 字符 | **0** |

- **成本如实记录（不是净收益）：** 固定工具目录让负载 A/B 的每个请求**增大约 700 字符**（Web schema 现在始终附带）。这是 SP-05 要求的取舍，是否划算取决于真实长会话能回收多少轮间前缀字节，只有真实会话能量。
- **第 2 条已达成的方式：** 本地 `stablePrefix`/requestKind 指纹与实际 `messages`/`tools` 的变化在报告里是分开的——探针只看真实请求体与工具定义；缓存边界标记只用来量出稳定头，**不作为任何命中证据**。
- **第 3–5 条未做：** 未修正 `docs/reference/cache-95-acceptance.md` 的过时汇总与因果归因；未做两组冻结负载的总体/分项命中率（需真实供应商）；未报告每任务未缓存输入、总输入输出、请求数、时延、失败与正确性。
- **按验收口径的结论：** 记录为**「结构修复完成」＋「精简收益（字符级，见上表）」**；**真实总体命中率仍未知**，因此**不标记缓存目标达成**。未改小目标，未挑选热缓存子集。

## 三、本轮验证与交付边界

- 已运行现有 `execute.test.ts` 的 strict-extension 定向测试：1 项通过，39 项未运行；已确认该测试忽略尾部的覆盖缺口。
- 已通过当前源码的离线请求复现，覆盖表中三个合成场景；没有调用真实供应商，也没有据此宣称真实缓存收益。
- 临时复现脚本、Vitest 配置及三份脱敏合成结果位于 `C:\Users\28971\AppData\Local\Temp\ls-prompt-audit-407f44f12a904771b039ab47a6b5089a`；临时目录可被系统清理，正式落地先完成 SP-01。
- 本轮仅新增本清单。工作树原有的 cache-observability、session-continuity、压缩提示测试和验收文档改动均保持原样。

建议首个实现批次：SP-01 + SP-02 + SP-03 + SP-04；先解决实际消息生命周期与重复注入，再进行工具目录和额外调用精简。SP-08 的基线应在实现改动前建立。

## 四、2026-09-21 SP-01 实现轮的验证边界（据实记录）

- 本轮**只做结构修复与离线验证**：全部证据来自 Vitest 中的 mock Provider 与单元级断言，**没有调用真实供应商，也没有测量真实缓存命中率**。因此本轮**不能**声称 95% 目标已达成，SP-08 的基线仍未建立（按清单要求在实现改动前建立，现已错位，需在下一轮以 `git` 历史中的旧实现补测）。
- 已验证的是**必要条件**：正常未压缩轮次的完整请求（含 tools 与尾部）满足"旧请求是新请求的严格前缀"。
- **未验证**的部分：真实 Provider 的缓存单元匹配行为、压缩区间切换时的重建、取消/重启后的位置恢复、跨轮（同一会话的多个 run）的连续性。清单第 2 节离线表中的字符量结论未被本轮推翻，也未据此推算 token 节省。
- 还原历史行为的方式：本轮改动集中在 `run-tail-ledger.ts`（新增）、`context-candidates.ts`、`model-observability.ts`、`tool-loop.ts`、`execute/prompt.ts`、`profile-prompt.ts`、`prompt/builder.ts`、`context-engine/contracts.ts`；`git stash` 一次即可回到旧实现的请求形状，可用于 SP-08 的对照测量。
