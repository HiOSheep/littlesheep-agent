# LittleSheep

LittleSheep（LS）是一个本地部署的高自治 Agent 桌面应用。核心运行在 Electron 主进程中，由代码级状态机驱动任务判断、执行、验证、恢复和记忆管理；用户可以在默认无感的同时，随时管理模型、权限、记忆和工作区。

LS 的目标是解放用户生产力：用户专注于想法的产生、判断和目标，LS 负责将想法可靠落地。凡是可以稳定自动化的检索、规划、执行、验证、整理和记忆维护由 LS 承担；目标取舍、风险接受、权限授予和关键判断仍由用户掌握。执行过程和最终输出遵循渐进式披露，默认先呈现结论、当前状态和关键产物，完整任务书、证据、日志与高级控制按需展开；失败、风险和待用户决策事项始终明确可见。

## 架构概览

```text
Electron 渲染进程（React）
        |
        | loopback Local App API / SSE
        v
Electron 主进程
  |-> Runner -> Harness Core Flow -> LLM / Tools / Memory Tree / Sessions
  |      ^
  |      +-- validated plugin tool contributions
  +-> PluginHost -> optional channel plugins
```

Local App API 只是本地 UI 与主进程之间的桥接，不属于外部渠道层。外部渠道是可选插件，只负责把渠道消息送入 Agent，并把 Agent 回复送回渠道；没有渠道配置时，LS 仍可完整运行。

当前 workspace 包共 26 个：22 个核心包和 4 个渠道插件。包边界和重要模块见 [仓库指南](docs/repository-guide.md)。

## 快速开始

```powershell
pnpm install
pnpm run build
.\build-app.bat
```

构建完成后，桌面上的 `LittleSheep.lnk` 会指向当前仓库的 Electron 构建，并使用当前 `packages/app` 作为工作目录。开发模式可以运行：

```powershell
.\start-littlesheep.bat
```

首次启动后，在设置中填写已购买的模型供应商 API key。当前配置层提供 OpenAI、DeepSeek 和 GLM 预置；没有可用密钥的供应商不会进入可选择模型列表。

## 质量门

```powershell
pnpm.cmd run check:repo
pnpm.cmd test
pnpm.cmd run typecheck
pnpm.cmd run build
pnpm.cmd run verify:app-recovery
```

不要在 README 中固定测试数量。最新结果记录在 [项目状态](docs/project-status.md)，每次重大变更后重新运行上述命令并更新状态文档。

## 当前能力

- 硬控制流 Agent：分类、需求澄清、TaskBook、步骤执行、验证、局部恢复和收尾。
- 索引优先记忆树：统一 Memory Service、T0-T3 资源注册、可回滚迁移、根/分支索引、按需展开、同分支深搜、预算、来源和写入闸门。
- 持久化执行记录：已完成 run 的 TaskBook、步骤、工具调用、验证记录和最终结果可在重启后重放；活动 run 的检查点续跑仍属于后续任务。
- 桌面聊天：SSE 流式回复、Markdown、代码块复制、附件、权限审批和中断；新导入附件使用独立受管缓存，用户工作区和外部文件不进入自动缓存清理范围。
- 拓展工作区：项目/会话、文件树、标签、内置 VS Code 风格编辑器、产物索引和 PowerShell/PTY 终端；Agent 通过有界、可恢复的元数据索引发现工作区资源，文件正文仍按任务需要读取。
- 稳定项目身份：新项目 ID 与路径解耦；移动或重命名文件夹后可重新定位，并保留会话、记忆、投影和工作区状态。
- 设置与模型：供应商密钥安全存储、供应商/模型选择、行为 profile 与权限策略分离；“存储与数据”支持登记完整数据根迁移、启动期校验切换和回滚。
- 插件扩展：PluginHost、manifest 校验、本地代码信任、工具贡献、owner-scoped Skill 贡献和可选外部渠道插件。
- 可选外部渠道：Webhook、Telegram、飞书和 QQ Bot；具体扩展边界见 [插件开发说明](docs/plugin-development.md)。

## 文档入口

仓库说明文档默认使用中文；代码标识、协议字段、命令、路径和产品名保留英文，避免与源码和外部文档脱节。

- [架构原则](docs/architecture-principles.md)：LLM、Agent、Mode、Context、Memory、Tools、Workflow 与插件的长期分工和硬约束。
- [架构评估与开发决策报告](docs/architecture-decision-report.md)：当前模块评估、主要缺口、推荐演进顺序和待决策事项。
- [项目状态](docs/project-status.md)：总进度、当前阶段、验证证据和未完成方向。
- [仓库指南](docs/repository-guide.md)：目录、模块和维护规则。
- [模块拆分地图](docs/module-split-map.md)：大型生产文件的所有权、目标边界和行为保持型拆分顺序。
- [总基调、认知架构与仓库基元化任务书 2026-07-14](docs/foundation-cognition-repository-taskbook-2026-07-14.md)：当前仓库整理、认知契约和数据边界的先行任务书。
- [核心 Agent 能力任务书 2026-07-13](docs/core-agent-capability-taskbook-2026-07-13.md)
- [Agent 核心与记忆系统任务书 2026-07-14](docs/agent-core-memory-taskbook-2026-07-14.md)：核心收敛与真实场景验收基线。
- [核心收敛小任务书 2026-07-13](docs/core-focus-maintenance-taskbook-2026-07-13.md)：冻结扩张、修复阻断 Bug、验证任务闭环与记忆系统。
- [拓展工作区任务书 2026-07-12](docs/extension-workspace-taskbook-2026-07-12.md)
- [Agent Runtime 连续性任务书 2026-07-14](docs/agent-runtime-continuity-taskbook-2026-07-14.md)：Context、记忆注册、附件、运行中重入、有界并行、检查点与后台连续执行。
- [核心流程规范](docs/core-agent-flow-guidelines.md)
- [UI 交互规范](docs/ui-interaction-guidelines.md)
- [插件开发说明](docs/plugin-development.md)
