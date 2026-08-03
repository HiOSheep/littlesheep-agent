# LittleSheep Agent Runtime 效率与版本化连续性任务书 2026-07-17

最后更新：2026-08-04 03:59:20

状态：已完成统一 Tool Execution Service、工具调用级与 TaskBook 步骤级有界并行、数据与工作区 shadow Git 检查点、退出冻结、有界 `RuntimeEventQueue`、活动 run ingress、Harness 安全边界、确定性 `TaskBookPatch`、延迟事件重规划、Renderer 事件生产/反馈入口、持久 RunCheckpoint、Runner 显式续跑、应用启动恢复控制面、活动任务控制、后台托盘、三档关闭策略和设置页“应用与后台”的工程基线。确定性 Electron 七场景，以及真实 DeepSeek 后台九场景、暂停/继续/中断、强制终止、跨重启恢复、回答级记忆连续性、主动断线恢复、多轮五字段摘要连续性、当前 120 秒诊断门、正式 2 小时持续负载和短时并行压力均已通过；DeepSeek V4 Flash 普通请求与工具协议已完成 `15/15 exact_match`，显式单工具路径 Prompt 为 `796`，LLM 自主选读工具路径 Prompt 为 `2,325`。Pro 工具协议、非字段事实和外部系统副作用仍待验收。

> 历史证据边界：本任务书保留各阶段当时的测试数字，不代表当前质量门；最新源码状态、测试数量和下一步只以 [项目状态](../decision/project-status.md) 为准。

本文是本轮“并行执行、可回退、少而有效地调用 LLM”工作的专项任务书。长期分工以 [架构原则](../principles/architecture-principles.md) 为准，当前事实以 [项目状态](../decision/project-status.md) 为准，旧连续性任务书中的阶段设计仍有效，但与本文冲突的完成状态以本文和项目状态为准。

## 1. 目标与边界

本任务线只服务两个核心目标：不失忆、高效完成任务。所有缓存、日志、版本、调度和上下文结构都必须证明能够减少丢失、重复、等待、无效 Token 或恢复成本，否则应简化或延后。

- LLM 负责理解、推理、提出计划、工具调用建议和用户可见表达；Agent Runtime 负责状态、权限、调度、执行、验证、记忆提交、版本和恢复。
- 用户看到的最终回答、执行结论和阶段性表达必须由真实 LLM 调用结合运行时 `SOUL.md` 生成。确定性代码只负责隐藏的流水记录、状态装配、验证、版本提交和安全兜底，不能把有风格的前台表达改成固定模板；重复、空回复或模型失败只能显示 Runtime 错误/状态。
- 并行只针对相互独立、无资源读写冲突、权限语义明确的工具调用或 TaskBook 步骤；缺少完整依赖、工具、资源和副作用信息时默认串行。工具调用并行与步骤并行仍是两层独立调度，不能混为无上限并发。
- 版本化只作用于 LS 应用数据和用户明确授权的工作区，不修改用户已有 `.git`，不把密钥、缓存、SQLite/WAL、构建物或无关未跟踪文件纳入管理。

## 2. 已完成实现

### 2.1 工具调用级并行

- LLM 在同一响应中提出多个独立工具调用时，Runtime 先做依赖、资源读写和权限判定，再把安全的调用分成有限波次执行。
- 默认并发度为 4，硬上限为 8；读操作可并行，不同文件的写入可并行，`exec`、Skill 创建和未知副作用保持独占。
- 同一资源、重叠路径、共享审批或顺序敏感操作自动串行；结果按模型原始调用顺序归并，保证并发不会改变证据语义。
- 每个分支保留开始、结束、状态、错误、耗时和工具结果；取消、超时和失败不会重做无关分支。

主要实现：`packages/tools/src/tool-execution-service.ts`、`packages/tools/src/tool-execution-scheduler.ts`、`packages/harness/src/stages/execute/tool-loop.ts`。

### 2.2 Shadow Git 与检查点

- LS 数据根和用户工作区使用相互独立的本地 bare shadow Git；用户工作区原有 `.git` 不被接管或污染。
- 每次完整 run 生成关联的数据域与工作区域检查点，manifest 采用 `pending`、`complete`、`partial` 状态，记录 run、session、before/after revision、文件清单、时间和结果。
- `write`/`edit` 修改前必须先成功保存 preimage；可能写入的 `exec` 先冻结工作区。创建前不存在的文件可回退为“不存在”。
- 支持回退到 run 的 `before` 或 `after` 状态；只恢复 shadow Git 管理的文件，不执行 `git clean -fd`，无关未跟踪文件保留。
- Runner 关闭时先关闭 SQLite/Embedding，再执行 `shutdown-freeze`；退出期间未完成的检查点保留可诊断状态。
- 密钥、缓存、日志、SQLite/WAL、向量和构建产物等敏感或可再生内容默认排除，不能因为 checkpoint 存在而进入版本库。

主要实现：`packages/types/src/versioning.ts`、`packages/snapshot/src/git-client.ts`、`packages/snapshot/src/git-checkpoint.ts`、`packages/snapshot/src/git-checkpoint-files.ts`、`packages/runner/src/version-checkpoint-lifecycle.ts`。

### 2.3 LLM 调用与上下文收敛

- 每轮模型调用有独立 `modelCallCount` 和默认 32 次硬上限，不依赖有界观测数组的长度。
- `CAPTURE` 默认从已持久化的对话、步骤和工具状态生成确定性 daily 原子，不为内部流水额外调用 LLM；`EVOLVE` 使用 `adaptive/always/never`，默认只在复杂任务、持久化工具、恢复/重规划或明确记忆信号出现时调用。
- `REPLY`、DECIDE 产生的任务说明、执行步骤结果、VERIFY 说明和多步骤 `execute_final_reply` 都必须在当次 run 中实时调用当前 Provider API 生成；运行时生成的澄清事实只能作为 `ASK_USER` 的输入，最终文本仍由 LLM 现场组织，不能直接发送，也不能从模板库、预备文案池或历史回答选取。这里不存在“LLM 生成候选文案后由 Runtime 挑选”的前台流程：Runtime 只校验真实 API 返回的来源、事实边界和唯一性。所有前台自然语言调用均注入运行时 `SOUL.md`，保证用户配置的人格、语气和渐进式披露风格；`ReplyProvenance` 绑定真实 model request，API 返回在发布前由持久化会话级注册表原子占用规范化指纹，完全重复时最多重新实时调用两次当前 Provider API，仍重复、注册表失败或生成失败只呈现 Runtime 错误/状态。按钮、状态、权限、路径和进度由 Runtime 固定提供，`FINALIZE` 禁止新增模型调用，只负责校验并持久化已经生成的回复。
- 显式工具任务已建立有界提议路径：DECIDE 只接收用户明确点名的最多 4 种工具 schema，为每个可分别验证的步骤生成一个 `toolProposal`；单 schema 最多 12,000 字符、总计最多 24,000 字符，每个 TaskBook 最多采用 8 个提议。Runtime 再校验名称、schema、依赖、资源、副作用、权限和审批；直接执行接受可证明且无需审批的 `read/write`，以及完全访问模式下来源明确为内置、参数完整、非 Checkpoint 恢复态的单次 `exec`，随后只调用一次 `execute_final_reply`。续接、记忆追问、需审批、参数不完整或边界不可证明时自动回退普通执行链；Runtime 不从自然语言猜参数。2026-08-04 最新真实 `glob` 验收为 2 次 API、1 次工具调用，DECIDE/final prompt `417/379`、Provider total `840`；最新真实两步 `write -> read` 恢复任务同样只有 `decide -> execute_final_reply` 两次 API，耗时 `6.466s`，两次工具各成功一次。本轮有权威 usage 的请求合计 Provider total `6,889`；中断分支不伪造 Provider usage。6 分钟历史门、当前 120 秒诊断门和正式 2 小时门均确认单次内置 `exec` 只执行一次、暂停在工具完成后生效且恢复不重放副作用。
- 2026-08-03 13:45:32 的单只读工具历史边界：自包含且来源可证明为内置的单个 `glob / grep / read` 进入独立 `decide_explicit_tool` 契约，不加载历史、附件、记忆、完整 Workflow 或 bootstrap；当时模型仍生成最小需求字段和一个 schema-bound 提议，Runtime 再展开为既有 TaskBook 并复核来源、名称、schema、路径边界、权限和副作用。该次真实 `glob` 为 2 次 API、1 次工具、`2.901s`；紧凑决策 prompt `629`，全程 prompt `1,479`、Provider total `1,702`，两次本地 tokenizer 均为 `exact_match`。该数字保留为历史，不再作为当前成本基线。
- 2026-08-04 00:34:33 的当时单只读工具边界：`decide_explicit_tool` 只要求模型返回 `input`，或在参数无法安全确定时返回澄清对象；工具名由 Runtime 锁定，旧 `summary / successCriterion / userNeed / goal / toolProposal` 响应继续兼容读取。Runtime 从原始用户输入展开 TaskBook，并复核 schema、路径、权限和副作用；紧凑最终回答只接受 trivial 单步骤、builtin `glob / grep / read`、无审批、无副作用、未清洗/截断，且 TaskBook、步骤结果、工具结果与权威调用记录 `callId` 完整一致的结果。该次真实 `glob` 为 2 次 API、1 次工具，DECIDE/final prompt `417/382`、全程 prompt `799`、Provider total `830`，两次本地 tokenizer 均为 `exact_match`；回归上限已收紧为 `500/450/950`。本次耗时 `2.842s` 只作运行记录，不能据此宣称速度变化。附件、历史指代、记忆介入、恢复态、运行时事件、同名插件/run-scoped 工具、多工具、写入、执行、调用审计不一致或边界不明请求继续回退完整路径。
- 2026-08-04 03:51:17 的最新“用户只表达目标”自主只读路径：只有请求新鲜、自包含、无附件、无续接、无实际记忆介入、无恢复态且不含写入/执行语义时，DECIDE 才在 builtin `glob / grep / read` 中选择最小工具集合；EXECUTE 使用 Provider 原生 `tool_calls -> tool result -> final answer`，不要求用户知道或点名工具。Runtime 继续复核工具来源、schema、路径、权限、结果、SSE、结构 VERIFY 与调用审计。只有 `excluded` 的记忆候选不算真实 Context 依赖；`adopted/conflicted`、活动 working set 或实际注入记忆会失败关闭。最新真实 `glob` 固定 3 次 API、1 次工具，prompt `663/726/936`、合计 `2,325`，相对原始完整路径 `11,050` 下降约 `79.0%`，三次均为 `exact_match`；回归上限 `750/850/1,100`、总上限 `2,700`。
- 2026-08-03 09:04:52 的短时并行压力门通过延迟代理制造取消、后台与重启窗口：14 次请求中 13 次实际转发、1 次在转发前取消，所有已转发请求都取得 Provider usage 并与本地 tokenizer `exact_match`，Provider 合计 prompt `23,358`、completion `2,986`、total `26,344`。同场景 `glob` 仍只有 `DECIDE + execute_final_reply` 两次模型调用和一次工具调用，本地/Provider prompt 为 `2934/2934`、`802/802`，没有重新引入额外工具循环或 VERIFY 模型调用。两条恢复会话的最终回答各自准确承接历史文件名和验收码并判定 `supported`；这项用户可见证据是“不失忆”的验收主体，内部检索成功不能替代。
- 后续复跑的最新短时并行 Provider total 为 `20,389`，结束后 active run/retired Runner 均为 0，source/listener 回到 1；2026-08-04 最新多轮压缩续答转发 8 次 Provider 请求，合计 Provider total `8,005`，最终续答 prompt 本地/Provider `1263/1265`，状态 `within_tolerance`，主动断线请求未到达 Provider。历史压力门和摘要门的固定数字继续保留在对应任务书时间点，但不得再作为“最新”引用。
- Context Engine 区分阶段软目标与模型窗口硬上限：先按优先级裁剪可选内容，必要内容在未超过真实模型窗口时可以超过软目标；未知模型不会凭软目标触发会话压缩。
- 每次请求在缓存边界后注入精确到秒的 runtime awareness；最近对话优先于重复的静态时间段，时间、耗时和进度仍由运行时事实提供。
- 记忆上下文继续沿 `root index -> branch index -> expand -> branch-scoped search`，只把有任务价值、作用域正确、证据可解释且预算允许的 Atom 放入请求。

主要实现：`packages/harness/src/model-observability.ts`、`packages/context/src/engine.ts`、`packages/harness/src/context-candidates.ts`、`packages/harness/src/stages/capture.ts`、`packages/harness/src/stages/execute/final-reply.ts`。

### 2.4 RuntimeEventQueue 与安全重入基元

- `packages/runner/src/runtime-event-queue.ts` 提供 run/session 隔离的有界事件队列；事件数量、payload 大小、事件寿命和决策批次都有硬上限。
- 入队支持稳定 sequence、事件 id 与 `dedupKey` 幂等去重；重复且语义相同的事件返回已有记录，冲突、越界和容量不足显式拒绝，不静默丢弃。
- 队列支持过期标记、单一决策批次租约、原子结算和失败释放；已完成事件可裁剪，`cursor` 与序号仍保持连续，避免长 run 的集合无限增长。
- 快照只保存有界事件状态，恢复时不恢复悬挂的决策租约；`contextSummary()` 只暴露类型、来源、序号和 payload key，不把完整 payload 默认注入 LLM。
- `ActiveRunRegistry`、Local App API 和 Renderer API 已提供 run-scoped ingress；停止按钮会发送控制事件，活动 run 中的普通输入会发送任务变化事件而不创建第二个 run。Harness 在每个 stage 前先处理控制事件，再处理任务变化事件。
- `pause / resume / interrupt` 使用独立安全批次；携带确定性 `TaskBookPatch` 的任务事件会在队列结算成功后原子更新 TaskBook，未携带 patch 的事件进入有界延迟区并回到 DECIDE 重规划。
- 普通追加消息、设置变化和工作区文件保存已由 Renderer 生产；文件事件只携带路径、类型、大小和修改时间，不携带文件正文。只有 `accepted`、`duplicate` 清空输入，网络失败、过期、冲突、拒绝和队列满均保留输入；响应丢失重试复用同一事件 id 与 `dedupKey`。
- 事件结果使用 Runtime 状态提示，不伪装成 Agent 对话；提示共用一个有清理路径的计时器。Local App API SSE 统一使用 15 秒注释心跳、512 KiB 单连接待写上限和幂等清理；普通 Agent/Checkpoint 观察连接断开不会取消 Main 任务，终端主动命令仍保持断连取消语义。真实 DeepSeek 后台两步任务、主动断线恢复、短时并行压力、6 分钟诊断门和正式 2 小时门已通过；更长期真实用户负载仍待观察。

### 2.5 持久 RunCheckpoint 与 Runner 显式续跑

- `RunCheckpointStore` 原子保存版本化 TaskBook、步骤执行、事件队列、权限、循环预算和副作用状态，并对数量、大小、版本、作用域和恢复数据做有界校验。
- disposition/controller 以 claim/interrupt/complete 事务防止同一检查点并发续跑；旧进程残留的 `resuming` 租约会转换为可审计、可重新领取的 `interrupted`。Runner 的 `resumeCheckpoint()` 不重复追加原始用户输入，并恢复 TaskBook、事件和执行状态。
- 不确定外部副作用、缺失原始输入或缺失工具时续跑会失败关闭，不用聊天文本猜测进度。
- Main 启动发现、Local App API 有界列表/详情/放弃/SSE 续跑和 Renderer 恢复控制面已经接通；用户可查看现场、补充信息、继续、停止或放弃，恢复后会强制重载对应会话。真实 Electron + DeepSeek 已验证两个独立任务分别暂停/中断后强制终止、重启并行领取原检查点，恢复工具调用均为 0，成功副作用文件的哈希、大小和 mtime 不变；真实外部系统副作用仍需独立验收，因此当前不是生产就绪声明。
- 2026-07-29 定向复核覆盖队列、活动 run 注册、安全边界、TaskBookPatch、checkpoint store/controller、Runner 续跑和 App ingress，共 9 个测试文件、43 项全部通过。

### 2.6 统一 Tool Execution Service

- `@littlesheep/tools` 统一拥有工具查找、来源、schema 校验、Permission Policy 与单次批准、超时、中断、资源冲突调度、结果清洗、`tool_start/tool_end` 和有界 `ToolInvocationRecord`。
- Harness 只保留模型循环、TaskBook 步骤编排和副作用检查点钩子；Runner 保留 run-scoped 工具合并及来源装配，Execution Log 优先持久化统一服务的权威记录。
- 调用记录最多保留 256 项，重复调用索引最多 1024 项；输入指纹序列化有深度、集合项数和 64 KiB 上限，观察者异常不会破坏真实工具执行。
- 旧 Harness 调度器已迁移删除；旧执行日志缺少权威记录时仍可从 tool message 推断兼容证据。

### 2.7 TaskBook 步骤级有界并行

- DECIDE 与 `TaskBookPatch` 支持为步骤声明 `serial/parallel`、仅指向更早步骤的依赖、资源读写集合和副作用；嵌套执行契约经过运行时校验。
- Runtime 默认同时运行 2 个步骤、硬上限 4；串行步骤形成调度屏障。缺少完整工具/资源/副作用契约、需审批、受限权限、研究模式写入、容器外资源、外部副作用或冲突路径一律退回串行。
- 每个并行分支有独立 `AbortController`，父 run 中断向下传播；分支内工具并发限制为 1，避免步骤并发与工具并发相乘。
- Tool Execution Service 会再次校验实际工具资源位于步骤声明封套内，独占工具不能进入并行分支；多个并发分支的审批回调仍串行。
- 分支消息、工具结果和执行证据按 TaskBook 顺序稳定归并，不按完成先后打乱。恢复时已完成兄弟分支保持完成，不重新执行。
- `RunCheckpoint` 在保留旧 `currentStepId` 的同时，可有界记录最多 4 个 `activeStepIds`；旧 v1 检查点仍可读取，应用恢复摘要可展示多个活动步骤。

主要实现：`packages/harness/src/stages/execute/task-step-scheduler.ts`、`task-step-runner.ts`、`task-book-runner.ts`、`packages/tools/src/tool-execution-service.ts`、`packages/runner/src/run-checkpoint.ts`。

## 3. 尚未完成

1. **后台持续负载验收**：真实 DeepSeek 两步任务、主动断线恢复、短时并行压力、6 分钟诊断门和正式 2 小时门已覆盖托盘、窗口关闭、4 个活动 run、暂停/继续/中断、强制终止、双 Checkpoint 并行续跑、SSE 重连、配置热重载和彻底退出；后续仍需验证更长期真实用户负载和真实外部系统副作用。
2. **其他 Provider 校准**：DeepSeek 的 chat、continuity、tool、abort、前台 Runner 与 Flash V4 普通/工具协议本地精确 token 对账已完成；Pro 工具协议以及 OpenAI/GLM 只在实际配置并进入用户选择范围后校准模型窗口、reasoning、usage、模型专用本地账本和前台表达质量。mock 只证明本地结构。
3. **长任务与外部副作用恢复**：两个独立 `write -> read` 任务的并行 Checkpoint 恢复已真实通过，且没有重复工具或文件改写；下一步验证更长的多步骤依赖图、真实网络中断和外部系统副作用恢复，不用单元测试替代产品场景。
4. **版本治理 UI**：在不把内部 Atom 结构暴露给普通记忆页的前提下，增加用户可理解的数据/工作区回退和恢复结果入口；run checkpoint 的启动恢复入口已经完成。

## 4. 验收标准

- 并行与串行在相同输入下得到等价的工具证据、验证结论和记忆写入；冲突资源不并行，长期运行无集合、监听器、子进程或句柄无界增长。
- 每轮完整对话、写入前和退出冻结均有可定位版本；数据与工作区能同步回退，回退不删除无关未跟踪文件，密钥和生成物不入 shadow Git。
- 普通聊天、复杂任务和运行时澄清的用户可见自然语言都能在请求快照中找到本轮当前 Provider 的真实 LLM 调用与 `SOUL`/profile 上下文来源，并通过 `ReplyProvenance` 追溯；同一 UI 回合的更新可以复用已通过检查的文本，但不得把它作为新的消息发送。确定性 CAPTURE 不增加前台模型调用。
- Context 快照记录实际纳入与排除的来源和理由；真实模型窗口未知时不显示伪精确 Token 百分比，也不因软目标误触发压缩。
- 运行中失败、取消、关闭和重启都有明确状态，不能把部分完成伪装成成功。

## 5. 验证顺序

```powershell
pnpm.cmd run check:repo
pnpm.cmd test
pnpm.cmd run typecheck
pnpm.cmd run build
pnpm.cmd run verify:app-recovery
pnpm.cmd run verify:deepseek-v4-tool-tokenizer
pnpm.cmd run verify:electron-deepseek-single-tool
pnpm.cmd run verify:electron-deepseek-tool-loop
pnpm.cmd run verify:electron-deepseek-parallel-load
pnpm.cmd run verify:electron-deepseek-hours
```

涉及正式用户数据时，只读记录 `<用户目录>/.littlesheep` 基线并使用隔离目录验证；未经单独授权不得迁移、重写或清理正式数据。每次桌面构建完成后刷新 `%USERPROFILE%\Desktop\LittleSheep.lnk`，快捷方式必须指向最新本地构建并能直接启动应用。

## 6. 后续顺序

保持 `respond / execute / clarify`、直接回应 Context、统一 Tool Execution Service、TaskBook 步骤级并行、Renderer 运行时事件入口、应用启动恢复、回答级连续性、后台控制面、Flash 工具协议 `15/15` 校准和正式 2 小时持续任务的完整质量门；下一步继续压缩自主选读工具路径，校准 Pro/其他实际启用 Provider，并推进非字段事实、真实外部副作用恢复、版本治理 UI 和严格效率对比基线。
