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

当前 workspace 包共 27 个：23 个核心包和 4 个渠道插件。包边界和重要模块见 [仓库指南](docs/reference/repository-guide.md)。

## 运行边界与权限

LS 把活动的完整应用数据根视为自己的逻辑容器，默认是 `.littlesheep`，可在设置中整体迁移；`workplace/` 只是该容器内的默认工作区。这个边界目前由 Electron Main 的路径解析、符号链接检查、命令静态判定和审批闸门实现，不等同于已经部署的 Docker/OS 进程沙箱。无法证明命令留在容器内时会按未知范围处理。

| 权限模式 | 容器内 | 容器外或范围不明 |
| --- | --- | --- |
| 完全访问 | 读取、写入、修改、删除、执行免批准 | 启用时确认一次风险，之后免逐次批准 |
| 研究 | 读取免批准；写入、修改、删除、执行需批准 | 任何操作需批准 |
| 受限 | 所有操作都需批准，包括读取 | 任何操作需批准 |

从其他模式切换到完全访问时，界面必须先显示风险警告，并使用红色危险按钮确认。确认后，Agent 工具和内置终端可直接访问宿主机外部资源及无法静态判定范围的资源，不再逐项询问。通用/编程是影响 Agent 行为的独立 profile，不是权限模式。LS 核心源码还受宿主级只读保护，危险命令黑名单也继续生效；任何权限都不能让 Agent 直接改写当前运行版本。具体实现和验收证据见 [项目状态](docs/decision/project-status.md)。

用户可以主动在拓展工作区打开外部项目或保存外部文件，但外部项目不会因此进入 LS 容器。研究和受限模式下，Agent 在外部工作区运行时不会先自动扫描其资源，只有对应访问得到明确批准后才继续；已经确认的完全访问模式可直接扫描和执行。

## 快速开始

```powershell
pnpm install
pnpm run build
.\build-app.bat
```

构建完成后，桌面上的 `LittleSheep.lnk` 会指向当前仓库生成的本机 `LittleSheep.exe` 命名运行时，并使用当前 `packages/app` 作为工作目录。这样通过标准桌面入口启动时，任务管理器中的主进程和 Electron 子进程都会显示为 `LittleSheep`。开发模式可以运行：

```powershell
.\start-littlesheep.bat
```

首次启动后，在设置中填写已购买的模型供应商 API key。当前配置层提供 OpenAI、DeepSeek 和 GLM 预置；没有可用密钥的供应商不会进入可选择模型列表。

## 质量门

日常开发先使用按 Git 变更传播到依赖方的快速门：

```powershell
pnpm.cmd run verify:changed
```

修改 Harness、Runner、Context、Memory 或公共契约时，再运行核心门：

```powershell
pnpm.cmd run verify:core
```

阶段结束、准备推送或发布前运行完整门：

```powershell
pnpm.cmd run verify:full
```

`typecheck` 使用 TypeScript project references 和增量缓存，并刷新本地声明产物，确保依赖包检查的是当前契约而不是旧 `dist/*.d.ts`。首次或清理缓存后会较慢，无改动复查通常会快速跳过。

完整门等价于按顺序运行：

```powershell
pnpm.cmd run check:repo
pnpm.cmd test
pnpm.cmd run typecheck
pnpm.cmd run build
pnpm.cmd run verify:app-recovery
```

不要在 README 中固定测试数量。最新结果记录在 [项目状态](docs/decision/project-status.md)，每次重大变更后重新运行上述命令并更新状态文档。

## 当前能力

- 硬控制流 Agent：`respond / execute / clarify` 活动路由、需求澄清、TaskBook、步骤执行、验证、局部恢复和收尾。
- 版本化模型调用契约：每次 LLM 请求独立声明 Context、允许决策、输出、工具、记忆意图和预算；越权在发送前失败关闭。
- 索引优先记忆树：统一 Memory Service、T0-T3 资源注册、可回滚迁移、根/分支索引、按需展开、同分支深搜、预算、来源和写入闸门。
- 用户长期理念：`PHILOSOPHY.md` 作为按需资源注册，不全文常驻每轮 Prompt；模型建议与运行时记忆提交权分离。
- 持久化执行与续跑：已完成 run 的 TaskBook、步骤、工具调用、验证记录和最终结果可在重启后重放；活动 run 已有版本化检查点、暂停/继续、应用启动恢复和显式续跑控制面。隔离的真实 Electron 已验收活动任务 SSE、托盘后台、暂停/继续/中断、配置与模型热重载、强制终止后续跑不重放、彻底退出和回答级跨重启连续性；非字段事实、真实外部系统副作用和更长期真实用户负载仍需继续验收。
- 桌面聊天：SSE 流式回复、Markdown、代码块复制、附件、权限审批和中断；新导入附件使用独立受管缓存，用户工作区和外部文件不进入自动缓存清理范围。
- 拓展工作区：项目/会话、只读 Git 审阅、文件树、标签、内置 VS Code 风格编辑器、产物索引和 PowerShell/PTY 终端；普通代码查看、编辑与 Git 审阅共用同一个 Monaco 内核、语言识别、主题和 `13px / 23px` 代码密度，Git 审阅提供稀疏变更树、分层红绿 diff、分支同步状态以及可持久化的单列/双列切换。审阅与文件查看共用右侧导航外壳，但目录缓存和 Git 快照保持隔离；两者使用有界、跨挂载、合并并发请求的 stale-while-revalidate 缓存，折叠或切换后立即恢复同一版本的旧快照并在后台校准。Monaco 只在代码文件或实际 Git 变更需要显示时按需加载。Agent 仍通过有界、可恢复的元数据索引发现工作区资源，文件正文按任务需要读取。
- OpenCode 对标：官方 VS Code 扩展采用约 10 KB 的原生终端桥，不在扩展内复制编辑器、文件树或 Diff；LS 已吸收其按字节有界内容缓存、稳定编辑器模型路径、审阅文件过滤/键盘导航和按需 Diff 原则。详细差异、MIT 复用边界与后续虚拟化/评论/真正扩展选项见 [OpenCode VS Code 对标记录](docs/reference/opencode-vscode-comparison-2026-08-13.md)。
- 开发环境管理：设置页可查看常用运行时状态、保存精确或系列版本偏好、导入/移除 LS 工具链；Electron 内置 Node 随应用提供，其他运行时的自动下载和安装包分发仍未完成。
- 稳定项目身份：新项目 ID 与路径解耦；移动或重命名文件夹后可重新定位，并保留会话、记忆、投影和工作区状态。
- 设置与模型：供应商密钥安全存储、供应商/模型选择、行为 profile 与权限策略分离；“存储与数据”支持登记完整数据根迁移、启动期校验切换和回滚。
- 插件扩展：PluginHost、manifest 校验、本地代码信任、工具贡献、owner-scoped Skill 贡献和可选外部渠道插件。
- 可选外部渠道：Webhook、Telegram、飞书和 QQ Bot；具体扩展边界见 [插件开发说明](docs/reference/plugin-development.md)。

## 文档入口

仓库说明文档默认使用中文；代码标识、协议字段、命令、路径和产品名保留英文，避免与源码和外部文档脱节。

先打开 [文档决策入口](docs/README.md)。它会先告诉你当前只需要决定什么，再按需展开依据、原则、任务书和仓库参考。

- 只想决定下一步：停留在文档决策入口第一页。
- 需要核对当前事实：[项目状态](docs/decision/project-status.md)。
- 需要理解推荐顺序：[架构决策报告](docs/decision/architecture-decision-report.md)。

不要从任务书列表开始阅读；任务书只在方向已经确定、准备执行具体阶段时展开。
