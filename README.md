# LittleSheep 🐑

最后更新：2026-09-22 10:56:22

**A local-first agent desktop app that turns goals into finished work.**

LittleSheep（LS）是一个本地运行、能够持续自主执行任务的 Agent 桌面应用。

你告诉 LS 想完成什么，它负责理解目标、调用工具、执行操作、核对执行证据，并在失败时按既定边界重试或停下来问清楚；你仍然掌握权限授予、风险接受、目标取舍和关键决策。

LS 不只是一个聊天窗口。它包含持久化 Agent Runtime、长期记忆、工作区、文件与 Git 工具、内置终端、模型管理，以及可扩展的工具和渠道插件。

> LittleSheep 目前仍在快速开发中，主要面向 Windows 桌面环境。

## Why LittleSheep?

普通聊天 Agent 往往围绕一次请求和一次回复运行，而 LS 更关注一个问题：

**怎样让 Agent 把一个目标持续、可靠地做完？**

因此 LS 将任务执行本身作为核心能力，而不是聊天界面的附属功能。

- 🧠 **Persistent Agent Runtime** — 任务由确定性的 Runtime 管理，并通过显式、可持久化的执行状态推进执行、结构验证、有界恢复和收尾。模型负责智能，Runtime 负责可靠性。
- 🔧 **Integrated Tool Execution** — 文件、终端、Git、检索、工作区能力和插件工具统一接入 Agent 执行流程。
- 💾 **Long-term Memory** — 使用索引优先、按需展开的长期记忆体系，而不是把所有历史信息长期堆进 Context。
- 🖥️ **Built-in Workspace** — 聊天、代码查看与编辑、文件树、Git Diff、终端、会话和任务产物集中在同一个桌面应用内。
- 🔐 **Explicit Permission Model** — Agent 能访问什么、执行什么由用户明确控制；无法证明安全范围的操作不会被默认视为安全。
- 🔌 **Extensible by Design** — 支持工具贡献、Skill、PluginHost，以及 Telegram、飞书、QQ Bot、Webhook 等可选渠道插件。

## 当前能力

### Agent Runtime

LS 当前已经实现一套确定性的 Agent Runtime，用显式执行状态管理任务生命周期：

- 活动路由只产出两条路径：所有常规会话和任务回合进入单一主循环 `execute`，只有能力/状态询问走最小 Runtime 事实契约的 `reply`
- 需求澄清（主循环内的 `request_user_input`，或恢复升级进入 `ASK_USER`）
- 持久化 TaskBook 作为只读历史，步骤在主循环内串行推进
- 工具调用
- 结构验证：只断言 Runtime 证据能证明的事实，窄结构形态记为 `pass`，其余已完成的 run 记为 `unverified`
- 有界恢复：Runtime 依据已记录事实重试、显式停止或把决定交回用户
- 任务收尾
- 暂停、继续和中断
- 跨应用重启恢复

DECIDE、VERIFY 模型调用、RECOVER 模型调用和 CAPTURE 已删除：不再有第二次规划请求、验证模型请求、恢复模型请求，也没有运行结束后的自动沉淀。

每次模型调用都使用版本化契约，显式声明 Context 种类、输出结构、记忆意图和预算；超出当前调用契约的 Context 组合会在发送前被拒绝。会话区间内广告给模型的工具目录保持固定，本回合无权使用的能力在执行时被拒绝，而不是从工具 schema 中隐藏。

### 持久化执行

已完成任务的 TaskBook、步骤、工具调用、验证记录和最终结果可以在重启后重新加载。

活动任务支持版本化检查点、暂停、继续、应用启动恢复和显式续跑。

隔离的实际 Electron 进程已验收活动任务 SSE、托盘后台运行、暂停 / 继续 / 中断、配置与模型热重载、强制终止后的续跑、避免重复执行已完成副作用、完整退出和回答级跨重启连续性；更复杂的外部副作用场景与更大规模负载仍在验证，证据见 [Project Status](docs/decision/project-status.md)。

### Memory

LS 使用统一 Memory Service 和索引优先的 Memory Tree，目前包括：

- T0–T3 资源注册
- 根索引和分支索引
- 按需展开
- 同分支深搜
- Context 预算
- 来源记录
- 压缩写入候选的认识状态校验
- 可回滚迁移

用户长期理念可以通过 `PHILOSOPHY.md` 注册为按需资源，而不是全文常驻每轮 Prompt。模型只能通过 `memory_tree` 的 `root_index` / `branch_index` / `expand` / `deep_search` / `release` 读取和释放记忆，没有记忆写入工具；持久记忆的唯一写入方是会话压缩路径，其候选由 Runtime 提交或拒绝。

### Desktop Workspace

LS 内置桌面工作区，目前支持：

- 项目与会话
- 文件树
- 文件查看与编辑
- Monaco Editor
- 只读 Git 审阅
- 单列 / 双列 Diff
- 分支同步状态
- 任务产物索引
- PowerShell / PTY 终端

普通代码查看、编辑和 Git 审阅使用同一套 Monaco 内核。工作区资源通过有界、可恢复的元数据索引提供给 Agent，文件正文只在任务需要时读取。

### Models & Settings

当前配置层预置：

- OpenAI
- DeepSeek
- GLM

供应商 API Key 使用安全存储。没有可用密钥的供应商不会进入可选择模型列表。

Agent 行为 Profile 与权限模式相互独立。

### Plugins & Channels

LS 提供 PluginHost 和 manifest 校验机制，目前支持：

- 本地代码插件信任
- 工具贡献
- Owner-scoped Skill
- 可选外部渠道插件

现有外部渠道包括 Webhook、Telegram、飞书和 QQ Bot。没有配置任何外部渠道时，LS 仍然可以作为完整桌面 Agent 独立运行。

## 快速开始

当前主要面向 Windows。

```powershell
pnpm install
pnpm run build
.\build-app.bat
```

构建完成后，桌面的 `LittleSheep.lnk` 会指向当前仓库生成的 `LittleSheep.exe` 命名运行时，并使用当前 `packages/app` 作为工作目录。

开发模式：

```powershell
.\start-littlesheep.bat
```

首次启动后，在设置中填写对应模型供应商的 API Key。

## 架构概览

```text
Electron Renderer (React)
        |
        | loopback Local App API / SSE
        v
Electron Main
  |
  |-> Runner
  |     |
  |     +-> Harness Core Flow
  |            |
  |            +-> LLM
  |            +-> Tools
  |            +-> Memory Tree
  |            +-> Sessions
  |            +-> validated plugin tool contributions
  |
  +-> PluginHost
         |
         +-> optional channel plugins
```

Local App API 只负责本地 Renderer 与 Electron Main 之间的通信，不属于外部渠道层。

外部渠道以可选插件存在，只负责将渠道消息送入 Agent，再将 Agent 回复送回对应渠道。

当前 workspace 包含 28 个 package：`packages/*` 下 24 个（含桌面应用）和 `packages/channels/*` 下 4 个渠道插件。更完整的仓库结构见 [Repository Guide](docs/reference/repository-guide.md)。

## 权限与安全边界

LS 将活动应用数据根视为自己的逻辑容器，默认数据根为：

```text
.littlesheep/
```

用户可以在设置中整体迁移数据根。`workplace/` 只是该容器内的默认工作区，并不代表整个权限边界。

当前安全边界主要由 Electron Main 中的路径解析、符号链接检查、命令静态判定、授权检查、核心源码宿主级只读保护和危险命令黑名单实现。

它**不等同于 Docker、虚拟机或 OS 级进程沙箱**。无法证明操作范围仍位于 LS 容器内时，会按照“范围未知”处理。

| 权限模式 | 容器内 | 容器外或范围未知 |
| --- | --- | --- |
| 完全访问 | 读取、写入、修改、删除、执行免批准 | 启用时确认风险，之后免逐次批准 |
| 研究 | 读取免批准；写入、修改、删除、执行需批准 | 所有操作需批准 |
| 受限 | 所有操作均需批准 | 所有操作均需批准 |

从其他模式切换至完全访问时，UI 会要求明确确认风险。完全访问确认后，Agent 工具和内置终端可以直接访问宿主机外部资源，以及无法静态判断范围的资源。

无论处于何种权限模式，Agent 都不能直接改写当前正在运行的 LS 核心版本。

更多实现状态和验收记录见 [Project Status](docs/decision/project-status.md)。

## 外部工作区

用户可以主动打开外部项目或将文件保存到外部位置。外部项目不会因此自动成为 LS 数据容器的一部分。

在研究模式和受限模式下，Agent 不会自动扫描外部工作区资源，只有相应访问得到明确批准后才会继续。已经确认完全访问模式后，可直接进行相应扫描和执行。

## 开发与验证

日常开发可以使用基于 Git 变更传播范围的快速验证：

```powershell
pnpm.cmd run verify:changed
```

修改 Harness、Runner、Context、Memory 或公共契约时：

```powershell
pnpm.cmd run verify:core
```

阶段结束、准备推送或发布前：

```powershell
pnpm.cmd run verify:full
```

完整验证流程当前等价于：

```powershell
pnpm.cmd run check:repo
pnpm.cmd test
pnpm.cmd run typecheck
pnpm.cmd run build:app
pnpm.cmd run verify:app-recovery
```

TypeScript 检查使用 Project References 和增量缓存，并刷新本地声明产物，避免依赖包继续检查旧的 `dist/*.d.ts`。

最新测试和验收状态统一记录在 [Project Status](docs/decision/project-status.md)。

## 文档

仓库文档默认使用中文。代码标识、协议字段、命令、路径和产品名称保留英文，以避免与源码及外部技术文档产生歧义。

文档入口：[docs/README.md](docs/README.md)

如果想进一步了解：

- 当前实现状态：[Project Status](docs/decision/project-status.md)
- 架构决策与演进顺序：[Architecture Decision Report](docs/decision/architecture-decision-report.md)
- 仓库结构：[Repository Guide](docs/reference/repository-guide.md)
- 插件开发：[Plugin Development](docs/reference/plugin-development.md)

## 参与贡献

如果你对 Agent Runtime、持久化执行、长期记忆、桌面 Agent、工具系统或具身智能方向感兴趣，欢迎阅读源码、提出 Issue 或参与讨论。

## License

LittleSheep is licensed under the [MIT License](LICENSE).

Copyright © 2026 HiOSheep.
