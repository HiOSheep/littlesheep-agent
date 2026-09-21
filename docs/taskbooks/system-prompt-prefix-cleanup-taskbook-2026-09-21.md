# 系统提示词与请求前缀精简任务清单 · 2026-09-21

最后更新：2026-09-22 02:32:00

日期：2026-09-21。
状态：SP-01～SP-07 已全部实现并有回归证据；SP-08 已建立结构基线与真实 Provider 读数。**唯一未执行项**是 SP-08 第 3 条中"修正验收文档过时汇总"这半边——`docs/reference/cache-95-acceptance.md` 在本任务期间有作者本人的在途改动，作者要求不要动该文件（见 SP-08 记录）；该条的"有界脱敏、原始内容不入库"半边已用扫描验证。**缓存 95% 目标未达成**，三组真实负载读数见 SP-08 记录。
目标：减少长任务中不必要的模型输入和请求前缀变化，继续以真实总体缓存命中率 >=95% 为验收目标；本清单不承诺仅完成这些改动就必然达标。

## 一、查明的问题（本节的四条问题均已由第二节对应条目处理；本节保留为当时的诊断记录）

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
- [x] SOUL/USER/工作区约定按配置版本进入区间基线；摘要只在明确压缩切换时替换；初始检索事实、根索引变化和任务约束以有界事件处理，不能在普通续接时悄悄改写旧头部。
- [x] 配置或权限变化必须立即体现，必要时开启新区间；不能为了缓存冻结已经失效的授权或记忆事实。

入口：`prompt/builder.ts`、`profile-prompt.ts`、`execute/prompt.ts`、`execute/runners.ts`、`context-candidates.ts`。
验收：同一区间聊天与工具轮的固定提示相同；摘要不会在非压缩路径被前插或更新；旧阶段规则与无用入口有实际净删除。

**2026-09-21 SP-02 执行记录（三条验收中两条达成，第四条仍缺）：**

- **实测（改前）：** 同一份上下文下，EXECUTE 的固定提示 5,208 字节、REPLY 3,297 字节，**第 324 字节即分歧**——也就是只有 identity 一行共享。根因是两个只在单一模式生效的分支：`coreFlowSection(stage)` 会给 REPLY 渲染 "This run is at the REPLY stage" 变体，`memoryAwarenessSection` 给 REPLY 渲染另一段记忆索引说明；此外 `appendSystemPromptBundleAddons` 不重算 `stableText`/`trailingSegments`，于是 REPLY 发"整份提示"作 system、EXECUTE 发"稳定半份"，两条路径的字节布局从根上就不一致。
- **改后：** 共享前缀 **324 → 3,369 字节**，且分歧点**恰好落在 `<!-- LITTLESHEEP_CACHE_BOUNDARY -->` 标记处**——即压缩边界，也就是两种模式"应该"分歧的唯一位置（`shared-fixed-prompt.test.ts` 断言共享段 ≥3,300 字节且必须在标记处切开，同时断言稳定半份里不再出现 `This run is at the`）。
- **收敛为一份的段落：** `coreFlowSection()` 去掉 stage 参数与 `CORE_FLOW_STAGE_BULLETS`；`memoryAwarenessSection` 删除，两种模式统一用 `memoryTreeSection`（并在共享段内恢复 2,400 字符上限——合并后 REPLY 一度失去截断，`reply.test.ts` 的 12k 守卫抓住了这个真实回退）。
- **净删除（实际删除，不是新增一层）：** 删除 `packages/prompt/src/shared-head.ts` 与其测试（`buildSharedPromptHead`/`sharedPromptHeadPrefixLength` 全仓库无生产调用方）；删除 `CORE_FLOW_STAGE_BULLETS`、`renderStagedCoreFlow`、`memoryAwarenessSection`；`PromptInput.coreFlowStage` / `RuntimeFacts.coreFlowStage` 从 API 与 `reply.ts` 调用处移除。
- **`text`/`stableText`/`trailingSegments` 不一致已修：** `rebuildBundle` 现在重算这三个字段；EXECUTE 与 REPLY 都改用 `systemPrompt.stableText ?? systemPrompt.text` 作为 system 消息。连带修掉一个既有隐患：`buildRunRequestCandidates` 现在按段落 id 去重，调用方重复提供同一段落不再触发 `Duplicate context candidate id` 契约失败。
- [x] 同一区间聊天与工具轮的固定提示相同（稳定半份逐字节相同）。
- [x] 摘要不会在非压缩路径被前插或更新（`interval-baseline.test.ts`，见下）。
- [x] 旧阶段规则与无用入口的净删除：已删除上列四项，另加第 11 轮删除的整份 `segments` 装配路径（system 消息不再由边界以下段落重建）。
- [x] 配置或权限变化开启新区间（`interval-baseline.test.ts`，见下）。

**2026-09-21 第 12 轮（SP-02 第三条与第四条已补齐验收）：**

新增 `packages/harness/src/interval-baseline.test.ts`（4 项），把此前只有设计意图、没有断言的区间语义钉住：

- **摘要与 bootstrap 在区间内逐字节稳定：** 四轮工具循环中，`# Session Summary` 与 `# Project Context`（含 USER.md）消息的字节与位置完全不变；两次共享同一上下文的用户回合之间同样不变。
- **只有压缩给出新摘要时才重建：** 换一份 `sessionSummary` → 基线消息确实改变，且是以"一次明确重建"的形式改变（整条消息替换），不是逐轮漂移。
- **配置/权限变化不被缓存冻结：** ledger 每次 update 都从活动上下文重新渲染 Runtime 能力事实；把 `permissionPolicyId` 从 `research` 改为 `restricted` 后，新值作为**新追加**的权威事实出现（`unchanged.messages` 为空证明无变化时不重发；改变后旧值不再存在于新条目中，旧条目原样保留）。
- **实现方式：** 这两条不需要新机制——第 11 轮把边界以下段落（含摘要、bootstrap、runtime 段）交给同一个追加式 ledger 之后，它们天然获得"发送一次、变化才追加"的语义；本轮补的是**断言**，把设计意图变成可回归的契约。

**2026-09-21 第 14 轮（SP-02 第 1 条的一处未兑现声明已补齐）：**

- **发现：** 第 1 条声明"删除无调用方的 split/helper"，但 `packages/harness/src/system-prompt-cache-split.ts` 仍然存在，且**只有它自己的测试**引用它（第 17 轮起 `stableText`/`stableSegments`/`trailingSegments` 已由 `@littlesheep/prompt` 的 `buildSystemPromptBundle` 与 `profile-prompt.rebuildBundle` 计算），既无生产调用方，也未被 `harness/index.ts` 导出。也就是说该声明此前**说早了**。
- **本轮处理：** 先把该测试里唯一未被生产路径用例覆盖的断言（"边界以下的段落保留提示词声明的 Context 种类，并按声明顺序排在会话之后"）迁到 `context-candidates.test.ts`（生产装配函数直测），再删除 `system-prompt-cache-split.ts` 与其测试文件。其余断言（system 消息不含边界标记、记忆根索引位于稳定段、边界以下段落各自成消息）已由既有 `shared-fixed-prompt.test.ts`、`request-prefix-append-only.test.ts`、`profile-prompt.test.ts` 在生产路径上覆盖。
- **验证：** `packages/harness/src` 70 个文件 574 项通过；`npx tsc -p packages/harness/tsconfig.json --noEmit` 退出码 0。

### SP-03：让最终发送消息成为可续接的序列（P0，依赖 SP-02）

- [x] 工具循环续接基于上一轮已发送的规范消息及新增模型/工具结果，避免每次从原始数组重新搬动尾部注入。
- [x] 检索约定只在建立任务约束或约束变化时追加；无变化的 Runtime 状态、释放说明和记忆状态不再次发送。
- [x] 增量事件按状态变更记录，不能用全会话文案去重：A→B→A 仍是有效变化；释放后重新展开的记忆必须恢复其正确状态。
- [x] 复用现有持久会话和检查点边界，保存必要的消息/事件位置；重启不能再次注入已记录内容，也不能重复执行副作用。
- [x] Context 裁剪不得隐式重排已发送前缀；超预算由明确压缩或可见失败处理。网页、工具和记忆正文保持原有不可信来源标记，不因移动消息而提升为指令。

入口：`execute/tool-loop.ts`、`model-observability.ts`、`context-candidates.ts`、`memory-context-working-set.ts`、相关 session/continuity 存储边界。
验收：正常未压缩轮次的完整旧 messages 是新请求的前缀；不靠排除尾部通过检查；取消、释放、再次展开和恢复语义正确。

**2026-09-21 SP-03 执行记录（五项完成）：**

- **已完成后三条的既有证据：** 工具循环续接基于上一轮已发送的规范消息与新增结果，尾部由 `RunTailLedger` 记账、`skipRuntimeTail` 关闭记录器自身的再注入（`request-prefix-append-only.test.ts`、`run-tail-ledger.test.ts`）；检索约定只追加一次，无变化的 Runtime 状态/释放说明/KnownState 不重发（单元测试断言第二轮 delta 为空）；A→B→A 产生两条独立条目，重新展开追加新的权威说明而不重写旧消息。
- **裁剪不再重排已发送前缀（本轮）：** 新增 `evictionScope`（`context-engine/budget.ts`、`contracts.ts`）。`appended-only` 下由 **ContextEngine 自己记账**：每次装配后记录该 run+stage 实际送达的单元 id（`deliveredUnitIds`，`eviction.ts`），下一次装配把它们全部保护起来；被保护单元**根本不进入淘汰候选**（`optionalOmissionUnits` 直接过滤），因此不会"先删了再补"。工具循环每轮都声明 `evictionScope: 'appended-only'`（`execute/tool-loop.ts` → `model-observability.ts`），并可另外用 `protectedCandidateIds` 指定自己拥有的单元。
- **保护整个消息，而非只保护消息里的一段：** 受保护消息的所有分段（如 system 消息里的 `date-time` 段落）一并受保护——删掉其中一段同样会重写调用方已经发出的那条消息。
- **复用缓存不再跨保护级别复用：** `contextReuseKey` 现在包含 `evictionScope` 与解析后的受保护 id 集合；否则一次弱保护下的淘汰决定会被强保护请求命中，等于绕过保护。
- **超预算的两种出口都可区分：** 先淘汰本次新增的单元；若已发送部分本身超窗口，抛 `ContextBudgetExceededError`（工具循环转成可见的 `llm call failed: Required context uses …`），即"明确压缩或可见失败"，不再静默改前缀。超出 stage 目标但仍在模型窗口内的请求按原样发送并记录估算值，不裁剪。
- **回归证据（有牙）：** `engine.test.ts` 新增 7 项（新增项被淘汰、旧请求仍是完整前缀 / 已发送部分本身超窗口时报错而非裁剪 / 不选 `appended-only` 时保持旧的裁剪行为 / 显式 `protectedCandidateIds` 生效 / 整条消息的段落一并受保护 / 保护级别不同不复用淘汰决定）；`request-prefix-append-only.test.ts` 新增 1 项端到端用例：历史撑到接近 `execute_tool_loop` 的 24,000 token stage 目标，工具结果把第 2 轮推过目标——**把 `evictionScope` 改回 `unconsumed`，该用例立刻报 `request 1 -> 2: message 0 (system) was rewritten at 1977`**。
- **第 4 项（复用既有边界 + 重启不重放副作用与已记录内容）：** 未新增任何持久化字段，验证的是**既有边界**：新增 `session-restart-continuity.test.ts` 用一个**全新的 runner 实例**（同一数据根、不共享内存）接续既有会话，断言已记录的一轮在请求中**恰好出现一次、顺序不变**（用户问题 → 助手回复 → 新回合），会话文件在重启前后保持 `[user, assistant]` → `[user, assistant, user, assistant]`；副作用一侧由既有 `durable-runner-effect-recovery.test.ts` 覆盖——真实子进程写盘后被 `SIGKILL`，恢复只把该副作用标为 `effect_settlement_unknown`，不重新执行（文件内容仍是第一次写入的值、`llm.chat` 从未被调用、重复恢复为空操作）。**口径：** 消息一侧验证的是"新 runner 实例 + 同一数据根"，不是杀进程后重启；副作用一侧才是真实进程级重启。两者的模型引用都带已注册的精确 tokenizer，否则保守估算会先于重启行为触发预算裁剪，掩盖本项要验证的性质。


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
- [x] 连续性纠正不再改写首条 system、抛弃原请求形状；仍必要的纠正作为有界反馈在原循环追加，并使用原工具目录及受控 `tool_choice`。能力回复保留现有最小事实契约。

入口：`execute/runners.ts`、`stages/ask_user.ts`、`reply/continuity-repair.ts`、`user-facing-reply.ts`。
验收：一次模型提问不再产生第二次模型请求；长会话、重启和并发发布仍防止同一 settlement 重发；缺失来源/空输出不能伪装成模型回复；历史连续性验收继续有效。

**2026-09-21 SP-06 执行记录（前两条完成；第三条当时未做，后由第 9–11 轮补齐）：**

- **改前：** 模型经 `request_user_input` 提问后，请求被路由到 ASK_USER，ASK_USER 再发**第二次** Provider 请求把同一个问题重新措辞一遍。模型提问本身就是 user-facing 文本，且已经有 Provider 请求作为来源。
- **改法：** `ClarificationRequest` 新增 `copyModelRequestId`，把「这句措辞是谁写的」从 execute 一路带到发布阶段；主循环的 `userInputRequest` 返回此前**丢掉了 `modelRequestId`**（所以引用无据可依），现已补上。`createReplyProvenance` 支持按请求 id 精确锁定来源（未给出 id 时才退回按 purpose 匹配），并校验该 purpose 确实有权署名 user-facing 文本。ASK_USER 现在分两条路：模型已提问 → 原样发布（Provider 调用数 0）；Runtime 升级 → 仍只发一次措辞请求。
- **删除伪装兜底：** `composeClarificationMessage` 原本在模型两次都无可见文本时返回 Runtime 草稿，stage 再把这个草稿当模型回复发布。现在它返回空、stage 明确失败：没有模型措辞的回合显示 Runtime 错误，而不是把固定文案挂在 Agent 名下。草稿本身仍是 Runtime 事实（请求自带的 `blockingReason` 与问题文本），UI 可按状态展示。
- **验收证据（`clarification-single-call.test.ts`，4 项）：** 模型提问路径 `llm.chat` **未被调用**且 provenance 指向 `request-that-asked`、`rewriteCount=0`；升级路径恰好 1 次调用且 `purpose='ask_user'`；两次空响应 → `ok: false`、无 `reply`、无 `replyProvenance`、`lastError.stage='ask_user'`；execute 路由写入的 `copyModelRequestId` 确实存在于 `modelRequests` 记录中。
- **未做：** 第三条（连续性纠正不再改写首条 system、改为在原循环追加有界反馈并使用原工具目录与受控 `tool_choice`）本轮未动。
- **后续状态：** 第三条已由下方第 9–11 轮的三段记录补齐（追加式反馈、`tool_choice: 'none'` 保留原工具目录、system 消息只由 `stableSegments` 构成），因此清单中该项已勾选。

**2026-09-21 SP-06 第三条执行记录（部分完成，剩余缺口已断言）：**

- **实测（改前）：** 纠正请求（1）把 `Continuity correction contract` 追加进 **system 提示词**，所以第一条消息就不同；（2）走 `reply` 调用契约，而该契约 `toolMode: 'none'`，所以**工具目录为 0**（草稿请求有 1 个工具）；（3）重建消息数组，丢掉主循环的尾部位置。
- **改法：** `repairDiscontinuousReply` 改为接收**请求形状**（purpose / 逐字消息 / 工具目录 / 采样参数），把纠正作为**追加的有界反馈**（草稿 + 一条契约消息）而非重写 system；工具目录保留并用 `tool_choice: 'none'` 禁止调用（与强制收尾同一手法）。工具循环现在回传它实际发出的消息与目录（`requestMessages` / `requestTools` / `requestTailMessages`），两条调用方各自传入自己的请求。`buildRunRequestCandidates` 新增 `primaryUserIndex`，让"在已装配请求后追加"的调用方把追加的那条标为本轮用户输入。`SystemPromptBundle` 新增 `stableSegments`（此前只有 `stableText` 与 `trailingSegments`）。
- **已完成并可验证（`continuity-correction-prefix.test.ts`，6 项）：** 纠正不再改写 system 提示词；工具目录与草稿请求**逐字节相同**且 `tool_choice='none'`；所有对话消息保持原顺序；已连续的回复不发纠正请求；对话路径行为一致。
- **剩余缺口（已用断言钉住，不会静默漂移）：** 纠正请求的**首条 system 消息仍与草稿请求不一致**——请求记录器会按提示词的分段列表重新装配 system，而不是复用被扩展的那条请求；实测草稿 4,058 字符、纠正 2,323 字符（纠正丢掉的是主循环作为尾部单独发送的边界以下段落）。因此纠正的复用上限仍被钉在该字节处。
- **顺带修正的一处真实语义漂移：** 修 `stableSegments` 过程中发现，把**整份** `segments` 交给装配器会让它用**边界以下**的段落重建 system 消息，等于把这些段落悄悄移到边界之上。`stableSegments` 让调用方能只交出一半。本轮**未**改 execute 路径的这一处（改动会连带把 bootstrap/指令从 system 消息移到尾部，超出本项范围），已在代码注释中记录。

**2026-09-21 第 10 轮补充（根因定位完成，改动按纪律回退）：**

- **根因已定位且可复现：** 剩余缺口的来源是**边界语义在两层之间不一致**——
  - `SystemPromptBundle` 按边界切分：`stableText` = 2323 字符（identity/core-flow/safety/workspace/date-time/capabilities），边界以下还有 `runtime`、`output-directives`、`bootstrap:*`、`retrieval-intent-contract`；
  - 但主循环把**整份** `segments`（9 段，4141 字符）交给 `buildRunRequestCandidates`，装配器于是把这些**边界以下**的段落重新拼进 system 消息 → 实际发出的 system 消息变成 4058 字符（边界以下的内容被**移到边界之上**）；
  - 纠正路径复用的是**会话形状**（2323 字符的稳定半份），于是首条消息与草稿请求不同（4058 vs 2323），复用被钉在该字节处。
  - 实测证据：`BOOTSTRAP LAYOUT {"stableInStableText":false,"stableSegments":[identity,core-flow,safety,workspace,date-time,capabilities],"trailingSegments":[runtime,output-directives,bootstrap:AGENTS.md,retrieval-intent-contract]}`。
- **正确的修法（较大改动，未在本轮做）：** 让主循环在 system 消息里只放 `stableSegments`，并把**所有**边界以下段落作为尾部消息发出（含 bootstrap 与 output-directives）。这样 system 消息就是 `stableText`，边界名副其实，纠正请求的首条消息自然逐字节一致。
- **为什么回退：** 该改动会让 bootstrap 与输出指令从 system 消息移到尾部，连带影响 7 个既有断言（其中 `model-request-characterization` 明确要求 bootstrap 可见）。这是一个**协调性**改动，不是本项范围内的收尾；本轮已完整实现并验证了一版（实测纠正请求前缀 3524/3524 完全一致、首条消息同为 2323），但按"不夹带、不半成品"的纪律**回退到已提交的验证状态**，把根因与修法完整记录于此，供专门一轮执行。
- **本轮实际落地：** 重新钉住基线（探针随 harness 套件重跑，指标不变：负载 A 每轮 5,585、负载 B 复用比 1.000、负载 C 共享 3,591 / 稳定头 3,446），并删除中间重复的钉住文件。`packages/harness`+`prompt`+`context` = **637 通过**。

**2026-09-21 第 11 轮（边界语义协调，已落地）：**

- **实现：** 主循环的 system 消息现在**只由 `stableSegments` 构成**，因此 system 消息**就是** `stableText`；所有边界以下段落（runtime 段、output-directives、bootstrap 文件、检索契约）作为**各自的消息**由同一个尾部 ledger 一次性追加，顺序按提示词渲染顺序；每条都保留提示词为其声明的 Context 种类（bootstrap 仍是 `project_knowledge`，记忆索引仍是 `memory_index`），所以字节搬了、账目没乱。REPLY 同样处理，两条路径描述同一份布局。
- **验收证据：** 纠正请求的首条消息现在与草稿请求**逐字节相同**，且草稿请求的每条消息都在纠正请求中按序重复（`continuity-correction-prefix.test.ts`）；system 消息内**不再含**边界标记（边界就是 system 消息结束的位置）；边界以下段落确实作为独立消息发出（`shared-fixed-prompt.test.ts` 新增用例断言 bootstrap / `# Runtime` / 检索契约 / `# Runtime Facts` 都在尾部）。
- **随之更新的既有断言（据实说明）：** 原先把边界以下文本钉在 system 消息内的断言（边界标记、BOOTSTRAP_SENTINEL）改为钉在尾部；两处基于条数的断言改为基于性质（固定提示开头、用户轮只出现一次、其余皆为 system 段落）。
- **基线复测（方向如实）：** 负载 B 仍为**完整前缀**（复用比 1.000）；负载 A 的可复用前缀从上一版读数 **5,585 修正为 3,574**——上一版把"system 消息吞下的边界以下字节"也算作了共享，那些字节本就**不该**共享。共享字节少了，但共享的是设计声明为稳定的那部分。
- **验证：** `harness`+`prompt`+`context`+`runner` = **991 通过**；全仓库 = **3145 通过**，仍是那 2 项既有 pnpm/Windows shim 失败。

### SP-07：压缩只携带必要输入（P1）

- [x] 保留当前摘要长度及 branch/scope 契约修复，移除压缩请求无关的能力快照、检索规则和主循环状态注入。
- [x] 保留最小专用摘要契约、真实待压缩消息、必须保真的目标/决定/产物与引用。压缩仍是当前唯一持久记忆写入方，不能在此次精简中误删该能力。
- [x] 明确摘要安装与消息截断为一次原子区间切换；失败继续使用旧的有效摘要，所有失败与重试计入成本。不要在本任务中顺带改变冻结基准的压缩频率。

入口：`runner/session-continuity.ts`、`model-observability.ts`、`runtime-awareness.ts`、压缩操作存储与恢复测试。
验收：压缩请求无无关播报；合法记忆候选与摘要保真通过；中断/失败不丢失旧摘要和未完成目标；保留已有未提交修复及其回归测试。

**2026-09-21 SP-07 执行记录（三条完成）：**

- **实测（改前）：** 压缩请求经 `prepareModelRequest` 走通用注入，实测形状为 `ssu`：系统摘要契约 + 中间夹入的 `# Runtime Facts`（能力快照、权限、工作区、网络、注册工具）+ 用户载荷。按字节：**355 字节的 Runtime 事实块对 32 字节的待压缩内容**——无关播报是被压缩内容的 11 倍，而且两次尝试每次都重付。
- **改法：** 压缩调用传 `skipRuntimeTail: true`，请求记录器不再注入 Runtime 尾部。记忆片段注入本就未生效（`session_compaction` 调用契约不允许 `memory_fragment` 这种 Context 种类），所以这次是关掉剩余的注入，而不是开一个新的豁免。
- **刻意不动：** 摘要长度上限（1200 字符）与 branch/scope 配对规则（既有 `session-compaction-prompt.test.ts` 正在守）、1800/2200 token 预算、尝试次数、压缩频率。压缩仍是唯一的持久记忆写入方。
- **验收证据（`session-compaction-input.test.ts`，3 项）：** 源码级断言压缩请求被标记为 summary-only；摘要契约与保真优先级仍在；真实 runner 运行中，摘要请求只带提示词与转录，**不含** `# Runtime Facts` / 检索契约 / `# Runtime State` / `capability_epoch` / `permission_policy`，同时该 run 仍正常发布摘要（`metadata.compaction.summary` 正确）。

**2026-09-21 SP-07 第三条执行记录（完成）：**

- **原子区间切换（显式断言）：** 新增 `compaction.test.ts` 用例，断言"摘要"和"它覆盖的区间"是**同一条记录的两个半边**：活动元数据、durable projection 与返回值三者的 `id`/`collapsedCount`/`sourceStartMessageId`/`sourceEndMessageId` 完全一致，`sourceHash` 等于被覆盖前缀的重算哈希，且 `compacted: true` 与摘要同批出现；原始 JSONL 消息条数与 id 顺序不变（压缩从不截断正文）。
- **失败继续使用旧的有效摘要（显式断言）：** 先成功压缩一次，再追加消息后让摘要调用抛错：断言活动摘要的 `id`/`sourceEndMessageId`/`collapsedCount` **原样保持**、不留下 pending 事务；随后一次成功压缩的 `previousSummaryId` 指向前一份有效摘要且覆盖区间单调扩大——失败没有跳过或吞掉那段区间。
- **所有失败与重试计入成本（实现改动）：** 压缩操作此前只统计**拿到了响应的**请求（`ctx.usage.requestCount` 由响应驱动），因此一次完全失败的操作在记录里**连 `usage` 字段都没有**。新增 `CompactionAttemptTally`：`onRequest` 记 issued/retries、`onError` 记 failures，`compactionUsage` 改为 `requestCount = max(issued, 响应数)`，并在 `SessionCompactionUsage`（及 app 侧同形投影）新增可选 `retryRequests`/`failedRequests`。token 总量仍在**没有任何 usage 上报时保持缺省**，不按 0 补齐，`usageStatus` 相应为 `unavailable`/`partial`。
- **有牙验证：** 把 `requestCount` 改回"仅响应数"，`session-compaction-input.test.ts` 的失败用例立刻失败（记录里 `usage` 整个缺失）。
- **刻意不动：** 压缩阈值、`keepRecent`、压缩频率、摘要长度上限、尝试次数（`maxAttempts: 2`）与 branch/scope 契约均未改变；工具循环的 `evictionScope` 也不影响压缩请求（压缩是单请求区间）。

### SP-08：按真实请求和成本验收（P0 建立基线，最后收口）

- [x] 先在同一代码/构建与冻结负载下保存旧实现基线，再做修复后对比。基线记录版本、模型、调用用途、轮数、工具集合、压缩配置和 usage 完整性。
- [x] 将本地 stage/requestKind 指纹变化与实际 messages/tools 变化分开报告；缓存边界标记不能当作供应商命中证据。
- [ ] 修正验收文档中过时汇总与未经证实的因果归因；正文保存有界脱敏汇总，原始提示、会话和密钥不进入仓库。
- [x] 两组冻结负载均报告总体及冷启动/连续工具/压缩/澄清等分项，包含全部辅助请求、失败和重试。公式固定为缓存输入 token 总和 ÷ 输入 token 总和，usage 缺失不得按零补齐。
- [x] 同时报告每任务未缓存输入、总输入/输出、请求数、任务时延、失败与正确性。禁止增加无用上下文或重试来抬高比例。

验收：保留范围的任务正确性通过；两组完整总体命中率均 >=95% 才标记缓存目标达成。否则分别记录“结构修复完成”“精简收益”和实际未达差距，不改小目标或挑选热缓存子集。

**2026-09-21 SP-08 执行记录（基线已建立并完成两组冻结负载对比；第 3 条未做，第 4–5 条已完成）：**

- **基线已补齐（此前错位，本轮补做）：** 新增 `packages/harness/src/probe/frozen-load.ts` + `baseline.test.ts`。探针用**脚本化模型**跑冻结负载，逐请求记录：请求字符数、与前一条请求的**共享前缀字符数与占比**、缓存边界以上的**稳定头字节数**、以及**工具目录名与 schema 摘要**。全程**不调用供应商**。
- **对比方式：** 把同一探针原样复制进 `git worktree`（`cd6cabc`，本工作开始前的提交）运行，产出 `docs/taskbooks/cache-baseline/pre-fix-cd6cabc.md`；当前实现产出 `baseline-git-0af62a7.md`。两者模型名、工具集合、压缩配置、负载完全相同。对比分析见 `docs/taskbooks/cache-baseline/README.md`。
- **实测（结构，字符数；下表已按第 11 轮边界修复后的读数更正）：**

  | 指标 | 改前 | 改后 |
  | --- | ---: | ---: |
  | 负载 A（本地→Web→本地）每轮可复用前缀 | 2311 | **3574** |
  | 负载 A 出现的不同工具目录数 | 3 | **1** |
  | 负载 B（四轮工具循环）复用比 | 0.93（每轮在 438 字符处分歧） | **1.000**（首处分歧即新追加内容） |
  | 负载 C 聊天/工具共享前缀 | 360（仅 identity） | **3557** |
  | 负载 C 聊天路径稳定头 | 1916 | **3444** |
  | 压缩请求的 Runtime 事实块 | 355 字符 | **0** |

  **更正说明：** 本表此前记录负载 A 为 5585 字符、负载 C 为 3591/3446，那是**虚高读数**——当时 system 消息把边界以下段落一并吞入，于是"共享前缀"里混进了提示词自己声明属于边界以下的字节。第 11 轮把边界以下段落改为独立消息后重测得以上数字：可复用字节变少，但**匹配上的字节正是设计上稳定的那一半**（`docs/taskbooks/cache-baseline/README.md`）。
- **成本如实记录（不是净收益）：** 固定工具目录让负载 A/B 的每个请求**增大约 800 字符**（Web schema 现在始终附带，边界以下段落改为独立消息）。这是 SP-05/SP-02 要求的取舍，是否划算由下面的真实会话读数回答。
- **第 2 条已达成的方式：** 本地 `stablePrefix`/requestKind 指纹与实际 `messages`/`tools` 的变化在报告里是分开的——探针只看真实请求体与工具定义；缓存边界标记只用来量出稳定头，**不作为任何命中证据**。
- **第 3 条部分完成（本轮补记）：**
  - **"原始提示、会话和密钥不进入仓库"已完成并验证：** 对跟踪文件做了四项扫描——`sk-` 形式的密钥字面量（0 命中）、非环境变量形式的 `apiKey` 字面值（0 命中）、本轮实机负载的会话 id/数据根名（0 命中）、Provider 原始载荷标记（`prompt_cache_hit_tokens`/`cached_tokens` 仅作为字段名与测试夹具出现）。本轮新增的 SP-08 记录只包含聚合计数与比率，不含提示词正文、会话内容、密钥或临时数据根名。
  - **"修正验收文档过时汇总"未做（有意留给该文档作者）：** `docs/reference/cache-95-acceptance.md` 在本任务开始时就带有未提交改动（5.50 节），用户明确要求不要动该文件。已核对到两处过时内容供作者处理：文末状态标记仍写"压缩 54.808%"，而 5.50 已实测 32.911%；第 55 行所述"历史结论、更正与最新读数并存"的状况依然存在。
  - **本清单自身与缓存基线 README 的过时汇总已在本轮修正：** 结构表按第 11 轮边界修复后的读数更正（3574/3557/3444），并说明此前 5585/3591/3446 是 system 消息吞入边界以下段落造成的虚高；README 补上真实 Provider 读数指引与"再次 pin 不是新增证据"的说明；`docs/README.md` 的缓存状态行也按上面的真实读数重写（原文仍写"压缩 54.808% 不达标""连续工具工作尚未测量"，两句都已不成立）。

**2026-09-22 第 14 轮补充（仓库门禁回归修复）：**

本轮发现本任务书此前几轮的改动让仓库自检 `node scripts/check-repository-hygiene.mjs` 由 33/33 变成 **8 项失败**（用户 5.50 节记录的 33/33 是改动之前的状态）。逐项修完 7 项，剩 1 项属于用户的未提交改动：

- **本机路径（已修）：** 本清单正文里残留一条带用户名的一次性临时目录绝对路径，改为 `<temp>/ls-prompt-audit-*`。
- **文档元数据（已修）：** 基线目录下所有 Markdown 补上 `最后更新：YYYY-MM-DD HH:MM:SS` 与中文说明行；探针生成的 `latest.md` 也由 `render()` 统一写入这两项，保证每次重写后仍合规。
- **文档命名与入口（已修）：** 缓存基线报告从 `docs/taskbooks/cache-baseline/` 移到 `docs/reference/cache-baseline/`（放在 `docs/taskbooks/` 下的每个 Markdown 都必须叫 `*-taskbook-YYYY-MM-DD.md`，而它不是任务书）；本清单改名为 `system-prompt-prefix-cleanup-taskbook-2026-09-21.md` 并把基线日期写进一级标题；`docs/README.md` 补齐全部新路径的入口条目。探针不再自动写 `baseline-<freeze>.md`（那会让每次测试运行都产生一个未登记的文档），需要冻结时手工复制 `latest.md`；重复的 `baseline-git-1929e7e.md` 已删除。
- **大型文件（已修）：** `context-candidates.ts`、`memory-known-state.ts` 补职责头注释；三个 >300 行文件登记进 `docs/reference/module-split-map.md` 软上限队列。
- **组合热点与受控超限（已修）：** `packages/context/src/engine.ts` 从 223 行拆到 139 行——append-only 记账移到 `context-engine/append-only.ts`、预算适配移到 `context-engine/fit.ts`（热点基线 180 行重新满足）；`model-observability.ts` 745 → 669（`validateModelRequest`/`applyResolvedReasoning` 移到 `model-request-contract.ts`，受控上限 705）；`tool-loop.ts` 651 → 575（工具调用/结果持久化与投影移到 `stages/execute/tool-result-persistence.ts`，已低于 600 行，其受控超限登记按规则移除）。
- **仍未修（1 项，属于用户的未提交改动）：** `packages/harness/src/cache-observability.ts` 当前 **696 行 > 受控上限 680**。该文件的未提交改动（`splitRequestForCache` 的"前导 system 块才算可缓存头"修复，+21 行）在 HEAD 上是 675 行、门禁是绿的；本轮**没有改动该文件**（其间一次尝试已完整回滚并逐行还原，`git diff --stat` 仍精确等于 `21 insertions(+)`，其自带测试 14 项通过）。要在作者提交该修复的同时恢复门禁，需要把该拆分或按规则下调/完成拆分；不由本轮代做，以免覆盖在途编辑。

**2026-09-22 第 15 轮（SP-02 第 1 条的第二处未兑现声明已补齐 + 死导出核对）：**

- **再删一个无调用方的 split helper：** `splitAtBoundary`（`packages/prompt/src/cache-boundary.ts`）被从包入口导出，但**没有任何生产调用方**——边界现在由 builder 按段落索引切分并发布为 `stableText`/`stableSegments`/`trailingSegments`，字符串级切分只是旧设计的残留。三处测试断言改为直接使用 bundle 的生产字段（`bundle.stableText` 与 `trailingSegments`），helper 自身那条单元测试随之删除；`CACHE_BOUNDARY_MARKER` 仍保留并成为该模块唯一导出，模块头注释写明"边界不是字符串操作"。验证：`packages/prompt` 12+3+3 项、`profile-prompt.test.ts` 9 项通过，`tsc -p packages/prompt` 退出 0，全仓库 `git grep splitAtBoundary` 0 命中。
- **顺带核对（只报告，未改动）：** 对本任务触碰过的 34 个生产文件做了一次导出核对（统计每个导出在其它文件中的非测试引用数）。确认两处**早就存在**、与本任务书无关的死导出，本轮不做删除以免混入范围外改动：
  - `applyMemoryContextWorkingSet`（`packages/harness/src/memory-context-working-set.ts:107`）：无生产调用方，只有自己的测试。它是"改写/删除已释放原子"的**旧机制**，已被 `appendMemoryReleaseNotes`（保留原文 + 尾部追加）取代（`harness-lean-phase-c` 任务书 round 23 的记录确认调用点已迁移）。留着它的风险是：它与本任务书 SP-03 确立的追加式不变量相反，容易被误用。**建议删除或显式标注为已废弃。**
  - `buildCompactUserFacingVoiceAddon`（`packages/harness/src/profile-prompt.ts:140`）与 `buildCompactBehaviorProfileAddon`（同文件 `:152`）：前者零引用，后者仅被 `profile-prompt.test.ts` 引用（3 处）。两者都属于已被 SP-02 取消的"compact 提示变体"路径。


**2026-09-21 SP-08 第 4–5 条执行记录（真实 Provider，2026-09-22 完成）：**

- **口径与工具：** 用 `scripts/verify-harness-path-comparison.mjs`（真实 Electron + 真实 Provider，隔离数据根，shadow/next 两条路径交替执行同一冻结任务集）产生样本，用 `scripts/audit-cache-usage.mjs` 从执行日志计算指标：命中率固定为 **Σ缓存输入 token ÷ Σ输入 token**（不是每请求比率的平均），且**usage 缺失不按 0 补齐**，任何不完整都只报 `unavailable`。模型 `deepseek/deepseek-flash`，每条路径 20（或 4）个任务 × 2 轮，密钥只经环境变量传入、未落盘未入库。
- **负载 1：同一共享会话的 20 个对话任务 × 2 轮**

  | 路径 | 请求 | 输入 | 缓存输入 | 未缓存输入 | 输出 | 总体命中 | 稳态（去冷启动） | 冷启动（单列不判定） |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
  | shadow | 40 | 215,359 | 168,192 | 47,167 | 1,074 | **78.098%** | 79.637%（39 请求） | 5.712%（1 请求） |
  | next | 40 | 216,766 | 169,472 | 47,294 | 1,126 | **78.182%** | 79.712%（39 请求） | 5.710%（1 请求） |

  - 每任务未缓存输入：shadow 1,179.2（p50 1,098 / p95 1,189）；next 1,182.3（p50 1,102 / p95 1,209）。模型请求/任务：avg 1.00。
  - 时延：shadow 平均 790ms（p50 767 / p95 1,180）；next 平均 806ms（p50 791 / p95 1,135）。
  - 分项：唯一用途 `execute_tool_loop` 40 次调用，命中 78.1% / 78.2%；**压缩 0 次、澄清 0 次**（该任务集不含需要追问的请求，stage 计数里没有 `ask_user`）。
  - 累计趋势（next）：第 1 轮 20 请求 74.36% → 第 2 轮累计 40 请求 **78.18%**，即会话前缀越长命中越高。
  - usage：两侧都 `complete=yes`，无缺失输入/缓存字段、无缺输出的 run；失败 0、重试 0、供应商尝试/调用 1.00。

- **负载 2：连续工具工作（4 个工具任务 × 2 轮，完全访问模式）**

  | 路径 | 请求 | 输入 | 缓存输入 | 未缓存输入 | 输出 | 总体命中 | 稳态 | 冷启动 |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
  | shadow | 17 | 78,920 | 66,048 | 12,872 | 826 | **83.690%** | 87.992%（15） | 50.056%（2） |
  | next | 18 | 83,745 | 70,784 | 12,961 | 1,003 | **84.523%** | 88.655%（16） | 50.022%（2） |

  - 每任务未缓存输入：shadow 1,609.0（p50 1,372 / p95 4,451）；next 1,620.1（p50 1,420 / p95 4,453）；按请求计 757.2 / 720.1。模型请求/任务：avg 2.13 / 2.25（p95 3），即一个任务内多轮工具循环。
  - 时延：shadow 平均 1,478ms（p50 1,357 / p95 2,348）；next 平均 1,805ms（p50 1,654 / p95 2,789）。首个工具动作：shadow n=7 平均 698ms；next n=8 平均 832ms。
  - usage：两侧 `complete=yes`；失败 0、重试 0、语义失败 0、空回复 0；stage 计数为 enter/classify/execute/verify/finalize 各 8，**没有 ask_user**。
  - **如实记录一条未达标项：** 该负载的 shadow/next 时延差超过 ±5% 咨询上限（p50 与 p95 均为 +15.9%，next 更慢），失败率仍为 0；两个对话负载的时延差在限内（p50 +4.1%、p95 −0.2%）。这不属于缓存指标，但按要求一并报告。
  - **正确性（保留范围）真实证据：** 两条路径的工作区里 `notes.md` 内容都是 `cache-probe-ok`（"写入后读回"这一步真的落盘了）；16/16 次 run 返回 200，0 失败。Runtime 的 `verification.passRate` 记为 0，即这些任务被判为 `unverified`（如实记录，未把它当成 pass）。

- **负载 3：开启压缩的同一共享会话（20 任务 × 2 轮）——回答"压缩"分项**

  | 路径 | 请求 | 输入 | 缓存输入 | 未缓存输入 | 输出 | 总体命中 | 稳态 | 冷启动 |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
  | shadow | 40 | 227,366 | 142,848 | 84,518 | 949 | **62.827%** | 63.976%（79） | 5.713%（1） |
  | next | 40 | 229,973 | 145,408 | 84,565 | 999 | **63.228%** | 64.372%（86） | 5.709%（1） |

  - 分项（真实用途拆分）：`execute_tool_loop` 67.2%（40 次）/ 67.8%（40 次）；**`session_compaction` 29.6%（40 次）/ 33.8%（47 次）**。压缩请求与主循环前缀互不通用，因此把总体拉到 63% 左右——与验收文档 5.50 独立测得的 32.911% 压缩场景水平同向。
  - 每任务未缓存输入：shadow 1,649.8（p50 1,638 / p95 1,910）；next 1,606.5（p50 1,572 / p95 1,997）。时延：859ms / 798ms 平均。
  - usage：两侧 `complete=yes`，失败 0、重试 0。**台账差额已核对：** shadow 的 run 汇总 `usage.promptTokens=201,032` 与逐请求台账 227,366 相差 26,334，恰好等于 40 次压缩请求的输入量（未缓存 18,524 ÷ (1−0.296) ≈ 26,313）——压缩成本记在压缩操作上（SP-07），不在 run 汇总里。

- **按验收口径的结论：** 三组真实负载的总体命中率分别为 **78.10/78.18%**（对话）、**83.69/84.52%**（连续工具）、**62.83/63.23%**（压缩），**均未达到 95%**。因此本轮记录为**「结构修复完成」＋「精简收益（字符级）」＋「实际未达差距（上述真实数字）」**，**不标记缓存目标达成**；未改小目标、未剔除冷启动、未挑选热缓存子集，也未通过增加冗余上下文或重试抬高比例（重试数为 0，供应商尝试/调用 1.00）。
- **未覆盖的分项：** "澄清"分项在这三组负载里**没有出现**（任务集均可直接作答，stage 计数无 `ask_user`），因此本报告不声称澄清路径的命中率。

## 三、本轮验证与交付边界

- 已运行现有 `execute.test.ts` 的 strict-extension 定向测试：1 项通过，39 项未运行；已确认该测试忽略尾部的覆盖缺口。
- 已通过当前源码的离线请求复现，覆盖表中三个合成场景；没有调用真实供应商，也没有据此宣称真实缓存收益。
- 临时复现脚本、Vitest 配置及三份脱敏合成结果保存在该轮的一次性临时目录（`<temp>/ls-prompt-audit-*`）；临时目录可被系统清理，正式落地先完成 SP-01。
- 本轮仅新增本清单。工作树原有的 cache-observability、session-continuity、压缩提示测试和验收文档改动均保持原样。

建议首个实现批次：SP-01 + SP-02 + SP-03 + SP-04；先解决实际消息生命周期与重复注入，再进行工具目录和额外调用精简。SP-08 的基线应在实现改动前建立。

## 四、2026-09-21 SP-01 实现轮的验证边界（据实记录）

- 本轮**只做结构修复与离线验证**：全部证据来自 Vitest 中的 mock Provider 与单元级断言，**没有调用真实供应商，也没有测量真实缓存命中率**。因此本轮**不能**声称 95% 目标已达成，SP-08 的基线仍未建立（按清单要求在实现改动前建立，现已错位，需在下一轮以 `git` 历史中的旧实现补测）。
- 已验证的是**必要条件**：正常未压缩轮次的完整请求（含 tools 与尾部）满足"旧请求是新请求的严格前缀"。
- **未验证**的部分：真实 Provider 的缓存单元匹配行为、压缩区间切换时的重建、取消/重启后的位置恢复、跨轮（同一会话的多个 run）的连续性。清单第 2 节离线表中的字符量结论未被本轮推翻，也未据此推算 token 节省。
- **后续状态（2026-09-22 补记）：** 上面四项后来都有了证据——真实 Provider 缓存行为见 SP-08 第 4–5 条的三组实机负载；压缩区间切换的原子性与失败保留见 SP-07 第三条记录（`session/compaction.test.ts`）；重启后的位置恢复见 SP-03 第四条记录（`runner/session-restart-continuity.test.ts`）与进程级副作用恢复用例；同一会话跨轮连续性见 `request-prefix-append-only.test.ts`。本节保留为当时边界的原始记录。
- 还原历史行为的方式：本轮改动集中在 `run-tail-ledger.ts`（新增）、`context-candidates.ts`、`model-observability.ts`、`tool-loop.ts`、`execute/prompt.ts`、`profile-prompt.ts`、`prompt/builder.ts`、`context-engine/contracts.ts`；`git stash` 一次即可回到旧实现的请求形状，可用于 SP-08 的对照测量。
