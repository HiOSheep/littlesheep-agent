# EXECUTE 内部边界

- `contracts.ts`：依赖、工具循环和输出清洗契约。
- `guidance.ts`：基础消息装配与计划提示片段。
- `prompt.ts`：装配 EXECUTE System Prompt，不拥有工具执行权。
- `tool-loop.ts`：模型工具循环，并把调用交给统一 Tool Execution Service，负责会话证据归并。
- `failure-policy.ts`：阻断失败识别、失败分类和稳定结果排序。
- `runners.ts`：单一主循环执行入口。
- `final-reply.ts`：仍被 REPLY 的旧检查点续答路径使用；它服务的 TaskBook 步骤执行器已删除。
- `direct-tool-proposal.ts`：仍被其单测覆盖的显式工具提议解析；生产执行路径已随步骤执行器删除。

`../execute.ts` 只负责请求运行提示并把控制权交给单一主循环。TaskBook 步骤执行器（`task-book-runner.ts`、`task-step-runner.ts`、`task-step-scheduler.ts`、`reply-candidate.ts`）与自动并行波次、资源冲突打包、按波次降级、bounded_loop 升级入口、自动记忆沉淀一起随第二执行体系删除：已持久化的 TaskBook 现在是只读历史，多步骤工作在同一个循环内串行完成。工具不能绕过权限门，失败不能被子循环重试掩盖，已完成副作用不得重放。
