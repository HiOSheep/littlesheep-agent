# CMv2-P0A：上下文链路审计与诊断基础

日期：2026-10-13。源码基准：`9f6bae0ff14e89698b1e3688772346f8c653690c` 加本阶段工作区变更。范围止于 P0A；不实施 P0B 页面、Prompt 精简或 P1 记忆权限调整。

## 1. 结论与证据等级

- **代码事实**：普通问候与工作任务都进入同一个 execute 主循环，携带共享提示头和注册工具目录。只有 Runtime 能力／状态问题走独立 reply 路径。不是先用一个小模型判断问候，再调用任务模型。[路由实现](../../packages/harness/src/stages/classify.ts)、[Harness 组装](../../packages/harness/src/default-harness.ts)。
- **隔离实测**：两字问候生成 14 个原生工具、9 条消息；使用仓库校验过的 DeepSeek V4.1 tokenizer，对这份真实 Runner/Harness 组装结果进行模型 framing 对照，得到 **5,640 Token**。原生工具的边际贡献为 **3,431 Token**。这解释了“约 6K”级别固定开销可以如何出现，但不能认定用户某次线上 6K 读数已经逐项复核。
- **代码事实**：已有 ContextSnapshot、ModelRequestSnapshot、Provider 回执、三个缓存账本和 durable 日志，不需要新数据库、Agent 框架或模型路由。[Context](../../packages/context/README.md)、[请求观测](../../packages/harness/src/model-observability.ts)。
- **实现并验证**：新增 `buildContextTrace`，只从匹配快照按需投影类别、作用域、计数和账本；没有保存原文的新日志或存储。[实现](../../packages/context/src/context-trace.ts)、[隐私与关联测试](../../packages/context/src/context-trace.test.ts)。
- **未验证**：用户实际会话、真实 Provider 账单和实际 Electron 圆环交互没有在本次运行中采集。六场景运行的是隔离 Runner 与模拟传输；不能当作线上模型质量、TTFT、缓存命中率或正式端到端性能验收。

## 2. 从输入到 API 的完整链路

```text
Composer → Renderer run-actions → runAgentStream
  → Local App API runStream → Main 所有权/工作区/附件/运行策略
  → Runner.runStream / run
    → 解析不可变 RunConfig、工具目录、会话、bootstrap
    → buildRunContext（压缩游标后的历史 + ModelHistory）
    → MemoryService.beginRun（根索引 + 有界初始检索）
    → Durable Harness: enter → classify → execute
      → buildExecuteSystemPrompt → executeMainLoop → runToolLoop
        → buildRunRequestCandidates
        → prepareModelRequest / recordPreparedRequest
          → 工具排序、reasoning、调用契约、Runtime/Memory 状态
          → ContextEngine.prepare（契约过滤、预算、计数、装配、快照）
          → 缓存观察、请求生命周期与 durable 事件
        → callObservedChat / callObservedChatStream
          → OpenAIClient → buildOpenAICompatibleChatCompletionsBody
          → /chat/completions（流式 usage fallback、传输重试）
        ← 实报 usage 回执、模型文本或 tool calls
        → Runtime 校验/执行工具、清洗结果、追加 assistant/tool 消息
        → 下一轮追加式请求，或交付回复
    → VERIFY/FINALIZE、会话与执行日志结算
    → 必要时单独压缩操作（不写长期记忆）
  ← SSE delta/tool events/final result → Renderer 圆环快照
```

链路入口及边界证据：

| 边界 | 代码与检查点 |
| --- | --- |
| 输入与流式调用 | [composer-view](../../packages/app/src/renderer/app-shell/composer-view.tsx)、[run-actions](../../packages/app/src/renderer/chat/run-actions.ts) 的 `runAgentStream`、[Renderer API](../../packages/app/src/renderer/api/run.ts) |
| Main 路由 | [run-routes](../../packages/app/src/main/local-app-api/run-routes.ts) 的 `POST runStream`：会话恢复、所有权、cwd、附件、策略，再 `runner.runStream`；[run-support](../../packages/app/src/main/local-app-api/run-support.ts) |
| Runtime 基础设施 | [infra](../../packages/runner/src/infra.ts)：Provider、惰性 tokenizer、Memory、Session、SkillLoader、ToolRegistry；[runner](../../packages/runner/src/runner.ts)：调用 `buildRunContext` 与 `memoryService.beginRun` |
| 历史与文件 | [context](../../packages/harness/src/context.ts) 的 `buildRunContext`；[model-history](../../packages/harness/src/model-history.ts)；用户可见历史与模型重放历史是不同投影 |
| 模型循环 | [execute](../../packages/harness/src/stages/execute.ts)、[main-loop](../../packages/harness/src/stages/execute/main-loop.ts)、[tool-loop](../../packages/harness/src/stages/execute/tool-loop.ts) |
| Context 权威边界 | [model-observability](../../packages/harness/src/model-observability.ts) 的 `recordPreparedRequest`；[ContextEngine](../../packages/context/src/engine.ts) 与 [内部模块](../../packages/context/src/context-engine/README.md) |
| 实际序列化 | [llm/client](../../packages/llm/src/client.ts) 的 `buildOpenAICompatibleChatCompletionsBody`、`chat`、`chatStream`、`callStreamApiWithUsageFallback`；[协议测试](../../packages/llm/src/client.test.ts) |
| usage 回执 | [model-provider-receipt](../../packages/harness/src/model-provider-receipt.ts)、[物理回执测试](../../packages/llm/src/provider-response-receipt.test.ts)、[对账测试](../../packages/harness/src/cache-provider-usage-reconciliation.test.ts) |

Trace 的 `boundary: prepared_chat_request` 明确表示 ContextEngine 后的请求证据，不宣称是 HTTP 原始 body。Provider 会增加 `stream_options`，可能重试不支持该字段的服务；回执按物理 attempt 统计。现有 `payloadHash` 基于请求形状、消息内容 hash 和工具名称，并不是完整原生工具 schema 的 wire hash。[snapshots](../../packages/context/src/context-engine/snapshots.ts)、[llm/client](../../packages/llm/src/client.ts)。

## 3. 上下文来源、注入条件与实际位置

| 来源 | 注入条件与位置 | 代码 |
| --- | --- | --- |
| 固定 System Prompt | canonical head：identity、core-flow、safety、workspace、date-time、capabilities；共享前缀，非聊天文字估算 | [builder](../../packages/prompt/src/builder.ts)、[sections](../../packages/prompt/src/sections.ts) |
| 行为/推理 | general/coding profile 为稳定 addon；执行路径 reasoning addon；最终 native reasoning 参数由 resolved run config 设置，显式逐请求控制优先 | [profiles](../../packages/prompt/src/profiles.ts)、[execute/prompt](../../packages/harness/src/stages/execute/prompt.ts)、[model-request-contract](../../packages/harness/src/model-request-contract.ts) |
| 原生工具定义 | 主循环发送整个 `ctx.tools` 的 schema。检索意图只限制可执行集合；不缩减 advertised catalog，以保护缓存前缀。`includeToolingText:false` 已避免执行路径重复渲染完整工具文字 | [main-loop](../../packages/harness/src/stages/execute/main-loop.ts)、[provider-tool-spec](../../packages/harness/src/provider-tool-spec.ts)、[execute/prompt](../../packages/harness/src/stages/execute/prompt.ts) |
| Skills | 内置/用户/extraDirs 发现；名称列表进入 `use_skill` 工具 description，正文在调用后作为 tool result 注入。Prompt builder 可接受 skills catalog，但当前 execute prompt 调用没有传 skills 列表 | [infra](../../packages/runner/src/infra.ts)、[use_skill](../../packages/skills/src/use_skill.ts)、[builder](../../packages/prompt/src/builder.ts) |
| Bootstrap 文件 | `AGENTS.md/SOUL.md/USER.md/TOOLS.md` 经过单文件与总字符限额进入 below-boundary 消息；`MEMORY.md/PHILOSOPHY.md` 仅注册为可检索资源。Main/Runner 的 bootstrapDir 与开发仓库 cwd 是不同概念 | [context](../../packages/harness/src/context.ts)、[bootstrap-resources](../../packages/memory-tree/src/memory-service/bootstrap-resources.ts)、[builder](../../packages/prompt/src/builder.ts) |
| 根记忆索引 | `beginRun` 返回，builder 的 `memory-root-index` 进入稳定头；scope 标记 global 描述注入段，不意味着所有被索引资源都可跨项目读取 | [run-coordinator](../../packages/memory-tree/src/memory-service/run-coordinator.ts)、[builder](../../packages/prompt/src/builder.ts) |
| 初始记忆片段 | 默认 autoPrime，最多 2 个 atom、预算 600（Memory 自己的近似口径）；仅有匹配片段时生成 `initialMemoryContext` | [run-coordinator](../../packages/memory-tree/src/memory-service/run-coordinator.ts)、[util](../../packages/memory-tree/src/util.ts) |
| Memory KnownState/释放说明 | 以 tail 追加，记录已见/采用/释放状态；`memory_fragment` 类别还可能包含这些规则，不等价于已加载 atom 正文 | [run-tail-ledger](../../packages/harness/src/run-tail-ledger.ts)、[memory-known-state](../../packages/harness/src/memory-known-state.ts)、[working-set](../../packages/harness/src/memory-context-working-set.ts) |
| 项目资料 | bootstrap + workspace 元数据资源索引；任意项目文件全文不会自动全量常驻。按 read/document/Memory 导航工具请求加载 | [workspace-index-resources](../../packages/memory-tree/src/memory-service/workspace-index-resources.ts)、[workspace-documents](../../packages/memory-tree/src/memory-service/workspace-documents.ts)、[run-support](../../packages/app/src/main/local-app-api/run-support.ts) |
| 会话历史 | `sourceEndMessageId` 压缩游标后的完整 task interval；ModelHistory 保留 tool pairs 与 Runtime tail，文本 history 不含这些。历史作为已发送前缀被 pinned，不每轮静默截断 | [context](../../packages/harness/src/context.ts)、[context-candidates](../../packages/harness/src/context-candidates.ts)、[model-history](../../packages/harness/src/model-history.ts) |
| 压缩摘要 | session metadata 的 versioned summary；被明确撤销的旧摘要不作为当前记忆注入。压缩保留原 JSONL，并更新覆盖游标 | [context](../../packages/harness/src/context.ts)、[compaction](../../packages/session/src/compaction.ts)、[session-continuity](../../packages/runner/src/session-continuity.ts) |
| 工具结果 | Runtime 执行、清洗/截断后追加 tool message；后续请求重放 assistant tool calls 和结果 | [tool-loop](../../packages/harness/src/stages/execute/tool-loop.ts)、[tool-result-persistence](../../packages/harness/src/stages/execute/tool-result-persistence.ts) |
| 附件 | manifest + 支持的图片 multipart；文档正文经工具读取；没有把所有附件全文直接并入 system | [shared stage helpers](../../packages/harness/src/stages/_shared.ts)、[run-routes](../../packages/app/src/main/local-app-api/run-routes.ts) |
| Runtime/控制/输出约束 | capability facts、环境说明、run 状态、检索契约、预算/无进展控制、用户追加输入；作为 tail 追加；unchanged tail 不再次发送 | [run-tail-ledger](../../packages/harness/src/run-tail-ledger.ts)、[runtime-awareness](../../packages/harness/src/runtime-awareness.ts)、[tool-loop](../../packages/harness/src/stages/execute/tool-loop.ts) |

本仓库开发 `AGENTS.md` 不是 LS Runtime System Prompt。本次隔离 fixture 没有读取开发仓库的 AGENTS 正文作为 Runtime 资料，也没有复制它到用户数据根。Runtime 只有在实际 bootstrap 目录读取到同名文件时才将它视为运行资料。

## 4. 约 6K 的来源与六类基线

正式 fixture：[context-baseline.test](../../packages/runner/src/context-baseline.test.ts)。使用临时 data root、Memory v3、真实 Runner/Harness/ToolRegistry/Session 路径；skillsDirs 为空，无个人 bootstrap、会话、密钥或记忆。模拟 LLM 不报告 usage，不发付费请求。Coding 场景执行一次真实隔离文件 read，再请求回复；压缩使用真实 `maybeCompact` 和确定性摘要 callback；记忆场景写入 fixture atom 并验证检索注入。

计数条件：已校验的 `deepseek-v4.1` 固定 revision `dba1be0a40aa45a94ad051997016db3960a90277`，`deepseek-flash` framing、显式 `thinking:disabled`。业务 fixture 的 model 是 `test/model`，只有计数副本改成上述模型；因此 **本地对照数字不写回 Provider/local 精确账本，也不冒充圆环真实读数**。[counter](../../packages/context/src/tokenizers/deepseek-v4-counter.ts)。首次下载因网络连接超时失败；随后仅将现有不可变 tokenizer 两个公开资源文件复制到临时资产根，经源码的大小/SHA-256 验证后计数。未读取个人记忆内容。

2026-10-13 最终有效本地采样：

| 场景 | 模拟模型请求数 | 最后请求消息数/工具数 | 最后请求本地对照 Token | 隔离 run 墙钟 ms | Trace 均值 µs |
| --- | ---: | --- | ---: | ---: | ---: |
| 简单问候 | 1 | 9 / 14 | 5,640 | 2,421 | 3.83 |
| 多轮会话（同 session 第二轮） | 1 | 12 / 14 | 5,703 | 1,423 | 3.40 |
| 项目问答（小型 AGENTS fixture） | 1 | 10 / 14 | 5,687 | 1,576 | 3.18 |
| Coding Agent（read + 回复） | 2 | 12 / 14 | 5,865 | 1,599 | 4.08 |
| 历史压缩后继续 | 1 | 12 / 14 | 5,772 | 1,597 | 3.47 |
| 记忆检索（fixture preference） | 1 | 12 / 14 | 6,239 | 1,810 | 4.20 |

墙钟是单次样本，含磁盘/Memory/会话/结算；不含真实 LLM 网络推理，也没有独立统计压缩模型耗时。Trace 对同一已生成快照调用 1,000 次取均值，体现按需投影增量成本；不是整个诊断链路成本或 P95。Token 是最后一次请求的输入量，不是整个 run 累计费用。不同场景包含不同历史/资料，不能以此表宣称压缩收益或真实记忆检索延迟优劣。

问候逐层对照：

| 对照请求 | 本地 Token |
| --- | ---: |
| 完整请求 | 5,640 |
| 去掉原生工具目录与 tool_choice | 2,209 |
| 只保留第一条 system 与当前 user，无工具 | 1,137 |
| 只保留第一条 system，无工具 | 1,133 |

按这条明确的移除顺序，工具目录为 3,431（约 60.8%），第一条 system 为 1,133，当前 user 连同 framing 的边际值为 4，其余 tail 边际值为 1,072。tokenizer 边界可能改变，不能把任意独立段落计数直接相加或按字符比例拆分 Provider 用量。

问候快照的非 Token 来源计数：system_prompt 2,865 字符、workspace 99、memory_index 2,578、user_input 2、runtime_event 1,257、output_constraint 2,692、workflow_state 83、memory_fragment 659。原生工具 schema JSON 另占 11,798 字符（不在 snapshot.items 内）；正文合计 10,235 个 UTF-16 code units，规范化非流式 body 为 22,663 UTF-8 bytes。这里的 memory_fragment 为 KnownState 规则；本次新根问候没有预置个人记忆。

**推断**：在更多 Skills、个人 bootstrap、实际项目资料、已有会话或额外附件工具存在时，请求可进一步增加。用户线上约 6K 很可能包含同类固定成本，但具体值仍需绑定 model/requestIndex/Provider receipt 后验证。

复现方式：

```powershell
# 默认离线：检验六场景真实组装、工具结果、摘要与记忆注入，不下载 tokenizer。
pnpm exec vitest run packages/runner/src/context-baseline.test.ts

# 可选：使用独立资产根；缺少资产时会按固定 revision 下载并校验。
$env:CMV2_TOKENIZER_ROOT = Join-Path $env:TEMP 'ls-cmv2-tokenizer-assets'
$env:CMV2_BASELINE_OUTPUT = Join-Path $env:TEMP 'ls-cmv2-baseline.json'
pnpm exec vitest run packages/runner/src/context-baseline.test.ts
```

输出仅为场景枚举、数值与 content-free Trace。fixture 完成后关闭 Runner、恢复环境变量并校验临时根边界再清理；可选不可变 tokenizer 资产保留供重复测量。

## 5. 圆环现有口径

[Renderer context-usage](../../packages/app/src/renderer/context-usage.ts) 与 [圆环组件](../../packages/app/src/renderer/composer/context-usage-indicator.tsx)、[session-routes](../../packages/app/src/main/local-app-api/session-routes.ts) 是权威实现。

1. 当前 modelRef 必须匹配快照，切模型不会沿用另一模型读数。
2. 从请求逆序选择 `reply/execute/ask_user` 对应快照；回退到匹配模型/usage 的快照。
3. **本地 exact promptTokens 优先**，其后 Provider 单次 promptTokens；conservative safety estimate 不显示。极旧/不完整记录只有 run aggregate usage 时会回退，可能把累计输入当成当前请求大小；P0B 应明确 legacy aggregate fallback。
4. `maxTokens = getContextWindowForModelRef(modelRef)`；percent 是 `round(used/max*100)`，封顶 100%。分母是 Config 的模型能力登记，未知窗口时不可用；不是“输入量 + 本次输出 + 预留输出”的比例。
5. 已发送输入量是上次请求的快照，不会随输入框草稿实时增加；也不是下一次请求准备后的预览。Provider 缓存命中不减少上下文占用：cached tokens 仍在 promptTokens 内。
6. 会话缓存指标来自 session 各 run 的 provider aggregate，按 `Σcached/Σinput` 计算；脱离主会话 run 的压缩操作不纳入。局部/缺失 cache 数据需要标注覆盖；目前缺整个 usage 的 run 被跳过，实报输入但没有 cached 字段的 run 也不进入分母，不能把该比例理解为所有请求的完整覆盖。
7. 当前圆环是 `role=status` 的可聚焦 div 和 popover，还没有独立详情页点击入口。

本阶段没有修改圆环 UI 或其选择算法。[圆环单测](../../packages/app/src/renderer/context-usage.test.ts)、[Session 聚合测试](../../packages/app/src/main/local-app-api/session-routes.test.ts) 已验证相关数据选择；未运行 Electron 视觉验收。

## 6. Memory 存储、检索、作用域与共享

- 基础设施支持仓库后端选择；本基线明确使用 v3。v3 文件权威根是活动 data root 下 `memory-tree/v3`，包含 atom、graph/resource、raw record 与派生检索/ledger；Session 保持 JSONL 和版本摘要。不能由 Memory v3 命名反推 CMv2 已实施。[v3-backend](../../packages/memory-tree/src/memory-repository/v3-backend.ts)、[atom-store](../../packages/memory-tree/src/v3/atom-store.ts)、[session](../../packages/session/README.md)。
- 先根索引 → branch index → expand；只有分支展开不足时允许该分支/subtree 的 deep_search。向量仅提名，不决定身份、权限或事实。[memory-tree](../../packages/memory-tree/src/memory-tree.ts)、[tree-memory-branch](../../packages/memory-tree/src/tree-memory-branch.ts)、[v3-retrieval](../../packages/memory-tree/src/memory-repository/v3-retrieval.ts)。
- Atom 检索候选 scope 为 global、当前 workspace、以 cwd 为 scopeKey 的 project、当前 session；存储 key 经 ledger 转换后按 scope/key 精确过滤。**project atom scope 当前绑定 cwd，不等于桌面 projectId**；不同路径同项目的共享行为要在 P1 明确。[retrievalScopes](../../packages/memory-tree/src/tree-memory-v3-presentation.ts)、[scopeAllowed](../../packages/memory-tree/src/memory-repository/v3-retrieval.ts)。
- Resource 可见性：global 共享、session/run 精确匹配；workspace/project 的资源路径允许同目录或后代目录访问。Atom 与 Resource 的边界规则不同，不能拿一个全局 scope 开关替代两者。[resource visibility](../../packages/memory-tree/src/memory-resource-branch.ts)。
- 同一 data root 内 global 记忆跨会话可见；不同 data root 的存储隔离；当前候选规则没有 behavior profile 专属 memory partition。这里只说明现状，不改共享或权限语义。
- durable memory 写入经 `memory_write`，每 run 最多四条，要求 user-request 或 necessary 来源；遗忘/纠正经 `memory_manage`。压缩只是摘要，不自动把所有会话沉淀为长期事实。[Memory README](../../packages/memory-tree/README.md)、[infra 工具组装](../../packages/runner/src/infra.ts)。
- Memory 的内部预算 `ceil(text.length/4)` 与 Context overflow 保护的 UTF-8 bytes + reserve 是两套不同近似；600 的检索预算不保证 Provider 恰好增加不超过 600 Token。[util](../../packages/memory-tree/src/util.ts)、[counting](../../packages/context/src/context-engine/counting.ts)。

## 7. Usage 与缓存账本

| 口径 | 当前含义与限制 | 证据 |
| --- | --- | --- |
| Provider input/output | `prompt_tokens/completion_tokens` 必须是有效非负整数；缺失不补 0；total 缺失才从两者求和 | [parseUsage](../../packages/llm/src/client.ts)、[client tests](../../packages/llm/src/client.test.ts) |
| 缓存读取 | DeepSeek `prompt_cache_hit_tokens` 或 compatible `prompt_tokens_details.cached_tokens`；是 prompt 子集 | 同上；[usage-state](../../packages/harness/src/usage-state.ts) |
| 未命中 | 实报 `prompt_cache_miss_tokens`，或在可用 hit 口径下对账；未知不能当完全 miss | [cache-provider reconciliation tests](../../packages/harness/src/cache-provider-usage-reconciliation.test.ts) |
| 缓存写入 | 可选 `cache_creation_input_tokens`；无实报则未知；不是“本地保存过 prefix”便证明 Provider 写入 | [parseUsage](../../packages/llm/src/client.ts)、[model-observability](../../packages/harness/src/model-observability.ts) |
| reasoning | 输出 reasoning 子集；不应再加一次到 completion 造成双计 | 同上 |
| 物理/逻辑请求 | attempt usage 在正文校验前交回并 durable 去重；错误/重试实报成本不消失；run aggregate 与某个请求快照不同 | [model-provider-receipt](../../packages/harness/src/model-provider-receipt.ts)、[usage-state](../../packages/harness/src/usage-state.ts)、[receipt tests](../../packages/llm/src/provider-response-receipt.test.ts) |
| 本地 exact | 模型专属已校验 tokenizer + framing；不支持的协议形状明确失败/未知；与 Provider 对账是额外证据 | [counter](../../packages/context/src/tokenizers/deepseek-v4-counter.ts)、[counting](../../packages/context/src/context-engine/counting.ts) |
| conservative safety | 序列化 UTF-8 bytes + 512 request reserve + 每图 32,768 reserve，用于溢出防护，`displayable:false` | [counting](../../packages/context/src/context-engine/counting.ts)、[contracts](../../packages/context/src/context-engine/contracts.ts) |
| LS context reuse | 本地装配复用，降低本地计算，不证明 Provider prompt 命中 | [cache-local-ledgers](../../packages/harness/src/cache-local-ledgers.ts)、[reuse-cache](../../packages/context/src/context-engine/reuse-cache.ts) |
| embedding reuse | 复用向量 vs 新排队向量，单位实为事件/向量数；旧通用 ledger 用 tokenCount 字段承载，详情页不可标成模型 Token | [cache-local-ledgers](../../packages/harness/src/cache-local-ledgers.ts) |

基线中 coding 的“去掉 schema 但保留 tool history”对照被现有精确计数器拒绝，因为该协议形状未校准；报告将这项 ablation 标为 unavailable，未换用字符估算补出一个精确值。

## 8. Context Trace 最小实现与兼容

公开入口：[buildContextTrace](../../packages/context/src/context-trace.ts)，从 [index](../../packages/context/src/index.ts) 导出。输入为同一个 request/context snapshot；核对 id、run、session、provider、model 的关联。输出：

```text
version:1 + boundary:prepared_chat_request + requestIndex
sources[]: kind/scope + included/omitted item counts + UTF-16 character counts
coverage: items/messages/tools complete|partial + rejectedItems
          sourceTokens/toolSchemaSize unavailable
messageCount/toolCount
tokens.local: exact(promptTokens)|unavailable
tokens.provider: reported(input/output + optional cache/reasoning subsets)|unavailable
compressionRecommended
```

采用 allowlist 枚举，未知 kind/scope/disposition 不透传。省略正文、sourceRef/path、id、hash、toolName、model/provider 自由文本和 unavailable reason；不展开 raw request，不再次 tokenization，不增加默认 IO。调用方仍须授权读取所属 session/run，本 helper 不是权限系统。[privacy tests](../../packages/context/src/context-trace.test.ts)。

保留两个真实缺口：工具定义不在 ContextSnapshot.items，旧日志无法恢复 schema 大小；逐来源 promptTokens 在当前快照没有生产计数。不能用 Provider 总量按字符比例分配。完整/部分状态仅描述已有快照覆盖，不宣称还原整个 wire payload。

已修复两处诊断元数据丢失：`spliceTailMessages` 保留 scope；tool loop 后续 tail delta 同步保留 kind/source/scope。只修改 side-map，不移动/改写 outbound message，不改 Atom 可见性。[修复](../../packages/harness/src/run-tail-ledger.ts)、[loop](../../packages/harness/src/stages/execute/tool-loop.ts)、[scope/字节保持测试](../../packages/harness/src/run-tail-ledger.test.ts)。

没有新增持久格式，因此旧 ContextSnapshot/ModelRequestSnapshot 不需迁移；旧日志缺关联时返回 undefined；local/provider 缺失分别保持 unavailable；截断是 partial。现有快照每 run 最多 64 组、每组 item/message/tool 最多 64，保留首项与尾部；不能承诺任意长会话的逐请求永久完整时间线。[snapshot limits](../../packages/context/src/context-engine/contracts.ts)、[snapshots](../../packages/context/src/context-engine/snapshots.ts)、[log retention](../../packages/runner/src/execution-log.ts)。

## 9. P0B 独立页面最小集成建议（尚未实施）

| 边界 | 最小改造 |
| --- | --- |
| Shared contract | 一个 content-free response DTO：所属 session/run/request 身份（由 Main 附加）、时间/model、Trace、缓存三账本、coverage 和 legacy 状态；公共类型复用 Context 包出口，不另起模型 usage 类型 |
| Main | 在现有 Local App API sessions/run 体系中增加只读 `GET /api/sessions/:id/context`（建议契约，实际常量由路由模块统一定义），支持 request cursor/limit；先校验 session 所有权，再从授权 ExecutionLog 关联投影；不把所有日志直接传给 Renderer |
| Runner 日志 | 复用 ExecutionLog、durable usage receipt 和 cache observation；历史列表按请求分页/按模型分组。将压缩作为独立 operation，分别显示 cost 与 current context，不改变账单累计 |
| Renderer API/controller | 一个 `api/context` 与独立 context-inspector view state；选择项必须包含 sessionId/model/request 身份，防止切会话异步响应串台；页面只读，打开不触发 model/Memory 检索 |
| 入口 | 将现有圆环改为有可访问名称的 button；点击、Enter/Space 打开正式详情页面；保留窗口/未知/缓存摘要，关闭返回原会话并恢复焦点；不在 hover popover 塞整个 Inspector |
| 页面 | 总 input（本地/Provider 分开）+ output/cache/reasoning + 来源字符/项目数 + budget/压缩 + 请求历史变化 + 覆盖/未知提示；不显示“精确来源 Token 饼图”直到逐来源计数真实存在 |
| 日志缺口 | 可选在现有请求 snapshot 增加纯数值工具 schema 大小/版本，按需计数并保留 unavailable；最终 Provider body hook 仅测数值与带本地密钥的指纹，不能记录 raw body；这是后续方案，本阶段未改持久协议 |
| 验收 | Main 所有权/分页/旧日志/缺 usage/截断；Renderer 切会话/模型/打开关闭/键盘焦点；真实 Electron 圆环点击；隔离 Provider 验证 input/cache 子集与回执。避免用单元测试代替真实 UI/Provider |

## 10. 风险、未解决项与后续阶段

1. **原文既有持久路径**：当前 Runner 设置 `streamModelTranscript:true`，`emitSystemPromptTranscript` 汇总所有 system 消息并赋值 `systemPromptProjection`，ExecutionLog 可存该字段。它可能包含 SOUL/USER/索引/已注入片段。新 Trace 不使用它，也没有增加原文持久化；但不能声称整个现有产品日志已 content-free。该路径有历史产品披露意图，需要 P0B/P1 明确 UI 展示与诊断持久化的边界。[transcript](../../packages/harness/src/system-prompt-transcript.ts)、[Runner](../../packages/runner/src/runner.ts)、[ExecutionLog](../../packages/runner/src/execution-log.ts)。
2. Snapshot 的 SHA-256 和 sourceRef 仍可能暴露相等性或路径；新公开 Trace 删除这些。现有 cache observation 使用本地 HMAC key，二者不可混为相同隐私级别。[snapshots](../../packages/context/src/context-engine/snapshots.ts)、[cache observability](../../packages/harness/src/cache-observability.ts)。
3. 旧历史重放把部分 Runtime tail/tool result 归入 recent_message；本次 scope 修复解决新 tail 的丢失，但没有回写历史数据或建立逐条历史 provenance。详情页必须说明“当前快照分类”与“原始注入类别”可能不同。[context-candidates](../../packages/harness/src/context-candidates.ts)。
4. memory_index 为 global 注入类别，已展开的 atom 仍有自己的 scope；Trace 是请求 segment scope，不应直接作为记忆共享权限视图。project atom 以 cwd 为 key 与 Resource 后代路径可见规则留待 P1 决策。
5. 原生工具稳定目录与自动尾部有能力/缓存理由。此次测出固定成本，不构成删除这些能力的授权；P2 的精简应同时评估任务成功、缓存失效与费用。
6. date-time、目录变化、profile、Skills 名称列表/工具 schema、root index 变化都可能改 prefix。必须用已有 cache fingerprint/diff 与真实 Provider hit 证据评估，不能仅从 marker 推断命中。
7. 本地 tokenizer 对模型命名/framing 有专门校准且会变动；本报告数字仅对本次固定 revision 的对照成立。未验证真实服务当前 framing，未执行真实用户 6K 回放。
8. baseline 单样本是后续回归起点。正式性能比较仍需要固定更长任务、重复样本/P50/P95、warm/cold 分离，以及真实 Provider TTFT、input/output/cache 账本；不在 P0A 静默开展这些长跑或大规模重构。

## 11. 验证记录

- 新 Trace 隐私/跨 session-model 关联/未知枚举/缺 usage：4 tests 通过；tail scope 与消息保持：7 tests 通过；六场景隔离 baseline 通过，真实隔离 read 成功，summary_memory/memory_fragment/tool_result 注入断言通过。
- 最终默认离线联跑：Provider 解析、物理 usage receipt、缓存对账、request shape、append-only prefix、组装 characterization、圆环、Session 聚合、Trace 与六场景 baseline，共 11 个文件、128 tests 全部通过。baseline 初次工具消融因不支持协议形状失败，修正为 explicit unavailable 后本地计数运行也通过。最后离线联跑的 Trace 均值约 5.2–5.9 µs，表中 3.2–4.2 µs 属于前一次有 tokenizer 的采样；小样本波动不作为性能收益证明。
- TypeScript 全 workspace 与 `check:repo` 通过；仓库现有 3 类 advisory（热点计数/上限/登记漂移）不代表新行为失败。
- `pnpm run verify:core` 通过：5 个测试文件、73 tests，加仓库卫生与全 workspace TypeScript；gate 报告 executed=3、skipped=3，不把未选择的 gate 步骤当作通过。新增文档后再次 `check:repo`、TypeScript 与 `git diff --check` 通过。未运行真实 Electron、线上 Provider、完整打包或全量性能门。

P0A 交付到此停止。P0B 页面、P1 scope 权限、Prompt 精简与模型路由均未实施。
