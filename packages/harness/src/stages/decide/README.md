# DECIDE 内部边界

本目录把需求判断拆成可独立维护的契约：

- `contracts.ts`：模型返回结构、依赖和 DECIDE 最小提示契约。
- `normalization.ts`：复杂度、范围上限、步骤、TaskBook 和澄清问题的代码级校准。
- `replan.ts`：只修改目标步骤的局部重规划反馈与合并。

`../decide.ts` 只负责 Context 组装、模型调用和状态路由。模型可以提出判断，但标准/复杂任务是否需要 TaskBook、最大额外范围和已完成步骤保护由代码决定。
