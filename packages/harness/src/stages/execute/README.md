# EXECUTE 内部边界

- `contracts.ts`：依赖、工具循环和输出清洗契约。
- `guidance.ts`：计划、TaskBook、单步骤提示和基础消息装配。
- `prompt.ts`：按普通执行或紧凑自主只读路径装配 EXECUTE System Prompt，不拥有工具执行权。
- `tool-loop.ts`：模型工具循环，并把调用交给统一 Tool Execution Service，负责会话证据归并。
- `failure-policy.ts`：步骤工具选择、阻断失败识别、失败分类和稳定结果排序。
- `runners.ts`：Legacy 与 TaskBook 两条执行入口。
- `task-step-scheduler.ts`：校验步骤依赖、资源封套和副作用，保守选择串行或有界并行波次。
- `task-step-runner.ts`：在独立消息与取消边界中执行一个已调度步骤。
- `task-book-runner.ts`：按依赖波次编排 TaskBook，保护已完成步骤并按任务书顺序稳定归并证据。
- `final-reply.ts`：根据步骤结果按渐进式披露装配最终回复。

`../execute.ts` 只负责请求运行提示并选择执行路径。缺少完整依赖、资源或副作用契约的步骤默认串行；工具不能绕过权限门，失败步骤不能被最终回复覆盖为成功，恢复时已完成且不在重规划目标中的步骤不得重做。
