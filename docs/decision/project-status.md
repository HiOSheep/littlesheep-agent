# LittleSheep 项目状态

最后更新：2026-08-03 01:50:17

本文件是项目进度的正式来源。状态只根据当前源码、测试和构建结果维护；旧的阶段报告不再作为进度依据。当前实现若处于未完成重构或质量门失败状态，必须明确写成“进行中”，不能沿用最近一次绿色基线冒充当前状态。

## 总体判断

LittleSheep 当前是一个**可运行的本地 Agent alpha 原型**：核心状态机、任务执行、索引优先记忆、版本化会话摘要、桌面聊天界面、拓展工作区和可选外部渠道已经形成完整工程骨架。真实 Electron 进程生命周期、跨重启会话与 Checkpoint 恢复已经形成可重复验收基线，下一步可以集中验证真实供应商长任务、持续负载和用户场景。

它还不是可直接宣称“生产就绪”的发行版。当前 DeepSeek 活动模型的基础 chat、continuity、tool 和 abort 已真实通过；DeepSeek V4 官方 tokenizer 与普通直接回答请求的最终 framing、本地精确账本和同请求 Provider usage 已完成零差值对账。包含历史 `tool_calls` 或 `tool` 结果的工具续轮仍未完成 Provider 校准，本地精确计数会失败关闭，等待响应后只采用真实 Provider usage，不冒充精确。OpenAI/GLM 尚无经过同等验证的本地精确计数器，未配置时更不能冒充已校准。隔离数据根验收已通过真实 Electron 启动、关闭、托盘恢复、强制终止、重启和 Checkpoint 续跑；2026-08-03 又用真实 DeepSeek 验证了完整退出重启后的最终回答连续性。它们仍不等于 DeepSeek 多步骤长任务、持续负载、MCP、安装包发布或完整用户场景已经闭环。因此本项目不使用一个没有权重定义的百分比来伪装精确进度，而用能力状态和验收证据表示总进度。产品方向已明确为：解放用户生产力，让用户专注于想法，LS 负责将想法可靠落地；执行和输出统一采用渐进式披露。

**当前阶段：Memory v3 阶段 0-26、统一 Tool Execution Service、工具调用级与 TaskBook 步骤级有界并行、运行时事件安全边界与 Renderer 生产入口、TaskBookPatch、Runner 检查点续跑、应用启动恢复控制面、活动任务快照与控制、托盘、三档关闭策略、设置页“应用与后台”、shadow Git 检查点、退出冻结、前台实时 Provider API 表达来源/去重闸门、回答级记忆连续性判断、逻辑容器权限闸门和 LS 开发环境版本管理已有工程基线。语义活动 `respond / execute / clarify`、直接回应紧凑 Prompt、有界历史、选择性上一轮摘要、结构验证快路径、无进展熔断和工具循环后续请求紧凑化已通过完整质量门及真实前端 Runner 验收。当前 DeepSeek 模型四项真实校准、普通直接回答的 V4 本地精确 tokenizer 对账、真实 DeepSeek 跨重启最终回答连续性，以及隔离数据根中的 Electron Checkpoint/后台控制验收均已通过；下一主线是真实 DeepSeek 多步骤长任务、工具续轮 tokenizer 校准、持续用户负载与单工具 Context 成本的实测收敛。**

- 后端继续使用连续、可衰减且无固定层数的 activation score；任务相关度、scope、证据和认识状态先于 activation。前端只显示带滞回的高/中/低三层汇总，不把三层写回后端。
- 正式数据根已有 40 个业务 Atom、5 个内部 scope root、11 个资源、45 条本地 512 维向量；Catalog schema v9、TaskBook 二次注入、KnownState、working set、关系调和和版本化摘要链路已完成隔离质量门。
- 阶段 19 已把最终 VERIFY、TaskExecution、Provider token 和两次运行时资源采样纳入只读报告。2026-07-29 重新读取 46/46 个执行日志：15 个有记忆访问、0 个有 KnownState、0 个报告显式 Atom 使用、12 个有 Provider usage、1 个有最终 VERIFY、10 个有资源采样。只有 Provider usage 达到单项门槛，整体仍为 `insufficient`，因此不调整 activation 参数。
- 阶段 20 已退役 Memory v2 的 archive 摘要写入、旧 vector 装饰写入和 CLI archive adapter；既有 archive/vector 数据保持原样，只读兼容路径不能创建摘要、向量或 Atom。阶段 20 当时的验收基线为 180 个文件、1317 passed、1 skipped。2026-08-03 当前工作树为 254 个测试文件、1734 passed、1 skipped；仓库卫生 33/33、全量测试、27 包 typecheck、Electron build、恢复源检查、隔离 Electron Runtime 连续性和真实 DeepSeek 跨重启回答连续性验收均已通过。
- 阶段 21 已把版本化会话摘要覆盖的 source run 与 daily Atom 对齐，完成有界、确定性的一对一提升：每次最多扫描 256、处理 8 个候选，先提交 project/long-term/experience T2 目标，再按 expected revision 归档源；写入或归档失败保留 daily 源，整个维护流程不增加 LLM 调用。
- 阶段 22 已把重复 Atom 合并接入独立调和闸门：模型只可引用本轮已 adopted、未冲突且 revision 匹配的 KnownState Atom；Runtime 再校验 scope、parent、认识边界、语义锚点和冲突/替代关系。单轮最多 2 个提案、每项最多 4 个 source，部分失败保留未提交 source 并支持幂等重试；阶段 22 本身不开放任意内容重写或层级重组，后续层级能力由阶段 23 单独治理。
- 阶段 23 已把显式关系驱动的叶子 Atom 跨 parent 调整接入独立层级闸门：单轮最多 1 项，只接受本轮 adopted 的当前 D2/D3 Atom 与目标 parent，并要求同 scope、active/resolved 且有证据的 `belongs-to`/`derived-from` 正向关系。Runtime 负责叶子、revision、关系强度、提交、恢复和审计；超额提案明确拒绝，不静默丢弃。非叶子子树移动由阶段 26 的独立协议治理。
- 阶段 24 已把同一陈述的内容澄清接入独立修订闸门：单轮最多 1 项，只接受本轮 adopted、当前 revision、未冲突、未截断的完整 D3 Atom，并要求当前 run 的通过验证证据。Runtime 只允许 title/summary/content/retrievalKeys 的澄清、规范化和去冗余，独立校验语义保留与硬锚点；来源、证据、实体/关系、层级、认识状态和生命周期不变。
- 阶段 25 已把事实纠正/冲突替代接入独立 correction 闸门：单轮最多 1 项，只能引用本轮完整 D3、当前 revision 的两个既有 Atom，并要求通过的 VERIFY、Runtime evidence、同 branch/scope/parent/statement kind 边界、足够权威的 replacement，以及方向正确且已 resolved 的 `replaces`/`conflicts-with` 关系。提交只把旧 Atom 标记为 superseded 并指向 replacement，保留旧正文、来源、证据和历史；响应丢失后可由管理读取恢复并返回 noop。跨陈述扩写仍未开放，非叶子移动由阶段 26 独立治理。
- 阶段 26 已把有证据约束的非叶子子树重组接入独立 subtree 闸门：单轮最多 1 项，只接受本轮完整 D3、当前 revision 的非叶子根与目标 parent，并要求同 branch/scope、通过 VERIFY/evidence、方向正确的 active/resolved 有证据关系和最多 128 个 active descendants。Runtime 只移动根 `parentId`，后代父链、revision、正文和来源不变；真实 V3 Backend 已覆盖 Catalog 有界计数、投影记录、重启和响应丢失 noop 恢复。真实 Provider 提案质量和超大子树治理仍待验收。
- 前台 Agent 自然语言已经建立实时 API 来源与持久化去重闸门：每条新的 REPLY、ASK_USER、RECOVER 或 TaskBook 最终交付都必须在当次 run 中实时调用当前 Provider API，由 LLM 现场生成并携带绑定 `modelRequestId`、request index、provider 和 model 的 `ReplyProvenance`；这不是候选文案生成或 Runtime 选稿。`FINALIZE` 回查不到真实请求时直接拒绝。API 返回在发布前进入会话级 SHA-256 注册表并原子占用规范化指纹；完全重复时最多重新实时调用两次当前 Provider API。空回复、注册表失败、模型失败或重新生成耗尽只留下 Runtime 错误/状态，Renderer 不生成固定 Agent 文案，也不存在模板库或预置文案库。
- FINALIZE 已增加回答级记忆连续性评估：本地评估实际发布且可由 `ReplyProvenance` 回查的 LLM 回答，与真实进入本轮因果模型调用链的 active/adopted Atom、版本化会话摘要和近期跨轮对话之间的独立锚点，并把 `supported / discontinuous / uncertain / not_applicable / unavailable`、Context 可观测性、来源、命中 Atom 和诊断写入 `AgentResult` 与执行日志。当前输入自身的词只证明回答贴合本轮；TaskBook 中由记忆介入后补出的细节仍可形成承接证据。任务续接和“你还记得上次的代号/颜色吗”这类直接记忆追问都会进入显式连续性门；明确追问多个历史字段时，最终回答必须逐项答出对应旧值，只有复述附带限制、漏答任一核心字段、用否定句提到旧值、明确说不记得或要求用户重新提供，均不能算连续。字段旧值按“近期可观察消息 → 已进入调用链的版本化会话摘要 → 已采用且仍 active 的记忆”逐项解析，因此原始轮次压缩后仍可从真实介入的摘要或 Atom 证明连续；纯记忆追问不会因此注入无关的上一轮工具耗时。只有 `supported` 可通过续答连续性门，`discontinuous`、`uncertain` 和 `unavailable` 都不能被 UI、Runtime 或验收脚本描述为“记忆连续”。Context Engine 已裁掉的来源、缺少请求快照的来源、释放/排除/冲突 Atom 均不计命中；执行中由 `memory_tree` 展开的 Atom 只有在对应工具结果确实进入后续模型请求时才可计入。回答实际采用的 Atom 或摘要只形成有界 routing/activation 反馈，不提高事实 confidence 或 verified usefulness，也不增加 Provider 调用。最新定向回归覆盖最终回答、Runtime 摘要隔离和记忆反馈；完整质量门数字见下方验证表。确定性验收 Provider 的七场景 Electron 门仍通过；真实 DeepSeek 隔离验收另外完成一次完整退出与重启，当前问题不含旧答案，最终回答仍原样给出代号 `deepseek-electron-continuity-anchor-6824` 和颜色“琥珀色”，判定 `supported`、`matchedSources=[recent_history]`。
- 2026-07-31 的真实前端 Runner 验收已验证两条路径：直接回应精确返回指定内容，仅 1 次 `reply` 模型请求、0 工具调用、`3.727s`，Provider usage 为 `975 + 12 = 987`；显式单步 `glob` 任务只调用 1 次工具，无重复轮次，`VERIFY` 结构快路径耗时 `0ms`，总耗时 `13.666s`。后者仍使用 `DECIDE 1 次 + EXECUTE 2 次`，三次 Provider usage 累计 `16,316` tokens，说明正确性与无进展熔断已收口，单工具 Context 成本仍是待优化的可量化边界。
- 2026-08-02 23:10:30 工具循环完成第一轮请求紧凑化：首轮仍保留最多 8 条有界历史和必需附件 manifest；首次工具结果之后，后续模型请求只保留最近 2 条历史、附件 manifest、当前用户消息、系统/步骤契约以及已产生的工具证据。没有减少真实 LLM 调用，也没有删除工具 schema、权限判断或工具结果。Harness 回归已验证旧历史被裁掉、最近历史/manifest/工具结果仍在；真实 DeepSeek Provider usage 与耗时的前后对比仍待长任务验收，当前不宣称具体 token 节省比例。
- 同日运行中 Main 对 `deepseek/deepseek-v4-flash` 完成四项脱敏真实校准：chat `872ms`，精确回复 `OK`；continuity `1,140ms`，正确采用最新值且未重复追问；tool `1,680ms`，只调用一次探针工具并正常收尾；abort `389ms`，在收到流式 chunk 后中断并返回 `AbortError`。当前 DeepSeek 凭证因此已被实测为有效；OpenAI/GLM、真实 Provider 长任务和达到校准门槛的持续真实负载仍未完成。
- 2026-08-01 已接入 DeepSeek V4 官方固定 revision tokenizer 资源和普通消息、thinking、工具定义的最终请求 framing。资源按固定大小与 SHA-256 下载后原子校验，计数使用真实 token id 数量；普通 `/run` 与 2026-08-03 最新真实跨重启回答验收均保持本地 prompt 与 Provider prompt 零差值，后者三次请求分别为 `1008/1008`、`387/387`、`1292/1292`。真实工具续轮含历史 `tool_calls`/`tool` 结果时，本地曾为 `3743`、Provider 为 `3824`，差值 `81`；因此该请求形态已从 exact 能力中移除并失败关闭，响应完成后使用 Provider usage。OpenAI/GLM 继续明确为 unavailable，旧会话没有历史最终载荷时显示“本会话尚无本地计数”而不伪造数字。
- 统一 Tool Execution Service 已迁入 `@littlesheep/tools`：内置、插件和 run-scoped 工具共享查找、schema 校验、权限与单次批准、超时/中断、资源冲突调度、结果清洗、事件和有界 `ToolInvocationRecord`。Harness 只保留模型循环、TaskBook 编排和副作用检查点生命周期；Execution Log 优先持久化权威调用记录，旧日志才使用消息推断兼容路径。
- TaskBook 步骤级有界并行已接通：DECIDE 可为步骤声明 `serial/parallel`、前置依赖、资源读写集合与副作用；Runtime 默认并发 2、硬上限 4，串行步骤形成屏障，缺少完整契约、需审批、容器外资源、未知/外部副作用或冲突路径自动退回串行。每个并行分支有独立取消信号，分支内工具并发固定为 1；结果与消息按 TaskBook 顺序稳定归并，恢复时已完成兄弟分支不重做。`RunCheckpoint` 同时有界保存最多 4 个活动步骤，旧 `currentStepId` 保持兼容。
- 运行时任务事件已接入 Renderer 生产入口：活动 run 中的输入会追加到当前任务而不是误开第二个 run；普通消息、设置变化和工作区文件保存分别发送有稳定身份的事件。只有 `accepted` 或 `duplicate` 会清空输入，`expired`、`conflict`、`rejected`、队列满和网络失败会保留用户输入并显示 Runtime 状态；响应丢失重试复用同一事件 id 与去重键。停止和追加任务保持独立，所有临时状态提示共用一个可清理计时器。
- 应用启动恢复控制面已接通：Main 启动时把上一进程遗留的 `resuming` 租约转换为可审计的 `interrupted`，并允许新 run 原子重新领取；Local App API 提供有界列表、详情、放弃和 SSE 续跑入口。Renderer 启动时按渐进式披露显示未完成任务，可查看现场、补充澄清、继续、停止或放弃；恢复完成后强制重载对应会话。完整 Context、工具输入和敏感正文不会进入列表响应，不确定外部副作用、模型不匹配和不可恢复附件仍由 Runner 拒绝。
- 活动任务后台控制面已接通：Runner 持有独立于 Renderer SSE 的中断信号，并提供有界活动快照、进度订阅及暂停、继续、中断；暂停在安全边界生成 `paused` 检查点，历史与重启恢复明确显示“已暂停”。Main 聚合当前与最多 4 个仍持有活动任务的退役 Runner，空闲后释放；Local App API 提供活动任务列表、`active_runs` SSE 与控制路由。设置页“应用与后台”可配置始终后台、仅活动任务时后台和始终退出三档策略，并以渐进式披露展示真实活动任务、步骤、进度、来源和运行标识；页面卸载会中止流、请求和重连计时器，Main 监听器有硬上限并在断连时释放。托盘最多展示 6 个任务，可显示应用、暂停/继续、中断和彻底退出；只有托盘成功创建时才允许隐藏窗口。2026-07-30 的真实窗口冒烟已验证设置入口、三档策略切换与恢复、同步状态、空任务态、手动刷新和全局前进/返回。2026-08-02 的隔离真实 Electron 验收进一步覆盖活动任务 SSE、关闭到托盘并恢复、暂停后继续、强制终止后从暂停 Checkpoint 恢复、运行中模型热切换和中断后生成可恢复 Checkpoint；真实 DeepSeek 持续长任务、断线重连压力和长期资源回落仍待验收。
- 2026-07-30 以同一专项回归复核后台连续性：20 个测试文件、83 项全部通过，覆盖窗口关闭策略、活动任务快照与控制、SSE、Renderer 状态归并、检查点租约释放与重新领取、重启续跑不重复原始输入、外部副作用拒绝、步骤/工具有界调度和监听器生命周期。该时间点只证明本地契约连续；真实 Electron 生命周期缺口已由 2026-08-02 的隔离七场景验收补齐，但真实 DeepSeek 长任务和真实外部副作用仍不由此替代。

## 能力总览

| 能力域 | 状态 | 当前结论 | 主要位置 |
| --- | --- | --- | --- |
| 架构治理 | 仓库基元化阶段 0-7 已完成 | 27 个 package 与指定领域目录均有所有权 README；关键组合入口已收敛为 facade。`check:repo` 自动校验文档、模块和 TypeScript references；单进程 `tsc -b`、受影响包传播和 changed/core/full 三级验证已接通，避免依赖方读取旧声明并降低日常反馈成本 | `docs/reference/repository-guide.md`、`docs/reference/module-split-map.md`、`scripts/workspace-projects.mjs`、`scripts/run-affected-verification.mjs` |
| LLM 调用契约与记忆提交 | 已实现工程闭环 | 每次模型请求解析独立 `LlmCallContract`，声明 purpose、Context、决策、输出、工具、记忆和预算；每轮有独立模型调用计数与硬上限；`CAPTURE` 默认按真实持久化状态确定性记录，`EVOLVE` 自适应调用。用户可见 Agent 自然语言必须在当次 run 中实时调用 Provider API，由 LLM 结合 `SOUL.md`/profile 现场生成，并通过 `ReplyProvenance` 绑定真实 model request；完全重复时最多重新实时调用两次 API，失败只返回 Runtime 状态。UI 状态与机器事实由 Runtime 固定提供，`FINALIZE` 禁止新增模型调用，只校验和持久化既有 API 回复。模型描述 statement/source，Runtime 独立决定 epistemic status 与 authority | `packages/types/src/runtime-contracts.ts`、`packages/types/src/message.ts`、`packages/harness/src/llm-call-contracts/`、`model-observability.ts`、`user-facing-reply.ts`、`stages/ask_user.ts`、`stages/capture.ts`、`stages/execute/final-reply.ts` |
| Context Engine | 主要数据链、调用契约与直接回应/工具续接瘦身已实现；DeepSeek V4 普通直接回答精确计数已闭环，工具续轮校准与其他 Provider 待补齐 | 支持确定性候选、来源 segment、契约过滤、阶段软预算、真实模型窗口硬上限、版本化 Summary Memory、附件清单优先、按需附件工具、Provider usage 绑定和双账本 UI。DeepSeek V4 普通回答使用官方固定 revision tokenizer 和最终请求 framing，本地账本优先显示、Provider usage 作同请求校准；含历史 `tool_calls`/`tool` 结果的续轮在校准完成前不生成 exact 本地账本。OpenAI/GLM 未验证时同样不显示伪精确数字。`respond` 路径只保留身份、能力名、受限记忆索引、`USER.md`、相关摘要/Atom、最近 8 条且最多 6000 字符的历史与紧凑输出约束；`execute` 工具循环首轮保留完整必要上下文，首轮工具结果后保留最近 2 条历史和必需附件 manifest，仍需真实 DeepSeek 长任务对比实际 usage 与耗时 | `packages/context/src/engine.ts`、`context-engine/`、`packages/context/src/tokenizers/`、`packages/types/src/token-ledger.ts`、`packages/harness/src/context-candidates.ts`、`packages/harness/src/stages/execute/tool-loop.ts`、`model-observability.ts` |
| 运行时时间与执行感知 | 基础闭环与直接回应介入条件已验收 | 每次实际模型请求仍在缓存边界后注入当前时间和本轮状态。普通直接回应只使用紧凑时钟；只有用户明确询问进度、状态、结果、耗时、成功/失败、错误、恢复或“刚才/上一轮/上次”时，才注入上一轮有界执行摘要和最近工具计时。正反向回归均已覆盖，普通闲聊不会被旧执行详情污染 | `packages/prompt/src/runtime-time.ts`、`packages/harness/src/runtime-awareness.ts`、`model-observability.ts`、`stages/execute/tool-loop.ts`、`packages/runner/src/session-run-summary.ts`、`execution-log.ts` |
| 应用数据根、默认 workplace 与附件生命周期 | 阶段 3 工程实现已完成 | 完整应用数据根默认名为 `.littlesheep`，但可通过环境、locator 和设置整体迁移；`workplace/` 只是未选择其他目录时的默认工作区子目录。粘贴/浏览器导入进入独立受管缓存，按 30 天、256 项、512 MiB 有界清理；workplace 使用可恢复的有界元数据索引，不读正文。设置页可登记完整数据根迁移，下一次启动会在任何写入者初始化前通过外部 locator、同级 staging、全文件 SHA-256 清单和活动元数据路径重绑定完成原子切换；源目录保留，失败继续使用旧目录，提交中断可恢复，回滚同样在下次启动生效。隔离测试已覆盖这些契约，尚未擅自搬迁正式用户数据 | `packages/branding/`、`packages/app/src/main/attachment-cache.ts`、`data-root-migration.ts`、`data-root-metadata.ts`、`packages/memory-tree/src/workspace-resource-index.ts` |
| 长会话压缩与 daily 提升 | 本地连续性门、首版提升、重复投影调和、叶子层级纠正、同陈述修订、事实纠正/冲突替代和非叶子子树重组闸门已完成 | 原始 JSONL 不删除；摘要版本化、记录来源范围和最近 64 个 source run，支持增量合并，并在下一轮作为独立 `summary_memory` 介入。真实指代且近期消息缺少任务锚点时才回退摘要；压缩后只对明确覆盖、符合认识边界的 active daily Atom 做有界一对一提升，先写目标再归档源，失败保留源且不增加模型调用。重复投影合并、叶子跨 parent 调整、同陈述内容澄清、事实替代和有界子树移动都只允许模型提出、Runtime 校验和原子提交；真实 Provider 长会话、摘要生成失败、提案判断质量、跨陈述重写、超大子树治理和成本仍待验收 | `packages/session/src/compaction.ts`、`compaction-store.ts`、`packages/memory-tree/src/memory-consolidation.ts`、`memory-reconciliation.ts`、`memory-hierarchy.ts`、`memory-subtree.ts`、`memory-revision.ts`、`memory-correction.ts`、`packages/runner/src/runner.ts` |
| 硬控制流 Agent | 基础状态机与语义活动迁移已实现 | Runtime 继续控制 `ENTER`、内部 stage、权限、工具、验证、恢复和收尾；模型只在有界活动路由中选择 `respond / execute / clarify`。内部 `classify` stage id、旧 `chat / problem / unclear` 会话与插件字段暂时保留兼容，不再作为新架构语义 | `packages/types/src/agent.ts`、`packages/classifier/`、`packages/harness/src/stages/classify.ts`、`packages/runner/` |
| 需求判断与任务书 | 已实现 | 支持澄清请求、复杂度判断、TaskBook、步骤验收和局部重规划；TaskBook 公共契约已与状态机/RunContext 分文件维护 | `packages/types/src/task.ts`、`packages/harness/src/stages/` |
| 工具统一执行与调用级并行 | 工程基线已完成 | `ToolExecutionService` 是工具查找、输入校验、权限/单次批准、超时、中断、执行、资源冲突调度、输出清洗、事件和有界调用记录的唯一宿主边界；内置、插件与 run-scoped 工具保留来源。默认并发 4、硬上限 8；冲突或未知副作用串行，结果按原始调用顺序归并。Harness 只拥有模型循环、步骤编排和副作用检查点钩子；网络权限、MCP 接入和更强授权 token 仍是后续扩展 | `packages/tools/src/tool-execution-service.ts`、`tool-execution-{scheduler,control,records,result}.ts`、`packages/harness/src/stages/execute/tool-loop.ts`、`packages/runner/src/run-tools.ts` |
| 步骤级执行与恢复 | TaskBook 步骤级并行工程基线已完成；真实长任务待验收 | 保留已完成步骤证据，失败或恢复时不重复执行已完成部分；步骤显式声明依赖、资源读写集合与副作用，Runtime 只并行无依赖、无冲突且权限明确的分支。默认并发 2、硬上限 4，串行步骤为屏障，分支取消独立，工具实际资源越过步骤封套时拒绝；消息、工具结果和执行证据按 TaskBook 顺序稳定归并。检查点可记录多个活动步骤，真实 Provider 长任务、崩溃时并行副作用和性能收益仍待验收 | `packages/harness/src/stages/execute/task-{book,step}-runner.ts`、`task-step-scheduler.ts`、`execute/tool-loop.ts`、`packages/tools/src/tool-execution-service.ts`、`packages/runner/src/run-checkpoint.ts` |
| 记忆树运行时协议 | 已实现基础闭环并通过相关性、动态工作集、多轮任务语义、关系路由与 TaskBook 调和门 | 根索引到分支索引再到展开/分支内深搜；D1 在 branch/scope 内先用 FTS 找精确候选，再补 80 个近期候选。首次 prime 最多选择 2 个 D2 Atom、预算 600 tokens；DECIDE 后的结构化 TaskBook 可再补最多 2 Atom/400 tokens，单 run 最多 4 次且重复 query 跳过。goal、验收标准和目标步骤分别评分，避免扁平长文本稀释相关性。高相关种子仍只做一次有界同 scope 关系扩展，D1 不调用向量；release 后真实请求删除对应正文，KnownState 同步排除，重新展开只恢复最新副本 | `packages/memory-tree/src/task-query.ts`、`memory-prime-selection.ts`、`memory-tree.ts`、`memory-service/run-coordinator.ts`、`packages/harness/src/memory-taskbook-refinement.ts`、`memory-context-working-set.ts` |
| Memory Service 与 Memory v3 | 正式 backend 已切换并完成数据、向量、规模、相关性、反馈演化、多轮任务语义、压缩连续性、关系选择、写入认识边界、关系调和、叶子层级重组、非叶子子树重组、同陈述内容修订、TaskBook 二次注入与跨缓存动态 activation 验收 | v3 使用对话原始来源、投影变更记录、Atom projection、run working set 四层模型。持久 Atom 与语义缓存共享连续、有界、惰性衰减的 activation 计算，但 namespace、TTL 和删除规则隔离；真实采用并产生任务价值才升温。任务相关度、scope、证据与认识状态始终先于 activation，冷 Atom 仍可由精确 FTS/索引找回。`InjectionTier` 继续表示稳定注入策略，不充当热度层级；结构与内容投影变化只能经显式 Runtime 闸门提交，原始对话来源不改写 | `packages/types/src/activation.ts`、`packages/memory-tree/src/v3/activation.ts`、`memory-repository/v3-retrieval-activation.ts`、`memory-reconciliation.ts`、`memory-hierarchy.ts`、`memory-subtree.ts`、`memory-revision.ts`、`packages/session/src/compaction-store.ts` |
| 项目身份与路径重绑定 | 已实现基础闭环 | 新项目使用与路径无关的稳定 ID，旧路径派生 ID 原样保留；项目移动或重命名后可从侧边栏重新定位。持久化事务日志幂等迁移会话、归档、记忆 scope、项目投影、工作区文档资源、产物、终端活动、布局、导航状态和当前运行路径；路径冲突会拒绝提交 | `packages/app/src/main/project-index.ts`、`project-rebinding.ts`、`path-rebinding.ts`、`packages/memory-tree/src/memory-service.ts` |
| 用户记忆文件视图与 Runtime 治理 | 用户视图已收敛；Runtime v3 治理保留 | GUI 的“记忆树”只读取活动数据根中的六份记忆文件，当前仅 `SOUL.md` 可写；同时只读展示合并后的高/中/低三层 activation 计数。Atom、连续分数、内部阈值、关系、向量与来源明细不进入普通 Renderer，三层投影也不写回后端。Runtime 仍通过同一 Memory Repository、内部治理接口和迁移工具完成 D0-D3、连续 activation、移动/合并/失效/恢复、证据导出、Catalog 与本地 BGE 维护，不建立展示副本 | `packages/app/src/renderer/MemoryTreeView.tsx`、`packages/app/src/main/memory-files.ts`、`packages/app/src/main/local-app-api/memory-routes.ts`、`packages/memory-tree/`、`packages/prompt/src/sections.ts` |
| 执行记录与历史重放 | 已实现 | 已完成 run 的 TaskBook、步骤、权威 `ToolInvocationRecord`、验证、调用契约、Context 快照、记忆意图运行时判定、有界资源 ID 和两次粗粒度资源快照可持久化并重放；记录只保留输入哈希/键摘要和输出状态，不保存完整敏感输入输出。旧日志缺少统一记录时才从 tool message 推断兼容证据。执行日志负责历史重放，活动 run 的续跑另由版本化 `RunCheckpoint` 负责，两者不互相冒充 | `packages/runner/src/execution-log.ts`、`packages/tools/src/tool-execution-service.ts`、`packages/runner/src/runtime-resource-observation.ts`、`packages/app/src/renderer/TraceCard.tsx` |
| 数据/工作区版本与运行检查点 | 数据版本、应用启动恢复与隔离 Electron 跨重启基线已闭环；真实 Provider 副作用长任务待验收 | LS 数据根和用户工作区使用不污染已有 `.git` 的独立 shadow Git；写入前 preimage、run before/after manifest、同步回退、partial 诊断和退出 `shutdown-freeze` 已接通。`RunCheckpoint` 有界保存 TaskBook、步骤、事件、权限与副作用状态；Main 启动释放旧进程租约，Local App API 与 Renderer 提供发现、查看现场、补充信息、续跑、停止和放弃。隔离真实 Electron 已验证暂停 Checkpoint 在强制终止后恢复，且原始用户指令恰好保留两条、不重复追加。Runner 仍拒绝不确定外部副作用、模型不匹配和不可恢复附件；真实 DeepSeek 多步骤副作用任务仍需独立验收 | `packages/snapshot/src/git-checkpoint.ts`、`git-checkpoint-files.ts`、`packages/runner/src/run-checkpoint-control.ts`、`run-checkpoint-controller.ts`、`packages/app/src/main/local-app-api/run-checkpoint-routes.ts`、`packages/app/src/renderer/runtime-recovery/`、`scripts/verify-electron-runtime-continuity.mjs` |
| 桌面聊天与流式交互 | 已实现基础形态 | Local App API、SSE、Markdown、附件、审批和中断已接通；一轮 Agent 输出按思考摘要、执行过程、最终回答/成果渐进披露。活动 run 中可追加普通消息，设置变化与工作区文件保存也进入同一有界事件入口；结果按 accepted/duplicate/expired/conflict/rejected 显示 Runtime 状态，失败时保留输入并可幂等重试。Renderer 只显示通过 LLM 来源与重复检查的 Agent 文案。独立对话和项目对话均可从侧边栏原位重命名，Main 同步更新会话 metadata 与 UI 索引并在索引失败时回滚。Markdown 和成果链接单击进入拓展工作区预览，双击交给系统默认应用；网页预览进入有界导航历史 | `packages/app/src/main/local-app-api/session-routes.ts`、`packages/app/src/renderer/sidebar/session-row.tsx`、`packages/app/src/renderer/chat/`、`packages/app/src/renderer/runtime-events/`、`packages/app/src/renderer/workspace/`、`packages/app/src/renderer/Markdown.tsx` |
| 权限与行为模式分离 | 已实现基础闭环 | 通用/编程是独立行为 profile；完全访问/研究/受限是独立权限策略。活动完整应用数据根 `<data-root>`（默认 `.littlesheep`）是产品语义上的 LS Agent 容器，`workplace/` 是其默认工作区。从其他模式切换到完全访问时先显示红色风险确认；确认后容器内外及范围不明的读、写、改、删、执行均免逐次批准。研究仅对容器内读取免批准；受限所有操作都需批准。外部工作区自动索引在研究/受限模式下等待批准，完全访问直接继续。Agent 工具、内置终端、运行配置和步骤调度共享该语义；核心源码只读和危险命令硬拒绝仍高于模式。当前不是实际 Docker/OS 进程沙箱 | `packages/safety/src/permission-boundary.ts`、`packages/app/src/renderer/composer/mode-picker.tsx`、`packages/app/src/main/run-policy.ts`、`packages/app/src/main/local-app-api/terminal-permission.ts`、`packages/runner/src/run-config.ts`、`packages/prompt/src/profiles.ts` |
| 核心源码自修改保护 | 已实现内置工具硬闸 | Runner 从实际 workspace 标记自动发现 LS 核心源码根，并通过 ToolContext 传递只读边界；内置 `write`、`edit` 无条件拒绝核心源码路径，`exec` 在核心根内只允许保守只读诊断，完全访问与单次审批不能绕过。第三方本地插件仍属于用户显式完全信任边界，受控自我修改尚未开放 | `packages/runner/src/core-source-protection.ts`、`packages/tools/src/path-protection.ts`、`packages/tools/src/builtin/` |
| 拓展工作区 | 已实现基础形态；内置浏览器已接通 | 文件树、标签、内置编辑器、Office/OpenDocument 有界只读预览、产物索引、PowerShell/PTY 终端和恢复快照已接通。关闭最后标签后面板保持展开并显示快捷启动空态；明确折叠后同时保留右上角固定入口和右侧全高悬浮入口。浏览器在 LS 内加载 HTTP(S)，提供与全局导航独立的有界前进、后退和刷新；切换标签可重建 webview，不依赖其原生历史栈 | `packages/app/src/renderer/workspace/`、`packages/app/src/renderer/app-shell/workspace-dock-view.tsx`、`packages/app/src/main/workspace-office-preview.ts`、`packages/app/src/main/workspace-*.ts` |
| 开发环境与工具链管理 | 已实现管理基础；运行时分发未完成 | 设置页可查看 Node、Python、Java/JDK、Go、Rust、C/C++、.NET、Ruby、PHP、Git 和 PowerShell 的检测状态，保存精确或系列版本偏好，导入已解压工具链并移除 LS 管理版本。Electron 内置 Node 随应用提供；其他工具链当前通过安全导入进入 `<data-root>/toolchains/`。终端优先使用已验证的 LS 版本，系统环境只作可解释降级，宿主 `PATH` 不被修改 | `packages/app/src/renderer/settings/development-environments.tsx`、`packages/app/src/main/development-environments.ts`、`development-environment-definitions.ts`、`development-environment-files.ts`、`packages/app/src/main/local-app-api/development-environment-routes.ts` |
| 模型供应商配置 | 已实现配置层 | OpenAI、DeepSeek、GLM 预置；只有配置了可用密钥的供应商/模型应进入选择范围 | `packages/config/`、`packages/app/src/main/keychain.ts` |
| 插件运行时 | 已实现基础闭环 | 插件发现、manifest 校验、启停、错误隔离、本地代码信任和 Runner 工具迁移已接通；当前支持 `channel`、`tool` 和声明式 `skill` 贡献。插件 Skill 使用 owner-scoped 来源和稳定资源 ID，随插件启停、移除、路径变化及 Runner 重建同步 | `packages/plugins/`、`packages/skills/`、`packages/memory-tree/src/memory-service.ts` |
| 外部渠道 | 已插件化基础形态 | Webhook、Telegram、飞书、QQ Bot 是可选渠道插件，只负责消息进出；没有配置时不加载实现 | `packages/channels/`、`packages/plugins/` |
| 技能系统与经验库 | 已实现基础形态，治理待补 | Skill 已区分 builtin、user、external、plugin 来源，支持 active/disabled/shadowed 与 owner-scoped 插件同步；创建时会拒绝同名覆盖。尚未实现语义去重、合并方案、冲突/回滚、基于验证收益的停用/归档/删除策略和用户可审查治理队列 | `packages/skills/`、`packages/experience/`、`packages/memory-tree/src/memory-service/skill-resources.ts` |
| Runtime 连续执行 | 隔离真实 Electron 生命周期与跨重启基线已完成；真实 Provider 持续长任务待验收 | 已有 `AbortSignal`、步骤级局部恢复、工具调用级与 TaskBook 步骤级有界并行、有界 `RuntimeEventQueue`、活动 run ingress、暂停/继续/即时中断、可恢复暂停检查点、Runner 显式续跑、应用启动恢复、当前/退役 Runner 聚合、托盘、三档关闭策略和设置页“应用与后台”。活动列表由 SSE 事件驱动同步，断连后有界重连；普通追加消息、设置和工作区事件由 Renderer 生产。真实 Electron 验收已覆盖跨重启回答连续、活动任务 SSE、关闭到托盘并恢复、暂停/继续、强制终止后 Checkpoint 恢复、模型热切换和中断 Checkpoint。该验收使用隔离数据与确定性 Provider，不外推为 DeepSeek 长任务、网络抖动、真实外部副作用或长期资源回落已通过 | `packages/runner/src/active-run-{registry,activity}.ts`、`run-abort-control.ts`、`run-checkpoint-*.ts`、`packages/app/src/main/desktop-shell.ts`、`tray-controller.ts`、`run-activity-monitor.ts`、`local-app-api/application-lifecycle-routes.ts`、`packages/app/src/renderer/settings/application-background.tsx`、`packages/app/src/renderer/runtime-recovery/`、`scripts/verify-electron-runtime-continuity.mjs` |

### 本轮权限边界收口

本轮把“LS 是一个容器”的产品概念落成可验证的逻辑边界：容器根来自活动完整数据根，而不是 `workplace`；用户选定的外部项目不会自动改变容器根。`describeToolAccess` 统一识别 `inside`、`outside` 和 `unknown`，并对绝对路径、相对越界、符号链接、动态 Shell 和外部命令采取保守策略。Tool Execution Service 在工具调用前执行宿主权限与单次批准判定，内置工具在实际读写前再检查一次，终端在创建会话和提交命令前由 Main 再检查一次。研究和受限模式下，外部或未知工作区的自动索引会在获批前暂停；完全访问完成一次显著风险确认后直接继续。用户主动的 UI 选择、预览和保存不与 Agent 授权混用。当前没有把宿主进程伪装成 Docker 沙箱；真正的 OS/Docker 隔离仍是后续安全增强方向。

上述外部或未知范围的逐次批准与自动索引暂停只适用于研究和受限模式；完全访问在用户完成一次显著风险确认后，对普通宿主访问免逐次批准。核心源码只读和危险命令硬拒绝仍独立生效。

本轮新增/更新的定向证据包括：逻辑容器路径与三档矩阵、完全访问一次风险确认后的免逐次批准、研究/受限的动态与越界命令审批、终端会话和命令审批、编辑工具在获批前不探测未授权路径，以及 Runner 外部工作区自动索引延迟闸门。以上验证数字已由本轮实际命令输出刷新。

## 当前验证结果

当前工作树的核心门、全量测试、类型、构建、仓库卫生和恢复源检查均通过，工程质量门为绿色。真实供应商冒烟仍是独立验收门，不能因本地质量门通过就宣称三家 Provider 已完成校准。

| 检查 | 当前工作树结果 | 证据命令 |
| --- | --- | --- |
| 仓库卫生 | 通过：33 项通过，0 项失败 | `pnpm.cmd run check:repo` |
| 开发快速门 | 本轮未单独执行；核心门和全量测试提供更广覆盖 | `pnpm.cmd run verify:changed` |
| 核心 Agent 门 | 本轮由全量测试、仓库卫生与全工作区 typecheck 覆盖，未额外重复执行聚合脚本 | `pnpm.cmd run verify:core` |
| 全量测试 | 通过：254 个测试文件全部通过；测试项为 1734 passed、1 skipped。覆盖回答级记忆连续性、直接记忆追问、多个历史字段完整/部分回答、版本化摘要与 active/adopted Atom 显式字段恢复、否定旧值、显式失忆表述、显式续答断档/弱证据/无目标边界、异常旧摘要降级、`respond` ContextSnapshot、统一工具执行、TaskBook 步骤级并行、无进展熔断、结构验证快路径、恢复策略、活动任务控制、Checkpoint JSON 语义与旧 `null` 事件兼容、隐藏桌面验收 API、完全访问一次确认与免逐次审批、会话重命名、对话布局稳定、控件行单行约束、普通表面圆角 token、折叠图标 `3px` 像素对齐 SVG 清晰度例外和字体/图标对齐 | `pnpm.cmd test`、`packages/harness/src/response-continuity.test.ts`、`packages/harness/src/runtime-awareness.test.ts`、`packages/harness/src/default-harness.test.ts`、`packages/harness/src/stages/{decide,execute,verify,recover,finalize}.test.ts`、`packages/runner/src/run-checkpoint-store.test.ts`、`runtime-event-queue.test.ts`、`packages/app/src/main/desktop-acceptance-api.test.ts`、`packages/app/src/main/session-rename-api.test.ts`、`packages/app/src/renderer/chat-layout-stability.test.ts`、`packages/app/src/renderer/ui-radius-consistency.test.ts`、`packages/app/src/renderer/ui/icons.test.ts`、`packages/app/src/renderer/font-rendering.test.ts` |
| 全工作区类型检查 | 通过：27 个 workspace package 的 project references 完整通过 | `pnpm.cmd run typecheck` |
| 全工作区构建 | 通过：类型图与 Electron main/preload/renderer 完整构建 | `pnpm.cmd run build` |
| 开发环境定向回归 | 通过：开发环境管理与 Local App API 共 2 个测试文件，7 项全部通过；导入、精确版本、系列版本、激活、移除和取消选择均有覆盖，App typecheck 已通过 | `packages/app/src/main/development-environments.test.ts`、`development-environment-api.test.ts` |
| Memory v2 写入路径退役 | 通过：旧 archive 摘要、Vector 装饰器和 CLI archive adapter 已删除；真实 CLI 子进程在损坏配置、无 API key 的隔离环境中于 branding/config/Provider/Runner 之前返回退出码 2，数据目录哈希前后一致。旧 archive/vector 只保留显式只读兼容，正式用户数据未改写 | `packages/cli/src/cli.test.ts`、`scripts/check-repository-hygiene.mjs`、`pnpm.cmd --filter @littlesheep/cli... run build`、`node packages/cli/dist/bin.js memory archive --force` |
| Memory v3 正式迁移与向量验收 | 通过：V2 源 2 个文件、40 个业务节点、11 个资源与源 manifest 保持不变；正式 backend/config 为 v3，Catalog 含 45 个 atom、45 条 BGE 512 维向量，integrity 为 `ok`；重启、恢复源和实际向量查询通过 | `node scripts/verify-memory-v3-migration-readiness.mjs --data-dir=<data-root>`、Local App API、只读 Catalog 检查 |
| Memory Catalog schema 兼容 | 通过：正式 v7 Catalog 先在一致性备份后幂等升级到 v8，本轮桌面启动再增量升级到 v9；45 个 atom、45 条 ready 向量和 `memory-atom` namespace 保持完整，45 条记录均具有 activation score/update time，`integrity_check=ok`。activation/routing-only 变化不触发语义向量重建 | `packages/memory-tree/src/v3/catalog.test.ts`、桌面启动与只读 Catalog 检查 |
| Memory v3 运行时规模 soak | 通过：默认档为 120 个基础 atom、96 次 run、双阶段各 128 条反馈；增强档为 500 个基础 atom、256 次 run、双阶段各 256 条反馈。增强档最终含 501 个 atom 文件、530 条投影变更记录、500 个 active ready 向量，单批不超过 16，Catalog 删除重建与崩溃恢复通过；目标 Atom 在 release 后让位、验证有用后恢复首位，关系 relevance 变化参与排序且不触发向量重算；ledger 保留 16 条、最近反馈 id 保留 64 条，峰值 RSS 约 213 MiB，低于 384 MiB 门槛 | `node scripts/verify-memory-v3-soak.mjs`、`node scripts/verify-memory-v3-soak.mjs --atoms=500 --runs=256 --feedback-events=256` |
| Memory v3 真实 BGE soak | 通过：只读校验活动数据根中 24,451,050 字节固定 BGE 资产，在隔离数据根写入 256 个基础 atom。模型暂不可用时保留 256 个 pending 且零 Embed 调用；恢复后完成索引。语义更新注入一次瞬时失败后在同一 maintenance drain 内恢复。最终 256 个 active 512 维向量全部 ready，0 pending、0 failed；Catalog 灾难重建、4 次重启、128 次 run、离线零网络请求和 pipeline dispose 均通过。最大批次 16，峰值 RSS 约 349 MiB，低于 512 MiB 门槛 | `pnpm.cmd run verify:memory-v3-bge-soak` |
| Memory v3 运行时相关性 | 通过：16 个隔离 Atom、11 个 D1 案例和 10 个 branch-scoped deep-search 案例使用正式 BGE q8 资产运行。D1 Recall@1/2 `1.0/1.0`、正/负例通过率 `1.0/1.0`、多余 Atom `0`、query Embedding `0`；深搜 Recall@1/3 `0.7/0.9`、MRR `0.7833`、scope leak `0`、query Embedding `10/10`。运行阶段零网络尝试，临时数据根已清理；一个较长英文改写未进入前 5，作为默认 BGE 的可见边界保留 | `pnpm.cmd run verify:memory-v3-relevance`、`scripts/lib/memory-v3-relevance-fixtures.mjs`、`packages/memory-tree/src/task-relevance.test.ts`、`memory-tree.test.ts`、`src/v3/catalog.test.ts` |
| Memory v3 动态工作集与反馈演化 | 通过：正式 BGE q8、3 个隔离 Atom 和真实 Runner 请求链验证 initial admit、release、readmit、KnownState/ledger 一致与重启保持。32 次历史 release 后 routing relevance 为 `0.0294`，一年后回归 `0.4717`，routing-only useful 后 `0.5790`，结构性 verified useful 后 `0.6500`；即时负反馈让中性对照优先，衰减和新证据后目标恢复首位。未进入 active Context 的冲突候选生成 0 条反馈；正文、confidence、embedding hash 不变。重启后 vector deep search 命中目标，1 次请求只生成 1 次 query Embedding，零网络尝试，RSS 约 186 MiB | `pnpm.cmd run verify:memory-v3-evolution`、`packages/harness/src/memory-context-working-set.test.ts`、`packages/runner/src/memory-v3.integration.test.ts`、`packages/memory-tree/src/memory-repository/v3-backend.test.ts` |
| Memory v3 多轮任务语义 | 通过：正式 BGE q8、11 个隔离 Atom、8 个 D1 和 2 个 branch-scoped deep-search 案例覆盖中英文指代、LS 方案引用、硬排除与替代、负向约束保留、任务转向、自足指示词、无历史指代、项目 A/B scope 和缓存否定。D1 `8/8`、深搜 `2/2`；D1 query Embedding `0`，深搜 query Embedding `2/2`，被排除正文、多余 Atom、scope leak、网络尝试均为 `0`。深搜在明确相关性断层处停止，不再为填满 limit 注入噪声；阶段 9 Recall 指标保持不变，平均 tokens 从 `530.7` 降至 `495.3`。RSS 约 179 MiB | `pnpm.cmd run verify:memory-v3-intent-routing`、`packages/memory-tree/src/task-query.test.ts`、`task-relevance.test.ts`、`memory-prime-relevance.test.ts`、`memory-repository/v3-retrieval-materializer.test.ts`、`scripts/lib/memory-v3-intent-routing-fixtures.mjs` |
| Memory v3 压缩后任务连续性 | 通过：正式 BGE q8、8 个隔离 Atom、7 个案例在 Repository 重启前后各执行一次。中文/英文摘要回退、最近明确目标优先、任务转向、旧方案排除与新方案选择、session A/B 隔离和无摘要模糊“继续”均通过，共 `14/14`；D1 query Embedding `0`、网络尝试 `0`。初始 working set 只保留最强 task-relevance 簇，弱相关高治理优先级候选仍留在索引而不自动注入。阶段 9、11 复跑保持原指标，RSS 约 182 MiB | `pnpm.cmd run verify:memory-v3-compaction-continuity`、`scripts/lib/memory-v3-compaction-continuity-fixtures.mjs`、`packages/memory-tree/src/task-query.test.ts`、`memory-tree.test.ts`、`packages/runner/src/memory-v3.integration.test.ts` |
| Memory v3 关系引导选择 | 通过：20 个 Atom、20 个实体、13 条关系和 7 个固定案例在 Repository 重启前后共 `14/14`。必要依赖、替代方向、冲突双向、项目/会话隔离均正确；`similar-to`、过期、归档、争议、低置信和无独立任务价值的关系候选不扩散。关系路径候选 12 次，scope leak、多余 Atom、D1 query Embedding 与网络尝试均为 `0`；首次 working set 重启前后均以 319 tokens 注入种子与必要依赖 | `pnpm.cmd run verify:memory-v3-relationship-routing`、`packages/memory-tree/src/v3/catalog-relation-routing.ts`、`memory-prime-selection.test.ts`、`memory-repository/v3-backend.test.ts` |
| Memory v3 写入认识边界 | 通过：模型只描述 domain、statement kind、asserted source 和 topics；Runtime 依据对话原始来源、成功工具证据与 VERIFY 独立决定 reported/corroborated/unverified 和 authority。伪工具来源会连同不可信 id/label 一起降级；建议与假设不能因高 confidence 或通过 VERIFY 变成事实。EVOLVE/CAPTURE 写入、D3 检查与关闭重启保持通过；旧 daily 原文追加蒸馏 API 已删除并由仓库卫生门防回流。专项 3 个文件、15 项通过 | `pnpm.cmd run verify:memory-v3-epistemic-writes`、`packages/harness/src/stages/memory-epistemic-policy.ts`、`packages/harness/src/stages/memory-stage-prompts.ts`、`packages/runner/src/memory-v3.integration.test.ts` |
| Memory v3 Atom 相关性与关系调和 | 通过：EVOLVE/CAPTURE 最多接受 12 个实体 hints 与 16 条关系 hints；模型只描述实体和端点，Runtime 独立决定关系认识状态。关系先 proposed，Atom 提交并引用且证据门满足后才激活；失败提交不泄漏，启动最多补偿 1,000 条中断激活。专项 3 个测试文件 `17/17`；可信替代路线 strength `0.855` 且 active，未验证建议保持 proposed，scope leak `0`、网络请求 `0`，重启前后候选与路线一致，Catalog integrity `ok` | `pnpm.cmd run verify:memory-v3-atom-reconciliation`、`packages/memory-tree/src/memory-repository/v3-write-graph-projection.ts`、`v3-write-graph-policy.ts`、`v3-write-graph-activation.ts` |
| Memory v3 TaskBook 二次注入调和 | 通过：模糊原始请求的前两次模型调用未提前加载目标 Atom；DECIDE 形成结构化 TaskBook 后，EXECUTE 收到目标 Atom，VERIFY 显式引用并保持 adopted。goal、success criteria、步骤和 acceptance criteria 独立评分；单次最多 2 Atom/400 tokens，单 run 最多 4 次，相同规范化 query 跳过。隔离验收记录 4 个分支检查，记忆消耗 553/3200 tokens，网络请求 `0`；5 个定向测试文件 35 项通过 | `pnpm.cmd run verify:memory-v3-taskbook-refinement`、`packages/harness/src/memory-taskbook-refinement.ts`、`packages/memory-tree/src/memory-service/run-coordinator.ts`、`packages/runner/src/memory-v3.integration.test.ts` |
| Memory v3 动态 Atom 激活层级 | 工程门通过：后端连续 activation、Catalog v9 投影、持久/缓存隔离、惰性衰减、有界证据、D1 热区、冷 Atom 精确召回、摘要真实使用反馈和前端三层只读汇总已接通。共享跟踪器让刷新使用真实滞回，状态随当前条目有界替换且重启清空。专项 11 个测试文件 `62/62`；长期真实负载仍待观察 | `pnpm.cmd run verify:memory-v3-activation`、[原子记忆与内置向量目录任务书](../taskbooks/memory-atom-vector-catalog-taskbook-2026-07-17.md)、`packages/types/src/activation.ts`、`packages/types/src/activation-projection.ts`、`packages/session/src/compaction-store.ts` |
| Memory v3 真实负载观测 | 观测工程门通过，校准门未通过：2026-07-29 只读报告检查正式数据根 46/46 份执行日志，0 拒绝、0 投影截断；15 个 run 有记忆访问，0 个有 KnownState，1 个有最终 VERIFY，0 个报告显式 Atom 使用，12 个有权威 Provider usage，10 个有资源采样。Memory 访问共使用 5,880/48,000 tokens；Provider 共报告 prompt 75,958、completion 17,742、reasoning 15,187、cached prompt 21,504，Memory/Provider prompt 比率 0.0632。默认五项门槛为 20/10/10/20/20，目前只有 Provider usage 达标，状态仍为 `insufficient`，禁止据此调参 | `pnpm.cmd run report:memory-v3-workload`、`packages/runner/src/memory-workload-observability.ts`、`packages/runner/src/runtime-resource-observation.ts` |
| Memory v3 Provider 与回答连续性 | 本地结构门、确定性 Electron 七场景门和真实 DeepSeek 跨重启回答门通过。FINALIZE 从真实发布回答反查其 Provider 请求与 ContextSnapshot，只把回答实际承接的 active/adopted Atom、版本化摘要、近期跨轮对话和已进入后续请求的记忆工具结果计为连续；当前输入重复、已裁剪来源或 released/excluded/conflicted Atom 不计入。任务续接及直接记忆追问只有 `supported` 可称为连续；多个被追问旧值必须全部出现在最终回答，漏答、只记得附带限制、否定旧值或明确失忆均判为 `discontinuous`。一次 run 可以正常交付回答，同时由独立连续性状态指出该回答是否承接记忆，不能用 `status=ok` 替代连续性结论。真实 DeepSeek 在隔离数据根完整退出重启后，问题未泄露答案而最终回答准确给出代号和颜色，`matchedSources=recent_history`。仍未完成的是 DeepSeek 多步骤长任务、摘要压缩后的真实续答、持续负载、工具续轮 token 校准和 EVOLVE/CAPTURE 提案质量验收 | `packages/harness/src/continuation-intent.ts`、`response-continuity-{text,targets,evidence,types}.ts`、`response-continuity.ts`、`packages/harness/src/stages/finalize.ts`、`scripts/verify-electron-runtime-continuity.mjs`、`scripts/verify-electron-deepseek-reply-continuity.mjs`、`pnpm.cmd run verify:electron-deepseek-reply-continuity` |
| 真实 Electron Runtime 连续性 | 通过：7 个场景全部完成 | 使用隔离数据根、真实 Electron 进程和确定性验收 Provider，覆盖跨重启回答连续、活动任务 SSE、关闭到托盘并恢复、暂停/继续、暂停 Checkpoint 后强制终止与恢复、运行中模型热切换、中断并生成可恢复 Checkpoint。最终恢复回答判定 `supported`，`matchedSources=recent_history`，`historyAnchorCount=17`，共 14 次 Provider 请求；正式用户数据未被读写 | `pnpm.cmd run verify:electron-continuity`、`scripts/verify-electron-runtime-continuity.mjs`、`scripts/lib/electron-acceptance-provider.mjs` |
| 应用恢复源检查 | 通过；现有数据根、默认 workplace、会话、执行日志目录、资源索引、终端活动和布局均可读取；仍保留部分旧 run 缺执行日志与可选 workspace artifact 索引缺失的诊断警告 | `pnpm.cmd run verify:app-recovery` |
| 桌面快捷方式 | 已刷新并验证：`<Desktop>\LittleSheep.lnk` 指向当前构建准备的 `LittleSheep.exe`；从快捷方式启动后主窗口标题为 `LittleSheep`，进程响应正常 | `scripts/refresh-desktop-shortcut.ps1`、PowerShell 进程窗口检查 |

供应商校准已收敛为运行中 Main 的脱敏接口：脚本只读取启动令牌和 loopback locator，不再另起 Electron 或复制密钥。接口覆盖最小聊天、continuity、工具调用、`reasoning_content` 续接、流式中断和 usage 对账；2026-07-31 运行中 Main 对当前 DeepSeek 模型的四项校准已全部通过。该结论只覆盖当前已配置 provider/model；mock 仍只证明本地结构链路，不代替长任务和 Memory 提案质量验收。

## 能力明细

### Agent 核心

- 语义活动已完成从旧 `chat / problem / unclear` 向 `respond / execute / clarify` 的迁移；规则快速路径、LLM fallback、Context 装配和回归质量门均使用新语义。旧类型只供旧会话、检查点与插件字段兼容，不再作为新产品活动。
- 缺少关键路径、权限或不可逆操作确认时使用结构化 `ClarificationRequest`，不把不确定性伪装成普通错误。
- 复杂任务可以生成目标、步骤、工具、产物和验收标准组成的 TaskBook；简单任务保持轻量。
- EXECUTE、VERIFY 和 RECOVER 以步骤为边界保存证据，支持局部重规划和有限重试。
- 运行事件包含步骤、工具、验证和最终回复，UI 可以实时展示，历史也能重建同一过程。
- 每次模型调用使用独立契约；工具、输出预算和 Context 来源越权会在请求发送前失败关闭。

### 记忆与持续能力

- 根索引、分支索引、节点展开和同分支深搜构成默认检索路径。
- 未命中索引时不会默认跨树或直接把向量召回塞入上下文。
- 分支和单次 run 有预算、去重、来源记录和安全封套。
- 目标架构要求在已导航分支和当前作用域内，让经验证且任务相关的高价值记忆优先介入；访问频率本身不提升可信度，错误、冲突和过期结果必须产生可审计负反馈。长期无验证收益的可选记忆降低注入权重，但不自动降低 confidence，T0、安全规则和当前用户约束不参与普通衰减。
- DECIDE、EXECUTE、VERIFY 和 FINALIZE 已共享版本化 run 级 `KnownState` 事实链，明确区分已采用、已排除、冲突和重新激活的信息；Harness 只注入有界状态元数据，不复制记忆正文。
- 各阶段会从 `KnownState` 派生有界 active evidence set：当前无用、重复、被替代或过期信息可退出后续 LLM 请求，必要时重新激活；注入记忆携带层级、作用域、来源、confidence、importance、新鲜度、冲突状态、披露级别和实际 token 使用。
- v3 已冻结 User、Agent Self、Task/Project/Session、Experience、Knowledge domain 与 D0-D3 契约，并已通过同一 facade 接管正式 Runner、工具和生产 UI 路径。
- v3 已登记 user/project/file/session/task/skill/tool/rule/concept 等稳定实体和有向关系，并投影 atom 对实体/关系的引用；归档、删除或物理清理前会检查直接引用和入/出边。名称、路径、共现与向量相似只作为候选关联，不自动证明同一实体、所有权或因果关系。
- v3 已把关系从“已有候选排序信号”升级为受控候选发现路径：只从高任务相关种子做一次同 branch/scope/subtree 扩展，按关系方向、状态、时间、权威、置信度、相关度和证据筛选；邻接 Atom 仍须独立通过任务相关度和预算。关系命中使用独立 `relation` 路径与结构化 route 证据，不能伪装为层级或向量命中。
- v3 已实现 `MemoryUpdateEvent`、持久 journal、幂等存储协调器、due index、启动补偿消费者与两类崩溃点重放；due 消费先持久捕获幂等 `time-due` 事件再确认。真实 Runtime 事件生产和后续归并属于连续执行阶段，v3 atom 管理 UI 属于 Memory v3 阶段 6。这里的“不失忆”仍指持久、可发现、可追溯、可恢复且相关时可取回，不是把全部记忆常驻 Prompt。
- v3 已将“对话原始来源”与内部“投影变更记录”拆开。正式 V3 Runner 从用户输入和对话区可见的回复、步骤、工具过程、验证与错误生成稳定来源记录；EVOLVE/CAPTURE 写 Atom 前先持久化其来源，Runner 在每轮结束补齐可见来源。来源捕获失败会延期投影写入，不会生成无法追溯的 Atom。迁移前的 V2 会话 JSONL 和 snapshot 继续保留为来源与回滚证据，不参与新写入。
- Atom 的 `sourceRefs` 只引用对话来源，工具、VERIFY 与外部佐证进入 `evidenceRefs`。自动去重不会因重复内容或模型给出更高 confidence 就覆盖正文；新验证证据或用户在自身目标、偏好、价值和决定范围内的权威来源才允许强化。合法父级变化保持稳定 id，合并保留来源 tombstone 与审计。
- v3 已接入分层使用反馈：VERIFY 显式声明且被 Runtime 核验为 active + adopted 的 Atom，只增加 routing usefulness；结构性 VERIFY，或 VERIFY 通过且有成功工具证据时，才增加 verified usefulness。单纯读取、重复出现、停留在 Context 和未验证 release 都不提高 confidence。release 只更新有界 routing feedback，旧影响随时间回归中性；有效关系 relevance 以批量聚合信号参与排序，并按当前 task relevance 向中性收缩，relation confidence 保持不变。
- v3 已接入真实本地 Transformers.js Embedding：模型资产固定 revision、大小和 SHA-256，产品运行禁用远程模型与框架缓存。BGE 平衡档与 multilingual E5 质量档均在阻断进程内网络后完成真实基准；向量不可用时层级和 FTS 保持工作。成功 atom 写入后会等待一次有界、并发合并的维护批次，失败不回滚 atom，shutdown 会释放本地模型 pipeline。
- v3 写入已经把用户/外界陈述分类为目标、偏好、报告观察、事实主张、建议/假设和决定/批准，并分别记录 epistemic status 与 authority scope。用户对自身意图和取舍具有权威，客观技术 claim 仍需证据；v2 原节点没有保存这些字段，安全迁移只按保守规则重建，不伪造旧元数据。
- 自动写入使用结构化意图，记录作用域、层级、来源 run、置信度和理由；普通用户通过记忆文件视图管理人格等高层资源，当前仅 `SOUL.md` 可直接编辑。Atom 治理保持 Runtime 内部可审计、可导出和可恢复，不在普通 GUI 中暴露。
- 模型提出的记忆操作与运行时提交权分离；无真实证据或低价值写入会拒绝，冲突/失效只进入有界审计记录。
- `PHILOSOPHY.md` 保存用户确认的长期理念，默认只在资源索引中出现，任务相关时才按预算展开正文。
- 长期记忆、项目记忆、经验和 daily 流水在概念上分开，避免把过程噪声全部变成长期记忆。
- 项目记忆完整权威数据保留在 LS 用户数据中；项目内私有投影需要显式启用并经过白名单过滤，共享导出使用独立、更严格的 Markdown 白名单。隔离数据根的真实 Electron 验收已覆盖启用、Git 隐私提示、外部冲突、删除保护、覆盖确认和恢复同步。

### 桌面应用

- Electron 主进程内嵌 Runner；渲染器通过 loopback 随机端口的 Local App API 通信。
- Local App API 与外部渠道插件完全分离；没有外部渠道时应用仍可独立运行。
- 聊天支持流式回复、Markdown、代码块复制、附件、工作区选择、权限审批和中断。
- 执行过程默认折叠但可展开，用户消息使用气泡，Agent 回复和工具过程使用无气泡时间线；展开后分为模型明确返回的思考摘要与真实执行过程，不展示私有思维链。
- 执行中优先显示当前步骤、实际选择/调用的工具和关键状态，命令与原始输出按需展开；任务结束后过程自动收拢，只保留最终回答与蓝色成果链接，失败和风险仍在默认层明确显示。
- Markdown 与成果链接采用统一激活协议：单击在拓展工作区打开文件或网页预览，双击取消单击并使用系统默认应用；不支持的协议失败关闭。网页地址属于独立且有界的浏览器导航栈，不进入全局应用导航，应用重启后历史清空。
- 设置、会话、项目、归档、记忆树和拓展工作区共享统一的转场、浮层和折叠交互约束。
- 旧原型默认 workspace 会在启动时同时迁移配置、项目壳、会话归属和归档元数据；真实迁移验证保留了全部索引会话，10 份会话 JSONL 的 SHA-256 均未变化，第二次启动的配置、会话索引和项目索引哈希保持稳定。

### 插件扩展

- `PluginHost` 在 Runner 之后独立启动，核心不依赖任何外部渠道。
- 内置渠道通过动态加载接入；未配置对应渠道时不会 import 渠道实现。
- 本地插件只在用户明确打开“允许执行本地插件代码”后才会在 Electron 主进程中运行；该开关不是代码沙箱，启用即代表完全信任插件代码。
- 插件设置页显示来源、版本、能力、激活事件、权限声明、运行状态和发现错误；用户可启停和重新加载插件。

### 工程治理

- [文档决策入口](../README.md) 已成为唯一首要入口；正式文档按当前依据、稳定原则、执行任务书和工程参考四层渐进展开，根 README 不再平铺全部文件。
- [架构原则](../principles/architecture-principles.md) 已成为 LLM、Agent、Mode、Context、Memory、Tools、Workflow 和插件分工的规范性来源。
- [架构决策报告](architecture-decision-report.md) 已按当前源码记录模块成熟度、主要缺口、推荐顺序和待用户决策事项。
- 架构文档、项目状态、仓库目录、专项规范和任务书拥有独立职责，避免同一事实在多份报告中重复维护。
- 文档已明确区分目标架构、当前事实、演进建议和专项任务书；Context Engine 按“阶段 1 主要数据链与 DeepSeek V4 普通请求精确本地计数已实现，工具续轮、其他 Provider 和单工具成本仍待收敛”记录，Tool Execution Service 按“本地工程基线完成、生态扩展待验收”记录，Mode Registry 仍不按已完成能力记录。
- [总基调、认知架构与仓库基元化任务书](../taskbooks/foundation-cognition-repository-taskbook-2026-07-15.md) 已完成阶段 0-7；package/领域 README、稳定 facade、LLM Call Contract、记忆更新闸门、理念资源和持续质量门均已落地。

## 未完成方向

### P0：Memory v3 原子记忆与内置向量目录

已完成的隔离基础：

1. 语义 atom 契约、stable id/parent、domain、D0-D3、statement/epistemic/authority、实体/关系、证据封套和 KnownState 引用已冻结。
2. Atom Store 已实现分片文件、内容哈希、修订冲突、同作用域 parent/循环校验、损坏/孤儿隔离、轻量常驻 header 和按需正文读取；10,000 atom 重启扫描通过。
3. Conversation Source Store 以独立哈希文件保存用户输入和对话区可见信息，写入后没有 update/delete/prune API。Projection Mutation Record Store 继续沿用兼容 `raw-record*` 内部路径保存事件与 mutation；mutation 提交后另写 append-only commit receipt。Event/operation journal 与 Storage Coordinator 再执行有界恢复和幂等双提交。变更记录已写但 event 未写、merge 部分写入、atom 已写/catalog 未写等崩溃点均可恢复，journal 裁剪不删除投影变更记录或 receipt。
4. SQLite catalog 已实现 FTS、branch/scope/subtree 强制过滤、向量状态、访问/反馈有界账本、due index、实体/有向关系和数据库删除后流式重建。
5. Provider `/embeddings` 默认硬拒绝，测试确认未授权远程引擎零调用；访问次数不进入优先级。显式采用只能形成 routing 反馈，独立验证证据才能形成 verified usefulness，二者都不自动改变 confidence；普通衰减不改 confidence 或淘汰 T0。
6. 独立 `packages/embedding` 已实现显式模型 provision、完整性校验、本地加载、批处理与取消；BGE Recall@1/3 为 `0.7778/0.8889`，E5 为 `0.9444/1.0`，两者离线断言网络尝试均为 0。
7. `MemoryV3MaintenanceWorker` 已实现有界向量重建和 due 启动补偿，不使用常驻轮询；实体/关系生命周期已检查 atom 引用与入/出边，Catalog 的 Embedding 职责已拆为独立控制器。
8. `MemoryRepository` 已成为 v2/v3 稳定 facade；正式数据当前由 v3 接管。活动版本 locator 优先并失败关闭，不能被旧实验标记或配置漂移绕过；v2 继续承担兼容、验证和受约束回滚来源。
9. 双后端 18 项契约覆盖根节点、读写、去重、层级、管理、资源、重启、并发、daily tier、冲突重绑定、恢复队列、项目路径重绑定和实验标记校验。
10. v3 写入先分类 domain、statement、epistemic、authority 和 actor；建议、事实、偏好与决定不会跨类别合并，资源与来源映射为稳定 user/project/file/session/task/skill/tool/rule/concept 实体。
11. Memory Service 与 Runner 已在正式 v3 根接管导航、证据定位和重启恢复；隔离路径另已验证 EVOLVE/CAPTURE。Catalog 删除后会先重建 graph，再重建带实体引用的 atom。
12. Graph、Ledger、Resource Store 首次初始化共享 Promise；Runner shutdown 释放 v3 SQLite，Git 真实仓库测试也具备显式子进程超时和 Windows 有界清理，降低句柄残留风险。
13. 阶段 4 已完成：迁移器直接只读原始 v2 文件，保存全量哈希 snapshot，在同卷 staging 中保留 node id、层级、资源、全部审计、恢复队列和迁移记录，并通过版本 locator、全量 validation hash、原子 rename、幂等恢复和受约束回滚提交。30 项迁移测试覆盖全部断电点、两类 ENOSPC、损坏/孤儿/重复数据、源变化、请求合并/取消、模型不可用、回滚后再迁移、运行中回滚预检和防丢失回滚；正式迁移已按同一协议完成。
14. 阶段 5 已完成：三类记忆工具共享 repository retrieval facade；v3 统一层级、作用域/子树过滤、FTS、本地向量、候选优先级、关系邻域、D0-D3 和访问账本。版本化 KnownState 贯穿 Harness 阶段，VERIFY 保持事实/建议/报告观察/未验证主张边界；默认 Provider Embedding 旁路已从 Runner 退役。
15. 新写入 atom 会在返回成功前触发有界本地向量维护；写入落在活动批次之后时会合并一个后续批次，模型不可用或维护失败不会回滚权威 atom，也不依赖无界轮询计时器。
16. 阶段 6 读取与迁移生命周期已完成：树接口只返回 D0/D1，节点 D2/D3 通过可取消请求按需展开；详情缓存限制为 24 条。Repository management facade 可检查 Catalog、atom、投影变更记录、Embedding、认识状态、证据和关系邻域；Memory Service 另外按 Atom `sourceRefs` 读取对话原始来源；迁移页可预检、确认登记、取消、重启执行、恢复和受约束回滚。
17. v3 atom 高级管理已完成：移动限制在同 branch/scope/scopeKey，合并要求相同认识类别、权威、断言者和解析状态，双 revision 先预检；来源 atom 保留 tombstone，合并不自动提高 confidence/usefulness，失效后退出检索并可精确恢复。
18. 单 atom D3 `.memory.json` 证据包导出继续由 Local App API 和内部维护控制面提供；普通 Renderer 已移除入口。真实 HTTP 测试覆盖参数校验、状态码、管理结果和文件输出。
19. Runner 首次业务请求已验证真实介入 D1 选中的 Atom；默认最多 2 个 D2 Atom、600 tokens，并执行 `0.25` 最低 task relevance 门，不达标时零注入且不凑配额。初始采用会立即同步到 Harness `KnownState`；`memory_tree release` 会同步移出真实后续请求与 KnownState，并允许之后重新加入。
20. Storage Coordinator 启动时分批协调投影变更记录、journal 与 catalog；能证明未执行或部分执行的记录才重放，能证明已投影的只补目录状态，含糊状态不猜测覆盖。
21. 隔离 `verify:memory-v3-soak` 默认档已通过：120 次初始写入形成 150 条投影变更记录与 121 个 atom，经历 4 次重启、journal 裁剪、projection-record-only 崩溃恢复、catalog 删除重建和 96 次 working-set run；120 个 active atom 的向量在重建后全部 ready，单批不超过 16，catalog integrity 为 `ok`，临时数据根执行后已删除。
22. 隔离 V3 Electron Atom 管理原型曾完成 65 个活动 atom、D2/D3、移动、失效/恢复和证据导出验收；2026-07-16 的产品边界决定已将该 Renderer 原型退役。相关治理能力与 API 保留为 Runtime/内部维护能力，普通 GUI 改为六份记忆文件视图且仅 `SOUL.md` 可写。
23. 正式 V2 数据先通过 `verify:memory-v3-readiness` 的只读预检和隔离副本完整演练，再完成真实迁移：2 个源文件共 164272 bytes，40 个业务节点与 11 个资源等价迁移；正式 V3 catalog 含 40 个业务 atom 和 5 个内部 scope root，integrity 为 `ok`；多次关闭重启后计数稳定，源 index/manifest 保持不变，临时副本已删除。
24. 回滚就绪检查已前移到运行中控制面：迁移 snapshot、当前 V2 manifest 与当前 V3 全量 validation 使用同一验证核心；安全时才允许写入 pending rollback。V2 源变化、V3 新写入或缺少活动 validator 都会在当前页面失败关闭，且不会要求用户重启后再发现失败；启动路径保留独立二次校验以处理预检后竞态和旧 pending。
25. 本地向量资产控制面已接入迁移页与 `verify:memory-v3-readiness`：正式数据根的默认 BGE 四个固定文件已完成 24451050/24451050 字节与 SHA-256 校验。Electron 构建已把 Transformers.js 与 ONNX Node 运行时保持为外部依赖，避免误打包浏览器/WASM 后端；正式 Catalog 的 45 个 atom 均为 512 维 `ready` 向量，0 pending、0 failed。运行时写入/检索不会隐式联网。
26. `verify:memory-v3-readiness` 已把当前正式 V2 副本的迁移器与真实 Runner 串成连续链路：首次迁移无新增写入时可回滚；重新迁移后，Runner 成功持久化 2 条会话消息、EVOLVE 项目 atom 与 CAPTURE daily atom，关闭重启后按相同 ID 恢复，并完成索引导航、release 后 FTS 重新介入。V3 新权威写入使 `activeV3Unchanged=false`，回滚在 pending 登记前被拒绝；正式源哈希不变，临时副本已删除。
27. 当前工作树已补齐 Memory V3 来源与反馈链路：对话原始来源具有稳定 hash、冲突保护和有界 manifest；来源文件位于 `memory-tree/v3/conversation-sources/`，不会污染 V2 源 manifest，并被 V3 validation hash 覆盖，新增来源会关闭可能丢数据的回滚。Atom 导出包分开包含 `sourceRecords` 与 `projectionRecords`；完全相同 Atom 可在新增支持来源下调整合法父级，近义内容不再因更高模型 confidence 覆盖正文；验证反馈幂等更新 verified usefulness 和既有关系 relevance，不改变陈述或关系 confidence。
28. 阶段 7 已完成：Atom routing feedback 通过 Storage Coordinator、投影变更记录和 commit receipt 持久化，计数与最近反馈 id 均有硬上限；候选排序已拆分 task、routing 与 relationship relevance，关系信号按当前任务相关度向中性收缩。VERIFY 显式使用只更新 routing，独立验证证据才更新 verified usefulness。Catalog schema v8 使用独立语义 Embedding 哈希，纯反馈、层级、关系 relevance 和认识元数据变化保留 ready 向量，语义正文变化才进入重建队列；非 active Atom 删除向量并在恢复为 active 后重新排队。正式升级后 45 条旧向量均未重算或丢失。
29. 阶段 7 增强规模门已通过：500 个基础 atom、32 个带有效关系引用的 atom、256 次 working-set run 和双阶段共 512 条反馈在隔离数据根完成。关系 relevance 从 `0.94` 调整到 `0.68` 时候选分同步下降但 Embedding 调用数不变；目标 atom 经连续 release 后从首位降到对照 atom 之后，验证有用后重新回到首位。Catalog 灾难重建生成 500 个 active ready 向量，最大批次 16；run ledger 保留 16 条、Atom 最近反馈 id 保留 64 条，峰值 RSS 约 213 MiB。
30. 真实本地 BGE 规模与恢复门已通过：`verify:memory-v3-bge-soak` 使用活动数据根中已校验的固定 BGE 资产，只在系统临时目录生成 256 个基础 atom 和 286 条投影变更记录。首次维护前模拟模型不可用，256 个 pending 全部保留且没有调用 Embed；恢复后完成 512 维向量。语义更新阶段注入一次瞬时失败并在同一 drain 内回退成功。Catalog 删除重建后 256 个 active 向量全部 ready，零 pending/failed；全程阻断网络且实际网络尝试为 0，pipeline 在报告输出前完成 dispose，峰值 RSS 约 349 MiB。
31. 阶段 8 已完成本地 D1 相关性收敛：独立 task relevance 不再重复计算 confidence/importance；分支说明不再污染 Atom admission；branch/scope 内 FTS 可以找回近期 fallback 之外的精确旧 Atom；prime 检查每分支完整有界 D1 候选；D1 零 Embedding、向量仅限已导航分支 deep search。定向 4 个测试文件、33 项通过。
32. 阶段 9 已建立 Memory v3 专属运行时相关性门：D1 与 branch-scoped BGE deep search 分开测量，覆盖中英文、跨语言、冲突说法、近邻概念、项目作用域和无关负例。D1 正负例与误注入全部达标；争议说法不再压过当前有效规则；英文词项不做子串误匹配；10 次深搜只生成 10 次查询向量且零 scope 泄漏。固定门通过但保留一个英文长改写失败明细，不宣称默认 BGE 已达到完美跨语言召回。
33. 阶段 10 已建立动态 working set 与反馈演化门：Atom 输出使用显式边界，release 不再误删后续 Prompt 段，真实 Runner 请求验证正文退出和重新介入；KnownState 与 ledger 记录 adopted/excluded/reactivated。routing feedback 增加独立派生相关度和有效证据权重，旧影响随时间回归中性，新事件不会刷新并复活旧负反馈。记忆导航与 Skill 加载不算独立验证工具证据，未进入 active Context 或未被 VERIFY 使用的冲突候选不生成负反馈。正式 BGE 隔离门、重启和 vector deep search 已通过，正文、confidence 和向量哈希保持不变。
34. 阶段 11 已建立多轮任务语义门：`MemoryTaskQuery` 在当前请求自足时拒绝拼接历史，只有真实指代或 LS 方案引用才有界补充最近 2 条 user/assistant 文本；任务转向切断旧历史。D1、FTS 与分支内向量共用正向主题、硬排除和负向约束语义；完整 Atom 判定成为 D1 权威结果，兼容索引才做词法补判。正式 BGE 隔离门的 8 个 D1、2 个深搜案例全部通过，零 scope 泄漏、零网络尝试。
35. 阶段 12 已建立压缩后任务连续性门：Runner 把版本化会话摘要作为可选 `continuitySummary` 传入 Memory v3；只有真实指代且近期消息缺少任务锚点时才选取最多 4 段、1,000 字符摘要。当前请求、最近明确用户目标、任务转向和排除条件优先。初始注入在 `task relevance > 0.25` 后只保留最强相关簇，弱相关尾部不为填满上限进入 Context。正式 BGE 隔离门在重启前后 14/14 通过，并保持阶段 9、11 指标。
36. 阶段 13 已建立关系引导的一跳选择门：Runtime 只从已通过独立任务门的高相关种子出发，在同 branch/scope/subtree 内做有界、有方向、有证据的一跳发现；邻接 Atom 仍须独立通过任务价值、状态、证据和预算。7 个案例重启前后共 14/14，通过且零 scope 泄漏。
37. 阶段 14 已建立写入认识边界门：模型只能描述 statement kind、asserted source、domain 与 topics，Runtime 根据对话来源、成功工具证据和 VERIFY 决定认识状态与权威。旧 daily 原文追加蒸馏入口已删除，建议、用户陈述和工具事实不会被模型自行升级为已验证事实。
38. 阶段 15 已建立 Atom 相关性与关系调和门：有界实体/关系 hints 先经 Runtime 校验并以 proposed 持久化，只有 Atom 成功提交、引用关系且满足证据门后才激活；提交失败、中断补偿、跨 scope 拒绝、替代方向和未验证建议均有独立回归。专项 17/17，通过路线 strength 为 0.855，scope leak 与网络请求均为 0，重启前后结果一致。
39. 阶段 16 已建立 TaskBook 二次注入调和门：首次选择仍只使用原始请求；DECIDE 明确目标后，goal、验收标准与目标步骤作为独立加权锚点补充选择。新增 Context 与 working set、KnownState 和账本同步；重复检索不再把 adopted Atom 覆盖为 excluded，用户指令在自身权威范围内保持 adopted。隔离 Runner 验收确认目标 Atom 只在 TaskBook 明确后进入 EXECUTE，重复 query 跳过且零网络请求。

最近完成的工程阶段：

40. 阶段 17 已建立动态 Atom 激活层级：后端用连续、惰性衰减且不限制层数的 activation score 统一持久记忆和语义缓存的候选速度；真实采用且产生价值才升温，长期不用或无帮助逐步降温。该分数不改写语义 parent、事实 confidence 或 D0-D3，无关高频 Atom 不能越过任务门。前端只映射为带滞回的高/中/低三层只读汇总，不暴露 Atom 或原始分数。持久记忆和语义缓存共用有界投影跟踪器：只保留当前条目的上一层，刷新可防阈值抖动，移除条目即释放，重启自动清空。实现没有无界访问历史与全库常驻轮询；专项质量门 `62/62` 通过。
41. 阶段 18 已建立真实负载只读观测基线：Runner 只聚合覆盖数、记忆访问、KnownState、VERIFY 显式使用、Provider usage 和 token 数据；命令行报告按修改时间有界选择日志，先脱敏投影再统计，不输出对话、回复、工具内容、路径或 Atom ID。正式 36 个 run 全部可读，但 20/10/10 三项默认校准门均未达到，因此只确认观测能力完成，不宣称 activation 已完成真实负载校准。
42. 阶段 19 已扩展真实负载质量、成本与资源观测：执行日志每轮只保留开始/结束两次粗粒度资源快照；报告增加最终 VERIFY、TaskExecution、Provider prompt/completion/cache/reasoning token、Memory/Provider prompt 比率和 RSS/heap 变化，并把旧日志缺字段保持为缺失。正式数据仍为 36/36 可读、0 拒绝、0 投影截断，0 个资源样本，五项校准门全部不足；“adopted 但未显式使用”只作为诊断代理，不等同误注入事实。
43. 阶段 20 已退役 Memory v2 的 archive 月/年摘要写入、旧 Vector 装饰写入和 CLI archive adapter。Memory Core 不再依赖 Config、LLM 或旧 Vector，CLI 不再引用 Vector project；旧类型和文件搜索只保留明确的只读兼容。卫生门禁止旧文件、主动符号和依赖回流；真实 CLI 子进程以退出码 2 在配置/Provider/用户数据加载前失败关闭。阶段 20 验收时为 180 个文件、1317 passed、1 skipped；2026-07-31 当时工作树为 240 个文件、1650 passed、1 skipped，正式用户旧 archive/vector 文件仍未改写。
44. 阶段 21 已完成结构化 daily 一对一提升：压缩摘要只保留最近 64 个 source run，Repository 查询最多扫描 256 个候选、每批处理 8 个；Runtime 先写 project/long-term/experience T2 目标，再按 expected revision 归档源 Atom，失败保留源且不增加 LLM 调用。复杂多 Atom 语义合并仍必须先由模型提出结构化提案，再由 Runtime 校验提交。
45. 阶段 22 已完成模型提案的重复 Atom 合并闸门：EVOLVE 使用独立 `reconciliations` 契约，普通 `merge` intent 不再旁路为写入；候选必须来自本轮 adopted KnownState，并通过 revision、scope、parent、认识边界、确定性语义锚点和冲突/替代关系检查。多 source 顺序复用原子 merge mutation；中途失败返回 partial，未提交 source 保持 active，重试识别已完成部分。协议与实现已拆为独立模块，定向 12/12 和全仓 typecheck 通过。
46. 阶段 23 已完成显式关系驱动的叶子 Atom 跨 parent 重组：EVOLVE 使用独立 `reparents` 契约，普通 `move` intent 只能延期审计；候选必须来自本轮 adopted 的当前 D2/D3 KnownState，并通过叶子、revision、branch/scope、关系方向、active/resolved、来源证据、confidence/relevance、提交和恢复检查。单轮最多 1 项，超额项写入 rejected 审计；真实 V3 Backend 回归确认 parent、Catalog、关系邻域、投影记录和重启后一致。非叶子子树由阶段 26 的独立协议治理。
47. 阶段 24 已完成有证据约束的同陈述 Atom 内容修订：EVOLVE 使用独立 `revisions` 契约，普通 `revise` intent 只能延期审计；候选必须来自本轮 adopted 的当前完整 D3 KnownState，并通过 VERIFY、Runtime evidence、revision、语义保留、硬锚点、长度、提交和恢复检查。单轮最多 1 项；真实 V3 Backend 回归确认 Atom、Catalog、投影记录、commit receipt 与重启一致，响应丢失后的重试返回 noop。
48. 阶段 25 已完成有证据约束的事实纠正/冲突替代：EVOLVE 使用独立 `corrections` 契约，普通 `conflict/invalidate` intent 只能延期审计；replacement 必须是本轮 adopted 的当前完整 D3，旧 Atom 可以 adopted 或 conflicted，但必须保持同 branch/scope/scopeKey/parent/statement kind。Runtime 验证通过的 VERIFY、来源权威、revision 和方向正确的 active/resolved `replaces`/`conflicts-with` 关系，只把旧 Atom 标记 superseded 并保留历史。真实 V3 Backend 回归确认管理读取、Catalog、投影记录、响应丢失恢复和 noop 重试一致。
49. 阶段 26 已完成有证据约束的非叶子子树重组：EVOLVE 使用独立 `subtreeMoves` v6 契约，普通 `move` intent 和叶子 `reparents` 均不能旁路。根与目标 parent 必须是本轮 adopted 的当前完整 D3，并通过 VERIFY、Runtime evidence、branch/scope、方向正确的 active/resolved 关系和最多 128 个 active descendants 的硬上限。真实 V3 Backend 回归确认只修改根 parent，后代父链/revision 不变，Catalog 有界计数、投影记录、重启和响应丢失 noop 恢复一致。

仍未完成：

1. 使用真实 Provider 完成正式 V3 会话、EVOLVE/CAPTURE 写入、模型对 `usedMemoryAtomIds` 的判断质量与长任务连续性验收；本地 activation、反馈演化和摘要使用证据门已通过，不能替代真实模型判断质量。
2. 在长期真实用户负载中继续观察 activation、BGE pipeline 的吞吐、Provider 成本、内存回落、半衰期和设备差异；先让只读报告达到至少 20 个 KnownState run、10 个显式使用 run、10 个 Provider usage run、20 个最终 VERIFY run 和 20 个资源样本，再进入参数校准评审。当前 46 个历史 run 的状态为 `insufficient`，不能用 256 Atom 的真实 BGE 隔离门、62 项 activation 专项或少量历史 token 替代数周真实使用数据。
3. 在正式使用场景继续验收索引导航、自动写入、关系长期演化、层级调整、内容澄清、事实替代、归档恢复和数据根整体迁移；daily 一对一提升、重复投影合并、叶子跨 parent、非叶子有界子树移动、同陈述修订和事实纠正/冲突替代闸门已通过内部流程验收，真实 Provider 提案准确率、跨陈述重写和超大子树人工治理仍未完成，普通用户页面继续只展示记忆文件和三层汇总。
4. 在阶段 9、11、12 固定质量集之外继续扩充真实用户长尾表达、反讽、多重否定、跨数十轮指代、压缩摘要失配和更大作用域数据；现有门已能阻止基础误注入、旧历史污染、旧摘要复活和 scope 泄漏，但固定合成案例不能替代数周真实负载与高质量可选模型比较。

**验收标准**：断网时记忆可写、可导航、可检索；用户输入与对话区可见内容形成不可改写的对话原始来源；每次 Atom 变化具有投影变更记录与 commit receipt；atom 与数据库投影可从持久文件恢复；Atom 可在保留来源、证据、稳定 id 和审计的前提下去重、合并、调整层级、失效、恢复与重建；向量检索不能跨越未导航分支；所有 domain 使用同一 repository 并可从 D0/D1 渐进展开到 D2/D3；当前请求充足时不消费旧历史，真实指代只继承有界最近目标，任务转向不受旧话题污染，硬排除正文与方向一致的负向约束可正确区分；匹配作用域内经验证的高价值记忆稳定优先介入；即时 release 只改变当前 working set，跨 run 只留下有界 routing feedback且可重新介入；长期低收益可选记忆减少注入但强制信息不被误衰减；重复访问不会形成错误自增强；confidence、verified usefulness、routing/relationship relevance 与 importance/basePriority 分开治理；LLM 能获得所用记忆的必要来源、证据与 epistemic 元数据；用户目标/偏好在范围内受到尊重，客观 claim 不经验证不成为事实，建议被采纳也不改变其验证状态，错误建议不生成用户能力画像；每个执行阶段可追溯采用、排除和重新激活的 `KnownState` 版本与信息；事件在确认前持久化，重复处理幂等，崩溃、重启和关闭期间到期不会静默丢失；迁移可中断恢复和回滚且不丢节点。

### P0：持续维护与受控超限拆分

1. 仓库基元化阶段 0-7 已完成，后续由 33 项仓库卫生门持续保护，不再作为待实现功能重复规划。
2. 10 个超过 600 行的生产文件已登记所有者、暂缓原因、上限和 2026-08-15 复查日期；功能工作触及相应责任域时按拆分地图逐项收缩。
3. 新增核心协议必须有唯一权威来源；workspace 运行时依赖环、未公开深层 import 和未登记大型文件会直接使质量门失败。

**验收标准**：新任务能从仓库指南和领域 README 定位所有者、入口与测试；跨模块契约只有一个权威来源；热点文件不再承接新领域职责；行为特征测试和全量质量门保持通过。

### P0：核心模块契约收敛

1. 阶段 0 已完成：`ModeDefinition`、Context、附件、运行事件、TaskBookPatch、检查点、运行决议、模型请求、工具调用和执行证据的内部 v1 契约均已建立。
2. Runner 已生成深冻结的 `ResolvedRunConfig`；所有 Harness LLM 请求会解析并持久化独立 `LlmCallContract` 与有界快照；旧日志、会话、记忆和 workspace 恢复路径已有兼容测试。
3. 已按 [架构决策报告](architecture-decision-report.md) 新建并分域 Context Engine；来源 segment、版本化摘要、附件清单优先、按需附件工具、压缩阈值设置和双账本展示已接通。Provider reasoning/capability 契约回归已经修复，tokenizer 能力矩阵禁止计数器自行声明精确性；DeepSeek V4 普通请求的官方 tokenizer、最终请求 framing、本地精确 ledger 与 Provider usage 同请求对账已完成，含历史工具调用/结果的续轮保持 unavailable，其他 unavailable 模型继续使用不可展示的保守请求前预算保护。
4. 模型调用的输出上限、工具集合和 Context 来源已由契约统一限制；实际工具调用已收敛到统一 Tool Execution Service，并将来源、权限、超时、中断、清洗、事件和权威记录贯穿 Runner、Harness 与 Execution Log。下一缺口是让 MCP 和未来工具贡献点复用该服务，并补齐网络资源声明与更强授权 token。
5. 随新模块落地扩充现有依赖方向检查，继续阻止 App、渠道和插件内部实现反向进入 Harness/Runner 核心。

**验收标准**：每个跨模块职责只有一个所有者；Context 来源和 token 口径可追溯；Behavior Mode 与 Permission Policy 保持正交；内置、插件及未来 MCP 工具能够共享同一执行契约；全量回归保持通过。

### P0：真实能力验收

1. DeepSeek 已完成真实最小对话、continuity、工具调用、中断、普通直接回答本地 token 对账和跨重启最终回答连续性；工具续轮的本地 exact 计数仍待 Provider 校准。OpenAI/GLM 只在用户实际配置并进入选择范围后执行同等测试，未配置状态不视为产品故障。
2. 隔离数据根中的真实 Electron 已验证活动 run 跨重启、暂停 Checkpoint 强制终止后续跑、模型热切换和中断恢复入口；下一步使用真实 DeepSeek 多步骤长任务验证 TaskBook、真实工具副作用、上下文占用、已完成执行日志重放和持续资源回落。
3. 根据各供应商具体模型文档补齐 reasoning 参数、上下文上限和 usage 字段映射；不能用本地估算冒充真实 token usage。

**阻塞条件**：扩展到 OpenAI/GLM 时，需要用户在设置中提供对应可用密钥并接受真实请求成本；DeepSeek 普通回答不受凭证或 tokenizer 阻塞，工具续轮 exact 计数仍需基于真实 Provider usage 校准。

**验收标准**：每个供应商都能完成一次真实请求；失败、中断、工具审批和历史恢复结果可解释且不损坏用户数据。

### P0：Context、运行连续性与数据边界

1. provider/model tokenizer 能力分类已经完成：DeepSeek V4 Flash/Pro 声明为 `exact`，并且只有能力记录、请求格式与运行时 `counterId` 一致时才生成精确账本；OpenAI/GLM 及未验证模型保持 `unavailable`。DeepSeek V4 已通过应用内同请求 `968 = 968` 对账；unavailable 模型继续使用复用最终 Chat Completions 载荷的保守估算完成请求前防溢出，该估算固定为不可展示。下一步只按实际启用范围增加模型专用计数器与校准证据。
2. 有界队列、Local App API ingress、安全决策边界、确定性 `TaskBookPatch`、延迟事件重规划和 Renderer 生产入口已经接通；普通追加消息、设置变化与工作区文件保存都使用稳定事件身份并显示可解释结果。TaskBook 步骤也已按显式依赖、资源与副作用契约实现默认 2、硬上限 4 的有界并行；缺失或不安全契约保守串行，实际资源越界由统一工具服务拒绝。
3. 版本化 `RunCheckpoint`、原子 store、disposition/controller、Runner 显式续跑、幂等副作用拒绝、有界恢复校验、应用启动发现以及恢复/放弃/查看现场控制面已经实现；检查点可同时记录最多 4 个活动步骤。隔离 Electron 已证明强制终止后可以恢复且不会重复追加原始输入；下一步验收真实 Provider、并行外部副作用与可恢复故障语义。
4. T0-T3 基础注册表、v1→v2 版本化迁移、统一 Memory Service、Summary Memory、run-scoped 附件、运行时事件账本登记端口，以及项目记忆“用户数据权威源 / 项目内私有投影 / 可共享导出”三层契约与控制面已实现。项目稳定 ID、旧 ID 兼容和可恢复路径重绑定也已完成；`RuntimeEventQueue`、`TaskBookPatch`、Renderer 生产/反馈、启动恢复控制面、TaskBook 步骤级并行、活动任务控制、托盘、三档关闭策略和设置页后台控制已有工程基线，隔离 Electron 跨重启与回答级连续性门已完成；当前缺口是真实 DeepSeek 长任务、真实工具副作用和持续负载验收。
5. 附件缓存、workplace 有界资源索引和可回滚完整数据根迁移已进入独立、索引驱动的数据生命周期。数据根迁移由外部 locator 登记，设置页只登记目标并明确要求重启；启动阶段在 Runner、Local App API 和插件宿主创建前暂停结构性写入，复制到目标同级 staging，跳过符号链接/junction，以流式 SHA-256 清单校验全部普通文件，只重绑定活动元数据中原本位于旧数据根内的路径，再原子提交。源目录保留，校验失败继续使用旧目录，提交后 locator 切换前中断可恢复，回滚在下次启动切回前一个仍存在的数据根。当前完成的是隔离临时目录工程验收，不代表已替用户迁移正式数据。
6. 后台任务已配套托盘、状态提示、暂停/继续/中断、彻底退出、三档关闭策略和设置页活动列表；列表使用 `active_runs` SSE 实时同步，并保留手动快照刷新作为校准入口。隔离真实 Electron 已验证关闭到托盘、重新显示、活动任务 SSE、暂停/继续、模型热切换和退出；下一步验证托盘不可用时失败关闭、真实网络断线重连、DeepSeek 长任务和长期资源回落。

**当前事实**：Harness 已把模型请求映射为显式 Context 候选并交给 `@littlesheep/context` 准备。完整执行路径继续把基础策略、记忆根索引、bootstrap、输出约束、Workflow/TaskBook、profile 和 reasoning 独立登记；已收敛的 `respond` 路径使用紧凑 Prompt，只保留回答所需的身份、能力名、`USER.md`、受限记忆索引、相关摘要/Atom、最近历史和输出约束。DeepSeek V4 普通请求的本地精确账本在发送前生成，Provider usage 绑定同一快照并用于校准；含历史 `tool_calls`/`tool` 结果的续轮不生成 exact 本地账本。UI 只在来源可证明时显示本地精确装配，并分行显示 Provider 实测与差异。unavailable 请求只使用 `displayable: false` 的保守安全估算防溢出，不向用户冒充真实 token；旧会话没有可复现的历史最终载荷时只显示尚无本地计数。当前 DECIDE 输出上限为 1400，直接 REPLY 与重复改写上限为 1200；这些值仍是 stage 局部预算，尚未由 Provider capability 统一解析。

版本化 Summary Memory、附件清单优先与按需正文工具、T0 根索引、项目记忆投影、稳定项目 ID、路径重绑定、统一 `MemoryService`、数据根迁移和压缩阈值设置继续沿既有工程基线工作。统一 Tool Execution Service、工具调用级与 TaskBook 步骤级有界并行、运行中事件安全消费、确定性 TaskBookPatch、Renderer 事件生产/反馈入口、Runner 显式续跑、应用启动恢复、活动任务控制、托盘、三档关闭策略和设置页后台控制入口已经实现。2026-08-03 的仓库卫生 33/33、254 个测试文件/1734 passed/1 skipped、27 包 workspace typecheck、Electron build、恢复源检查、确定性 Electron Runtime 连续性和真实 DeepSeek 跨重启回答验收均已通过；恢复检查仍明确报告部分旧 run 缺执行日志与可选 workspace artifact 索引缺失。这些证据仍不等于真实 DeepSeek 后台长任务、持续负载、其他 Provider 矩阵或生产发布已就绪。

**验收标准**：每项 Context 可追溯且不超预算；未知 tokenizer 不显示伪精确 token；追加要求不重做已完成副作用；活动 run 可在重启后从检查点恢复；所有循环有界；用户数据迁移可验证、可回滚；后台运行始终可见、可终止。

### P1：长会话与记忆质量

1. `packages/session/src/compaction.ts` 已实现非破坏式、版本化和可增量合并的 Summary Memory；阶段 12 已证明压缩后“继续”类请求能在重启前后从版本化摘要恢复任务锚点，且不会压过当前明确目标、任务转向或 scope。下一步仍需真实 Provider 长会话、模型摘要失败、摘要失配、工具副作用恢复和成本场景验收。
2. 旧 `packages/memory-core/src/distill.ts`、archive 月/年摘要写入、Vector 装饰写入和 CLI archive adapter 已在阶段 14/20 退役，仓库卫生门阻止其回流。阶段 21 已完成结构化 daily 一对一提升；阶段 22 已开放受限的 duplicate-projection 合并，阶段 23 已开放受限的叶子跨 parent 重组，阶段 24 已开放受限的 same-claim-refinement，阶段 25 已开放受限的 evidence-backed correction/conflict replacement，阶段 26 已开放受限的非叶子 subtree move。模型只能提出本轮 KnownState 内的结构化方案，Runtime 负责证据、语义/关系边界、规模上限、审计、原子提交和恢复。下一步评估真实 Provider 提案质量、跨陈述重写和超大子树人工治理。
3. 对旧用户数据中缺少执行日志、缺少可选 workspace artifact 索引的情况制定只读诊断和渐进治理；workplace 资源索引在下一次真实 run 时按需创建，不为消除警告而提前扫描或改写用户文件。
4. 实体/关系 catalog、自动关系投影、提交后激活、启动补偿和冲突/替代调和已完成阶段 15 质量门。下一步在真实 Provider 与持续用户负载中验证 Runtime 是否仍能以最少且足够的 Atom 完成本轮任务，并持续保持零 scope 泄漏、可解释采用/排除、执行中可释放/重入和重启一致性。Skill 合并仍先给出可审查方案，低收益 Skill 优先停用或归档，删除必须经过引用检查、保留期与恢复验证。

**验收标准**：长会话压缩后仍能沿记忆树恢复关键事实、任务约束和来源；压缩过程可追溯、可失败回退，不制造孤立记忆。

### P1：拓展工作区与渠道场景

1. 在真实项目中连续验收文件树、标签、编辑冲突、终端 PTY、权限模式、产物索引和重启恢复。
2. 使用真实渠道凭证验收消息插入 Agent 和回复回传；渠道异常不能影响本地 UI 核心。
3. 在已有 PTY/ConPTY 基础上，决定是否开放受控的原始键盘直通与交互式程序；同时完善发布环境下的原生模块装载/回退，并单独评估重度 IDE 能力。
4. 拓展工作区中的浏览器已完成基础真实能力：HTTP(S) webview、内部链接/新窗口回收、独立前进/后退/刷新和 50 条 URL 历史已接通；仍需在真实网络、重定向、登录态和重启场景中持续验收。侧边聊天仍是占位工作面。

**验收标准**：主对话区、拓展工作区和侧边栏相互独立；应用重启后布局、标签、会话和产物状态符合持久化约定。

### P1：开发环境正式分发

- 设置页的版本偏好、导入、移除和终端优先路径已经形成基础闭环，但当前只有 Electron 内置 Node 随应用提供，其他运行时仍需要用户准备并导入已解压目录。
- 后续必须先完成官方来源锁定、SHA-256/签名校验、取消与恢复、低磁盘空间和损坏包清理，再决定哪些运行时随安装包提供、哪些按需下载。
- Windows 真实工具链目录布局和原生可执行文件导入矩阵仍需人工验收；不能把 Linux 定向测试替代 Windows 分发证据。

**验收标准**：用户能在设置页选择并验证目标版本；终端在重启后继续使用同一受管版本；下载、升级、取消、恢复和卸载不会损坏用户数据根或遗留半成品工具链。

### P1：发布与安装

- 当前只有源码构建和本地快捷方式流程，尚未完成签名安装包、升级、卸载、原生依赖分发和发布回滚流程。

**验收标准**：在干净 Windows 环境安装、启动、升级和卸载；用户数据与应用版本升级解耦且不丢失。

### P2：MCP 与生态扩展

- `packages/mcp/src/index.ts` 仍是骨架包。需要先明确服务器生命周期、权限、工具命名冲突、超时、日志和用户批准策略，再实现客户端。

**验收标准**：MCP 工具遵守与内置工具相同的权限、清洗、超时、执行记录和恢复契约。

### P2：插件生态扩展

- 插件 API v1 当前接通 `channel`、`tool` 和声明式 `skill`。供应商、记忆分支、工作区、自动化和 renderer UI 仍是规划中的扩展位，不能通过增加 manifest 字符串冒充已实现。
- 后续每个扩展位都要单独定义宿主接口、权限边界、持久化目录、启停/升级/失败恢复语义和 UI 管理入口，再升级 API 版本。
- 还需要补充插件安装、版本兼容、签名/来源提示和卸载流程；目前以用户数据目录发现和手动放置为主。

## 推荐后续顺序

1. 保持当前 DeepSeek chat、continuity、tool、abort、跨重启最终回答连续性与普通回答本地精确 token 对账为回归门；先校准含历史 `tool_calls`/`tool` 结果的续轮 framing，再用真实 Provider usage/耗时量化单工具任务的 Context 紧凑化收益。只有 OpenAI/GLM 实际配置并进入用户选择范围后，才为其执行同等真实校准和模型专用 tokenizer 验证。远程 Embedding 不纳入默认路径。
2. 在正式 V3 上验收真实会话写入、索引导航、验证反馈、本地向量持续维护和应用重启连续性，并继续积累 KnownState、显式 Atom 使用、最终 VERIFY 和资源样本。
3. 在已完成的统一 Tool Execution Service 上补齐网络资源声明、授权 token 与 MCP adapter 验收，但不再建立第二条工具执行路径。
4. 保持已完成的 RuntimeEventQueue、安全边界、TaskBookPatch、Renderer 事件生产、TaskBook 步骤级并行、Runner 续跑、应用启动恢复、活动任务 SSE、设置页“应用与后台”、托盘、三档关闭策略、shadow Git 检查点和隔离 Electron 跨重启质量门；下一阶段改用真实 DeepSeek 多步骤长任务验收上下文、工具副作用、断线恢复和长期资源回落，之后再推进开发环境正式分发、Mode Registry、插件 API v2 与 MCP。

## 维护规则

- 本文件只记录当前事实和可复现证据；完成一项能力必须同时更新测试、构建证据和本文件。
- 每次更新当前状态时记录精确到秒的验证时间，并区分“最近一次绿色基线”“当前工作树结果”和“历史专项验收”；三者不能互相替代。
- 任何“已完成”都要说明范围：基础形态、配置层、连接器层和真实场景验收不能混为一谈。
- 不把用户密钥、用户会话、记忆树或工作区文件复制到仓库；运行时数据只在用户数据目录中维护。
- 顶层分工见 [architecture-principles.md](../principles/architecture-principles.md)，当前架构评估和决策点见 [architecture-decision-report.md](architecture-decision-report.md)，目录和模块归属见 [repository-guide.md](../reference/repository-guide.md)，插件边界见 [plugin-development.md](../reference/plugin-development.md)。
- 当前先行仓库整理和认知契约见 [总基调、认知架构与仓库基元化任务书 2026-07-15](../taskbooks/foundation-cognition-repository-taskbook-2026-07-15.md)。
- Memory v3 的原子文件、层级、内置向量目录、三层视图、动态注入、压缩连续性和迁移边界见 [原子记忆与内置向量目录任务书 2026-07-17](../taskbooks/memory-atom-vector-catalog-taskbook-2026-07-17.md)。
- 核心能力细节见 [核心 Agent 能力任务书 2026-07-13](../taskbooks/core-agent-capability-taskbook-2026-07-13.md)，拓展工作区细节见 [拓展工作区任务书 2026-07-12](../taskbooks/extension-workspace-taskbook-2026-07-12.md)。
- Context、记忆分级、附件、运行中重入、有界并行、检查点和后台连续执行的专项计划见 [Agent Runtime 连续性任务书 2026-07-14](../taskbooks/agent-runtime-continuity-taskbook-2026-07-14.md)。
- 本轮工具并行、shadow Git、退出冻结、LLM 调用收敛和前台人格表达边界见 [Agent Runtime 效率与版本化连续性任务书 2026-07-17](../taskbooks/agent-runtime-efficiency-versioning-taskbook-2026-07-17.md)。
- 开发环境版本管理、工具链导入、终端优先路径和后续运行时分发边界见 [开发环境管理任务书 2026-07-19](../taskbooks/development-environment-taskbook-2026-07-19.md)。
