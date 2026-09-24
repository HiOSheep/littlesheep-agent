# LittleSheep 仓库指南

最后更新：2026-09-24 20:56:17

本文件说明源码仓库的边界和模块归属。它不描述用户运行时数据的具体内容，也不替代能力进度记录；进度以 [project-status.md](../decision/project-status.md) 为准。

## 正式文档层级

正式文档采用渐进式披露，阅读入口固定为 [文档决策入口](../README.md)。根 README 只引导进入该入口，不再平铺全部文档。

| 层级 | 目录 | 何时阅读 | 文档职责 |
| --- | --- | --- | --- |
| L0 决策入口 | `docs/README.md` | 每次准备决定下一步时 | 只显示当前阶段、推荐动作和此刻需要用户决定的事项 |
| L1 当前依据 | `docs/decision/` | 需要核实现状或理解推荐顺序时 | [项目状态](../decision/project-status.md) 维护当前事实与验证；[架构决策报告](../decision/architecture-decision-report.md) 维护演进顺序与风险 |
| L2 稳定原则 | `docs/principles/` | 修改产品方向、流程或交互规则时 | [架构原则](../principles/architecture-principles.md)、[核心流程规范](../principles/core-agent-flow-guidelines.md) 和 [UI 交互规范](../principles/ui-interaction-guidelines.md) |
| L3 执行细节 | `docs/taskbooks/` | 方向已确定并准备实施具体阶段时 | 版本化任务书、阶段验收标准和历史完成证据 |
| L4 工程参考 | `docs/reference/` | 定位代码、维护仓库或开发插件时 | 本指南、[模块拆分地图](module-split-map.md)、[Core Flow 状态契约](core-flow-state-contract.md)、[插件开发说明](plugin-development.md) 和 [自定义模型供应商](custom-model-providers.md)；`docs/paper/` 的论文材料见[论文材料入口](../paper/README.md) |

同一事实只在其责任文档中维护，其他文档使用链接引用。冲突时，长期约束看架构原则，当前事实和验证数字看项目状态，演进顺序看架构决策报告，目录归属看本指南，专项交互和流程看对应规范。任务书不维护全局最新状态，也不要创建另一份一次性总结复制决策入口。

任务书属于版本化执行基线，文件名使用 `*-taskbook-YYYY-MM-DD.md`，一级标题保留同一基线日期；文件名和标题不加入时分秒。所有正式文档正文统一使用 `最后更新：YYYY-MM-DD HH:mm:ss` 记录精确维护时间。对既有任务书做状态校正、证据补充或小范围维护时保持文件名和标题不变；只有建立新的执行基线版本时才创建新日期文件并更新全仓链接。不使用 `latest`、`final` 或无日期文件名表达当前版本。

**任务书有生命周期：完成后不再留在仓库里。** 任务书是执行期的工作文档，不是长期事实来源。一份任务书的工作完成时按顺序做两件事：

1. **先汇总事实**：把其中仍然成立的内容（当前行为、契约、边界、已核验的数字）写进拥有该事实的常驻文档——当前事实进[项目状态](../decision/project-status.md)，演进顺序与取舍进[架构决策报告](../decision/architecture-decision-report.md)，长期约束进[架构原则](../principles/architecture-principles.md)，流程与状态契约进[核心流程规范](../principles/core-agent-flow-guidelines.md) 与 [Core Flow 状态契约](core-flow-state-contract.md)，代码归属进本指南与[模块拆分地图](module-split-map.md)。逐条确认没有常驻文档缺失该事实后，才进入下一步。
2. **再取消追踪**：`git rm <file>`（同时删除工作区文件），并从[文档决策入口](../README.md)的任务书清单里删除对应条目。文件内容仍完整保留在 git 历史中（`git log --follow -- <path>` 可取回原始文本），所以这一步不丢证据，只防止仓库文档持续膨胀。

未完成的任务书继续跟踪，并在入口的"当前主线"里列出。已完成但尚未汇总事实的任务书**不得**直接删除；入口的"已完成基线/专项与历史执行基线"分组只用于尚未走完这两步的过渡期，不应长期存在。仓库自检对 `docs/taskbooks/` 下的跟踪文件数量设有预算，超预算时必须在退役已完成任务书与新增任务书之间做取舍，而不是继续累加。

**package / 领域 README 是随代码一起维护的所有权说明。** 每个 workspace package（`packages/*`、`packages/channels/*`）和每个领域目录（例如 `packages/app/src/main`、`packages/app/src/renderer/chat`、`packages/harness/src/stages/execute`）都有自己的 `README.md`，内容是**当前**职责、入口、边界、依赖方向和验证方式。规则：

1. 改动某个 package 或领域的行为、公开入口、所有权边界、依赖或验证方式时，必须**在同一次改动里**更新对应 README；只改代码不改 README 视为未完成。
2. README 首行标题下必须有 `最后更新：YYYY-MM-DD HH:mm:ss`（取自系统时钟，见下条）。它的作用不是装饰，而是让"这次改动是否同步了文档"在评审时可见。
3. `node scripts/check-repository-hygiene.mjs`（= `pnpm check:repo`）用两条检查保证这条规则，改代码时按它们自检：
   - **package README 带秒级最后更新**：`packages/` 下每个 README 都必须有秒级时间行，缺失即失败。
   - **package README 与源码同步更新**：比较 `git log -1` 的提交时间——若某个目录里除 README 外的已提交文件晚于该目录 README，就判为"改代码没改文档"。它只看已提交历史，工作区未提交的编辑既不会触发也不会免除失败；把 README 和源码放进**同一次提交**即可通过（同一提交里两者时间相同）。
4. README 只写职责与边界，不复制测试数字、不写分轮进展、不重复其他文档的结论（冲突时按本条上方的责任划分处理）。

**时间必须取自系统时钟，不得估算**：`最后更新` 与状态记录里的日期时间一律从系统时钟读取（本仓为 UTC+08:00 北京时间），不使用模型推测或手写的近似值。写入正文条目的时间应与引入该条目的提交时间一致，可用 `git log --date=format:"%Y-%m-%d %H:%M:%S"` 核对；估算时间会让“谁先谁后”的判断失真，并让读者无法把文档与提交对应起来。

## 根目录

| 路径 | 用途 |
| --- | --- |
| `docs/` | 正式文档唯一入口和分层目录。先读 `docs/README.md`，再按需进入 `decision/`、`principles/`、`taskbooks/` 或 `reference/`。 |
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
| `package.json` | workspace 根脚本、测试入口、类型检查、构建和仓库卫生检查；`build:app` 是不含根 workspace typecheck 的 App-only 构建入口，`build` 保持完整构建语义。`ensure:app-build` 会在 App fingerprint 新鲜时复用产物，`assert:app-build` 只断言并在缺失或过期时失败；`ensure:workspace-build`/`assert:workspace-build` 对指定包及其依赖闭包的 `dist` 使用独立 sidecar。 |
| `pnpm-workspace.yaml` | 声明 `packages/*` 与 `packages/channels/*` 两组 workspace。 |
| `pnpm-lock.yaml` | 依赖锁定文件；只有依赖变更时由 pnpm 更新。 |
| `tsconfig.base.json`、`tsconfig.workspace.json`、`vitest.config.ts` | 全仓 TypeScript 基线、自动生成的 project references solution 与 Vitest 基线。`tsconfig.workspace.json` 由维护脚本生成，不手工编辑。Vitest 保留单项 30 秒超时，并把文件并发限制为 3；历史完整测试曾在 258 个测试文件上验证该并发上限，当前测试文件数量和结果以实际命令输出为准。 |
| `branding.config.json`、`littlesheep.config.json` | 仓库级品牌/开发配置样例，不放用户密钥。 |
| `README.md` | 面向开发者的入口说明和质量检查。 |
| `build-app.bat`、`start-littlesheep.bat` | Windows 兼容入口，实际逻辑委托给 `scripts/`。 |
| `.gitignore`、`.editorconfig` | 版本边界和编辑格式规范。 |

## 本地私有材料

- 个人档案、本地操作指令、长期记忆、评审材料和临时研究笔记可以留在开发机上，但不得被 Git 跟踪。
- 这类文件使用本地 `.git/info/exclude` 排除，不把机器或个人特定规则写入公开 `.gitignore`。
- 应用运行时在数据根生成的用户说明和记忆文件与源码仓库完全分离；数据根内容、生成物与版本边界的完整口径见本指南“源码、生成物和用户数据边界”一节。

## Workspace 包清单

### Agent 核心

| 包 | 归属和职责 |
| --- | --- |
| `packages/types/` | Agent、消息、会话、工具、记忆、澄清请求，以及 Mode、运行决议、Context、附件、运行事件、TaskBookPatch、检查点、模型请求和执行证据等内部 v1 契约；`src/stage-transitions.ts` 是唯一 Core Flow 允许边 manifest，`src/run-context-contract.ts` 维护高频 RunContext 字段 owner、读写阶段和生命周期；本地精确、Provider 实测与不可展示安全估算的 Token 账本独立位于 `src/token-ledger.ts`。 |
| `packages/classifier/` | 确定性的活动路由规则：所有常规会话与任务回合都进入主循环（`execute`），只有能力/状态询问（`capability_question` / `capability_probe`）走最小 Runtime 事实契约的 `reply`；规则只决定这一轮的读法并保留在 `type` / `reasonCode`，不消耗模型请求。旧 `chat / problem / unclear`、`respond` 和 `classify` 只由公共契约与旧检查点做兼容映射。 |
| `packages/prompt/` | 系统提示词、行为 profile、工作区信息和记忆树根索引的装配；支持完整执行、紧凑 `respond`、最小与禁用四种投影模式。 |
| `packages/harness/` | 核心 Agent Runtime、只读 TaskBook 历史、各 stage、hooks、局部重规划和结构验证；Stage 边由 `@littlesheep/types` 的 `allowedTransitions` 统一校验，导航说明见 [Core Flow 状态契约](core-flow-state-contract.md)。`src/default-harness.ts` 装配唯一的主循环驱动（DECIDE、EVOLVE、CAPTURE 已不是注册 stage），`src/stages/execute/tool-loop.ts` 拥有普通工具循环，`execute/prompt.ts` 装配固定工具目录与缓存边界以下的有界尾部，`execute/` 与 `verify/` 其余模块负责步骤调度和结构验收；`runtime-state.ts` 统一校验并批次提交 runtimeControl 组的 RunContext 顶层写入，`explicit-tool-instruction.ts` 解析用户点名工具的有界 schema 集合，`runtime-control-boundary.ts` 和 `taskbook-patch.ts` 拥有运行中事件的安全消费与确定性局部修订。`checkpoint-resume.ts` 负责依据已保存步骤证据恢复，`response-continuity*.ts` 负责从最终用户可见回答反查真实因果 Context 来源并判定记忆连续，`stages/reply/continuity-repair.ts` 只负责直接续答在发布前的一次有界实时纠偏，`session-summary-fidelity-text.ts` 只解析 Runtime 精确字段封套。步骤在主循环内串行执行：已持久化的 TaskBook 只作为可读历史，不触发第二个执行器；本回合无权使用的工具在执行边界被拒绝，而不是从固定工具目录中移除。 |
| `packages/runner/` | 运行时装配、单次 run、流式事件、执行日志、活动 run 事件注册与有界状态快照、暂停/继续/中断、持久检查点、显式续跑和基础设施依赖注入；`session-continuity.ts` 负责版本化会话压缩调用，`session-summary-fidelity.ts` 从保留的用户消息和旧封套重建有界精确字段。 |
| `packages/llm/` | OpenAI-compatible 客户端、供应商请求、流式输出、重试和 usage 类型。 |
| `packages/config/` | 配置 schema、默认值、供应商预置、模型选择和用户配置加载；`tools.invocationTimeoutMs` 统一约束宿主工具调用超时，默认 120 秒，可配置 1 秒到 24 小时；实际调用仍同时受 run 总超时、AbortSignal 和取消后的有界清理约束。 |
| `packages/context/` | Context 候选排序、模型窗口预算、可注入精确 token 计数、预算淘汰、压缩阈值信号以及脱敏 `ContextSnapshot` / `ModelRequestSnapshot`。`src/engine.ts` 是兼容 facade，内部实现位于 `src/context-engine/`；模型专用 tokenizer 资源准备与最终请求 framing 位于 `src/tokenizers/`。本包不负责记忆存储、会话存储或 Provider 调用。 |
| `packages/branding/` | 品牌配置和用户数据目录布局。 |

`packages/harness/src/memory-state.ts` 是 Memory 顶层 `RunContext` 状态的统一写入边界：它覆盖 Runner bootstrap/restore、KnownState、working set、FINALIZE 和 memory intent audit 的批次校验与提交。该入口不代理 `packages/memory-tree/` 的 Repository/Service 持久化事务。`packages/harness/src/usage-state.ts` 只负责顶层 `RunContext.usage` 快照的 stage 校验和 provider usage 规范化；请求级 usage 仍由 `model-observability.ts` 绑定到 context snapshot。

### 记忆、学习与安全

| 包 | 归属和职责 |
| --- | --- |
| `packages/memory-tree/` | `MemoryService` 与 `MemoryRepository` 稳定公共接口、T0-T3 资源注册、索引导航、项目投影和生命周期；`src/task-query.ts` 与 `task-relevance.ts` 拥有有界多轮任务语义、版本化会话摘要回退和当前任务匹配；`src/memory-tree.ts` 负责 D1 准入、最强相关簇和 run working set；`src/memory-repository/` 拥有 v2/v3 后端、选择校验、事务账本、认识状态分类、节点/资源适配，以及独立的 v2→v3 snapshot/build/validation/commit、请求登记、恢复和受约束回滚模块；`src/v3/` 拥有 atom、journal、SQLite catalog、FTS/向量、有界维护和实体关系权威文件。v3 已接管正式用户数据；v2 与 snapshot 保留为兼容和受约束回滚来源。 |
| `packages/embedding/` | Memory v3 的本地 Transformers.js Embedding 实现、固定 revision 模型登记、显式资产准备、大小/SHA-256 校验、离线加载和候选基准；不拥有记忆正文、Catalog 或 Provider 请求。 |
| `packages/memory-core/` | 文件记忆兼容读取与受限维护基元：daily、长期记忆、旧来源适配和写入策略校验；它不是运行时持久记忆的写入方（唯一写入方是会话压缩路径）。 |
| `packages/vector/` | 向量存储接口；只在已导航分支的深搜兜底路径使用。 |
| `packages/experience/` | 经验记录、置信度衰减和可复用能力数据。 |
| `packages/snapshot/` | 记忆快照、索引和回滚支持。 |
| `packages/safety/` | 记忆/提示注入防护、清洗、隔离、安全存储，以及 LS 逻辑容器的路径边界、Shell 保守判定和权限策略基元。 |
| `packages/session/` | JSONL 会话管理、锁、持久化回复指纹注册表和长会话压缩入口。 |

### 工具与扩展

| 包 | 归属和职责 |
| --- | --- |
| `packages/tools/` | 内置工具、注册表和统一 Tool Execution Service；统一拥有工具来源、输入 schema、权限与单次批准、超时/中断、调用级资源调度、结果清洗、流式事件和有界调用记录。超时或中断后只等待 1.5 秒有界清理；内置 `exec` 对 stdout/stderr 分别保留最多 64 KiB 首尾内容，记录原始/保留长度、截断和进程关闭证据，并在 Windows 关闭进程树。容器边界与核心源码只读仍由宿主权限判定和工具动作前二次复核共同保护；Harness 只保留 TaskBook 编排及副作用检查点生命周期。 |
| `packages/plugins/` | 插件 API v1、插件发现、信任校验、生命周期宿主，以及渠道、工具和 owner-scoped Skill 贡献。它是扩展运行时，不是 Agent 任务核心。 |
| `packages/skills/` | 技能索引加载与 `use_skill` 使用；自动创建技能已随极简方案删除，技能只由用户或技能来源提供。 |
| `packages/web/` | provider 无关的网络检索领域包：SearchProvider 契约与 registry、受控匿名 HTTP 抓取（scheme、DNS/IP、重定向、响应/解压大小、超时和取消校验）、citation 生成、网页正文的 `external_untrusted` 标记和有界进程内缓存；不拥有 Agent 权限判定、记忆写入或渠道协议。只依赖 `@littlesheep/types` 与 Node 内建模块，**没有第三方 HTTP 客户端或 HTML 抽取依赖**；引入这类依赖必须重做许可证、漏洞与 SSRF 审查。 |
| `packages/documents/` | 共享文档处理内核：PDF、DOCX、XLS/XLSX、CSV/TSV 与 PPTX 的有界读取，以及 PDF、DOCX、XLSX 和 CSV 产物的生成与重新校验；不处理 Agent 权限，调用方必须先完成路径校验与授权检查。 |
| `packages/cli/` | 命令行入口、参数解析、REPL 和管理命令。 |

MCP 客户端当前尚未实现，也不保留空 workspace 包；未来实现必须从稳定 adapter 开始，并复用 `packages/tools/` 的统一执行服务。

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
| Agent 状态机、活动路由、TaskBook 只读历史、工具循环、结构验证、恢复或回答级记忆连续性 | `packages/harness/`、`packages/classifier/` | `harness/src/default-harness.ts`、`explicit-tool-instruction.ts`、`checkpoint-resume.ts`、`response-continuity*.ts`、`session-summary-fidelity-text.ts`、`src/stages/reply.ts`、`src/stages/reply/continuity-repair.ts`、`runtime-control-boundary.ts`、`taskbook-patch.ts`、`replan-state.ts`、`reply-state.ts`、`memory-state.ts`；语义路由规则位于 `classifier/src/rules.ts` | `harness/src/default-harness.test.ts`、`response-continuity.test.ts`、`session-summary-fidelity-text.test.ts`、`continuation-intent.test.ts`、`src/stages/reply.test.ts`、`replan-state.test.ts`、`reply-state.test.ts`、`memory-state.test.ts`、其余 `src/stages/*.test.ts`、`runtime-control-boundary.test.ts`、`taskbook-patch.test.ts`、`classifier/src/*.test.ts` |
| 单次 run、流式事件、执行日志、上一轮有界摘要与活动续跑 | `packages/runner/` | `src/runner.ts`、`src/runner-coordinator.ts`、`src/runner-execute.ts`、`src/runner-finalize.ts`、`src/runner-persist.ts`、`src/execution-log.ts`、`src/session-run-summary.ts`、`src/session-continuity.ts`、`src/session-summary-fidelity.ts`、`src/runtime-event-queue.ts`、`src/active-run-registry.ts`、`src/active-run-activity.ts`、`src/run-abort-control.ts`、`src/run-checkpoint-*.ts` | `src/runner.test.ts`、`src/runner-coordinator.test.ts`、`src/execution-log.test.ts`、`src/session-summary-fidelity.test.ts`、`src/runtime-event-queue.test.ts`、`src/active-run-registry.test.ts`、`src/runner-continuation.test.ts`、`src/run-checkpoint-*.test.ts` |
| 公共运行契约 | `packages/types/` | `src/index.ts`、`src/runtime-contracts.ts`、`src/token-ledger.ts` | `src/runtime-contracts.test.ts`、`test/core-agent-contracts.test.ts` |
| Context 候选、预算、计数和快照 | `packages/context/` | `src/engine.ts` facade、`src/context-engine/`、`src/tokenizers/deepseek-v4-{encoding,counter}.ts` | `src/engine.test.ts`、`src/tokenizers/*.test.ts`、Harness Context/观测测试 |
| Provider 请求、流式与 usage | `packages/llm/` | `src/client.ts` | `src/client.test.ts`、Provider smoke 脚本 |
| 配置、Provider/模型能力 | `packages/config/` | `src/schema.ts`、`src/model-capabilities.ts` | `src/schema.test.ts`、App shared capability 测试 |
| Prompt 与行为 profile | `packages/prompt/` | `src/builder.ts`、`src/profiles.ts` | `src/builder.test.ts`、`src/profiles.test.ts` |
| 记忆树、资源注册与项目投影 | `packages/memory-tree/` | 稳定 facade：`src/memory-service.ts`、`src/memory-repository.ts`；对话原始来源：`src/conversation-source-store.ts`；run 反馈：`src/memory-feedback.ts`、`src/memory-repository/v3-feedback-manager.ts`；run working set：`src/memory-tree-working-set.ts`；多轮任务语义、当前任务相关度与 prime 选择：`src/task-query.ts`、`src/task-relevance.ts`、`src/memory-prime-relevance.ts`；D1/深搜候选：`src/memory-repository/v3-retrieval.ts`、`v3-retrieval-materializer.ts`；Catalog FTS/向量：`src/v3/catalog-fts.ts`、`catalog-embedding.ts`；路由/关系相关性：`src/v3/priority.ts`、`src/v3/catalog-relevance.ts`；版本后端：`src/memory-repository/v2-backend.ts`、`v3-backend.ts`、`factory.ts`；安全迁移：`repository-locator.ts`、`v3-migration*.ts`；v3 投影变更与 Atom：`src/v3/raw-record-store.ts`、`raw-record-file.ts`、`raw-record-commit-store.ts`（兼容内部命名，语义为 projection mutation records）、`atom-store.ts`、`catalog.ts`、`graph-store.ts`、`storage-coordinator.ts` | 双后端契约：`src/memory-repository.contract.test.ts`；来源与反馈：`src/conversation-source-store.test.ts`、`src/memory-feedback.test.ts`；任务语义、相关性与 D1：`src/task-query.test.ts`、`src/task-relevance.test.ts`、`src/memory-prime-relevance.test.ts`、`src/memory-tree.test.ts`、`src/memory-service-v3.test.ts`、`src/v3/catalog.test.ts`、`src/v3/contracts-priority.test.ts`、`src/memory-repository/v3-backend.test.ts`；迁移：`src/memory-repository/v3-migration.test.ts`；v3：`src/memory-repository/v3-*.test.ts`、`src/v3/*.test.ts`；Runner：`packages/runner/src/memory-v3.integration.test.ts`；KnownState 摄入：`packages/harness/src/memory-known-state.ts`、`packages/harness/src/stages/execute/tool-loop.ts` |
| 旧文件记忆兼容读取与安全写入基元 | `packages/memory-core/` | `src/store.ts`、`src/search.ts`、`src/write-memory.ts` | 对应同名测试；旧 archive/vector 写入入口已退役，运行时持久记忆仍只经会话压缩路径写入 |
| 会话、回复 settlement 幂等和长会话摘要 | `packages/session/` | `src/manager.ts`、`src/reply-fingerprint-store.ts`、`src/compaction.ts`、`src/compaction-store.ts` | 对应同名测试；原始 JSONL 不删除、不改写。回复闸门只约束 settlement 身份（同一身份幂等、不同身份允许相同措辞），文本指纹账本用于审计与旧入口。摘要生成与精确字段保真还需联查 `packages/runner/src/session-continuity.ts`、`session-summary-fidelity.ts`，摘要进入 Memory v3 的边界联查 `packages/memory-tree/src/task-query.ts` |
| 工具注册、统一执行、审批、超时清理和内置工具 | `packages/tools/` | `src/registry.ts`、`src/tool-execution-service.ts`、`src/tool-execution-{scheduler,control,records,result}.ts`、`src/builtin/exec.ts`、其余 `src/builtin/` | `src/tool-execution-service.test.ts`、`src/builtin/exec.test.ts`、`src/builtin/document-tools.test.ts`、其余 `src/**/*.test.ts` |
| 网络检索、抓取安全与 citation | `packages/web/` | `src/provider.ts`、`src/provider-registry.ts`、`src/runtime.ts`、`src/fetch/{service,url-policy,dns-resolver,http-client,extract}.ts`、`src/providers/tavily.ts`、`src/cache/web-cache.ts` | `src/**/*.test.ts`、`scripts/verify-web-*.mjs` |
| 文档读取、生成与产物校验 | `packages/documents/` | `src/read.ts`、`src/read-pdf.ts`、`src/read-office.ts`、`src/write.ts`、`src/write-pdf.ts`、`src/write-docx.ts`、`src/write-spreadsheet.ts`、`src/verify.ts`、`src/limits.ts` | `src/documents.test.ts`、`src/office-preview.test.ts`、`src/xlsx-security-regression.test.ts` |
| 插件发现、信任和生命周期 | `packages/plugins/` | `src/host.ts`、`src/manifest.ts` | `src/**/*.test.ts` |
| 外部渠道协议 | `packages/channels/*` | 各包 `src/plugin.ts` | 各包 `src/plugin.test.ts`、`test/e2e-webhook.test.ts` |
| Electron 启动、Local App API、验收采样和用户数据 adapter | `packages/app/src/main/` | `index.ts`、`local-app-api-server.ts`、`desktop-acceptance-snapshot.ts` | `src/main/*.test.ts`、`scripts/verify-electron-*.mjs` |
| 窗口、托盘、关闭策略与活动任务控制 | `packages/app/src/main/`、`packages/app/src/renderer/settings/`、`packages/runner/` | `desktop-shell.ts`、`tray-controller.ts`、`close-policy.ts`、`run-activity-monitor.ts`、`desktop-acceptance-snapshot.ts`、`local-app-api/application-lifecycle-routes.ts`、`renderer/settings/application-background*.ts(x)`、`runner/src/active-run-*.ts` | `close-policy.test.ts`、`run-activity-monitor.test.ts`、`desktop-acceptance-api.test.ts`、`application-lifecycle-api.test.ts`、`renderer/api/application-lifecycle.test.ts`、`renderer/settings/application-background-state.test.ts`、`runner/src/active-run-registry.test.ts`、`scripts/verify-electron-deepseek-parallel-load.mjs` |
| LS 开发环境、工具链版本和终端环境 | `packages/app/src/main/`、`packages/app/src/renderer/settings/` | `development-environments.ts`、`development-environment-definitions.ts`、`development-environment-files.ts`、`local-app-api/development-environment-routes.ts`、`settings/development-environments.tsx` | `development-environments.test.ts`、`development-environment-api.test.ts` |
| 桌面 UI、导航、设置和工作区 | `packages/app/src/renderer/` | `App.tsx`、`app-shell/`、各 Renderer 领域目录、`api/` | `src/renderer/*.test.ts(x)`、领域同目录测试与真实窗口验收 |
| CLI 与管理命令 | `packages/cli/` | `src/bin.ts`、`src/commands/` | `src/**/*.test.ts`、`test/e2e-cli.test.ts` |

当前大型文件的拆分所有权和顺序见 [模块拆分地图](module-split-map.md)。

## Electron 应用

`packages/app/` 是本地桌面产品。Local App API 是 renderer 与主进程之间的本地桥接，不属于外部渠道插件。

| 路径 | 重要模块 |
| --- | --- |
| `packages/app/src/main/index.ts` | Electron 主进程启动、用户数据初始化及 Runner/PluginHost/桌面壳装配；不再直接拥有窗口、托盘或关闭策略实现。 |
| `packages/app/src/main/desktop-shell.ts`、`tray-controller.ts`、`close-policy.ts` | 主窗口创建与显示、托盘任务菜单、三档关闭策略，以及托盘不可用时禁止隐藏的默认拒绝边界。 |
| `packages/app/src/main/run-activity-monitor.ts` | 聚合当前与有界退役 Runner 的活动任务，去重快照、路由暂停/继续/中断，并限制来源、监听器和聚合项数量。 |
| `packages/app/src/main/builtin-plugins.ts` | 内置插件目录；具体渠道实现仍通过动态 import 按需加载。 |
| `packages/app/src/main/local-app-api-server.ts` | renderer 与主进程之间的 loopback Local App API 组合入口和生命周期。 |
| `packages/app/src/main/local-app-api/` | Local App API 的 HTTP 基元、公共契约及 run、应用生命周期、项目、会话、Runtime、记忆、工作区、终端和扩展领域路由；`http.ts` 统一拥有 SSE 响应头、15 秒注释心跳、512 KiB 单连接待写上限和幂等清理。普通 Agent run 与 Checkpoint 续跑的观察连接断开不取消 Main 任务，终端主动命令仍保留断连取消。活动任务快照、`active_runs` SSE 与控制位于 `application-lifecycle-routes.ts`，组合入口位于 `run-lifecycle-routes.ts`，atom 高级管理与证据导出位于 `memory-atom-routes.ts`。 |
| `packages/app/src/main/run-policy.ts`、`local-app-api/terminal-permission.ts` | Main 侧 Agent 权限策略决议、逻辑容器边界复核和受控终端命令审批；用户交互终端固定使用 `workspace-user` 来源直接操作，Agent 命令固定使用 `agent` 来源，Renderer 不能改写来源或替代 Main 判定。 |
| `packages/app/src/main/attachment-cache.ts`、`attachments.ts` | LS 受管附件缓存的稳定索引、配额/过期清理、安全删除校验，以及 run-scoped 附件解析与所有权分类。 |
| `packages/app/src/main/data-root-migration.ts`、`data-root-metadata.ts` | 数据根 locator、迁移事务、同级 staging、流式哈希清单、启动前恢复、活动元数据内部路径重绑定和回滚；正式用户数据不得用于故障注入。 |
| `packages/app/src/main/development-environment-definitions.ts` | 可管理开发环境的稳定 ID、中文标签、检测命令、可执行文件候选和分类；新增环境先在这里登记。 |
| `packages/app/src/main/development-environment-files.ts` | 工具链偏好读取、版本规范化/系列匹配、目录扫描、可执行文件检测、符号链接拒绝、导入校验和安全路径辅助；不负责 UI 或终端会话。 |
| `packages/app/src/main/development-environments.ts` | LS 工具链管理 facade：偏好串行写入、检测快照、导入/移除事务、Electron Node shim 和终端派生环境。 |
| `packages/app/src/main/local-app-api/development-environment-routes.ts` | 开发环境状态、偏好、导入和移除的 Local App API 路由；Renderer 不直接访问工具链目录。 |
| `packages/app/src/main/keychain.ts` | API key 的 Electron 安全存储与环境注入。 |
| `packages/app/src/main/session-index.ts`、`project-index.ts`、`archive-index.ts` | UI 侧会话、稳定项目身份和归档元数据索引。 |
| `packages/app/src/main/project-rebinding.ts`、`path-rebinding.ts` | 项目移动/重命名后的持久化重绑定事务、恢复日志和跨索引路径重映射。 |
| `packages/app/src/main/memory-files.ts`、`local-app-api/memory-routes.ts` | 用户记忆文件视图的允许列表、读取上限和“仅 `SOUL.md` 可写”边界；Renderer 不能直接访问数据根。 |
| `packages/app/src/main/memory-tree-control.ts`、`memory-atom-control.ts` | Runtime/内部维护使用的记忆树与 Atom 控制面；通过 `MemoryService` 读取节点、访问账本、资源注册表和审计，并通过 Repository management 执行受约束的移动、合并、失效、恢复和证据导出。普通 GUI 不调用这些 Atom 管理入口。 |
| `packages/app/src/main/memory-v3-bootstrap.ts`、`memory-v3-migration-control.ts` | Memory v3 迁移生命周期的应用边界：运行中只登记/取消请求，启动时在 Runner、Local App API 和插件写入者创建前执行迁移或回滚，并让配置服从 durable locator。 |
| `packages/app/src/main/workspace-*.ts` | 工作区布局、产物、文件路由、终端和 shell 适配。 |
| `packages/memory-tree/src/workspace-resource-index.ts`、`workspace-resource-scanner.ts` | 用户数据中的工作区资源元数据索引、游标式有界扫描、精确变更提示、重启恢复和按查询展开；不读取文件正文。 |
| `packages/app/src/main/shutdown-sequence.ts` | 应用退出时的有序关闭。 |
| `packages/app/src/preload/` | 安全的 context bridge，向 renderer 暴露必要运行时信息。 |
| `packages/app/src/renderer/App.tsx` | 7 行兼容入口，只组合 `app-shell` 控制器和顶层视图。 |
| `packages/app/src/renderer/app-shell/` | 顶层视图组合、全局导航历史、设置转场和跨领域兼容协调器。 |
| `packages/app/src/renderer/approval/`、`chat/`、`composer/`、`runtime/` | 审批展示、对话与流式 run 归并、输入栏和运行选项。 |
| `packages/app/src/renderer/settings/`、`sidebar/`、`ui/`、`workspace/` | 设置页、项目/会话导航、通用交互基元和拓展工作区。 |
| `packages/app/src/renderer/settings/development-environments.tsx` | 设置中的开发环境管理页：状态、目标版本、系列版本选择、导入、移除和错误/忙碌反馈。 |
| `packages/app/src/renderer/settings/application-background.tsx`、`active-run-row.tsx` | 设置中的关闭策略和活动任务管理页：通过 SSE 接收有界 Runtime 快照，提供暂停、继续、中断和渐进式运行详情；卸载时必须释放流、请求和重连计时器。 |
| `packages/app/src/renderer/TraceCard.tsx` | Agent 执行过程、TaskBook、工具调用和验证时间线。 |
| `packages/app/src/renderer/MemoryTreeView.tsx`、`ArchiveManager.tsx`、`settings/models.tsx` | 六份记忆文件的简洁视图、归档和模型供应商管理页；记忆页仅 `SOUL.md` 可编辑，不展示 Atom 内部结构；供应商页只经 Local App API 读写 Main 的配置与密钥库。 |
| `packages/app/src/renderer/chat/assistant-turn.tsx`、`Markdown.tsx`、`workspace/browser.tsx` | 思考摘要/执行过程/最终结果的渐进披露，以及链接单击内置预览、双击系统打开的全局交互。 |
| `packages/app/src/renderer/api.ts` | renderer 对 Local App API 的兼容导出入口；领域客户端位于 `packages/app/src/renderer/api/`。活动任务快照、SSE 订阅与控制客户端位于 `api/application-lifecycle.ts`，由设置页领域组件直接使用，不要求进入旧兼容 barrel。 |
| `packages/app/src/renderer/styles.css` | 当前深灰视觉系统、共享浮层/转场 token、折叠和工作区布局样式；后续按 feature 拆分时必须保留共享原语契约。 |
| `packages/app/src/shared/` | renderer 与主进程共享的纯函数模型、Local App API 路由和跨进程协议；稳定跨 package 契约仍归 `packages/types/`。 |

## 插件与核心边界

- 核心路径是 `Local App API -> Runner -> Harness -> tools/memory/session`；没有插件时也必须能够启动、对话、执行和恢复。
- `packages/plugins/` 提供插件生命周期和受控贡献接口。当前 API v1 已接通 `channel`、`tool` 与声明式 `skill`；插件 Skill 由 PluginHost 管理启停和迁移，SkillLoader/记忆注册表只消费真实拥有者状态。
- `packages/channels/*` 是具体的可选渠道插件；它们只有在配置中启用对应渠道时才会动态加载，不参与本地 UI 的启动条件。
- 用户插件放在用户数据目录的 `plugins/` 下，插件自己的持久化数据放在 `plugin-data/<plugin-id>/`；两者都不进入源码仓库。
- `provider`、`memory`、`workspace`、`automation`、`ui` 等未来扩展不能仅靠 manifest 枚举就算完成。必须先定义生命周期、权限、持久化、错误隔离和 UI/Runner 消费方，再升级插件 API。

## 模块依赖方向

模块分层和长期责任以 [架构原则](../principles/architecture-principles.md) 为准。当前代码和后续重构统一遵守以下依赖规则：

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

Context 已通过轻量 `ContextEngine` facade 接通来源分段、调用契约过滤、预算、淘汰、计数和双快照；provider/model tokenizer 能力矩阵强制模型声明、请求格式与运行时 `counterId` 一致后才能生成精确账本。DeepSeek V4 官方 tokenizer 与 Provider 校准后的请求 framing 位于 `packages/context/src/tokenizers/`；精确性按模型和请求形态记录：Flash 的普通请求与工具协议、Pro 的普通请求已通过逐请求对账，Pro 工具协议与 OpenAI/GLM 模型专用 tokenizer 仍需在实际启用形态下单独校准。Token 账本公共契约独立位于 `packages/types/src/token-ledger.ts`。Memory Repository 与 Memory Service 已分别把持久化和运行协调拆入同名领域目录；EXECUTE 与 VERIFY 也已把 Prompt 装配、工具循环、步骤调度和结构验收从 stage facade 中分离，其中 `stages/execute.ts` 只保留调度。工具目录在整个会话区间内固定：`stages/execute/prompt.ts` 渲染固定目录，检索意图只在缓存边界以下的有界尾部收窄本回合可执行的能力，实际调用仍由 Runtime 在执行边界复核权限、schema、路径、资源和副作用。TaskBook 与步骤执行公共契约位于 `packages/types/src/task.ts`，状态机与 RunContext 位于 `packages/types/src/agent.ts`。版本化 LLM Call Contract 位于 `packages/harness/src/llm-call-contracts/`；`classify`、`evolve`、`capture`、`recover`、`verify` 模板只为历史日志、重放投影和旧检查点解析保留，运行路径不再发起对应请求（`classify` 由确定性规则完成）。持久记忆的唯一写入方是会话压缩路径；`memory_tree` 只读（`root_index` / `branch_index` / `expand` / `deep_search` / `release`），模型没有记忆写入工具，压缩候选由 Runtime 提交或拒绝。运行时事件队列、活动 run ingress、安全边界、TaskBookPatch、统一工具超时与清理、持久检查点、Runner 显式续跑、Renderer 事件入口、应用启动恢复、活动任务 SSE、设置页后台控制、托盘和关闭策略已有独立模块。不能因为已有 package 或接口就宣称真实场景已经完成，具体评估和演进顺序见 [架构决策报告](../decision/architecture-decision-report.md)。

## 测试与脚本

- `pnpm.cmd run build`：完整构建入口，先执行全 workspace typecheck，再执行 App 构建；阶段验收使用它的完整语义，不用于每次小改动。
- `pnpm.cmd run build:app`：强制执行一次 App-only 构建，并写入 `packages/app/out/.littlesheep-build-fingerprint.json`；它不替代根 `build` 的全 workspace typecheck。
- `pnpm.cmd run ensure:app-build`：准备并校验 Electron 运行时；App 输入和 `out/**` fingerprint 新鲜时返回 `reused`，否则构建并原子写入 sidecar。`pnpm.cmd run assert:app-build` 只读断言，不会触发构建，过期、缺失、篡改或来源不明的 App 产物会 fail-closed。
- `pnpm.cmd run ensure:workspace-build -- --package=@littlesheep/runner`：构建或复用目标包及其传递 workspace 依赖闭包，并在各目标 `dist/` 写入独立 sidecar；`pnpm.cmd run assert:workspace-build -- --package=<name>` 只断言，不会构建。App `out` sidecar 证明桌面应用入口与 Electron runtime 契约；workspace `dist` sidecar 证明声明的源码/依赖闭包和本地产物，两者不能互相替代。
- `node scripts/run-verified-electron.mjs <script> [args...]`：在启动 Electron 专项脚本前只读断言 App fingerprint，并使用 sidecar 绑定且重新校验过的 prepared Electron 可执行文件；DeepSeek V4 tokenizer 和 Memory Provider 门通过此入口运行。
- `pnpm.cmd run verify:task -- --files=<path>`：不读取 `origin/main`，只按显式任务文件执行直接同名测试或必要的 related fallback，并对所属 package 做局部 typecheck；同目录存在 `<name>.test.*`/`<name>.spec.*` 时优先只运行它。Renderer 或 shared 输入会单独执行 App web typecheck。该入口不会读取其他脏文件，也不会传播到 dependents，因此完成后仍需运行 `verify:changed`。
- `pnpm.cmd run verify:task -- --package=<name>`：包级快速入口，默认只做该 package 的 typecheck；需要整包测试时显式加 `--package-tests`，因为 Runner 等包包含 30 秒以上的 Memory/Runner 集成套件。`--manifest=<path>` 可把文件、测试、typecheck 和 App web typecheck 边界固定为 JSON。
- `pnpm.cmd run verify:changed`：日常源码/测试改动的提交前门。默认以 `origin/main` 为基线，合并已提交、暂存、未暂存和未跟踪文件，计算变更 package 及其传递依赖方；一次 selector 计划同时驱动受影响 typecheck、Vitest 和必要的 `ensure:app-build`，避免重复计算。可用 `pnpm.cmd run verify:changed -- --base=<ref>` 或环境变量 `LITTLESHEEP_BASE_REF=<ref>` 指定基线；基线缺失时先获取基线或显式传入 ref，不能把缺失基线当作无变更。报告保存在被忽略的 `.codex_tmp/verification-reports/`，包含每阶段 `status`、`durationMs`、命令和输出摘要；`skipped` 只表示该阶段无适用输入，不等于通过。
- `pnpm.cmd run verify:core`：核心契约升级门，依次执行 `check:repo`、全 workspace typecheck 和 `test:core-eval`，适用于 Harness、Runner、Context、Memory、公共协议和跨包依赖变更；不执行 App build 或 recovery。测试数量与阶段耗时随源码变化，以 Vitest 实际输出和验证报告为准。
- `pnpm.cmd run verify:full`：阶段结束或发布前门，依次执行 `check:repo`、完整测试、一次全 workspace typecheck、`build:app` 和 `verify:app-recovery`；不包含 Provider、Electron continuity 或 Memory soak 专项门。失败时以报告中的 `failedStage` 为准，不用最终摘要掩盖前置阶段失败。
- `pnpm.cmd run verify:memory-v3-soak`：只在系统临时目录创建隔离 Memory v3 数据，重复验证只追加投影变更记录/commit receipt、atom 治理、journal 裁剪、重启、catalog 重建、向量有界批处理、关系相关性、routing feedback、run working set 和 RSS 上限；默认完成后删除临时根，不迁移或改写正式用户数据。增强档可使用 `--atoms=500 --runs=256 --feedback-events=256`，并可通过 `--related-atoms`、`--embedding-batch`、`--max-rss-mib` 调整验收边界。确定性测试 Embedding 只用于可重复规模门，不替代正式 BGE 或 Provider 验收。
- `pnpm.cmd run verify:memory-v3-relevance`：使用正式本地 BGE 和系统临时数据根，分开测量 D1 admission 与 branch-scoped deep search 的 Recall@K、负例、多余注入、scope 泄漏、token、query Embedding 次数和零网络边界。D1 必须保持零向量；同一次深搜只允许生成一次查询向量。该门不读取或修改正式用户 Atom/Catalog。
- `pnpm.cmd run verify:memory-v3-evolution`：使用正式本地 BGE 和系统临时数据根，验证 Atom 初始准入、run 内 release/readmit、真实请求正文移除、KnownState/ledger 一致、未见冲突零反馈、历史 routing 衰减、routing-only 与 verified usefulness 分层、重启保持和 vector deep search。该门要求正文、confidence 与 embedding hash 不因路由反馈变化，运行阶段零网络请求，完成后删除临时数据根。
- `pnpm.cmd run verify:memory-v3-intent-routing`：使用正式本地 BGE 和系统临时数据根，验证当前请求自足、多轮中英文指代、LS 方案引用、硬排除/负向约束、任务转向和项目 scope。D1 必须保持零查询向量，分支内深搜每个请求只生成一个查询向量；被排除正文、旧历史污染、scope 泄漏和网络尝试都必须为零。
- `pnpm.cmd run verify:memory-v3-compaction-continuity`：使用正式本地 BGE 和系统临时数据根，验证压缩后真实指代只在近期任务锚点不足时读取版本化会话摘要；覆盖中英文回退、当前目标优先、任务转向、排除/替代、session 隔离、无摘要零注入和 Repository 重启。D1 必须零查询向量，弱相关尾部不得为填满 working set 自动注入，运行阶段不得访问网络。
- `pnpm.cmd run verify:memory-v3-bge-soak`：复用同一隔离 soak，但使用活动数据根中已 provision 且通过哈希校验的真实本地 BGE 模型。合成 Atom 仍只写系统临时目录；模型目录只读。该门额外验证模型暂不可用、瞬时 Embed 失败恢复、512 维向量、离线零请求、RSS 上限和 pipeline dispose，不修改正式记忆或 Catalog。
- `pnpm.cmd run verify:memory-v3-provider -- --provider=<id>`：在创建隔离数据根前先执行真实非流式 Provider 预检，要求真实回复和权威 usage；预检通过后才验证 Memory v3 首轮注入、压缩写入候选的提交/拒绝、反馈和重启召回。鉴权失败、缺少 usage、mock 或 Harness 恢复文本都不能算通过。
- `pnpm.cmd run verify:memory-v3-readiness -- --data-dir=<应用数据根>`：只读检查指定 V2 数据根，只把 `memory-tree` 复制到系统临时目录，在副本上验证完整迁移、V3 重启读取、业务 atom/内部 scope root 口径、catalog integrity 和回滚；不复制配置、会话、密钥或 workplace，任何退出路径都删除临时副本。结果只证明该次源快照，正式登记迁移前必须重新执行，不能用旧哈希替代迁移器的提交前复核。
- `pnpm.cmd run sync:tsconfig`：从 28 个 workspace manifest 的真实依赖自动生成 package `references` 和 `tsconfig.workspace.json`；`check:repo` 会拒绝过期引用。
- 包内 `src/**/*.test.ts(x)`：测试包内契约和模块行为，应与源码同目录维护。
- `test/core-agent-contracts.test.ts`：跨包核心 Agent 契约。
- `test/e2e-cli.test.ts`、`test/e2e-webhook.test.ts`：跨包 CLI/渠道流程。
- `scripts/check-repository-hygiene.mjs`：仓库结构质量检查，不参与运行时；检查正式文档、任务书日期、生成物、300/600 行登记、受控超限、热点增长、workspace 清单、深层 import、运行时依赖环和核心协议唯一来源。
- `scripts/workspace-projects.mjs`：workspace 包发现、依赖图、受影响包传播和 TypeScript config 路径的唯一实现。
- `scripts/sync-typescript-projects.mjs`：同步或检查 TypeScript project references，避免手工维护的引用图与 package manifest 分叉。
- `scripts/run-affected-verification.mjs`：按 Git 变更执行受影响 typecheck 与 related tests；配置文件变化不应误触发全部运行时测试；缺失 Git 基线必须 fail-closed，Vitest fallback 使用已解析的 merge-base 提交。
- `scripts/run-verification-gate.mjs`：统一 changed/core/full 三层门的阶段编排、计时、失败定位和本地 JSON 历史；它只负责调用既有命令，不把报告目录中的生成物纳入 Git。
- `scripts/run-task-verification.mjs`：按显式文件、package 或 JSON manifest 执行任务级内循环；不依赖 Git 基线，直接测试优先，任务范围无法生成测试或 typecheck 时 fail-closed。
- `scripts/measure-verification-baseline.mjs`：只读生成任务级/脏工作树验证选择和阶段耗时摘要；默认 dry-run，支持显式文件、package 或 JSON manifest 样本，报告 planning/fingerprint/command/total 分段耗时、变更来源、full/explicit/related/deleted 测试输入、fallback、缓存线索和构建 fingerprint；`--run` 才执行既有质量检查，不替代 `verify:changed` 或 `verify:full`。命令状态明确区分 `executed`、`skipped` 和 `failed`；例如无 affected package 的 `--run=typecheck` 可以是 `exitCode=0`、`signal=null` 但状态为 `skipped`，不能把 skipped 当作实际 typecheck 通过。
- `scripts/verify-app-recovery-sources.mjs`：只读检查用户数据中的工作区、会话、执行日志和恢复索引。
- `scripts/verify-provider-smoke.mjs`：使用本机安全存储中的凭证执行脱敏 Provider 冒烟，覆盖最小聊天、reasoning、工具调用、流式中断和 usage 对账；不得输出或写入明文密钥。
- `scripts/verify-deepseek-v4-tool-tokenizer.mjs`：DeepSeek V4 Flash 工具协议的实际 Provider 校准矩阵，覆盖 disabled/high/max 下的普通请求、tool schema、单工具续轮、仅历史工具消息和多工具乱序结果；任何非零差值都失败。Pro 工具协议必须使用独立校准，不能沿用 Flash 结果。
- `scripts/verify-memory-v3-soak.mjs`：Memory v3 的可重复隔离压力与恢复验收；支持确定性和真实本地 Transformers.js 两种 Embedding 模式。必须校验临时根边界，并在任何退出路径停止维护 worker、关闭 SQLite、释放 pipeline 后再清理。
- `scripts/lib/memory-v3-runtime-soak.mjs`：soak 的公共 Repository 路径辅助验证，负责确定性本地 Embedding、候选排序翻转、routing feedback 有界性和重启恢复；不得向正式应用数据根写入合成记忆。
- `scripts/verify-memory-v3-provider.mjs`、`scripts/lib/memory-v3-provider-acceptance.mjs`：实际 Provider 连续性门及其脱敏预检/隔离运行辅助；必须在任何失败路径清理临时数据根，且不得把凭证或完整 Provider 错误写入报告。
- `scripts/verify-electron-deepseek-compaction-continuity.mjs`：实际 Electron 进程 + DeepSeek API 的会话摘要回答连续性门；校验原始旧消息不进入重启后的回答请求、压缩深度按 `1 -> 2 -> 3 -> 3` 有界滚动、Runtime 精确保真封套保留五个不同字段、版本化摘要成为唯一命中来源、最终回答逐项命中历史值，以及首次续答请求被主动断开后重试成功且失败尝试不触达 Provider。
- `scripts/verify-harness-path-comparison.mjs` 的工具负载（`LITTLESHEEP_COMPARISON_TOOL_WORK=1`、完全访问、`--keep-data`）是当前**真实 Provider + 真实 Electron** 工具工作验收：覆盖读取、写入后读回、列举和搜索，并同时给出命中率、未缓存输入、时延与失败分项。旧 `verify-electron-deepseek-single-tool.mjs`（单工具/自主只读的两次 API 路径）随 DECIDE 一起删除，其本地与 Provider token 对账价值由 `verify-deepseek-v4-tool-tokenizer.mjs` 承担。
- `scripts/verify-electron-deepseek-sustained-load.mjs`：实际 Electron 进程 + DeepSeek API 的持续任务门。默认 diagnostic 为 120 秒，可显式运行 15-1200 秒；`--mode=formal` 默认 2 小时、允许 1-6 小时。两种模式都验证单次副作用只执行一次、安全暂停、Checkpoint 恢复不重放、最终回答连续性和资源回落；formal 另外按最多 24 个窗口检查后半程资源趋势。分钟级结果不能替代 formal 小时级结论。
- `pnpm.cmd run verify:workspace-performance`：先只读断言 App fingerprint，再启动 Electron 性能测量；不会在性能门内隐式构建未知或过期的 `packages/app/out`。
- `scripts/lib/sustained-load-evidence.mjs`：持续任务参数、资源聚合和 formal 趋势窗口的唯一实现；临时进度文件短暂不可读时沿用上一已确认 tick，真正回退仍失败。对应测试为 `scripts/lib/sustained-load-evidence.test.mjs`。
- `scripts/verify-memory-v3-migration-readiness.mjs`：用指定真实 V2 数据的隔离副本执行迁移就绪验收；必须在复制前后复核源 manifest/index 哈希，并区分业务 atom 与内部 scope root，不得在源数据根登记迁移。
- `scripts/build-app.ps1`：构建 Electron 应用并刷新快捷方式。
- `scripts/prepare-littlesheep-runtime.mjs`：按当前 Electron 版本在本机生成被命名为 `LittleSheep.exe` 的运行时副本；该副本属于安装/构建产物，不进入 Git。
- `scripts/refresh-desktop-shortcut.ps1`：调用命名运行时准备脚本，按脚本所在仓库路径生成指向 `LittleSheep.exe` 的桌面快捷方式。
- `scripts/start-littlesheep.ps1`：位置无关的开发启动入口。

## 源码、生成物和用户数据边界

### 应提交和维护的内容

- `packages/**/src/`、跨包 `test/`、配置 schema、正式文档、维护脚本和根入口。
- 影响运行时契约的变更必须同时有测试；影响用户交互的变更必须更新对应交互规范或状态说明。

### 只在本机生成的内容

- `packages/app/out/`、各包 `dist/`、`coverage/`、日志、缓存、临时文件和 TypeScript 构建缓存。
- 构建输出可以留在本机供桌面快捷方式启动，但不进入 Git 版本内容。

### 用户运行时数据

- 完整应用数据根由 `@littlesheep/branding` 和应用运行时解析为 `<data-root>`；默认目录名为 `.littlesheep`，但用户可迁移到其他位置，正式文档不固化真实用户绝对路径。
- 解析优先级为 `LITTLESHEEP_DATA_DIR`、外部 locator、branding 默认目录。locator 默认位于用户主目录，保持在数据根之外，记录活动目录、待迁移/回滚事务和最近一次迁移清单。
- 包括 API 配置、加密密钥引用、sessions、memory-tree、用户与 LS 自身记忆、Skills、plugins/plugin-data、projects、archive、execution logs、workspace layout、terminal activity、`attachment-cache/`、`workspace/resource-indexes/`、`models/tokenizer/`，以及 `AGENTS.md`、`SOUL.md`、`USER.md`、`PHILOSOPHY.md`、`TOOLS.md`、`MEMORY.md` 等用户所有的运行时资源。
- `<data-root>/workplace/` 是未选择项目或外部目录时的默认工作区，只是完整应用数据根的一个子目录。移动 workplace 不等于迁移应用数据；“存储与数据”执行的是完整数据根迁移。
- `<data-root>` 同时是 Agent 的逻辑容器根：默认 workplace 在容器内，用户选定的数据根外项目在容器外。当前由 Main/Safety 的路径分类和权限策略实现，不等同于 Docker/OS 进程沙箱；范围不明的命令按 `unknown` 处理。研究/受限模式在外部或未知工作区启动时先跳过自动资源/文档索引并等待批准，已确认的完全访问直接继续；用户主动的选择、预览和保存走独立 UI 路径。
- `PHILOSOPHY.md` 保存经用户确认的长期价值判断和设计取舍。它注册为 `philosophy` 资源但不进入每轮常驻 Prompt；Agent 必须先沿资源索引发现，再按任务相关性和 token 预算展开。
- `attachment-cache/` 只保存 LS 通过粘贴/浏览器导入创建并登记的临时附件；自动清理只能处理索引中仍通过路径、普通文件、大小和哈希验证的缓存项。`workplace/`、项目目录和外部路径是不同所有权边界，不能因为文件名或目录名相似而由缓存清理删除。
- `workspace/resource-indexes/` 只保存各工作区的相对路径、文件类型、大小、修改时间和 `user/agent` 来源；它不保存正文，扫描有目录、深度、条目和待处理队列上限。索引文件属于 LS 受管运行数据，项目索引以稳定 project id 关联。
- `models/tokenizer/` 保存模型专用、固定 revision 的本地计数资源。资源只有通过登记的大小与 SHA-256 校验后才加载；下载使用同目录临时文件和原子重命名，损坏或不完整文件不会被当作可用 tokenizer，也不进入源码仓库。
- 数据根迁移只在应用启动、Runner/Local App API/插件宿主和其他写入者创建之前执行。目标必须不存在或为空；源目录保留，符号链接与 junction 不复制，内部活动元数据只重绑定原本位于旧数据根中的绝对路径，外部项目和用户文件路径保持不变。
- 仓库治理、构建和测试不得迁移、格式化、删除或重写该目录。需要数据治理时必须先做只读诊断，并单独获得用户授权。

## 后续修改规则

1. 先根据 [架构原则](../principles/architecture-principles.md) 和本指南确认责任与模块归属；不要把运行时逻辑塞进 renderer，也不要让外部渠道成为本地核心依赖。
2. 新增模块优先放入已有包；只有边界、生命周期和测试都清晰时才创建新包，并同步 workspace、入口、文档和测试。
3. 修改公共类型或事件协议时，同时检查 `types`、生产者、消费者、持久化、renderer 恢复和相关测试。
4. 删除模块前先搜索 import、导出、文档链接、脚本和用户数据兼容代码；删除后运行 `check:repo`、测试、typecheck 和 build。
5. 文档只保留当前事实。阶段完成后更新 [project-status.md](../decision/project-status.md)，不要继续追加一次性历史报告。
6. UI 变更遵守 [ui-interaction-guidelines.md](../principles/ui-interaction-guidelines.md)；核心流程变更遵守 [core-agent-flow-guidelines.md](../principles/core-agent-flow-guidelines.md)；跨模块重构同步更新 [架构决策报告](../decision/architecture-decision-report.md)。
7. 每次应用构建都通过 `scripts/build-app.ps1` 或根 `build-app.bat` 刷新快捷方式；不得把机器绝对路径写进脚本。
8. 插件变更必须同时验证 manifest 校验、未启用插件不加载、失败隔离、Runner 重建迁移和停用清理；本地代码默认不信任。
9. 纯逻辑单文件先运行 `verify:task -- --files=<path>`，包级契约先运行 `verify:task -- --package=<name>`；公共契约、workspace manifest、Harness、Runner、Context 或 Memory 改动升级到 `verify:core`；阶段完成或发布前运行 `verify:full`。任务门不替代 affected 门，三层阶段验收也不是简单的包含关系。完整门内部顺序为 `check:repo`、全量测试、一次全 workspace typecheck、App build 和恢复源检查；失败时根据报告的 `failedStage` 继续定位，不用快速门替代阶段完成证据。若 selector 无法证明范围，扩大验证或进入 fallback；若报告为 `skipped`，需确认其 reason 后再判断是否满足验收。
10. 当前运行时的 LS 核心源码是只读安全边界：内置 `write`、`edit`、`exec` 不得修改自动发现的核心源码根。未来开放自我修改前，必须先建立隔离工作树、检查点、完整验证、用户审查和自动回滚，不能删除现有校验后直接开放。
11. workspace package 依赖变化后运行 `sync:tsconfig`，不要手改生成的 references。`typecheck` 会产生被忽略的声明和 `.tsbuildinfo`，用于保证跨包契约正确并加速下一轮。
12. 说明文档默认使用中文；代码标识、协议字段、命令、路径和供应商产品名保留英文。确有维护价值的英文内容只能作为补充版本，不能取代中文正式文档。
