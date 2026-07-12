# LittleSheep 项目状态

最后更新：2026-07-12

本文件是项目进度的正式来源。状态只根据当前源码、测试和构建结果维护；旧的阶段报告不再作为进度依据。

## 总体判断

LittleSheep 当前是一个**可运行的本地 Agent alpha 原型**：核心状态机、任务执行、索引优先记忆、桌面聊天界面、拓展工作区和可选外部渠道已经形成完整工程骨架，能够继续做真实供应商和长任务验收。

它还不是可直接宣称“生产就绪”的发行版。主要原因是实际供应商长任务验证、长会话压缩、MCP、安装包发布和真实用户场景验收仍未闭环。因此本项目不使用一个没有权重定义的百分比来伪装精确进度，而用能力状态和验收证据表示总进度。

**当前阶段：核心能力真实场景验收与产品化收尾。**

## 能力总览

| 能力域 | 状态 | 当前结论 | 主要位置 |
| --- | --- | --- | --- |
| 硬控制流 Agent | 已实现 | `ENTER`、分类、决策、执行、恢复、验证、演化、捕获和收尾由 Harness 驱动 | `packages/harness/`、`packages/runner/` |
| 需求判断与任务书 | 已实现 | 支持澄清请求、复杂度判断、TaskBook、步骤验收和局部重规划 | `packages/types/`、`packages/harness/src/stages/` |
| 步骤级执行与恢复 | 已实现 | 保留已完成步骤证据，失败时按步骤恢复，不重复执行已完成部分 | `packages/harness/src/stages/execute.ts`、`recover.ts`、`verify.ts` |
| 记忆树运行时协议 | 已实现基础闭环 | 根索引到分支索引再到展开/分支内深搜，写入走结构化闸门 | `packages/memory-tree/`、`packages/memory-core/`、`packages/runner/` |
| 记忆管理控制面 | 已实现基础形态 | UI 操作真实运行时索引与仓库，可查看、归档、恢复和删除 | `packages/app/src/renderer/MemoryTreeView.tsx`、`packages/app/src/main/memory-tree-control.ts` |
| 执行记录与历史恢复 | 已实现 | TaskBook、步骤、工具调用、验证和最终结果可持久化并恢复 | `packages/runner/src/execution-log.ts`、`packages/app/src/renderer/TraceCard.tsx` |
| 桌面聊天与流式交互 | 已实现基础形态 | Local App API、SSE、Markdown、附件、审批和中断已接通 | `packages/app/src/main/local-app-api-server.ts`、`packages/app/src/renderer/` |
| 权限与行为模式分离 | 已实现基础形态 | 通用/编程系统提示词与完全访问/研究/受限权限策略分离 | `packages/prompt/src/profiles.ts`、`packages/app/src/main/run-policy.ts` |
| 拓展工作区 | 已实现基础形态 | 文件树、标签、内置编辑器、产物索引、PowerShell/PTY 终端和恢复快照已接通 | `packages/app/src/renderer/`、`packages/app/src/main/workspace-*.ts` |
| 模型供应商配置 | 已实现配置层 | OpenAI、DeepSeek、GLM 预置；只有配置了可用密钥的供应商/模型应进入选择范围 | `packages/config/`、`packages/app/src/main/keychain.ts` |
| 外部渠道 | 已实现连接器层 | Webhook、Telegram、飞书、QQ Bot 是可选连接器，只负责消息进出 | `packages/gateway/`、`packages/channels/` |
| 技能系统与经验库 | 已实现基础形态 | 技能加载、创建、经验记录和衰减基础能力存在 | `packages/skills/`、`packages/experience/` |

## 当前验证结果

以下数字必须在每次重大仓库整理或核心代码变更后重新运行，不沿用历史报告中的数字。

| 检查 | 最近结果 | 证据命令 |
| --- | --- | --- |
| 仓库卫生 | 通过：15 项通过，0 项失败 | `pnpm.cmd run check:repo` |
| 全量测试 | 通过：92 个测试文件，836 passed，1 skipped | `pnpm.cmd test` |
| 全工作区类型检查 | 通过：25 个 workspace 包 | `pnpm.cmd run typecheck` |
| 全工作区构建 | 通过：25 个 workspace 包，包含 Electron app | `pnpm.cmd run build` |
| 应用恢复源检查 | 通过；保留既有数据治理警告 | `pnpm.cmd run verify:app-recovery` |
| 桌面快捷方式 | 已刷新并校验目标与工作目录 | `scripts/refresh-desktop-shortcut.ps1` |

恢复源检查只读访问当前机器的用户数据。公开状态文档只记录检查是否通过，不公布文件数量、哈希、本机路径或会话级诊断细节。

## 已完成能力

### Agent 核心

- 分类结果区分闲聊、可执行问题和真正不清晰的请求。
- 缺少关键路径、权限或不可逆操作确认时使用结构化 `ClarificationRequest`，不把不确定性伪装成普通错误。
- 复杂任务可以生成目标、步骤、工具、产物和验收标准组成的 TaskBook；简单任务保持轻量。
- EXECUTE、VERIFY 和 RECOVER 以步骤为边界保存证据，支持局部重规划和有限重试。
- 运行事件包含步骤、工具、验证和最终回复，UI 可以实时展示，历史也能重建同一过程。

### 记忆与持续能力

- 根索引、分支索引、节点展开和同分支深搜构成默认检索路径。
- 未命中索引时不会默认跨树或直接把向量召回塞入上下文。
- 分支和单次 run 有预算、去重、来源记录和安全封套。
- 自动写入使用结构化意图，记录作用域、层级、来源 run、置信度和理由；用户可在记忆树控制面管理真实数据。
- 长期记忆、项目记忆、经验和 daily 流水在概念上分开，避免把过程噪声全部变成长期记忆。

### 桌面应用

- Electron 主进程内嵌 Runner；渲染器通过 loopback 随机端口的 Local App API 通信。
- Local App API 与外部渠道网关概念分离；没有外部渠道时应用仍可独立运行。
- 聊天支持流式回复、Markdown、代码块复制、附件、工作区选择、权限审批和中断。
- 执行过程默认折叠但可展开，用户消息使用气泡，Agent 回复和工具过程使用无气泡时间线。
- 设置、会话、项目、归档、记忆树和拓展工作区共享统一的转场、浮层和折叠交互约束。

## 未完成方向

### P0：真实能力验收

1. 使用真实 API key 对 OpenAI、DeepSeek、GLM 至少各完成一次最小对话、工具调用和中断测试。
2. 对多步骤长任务验证 TaskBook、步骤级恢复、上下文占用、执行日志和重启恢复。
3. 根据各供应商具体模型文档补齐 reasoning 参数、上下文上限和 usage 字段映射；不能用本地估算冒充真实 token usage。

**阻塞条件**：需要用户在设置中提供可用的供应商密钥，并指定可接受的测试模型与成本上限。

**验收标准**：每个供应商都能完成一次真实请求；失败、中断、工具审批和历史恢复结果可解释且不损坏用户数据。

### P1：长会话与记忆质量

1. `packages/session/src/compaction.ts` 的 `maybeCompact()` 仍是 no-op，需要实现可验证的长会话压缩和恢复。
2. `packages/memory-core/src/distill.ts` 目前是带日期标题的原始追加，不是模型辅助的去重蒸馏；需要在安全闸门和可回滚约束下升级。
3. 对旧用户数据中缺少执行日志、缺少可选 workspace artifact 索引的情况制定只读诊断和渐进治理，不直接改写用户数据。

**验收标准**：长会话压缩后仍能沿记忆树恢复关键事实、任务约束和来源；压缩过程可追溯、可失败回退，不制造孤立记忆。

### P1：拓展工作区与渠道场景

1. 在真实项目中连续验收文件树、标签、编辑冲突、终端 PTY、权限模式、产物索引和重启恢复。
2. 使用真实渠道凭证验收消息插入 Agent 和回复回传；渠道异常不能影响本地 UI 核心。
3. 完善完整 PTY 直通、IDE 重度能力和发布环境下的原生模块处理。

**验收标准**：主对话区、拓展工作区和侧边栏相互独立；应用重启后布局、标签、会话和产物状态符合持久化约定。

### P1：发布与安装

- 当前只有源码构建和本地快捷方式流程，尚未完成签名安装包、升级、卸载、原生依赖分发和发布回滚流程。

**验收标准**：在干净 Windows 环境安装、启动、升级和卸载；用户数据与应用版本升级解耦且不丢失。

### P2：MCP 与生态扩展

- `packages/mcp/src/index.ts` 仍是骨架包。需要先明确服务器生命周期、权限、工具命名冲突、超时、日志和用户批准策略，再实现客户端。

**验收标准**：MCP 工具遵守与内置工具相同的权限、清洗、超时、执行记录和恢复契约。

## 推荐后续顺序

1. 在明确密钥和成本边界后，完成三家供应商的真实冒烟与长任务验收。
2. 实现长会话压缩，并把压缩结果接入记忆树和执行日志。
3. 升级 daily 到长期记忆的安全蒸馏，补旧用户数据的只读诊断与治理工具。
4. 完成工作区、渠道和记忆树的真实场景验收，再规划发布包。
5. 最后实现 MCP 客户端，避免在核心契约尚未稳定时扩大工具面。

## 维护规则

- 本文件只记录当前事实和可复现证据；完成一项能力必须同时更新测试、构建证据和本文件。
- 任何“已完成”都要说明范围：基础形态、配置层、连接器层和真实场景验收不能混为一谈。
- 不把用户密钥、用户会话、记忆树或工作区文件复制到仓库；运行时数据只在用户数据目录中维护。
- 详细目录和模块归属见 [repository-guide.md](repository-guide.md)，核心能力细节见 [core-agent-capability-taskbook.md](core-agent-capability-taskbook.md)，拓展工作区细节见 [extension-workspace-taskbook.md](extension-workspace-taskbook.md)。
