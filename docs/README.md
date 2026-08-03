# LittleSheep 文档决策入口

最后更新：2026-08-03 17:35:20

本页是正式文档的唯一首要入口。日常决策先看本页，不要从任务书、仓库指南或架构长文开始阅读。

## 现在先做什么

**当前阶段**：Memory v3 阶段 0-26、正式数据迁移、本地向量目录、动态 working set、关系导航、shadow Git 检查点、退出冻结、统一 Tool Execution Service、工具调用级与 TaskBook 步骤级有界并行、运行时事件安全边界、TaskBookPatch、Runner 检查点续跑、应用启动恢复控制面，以及活动任务快照、暂停/继续/中断、托盘、三档关闭策略和设置页“应用与后台”已有工程基线。语义活动已收敛为 `respond / execute / clarify`；直接回应使用紧凑 Prompt 与有界历史，只在明确追问进度、结果、耗时、错误或恢复时介入上一轮执行摘要。自包含且来源可证明为内置的单个 `glob / grep / read` 请求使用独立 `decide_explicit_tool` 紧凑契约；多工具、写入、执行、附件、续接、记忆介入、恢复和边界不明任务仍走完整 `decide`。当前 DeepSeek 已完成 chat、continuity、tool、abort 四项真实校准、普通直接回答 V4 本地精确 token 对账、显式工具路径、真实 Electron 完整退出/重启后的最终回答连续性、短时并行与 Checkpoint 恢复，以及单次 120 秒持续 `exec` 的安全暂停、重启不重放和资源回落验收。含历史 Provider `tool_calls`/`tool` 结果的普通工具续轮仍等待 tokenizer 校准，不显示伪精确本地数字。具体证据只看 [项目状态](decision/project-status.md)。

**推荐下一步**：优先验证数小时持续长任务、多轮多次压缩、更多字段与非字段事实的回答连续性、真实网络断线恢复、外部系统副作用和更长期资源回落；120 秒分钟级任务、一次双字段摘要续答、短时并行压力、基础两步副作用、跨重启回答门与显式工具提议门已经完成，不再重复把它们列为未开始。下一项 Context 计量工作是校准含历史 `tool_calls`/`tool` 结果的普通工具续轮 framing。权限定义继续保持“行为 profile 与权限策略正交”，不要再把编程当作权限模式。

**当前权限决策**：产品语义上 LS 是 Agent 的容器，活动完整应用数据根（默认 `.littlesheep`）是容器边界，`workplace/` 是容器内的默认工作区；当前桌面实现是 Main 的逻辑边界，不是实际 Docker/OS 进程沙箱。从其他模式切换到完全访问时先用红色危险按钮确认一次；确认后容器内外及范围不明的读、写、改、删、执行均免逐次批准。研究只对容器内读取免批准；受限所有操作都需批准。外部工作区在研究/受限模式下先跳过自动索引，完全访问可直接继续。核心源码只读和危险命令硬拒绝不受模式影响。

**你现在不需要再次决定迁移或替换 DeepSeek 凭证**：迁移、模型准备、向量回填和应用重启已完成。最新无延迟单 `glob` 验收为 `decide_explicit_tool -> Runtime glob -> structural VERIFY -> execute_final_reply`：2 次真实 DeepSeek API、1 次只读工具，耗时 `2.901s`；紧凑决策 prompt 为 `629` tokens，全程 prompt `1,479`、Provider total `1,702`，两次本地 tokenizer 均为 `exact_match`。最新短时并行压力门结束后 active run/retired Runner 均为 0，source/listener 回到 1，Provider total 为 `20,389`。最新 120 秒持续门中 `exec` 只执行 1 次、产生 120 个进度 tick，恢复不重放，跨模型追问连续性为 `supported`，最终资源回到有界空闲状态。最新摘要续答 Provider total 为 `3,480`；最终续答 prompt 本地/Provider 为 `1127/1129`，状态是 `within_tolerance`，不能写成零差值。含历史 Provider 工具结果的普通续轮仍失败关闭 exact 声明，等待独立校准。

- Provider `/embeddings` 已在 v3 基础设施中默认硬关闭；BGE 是当前平衡默认，multilingual E5 是高质量可选档，两者均已通过显式资产校验和运行阶段零网络请求的真实离线基准。
- Memory v3 使用四层语义：对话原始来源保存用户输入与对话区可见内容，写入后不改写；投影变更记录保存 `MemoryUpdateEvent + mutation`，只服务幂等、恢复和审计；atom 是可去重、合并、调层级、失效、恢复和重建的当前语义投影；run working set 只决定本轮介入。SQLite 向量目录管理 atom 的路径、层级、FTS、向量、状态和审计，但必须能从持久文件重建。
- 记忆文件位于哪里不是注入依据。层级先缩小候选范围；Runtime 再按当前 task relevance、scope、权威、认识状态、confidence、importance、verified usefulness、时效、routing/relationship relevance 和预算选择少量 Atom，并在执行中按需展开、释放或重新激活。高相关种子可在同 branch/scope/subtree 内沿有方向、有证据的一跳关系发现必要邻接 Atom；`similar-to`、跨 scope、过期、争议、低置信或无独立任务价值的关系候选不会自动进入。访问、文件路径和导航成功都不能冒充事实证据。
- D1 task relevance 已与 confidence/importance/历史 usefulness 解耦；branch/scope 内 FTS 可找回近期候选之外的精确旧 Atom，prime 会检查完整有界 D1 列表，只让 `task relevance > 0.25` 且属于最强相关簇的候选进入首轮 working set，再按完整治理优先级排序。只有已通过独立任务门、由强语义关系发现且 route strength 达到硬门槛的必要 Atom，可以与种子一同跨越普通相关性断层；普通弱相关尾部仍只留在索引。D1 不调用向量，正式本地 BGE 仍只作为已导航分支 deep search 的语义兜底；同一深搜请求只生成一次查询向量并复用于授权 scope。
- 正式迁移前的只读预检和隔离副本演练已通过；正式提交后再次验证 40 个业务 atom、5 个内部根和 11 个资源，源 V2 index/manifest 未变化，配置与 locator 均指向 v3，应用恢复源检查通过。
- 迁移后的回滚不再先登记、重启后才发现失败：内部维护流程会用当前运行中的同一 V3 repository 实时核对迁移 snapshot、V2 回滚源和 V3 validation hash；任一侧变化都不生成 pending rollback，启动阶段仍保留第二次强校验。普通记忆文件页不展示这些底层维护状态。
- 迁移页独立显示固定本地 BGE 模型的资产状态。当前正式模型为固定 revision `75c43b069aac4d136ba6bc1122f995fedcfd2781`，运行阶段零网络请求；Electron 主进程将 Transformers.js 保持为外部 Node 运行依赖，避免构建时误选浏览器/WASM 后端。
- `.littlesheep` 只是默认数据根名称，完整应用数据可整体迁移；`workplace/` 只是默认工作区子目录。
- 当前 LS 核心源码保持只读；Skill 合并、停用、归档或删除需要来源、引用、验证和回滚证据。
- 当前 DeepSeek 活动模型的四项 Provider 校准、普通请求、自包含单只读工具的紧凑路径、有界多工具提议路径和真实跨重启最终回答连续性均已完成。精确性按具体请求形态声明：最新单只读工具两次请求均为 `exact_match`，最新摘要续答最终请求为 `within_tolerance`；含历史 Provider 工具消息的普通续轮 exact 校准与 OpenAI/GLM 模型专用 tokenizer 验证仍待实际启用后补齐。定位文件不存在或 Main 未运行时，`verify:provider` 应明确失败，不用 mock 冒充通过。
- 记忆连续以 LS 最终回答为准：仅保存会话、摘要、Atom、Checkpoint 或内部检索成功不算通过；任务续接和直接追问旧信息只有回答级状态 `supported` 才能称为连续。明确追问多个旧值时必须逐项肯定答出，漏答、答错、否定旧值、只记得附带限制或明确说忘了均判为断档；即使回答复述了全部旧值，只要同时声称无法回忆，也必须判为 `discontinuous`。旧值可从真实进入回答 Context 的近期历史、版本化摘要或 active/adopted Atom 证明。字段门支持 Markdown 表格、短数字、布尔值、`executionCount / ticks / completed`，但仍要求标签和值精确对应，无关位置出现同一个数字不能冒充命中。真实 DeepSeek 跨重启回答门、两步副作用后的记忆追问、两条独立会话的并行恢复追问、一次原始旧消息已被压缩且最终回答只依赖 `session_summary` 的双字段验收，以及 120 秒持续任务后的跨模型追问均已通过；多轮多次压缩、更多事实形态、数小时持续负载和外部系统副作用仍需同样标准验收。
- 暂时不用决定：更多插件类型、MCP 和发布打包。设置页后台任务控制已经作为连续性能力收口接入，不是新产品范围。

到这里即可停止阅读。正式 V3 数据、桌面基线、活动路由、直接回应 Context、当前 DeepSeek 四项 Provider 能力、普通请求与显式单/多工具提议路径的精确本地 token 对账、真实 DeepSeek 跨重启回答门、一次有界摘要压缩续答、基础两步副作用、短时并行压力、120 秒持续任务、应用启动恢复和后台任务控制面已有当前证据；普通工具续轮 tokenizer、多轮多次压缩、数小时持续负载和其他 Provider 能力矩阵仍需单独验收。

## 需要确认依据时

只按下面顺序展开：

1. [项目状态](decision/project-status.md)：当前真正实现了什么、验证结果和仍未完成的边界。
2. [架构决策报告](decision/architecture-decision-report.md)：为什么推荐 Memory v3 → Provider 对话校准 → Tool Execution Service → Runtime 连续性 → Mode/MCP/插件。

当前事实与测试数字只以项目状态为准，演进顺序只以架构决策报告为准。

## 需要修改长期方向时

- [架构原则](principles/architecture-principles.md)：产品使命、LLM 与 Agent 分工、Context、Memory、Tools、Workflow、插件和数据边界。
- [核心 Agent 流程规范](principles/core-agent-flow-guidelines.md)：TaskBook、执行、验证、恢复、记忆介入和连续性约束。
- [UI 交互规范](principles/ui-interaction-guidelines.md)：渐进式披露、动画、层级、浮层、导航和交互一致性。

这些文档是稳定约束，不用于查看最新测试数字。

## 已决定方向后再看任务书

### 当前主线

- [原子记忆与内置向量目录任务书 2026-07-17](taskbooks/memory-atom-vector-catalog-taskbook-2026-07-17.md)：Memory v3 原子文件、层级、本地向量目录、三层视图边界、动态注入、压缩连续性、迁移与验收。
- [Agent Runtime 连续性任务书 2026-07-14](taskbooks/agent-runtime-continuity-taskbook-2026-07-14.md)：Provider 校准、Context、附件、运行中重入、检查点、后台执行和有界并行。
- [Agent Runtime 效率与版本化连续性任务书 2026-07-17](taskbooks/agent-runtime-efficiency-versioning-taskbook-2026-07-17.md)：工具调用并行、shadow Git、检查点、退出冻结、LLM 调用预算和前台 `SOUL` 表达边界。
- [开发环境管理任务书 2026-07-19](taskbooks/development-environment-taskbook-2026-07-19.md)：设置页版本偏好、工具链导入、终端优先路径、安全校验和后续运行时分发边界。

### 已完成基线

- [总基调、认知架构与仓库基元化任务书 2026-07-15](taskbooks/foundation-cognition-repository-taskbook-2026-07-15.md)
- [核心 Agent 能力任务书 2026-07-13](taskbooks/core-agent-capability-taskbook-2026-07-13.md)

### 专项与历史执行基线

- [Agent 核心与记忆系统任务书 2026-07-14](taskbooks/agent-core-memory-taskbook-2026-07-14.md)
- [核心收敛小任务书 2026-07-13](taskbooks/core-focus-maintenance-taskbook-2026-07-13.md)
- [拓展工作区任务书 2026-07-12](taskbooks/extension-workspace-taskbook-2026-07-12.md)

任务书保存阶段设计和验收记录，不代表全局最新状态。不要通过比较任务书日期判断下一步。

任务书中出现的 `CLASSIFY`、`chat / problem / unclear`、旧测试数量和旧 Catalog 版本属于对应阶段的历史验收语境。当前语义活动统一为 `respond / execute / clarify`；内部 stage id、旧会话和插件字段可继续保留兼容名称，但不得再作为新的产品概念使用。

## 需要定位代码或维护仓库时

- [仓库指南](reference/repository-guide.md)：需求类型对应的 package、入口、测试、依赖和维护流程。
- [模块拆分地图](reference/module-split-map.md)：大型生产文件的所有权、上限和拆分边界。
- [插件开发说明](reference/plugin-development.md)：插件贡献、权限、生命周期和兼容规则。

## 文档冲突规则

1. 长期使命与硬约束：以架构原则为准。
2. 当前实现与验证数字：以项目状态和源码测试为准。
3. 下一阶段顺序：以架构决策报告为准。
4. 具体阶段验收：以对应任务书为准。
5. 目录和模块归属：以仓库指南为准。

发现冲突时先修正文档责任边界，不通过复制一份新的总结来规避冲突。
