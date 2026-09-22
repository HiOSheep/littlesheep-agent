# EXECUTE 内部边界

最后更新：2026-09-22 16:13:37

- `contracts.ts`：依赖、工具循环和输出清洗契约，并区分模型可见的 `tools` 目录与本轮真正可调用的 `admittedTools`。
- `guidance.ts`：基础消息装配与步骤提示片段；`renderPlanGuidance`/`renderTaskBookGuidance` 把 TaskBook 与计划渲染进主循环提示（不提及已删除的 stage），`renderStepGuidance` 是第二执行体系遗留的步骤契约渲染，当前没有运行期调用方。
- `prompt.ts`：装配 EXECUTE System Prompt，不拥有工具执行权。
- `tool-loop.ts`：唯一主循环——模型工具循环，把调用交给统一 Tool Execution Service，并保留本轮请求消息与工具目录供有界纠正复用。Runtime 控制消息（引用修复、工具边界失败、无进展上限）与 Runtime 尾部一样按位置持久化：它们属于被缓存的请求字节，不记录就会让下一轮回放停在上一条请求的最后一个消息（实测冻结 A2 diff@19/20）。
- `model-transcript.ts`：有序 thinking/tool/text 转录行的发布、重置与关闭。
- `tool-result-persistence.ts`：单轮工具提议与结果的持久化和有界投影，输入先过工具自己的 projector；`toolResultForModel` 对成功和失败都保留有界输出——命令执行器失败时只给 `exit code 1` 会让模型无法诊断（实测：模型因此声称"未捕获到 stdout"）。为了让下一次 run 能按字节回放这次请求，`persistToolCalls` 在工具没有 `persistence.projectInput` 时保存 Provider 的原始参数串（`ToolCall.rawArguments`）、assistant 的文本前言与 `reasoning`，`persistToolResult` 保存模型当时看到的有界文本（`tool_result.modelContent`），`persistRuntimeTailMessages` 把 Runtime 尾部按发送位置存为 `runtimeTail` 消息；带 `webEvidence` 的结果永不保存该文本，网页正文只在本轮进入模型上下文。
- `runners.ts`：单一主循环执行入口；把 `historyChatCount` 交给请求装配器，使"历史占用的请求消息数"与 `history` 条目数不一致时（回放的工具配对会多出消息）主用户回合仍被标在正确位置。
- `side-effect-ledger.ts`、`side-effect-lifecycle.ts`：Runtime 自有的副作用账本及其生命周期适配；只读工具不记账，写能力或未知工具先记账再执行，未结算不得重放。`settlementForResult` 只在工具**返回**失败结果时结算为 `failed`（命令跑完返回非零是已知结果）；服务自己合成的状态（工具抛错、超时/中断、生命周期钩子失败）说明工具从未报告结果、可能已部分生效，仍留在 `unknown` 并阻塞重试与完成。同一次运行内重试已结算失败会得到 `:retryN` 的独立 attempt id（durable kernel 每个 effect id 只允许一次结算），而任何一次成功之后同一操作都会被拒为重复。
- `failure-policy.ts`：阻断失败识别、失败分类和稳定结果排序。

`../execute.ts` 只负责清除回复状态、请求运行提示并把控制权交给单一主循环。TaskBook 步骤执行器（`task-book-runner.ts`、`task-step-runner.ts`、`task-step-scheduler.ts`、`reply-candidate.ts`、`final-reply.ts`、`direct-tool-proposal.ts`）与自动并行波次、资源冲突打包、按波次降级、bounded_loop 升级入口、自动记忆沉淀一起随第二执行体系删除：已持久化的 TaskBook 现在是只读历史，多步骤工作在同一个循环内串行完成。工具不能绕过权限门，失败不能被子循环重试掩盖，已完成副作用不得重放。
