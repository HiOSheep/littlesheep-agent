# LittleSheep 文档决策入口

最后更新：2026-07-29 13:45:17

本页是正式文档的唯一首要入口。日常决策先看本页，不要从任务书、仓库指南或架构长文开始阅读。

## 现在先做什么

**当前阶段**：Memory v3 阶段 0-26、正式数据迁移、本地向量目录、动态 working set、关系导航、shadow Git 检查点、退出冻结、工具调用级并行、运行时事件安全边界、TaskBookPatch、Runner 检查点续跑和应用启动恢复控制面、逻辑容器权限及开发环境版本管理已有工程基线。语义活动已收敛为 `respond / execute / clarify`；直接回应使用紧凑 Prompt 与有界历史，不再默认携带执行专用 workspace、Workflow、reasoning 和上一轮工具详情。这一批改动已通过本地完整质量门，具体证据只看 [项目状态](decision/project-status.md)。

**推荐下一步**：替换当前无效的 DeepSeek 密钥并完成真实 Provider 校准；并行推进 TaskBook 步骤级并行和后台执行控制面。运行时事件前端入口与应用启动检查点恢复控制面已经形成工程闭环，但真实 Electron 崩溃/重启长任务仍需独立验收。权限定义继续保持“行为 profile 与权限策略正交”，不要再把编程当作权限模式。

**当前权限决策**：产品语义上 LS 是 Agent 的容器，活动完整应用数据根（默认 `.littlesheep`）是容器边界，`workplace/` 是容器内的默认工作区；当前桌面实现是 Main 的逻辑边界，不是实际 Docker/OS 进程沙箱。完全访问只对容器内读、写、改、删、执行免批准；研究只对容器内读取免批准；受限所有操作都需批准；容器外或范围不明三档都需批准。外部工作区启动 run 时先跳过自动索引，用户主动的 UI 预览/保存仍与 Agent 授权分开。核心源码另有不可绕过的宿主级只读保护。

**你现在不需要再次决定迁移**：迁移、模型准备、向量回填和应用重启已经完成。2026-07-29 的脱敏真实请求确认 DeepSeek 密钥能够被应用读取，但官方端点返回 HTTP 401 `invalid key`；OpenAI/GLM 仍无可用测试密钥。受控 mock 只能证明首轮注入、KnownState、反馈、EVOLVE/CAPTURE 和重启召回的本地结构连续性，不能替代真实模型验收。

- Provider `/embeddings` 已在 v3 基础设施中默认硬关闭；BGE 是当前平衡默认，multilingual E5 是高质量可选档，两者均已通过显式资产校验和运行阶段零网络请求的真实离线基准。
- Memory v3 使用四层语义：对话原始来源保存用户输入与对话区可见内容，写入后不改写；投影变更记录保存 `MemoryUpdateEvent + mutation`，只服务幂等、恢复和审计；atom 是可去重、合并、调层级、失效、恢复和重建的当前语义投影；run working set 只决定本轮介入。SQLite 向量目录管理 atom 的路径、层级、FTS、向量、状态和审计，但必须能从持久文件重建。
- 记忆文件位于哪里不是注入依据。层级先缩小候选范围；Runtime 再按当前 task relevance、scope、权威、认识状态、confidence、importance、verified usefulness、时效、routing/relationship relevance 和预算选择少量 Atom，并在执行中按需展开、释放或重新激活。高相关种子可在同 branch/scope/subtree 内沿有方向、有证据的一跳关系发现必要邻接 Atom；`similar-to`、跨 scope、过期、争议、低置信或无独立任务价值的关系候选不会自动进入。访问、文件路径和导航成功都不能冒充事实证据。
- D1 task relevance 已与 confidence/importance/历史 usefulness 解耦；branch/scope 内 FTS 可找回近期候选之外的精确旧 Atom，prime 会检查完整有界 D1 列表，只让 `task relevance > 0.25` 且属于最强相关簇的候选进入首轮 working set，再按完整治理优先级排序。只有已通过独立任务门、由强语义关系发现且 route strength 达到硬门槛的必要 Atom，可以与种子一同跨越普通相关性断层；普通弱相关尾部仍只留在索引。D1 不调用向量，正式本地 BGE 仍只作为已导航分支 deep search 的语义兜底；同一深搜请求只生成一次查询向量并复用于授权 scope。
- 正式迁移前的只读预检和隔离副本演练已通过；正式提交后再次验证 40 个业务 atom、5 个内部根和 11 个资源，源 V2 index/manifest 未变化，配置与 locator 均指向 v3，应用恢复源检查通过。
- 迁移后的回滚不再先登记、重启后才发现失败：内部维护流程会用当前运行中的同一 V3 repository 实时核对迁移 snapshot、V2 回滚源和 V3 validation hash；任一侧变化都不生成 pending rollback，启动阶段仍保留第二次强校验。普通记忆文件页不展示这些底层维护状态。
- 迁移页独立显示固定本地 BGE 模型的资产状态。当前正式模型为固定 revision `75c43b069aac4d136ba6bc1122f995fedcfd2781`，运行阶段零网络请求；Electron 主进程将 Transformers.js 保持为外部 Node 运行依赖，避免构建时误选浏览器/WASM 后端。
- `.littlesheep` 只是默认数据根名称，完整应用数据可整体迁移；`workplace/` 只是默认工作区子目录。
- 当前 LS 核心源码保持只读；Skill 合并、停用、归档或删除需要来源、引用、验证和回滚证据。
- 下一项外部条件是替换可用的 DeepSeek 凭证，或提供 OpenAI/GLM 凭证，并确定可接受的测试模型与成本上限；凭证无效或缺失时继续保持真实 Provider 门未完成，不用 mock 冒充通过。
- 暂时不用决定：新 UI、更多插件类型、MCP 和发布打包。

到这里即可停止阅读。正式 V3 数据、桌面基线、活动路由、直接回应 Context 与应用启动恢复控制面已有本地绿色证据；真实 Provider 能力和真实跨重启长任务仍必须单独验收。

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
