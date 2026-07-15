# LittleSheep 文档决策入口

最后更新：2026-07-15

本页是正式文档的唯一首要入口。日常决策先看本页，不要从任务书、仓库指南或架构长文开始阅读。

## 现在先做什么

**当前阶段**：仓库基元化阶段 0-7 已完成，版本化 LLM Call Contract、Context 强制约束、记忆意图闸门和持续维护质量门已经落地。

**推荐下一步**：使用已经配置 API key 的 OpenAI、DeepSeek 和 GLM 逐家完成真实 Provider 校准，验证最小对话、reasoning、工具调用、中断、usage 和上下文账本映射。

**你现在只需要决定**：是否进入真实 Provider 校准阶段。

- 推荐：进入。它是统一 Tool Execution Service、运行时连续执行和 MCP 之前的真实性基础。
- 前提：至少有一家供应商的可用 API key；未配置的供应商可以暂时跳过。
- 暂时不用决定：新 UI、更多插件类型、MCP 和发布打包，它们都有更靠后的依赖顺序。

如果已经批准该方向，到这里即可停止阅读并开始执行。

## 需要确认依据时

只按下面顺序展开：

1. [项目状态](decision/project-status.md)：当前真正实现了什么、验证结果和仍未完成的边界。
2. [架构决策报告](decision/architecture-decision-report.md)：为什么推荐 Provider → Tool Execution Service → Runtime 连续性 → Mode/MCP/插件。

当前事实与测试数字只以项目状态为准，演进顺序只以架构决策报告为准。

## 需要修改长期方向时

- [架构原则](principles/architecture-principles.md)：产品使命、LLM 与 Agent 分工、Context、Memory、Tools、Workflow、插件和数据边界。
- [核心 Agent 流程规范](principles/core-agent-flow-guidelines.md)：TaskBook、执行、验证、恢复、记忆介入和连续性约束。
- [UI 交互规范](principles/ui-interaction-guidelines.md)：渐进式披露、动画、层级、浮层、导航和交互一致性。

这些文档是稳定约束，不用于查看最新测试数字。

## 已决定方向后再看任务书

### 当前主线

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
