# LittleSheep 文档决策入口

最后更新：2026-08-09 17:38:00

本页是正式文档的唯一首要入口。日常决策先看本页，不要从任务书、仓库指南或架构长文开始阅读。

## 现在先做什么

**当前开发效率阶段**：开发反馈环提速任务书的阶段 0 已完成并已提交推送；阶段 2 的统一 affected 选择计划正在做最终独立验收，阶段 3 的专项 build-once/fingerprint 复用仍未完成。当前首要问题仍是验证反馈可信度和构建产物新鲜度，不是 README 或注释数量。

**当前阶段**：Memory v3 阶段 0-26、正式数据迁移、本地向量目录、动态 working set、关系导航、shadow Git 检查点、退出冻结、统一 Tool Execution Service、工具调用级与 TaskBook 步骤级有界并行、运行时事件安全边界、TaskBookPatch、Runner 检查点续跑、应用启动恢复控制面，以及活动任务快照、暂停/继续/中断、托盘、三档关闭策略和设置页“应用与后台”已有工程基线。语义活动已收敛为 `respond / execute / clarify`；直接回应使用紧凑 Prompt 与有界历史，只在明确追问进度、结果、耗时、错误或恢复时介入上一轮执行摘要。用户明确点名且可证明为新鲜、自包含、内置的单个 `glob / grep / read` 请求使用 `decide_explicit_tool`；没有点名工具的同类只读目标由 LLM 在三种内置读工具中自主选择，并在同一次 DECIDE 中给出有界参数提议，Runtime 重验后直接执行。多工具、写入、执行、附件、续接、已采用/冲突记忆、恢复和边界不明任务仍走完整 `decide`。直接续答在发布前使用本地回答连续性证据检查；普通回答不增加调用，只有明确续接且首个实时 API 回答被判为 `discontinuous` 时，才允许一次有界实时 API 纠偏，纠偏仍断档则失败关闭。当前 DeepSeek 已完成 chat、continuity、tool、abort 四项真实校准、普通直接回答与 Flash 工具协议的 V4 本地精确 token 对账、真实 Electron 完整退出/重启后的最终回答连续性、短时并行与 Checkpoint 恢复、摘要深度 `1 -> 2 -> 3 -> 3` 的五字段连续性、一次主动断线零额外 Provider Token 恢复，以及单次 6 分钟持续 `exec` 的安全暂停、重启不重放和资源回落验收。正式 2 小时持续负载门已通过：`7200s`、`1441` 个采样、进度缺测 `0`、资源预算违规 `0`，后半程 RSS/Heap/Electron 工作集/句柄/请求趋势均在预算内，结束后恢复空闲基线。Flash 的 direct、tool schema、单工具续轮、仅历史工具消息和多工具乱序结果在 disabled/high/max 三档共 `15/15` 次请求与 Provider prompt usage 零差值；Pro 普通请求保持精确，Pro 工具协议仍失败关闭。具体证据只看 [项目状态](decision/project-status.md)。

**推荐下一步**：继续执行[开发反馈环提速任务书 2026-08-09](taskbooks/development-feedback-loop-taskbook-2026-08-09.md)的阶段 2，然后进入阶段 3 的构建新鲜度门。在此之前，不把已经完成的 Memory v3/Provider 基线扩展重新当作本仓库当前开发瓶颈。自主单只读路径已经稳定为 2 次请求，不再以减少调用次数为首要目标；其后续才是扩展非字段事实的回答连续性和真实外部系统副作用恢复，再按实际启用范围校准 Pro/其他 Provider，并继续观察更长期真实用户负载。最新真实矩阵为 `glob 630 + 379 = 1,009`、`grep 646 + 333 = 979`、`read 632 + 292 = 924` Prompt Token；连续两轮观测范围为 `glob 1,005-1,009 / grep 977-979 / read 924`，均为 2 次模型调用、1 次工具、逐请求 `exact_match`。点值会随 LLM 生成的步骤摘要小幅波动，回归契约以 DECIDE `750`、最终回答 `450`、总 Prompt `1,200` 与 `2 API / 1 tool` 为准。后续只在不撤掉权限、schema、工具证据、结构验证和实时 LLM 最终回答的前提下继续缩短 Prompt。正式 2 小时门、当前 120 秒诊断门、主动网络断线恢复、多轮摘要滚动与任意明确字段已经形成证据，不再重复列为未开始。权限定义继续保持“行为 profile 与权限策略正交”，不要再把编程当作权限模式。

**当前权限决策**：产品语义上 LS 是 Agent 的容器，活动完整应用数据根（默认 `.littlesheep`）是容器边界，`workplace/` 是容器内的默认工作区；当前桌面实现是 Main 的逻辑边界，不是实际 Docker/OS 进程沙箱。从其他模式切换到完全访问时先用红色危险按钮确认一次；确认后容器内外及范围不明的读、写、改、删、执行均免逐次批准。研究只对容器内读取免批准；受限所有操作都需批准。外部工作区在研究/受限模式下先跳过自动索引，完全访问可直接继续。核心源码只读和危险命令硬拒绝不受模式影响。

**你现在不需要再次决定迁移或替换 DeepSeek 凭证**：迁移、模型准备、向量回填和应用重启已完成。2026-08-04 最新显式 `glob` 验收仍为 `decide_explicit_tool -> Runtime glob -> execute_final_reply`，随后通过 structural VERIFY：2 次真实 DeepSeek API、1 次只读工具，DECIDE/final prompt `417/379`、全程 prompt `796`、Provider total `826`，两次本地 tokenizer 均为 `exact_match`。09:31 的最新自主工具矩阵中，`glob / grep / read` 都走 `decide -> Runtime tool -> execute_final_reply`，均为 2 次真实 API、1 次工具、Provider 工具协议请求数 0、逐请求 `exact_match`、结构 VERIFY 通过且工作区无修改；Prompt 总量分别为 `1,009 / 979 / 924`。真实跨重启续答首轮与重启轮都只调用 1 次 API，Prompt 为 `974 / 1,286`，最终连续性为 `supported`，正常回答没有触发纠偏。最新后台九场景同样全部通过：恢复任务只有 `decide -> execute_final_reply` 两次 API，`write/read` 各成功 1 次，耗时 `6.863s`；具有权威 usage 的请求合计 prompt `5,477`、completion `934`、total `6,411`，中断分支的未完成请求不伪造 Provider usage。SSE、托盘、暂停、强制终止、重启续跑、profile 热重载、回答连续性、中断 Checkpoint 和彻底退出均通过。耗时只作为运行记录，不作为速度结论；Prompt 成本以请求级账本为准。最新正式 2 小时门已完成，后半程资源趋势和终态均通过；当前工作树又通过 120 秒持续门，`exec` 只执行 1 次，完成“同进程暂停 -> 继续 -> 再暂停 -> 安全边界 Checkpoint -> 强制终止/重启恢复”链路，120 个进度 tick、121 次采样、无进度缺测且资源违规为 0，跨模型追问的 LS 最终回答连续性为 `supported`。最新多轮摘要续答还验证了 5 个历史字段、三级压缩深度上限和一次主动断线恢复；失败请求未到达 Provider，额外 Provider Token 为 0。

- Provider `/embeddings` 已在 v3 基础设施中默认硬关闭；BGE 是当前平衡默认，multilingual E5 是高质量可选档，两者均已通过显式资产校验和运行阶段零网络请求的真实离线基准。
- Memory v3 使用四层语义：对话原始来源保存用户输入与对话区可见内容，写入后不改写；投影变更记录保存 `MemoryUpdateEvent + mutation`，只服务幂等、恢复和审计；atom 是可去重、合并、调层级、失效、恢复和重建的当前语义投影；run working set 只决定本轮介入。SQLite 向量目录管理 atom 的路径、层级、FTS、向量、状态和审计，但必须能从持久文件重建。
- 记忆文件位于哪里不是注入依据。层级先缩小候选范围；Runtime 再按当前 task relevance、scope、权威、认识状态、confidence、importance、verified usefulness、时效、routing/relationship relevance 和预算选择少量 Atom，并在执行中按需展开、释放或重新激活。高相关种子可在同 branch/scope/subtree 内沿有方向、有证据的一跳关系发现必要邻接 Atom；`similar-to`、跨 scope、过期、争议、低置信或无独立任务价值的关系候选不会自动进入。访问、文件路径和导航成功都不能冒充事实证据。
- D1 task relevance 已与 confidence/importance/历史 usefulness 解耦；branch/scope 内 FTS 可找回近期候选之外的精确旧 Atom，prime 会检查完整有界 D1 列表，只让 `task relevance > 0.25` 且属于最强相关簇的候选进入首轮 working set，再按完整治理优先级排序。只有已通过独立任务门、由强语义关系发现且 route strength 达到硬门槛的必要 Atom，可以与种子一同跨越普通相关性断层；普通弱相关尾部仍只留在索引。D1 不调用向量，正式本地 BGE 仍只作为已导航分支 deep search 的语义兜底；同一深搜请求只生成一次查询向量并复用于授权 scope。
- 正式迁移前的只读预检和隔离副本演练已通过；正式提交后再次验证 40 个业务 atom、5 个内部根和 11 个资源，源 V2 index/manifest 未变化，配置与 locator 均指向 v3，应用恢复源检查通过。
- 迁移后的回滚不再先登记、重启后才发现失败：内部维护流程会用当前运行中的同一 V3 repository 实时核对迁移 snapshot、V2 回滚源和 V3 validation hash；任一侧变化都不生成 pending rollback，启动阶段仍保留第二次强校验。普通记忆文件页不展示这些底层维护状态。
- 迁移页独立显示固定本地 BGE 模型的资产状态。当前正式模型为固定 revision `75c43b069aac4d136ba6bc1122f995fedcfd2781`，运行阶段零网络请求；Electron 主进程将 Transformers.js 保持为外部 Node 运行依赖，避免构建时误选浏览器/WASM 后端。
- `.littlesheep` 只是默认数据根名称，完整应用数据可整体迁移；`workplace/` 只是默认工作区子目录。
- 当前 LS 核心源码保持只读；Skill 合并、停用、归档或删除需要来源、引用、验证和回滚证据。
- 当前 DeepSeek 活动模型的四项 Provider 校准、普通请求、显式单只读工具、自主单只读工具、Flash Provider 工具续轮、有界多工具提议路径和真实跨重启最终回答连续性均已完成。精确性按模型和请求形态声明：Flash 工具协议校准矩阵 `15/15` 为 `exact_match`，最新显式与自主单工具请求也逐请求 `exact_match`；最新摘要续答最终请求仍为 `within_tolerance`。Pro 普通请求保持 exact，Pro 工具协议与 OpenAI/GLM 模型专用 tokenizer 仍需在实际启用形态下单独校准。定位文件不存在或 Main 未运行时，真实校准必须明确失败，不用 mock 冒充通过。
- 记忆连续以 LS 最终回答为准：仅保存会话、摘要、Atom、Checkpoint 或内部检索成功不算通过；任务续接和直接追问旧信息只有回答级状态 `supported` 才能称为连续。明确追问多个旧值时必须逐项肯定答出，漏答、答错、否定旧值、只记得附带限制或明确说忘了均判为断档；即使回答复述了全部旧值，只要同时声称无法回忆，也必须判为 `discontinuous`。旧值可从真实进入回答 Context 的近期历史、版本化摘要或 active/adopted Atom 证明。字段门既支持固定标签，也能从近期历史、Runtime 精确保真摘要和 active Atom 发现用户实际使用的任意明确字段；Markdown 表格、短数字、布尔值、`executionCount / ticks / completed` 仍要求标签和值精确对应，无关位置出现同一个数字不能冒充命中。真实 DeepSeek 跨重启回答门、两步副作用后的记忆追问、两条独立会话的并行恢复追问、摘要深度 `1 -> 2 -> 3 -> 3` 后仅依赖 `session_summary` 的五字段验收，以及 6 分钟持续任务后的跨模型追问均已通过；正式 2 小时持续负载门也已通过。非字段事实、外部系统副作用和其他 Provider 能力矩阵仍需单独验收。
- Local App API 的长生命周期 SSE 统一每 15 秒发送注释心跳，并在单连接待写缓冲达到 512 KiB 前主动断开慢观察者。普通 Agent run、活动任务订阅和 Checkpoint 续跑的观察连接断开不会取消 Main 中的任务；终端主动命令仍保留断连取消语义。所有 timer、listener 和订阅都必须在关闭、完成或 server stop 时释放。
- 暂时不用决定：更多插件类型、MCP 和发布打包。设置页后台任务控制已经作为连续性能力收口接入，不是新产品范围。

到这里即可停止阅读。正式 V3 数据、桌面基线、活动路由、直接回应 Context、当前 DeepSeek 四项 Provider 能力、普通请求、Flash 工具协议、显式单只读与自主 `glob / grep / read` 矩阵、显式多工具提议路径的精确本地 token 对账、真实 DeepSeek 跨重启回答门、有界连续性纠偏、多轮五字段摘要续答、主动断线恢复、基础两步副作用、短时并行压力、6 分钟持续任务、正式 2 小时持续负载、应用启动恢复和后台任务控制面已有当前证据；Pro 工具协议、非字段事实、真实外部系统副作用和其他 Provider 能力矩阵仍需单独验收。

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

- [开发反馈环提速任务书 2026-08-09](taskbooks/development-feedback-loop-taskbook-2026-08-09.md)：任务级内循环、affected 选择器、重复构建消除和后续状态契约收敛；用于决定下一阶段开发效率工作。
- [拓展工作区性能任务书 2026-08-04](taskbooks/workspace-performance-taskbook-2026-08-04.md)：文件树、代码首帧、Monaco 接管、Git 审阅缓存、后台资源和生产构建体积的专项验收。
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
