# LittleSheep 文档决策入口

最后更新：2026-07-16 11:59:42

本页是正式文档的唯一首要入口。日常决策先看本页，不要从任务书、仓库指南或架构长文开始阅读。

## 现在先做什么

**当前阶段**：Memory v3 阶段 0-5 已在隔离目录完成；阶段 6 已完成同源 D0-D3 管理读取、启动前迁移/回滚、实时回滚安全预检、atom 移动/合并/失效/恢复/导出、首次自动选择、运行中 release、原始数据记录孤儿恢复、commit receipt、隔离 soak、真实 Electron 窗口验收，以及正式 V2 数据的只读预检和隔离迁移/重启/回滚演练。当前 Memory v2 仍是正式运行路径，正式用户数据尚未迁移。

**推荐下一步**：由用户单独决定是否批准正式 Memory v2→v3 数据迁移；未批准前继续保持 v2 权威。真实 Provider 对话校准继续作为独立验收门。

**你现在需要决定的只有一项**：是否允许在正式数据根登记 Memory v3 迁移并重启执行；没有明确批准时不触碰正式用户记忆。

- Provider `/embeddings` 已在 v3 基础设施中默认硬关闭；BGE 是当前平衡默认，multilingual E5 是高质量可选档，两者均已通过显式资产校验和运行阶段零网络请求的真实离线基准。
- 原始数据记录（raw records）保存事件最初落盘的数据，写入后只追加、不改写；它们不代表内容已经是事实。mutation 提交由独立 commit receipt 证明，不回写原始记录；atom 是可治理投影；SQLite 向量目录管理 atom 的路径、层级、FTS、向量、状态和审计，但必须能从持久文件重建。
- 当前正式 V2 数据已通过只读预检和隔离副本演练：40 个业务节点、11 个资源完整迁移，5 个内部 scope root 与业务 atom 分开计数；V3 重启读取、catalog 完整性和回滚均通过，正式源哈希未变化，临时副本已删除。
- 迁移后的回滚不再先登记、重启后才发现失败：管理页会用当前运行中的同一 V3 repository 实时核对迁移 snapshot、V2 回滚源和 V3 validation hash；任一侧变化都不生成 pending rollback，启动阶段仍保留第二次强校验。
- `.littlesheep` 只是默认数据根名称，完整应用数据可整体迁移；`workplace/` 只是默认工作区子目录。
- 当前 LS 核心源码保持只读；Skill 合并、停用、归档或删除需要来源、引用、验证和回滚证据。
- 下一次需要用户明确批准的节点，是现在是否切换正式用户数据。
- 暂时不用决定：新 UI、更多插件类型、MCP 和发布打包。

如果已经批准该方向，到这里即可停止阅读并开始执行。

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

- [原子记忆与内置向量目录任务书 2026-07-15](taskbooks/memory-atom-vector-catalog-taskbook-2026-07-15.md)：Memory v3 原子文件、层级、本地向量目录、迁移与验收。
- [Agent Runtime 连续性任务书 2026-07-14](taskbooks/agent-runtime-continuity-taskbook-2026-07-14.md)：Provider 校准、Context、附件、运行中重入、检查点、后台执行和有界并行。

### 已完成基线

- [总基调、认知架构与仓库基元化任务书 2026-07-15](taskbooks/foundation-cognition-repository-taskbook-2026-07-15.md)
- [核心 Agent 能力任务书 2026-07-13](taskbooks/core-agent-capability-taskbook-2026-07-13.md)

### 专项与历史执行基线

- [Agent 核心与记忆系统任务书 2026-07-14](taskbooks/agent-core-memory-taskbook-2026-07-14.md)
- [核心收敛小任务书 2026-07-13](taskbooks/core-focus-maintenance-taskbook-2026-07-13.md)
- [拓展工作区任务书 2026-07-12](taskbooks/extension-workspace-taskbook-2026-07-12.md)

任务书保存阶段设计和验收记录，不代表全局最新状态。不要通过比较任务书日期判断下一步。

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
