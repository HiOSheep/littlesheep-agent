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

应用数据根（默认 `.littlesheep/`）可整体迁移；其下的 `workplace/` 只是默认工作区。用户选择外部项目不会改变其数据所有权。研究与受限模式下，Agent 在外部或未知工作区读取、写入和执行前须按策略取得批准。

| 权限模式 | 容器内 | 容器外或范围未知 |
| --- | --- | --- |
| 完全访问 | 确认风险后免逐次批准 | 启用时确认风险后免逐次批准 |
| 研究 | 读取免批准；写入与执行需批准 | 需要批准 |
| 受限 | 每项操作都需批准 | 每项操作都需批准 |

该边界由 Main 的路径分类和审批实现，不等同于 Docker 或 OS 级进程隔离。核心源码只读与危险命令硬拒绝独立生效。

## 开发与文档

开发规则、代码入口和验证分档见[仓库指南](docs/reference/repository-guide.md)。仓库检查运行 `pnpm check:repo`；定向验证从根 `package.json` 的 `verify:*` 命令选择。真实 Electron、真实 Provider 和发布包验收各自证明不同边界，检查结果见[项目状态](docs/decision/project-status.md)。

文档入口：[docs/README.md](docs/README.md)。

## 参与贡献

欢迎阅读源码、提出 Issue 或参与讨论。

## License

LittleSheep is licensed under the [MIT License](LICENSE).

Copyright © 2026 HiOSheep.
