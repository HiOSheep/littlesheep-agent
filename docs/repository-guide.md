# LittleSheep 仓库指南

最后更新：2026-07-12

本文件说明源码仓库的边界和模块归属。它不描述用户运行时数据的具体内容，也不替代能力进度记录；进度以 [project-status.md](project-status.md) 为准。

## 根目录

| 路径 | 用途 |
| --- | --- |
| `docs/` | 正式架构约束、能力任务书、交互规范、项目状态和仓库维护说明。 |
| `packages/` | pnpm workspace 的全部产品源码包。 |
| `scripts/` | 可重复执行的构建、启动、快捷方式刷新、恢复检查和仓库卫生检查。 |
| `skills/` | 仓库级技能示例和技能编写辅助材料；运行时技能仍从用户数据和配置的技能目录加载。 |
| `test/` | 跨包契约、CLI、渠道和端到端测试。 |
| `.git/` | Git 元数据，禁止脚本直接修改历史。 |
| `node_modules/` | pnpm 安装产物，不属于源码，不应手工编辑或提交。 |

本地开发助手、IDE 工作目录、个人说明和临时研究材料不属于公开源码边界。构建输出也不属于源码仓库的维护边界。

## 根目录文件

| 文件 | 用途 |
| --- | --- |
| `package.json` | workspace 根脚本、测试入口、类型检查、构建和仓库卫生检查。 |
| `pnpm-workspace.yaml` | 声明 `packages/*` 与 `packages/channels/*` 两组 workspace。 |
| `pnpm-lock.yaml` | 依赖锁定文件；只有依赖变更时由 pnpm 更新。 |
| `tsconfig.base.json`、`vitest.config.ts` | 全仓 TypeScript 与 Vitest 基线。 |
| `branding.config.json`、`littlesheep.config.json` | 仓库级品牌/开发配置样例，不放用户密钥。 |
| `README.md` | 面向开发者的入口说明和质量门。 |
| `build-app.bat`、`start-littlesheep.bat` | Windows 兼容入口，实际逻辑委托给 `scripts/`。 |
| `.gitignore`、`.editorconfig` | 版本边界和编辑格式规范。 |

## 本地私有材料

- 个人档案、本地操作指令、长期记忆、评审材料和临时研究笔记可以留在开发机上，但不得被 Git 跟踪。
- 这类文件使用本地 `.git/info/exclude` 排除，不把机器或个人特定规则写入公开 `.gitignore`。
- 应用运行时会在用户数据目录中生成可编辑的用户说明和记忆文件；这些数据与源码仓库完全分离。

## Workspace 包清单

### Agent 核心

| 包 | 归属和职责 |
| --- | --- |
| `packages/types/` | Agent、消息、会话、工具、记忆和澄清请求的公共类型。 |
| `packages/classifier/` | 闲聊/问题/不清晰分类，含规则快速路径和模型兜底。 |
| `packages/prompt/` | 系统提示词、行为 profile、工作区信息和记忆树根索引的装配。 |
| `packages/harness/` | 硬控制流状态机、TaskBook、各 stage、hooks、局部重规划和验证。 |
| `packages/runner/` | 运行时装配、单次 run、流式事件、执行日志和基础设施依赖注入。 |
| `packages/llm/` | OpenAI-compatible 客户端、供应商请求、流式输出、重试和 usage 类型。 |
| `packages/config/` | 配置 schema、默认值、供应商预置、模型选择和用户配置加载。 |
| `packages/branding/` | 品牌配置和用户数据目录布局。 |

### 记忆、学习与安全

| 包 | 归属和职责 |
| --- | --- |
| `packages/memory-tree/` | 分支注册、根/分支索引、节点展开、同分支深搜、预算、来源和原子仓库。 |
| `packages/memory-core/` | 文件记忆兼容存储、daily、长期记忆、写入闸门、归档和旧来源适配。 |
| `packages/vector/` | 向量存储接口；只在已导航分支的深搜兜底路径使用。 |
| `packages/experience/` | 经验记录、置信度衰减和可复用能力数据。 |
| `packages/snapshot/` | 记忆快照、索引和回滚支持。 |
| `packages/safety/` | 记忆/提示注入防护、清洗、隔离和安全存储。 |
| `packages/session/` | JSONL 会话管理、锁和长会话压缩入口。 |

### 工具与扩展

| 包 | 归属和职责 |
| --- | --- |
| `packages/tools/` | 内置工具注册、权限审批、参数校验、结果清洗和 `read/write/edit/exec/grep/glob/memory_*` 工具。 |
| `packages/skills/` | 技能加载、使用和自主创建。 |
| `packages/mcp/` | MCP 客户端预留包；当前仍是骨架，不应在状态文档中写成已完成。 |
| `packages/cli/` | 命令行入口、参数解析、REPL 和管理命令。 |

### 渠道

| 包 | 归属和职责 |
| --- | --- |
| `packages/gateway/` | 可选外部渠道连接器的生命周期、路由、状态和消息桥接。它不承载本地 UI 与主 Agent 的必要通信。 |
| `packages/channels/webhook/` | Webhook 渠道插件。 |
| `packages/channels/telegram/` | Telegram 渠道插件。 |
| `packages/channels/feishu/` | 飞书渠道插件。 |
| `packages/channels/qqbot/` | QQ Bot 渠道插件。 |

## Electron 应用

`packages/app/` 是本地桌面产品，不应被误称为外部网关。

| 路径 | 重要模块 |
| --- | --- |
| `packages/app/src/main/index.ts` | Electron 主进程启动、用户数据初始化、Runner/渠道装配、窗口和退出流程。 |
| `packages/app/src/main/local-app-api-server.ts` | 渲染器与主进程之间的 loopback Local App API、SSE、会话、工作区、终端和设置接口。 |
| `packages/app/src/main/keychain.ts` | API key 的 Electron 安全存储与环境注入。 |
| `packages/app/src/main/session-index.ts`、`project-index.ts`、`archive-index.ts` | UI 侧会话、项目和归档元数据索引。 |
| `packages/app/src/main/memory-tree-control.ts` | 记忆树管理页面使用的运行时控制面。 |
| `packages/app/src/main/workspace-*.ts` | 工作区布局、产物、文件路由、终端和 shell 适配。 |
| `packages/app/src/main/shutdown-sequence.ts` | 应用退出时的有序关闭。 |
| `packages/app/src/preload/` | 安全的 context bridge，向 renderer 暴露必要运行时信息。 |
| `packages/app/src/renderer/App.tsx` | 主界面、侧边栏、会话、输入栏、设置和拓展工作区编排。 |
| `packages/app/src/renderer/TraceCard.tsx` | Agent 执行过程、TaskBook、工具调用和验证时间线。 |
| `packages/app/src/renderer/MemoryTreeView.tsx`、`ArchiveManager.tsx`、`Settings.tsx` | 记忆树、归档和设置界面。 |
| `packages/app/src/renderer/api.ts` | renderer 对 Local App API 的类型化 fetch/SSE 客户端。 |
| `packages/app/src/renderer/styles.css` | 深灰视觉系统、统一浮层、转场、折叠和工作区布局样式。 |
| `packages/app/src/shared/` | renderer 与主进程共享的纯函数模型和持久化协议。 |

## 测试与脚本

- 包内 `src/**/*.test.ts(x)`：测试包内契约和模块行为，应与源码同目录维护。
- `test/core-agent-contracts.test.ts`：跨包核心 Agent 契约。
- `test/e2e-cli.test.ts`、`test/e2e-webhook.test.ts`：跨包 CLI/渠道流程。
- `scripts/check-repository-hygiene.mjs`：仓库结构质量门，不参与运行时。
- `scripts/verify-app-recovery-sources.mjs`：只读检查用户数据中的工作区、会话、执行日志和恢复索引。
- `scripts/build-app.ps1`：构建 Electron 应用并刷新快捷方式。
- `scripts/refresh-desktop-shortcut.ps1`：按脚本所在仓库路径解析 Electron，生成桌面快捷方式。
- `scripts/start-littlesheep.ps1`：位置无关的开发启动入口。

## 源码、生成物和用户数据边界

### 应提交和维护的内容

- `packages/**/src/`、跨包 `test/`、配置 schema、正式文档、维护脚本和根入口。
- 影响运行时契约的变更必须同时有测试；影响用户交互的变更必须更新对应交互规范或状态说明。

### 只在本机生成的内容

- `packages/app/out/`、各包 `dist/`、`coverage/`、日志、缓存、临时文件和 TypeScript 构建缓存。
- 构建输出可以留在本机供桌面快捷方式启动，但不进入 Git 版本内容。

### 用户运行时数据

- 默认位于 `C:\Users\<用户名>\.littlesheep`，由 `@littlesheep/branding` 和应用运行时确定。
- 包括 API 配置、加密密钥引用、sessions、memory-tree、projects、archive、execution logs、workspace layout、terminal activity 和用户工作区。
- 仓库治理、构建和测试不得迁移、格式化、删除或重写该目录。需要数据治理时必须先做只读诊断，并单独获得用户授权。

## 后续修改规则

1. 先在对应包和本指南中确认模块归属；不要把运行时逻辑塞进 renderer，也不要让外部渠道成为本地核心依赖。
2. 新增模块优先放入已有包；只有边界、生命周期和测试都清晰时才创建新包，并同步 workspace、入口、文档和测试。
3. 修改公共类型或事件协议时，同时检查 `types`、生产者、消费者、持久化、renderer 恢复和相关测试。
4. 删除模块前先搜索 import、导出、文档链接、脚本和用户数据兼容代码；删除后运行 `check:repo`、测试、typecheck 和 build。
5. 文档只保留当前事实。阶段完成后更新 [project-status.md](project-status.md)，不要继续追加一次性历史报告。
6. UI 变更遵守 [ui-interaction-guidelines.md](ui-interaction-guidelines.md)；核心流程变更遵守 [core-agent-flow-guidelines.md](core-agent-flow-guidelines.md)。
7. 每次应用构建都通过 `scripts/build-app.ps1` 或根 `build-app.bat` 刷新快捷方式；不得把机器绝对路径写进脚本。
8. 验证顺序固定为：`pnpm.cmd run check:repo`、`pnpm.cmd test`、`pnpm.cmd run typecheck`、`pnpm.cmd run build`、`pnpm.cmd run verify:app-recovery`。失败时记录真实原因，不用旧数字覆盖。
9. 说明文档默认使用中文；代码标识、协议字段、命令、路径和供应商产品名保留英文。确有维护价值的英文内容只能作为补充版本，不能取代中文正式文档。
