# LittleSheep 仓库指南

最后更新：2026-07-14

本文件说明源码仓库的边界和模块归属。它不描述用户运行时数据的具体内容，也不替代能力进度记录；进度以 [project-status.md](project-status.md) 为准。

## 正式文档职责

| 文档 | 唯一职责 | 更新时机 |
| --- | --- | --- |
| [architecture-principles.md](architecture-principles.md) | 长期架构原则、责任边界和禁止的架构捷径 | 顶层设计原则发生变化时 |
| [architecture-decision-report.md](architecture-decision-report.md) | 当前架构评估、演进顺序、风险和用户决策点 | 完成一个架构阶段或证据推翻原建议时 |
| [project-status.md](project-status.md) | 当前能力状态、真实验证结果和未完成方向 | 重大实现或验证后 |
| [repository-guide.md](repository-guide.md) | 目录、文件、模块归属、依赖和维护规则 | 仓库结构或模块所有权变化时 |
| [module-split-map.md](module-split-map.md) | 大型生产文件的所有权、目标边界、分支归属和拆分顺序 | 文件越过阈值、完成拆分或批准例外时 |
| [core-agent-flow-guidelines.md](core-agent-flow-guidelines.md) | Core Flow、TaskBook、验证、恢复和记忆运行时的专项规范 | 核心流程契约变化时 |
| [ui-interaction-guidelines.md](ui-interaction-guidelines.md) | UI 视觉与交互专项规范 | 新增或调整交互规则时 |
| [总基调、认知架构与仓库基元化任务书 2026-07-14](foundation-cognition-repository-taskbook-2026-07-14.md) | 总基调的工程转译、仓库基元化、LLM Call Contract、身份与数据边界 | 仓库整理阶段、认知契约或数据边界发生变化时 |
| [核心 Agent 能力任务书 2026-07-13](core-agent-capability-taskbook-2026-07-13.md) | 核心 Agent 能力的阶段设计、验收标准和完成记录 | 阶段契约或实现范围变化时；不维护全仓最新测试数字 |
| [Agent 核心与记忆系统任务书 2026-07-14](agent-core-memory-taskbook-2026-07-14.md) | 核心闭环、记忆闭环和真实场景验收基线 | 核心收敛顺序或验收门槛变化时 |
| [核心收敛小任务书 2026-07-13](core-focus-maintenance-taskbook-2026-07-13.md) | 冻结非必要扩张并集中处理阻断 Bug 和核心收敛 | 核心收敛范围或冻结条件变化时 |
| [拓展工作区任务书 2026-07-12](extension-workspace-taskbook-2026-07-12.md) | 拓展工作区的阶段设计、验收标准和剩余边界 | 工作区阶段契约或实现范围变化时；不替代项目状态 |
| [Agent Runtime 连续性任务书 2026-07-14](agent-runtime-continuity-taskbook-2026-07-14.md) | Context、T0-T3、附件、运行中重入、有界并行、检查点、后台执行和透明度的专项任务书 | Runtime 连续性阶段契约、依赖或验收结果变化时 |
| [plugin-development.md](plugin-development.md) | 插件 API、开发流程、安全边界和兼容规则 | 插件宿主或贡献接口变化时 |

同一事实只在其责任文档中维护，其他文档使用链接引用。冲突时，长期约束看架构原则，当前事实和验证数字看项目状态，演进顺序看架构决策报告，目录归属看本指南，专项交互和流程看对应规范。不要创建按日期命名的一次性总结来复制进度、目录或测试数字。

任务书属于版本化执行基线，命名固定为“任务书总名称 + 最后更新时间”。文件名使用 `*-taskbook-YYYY-MM-DD.md`，一级标题以同一日期结尾，正文 `最后更新：YYYY-MM-DD` 必须一致。修改任务书内容并更新日期时，必须在同一变更中重命名文件并更新全仓链接；不使用 `latest`、`final` 或无日期文件名表达当前版本。

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
| `packages/types/` | Agent、消息、会话、工具、记忆、澄清请求，以及 Mode、运行决议、Context、附件、运行事件、TaskBookPatch、检查点、模型请求和执行证据等内部 v1 契约。 |
| `packages/classifier/` | 闲聊/问题/不清晰分类，含规则快速路径和模型兜底。 |
| `packages/prompt/` | 系统提示词、行为 profile、工作区信息和记忆树根索引的装配。 |
| `packages/harness/` | 硬控制流状态机、TaskBook、各 stage、hooks、局部重规划和验证。 |
| `packages/runner/` | 运行时装配、单次 run、流式事件、执行日志和基础设施依赖注入。 |
| `packages/llm/` | OpenAI-compatible 客户端、供应商请求、流式输出、重试和 usage 类型。 |
| `packages/config/` | 配置 schema、默认值、供应商预置、模型选择和用户配置加载。 |
| `packages/context/` | Context 候选排序、模型窗口预算、可注入精确 token 计数、预算淘汰、压缩阈值信号以及脱敏 `ContextSnapshot` / `ModelRequestSnapshot`。阶段 1 主要数据链已接通，但仍不负责记忆存储、会话存储或 Provider 调用。 |
| `packages/branding/` | 品牌配置和用户数据目录布局。 |

### 记忆、学习与安全

| 包 | 归属和职责 |
| --- | --- |
| `packages/memory-tree/` | `MemoryService` 统一消费门面、T0-T3 资源注册、v1→v2 安全迁移、资源生命周期与有界审计、分支注册、根/分支索引、节点/资源展开、同分支深搜、预算、来源、项目记忆三层投影、项目/资源路径迁移、workplace 元数据索引和原子仓库。 |
| `packages/memory-core/` | 文件记忆兼容存储、daily、长期记忆、写入闸门、归档和旧来源适配。 |
| `packages/vector/` | 向量存储接口；只在已导航分支的深搜兜底路径使用。 |
| `packages/experience/` | 经验记录、置信度衰减和可复用能力数据。 |
| `packages/snapshot/` | 记忆快照、索引和回滚支持。 |
| `packages/safety/` | 记忆/提示注入防护、清洗、隔离和安全存储。 |
| `packages/session/` | JSONL 会话管理、锁和长会话压缩入口。 |

### 工具与扩展

| 包 | 归属和职责 |
| --- | --- |
| `packages/tools/` | 内置工具、注册表、输入 schema、基础计时/结果 wrapper 和部分工具内审批。完整授权、超时、流式事件、证据与恢复当前仍分散在 Tools、Harness 和 App，尚待统一 Tool Execution Service 收敛。 |
| `packages/plugins/` | 插件 API v1、插件发现、信任闸门、生命周期宿主，以及渠道、工具和 owner-scoped Skill 贡献。它是扩展运行时，不是 Agent 任务核心。 |
| `packages/skills/` | 技能加载、使用和自主创建。 |
| `packages/mcp/` | MCP 客户端预留包；当前仍是骨架，不应在状态文档中写成已完成。 |
| `packages/cli/` | 命令行入口、参数解析、REPL 和管理命令。 |

### 渠道

| 包 | 归属和职责 |
| --- | --- |
| `packages/channels/webhook/` | Webhook 渠道插件。 |
| `packages/channels/telegram/` | Telegram 渠道插件。 |
| `packages/channels/feishu/` | 飞书渠道插件。 |
| `packages/channels/qqbot/` | QQ Bot 渠道插件。 |

## 需求定位表

先从需求类型定位 package，再沿 package README 进入公开入口和同目录测试。不要从搜索结果直接跨包深层 import。

| 需求类型 | 主要所有者 | 首要入口 | 主要测试 |
| --- | --- | --- | --- |
| Agent 状态机、TaskBook、验证或恢复 | `packages/harness/` | `src/default-harness.ts`、`src/stages/` | `src/default-harness.test.ts`、`src/stages/*.test.ts` |
| 单次 run、流式事件、执行日志 | `packages/runner/` | `src/runner.ts`、`src/execution-log.ts` | `src/runner.test.ts`、`src/execution-log.test.ts` |
| 公共运行契约 | `packages/types/` | `src/index.ts`、`src/runtime-contracts.ts` | `src/runtime-contracts.test.ts`、`test/core-agent-contracts.test.ts` |
| Context 候选、预算、计数和快照 | `packages/context/` | `src/engine.ts` | `src/engine.test.ts`、Harness Context 测试 |
| Provider 请求、流式与 usage | `packages/llm/` | `src/client.ts` | `src/client.test.ts`、Provider smoke 脚本 |
| 配置、Provider/模型能力 | `packages/config/` | `src/schema.ts`、`src/model-capabilities.ts` | `src/schema.test.ts`、App shared capability 测试 |
| Prompt 与行为 profile | `packages/prompt/` | `src/builder.ts`、`src/profiles.ts` | `src/builder.test.ts`、`src/profiles.test.ts` |
| 记忆树、资源注册与项目投影 | `packages/memory-tree/` | `src/memory-service.ts`、`src/memory-repository.ts` | `src/memory-*.test.ts`、`src/project-*.test.ts` |
| 旧文件记忆、写入与归档 | `packages/memory-core/` | `src/write-memory.ts`、`src/archive.ts` | 对应同名测试 |
| 会话和长会话摘要 | `packages/session/` | `src/manager.ts`、`src/compaction.ts` | 对应同名测试 |
| 工具注册、审批和内置工具 | `packages/tools/` | `src/registry.ts`、`src/wrapper.ts`、`src/builtin/` | `src/**/*.test.ts` |
| 插件发现、信任和生命周期 | `packages/plugins/` | `src/host.ts`、`src/manifest.ts` | `src/**/*.test.ts` |
| 外部渠道协议 | `packages/channels/*` | 各包 `src/plugin.ts` | 各包 `src/plugin.test.ts`、`test/e2e-webhook.test.ts` |
| Electron 启动、Local App API 和用户数据 adapter | `packages/app/src/main/` | `index.ts`、`local-app-api-server.ts` | `src/main/*.test.ts` |
| 桌面 UI、导航、设置和工作区 | `packages/app/src/renderer/` | `App.tsx`、`api.ts` | `src/renderer/*.test.ts(x)` 与真实窗口验收 |
| CLI 与管理命令 | `packages/cli/` | `src/bin.ts`、`src/commands/` | `src/**/*.test.ts`、`test/e2e-cli.test.ts` |

当前大型文件的拆分所有权和顺序见 [模块拆分地图](module-split-map.md)。

## Electron 应用

`packages/app/` 是本地桌面产品。Local App API 是 renderer 与主进程之间的本地桥接，不属于外部渠道插件。

| 路径 | 重要模块 |
| --- | --- |
| `packages/app/src/main/index.ts` | Electron 主进程启动、用户数据初始化、Runner/PluginHost 装配、窗口和退出流程。 |
| `packages/app/src/main/builtin-plugins.ts` | 内置插件目录；具体渠道实现仍通过动态 import 按需加载。 |
| `packages/app/src/main/local-app-api-server.ts` | renderer 与主进程之间的 loopback Local App API、SSE、会话、工作区、终端、插件和设置接口。 |
| `packages/app/src/main/attachment-cache.ts`、`attachments.ts` | LS 受管附件缓存的稳定索引、配额/过期清理、安全删除校验，以及 run-scoped 附件解析与所有权分类。 |
| `packages/app/src/main/data-root-migration.ts`、`data-root-metadata.ts` | 数据根 locator、迁移事务、同级 staging、流式哈希清单、启动前恢复、活动元数据内部路径重绑定和回滚；正式用户数据不得用于故障注入。 |
| `packages/app/src/main/keychain.ts` | API key 的 Electron 安全存储与环境注入。 |
| `packages/app/src/main/session-index.ts`、`project-index.ts`、`archive-index.ts` | UI 侧会话、稳定项目身份和归档元数据索引。 |
| `packages/app/src/main/project-rebinding.ts`、`path-rebinding.ts` | 项目移动/重命名后的持久化重绑定事务、恢复日志和跨索引路径重映射。 |
| `packages/app/src/main/memory-tree-control.ts` | 记忆树管理页面使用的运行时控制面；通过 `MemoryService` 读取节点、访问账本、资源注册表、资源生命周期审计和项目投影状态，并执行受约束的节点/资源管理动作。 |
| `packages/app/src/main/workspace-*.ts` | 工作区布局、产物、文件路由、终端和 shell 适配。 |
| `packages/memory-tree/src/workspace-resource-index.ts`、`workspace-resource-scanner.ts` | 用户数据中的工作区资源元数据索引、游标式有界扫描、精确变更提示、重启恢复和按查询展开；不读取文件正文。 |
| `packages/app/src/main/shutdown-sequence.ts` | 应用退出时的有序关闭。 |
| `packages/app/src/preload/` | 安全的 context bridge，向 renderer 暴露必要运行时信息。 |
| `packages/app/src/renderer/App.tsx` | 主界面、侧边栏、会话、输入栏、设置和拓展工作区编排。 |
| `packages/app/src/renderer/TraceCard.tsx` | Agent 执行过程、TaskBook、工具调用和验证时间线。 |
| `packages/app/src/renderer/MemoryTreeView.tsx`、`ArchiveManager.tsx`、`Settings.tsx` | 记忆树、项目记忆投影、归档和设置界面。 |
| `packages/app/src/renderer/api.ts` | renderer 对 Local App API 的类型化 fetch/SSE 客户端。 |
| `packages/app/src/renderer/styles.css` | 当前深灰视觉系统、共享浮层/转场 token、折叠和工作区布局样式；后续按 feature 拆分时必须保留共享原语契约。 |
| `packages/app/src/shared/` | renderer 与主进程共享的纯函数模型、Local App API 路由和跨进程协议；稳定跨 package 契约仍归 `packages/types/`。 |

## 插件与核心边界

- 核心路径是 `Local App API -> Runner -> Harness -> tools/memory/session`；没有插件时也必须能够启动、对话、执行和恢复。
- `packages/plugins/` 提供插件生命周期和受控贡献接口。当前 API v1 已接通 `channel`、`tool` 与声明式 `skill`；插件 Skill 由 PluginHost 管理启停和迁移，SkillLoader/记忆注册表只消费真实拥有者状态。
- `packages/channels/*` 是具体的可选渠道插件；它们只有在配置中启用对应渠道时才会动态加载，不参与本地 UI 的启动条件。
- 用户插件放在用户数据目录的 `plugins/` 下，插件自己的持久化数据放在 `plugin-data/<plugin-id>/`；两者都不进入源码仓库。
- `provider`、`memory`、`workspace`、`automation`、`ui` 等未来扩展不能仅靠 manifest 枚举就算完成。必须先定义生命周期、权限、持久化、错误隔离和 UI/Runner 消费方，再升级插件 API。

## 模块依赖方向

模块分层和长期责任以 [架构原则](architecture-principles.md) 为准。当前代码和后续重构统一遵守以下依赖规则：

```text
App / CLI / Channel adapters
          -> Runner application service
          -> Harness and domain services
          -> public ports in @littlesheep/types
          <- infrastructure implementations
```

1. `packages/types/` 只定义公共契约，不依赖 Electron、文件系统、数据库、渠道或具体 Provider。
2. `packages/harness/` 控制流程并依赖端口，不 import App、CLI、具体渠道或插件内部实现。
3. `packages/runner/` 是核心 run 的应用服务和装配入口；它可以组合基础设施，但不应继续吸收 Context、Memory、Tools 的内部算法。
4. `packages/app/` 是产品组合根和 adapter。Renderer 只能通过 Local App API 使用主进程能力，不能直接读写用户数据存储。
5. `packages/channels/*` 只能依赖插件/渠道公开契约，不依赖 App 或 Harness 私有文件。
6. 插件贡献必须通过 `packages/plugins/` 的版本化 Host 接入；插件工具仍走统一权限和执行记录，插件 Skill 不得绕过 PluginHost 直接写入可调用索引或伪造资源状态。
7. 跨包只从公开入口导入；出现反向依赖时先定义端口，不通过深层 import 或循环依赖解决。
8. 新建 package 需要同时满足独立职责、稳定接口、独立测试和真实复用；否则先在现有 package 内按 feature 拆分。

Context 已收敛出独立包并接通来源分段、版本化摘要、附件清单优先、按需附件工具、压缩阈值设置和双账本展示。provider/model tokenizer 能力矩阵已经建立，并强制模型声明与运行时 `counterId` 一致后才能生成精确账本；unavailable 模型也已接入与真实 ledger 类型隔离、不可展示的保守请求前预算保护，当前仍缺真实 Provider 对账。Memory Service 已接管首批消费者并统一注册 Summary Memory、run-scoped 附件、运行时事件账本端口和项目记忆三层投影；App 层已经补齐稳定项目身份和可恢复路径重绑定。当前仍缺其他资源的完整治理，实时事件队列、Mode 与 Tool Execution 也仍有职责分散。不能因为已有 package 或接口就宣称完成模块化，具体评估和演进顺序见 [架构决策报告](architecture-decision-report.md)。

## 测试与脚本

- 包内 `src/**/*.test.ts(x)`：测试包内契约和模块行为，应与源码同目录维护。
- `test/core-agent-contracts.test.ts`：跨包核心 Agent 契约。
- `test/e2e-cli.test.ts`、`test/e2e-webhook.test.ts`：跨包 CLI/渠道流程。
- `scripts/check-repository-hygiene.mjs`：仓库结构质量门，不参与运行时；同时检查正式文档、生成物、旧渠道命名、workspace 清单和源码包依赖方向。
- `scripts/verify-app-recovery-sources.mjs`：只读检查用户数据中的工作区、会话、执行日志和恢复索引。
- `scripts/verify-provider-smoke.mjs`：使用本机安全存储中的凭证执行脱敏 Provider 冒烟，覆盖最小聊天、reasoning、工具调用、流式中断和 usage 对账；不得输出或写入明文密钥。
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

- 默认位置由 `@littlesheep/branding` 和应用运行时解析为 `<user-data>`；正式文档不固化真实用户绝对路径。
- 解析优先级为 `LITTLESHEEP_DATA_DIR`、外部 locator、branding 默认目录。locator 默认位于用户主目录，保持在数据根之外，记录活动目录、待迁移/回滚事务和最近一次迁移清单。
- 包括 API 配置、加密密钥引用、sessions、memory-tree、projects、archive、execution logs、workspace layout、terminal activity、`attachment-cache/`、`workspace/resource-indexes/` 和用户工作区。
- `attachment-cache/` 只保存 LS 通过粘贴/浏览器导入创建并登记的临时附件；自动清理只能处理索引中仍通过路径、普通文件、大小和哈希验证的缓存项。`workplace/`、项目目录和外部路径是不同所有权边界，不能因为文件名或目录名相似而由缓存清理删除。
- `workspace/resource-indexes/` 只保存各工作区的相对路径、文件类型、大小、修改时间和 `user/agent` 来源；它不保存正文，扫描有目录、深度、条目和待处理队列上限。索引文件属于 LS 受管运行数据，项目索引以稳定 project id 关联。
- 数据根迁移只在应用启动、Runner/Local App API/插件宿主和其他写入者创建之前执行。目标必须不存在或为空；源目录保留，符号链接与 junction 不复制，内部活动元数据只重绑定原本位于旧数据根中的绝对路径，外部项目和用户文件路径保持不变。
- 仓库治理、构建和测试不得迁移、格式化、删除或重写该目录。需要数据治理时必须先做只读诊断，并单独获得用户授权。

## 后续修改规则

1. 先根据 [架构原则](architecture-principles.md) 和本指南确认责任与模块归属；不要把运行时逻辑塞进 renderer，也不要让外部渠道成为本地核心依赖。
2. 新增模块优先放入已有包；只有边界、生命周期和测试都清晰时才创建新包，并同步 workspace、入口、文档和测试。
3. 修改公共类型或事件协议时，同时检查 `types`、生产者、消费者、持久化、renderer 恢复和相关测试。
4. 删除模块前先搜索 import、导出、文档链接、脚本和用户数据兼容代码；删除后运行 `check:repo`、测试、typecheck 和 build。
5. 文档只保留当前事实。阶段完成后更新 [project-status.md](project-status.md)，不要继续追加一次性历史报告。
6. UI 变更遵守 [ui-interaction-guidelines.md](ui-interaction-guidelines.md)；核心流程变更遵守 [core-agent-flow-guidelines.md](core-agent-flow-guidelines.md)；跨模块重构同步更新 [架构决策报告](architecture-decision-report.md)。
7. 每次应用构建都通过 `scripts/build-app.ps1` 或根 `build-app.bat` 刷新快捷方式；不得把机器绝对路径写进脚本。
8. 插件变更必须同时验证 manifest 校验、未启用插件不加载、失败隔离、Runner 重建迁移和停用清理；本地代码默认不信任。
9. 验证顺序固定为：`pnpm.cmd run check:repo`、`pnpm.cmd test`、`pnpm.cmd run typecheck`、`pnpm.cmd run build`、`pnpm.cmd run verify:app-recovery`。失败时记录真实原因，不用旧数字覆盖。
10. 说明文档默认使用中文；代码标识、协议字段、命令、路径和供应商产品名保留英文。确有维护价值的英文内容只能作为补充版本，不能取代中文正式文档。
