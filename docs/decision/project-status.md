# LittleSheep 项目状态

最后更新：2026-07-15

本文件是项目进度的正式来源。状态只根据当前源码、测试和构建结果维护；旧的阶段报告不再作为进度依据。

## 总体判断

LittleSheep 当前是一个**可运行的本地 Agent alpha 原型**：核心状态机、任务执行、索引优先记忆、版本化会话摘要、桌面聊天界面、拓展工作区和可选外部渠道已经形成完整工程骨架，能够继续做真实供应商、长任务和重启连续性验收。

它还不是可直接宣称“生产就绪”的发行版。主要原因是当前内置模型尚无已验证的最终请求精确计数器、真实供应商验证未完成、活动 run 重启续跑、MCP、安装包发布和真实用户场景验收仍未闭环。因此本项目不使用一个没有权重定义的百分比来伪装精确进度，而用能力状态和验收证据表示总进度。产品方向已明确为：解放用户生产力，让用户专注于想法，LS 负责将想法可靠落地；执行和输出统一采用渐进式披露。

**当前阶段：仓库基元化阶段 0-7 已完成；稳定 facade、版本化 LLM Call Contract、Context 强制约束、记忆意图闸门、理念资源注册和持续维护质量门均已落地。下一主线是完成真实 Provider 校准，再收敛统一 Tool Execution Service 与 Runtime 连续执行。**

## 能力总览

| 能力域 | 状态 | 当前结论 | 主要位置 |
| --- | --- | --- | --- |
| 架构治理 | 仓库基元化阶段 0-7 已完成 | 26 个 package 与指定领域目录均有所有权 README；关键组合入口已收敛为 facade。`check:repo` 自动校验文档分层、任务书日期、300/600 行登记、受控超限、热点增长、深层 import、运行时依赖环和核心协议唯一来源 | `docs/taskbooks/foundation-cognition-repository-taskbook-2026-07-15.md`、`docs/reference/module-split-map.md`、`scripts/check-repository-hygiene.mjs` |
| LLM 调用契约与记忆提交 | 已实现工程闭环 | 每次模型请求解析独立 `LlmCallContract`，声明 purpose、Context、决策、输出、工具、记忆和预算；FINALIZE 禁止模型调用。EVOLVE/CAPTURE 只提交有真实步骤、工具和验证证据的写入，冲突/失效意图只延期审计 | `packages/types/src/runtime-contracts.ts`、`packages/harness/src/llm-call-contracts/`、`model-observability.ts`、`stages/memory-intent-gate.ts` |
| Context Engine | 阶段 1 主要数据链与调用契约已实现，供应商验收未闭环 | 支持确定性候选、来源 segment、契约过滤、预算淘汰、版本化 Summary Memory、附件清单优先、按需附件工具、Provider usage 绑定和双账本 UI；必需 Context 越权或缺失会失败关闭。当前内置模型均明确为 unavailable 并使用不可展示的保守安全估算；真实 Provider 对账尚未完成 | `packages/context/src/engine.ts`、`context-engine/`、`packages/harness/src/context-candidates.ts`、`model-observability.ts`、`packages/config/src/model-capabilities.ts` |
| 附件、workplace 与数据根生命周期 | 阶段 3 工程实现已完成 | 粘贴/浏览器导入进入独立受管缓存，按 30 天、256 项、512 MiB 有界清理；workplace 使用可恢复的有界元数据索引，不读正文。设置页可登记完整数据根迁移，下一次启动会在任何写入者初始化前通过外部 locator、同级 staging、全文件 SHA-256 清单和活动元数据路径重绑定完成原子切换；源目录保留，失败继续使用旧目录，提交中断可恢复，回滚同样在下次启动生效。隔离测试已覆盖这些契约，尚未擅自搬迁正式用户数据 | `packages/app/src/main/attachment-cache.ts`、`packages/app/src/main/data-root-migration.ts`、`packages/app/src/main/data-root-metadata.ts`、`packages/memory-tree/src/workspace-resource-index.ts` |
| 长会话压缩 | 已实现基础闭环 | 原始 JSONL 不删除；摘要版本化、记录来源范围、支持增量合并，并在下一轮作为独立 `summary_memory` 介入；摘要同时按 session scope 注册到资源目录，正文仍以会话元数据为权威来源并按需解析；真实长会话、失败回退和成本仍待验收 | `packages/session/src/compaction.ts`、`packages/runner/src/runner.ts`、`packages/prompt/src/builder.ts`、`packages/memory-tree/src/memory-service.ts` |
| 硬控制流 Agent | 已实现 | `ENTER`、分类、决策、执行、恢复、验证、演化、捕获和收尾由 Harness 驱动 | `packages/harness/`、`packages/runner/` |
| 需求判断与任务书 | 已实现 | 支持澄清请求、复杂度判断、TaskBook、步骤验收和局部重规划 | `packages/types/`、`packages/harness/src/stages/` |
| 步骤级执行与恢复 | 已实现 | 保留已完成步骤证据，失败时按步骤恢复，不重复执行已完成部分；工具循环、权限/超时、失败分类、步骤调度和结构验收已分离，stage facade 不再承接内部细节 | `packages/harness/src/stages/execute.ts`、`execute/`、`recover.ts`、`verify.ts`、`verify/` |
| 记忆树运行时协议 | 已实现基础闭环 | 根索引到分支索引再到展开/分支内深搜，写入走结构化闸门；新增 `resources` 分支后，注册文档正文仍必须先看目录再按需展开 | `packages/memory-tree/`、`packages/memory-core/`、`packages/runner/` |
| Memory Service 与 T0-T3 注册 | 阶段 2 与理念资源接入已完成 | v2 文档、T0、元数据资源目录、Bootstrap/Skills/工作区文档、Summary Memory、run-scoped 附件、项目投影和通用资源生命周期均进入真实路径。`PHILOSOPHY.md` 是显式 `philosophy` 资源，只沿索引按预算读取，不进入常驻 Prompt | `packages/memory-tree/src/memory-service.ts`、`memory-service/`、`memory-repository/`、`packages/app/src/main/index.ts` |
| 项目身份与路径重绑定 | 已实现基础闭环 | 新项目使用与路径无关的稳定 ID，旧路径派生 ID 原样保留；项目移动或重命名后可从侧边栏重新定位。持久化事务日志幂等迁移会话、归档、记忆 scope、项目投影、工作区文档资源、产物、终端活动、布局、导航状态和当前运行路径；路径冲突会拒绝提交 | `packages/app/src/main/project-index.ts`、`project-rebinding.ts`、`path-rebinding.ts`、`packages/memory-tree/src/memory-service.ts` |
| 记忆管理控制面 | 已实现基础闭环 | UI 操作真实运行时索引与注册表，可查看、归档、恢复、删除记忆，并以渐进式披露查看资源来源、权威、隐私、索引键和生命周期审计；持久资源支持停用、恢复和只清理登记，缺失的工作区文档可在授权范围内保持原 ID 重新定位；项目记忆支持私有投影启用/同步、缺失与冲突恢复、Git 隐私提示、共享导出、停用和安全清理 | `packages/app/src/renderer/MemoryTreeView.tsx`、`packages/app/src/main/memory-tree-control.ts` |
| 执行记录与历史重放 | 已实现 | 已完成 run 的 TaskBook、步骤、工具调用、验证、调用契约、Context 快照、记忆意图运行时判定和有界资源 ID 可持久化并重放；附件正文不进入执行日志；这仍不等于活动 run 在应用重启后续跑 | `packages/runner/src/execution-log.ts`、`packages/app/src/renderer/TraceCard.tsx` |
| 桌面聊天与流式交互 | 已实现基础形态 | Local App API、SSE、Markdown、附件、审批和中断已接通 | `packages/app/src/main/local-app-api-server.ts`、`packages/app/src/renderer/` |
| 权限与行为模式分离 | 已实现基础形态 | 通用/编程系统提示词与完全访问/研究/受限权限策略分离 | `packages/prompt/src/profiles.ts`、`packages/app/src/main/run-policy.ts` |
| 拓展工作区 | 已实现基础形态 | 文件树、标签、内置编辑器、产物索引、PowerShell/PTY 终端和恢复快照已接通 | `packages/app/src/renderer/`、`packages/app/src/main/workspace-*.ts` |
| 模型供应商配置 | 已实现配置层 | OpenAI、DeepSeek、GLM 预置；只有配置了可用密钥的供应商/模型应进入选择范围 | `packages/config/`、`packages/app/src/main/keychain.ts` |
| 插件运行时 | 已实现基础闭环 | 插件发现、manifest 校验、启停、错误隔离、本地代码信任和 Runner 工具迁移已接通；当前支持 `channel`、`tool` 和声明式 `skill` 贡献。插件 Skill 使用 owner-scoped 来源和稳定资源 ID，随插件启停、移除、路径变化及 Runner 重建同步 | `packages/plugins/`、`packages/skills/`、`packages/memory-tree/src/memory-service.ts` |
| 外部渠道 | 已插件化基础形态 | Webhook、Telegram、飞书、QQ Bot 是可选渠道插件，只负责消息进出；没有配置时不加载实现 | `packages/channels/`、`packages/plugins/` |
| 技能系统与经验库 | 已实现基础形态 | 技能加载、创建、经验记录和衰减基础能力存在 | `packages/skills/`、`packages/experience/` |
| Runtime 连续执行 | 尚未实现完整闭环 | 已有 `AbortSignal` 和步骤级局部恢复；运行中用户事件重入、活动 run 检查点、幂等续跑、后台任务与托盘尚未完成 | `packages/harness/`、`packages/runner/`、`packages/app/` |

## 当前验证结果

当前工作树的工程质量门已经恢复为绿色。真实供应商冒烟仍是独立验收门，不能因为本地测试通过就宣称三家 Provider 已完成校准。

| 检查 | 当前工作树结果 | 证据命令 |
| --- | --- | --- |
| 仓库卫生 | 通过：31 项通过，0 项失败 | `pnpm.cmd run check:repo` |
| 全量测试 | 通过：119 个测试文件；996 passed、1 skipped | `pnpm.cmd test` |
| 全工作区类型检查 | 通过 | `pnpm.cmd run typecheck` |
| 全工作区构建 | 通过 | `pnpm.cmd run build` |
| 应用恢复源检查 | 通过；仍保留旧执行日志缺失、可选 workspace artifact 索引缺失，以及现有用户数据尚未产生 workplace 资源索引的诊断警告 | `pnpm.cmd run verify:app-recovery` |
| 桌面快捷方式 | 已刷新至最新 Electron 构建；窗口可见且响应正常，记忆树可见 `PHILOSOPHY.md / 长期理念`，全局返回可回到原对话 | `scripts/refresh-desktop-shortcut.ps1` |

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

1. 优先完成 OpenAI、DeepSeek、GLM 真实冒烟，用 Provider 结果校准 Context、reasoning、usage 与保守安全估算；该项需要用户提供有效凭证。
2. 在稳定 Call Contract 上收敛统一 Tool Execution Service，使内置、插件和未来 MCP 工具共享审批、超时、清洗、证据与恢复契约。
3. 按连续性任务书实现 RuntimeEventQueue、TaskBookPatch、有界并行、版本化检查点、重启恢复和后台运行。
4. 再推进 Mode Registry、daily 到长期记忆的安全蒸馏、插件 API v2 与 MCP；完成真实用户场景验收后规划发布包。

## 维护规则

- 本文件只记录当前事实和可复现证据；完成一项能力必须同时更新测试、构建证据和本文件。
- 任何“已完成”都要说明范围：基础形态、配置层、连接器层和真实场景验收不能混为一谈。
- 不把用户密钥、用户会话、记忆树或工作区文件复制到仓库；运行时数据只在用户数据目录中维护。
- 顶层分工见 [architecture-principles.md](../principles/architecture-principles.md)，当前架构评估和决策点见 [architecture-decision-report.md](architecture-decision-report.md)，目录和模块归属见 [repository-guide.md](../reference/repository-guide.md)，插件边界见 [plugin-development.md](../reference/plugin-development.md)。
- 当前先行仓库整理和认知契约见 [总基调、认知架构与仓库基元化任务书 2026-07-15](../taskbooks/foundation-cognition-repository-taskbook-2026-07-15.md)。
- 核心能力细节见 [核心 Agent 能力任务书 2026-07-13](../taskbooks/core-agent-capability-taskbook-2026-07-13.md)，拓展工作区细节见 [拓展工作区任务书 2026-07-12](../taskbooks/extension-workspace-taskbook-2026-07-12.md)。
- Context、记忆分级、附件、运行中重入、有界并行、检查点和后台连续执行的专项计划见 [Agent Runtime 连续性任务书 2026-07-14](../taskbooks/agent-runtime-continuity-taskbook-2026-07-14.md)。
