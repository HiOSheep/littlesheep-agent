# LittleSheep 文档决策入口

最后更新：2026-07-15 22:43:54

本页是正式文档的唯一首要入口。日常决策先看本页，不要从任务书、仓库指南或架构长文开始阅读。

## 现在先做什么

**当前阶段**：Memory v3 阶段 0-5 已在隔离目录完成。层级、FTS、本地向量、D0-D3、证据封套、版本化 KnownState、安全迁移和写后有界向量维护均已通过工程验证；当前 Memory v2 仍是正式运行路径，正式用户数据尚未迁移。

**推荐下一步**：进入 Memory v3 阶段 6，让管理 UI 直接操作同一份 atom/catalog，并实现迁移预检、进度、失败恢复、回滚和用户批准入口。真实 Provider 对话校准继续作为独立验收门。

**你现在不需要追加决策**：默认按已确认方案继续设计和实现，但不触碰正式用户记忆。

- Provider `/embeddings` 已在 v3 基础设施中默认硬关闭；BGE 是当前平衡默认，multilingual E5 是高质量可选档，两者均已通过显式资产校验和运行阶段零网络请求的真实离线基准。
- SQLite 向量目录管理 atom 的路径、层级、FTS、向量、状态和审计，但必须能从原子文件重建。
- `.littlesheep` 只是默认数据根名称，完整应用数据可整体迁移；`workplace/` 只是默认工作区子目录。
- 当前 LS 核心源码保持只读；Skill 合并、停用、归档或删除需要来源、引用、验证和回滚证据。
- 下一次需要用户明确批准的节点，是隔离迁移全部通过后切换正式用户数据。
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
