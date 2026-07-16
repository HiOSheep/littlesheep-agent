# LittleSheep 项目状态

最后更新：2026-07-16 13:23:36

本文件是项目进度的正式来源。状态只根据当前源码、测试和构建结果维护；旧的阶段报告不再作为进度依据。

## 总体判断

LittleSheep 当前是一个**可运行的本地 Agent alpha 原型**：核心状态机、任务执行、索引优先记忆、版本化会话摘要、桌面聊天界面、拓展工作区和可选外部渠道已经形成完整工程骨架，能够继续做真实供应商、长任务和重启连续性验收。

它还不是可直接宣称“生产就绪”的发行版。主要原因是当前内置模型尚无已验证的最终请求精确计数器、真实供应商验证未完成、活动 run 重启续跑、MCP、安装包发布和真实用户场景验收仍未闭环。因此本项目不使用一个没有权重定义的百分比来伪装精确进度，而用能力状态和验收证据表示总进度。产品方向已明确为：解放用户生产力，让用户专注于想法，LS 负责将想法可靠落地；执行和输出统一采用渐进式披露。

**当前阶段：Memory v3 阶段 0-5 已完成；阶段 6 已接通同源 D0-D3 读取、启动前迁移/回滚、实时回滚安全预检、本地向量模型资产检查与显式准备、atom 移动/合并/失效/恢复/导出、首次自动选择、执行中受控纳入/release、原始数据记录孤儿恢复、commit receipt、隔离 soak、真实 Electron 窗口验收和正式 V2 数据副本上的迁移后 Runner 连续性演练。当前正式用户数据仍为 v2，实际切换继续等待用户单独确认。**

## 能力总览

| 能力域 | 状态 | 当前结论 | 主要位置 |
| --- | --- | --- | --- |
| 架构治理 | 仓库基元化阶段 0-7 已完成 | 27 个 package 与指定领域目录均有所有权 README；关键组合入口已收敛为 facade。`check:repo` 自动校验文档、模块和 TypeScript references；单进程 `tsc -b`、受影响包传播和 changed/core/full 三级验证已接通，避免依赖方读取旧声明并降低日常反馈成本 | `docs/reference/repository-guide.md`、`docs/reference/module-split-map.md`、`scripts/workspace-projects.mjs`、`scripts/run-affected-verification.mjs` |
| LLM 调用契约与记忆提交 | 已实现工程闭环 | 每次模型请求解析独立 `LlmCallContract`，声明 purpose、Context、决策、输出、工具、记忆和预算；FINALIZE 禁止模型调用。EVOLVE/CAPTURE 只提交有真实步骤、工具和验证证据的写入，冲突/失效意图只延期审计 | `packages/types/src/runtime-contracts.ts`、`packages/harness/src/llm-call-contracts/`、`model-observability.ts`、`stages/memory-intent-gate.ts` |
| Context Engine | 阶段 1 主要数据链与调用契约已实现，供应商验收未闭环 | 支持确定性候选、来源 segment、契约过滤、预算淘汰、版本化 Summary Memory、附件清单优先、按需附件工具、Provider usage 绑定和双账本 UI；必需 Context 越权或缺失会失败关闭。当前内置模型均明确为 unavailable 并使用不可展示的保守安全估算；真实 Provider 对账尚未完成 | `packages/context/src/engine.ts`、`context-engine/`、`packages/harness/src/context-candidates.ts`、`model-observability.ts`、`packages/config/src/model-capabilities.ts` |
| 运行时时间与执行感知 | 已实现基础闭环 | 每次实际模型请求都会在缓存边界后重新注入本地年月日时分秒、时区/offset、run elapsed、真实 TaskBook 进度和有界工具计时；工具 continuation 明确携带状态与 `durationMs`。上一轮 run 的有界进度/耗时摘要通过执行日志域内的会话 sidecar 原子替换，供紧接着的追问和重启恢复使用，不重写长会话；默认回复不主动输出低价值耗时数字 | `packages/prompt/src/runtime-time.ts`、`packages/harness/src/runtime-awareness.ts`、`model-observability.ts`、`stages/execute/tool-loop.ts`、`packages/runner/src/session-run-summary.ts`、`execution-log.ts` |
| 应用数据根、默认 workplace 与附件生命周期 | 阶段 3 工程实现已完成 | 完整应用数据根默认名为 `.littlesheep`，但可通过环境、locator 和设置整体迁移；`workplace/` 只是未选择其他目录时的默认工作区子目录。粘贴/浏览器导入进入独立受管缓存，按 30 天、256 项、512 MiB 有界清理；workplace 使用可恢复的有界元数据索引，不读正文。设置页可登记完整数据根迁移，下一次启动会在任何写入者初始化前通过外部 locator、同级 staging、全文件 SHA-256 清单和活动元数据路径重绑定完成原子切换；源目录保留，失败继续使用旧目录，提交中断可恢复，回滚同样在下次启动生效。隔离测试已覆盖这些契约，尚未擅自搬迁正式用户数据 | `packages/branding/`、`packages/app/src/main/attachment-cache.ts`、`data-root-migration.ts`、`data-root-metadata.ts`、`packages/memory-tree/src/workspace-resource-index.ts` |
| 长会话压缩 | 已实现基础闭环 | 原始 JSONL 不删除；摘要版本化、记录来源范围、支持增量合并，并在下一轮作为独立 `summary_memory` 介入；摘要同时按 session scope 注册到资源目录，正文仍以会话元数据为权威来源并按需解析；真实长会话、失败回退和成本仍待验收 | `packages/session/src/compaction.ts`、`packages/runner/src/runner.ts`、`packages/prompt/src/builder.ts`、`packages/memory-tree/src/memory-service.ts` |
| 硬控制流 Agent | 已实现 | `ENTER`、分类、决策、执行、恢复、验证、演化、捕获和收尾由 Harness 驱动 | `packages/harness/`、`packages/runner/` |
| 需求判断与任务书 | 已实现 | 支持澄清请求、复杂度判断、TaskBook、步骤验收和局部重规划 | `packages/types/`、`packages/harness/src/stages/` |
| 步骤级执行与恢复 | 已实现 | 保留已完成步骤证据，失败时按步骤恢复，不重复执行已完成部分；工具循环、权限/超时、失败分类、步骤调度和结构验收已分离，stage facade 不再承接内部细节 | `packages/harness/src/stages/execute.ts`、`execute/`、`recover.ts`、`verify.ts`、`verify/` |
| 记忆树运行时协议 | 已实现基础闭环 | 根索引到分支索引再到展开/分支内深搜；首次请求从 D1 元数据最多自动选择 2 个 D2 atom、预算 600 tokens；执行中模型通过受控 `expand/deep_search` 把所需 atom 纳入本轮 working set，也可显式 `release` 无用 atom并释放本轮 token/dedup 预算。模型可见契约已说明纳入、释放和重新介入语义；持久原始数据记录和 atom 不受影响。注册文档正文仍必须先看目录再按需展开 | `packages/prompt/src/sections.ts`、`packages/memory-tree/src/memory-tree.ts`、`memory-tool.ts`、`memory-tree-working-set.ts`、`packages/harness/src/memory-context-working-set.ts`、`packages/runner/` |
| Memory Service 与 Memory v3 | v2 基础闭环；v3 工程、窗口和正式数据副本演练完成 | v2 仍是正式默认。v3 以只追加原始数据记录保存事件最初落盘的数据、以 atom 保存可治理投影、以可重建 catalog 负责层级/FTS/向量；原始记录不把建议、陈述或假设冒充成事实，认识状态由 atom 元数据表达。Recovery journal 只保留有界恢复状态。管理 UI 从同一 Repository/raw record/atom/Catalog 按需展开 D0-D3，并可登记迁移/回滚和执行高级 atom 管理；原始数据记录已写但 journal 未写的崩溃可在重启时自动补投影。隔离 Electron 窗口已完成 D2/D3、菜单、移动、失效/恢复、证据导出和全局返回/前进验收；当前正式 V2 副本还通过了迁移后真实 Runner 会话、EVOLVE/CAPTURE、重启恢复、索引/FTS 和写入后回滚关闭验收，但正式 backend 尚未切换 | `packages/memory-tree/src/memory-repository/`、`packages/memory-tree/src/v3/`、`packages/app/src/main/memory-v3-bootstrap.ts`、`packages/app/src/main/memory-atom-control.ts`、`packages/app/src/renderer/MemoryTreeView.tsx`、`scripts/verify-memory-v3-migration-readiness.mjs`、`docs/taskbooks/memory-atom-vector-catalog-taskbook-2026-07-15.md` |
| 项目身份与路径重绑定 | 已实现基础闭环 | 新项目使用与路径无关的稳定 ID，旧路径派生 ID 原样保留；项目移动或重命名后可从侧边栏重新定位。持久化事务日志幂等迁移会话、归档、记忆 scope、项目投影、工作区文档资源、产物、终端活动、布局、导航状态和当前运行路径；路径冲突会拒绝提交 | `packages/app/src/main/project-index.ts`、`project-rebinding.ts`、`path-rebinding.ts`、`packages/memory-tree/src/memory-service.ts` |
| 记忆管理控制面 | v2 基础闭环；v3 同源读取、迁移和高级管理已接通 | UI 操作真实运行时索引与注册表。v3 树概况只加载 D0/D1，D2 正文与 D3 原始数据记录/证据/历史/关系按需展开；“更多”菜单可移动、合并、失效、恢复和导出单 atom 证据包，所有操作进入同一 Repository transaction，不建立 Renderer 副本。迁移页支持预检、登记、取消、重启执行和失败恢复；回滚登记前会通过当前运行中的同一 V3 backend 核对原始 snapshot、V2 源与 V3 validation。固定本地 BGE 资产以大小和 SHA-256 单独校验，缺失/损坏/准备中/失败/就绪状态真实可见；下载只由用户显式触发，可取消，应用退出会中止 | `packages/app/src/renderer/MemoryTreeView.tsx`、`packages/app/src/renderer/memory-tree/`、`packages/app/src/main/memory-embedding-model-control.ts`、`packages/app/src/main/local-app-api/memory-migration-routes.ts`、`packages/memory-tree/src/memory-repository/v3-migration-validation-state.ts` |
| 执行记录与历史重放 | 已实现 | 已完成 run 的 TaskBook、步骤、工具调用、验证、调用契约、Context 快照、记忆意图运行时判定和有界资源 ID 可持久化并重放；附件正文不进入执行日志；这仍不等于活动 run 在应用重启后续跑 | `packages/runner/src/execution-log.ts`、`packages/app/src/renderer/TraceCard.tsx` |
| 桌面聊天与流式交互 | 已实现基础形态 | Local App API、SSE、Markdown、附件、审批和中断已接通 | `packages/app/src/main/local-app-api-server.ts`、`packages/app/src/renderer/` |
| 权限与行为模式分离 | 已实现基础形态 | 通用/编程系统提示词与完全访问/研究/受限权限策略分离 | `packages/prompt/src/profiles.ts`、`packages/app/src/main/run-policy.ts` |
| 核心源码自修改保护 | 已实现内置工具硬闸 | Runner 从实际 workspace 标记自动发现 LS 核心源码根，并通过 ToolContext 传递只读边界；内置 `write`、`edit` 无条件拒绝核心源码路径，`exec` 在核心根内只允许保守只读诊断，完全访问与单次审批不能绕过。第三方本地插件仍属于用户显式完全信任边界，受控自我修改尚未开放 | `packages/runner/src/core-source-protection.ts`、`packages/tools/src/path-protection.ts`、`packages/tools/src/builtin/` |
| 拓展工作区 | 已实现基础形态 | 文件树、标签、内置编辑器、产物索引、PowerShell/PTY 终端和恢复快照已接通 | `packages/app/src/renderer/`、`packages/app/src/main/workspace-*.ts` |
| 模型供应商配置 | 已实现配置层 | OpenAI、DeepSeek、GLM 预置；只有配置了可用密钥的供应商/模型应进入选择范围 | `packages/config/`、`packages/app/src/main/keychain.ts` |
| 插件运行时 | 已实现基础闭环 | 插件发现、manifest 校验、启停、错误隔离、本地代码信任和 Runner 工具迁移已接通；当前支持 `channel`、`tool` 和声明式 `skill` 贡献。插件 Skill 使用 owner-scoped 来源和稳定资源 ID，随插件启停、移除、路径变化及 Runner 重建同步 | `packages/plugins/`、`packages/skills/`、`packages/memory-tree/src/memory-service.ts` |
| 外部渠道 | 已插件化基础形态 | Webhook、Telegram、飞书、QQ Bot 是可选渠道插件，只负责消息进出；没有配置时不加载实现 | `packages/channels/`、`packages/plugins/` |
| 技能系统与经验库 | 已实现基础形态，治理待补 | Skill 已区分 builtin、user、external、plugin 来源，支持 active/disabled/shadowed 与 owner-scoped 插件同步；创建时会拒绝同名覆盖。尚未实现语义去重、合并方案、冲突/回滚、基于验证收益的停用/归档/删除策略和用户可审查治理队列 | `packages/skills/`、`packages/experience/`、`packages/memory-tree/src/memory-service/skill-resources.ts` |
| Runtime 连续执行 | 尚未实现完整闭环 | 已有 `AbortSignal` 和步骤级局部恢复；运行中用户事件重入、活动 run 检查点、幂等续跑、后台任务与托盘尚未完成 | `packages/harness/`、`packages/runner/`、`packages/app/` |

## 当前验证结果

当前工作树的工程质量门已经恢复为绿色。真实供应商冒烟仍是独立验收门，不能因为本地测试通过就宣称三家 Provider 已完成校准。

| 检查 | 当前工作树结果 | 证据命令 |
| --- | --- | --- |
| 仓库卫生 | 通过：31 项通过，0 项失败 | `pnpm.cmd run check:repo` |
| 开发快速门 | 本轮未单独重复执行；已由更强的全量测试、全工作区类型检查和完整构建覆盖 | `pnpm.cmd run verify:changed` |
| 核心 Agent 门 | 本轮未单独重复执行；核心契约包含在全量 1176 项通过测试中 | `pnpm.cmd run verify:core` |
| 全量测试 | 通过：152 个测试文件；1176 passed、1 skipped | `pnpm.cmd test` |
| 全工作区类型检查 | 通过：27 个 workspace package 的 project references 完整通过 | `pnpm.cmd run typecheck` |
| 全工作区构建 | 通过：类型图与 Electron main/preload/renderer 完整构建 | `pnpm.cmd run build` |
| 应用恢复源检查 | 通过；现有数据根、默认 workplace、会话、执行日志目录、资源索引、终端活动和布局均可读取；仍保留部分旧 run 缺执行日志与可选 workspace artifact 索引缺失的诊断警告 | `pnpm.cmd run verify:app-recovery` |
| 桌面快捷方式 | 已刷新至最新 Electron 构建并通过桌面快捷方式重新启动；`LittleSheep` 窗口可见且 `Responding=True` | `scripts/refresh-desktop-shortcut.ps1` |

供应商冒烟脚本已经能够脱敏执行最小聊天、reasoning、工具调用、`reasoning_content` 续接、流式中断和 usage 对账。当前验证环境中，DeepSeek 请求已到达官方端点但因凭证无效返回 HTTP 401；OpenAI 与 GLM 未提供可用测试凭证。因此阶段 1 仍不能标记为完成，且文档不得把“脚本可用”写成“三家真实能力已验收”。

## 已完成能力

### Agent 核心

- 分类结果区分闲聊、可执行问题和真正不清晰的请求。
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
- v3 已冻结 User、Agent Self、Task/Project/Session、Experience、Knowledge domain 与 D0-D3 契约，并已通过同一 facade 在隔离 Runner 路径运行；正式配置仍默认 v2，生产 UI 尚未切换。
- v3 已登记 user/project/file/session/task/skill/tool/rule/concept 等稳定实体和有向关系，并投影 atom 对实体/关系的引用；归档、删除或物理清理前会检查直接引用和入/出边。名称、路径、共现与向量相似只作为候选关联，不自动证明同一实体、所有权或因果关系；当前 v2 尚无统一实体/关系 schema。
- v3 已实现 `MemoryUpdateEvent`、持久 journal、幂等存储协调器、due index、启动补偿消费者与两类崩溃点重放；due 消费先持久捕获幂等 `time-due` 事件再确认。真实 Runtime 事件生产和后续归并属于连续执行阶段，v3 atom 管理 UI 属于 Memory v3 阶段 6。这里的“不失忆”仍指持久、可发现、可追溯、可恢复且相关时可取回，不是把全部记忆常驻 Prompt。
- v3 已接入真实本地 Transformers.js Embedding：模型资产固定 revision、大小和 SHA-256，产品运行禁用远程模型与框架缓存。BGE 平衡档与 multilingual E5 质量档均在阻断进程内网络后完成真实基准；向量不可用时层级和 FTS 保持工作。成功 atom 写入后会等待一次有界、并发合并的维护批次，失败不回滚 atom，shutdown 会释放本地模型 pipeline。
- v3 写入已经把用户/外界陈述分类为目标、偏好、报告观察、事实主张、建议/假设和决定/批准，并分别记录 epistemic status 与 authority scope。用户对自身意图和取舍具有权威，客观技术 claim 仍需证据；v2 原节点没有保存这些字段，安全迁移只按保守规则重建，不伪造旧元数据。
- 自动写入使用结构化意图，记录作用域、层级、来源 run、置信度和理由；用户可在记忆树控制面管理真实数据。
- 模型提出的记忆操作与运行时提交权分离；无真实证据或低价值写入会拒绝，冲突/失效只进入有界审计记录。
- `PHILOSOPHY.md` 保存用户确认的长期理念，默认只在资源索引中出现，任务相关时才按预算展开正文。
- 长期记忆、项目记忆、经验和 daily 流水在概念上分开，避免把过程噪声全部变成长期记忆。
- 项目记忆完整权威数据保留在 LS 用户数据中；项目内私有投影需要显式启用并经过白名单过滤，共享导出使用独立、更严格的 Markdown 白名单。隔离数据根的真实 Electron 验收已覆盖启用、Git 隐私提示、外部冲突、删除保护、覆盖确认和恢复同步。

### 桌面应用

- Electron 主进程内嵌 Runner；渲染器通过 loopback 随机端口的 Local App API 通信。
- Local App API 与外部渠道插件完全分离；没有外部渠道时应用仍可独立运行。
- 聊天支持流式回复、Markdown、代码块复制、附件、工作区选择、权限审批和中断。
- 执行过程默认折叠但可展开，用户消息使用气泡，Agent 回复和工具过程使用无气泡时间线。
- 执行中优先显示当前步骤和关键状态，命令与原始输出按需展开；任务结束后过程自动收拢，只保留结果摘要，失败和风险仍在默认层明确显示。
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
- 文档已明确区分目标架构、当前事实、演进建议和专项任务书；Context Engine 只按“阶段 1 主要数据链已实现、真实供应商验收未完成”记录，统一 Tool Execution Service 与 Mode Registry 仍不按已完成能力记录。
- [总基调、认知架构与仓库基元化任务书](../taskbooks/foundation-cognition-repository-taskbook-2026-07-15.md) 已完成阶段 0-7；package/领域 README、稳定 facade、LLM Call Contract、记忆更新闸门、理念资源和持续质量门均已落地。

## 未完成方向

### P0：Memory v3 原子记忆与内置向量目录

已完成的隔离基础：

1. 语义 atom 契约、stable id/parent、domain、D0-D3、statement/epistemic/authority、实体/关系、证据封套和 KnownState 引用已冻结。
2. Atom Store 已实现分片文件、内容哈希、修订冲突、同作用域 parent/循环校验、损坏/孤儿隔离、轻量常驻 header 和按需正文读取；10,000 atom 重启扫描通过。
3. Raw Record Store 先以独立哈希文件保存原始事件与 mutation，写入后没有 update/delete/prune API；mutation 提交后另写 append-only commit receipt，不回写原始数据记录。Event/operation journal 与 Storage Coordinator 再执行有界恢复和幂等双提交。原始记录已写但 event 未写、merge 部分写入、atom 已写/catalog 未写等崩溃点均可恢复，journal 裁剪不删除原始记录或 receipt。
4. SQLite catalog 已实现 FTS、branch/scope/subtree 强制过滤、向量状态、访问/反馈有界账本、due index、实体/有向关系和数据库删除后流式重建。
5. Provider `/embeddings` 默认硬拒绝，测试确认未授权远程引擎零调用；访问次数不进入优先级，正向反馈必须携带验证证据，普通衰减不改 confidence 或淘汰 T0。
6. 独立 `packages/embedding` 已实现显式模型 provision、完整性校验、本地加载、批处理与取消；BGE Recall@1/3 为 `0.7778/0.8889`，E5 为 `0.9444/1.0`，两者离线断言网络尝试均为 0。
7. `MemoryV3MaintenanceWorker` 已实现有界向量重建和 due 启动补偿，不使用常驻轮询；实体/关系生命周期已检查 atom 引用与入/出边，Catalog 的 Embedding 职责已拆为独立控制器。
8. `MemoryRepository` 已成为 v2/v3 稳定 facade；默认 v2。隔离实验使用显式标记，已完成迁移使用活动版本 locator；locator 存在时优先并失败关闭，不能被旧实验标记绕过。
9. 双后端 18 项契约覆盖根节点、读写、去重、层级、管理、资源、重启、并发、daily tier、冲突重绑定、恢复队列、项目路径重绑定和实验标记校验。
10. v3 写入先分类 domain、statement、epistemic、authority 和 actor；建议、事实、偏好与决定不会跨类别合并，资源与来源映射为稳定 user/project/file/session/task/skill/tool/rule/concept 实体。
11. Memory Service 与 Runner 已在隔离 v3 根完成 EVOLVE/CAPTURE、导航、证据定位和重启恢复；Catalog 删除后会先重建 graph，再重建带实体引用的 atom。
12. Graph、Ledger、Resource Store 首次初始化共享 Promise；Runner shutdown 释放 v3 SQLite，Git 真实仓库测试也具备显式子进程超时和 Windows 有界清理，降低句柄残留风险。
13. 阶段 4 已完成：迁移器直接只读原始 v2 文件，保存全量哈希 snapshot，在同卷 staging 中保留 node id、层级、资源、全部审计、恢复队列和迁移记录，并通过版本 locator、全量 validation hash、原子 rename、幂等恢复和受约束回滚提交。30 项迁移测试覆盖全部断电点、两类 ENOSPC、损坏/孤儿/重复数据、源变化、请求合并/取消、模型不可用、回滚后再迁移、运行中回滚预检和防丢失回滚；正式用户数据未迁移。
14. 阶段 5 已完成：三类记忆工具共享 repository retrieval facade；v3 统一层级、作用域/子树过滤、FTS、本地向量、候选优先级、关系邻域、D0-D3 和访问账本。版本化 KnownState 贯穿 Harness 阶段，VERIFY 保持事实/建议/报告观察/未验证主张边界；默认 Provider Embedding 旁路已从 Runner 退役。
15. 新写入 atom 会在返回成功前触发有界本地向量维护；写入落在活动批次之后时会合并一个后续批次，模型不可用或维护失败不会回滚权威 atom，也不依赖无界轮询计时器。
16. 阶段 6 读取与迁移生命周期已完成：树接口只返回 D0/D1，节点 D2/D3 通过可取消请求按需展开；详情缓存限制为 24 条。Repository management facade 可检查 Catalog、atom、原始数据记录、Embedding、认识状态、证据和关系邻域；迁移页可预检、确认登记、取消、重启执行、恢复和受约束回滚。
17. v3 atom 高级管理已完成：移动限制在同 branch/scope/scopeKey，合并要求相同认识类别、权威、断言者和解析状态，双 revision 先预检；来源 atom 保留 tombstone，合并不自动提高 confidence/usefulness，失效后退出检索并可精确恢复。
18. 单 atom D3 `.memory.json` 证据包导出已接入 Local App API 和 Renderer；真实 HTTP 测试覆盖参数校验、状态码、管理结果和文件输出。
19. Runner 首次业务请求已验证真实介入 D1 选中的 atom；默认最多 2 个 D2 atom、600 tokens。`memory_tree release` 会同步移出真实后续请求与 KnownState，并允许之后重新加入。
20. Storage Coordinator 启动时分批协调原始数据记录、journal 与 catalog；能证明未执行或部分执行的记录才重放，能证明已投影的只补目录状态，含糊状态不猜测覆盖。
21. 隔离 `verify:memory-v3-soak` 已通过：120 次初始写入形成 149 条原始数据记录与 121 个 atom，经历 4 次重启、journal 裁剪、raw-record-only 崩溃恢复、catalog 删除重建和 96 次 working-set run；catalog integrity 为 `ok`，历史记录依靠 commit receipt 恢复审计投影而不会倒放覆盖演进后的 atom，临时数据根执行后已删除。
22. 隔离 V3 Electron 窗口已验收：管理页显示 65 个活动 atom，可展开 D2 与 D3“证据与历史”，更多菜单支持点击外部收回，移动、失效/恢复和单 atom 证据包导出均成功；全局返回到主页后前进栈保持可用，并可恢复记忆树页面。导航历史限制为 50 项，恢复期间的派生状态只替换当前快照，不截断前进分支。
23. 当前正式 V2 数据已通过 `verify:memory-v3-readiness` 的只读预检和隔离副本完整演练：2 个源文件共 164272 bytes，40 个业务节点与 11 个资源等价迁移；V3 catalog 含 40 个业务 atom 和 5 个内部 scope root，integrity 为 `ok`；关闭重启后计数稳定，隔离回滚成功，源 index/manifest 哈希全程未变化，临时副本已删除。
24. 回滚就绪检查已前移到运行中控制面：迁移 snapshot、当前 V2 manifest 与当前 V3 全量 validation 使用同一验证核心；安全时才允许写入 pending rollback。V2 源变化、V3 新写入或缺少活动 validator 都会在当前页面失败关闭，且不会要求用户重启后再发现失败；启动路径保留独立二次校验以处理预检后竞态和旧 pending。
25. 本地向量资产控制面已接入迁移页与 `verify:memory-v3-readiness`：当前正式数据根的默认 BGE 资产尚未准备，4 个固定文件均缺失，已验证字节为 0/24451050。该状态不会阻断数据安全迁移，也不会影响层级和 FTS；UI 不再误报向量就绪，并提供单实例、可取消、关闭时中止的显式准备操作。下载地址、revision、文件大小和 SHA-256 均由 `packages/embedding` 固定，运行时写入/检索不会隐式联网；模型准备期间 UI 与 Local App API 均拒绝登记迁移，避免重启与下载竞态。
26. `verify:memory-v3-readiness` 已把当前正式 V2 副本的迁移器与真实 Runner 串成连续链路：首次迁移无新增写入时可回滚；重新迁移后，Runner 成功持久化 2 条会话消息、EVOLVE 项目 atom 与 CAPTURE daily atom，关闭重启后按相同 ID 恢复，并完成索引导航、release 后 FTS 重新介入。V3 新权威写入使 `activeV3Unchanged=false`，回滚在 pending 登记前被拒绝；正式源哈希不变，临时副本已删除。

仍未完成：

1. 正式用户数据切换必须继续由用户在迁移页明确确认并重启。
2. 用户可在迁移前显式准备默认本地 BGE 模型；若选择暂不准备，必须知晓迁移后先使用层级与 FTS，向量候选保持不可用/待维护，而不是被伪装成就绪。
3. 切换后执行真实会话、记忆写入、索引导航、本地向量维护、重启连续性和受约束回滚验收。

**验收标准**：断网时记忆可写、可导航、可检索；原始数据记录写入后不修改且不会随 journal 裁剪丢失；atom 与数据库投影可从持久文件恢复；向量检索不能跨越未导航分支；所有 domain 使用同一 repository 并可从 D0/D1 渐进展开到 D2/D3；匹配作用域内经验证的高价值记忆稳定优先介入；首次请求只加载有界相关 atom，执行中 release 不改持久数据且可重新介入；长期低收益可选记忆减少注入但强制信息不被误衰减；重复访问不会形成错误自增强；LLM 能获得所用记忆的必要证据与 epistemic 元数据；用户目标/偏好在范围内受到尊重，客观 claim 不经验证不成为事实，建议被采纳也不改变其验证状态，错误建议不生成用户能力画像；每个执行阶段可追溯采用、排除和重新激活的 `KnownState` 版本与信息；事件在确认前持久化，重复处理幂等，崩溃、重启和关闭期间到期不会静默丢失；迁移可中断恢复和回滚且不丢节点。

### P0：持续维护与受控超限拆分

1. 仓库基元化阶段 0-7 已完成，后续由 31 项仓库卫生门持续保护，不再作为待实现功能重复规划。
2. 6 个超过 600 行的生产文件已登记所有者、暂缓原因、上限和 2026-08-15 复查日期；功能工作触及相应责任域时按拆分地图逐项收缩。
3. 新增核心协议必须有唯一权威来源；workspace 运行时依赖环、未公开深层 import 和未登记大型文件会直接使质量门失败。

**验收标准**：新任务能从仓库指南和领域 README 定位所有者、入口与测试；跨模块契约只有一个权威来源；热点文件不再承接新领域职责；行为特征测试和全量质量门保持通过。

### P0：核心模块契约收敛

1. 阶段 0 已完成：`ModeDefinition`、Context、附件、运行事件、TaskBookPatch、检查点、运行决议、模型请求、工具调用和执行证据的内部 v1 契约均已建立。
2. Runner 已生成深冻结的 `ResolvedRunConfig`；所有 Harness LLM 请求会解析并持久化独立 `LlmCallContract` 与有界快照；旧日志、会话、记忆和 workspace 恢复路径已有兼容测试。
3. 已按 [架构决策报告](architecture-decision-report.md) 新建并分域 Context Engine；来源 segment、版本化摘要、附件清单优先、按需附件工具、压缩阈值设置和双账本展示已接通。Provider reasoning/capability 契约回归已经修复，tokenizer 能力矩阵也已建立并禁止计数器自行声明精确性；unavailable 模型已接入不可展示的保守请求前预算保护，下一步完成真实 Provider 对账。
4. 模型调用的输出上限、工具集合和 Context 来源已由契约统一限制；下一缺口是把实际工具执行进一步收敛为统一 Tool Execution Service。
5. 随新模块落地扩充现有依赖方向检查，继续阻止 App、渠道和插件内部实现反向进入 Harness/Runner 核心。

**验收标准**：每个跨模块职责只有一个所有者；Context 来源和 token 口径可追溯；Behavior Mode 与 Permission Policy 保持正交；内置、插件及未来 MCP 工具能够共享同一执行契约；全量回归保持通过。

### P0：真实能力验收

1. 使用真实 API key 对 OpenAI、DeepSeek、GLM 至少各完成一次最小对话、工具调用和中断测试。
2. 对多步骤长任务验证 TaskBook、步骤级恢复、上下文占用和已完成执行日志重放；活动 run 重启续跑必须等检查点能力落地后单独验收。
3. 根据各供应商具体模型文档补齐 reasoning 参数、上下文上限和 usage 字段映射；不能用本地估算冒充真实 token usage。

**阻塞条件**：需要用户在设置中提供可用的供应商密钥，并指定可接受的测试模型与成本上限。

**验收标准**：每个供应商都能完成一次真实请求；失败、中断、工具审批和历史恢复结果可解释且不损坏用户数据。

### P0：Context、运行连续性与数据边界

1. provider/model tokenizer 能力分类已经完成：当前内置模型均明确为 unavailable，只有能力声明与计数器实现 id 一致时才允许精确账本。unavailable 模型已使用复用最终 Chat Completions 载荷的保守估算执行可选项淘汰、压缩触发和必需内容超限阻断；该估算固定为不可展示。下一步完成精确 ledger、安全估算与 Provider usage 的真实对账验收。
2. 为运行中用户消息和 LS 内授权事件建立有界队列，在安全决策边界生成 `TaskBookPatch`，保留已完成步骤和证据；同时为无依赖、无资源冲突的步骤建立有硬上限的并行调度。
3. 定义版本化 `RunCheckpoint`、幂等副作用记录、恢复兼容和防死循环上限，实现用户中断、应用重启和可恢复故障的清晰语义。
4. T0-T3 基础注册表、v1→v2 版本化迁移、统一 Memory Service、Summary Memory、run-scoped 附件、运行时事件账本登记端口，以及项目记忆“用户数据权威源 / 项目内私有投影 / 可共享导出”三层契约与控制面已实现。项目稳定 ID、旧 ID 兼容和可恢复路径重绑定也已完成；实时事件生产仍依赖后续 `RuntimeEventQueue`，当前继续完成其他资源的通用治理。
5. 附件缓存、workplace 有界资源索引和可回滚完整数据根迁移已进入独立、索引驱动的数据生命周期。数据根迁移由外部 locator 登记，设置页只登记目标并明确要求重启；启动阶段在 Runner、Local App API 和插件宿主创建前暂停结构性写入，复制到目标同级 staging，跳过符号链接/junction，以流式 SHA-256 清单校验全部普通文件，只重绑定活动元数据中原本位于旧数据根内的路径，再原子提交。源目录保留，校验失败继续使用旧目录，提交后 locator 切换前中断可恢复，回滚在下次启动切回前一个仍存在的数据根。当前完成的是隔离临时目录工程验收，不代表已替用户迁移正式数据。
6. 后台任务必须配套托盘、状态提示、彻底退出和用户可配置关闭策略，不能只让进程静默驻留。

**当前事实**：Harness 已把模型请求映射为显式 Context 候选并交给 `@littlesheep/context` 准备；System Prompt 内的基础策略、记忆根索引、bootstrap、输出约束、Workflow/TaskBook、profile 和 reasoning 已能独立登记。Provider usage 会绑定到准确快照，UI 能区分供应商实测、本地精确装配和 tokenizer 不可用。tokenizer 能力矩阵已经覆盖当前内置模型，但没有任何模型被错误标记为本地精确；未来计数器必须与模型声明的 `counterId` 和请求格式一致。对 unavailable 模型，Context Engine 复用 LLM Client 的最终载荷构造器，以 UTF-8 字节和独立图片预算生成 `displayable: false` 的 `ContextSafetyEstimate`，用于请求前防溢出、可选项淘汰和压缩触发；Renderer 不读取该值作为已用 token。会话压缩已生成版本化 Summary Memory，原始消息保留；摘要以 session scope 注册，重启后仍从会话元数据按 summary id 解析。附件在模型输入中先以清单介入，非图片正文只有 Agent 调用当前 run 专属 `inspect_attachment` 时才读取并作为工具结果进入 Context；资源目录只保存附件元数据，活动 run 结束即清除内存正文，同会话新 run 会替换旧登记。执行日志从 Context 快照和记忆访问账本收集有界资源 ID，不保存附件正文或 data URL。记忆文档已升级到 v2，T0 根索引固定有界；Bootstrap、Skills 和工作区规范按元数据注册，正文仍沿资源分支显式展开。项目记忆完整权威数据继续留在用户数据中；项目内私有投影只有用户明确启用后才生成，并使用层级、敏感内容和路径白名单；共享 Markdown 导出采用独立、更严格的置信度白名单。投影的外部修改、缺失、停用和恢复会与资源目录对账，覆盖与移除需要确认，移除仅作用于 LS 最后验证写入的文件。新项目 ID 已与路径解耦，旧路径派生 ID 不重写；移动或重命名项目时，持久化重绑定事务会同步项目会话、归档、记忆 scope、投影、资源、产物、终端、布局、导航和当前运行路径，中断后可幂等恢复。Runner、工具和 UI 已通过统一 `MemoryService` 使用同一仓库；真实用户 v1 数据迁移验证保持既有节点、审计和迁移记录不变，并生成可恢复备份。压缩阈值与数据根管理已接入 Local App API 和设置 UI。数据根迁移的工程闭环已通过隔离故障注入，但正式用户数据仍保持原位置，等待用户主动验收。当前工程质量门为绿色，但生产环境尚未完成三家真实 Provider 校准。关闭最后窗口当前会退出应用；运行时尚无有界并行调度。

**验收标准**：每项 Context 可追溯且不超预算；未知 tokenizer 不显示伪精确 token；追加要求不重做已完成副作用；活动 run 可在重启后从检查点恢复；所有循环有界；用户数据迁移可验证、可回滚；后台运行始终可见、可终止。

### P1：长会话与记忆质量

1. `packages/session/src/compaction.ts` 已实现非破坏式、版本化和可增量合并的 Summary Memory；下一步需要真实长会话、模型失败、摘要失配、恢复和成本场景验收，并确认关键任务约束不会因摘要而丢失。
2. `packages/memory-core/src/distill.ts` 仍导出未接入主运行时的旧原始追加 helper。它必须在任何 daily 提升功能启用前被替换或退役；新的蒸馏只能进入结构化、安全、去重且可回滚的记忆树写入闸门。
3. 对旧用户数据中缺少执行日志、缺少可选 workspace artifact 索引的情况制定只读诊断和渐进治理；workplace 资源索引在下一次真实 run 时按需创建，不为消除警告而提前扫描或改写用户文件。
4. 建立实体/关系 catalog 与 Skill 治理队列：关系必须有方向、证据、作用域和时间；Skill 合并先给出可审查方案，低收益 Skill 优先停用或归档，删除必须经过引用检查、保留期与恢复验证。

**验收标准**：长会话压缩后仍能沿记忆树恢复关键事实、任务约束和来源；压缩过程可追溯、可失败回退，不制造孤立记忆。

### P1：拓展工作区与渠道场景

1. 在真实项目中连续验收文件树、标签、编辑冲突、终端 PTY、权限模式、产物索引和重启恢复。
2. 使用真实渠道凭证验收消息插入 Agent 和回复回传；渠道异常不能影响本地 UI 核心。
3. 在已有 PTY/ConPTY 基础上，决定是否开放受控的原始键盘直通与交互式程序；同时完善发布环境下的原生模块装载/回退，并单独评估重度 IDE 能力。
4. 拓展工作区中的“浏览器”和“侧边聊天”目前只是占位工作面；只有完成真实能力、权限、上下文和恢复契约后才能改为已实现状态。

**验收标准**：主对话区、拓展工作区和侧边栏相互独立；应用重启后布局、标签、会话和产物状态符合持久化约定。

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

1. 由用户明确决定是否批准正式 Memory v2→v3 数据迁移；批准后再验收真实会话写入、索引导航、本地向量维护、应用重启和受约束回滚，批准前保持 v2 权威。
2. 完成 OpenAI、DeepSeek、GLM 真实对话冒烟，用 Provider 结果校准 Context、reasoning、usage 与保守安全估算；远程 Embedding 不纳入默认路径。
3. 根据正式迁移与 Provider 验收结果修正 Context 和记忆介入参数，不用隔离数据替代真实用户场景证据。
4. 在稳定 Call Contract 上收敛统一 Tool Execution Service，使内置、插件和未来 MCP 工具共享审批、超时、清洗、证据与恢复契约。
5. 按连续性任务书实现 RuntimeEventQueue、TaskBookPatch、有界并行、版本化检查点、重启恢复和后台运行，再推进 Mode Registry、插件 API v2 与 MCP。

## 维护规则

- 本文件只记录当前事实和可复现证据；完成一项能力必须同时更新测试、构建证据和本文件。
- 任何“已完成”都要说明范围：基础形态、配置层、连接器层和真实场景验收不能混为一谈。
- 不把用户密钥、用户会话、记忆树或工作区文件复制到仓库；运行时数据只在用户数据目录中维护。
- 顶层分工见 [architecture-principles.md](../principles/architecture-principles.md)，当前架构评估和决策点见 [architecture-decision-report.md](architecture-decision-report.md)，目录和模块归属见 [repository-guide.md](../reference/repository-guide.md)，插件边界见 [plugin-development.md](../reference/plugin-development.md)。
- 当前先行仓库整理和认知契约见 [总基调、认知架构与仓库基元化任务书 2026-07-15](../taskbooks/foundation-cognition-repository-taskbook-2026-07-15.md)。
- Memory v3 的原子文件、层级、内置向量目录和迁移边界见 [原子记忆与内置向量目录任务书 2026-07-15](../taskbooks/memory-atom-vector-catalog-taskbook-2026-07-15.md)。
- 核心能力细节见 [核心 Agent 能力任务书 2026-07-13](../taskbooks/core-agent-capability-taskbook-2026-07-13.md)，拓展工作区细节见 [拓展工作区任务书 2026-07-12](../taskbooks/extension-workspace-taskbook-2026-07-12.md)。
- Context、记忆分级、附件、运行中重入、有界并行、检查点和后台连续执行的专项计划见 [Agent Runtime 连续性任务书 2026-07-14](../taskbooks/agent-runtime-continuity-taskbook-2026-07-14.md)。
