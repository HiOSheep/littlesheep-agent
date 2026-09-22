# EXECUTE 内部边界

最后更新：2026-09-22 13:10:04

- `contracts.ts`：依赖、工具循环和输出清洗契约，并区分模型可见的 `tools` 目录与本轮真正可调用的 `admittedTools`。
- `guidance.ts`：基础消息装配与步骤提示片段；`renderPlanGuidance`/`renderTaskBookGuidance` 把 TaskBook 与计划渲染进主循环提示（不提及已删除的 stage），`renderStepGuidance` 是第二执行体系遗留的步骤契约渲染，当前没有运行期调用方。
- `prompt.ts`：装配 EXECUTE System Prompt，不拥有工具执行权。
- `tool-loop.ts`：唯一主循环——模型工具循环，把调用交给统一 Tool Execution Service，并保留本轮请求消息与工具目录供有界纠正复用。
- `model-transcript.ts`：有序 thinking/tool/text 转录行的发布、重置与关闭。
- `tool-result-persistence.ts`：单轮工具提议与结果的持久化和有界投影，输入先过工具自己的 projector。
- `side-effect-ledger.ts`、`side-effect-lifecycle.ts`：Runtime 自有的副作用账本及其生命周期适配；只读工具不记账，写能力或未知工具先记账再执行，未结算不得重放。
- `failure-policy.ts`：阻断失败识别、失败分类和稳定结果排序。
- `runners.ts`：单一主循环执行入口。

`../execute.ts` 只负责清除回复状态、请求运行提示并把控制权交给单一主循环。TaskBook 步骤执行器（`task-book-runner.ts`、`task-step-runner.ts`、`task-step-scheduler.ts`、`reply-candidate.ts`、`final-reply.ts`、`direct-tool-proposal.ts`）与自动并行波次、资源冲突打包、按波次降级、bounded_loop 升级入口、自动记忆沉淀一起随第二执行体系删除：已持久化的 TaskBook 现在是只读历史，多步骤工作在同一个循环内串行完成。工具不能绕过权限门，失败不能被子循环重试掩盖，已完成副作用不得重放。
