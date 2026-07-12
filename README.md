# LittleSheep

LittleSheep（LS）是一个本地部署的高自治 Agent 桌面应用。核心运行在 Electron 主进程中，由代码级状态机驱动任务判断、执行、验证、恢复和记忆管理；用户可以在默认无感的同时，随时管理模型、权限、记忆和工作区。

## 架构概览

```text
Electron 渲染进程（React）
        |
        | loopback Local App API / SSE
        v
Electron 主进程
  Runner -> Harness Core Flow -> LLM / Tools / Memory Tree / Sessions
        |
        +-> optional external channel connectors
```

Local App API 只是本地 UI 与主进程之间的桥接，不是外部渠道网关。外部渠道是可选连接器，只负责把渠道消息送入 Agent，并把 Agent 回复送回渠道；没有渠道配置时，LS 仍可完整运行。

当前 workspace 包共 25 个：21 个核心包和 4 个渠道插件。包边界、重要模块和数据边界见 [仓库指南](docs/repository-guide.md)。

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
- 索引优先记忆树：根索引、分支索引、按需展开、同分支深搜、预算、来源和写入闸门。
- 持久化执行过程：TaskBook、步骤、工具调用、验证记录和最终结果可以在重启后恢复。
- 桌面聊天：SSE 流式回复、Markdown、代码块复制、附件、权限审批和中断。
- 拓展工作区：项目/会话、文件树、标签、内置 VS Code 风格编辑器、产物索引和 PowerShell/PTY 终端。
- 设置与模型：供应商密钥安全存储、供应商/模型选择、行为 profile 与权限策略分离。
- 可选外部渠道：Webhook、Telegram、飞书和 QQ Bot。

## 文档入口

仓库说明文档默认使用中文；代码标识、协议字段、命令、路径和产品名保留英文，避免与源码和外部文档脱节。

- [项目状态](docs/project-status.md)：总进度、当前阶段、验证证据和未完成方向。
- [仓库指南](docs/repository-guide.md)：目录、模块、数据边界和维护规则。
- [核心 Agent 能力任务书](docs/core-agent-capability-taskbook.md)
- [拓展工作区任务书](docs/extension-workspace-taskbook.md)
- [核心流程规范](docs/core-agent-flow-guidelines.md)
- [UI 交互规范](docs/ui-interaction-guidelines.md)

## 数据边界

用户运行时数据默认位于 `C:\Users\<用户名>\.littlesheep`，包括配置、会话、记忆树、项目、归档、执行日志和工作区恢复信息。仓库整理、构建和测试不会迁移或重写该目录。`packages/app/out/`、各包 `dist/`、日志和缓存是本机生成物，不进入 Git 版本内容。

## 公开仓库边界

公开版本只保留产品源码、测试、维护脚本和当前有效的工程文档。个人档案、本地操作指令、长期记忆、临时研究材料、评审或资源申请文档属于本机私有内容，不进入 Git。文档和脚本中不得出现真实用户绝对路径、密钥、交接过程或外部开发助手的对话痕迹。
