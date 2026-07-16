# LittleSheep 文档决策入口

最后更新：2026-07-16 17:04:25

本页是正式文档的唯一首要入口。日常决策先看本页，不要从任务书、仓库指南或架构长文开始阅读。

## 现在先做什么

**当前阶段**：正式 Memory v2→v3 迁移已于 2026-07-16 完成，活动 backend 与运行配置均为 v3。正式数据包含 40 个业务 atom、5 个内部 scope root 和 11 个资源；SQLite Catalog integrity 为 `ok`。固定 BGE 模型已完成 24,451,050 字节和 SHA-256 校验，45 个 atom 均已生成 512 维本地向量，状态为 45 ready、0 pending、0 failed。

**推荐下一步**：先由用户直接验收正式 V3 的记忆树、会话读取与重启体验，再进行 OpenAI、DeepSeek、GLM 真实 Provider 对话校准。首次产生新的 V3 权威来源或 atom 后，无损回滚窗口会按设计关闭，避免新记忆被静默丢弃。

**你现在不需要再次决定迁移**：迁移、模型准备、向量回填和应用重启已经完成。下一项需要明确选择的高价值节点，是何时开始真实 Provider 与长任务验收。

- Provider `/embeddings` 已在 v3 基础设施中默认硬关闭；BGE 是当前平衡默认，multilingual E5 是高质量可选档，两者均已通过显式资产校验和运行阶段零网络请求的真实离线基准。
- Memory v3 使用四层语义：对话原始来源保存用户输入与对话区可见内容，写入后不改写；投影变更记录保存 `MemoryUpdateEvent + mutation`，只服务幂等、恢复和审计；atom 是可去重、合并、调层级、失效、恢复和重建的当前语义投影；run working set 只决定本轮介入。SQLite 向量目录管理 atom 的路径、层级、FTS、向量、状态和审计，但必须能从持久文件重建。
- 正式迁移前的只读预检和隔离副本演练已通过；正式提交后再次验证 40 个业务 atom、5 个内部根和 11 个资源，源 V2 index/manifest 未变化，配置与 locator 均指向 v3，应用恢复源检查通过。
- 迁移后的回滚不再先登记、重启后才发现失败：管理页会用当前运行中的同一 V3 repository 实时核对迁移 snapshot、V2 回滚源和 V3 validation hash；任一侧变化都不生成 pending rollback，启动阶段仍保留第二次强校验。
- 迁移页独立显示固定本地 BGE 模型的资产状态。当前正式模型为固定 revision `75c43b069aac4d136ba6bc1122f995fedcfd2781`，运行阶段零网络请求；Electron 主进程将 Transformers.js 保持为外部 Node 运行依赖，避免构建时误选浏览器/WASM 后端。
- `.littlesheep` 只是默认数据根名称，完整应用数据可整体迁移；`workplace/` 只是默认工作区子目录。
- 当前 LS 核心源码保持只读；Skill 合并、停用、归档或删除需要来源、引用、验证和回滚证据。
- 下一次需要用户明确批准的节点，是开始真实 Provider 与长任务验收，或在无新增 V3 权威写入前主动选择回滚。
- 暂时不用决定：新 UI、更多插件类型、MCP 和发布打包。

到这里即可停止阅读，并直接通过桌面快捷方式验收当前正式 V3。

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
