# LittleSheep 文档索引

## 当前阶段

LittleSheep 已形成以单一主循环、受控工具执行和显式权限边界为核心的本地 Agent。当前工作聚焦于完成既有 Runtime、界面与 coding-agent 约束评估；项目实现和未完成边界由[项目状态](decision/README.md)中的唯一状态页维护。

## 当前方向

- [前端简洁高效化](taskbooks/frontend-simplification-taskbook-2026-09-27.md)：进行中的界面整理与验证。
- [Runtime 自主执行与沙箱评估](taskbooks/runtime-autonomy-sandbox-evaluation-taskbook-2026-09-27.md)：首轮审阅未通过，按任务书补正后复核。
- [单层子 Agent 与执行效率](taskbooks/single-level-subagent-taskbook-2026-09-24.md)：方案仍未实现，效率收益未证明。
- [UI/UX 架构变更候选](decision/ui-ux-architecture-candidates-2026-09-28.md)：提案，等待用户决定是否进入架构工作。

## 文档入口

- [Decision](decision/README.md)：当前状态、重要取舍与待决方向。
- [Principles](principles/README.md)：跨版本有效的产品、架构和交互约束。
- [Taskbooks](taskbooks/README.md)：仍在执行或评估中的工作计划与验收。
- [Reference](reference/README.md)：代码导航、协议、专项验收和需要复用的基线。

## 快速定位

- 现在实现了什么、主要未完成边界： [项目状态](decision/project-status.md)。
- 从需求定位源码、package、测试与验证入口： [仓库指南](reference/repository-guide.md)。
- 状态机与恢复转移： [Core Flow 状态契约](reference/core-flow-state-contract.md)。
- 缓存红线与实测账本： [缓存验收规程](reference/cache-95-acceptance.md)。
- 界面原则： [UI 交互规范](principles/ui-interaction-guidelines.md)。

分类索引维护各类文档链接；这里不复制项目状态、历史退役记录或逐次执行证据。
