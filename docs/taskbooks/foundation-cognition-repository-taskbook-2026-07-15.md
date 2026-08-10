# LittleSheep 总基调、认知架构与仓库基元化任务书 2026-07-15

最后更新：2026-08-10 15:57:32
版本：v1.5
状态：已完成；D1-D6 已于 2026-07-14 按推荐方案确认，阶段 0-7 已于 2026-07-15 完成并通过质量门与真实窗口验收

> 历史证据边界：本任务书保存仓库基元化阶段的设计和当时验收；当前模块行数、测试数量和工程状态由 [项目状态](../decision/project-status.md) 与 [模块拆分地图](../reference/module-split-map.md) 维护。

本文把用户提供的本机私有开发原稿转译为可执行的工程任务。原稿保持不变且不进入公开仓库；本文只保存能够长期约束 LittleSheep（LS）的工程结论，不记录个人路径、开发对话或一次性过程。

## 1. 总目标

本任务书先整理仓库和责任边界，再继续扩展功能。目标不是为了降低文件行数而重排代码，而是让 LS 能够长期、并行、低风险地持续开发：

- 所有代码和模块由产品使命向下推导，而不是让局部实现反过来决定产品方向；
- 每次 LLM 调用拥有明确、独立、可追溯的认知任务和 Context 契约；
- LS 的身份、记忆、运行数据、用户资料和用户项目拥有清晰的权威来源与所有权；
- 记忆读取和写入沿注册表、索引和事件触发，不靠整份文件常驻或提示词自觉；
- 仓库按稳定基元和窄 API 组织，修改一个责任域时尽量不触碰无关模块；
- 模块、文档和控制面统一采用渐进式披露，默认简单，但允许继续深入；
- 重构过程保持当前功能、用户数据和公共接口可用，不以“整理”为理由制造大面积回归。

## 2. 总基调的正式工程解释

### 2.1 自上而下的服务关系

LS 的设计顺序固定为：

```text
产品使命与核心理念
        ↓
系统能力与边界
        ↓
领域事件与状态
        ↓
业务逻辑与策略
        ↓
代码、算法和基础设施
```

- 代码服务于逻辑，逻辑服务于事件，事件服务于系统，系统服务于产品使命。
- 算法、框架、模式和目录都只是实现手段；选择它们的依据是可靠性、时间成本、维护成本和任务兑现率。
- 主流 Agent 架构可以作为证据和参考，但不能自动覆盖 LS 已确认的目标、记忆索引和用户控制原则。

### 2.2 每次 LLM 调用都是独立认知任务

LLM 不保留跨调用状态。Agent 必须为每次请求明确装配：

- 本次调用的角色和唯一目标；
- 已知事实、来源、可信度和作用域；
- 当前 Workflow/TaskBook 状态；
- 可作出的决策、不可越过的权限和安全边界；
- 可用工具及返回格式；
- 需要模型输出的结构、语言和完成条件；
- 何时需要请求更多 Context；
- 何时应提出记忆读取、写入、合并、冲突或失效意图。

模型只提出结构化意图。Context 选择、记忆读写、工具调用、状态转移、权限和最终提交仍由 Agent 运行时决定。

### 2.3 记忆是可发现、可索引、可治理的内部系统

- LS 只常驻有界根索引，不常驻全部长期记忆。
- 读取遵循 `root index → branch index → expand → branch-scoped deep search`。
- 写入沿索引确定 parent、scope、tier、来源、理由、置信度和生命周期。
- “模型建议更新记忆”与“运行时提交记忆”是两件事；提交前必须经过事件、价值、安全、去重、冲突和审计闸门。
- 用户可以查看和管理同一份运行时记忆，但 UI 不另造展示副本。

### 2.4 LS、用户、开发者和项目相互独立

“数字生命”作为长期产品方向，当前先落成可验证的身份和数据边界，不能提前宣称已经实现完整人格或生命能力。

| 对象 | 权威位置 | 内容 | 禁止事项 |
| --- | --- | --- | --- |
| 公开源码仓库 | Git 跟踪内容 | 产品源码、测试、维护脚本、公开工程文档 | 个人资料、私有记忆、密钥、开发助手记录 |
| LS 用户数据根 | 用户选择的受管目录 | LS 身份、配置、会话、记忆树、插件数据、执行记录、默认 workplace | 被普通仓库整理或测试擅自改写 |
| 用户资料 | 用户数据中的注册资源 | 用户偏好、称呼、长期目标、授权的核心理念 | 与 LS 自身身份混成一个无边界 Prompt |
| LS 身份 | `SOUL.md`、`AGENTS.md` 等受管资源 | LS 是谁、如何行动、哪些事情不能做 | 把用户事实当成 LS 自身事实 |
| 用户项目 | 用户选择的外部工作区 | 用户文件、项目代码、项目产物 | 默认写入 LS 私有记忆或内部控制文件 |
| 开发 Agent 本地状态 | 开发工具自己的本地数据 | 开发会话、临时分析、工具缓存 | 进入 LS 产品仓库或随产品发布 |

新增一个用户可编辑、运行时可注册的 `PHILOSOPHY.md`，保存经过用户确认的长期理念。它与 `USER.md`、`SOUL.md`、`AGENTS.md` 分工如下：

- `PHILOSOPHY.md`：共享的长期价值判断和设计取舍原则；
- `USER.md`：用户事实、偏好、称呼和目标；
- `SOUL.md`：LS 的身份、性格和表达方式；
- `AGENTS.md`：操作规则、控制流和安全约束；
- `MEMORY.md` / 记忆树：会随任务演进的事实、项目状态和经验。

D1 已确认采用该方案。实现安排在稳定仓库边界之后，不能只创建文件而不接入注册、Context 预算、UI 管理和迁移协议。

### 2.5 模块化服务于低成本持续开发

- 渐进式披露既用于 UI，也用于目录、文档、Context 和代码责任。
- 每个基元只拥有一个主要变化原因，并通过窄接口与外部协作。
- 拆分必须减少耦合、冲突和重复修改，不能把一个大文件机械切成大量互相穿透的小文件。
- 代码行数是风险信号，不是唯一目标；职责、依赖方向、测试和认知成本优先。

## 3. 当前仓库基线

基线日期：2026-07-14。以下数字用于规划本轮仓库整理，后续更新以重新执行检查后的结果为准。

### 3.1 已对齐的部分

- 产品使命已明确为解放用户生产力，让用户专注想法和关键决策；
- 架构原则已采用渐进式披露，并区分 LLM 与 Agent 运行时职责；
- Context Engine、T0-T3、索引式记忆、资源注册和用户数据根已经形成基础闭环；
- 用户项目、LS workplace、受管附件缓存和插件数据已经拥有不同所有权；
- 公开仓库与用户运行数据已有基本隔离和卫生检查。

### 3.2 主要缺口

| 缺口 | 当前证据 | 风险 |
| --- | --- | --- |
| 大型组合文件 | 38 个非测试生产文件超过 300 行 | 修改冲突、职责漂移、难以并行开发 |
| Renderer 总控过重 | `App.tsx` 约 9935 行 | UI、导航、会话、设置和工作区相互牵连 |
| Memory 边界仍大 | `memory-repository.ts` 约 1279 行，`memory-service.ts` 约 1120 行 | 存储、迁移、索引和消费职责难以单独演进 |
| 说明入口不足 | 26 个 package 根目录中 25 个没有 README | 新任务难以快速找到所有者和入口 |
| 领域目录说明不足 | 35 个直接包含源码的 `src` 目录没有 README | 目录层级不能承担渐进式披露 |
| LLM 调用契约未统一 | 各 stage 能形成请求，但没有统一的 Call Contract | 调用目的、输出结构和记忆意图容易漂移 |
| 核心理念没有独立权威源 | 工程原则已有投影，但用户长期理念未形成独立注册资源 | 个人偏好、LS 身份和公开架构可能继续混杂 |

### 3.3 行数规则

- 生产代码目标：单文件尽量不超过 300 行。
- 301-600 行：必须有清晰单一职责，并在所在 README 说明暂不拆分的理由。
- 超过 600 行：默认进入拆分队列，除非属于声明式数据、协议集合或其他确有证据的例外。
- 测试可以因场景矩阵适当超过 300 行，但应按领域或夹具拆分，避免单文件成为不可维护测试仓库。
- 不以行数为由拆分紧密耦合的算法，也不创建只有转发和重复类型的微型模块。

## 4. 本轮范围

### 4.1 包含

- 统一任务书命名、文档职责和仓库导航规则；
- 建立 package 与主要领域目录 README；
- 为大型组合文件形成拆分地图、接口边界和分支所有权；
- 按领域逐步拆分 App、Local App API、Renderer API、Memory、Harness 和 Context 热点；
- 定义每次 LLM 调用的 Context/Decision/Output/Memory Intent 契约；
- 设计用户理念、LS 身份、操作规则和记忆之间的权威分工；
- 增加仓库卫生、文件预算、README、依赖方向和文档链接检查；
- 每阶段执行行为保持、定向回归、全量质量门和桌面恢复验收。

### 4.2 不包含

- 新增产品功能、供应商、渠道、MCP 或 IDE 能力；
- 迁移或重写正式用户数据；
- 修改 LS 视觉风格或增加非阻断 UI；
- 把“数字生命”直接实现为无边界自主权；
- 把用户全部核心理念全文常驻每次模型请求；
- 一次性全仓格式化、改名或重新组织 Git 历史。

## 5. 执行阶段

### 阶段 0：冻结基线与命名规范

状态：已完成。任务书命名、链接、当前源码统计和质量门已冻结。

任务：

1. 统一任务书为“总名称 + 基线日期”，文件名和一级标题只保留年月日；
2. 正文使用秒级 `最后更新`；小范围维护不改基线名称，只有建立新执行基线时才创建新日期文件并更新全仓链接；
3. 记录超大文件、包 README、领域 README、公共 API 和依赖方向基线；
4. 冻结当前测试、typecheck、build、恢复检查和桌面启动结果；
5. 明确本轮只做行为保持型整理。

验收：文档链接和卫生检查通过；不存在两个名称不同但内容重复的“最新任务书”。

冻结证据（2026-07-14）：

- `pnpm.cmd run check:repo`：20 项通过，0 项失败；
- `pnpm.cmd test`：117 个测试文件，989 项通过，1 项跳过；
- `pnpm.cmd run typecheck`：26 个 workspace package 通过；
- `pnpm.cmd run build`：26 个 workspace package 与 Electron renderer 构建通过；
- `pnpm.cmd run verify:app-recovery`：通过，保留既有旧执行日志与可选工作区索引诊断警告；
- 桌面快捷方式已刷新，Electron 窗口标题为 `LittleSheep` 且进程正常响应。

### 阶段 1：仓库导航和所有权地图

状态：已完成。package/领域说明、所有权导航和大型文件拆分地图已经建立，未改变运行行为。

任务：

1. 为 26 个 workspace package 建立 README；
2. 为具有独立责任的主要 `src` 领域目录建立 README；
3. 每份 README 只包含职责、公开入口、依赖方向、数据所有权、测试位置、禁止放入内容和常见修改路径；
4. 为生产文件补充一句到三句的职责头注释；
5. 在仓库指南中建立“需求类型 → package → 入口 → 测试”的定位表；
6. 生成大型文件拆分地图，不在本阶段改动运行行为。

验收：新开发任务可以只沿 README 和仓库指南定位到所有者、入口和测试；README 不复制项目状态和完整实现细节。

完成证据（2026-07-14）：

- 26/26 个 workspace package 均有职责 README；
- 9/9 个具有独立责任的主要领域目录均有 README；
- 38/38 个超过 300 行的生产文件均有职责头注释；
- [仓库指南](../reference/repository-guide.md) 已增加“需求类型 → package → 入口 → 测试”定位表；
- [模块拆分地图](../reference/module-split-map.md) 已登记 38 个大型文件的目标边界、分支所有权和顺序；
- `pnpm.cmd run check:repo` 通过。

### 阶段 2：共享契约与拆分基元

状态：已完成。重复协议、跨层路由和 facade 输入输出已经冻结，并由特征测试和质量门保护。

任务：

1. 识别 App、Local App API、Memory、Harness 和 Context 的共享类型重复；
2. 把跨进程、跨 package 的稳定契约放入明确的 shared/types 所有者；
3. 为每个大型文件定义内部 facade，先固定输入输出再移动实现；
4. 建立行为特征测试，保护路由、导航、记忆读写、迁移和流式事件；
5. 禁止新代码继续进入已标记的组合文件，除非是完成拆分所需的兼容适配。

验收：后续分支可以在不同时编辑同一组合文件的前提下工作；公共契约有唯一来源。

完成证据（2026-07-14）：

- 会话/项目/归档、工作区、Runtime/数据根、记忆控制面、附件、插件/渠道和历史消息协议均已迁入 `packages/app/src/shared/`；
- Local App API 静态路由、动态 ID 编码与解析已集中到 `local-app-api-routes.ts`，server 与 renderer 共同消费；
- 旧 main 模块和 `renderer/api.ts` 保留 type re-export，调用方兼容；
- 新增 Local App API 路由单一性测试和 SSE start/activity/delta/result 特征测试；现有导航、迁移、记忆和恢复测试继续通过；
- `check:repo` 已强制检查 package/领域 README、大型文件职责头注释和六个核心组合热点不增长；
- 全量测试 119 个文件，992 项通过、1 项跳过；全工作区 typecheck 与 build 通过，桌面快捷方式已刷新。

### 阶段 3：Electron App 分域

状态：已完成。Renderer、Main/Local App API 与 Renderer API 均已形成兼容入口和领域边界。

#### 3A Renderer

状态：已完成。`App.tsx` 已从约 9935 行收敛为 7 行兼容入口，Renderer 实现按责任域迁入独立目录。

按以下边界从 `App.tsx` 逐步抽取：

- 全局导航与历史；
- 主侧边栏、项目树和会话树；
- 聊天消息、执行披露和输入栏；
- 设置壳、设置导航和各设置页面；
- 拓展工作区布局、标签、文件树、编辑器和终端；
- 浮层、菜单、提示和审批；
- 各领域 controller/hooks 与纯状态 reducer。

目标：`App.tsx` 最终只承担应用壳、领域组合和顶层路由，目标不超过 300 行；动画和交互状态不能因拆分退化。

完成证据（2026-07-14）：

- `App.tsx` 只组合 `useAppController()` 与 `AppView`，顶层视图位于 `app-shell/`；
- `app-shell`、`approval`、`chat`、`composer`、`runtime`、`settings`、`sidebar`、`ui` 和 `workspace` 已形成独立领域目录及中文 README；
- 全局导航/有界历史、审批、run 事件归并、会话/项目动作、侧边栏与拓展工作区两级阈值拖动均已从总控文件中抽离；
- `use-app-controller.ts` 当前为 580 行兼容协调器；本轮新增的浏览器、Office 预览和工作区缓存边界均保持在独立模块或已登记组合壳内，301-600 行文件已在所属 README 解释保留理由并由仓库质量门锁定上限；
- 拆分继续使用原 Local App API、共享协议、持久化键和交互组件，不引入新的运行时 API 或用户数据副本；
- App 双配置 TypeScript 检查已通过；完整质量门和桌面验收结果以 [项目状态](../decision/project-status.md) 为准。

#### 3B Main 与 Local App API

状态：已完成。`local-app-api-server.ts` 已由 2819 行收敛为 241 行组合入口，领域实现位于 `main/local-app-api/`。

按领域拆分：

- run/stream/approval；
- sessions/projects/archive；
- runtime/providers/keys；
- memory tree 与项目投影；
- workspace files/layout/artifacts；
- terminal session/activity；
- plugins/channels；
- attachments/data root；
- HTTP 基础设施、错误和响应 helper。

目标：入口只装配路由和服务；每个领域路由拥有独立测试，现有 URL 和 renderer 行为保持兼容。

完成证据（2026-07-14）：

- HTTP 基元、公共构造契约、run/stream/approval、projects、sessions/archive、runtime/providers/data-root、memory、workspace、terminal、plugins/channels 已按领域分离；
- 所有领域文件均不超过 300 行，`main/local-app-api/README.md` 明确所有权、路由目录、依赖边界和验证规则；
- 活动 run controller、审批 timer、终端 session、移除 timer、SSE listener 与命令捕获均归属具体 server/router 实例，并在 `stop()` 中释放；
- 10 个 Local App API 定向测试文件共 21 项通过；全量 119 个测试文件、992 项通过、1 项跳过，全工作区 typecheck 通过；
- 现有 URL、状态码、SSE 事件名、会话/项目归属、附件、产物、记忆、终端和数据根语义保持不变。

#### 3C Renderer API

状态：已完成。`renderer/api.ts` 已收敛为 21 行兼容 barrel，领域实现位于 `renderer/api/`。

- 按上述领域拆分 fetch/SSE 客户端；
- 保留一个兼容 barrel，避免大规模同步修改调用方；
- 共享协议类型不得在 main 和 renderer 各写一份。

完成证据（2026-07-14）：

- 客户端已按 run、sessions、runtime、attachments、workspace files、terminal、plugins/channels 和 memory 分域；
- 工作区文件与终端会话进一步分离，旧 `./api` 和 `./api/workspace` 导出保持兼容；
- 所有路由继续消费 `shared/local-app-api-routes.ts`，跨进程类型继续消费 shared contracts；
- App TypeScript 双配置检查通过，完整质量门见本阶段最终验证记录。

验收：桌面所有现有交互、转场、导航、恢复和 Local App API 契约不变；三个原始热点不再接收新领域逻辑。

### 阶段 4：Memory、Harness 与 Context 分域

状态：已完成。Memory Repository、Memory Service、Context Engine 与 DECIDE/EXECUTE/VERIFY 均已保留兼容 facade，并把内部责任迁入可独立测试的领域模块。

任务：

1. 将 Memory Repository 的文档 IO、迁移、节点写入、资源注册、审计和备份恢复拆成独立基元；
2. 将 Memory Service 的 run scope、project scope、bootstrap、skills、附件、工作区和事件账本协调拆成内部服务；
3. 将 EXECUTE 的步骤调度、工具循环、权限、失败分类和证据归并拆分；
4. 将 DECIDE 的需求校准、复杂度、TaskBook 解析和重规划拆分；
5. 将 VERIFY 的步骤验收、缺口分类和恢复反馈拆分；
6. 将 Context Engine 的候选规范化、预算、淘汰、装配、计数和快照拆分；
7. 对外继续由现有 facade 提供兼容 API，直到调用方迁移完成。

完成证据（2026-07-15）：

- `memory-repository.ts` 从 1279 行收敛为 171 行 facade，文档存储、资源生命周期、节点管理、写入策略和项目路径重绑定进入 `memory-repository/`；
- `memory-service.ts` 从 1120 行收敛为 343 行 facade，run、摘要、附件、事件、Bootstrap、Skills、工作区资源、项目投影和资源管理进入 `memory-service/`；
- `ContextEngine` 从约 690 行收敛为 180 行 facade，候选、预算、淘汰、装配、计数和快照进入 `context-engine/`；
- `decide.ts`、`execute.ts`、`verify.ts` 分别收敛为 169、46、145 行 facade，需求校准、局部重规划、工具循环、权限、失败分类、步骤调度、证据和验证路由进入同名领域目录；
- `@littlesheep/memory-tree` 79 项、`@littlesheep/context` 11 项、Harness 115 项测试通过，三个包 typecheck 和相关 `git diff --check` 通过；
- 新增浏览器历史和 Office 预览模块均有边界测试；超过 600 行的既有组合文件继续进入受控清单，`catalog.ts` 的登记上限调整为 640 行并按期复查。
- 最终质量门由 `check:repo`、全量测试、全工作区 typecheck、Electron build 和恢复源检查分别提供证据；具体数量以最新 [项目状态](../decision/project-status.md) 为准。本轮源码构建不自动宣称桌面快捷方式已刷新或真实窗口验收完成。

验收：记忆树索引、迁移、项目投影、TaskBook、工具循环、Context 快照和恢复行为与拆分前等价。

### 阶段 5：LLM Call Contract 与记忆更新策略

状态：已完成。每次模型调用已拥有独立契约，Context、工具、输出预算和记忆提交均由运行时强制约束。

先在阶段 1-4 稳定的模块边界上实现，不提前塞回大型文件。

任务：

1. 定义版本化 `LlmCallContract`，至少包含 purpose、stage、goal、inputs、allowed decisions、output schema、memory intent policy、tool policy 和 budget；
2. 为 CLASSIFY、DECIDE、EXECUTE tool-loop、RECOVER、VERIFY、EVOLVE、CAPTURE、REPLY 和 FINALIZE 分别定义最小契约；
3. Context Engine 只装配契约允许的来源，执行日志记录调用契约版本和实际 Context 快照；
4. 定义模型可提出的记忆意图：read、write、merge、invalidate、conflict、none；
5. EVOLVE/CAPTURE 根据真实任务事件和记忆闸门决定是否提交，不因模型输出一句“记住”就直接写入；
6. `PHILOSOPHY.md` 若获批准，作为有预算、可追溯的注册资源按任务相关性介入，不全文常驻；
7. 建立多次 LLM 调用的端到端测试，证明不同调用不会误继承未登记状态。

验收：每次模型请求都能回答“为什么调用、给了什么、允许决定什么、应输出什么、记忆意图如何处理”。

完成证据（2026-07-15）：

- `@littlesheep/types` 已定义版本化 `LlmCallContract`，覆盖 CLASSIFY、DECIDE、EXECUTE 工具循环/最终回复、RECOVER、VERIFY、EVOLVE、CAPTURE、REPLY、FINALIZE 和会话压缩；`FINALIZE` 明确禁止模型调用；
- Context Engine 在预算计算前按契约过滤候选和 System Prompt segment；必需来源越权、缺失、stage 不匹配或禁用调用均失败关闭；模型请求快照持久化完整契约；
- `prepareModelRequest()` 校验注册工具、步骤工具范围和输出 token 上限，会话压缩使用独立 `session_compaction` purpose；
- EVOLVE/CAPTURE 的 `read/write/merge/invalidate/conflict/none` 建议经过真实步骤、工具和 VERIFY 证据闸门；只有运行时可提交，`invalidate/conflict` 只延期记录，不直接破坏数据；判定记录进入执行日志；
- `PHILOSOPHY.md` 已成为用户数据模板和显式 `philosophy` 资源类型，只注册元数据并沿资源索引按预算展开，不进入常驻 Prompt bootstrap；
- Harness 端到端测试验证连续六次不同 purpose 的契约、Context 和工具策略互不泄漏；Context、Harness、Runner 和 Memory 定向回归均通过。

### 阶段 6：持续维护质量门

状态：已完成。仓库卫生门已从 25 项扩充为 31 项，并由脚本自动失败关闭。

任务：

1. `check:repo` 校验任务书日期命名和链接；
2. 校验每个 package 和指定领域目录存在 README；
3. 对生产文件超过 300/600 行分别给出警告/失败或受控例外；
4. 校验组合热点不再增长；
5. 校验跨 package 深层 import、循环依赖和重复协议类型；
6. 校验新模块包含职责说明、测试位置和所有权；
7. 为例外建立有界清单，包含原因、所有者和复查日期。

验收：后续新增文件和模块默认符合本任务书，不依赖人工记忆规则。

完成证据（2026-07-15）：

- 任务书标题/文件名/最后更新日期、Markdown 链接、package 与领域 README、生成物、热点文件和模块依赖方向均自动校验；
- 所有 300 行以上生产文件必须登记；当前 6 个超过 600 行的文件进入包含原因、所有者、上限和 2026-08-15 复查日期的受控清单，`catalog.ts` 的本轮上限为 640 行；
- 新增 workspace 运行时依赖环检查、跨包深层 import 检查和核心协议唯一来源检查；
- 当前 `pnpm.cmd run check:repo` 的仓库卫生项为 33 项通过、0 项失败，TypeScript project references 也必须同时通过。

### 阶段 7：真实场景回归与决策报告

状态：已完成本任务书范围内的工程与代表性场景验收；真实供应商和真实长任务仍作为后续独立能力门。

任务：

1. 运行完整仓库质量门和桌面恢复验收；
2. 对会话、项目、记忆树、插件、设置、工作区和长任务做代表性回归；
3. 比较整理前后的文件热点、依赖、测试、构建时间和修改冲突面；
4. 出具“用户需要决定的事项”和下一阶段可并行任务；
5. 更新项目状态、仓库指南和架构决策报告。

验收：维护成本和修改冲突面有可复现改善，功能与用户数据无回归。

完成证据（2026-07-15）：

- 全量测试 119 个文件，996 项通过、1 项按既有环境条件跳过；26 个 workspace package typecheck、全工作区 build、恢复源检查和 31 项仓库卫生门通过；
- Electron 构建约 91 秒，完整测试约 37 秒，完整 typecheck 约 38 秒；时间仅作本机本轮参考，是否回归以命令结果为准；
- 桌面快捷方式已刷新，最新 `LittleSheep` 窗口可见且响应正常；真实 UI 中已打开记忆树资源目录，确认 `PHILOSOPHY.md` 显示为“长期理念”，全局返回可回到原对话；
- 自动回归覆盖会话、项目、归档、记忆树、插件、设置契约、工作区、附件、渠道和多步骤任务；恢复源检查保留旧 run 缺失执行日志和可选 workspace 索引缺失的诊断警告；
- 现有会话、记忆和配置未迁移或重写；应用只在缺失时新增获批的 `PHILOSOPHY.md` 模板并注册其资源元数据；
- 主要热点已从 `App.tsx` 9935→7 行、Local App API 2819→241 行、Renderer API 1088→21 行、Memory Repository 1279→171 行、Memory Service 1120→343 行、Context Engine 690→180 行、DECIDE/EXECUTE/VERIFY 620/867/473→169/46/145 行；公共 facade 与特征测试保留。

后续需要用户决定或提供的事项：

1. DeepSeek 凭证、四项脱敏冒烟和 V4 本地精确 token 对账已完成；OpenAI/GLM 只在实际启用时再提供对应凭证并完成同等校准；
2. 编辑并确认用户数据中的 `PHILOSOPHY.md` 长期理念正文；
3. 在 2026-08-15 前决定 6 个受控超限文件的拆分优先级；
4. 下一工程主线建议依次为真实 Provider 校准、统一 Tool Execution Service、RuntimeEventQueue/检查点与重启续跑。

## 6. 建议分支与并行边界

阶段 0-2 必须先串行完成。共享契约冻结后，才建议并行：

| 分支 | 所有权 | 可并行条件 | 禁止同时修改 |
| --- | --- | --- | --- |
| A 文档与质量门 | README、仓库指南、检查脚本 | 阶段 2 契约完成 | 业务实现文件 |
| B Renderer | `src/renderer` 组件和 hooks | App facade 与共享类型冻结 | main 路由、Memory 实现 |
| C Main/API | `src/main` 路由和服务 | URL/协议特征测试完成 | Renderer 组件、Memory Repository |
| D Memory | memory-tree/memory-core 内部基元 | Memory facade 冻结 | App 热点和 Harness stage |
| E Harness/Context | stage、Call Contract、Context Engine | runtime contract 冻结 | Renderer 与 main 组合文件 |

合并顺序建议：A → C/D → B → E。任何两个分支需要编辑同一热点文件时，先由主分支完成 facade 提取，再重新分派所有权。

## 7. 已确认决策

| 编号 | 决策 | 已确认方案 | 状态 | 影响 |
| --- | --- | --- | --- | --- |
| D1 | 是否新增 `PHILOSOPHY.md` | 新增，但只存用户确认的长期理念并接入资源注册 | 已确认 | 明确理念、用户资料和 LS 身份边界 |
| D2 | README 覆盖粒度 | package 根 + 有独立责任的领域目录，不机械覆盖每个叶子目录 | 已确认 | 保持可导航且避免文档噪声 |
| D3 | 300 行规则 | 软上限；超过 600 行默认失败，例外需登记 | 已确认 | 避免机械拆分，同时阻止组合文件继续膨胀 |
| D4 | 是否并行分支 | 阶段 0-2 后按 A-E 所有权并行 | 已确认 | 降低冲突，不让多个 Agent 同时改热点 |
| D5 | “数字生命”公开表达 | 作为长期产品方向，不作为当前已实现能力宣传 | 已确认 | 保留总基调，同时避免错误能力声明 |
| D6 | 个人称呼和开发者资料位置 | 只进入用户私有资料，不进入公开仓库 | 已确认 | 满足个性化且保护公开边界 |

## 8. 用户与维护 Agent 的责任

### 用户需要做的事

1. 在每个阶段验收功能是否保持一致；
2. 对 `PHILOSOPHY.md` 的内容拥有最终编辑和确认权；
3. 发现交互或行为变化时提供可复现步骤。

### 维护 Agent 需要做的事

1. 先保护当前未提交改动和用户数据；
2. 每阶段先读源码和测试，再确定拆分边界；
3. 使用 facade、特征测试和兼容 barrel 渐进迁移；
4. 不把个人原稿、私有资料或开发对话提交到公开仓库；
5. 每次改动同步 README、任务书日期、项目状态和质量门；
6. 每轮应用改动后构建、刷新桌面快捷方式并进行真实窗口验收；
7. 发现行数规则与职责完整性冲突时，以职责为先并登记例外；
8. 阶段完成后给出真实证据、遗留风险和下一决策，不用“已重构”概括未完成工作。

## 9. 每阶段验证顺序

```powershell
pnpm.cmd run check:repo
pnpm.cmd test
pnpm.cmd run typecheck
pnpm.cmd run build
pnpm.cmd run verify:app-recovery
```

涉及 Electron 时还必须：

1. 刷新桌面快捷方式；
2. 启动最新构建；
3. 验证窗口可见、响应正常；
4. 验证导航、设置、会话、工作区和恢复路径；
5. 确认没有意外创建、迁移或删除用户数据。

## 10. 总完成门槛

- 所有 package 和主要领域目录可通过 README 渐进定位；
- 生产文件超过 600 行的例外全部有理由、所有者和复查计划；
- `App.tsx`、Local App API 和 Renderer API 已成为轻量组合入口；
- Memory、Harness 与 Context 的大型职责可独立测试和修改；
- 每次 LLM 调用都有版本化 Call Contract；
- 记忆读取、写入、合并、冲突和失效均经过索引与运行时闸门；
- 用户、LS、项目、公开仓库和开发 Agent 的数据边界可查询且不混写；
- 全量测试、typecheck、build、恢复检查和桌面验收通过；
- 正式用户数据没有因仓库整理被迁移、重写或删除；
- 项目状态和架构文档准确反映当前事实。

在上述门槛完成前，除阻断性 Bug 外，不继续扩大 UI、MCP、插件类型、渠道或 IDE 能力范围。
