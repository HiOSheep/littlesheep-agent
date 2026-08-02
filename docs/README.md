# LittleSheep 文档决策入口

最后更新：2026-08-02 22:27:11

本页是正式文档的唯一首要入口。日常决策先看本页，不要从任务书、仓库指南或架构长文开始阅读。

## 现在先做什么

**当前阶段**：Memory v3 阶段 0-26、正式数据迁移、本地向量目录、动态 working set、关系导航、shadow Git 检查点、退出冻结、统一 Tool Execution Service、工具调用级与 TaskBook 步骤级有界并行、运行时事件安全边界、TaskBookPatch、Runner 检查点续跑、应用启动恢复控制面，以及活动任务快照、暂停/继续/中断、托盘、三档关闭策略和设置页“应用与后台”已有工程基线。语义活动已收敛为 `respond / execute / clarify`；直接回应使用紧凑 Prompt 与有界历史，只在明确追问进度、结果、耗时、错误或恢复时介入上一轮执行摘要。当前使用的 DeepSeek 模型已完成 chat、continuity、tool、abort 四项真实校准，V4 官方 tokenizer 的本地精确计数与同请求 Provider 对账也已完成。隔离数据根中的真实 Electron 已通过跨重启回答、活动任务 SSE、托盘恢复、暂停/继续、强制终止后 Checkpoint 恢复、模型热切换和中断 Checkpoint 七项验收；最终回答必须承接重启前目标且连续性状态为 `supported`。具体证据只看 [项目状态](decision/project-status.md)。

**推荐下一步**：优先用真实 DeepSeek 多步骤长任务验收 TaskBook、工具副作用、跨重启回答连续、网络断线恢复和长期资源回落；隔离 Electron 生命周期基线已经完成，不再重复把它列为未开始。并行记录单工具轻量任务的 Context 成本：当前已消除重复工具轮次和额外 VERIFY/最终回复调用，但真实 `glob` 基线仍需 `DECIDE 1 次 + EXECUTE 2 次`，后续应继续缩减这条路径的 Prompt，而不撤掉权限、工具证据和结构验证。权限定义继续保持“行为 profile 与权限策略正交”，不要再把编程当作权限模式。

**当前权限决策**：产品语义上 LS 是 Agent 的容器，活动完整应用数据根（默认 `.littlesheep`）是容器边界，`workplace/` 是容器内的默认工作区；当前桌面实现是 Main 的逻辑边界，不是实际 Docker/OS 进程沙箱。从其他模式切换到完全访问时先用红色危险按钮确认一次；确认后容器内外及范围不明的读、写、改、删、执行均免逐次批准。研究只对容器内读取免批准；受限所有操作都需批准。外部工作区在研究/受限模式下先跳过自动索引，完全访问可直接继续。核心源码只读和危险命令硬拒绝不受模式影响。

**你现在不需要再次决定迁移或替换 DeepSeek 凭证**：迁移、模型准备、向量回填和应用重启已完成。2026-07-31 真实桌面验收中，直接回应仅发生 1 次 `reply` 模型请求，耗时 `3.727s`，Provider usage 为 `975 + 12 = 987`，精确返回指定内容；显式 `glob` 任务只调用 1 次工具，结构验证为 `0ms`，总耗时 `13.666s`，3 次模型请求累计报告 `16,316` tokens。随后运行中 Main 完成四项脱敏校准：chat `872ms`、continuity `1,140ms`、tool `1,680ms`、abort `389ms`，全部通过；中断在收到流式 chunk 后正确返回 `AbortError`。2026-08-01 应用内正常 `/run` 又完成 DeepSeek V4 本地 prompt `968` 与 Provider prompt `968` 的零差值对账。这些证据证明当前 DeepSeek 配置和本地精确计数真实可用，不外推为 OpenAI/GLM 或真实后台长任务已验收。

- Provider `/embeddings` 已在 v3 基础设施中默认硬关闭；BGE 是当前平衡默认，multilingual E5 是高质量可选档，两者均已通过显式资产校验和运行阶段零网络请求的真实离线基准。
- Memory v3 使用四层语义：对话原始来源保存用户输入与对话区可见内容，写入后不改写；投影变更记录保存 `MemoryUpdateEvent + mutation`，只服务幂等、恢复和审计；atom 是可去重、合并、调层级、失效、恢复和重建的当前语义投影；run working set 只决定本轮介入。SQLite 向量目录管理 atom 的路径、层级、FTS、向量、状态和审计，但必须能从持久文件重建。
- 记忆文件位于哪里不是注入依据。层级先缩小候选范围；Runtime 再按当前 task relevance、scope、权威、认识状态、confidence、importance、verified usefulness、时效、routing/relationship relevance 和预算选择少量 Atom，并在执行中按需展开、释放或重新激活。高相关种子可在同 branch/scope/subtree 内沿有方向、有证据的一跳关系发现必要邻接 Atom；`similar-to`、跨 scope、过期、争议、低置信或无独立任务价值的关系候选不会自动进入。访问、文件路径和导航成功都不能冒充事实证据。
- D1 task relevance 已与 confidence/importance/历史 usefulness 解耦；branch/scope 内 FTS 可找回近期候选之外的精确旧 Atom，prime 会检查完整有界 D1 列表，只让 `task relevance > 0.25` 且属于最强相关簇的候选进入首轮 working set，再按完整治理优先级排序。只有已通过独立任务门、由强语义关系发现且 route strength 达到硬门槛的必要 Atom，可以与种子一同跨越普通相关性断层；普通弱相关尾部仍只留在索引。D1 不调用向量，正式本地 BGE 仍只作为已导航分支 deep search 的语义兜底；同一深搜请求只生成一次查询向量并复用于授权 scope。
- 正式迁移前的只读预检和隔离副本演练已通过；正式提交后再次验证 40 个业务 atom、5 个内部根和 11 个资源，源 V2 index/manifest 未变化，配置与 locator 均指向 v3，应用恢复源检查通过。
- 迁移后的回滚不再先登记、重启后才发现失败：内部维护流程会用当前运行中的同一 V3 repository 实时核对迁移 snapshot、V2 回滚源和 V3 validation hash；任一侧变化都不生成 pending rollback，启动阶段仍保留第二次强校验。普通记忆文件页不展示这些底层维护状态。
- 迁移页独立显示固定本地 BGE 模型的资产状态。当前正式模型为固定 revision `75c43b069aac4d136ba6bc1122f995fedcfd2781`，运行阶段零网络请求；Electron 主进程将 Transformers.js 保持为外部 Node 运行依赖，避免构建时误选浏览器/WASM 后端。
- `.littlesheep` 只是默认数据根名称，完整应用数据可整体迁移；`workplace/` 只是默认工作区子目录。
- 当前 LS 核心源码保持只读；Skill 合并、停用、归档或删除需要来源、引用、验证和回滚证据。
- 当前 DeepSeek 活动模型的四项 Provider 校准与 V4 本地精确 token 同请求对账已完成。OpenAI/GLM 只在实际配置凭证并进入用户选择范围后再做同等校准和模型专用 tokenizer 验证；定位文件不存在或 Main 未运行时，`verify:provider` 应明确失败，不用 mock 冒充通过。
- 记忆连续以最终回答为准：仅保存会话、摘要、Atom 或 Checkpoint 不算通过；显式“继续/恢复”只有回答级状态 `supported` 才能称为连续。当前隔离 Electron 已通过该门，真实 DeepSeek 长任务仍需同样标准验收。
- 暂时不用决定：更多插件类型、MCP 和发布打包。设置页后台任务控制已经作为连续性能力收口接入，不是新产品范围。

到这里即可停止阅读。正式 V3 数据、桌面基线、活动路由、直接回应 Context、当前 DeepSeek 四项 Provider 能力与精确本地 token 对账、应用启动恢复、后台任务控制面、设置页入口和隔离真实 Electron 跨重启回答门已有当前证据；真实 DeepSeek 多步骤长任务、持续负载、其他 Provider 能力矩阵和单工具 Context 成本仍需单独验收。

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
