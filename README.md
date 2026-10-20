# LittleSheep 🐑

**A local-first agent desktop app that turns goals into finished work.**

LittleSheep（LS）是一个本地运行的 Agent 桌面应用。用户设定目标并掌握权限、风险和关键决策；LS 负责理解、执行、验证，并在失败时按明确边界恢复或请求决定。

LS 提供持久化 Agent Runtime、长期记忆、桌面工作区、文件与 Git 工具、终端、模型配置及可选工具和渠道扩展。目前仍在快速开发，主要面向 Windows。

## 产品方向

普通聊天 Agent 围绕一次请求和回复运行；LS 关注如何持续、可靠地完成目标。模型负责理解与提出工具请求，Runtime 控制权限、执行、证据、恢复和持久化。

- **受控执行**：常规会话与任务共用单一主循环，工具调用经统一执行边界；Runtime 按记录证据验证并有界恢复。
- **长期记忆**：从索引按需导航；durable 写入经受控工具和来源校验，压缩只维护会话摘要。
- **桌面工作区**：在一个应用中查看和编辑文件、审阅 Git、管理会话并使用内置终端。
- **显式权限**：用户决定授权范围；Main 执行前重新检查路径和策略。当前逻辑容器不是 OS 进程沙箱。
- **扩展能力**：PluginHost 支持工具、Skill 与可选外部渠道，如 Webhook、Telegram、飞书和 QQ Bot。

当前实现与未完成边界见[项目状态](docs/decision/project-status.md)；以上概述不代替逐项产品验收。

## 快速开始

需要 Node.js 20.9+ 和 pnpm 11.9.0。Windows 开发流程：

```powershell
pnpm install
pnpm run build
.\build-app.bat
```

也可以运行 `pnpm run dev` 启动开发应用，或运行 `pnpm run start` 启动 CLI。桌面启动入口为 `start-littlesheep.bat`。

首次启动后，在设置中配置模型供应商。没有可用密钥的 Provider 不会出现在可选模型中；密钥由宿主安全存储管理。

## 架构概览

```text
Electron Renderer
       │ loopback Local App API / SSE
Electron Main ── Runner ── Harness
       │                    ├── LLM
       │                    ├── Tools
       │                    ├── Memory Tree
       │                    └── Session / Context
       └── PluginHost ── optional channel plugins
```

Local App API 只连接本地 Renderer 与 Main，不属于外部渠道。仓库含 27 个 workspace package；代码定位见[仓库指南](docs/reference/repository-guide.md)。

## 权限与工作区

应用数据根（默认 `.littlesheep/`）可整体迁移；其下的 `workplace/` 只是默认工作区。用户选择外部项目不会改变其数据所有权。公开权限选择是 Permission V2 的三个预设：`read-only`（只读）、`workspace-write`（工作区写入）和 `full-access`（完全访问）。旧 `full`、`research`、`restricted` 会话不做兼容迁移：其索引条目会从 `sessions.json` 移除，聊天记录文件不因此删除。

| 权限预设 | 工作区内读取 | 工作区内写入 | 工作区外、应用数据根或范围未知 | Shell 执行 |
| --- | --- | --- | --- | --- |
| 只读 | 经原生文件守卫可证明安全时自动放行 | 需批准 | 需批准 | 需批准 |
| 工作区写入 | 同上 | 仅 Windows 的内置写入工具自动放行（文件守卫可用时）；其他平台需批准 | 需批准 | 需批准 |
| 完全访问 | 明确确认后自动放行 | 明确确认后自动放行（受保护源码根仍硬拒绝） | 明确确认后自动放行 | 仍需逐次批准 |

- 切换到完全访问必须在界面中明确确认风险；该确认是 Main 记录的运行事实，运行请求不能把已有会话提升到更高权限，只能收窄。
- 只读与工作区写入预设只自动放行工作区内读取；应用数据根、Memory/会话等 Runtime 自有资源和 Web 读取仍按审批或硬拒绝处理。完全访问确认后，除 Shell 外的普通读取与写入自动放行，网络策略、受保护资源和硬拒绝仍独立生效。
- 所有预设下 Shell 都以当前用户身份在宿主执行，没有 OS 级 Shell 沙箱，也不受工作区目录约束；`workspace-write` 的文件守卫同样只是应用层路径检查。
- 受保护源码根的写入、危险命令和 `approvalPolicy=deny` 属于硬拒绝，任何预设与用户批准都不能覆盖；Shell 的逐次批准唯一例外是 P3 ADR 明确批准、由用户主动启用的精确命令重复授权。
- 该边界由 Main 的路径分类、权限快照和审批实现，不等同于 Docker 或 OS 级进程隔离。

## 开发与文档

开发规则、代码入口和验证分档见[仓库指南](docs/reference/repository-guide.md)。仓库检查运行 `pnpm check:repo`；定向验证从根 `package.json` 的 `verify:*` 命令选择。真实 Electron、真实 Provider 和发布包验收各自证明不同边界，检查结果见[项目状态](docs/decision/project-status.md)。

文档入口：[docs/README.md](docs/README.md)。

## 参与贡献

欢迎阅读源码、提出 Issue 或参与讨论。

## License

LittleSheep is licensed under the [MIT License](LICENSE).

Copyright © 2026 HiOSheep.
