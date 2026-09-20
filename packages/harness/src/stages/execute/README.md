# EXECUTE 内部边界

- `contracts.ts`：依赖、工具循环和输出清洗契约。
- `guidance.ts`：计划、TaskBook、单步骤提示和基础消息装配。
- `prompt.ts`：按普通执行或紧凑自主只读路径装配 EXECUTE System Prompt，不拥有工具执行权。
- `tool-loop.ts`：模型工具循环，并把调用交给统一 Tool Execution Service，负责会话证据归并。
- `failure-policy.ts`：步骤工具选择、阻断失败识别、失败分类和稳定结果排序。
- `runners.ts`：单步主循环与 TaskBook 两条执行入口。
- `task-step-scheduler.ts`：校验步骤 id、依赖顺序与资源封套，并按计划顺序选择下一个可执行步骤。
- `task-step-runner.ts`：在独立消息与取消边界中执行一个步骤。
- `task-book-runner.ts`：串行编排 TaskBook，保护已完成步骤并按任务书顺序稳定归并证据。
- `final-reply.ts`：根据步骤结果按渐进式披露装配最终回复。

`../execute.ts` 只负责请求运行提示并选择执行路径。计划步骤按顺序串行执行：自动并行波次、资源冲突打包与按波次的降级判定已随第二执行体系删除，只有依赖已完成的步骤才可以开始；工具不能绕过权限门，失败步骤不能被最终回复覆盖为成功，恢复时已完成且不在重规划目标中的步骤不得重做。
