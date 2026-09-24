# @littlesheep/llm

最后更新：2026-09-24 22:32:00

提供 OpenAI-compatible 的聊天、流式输出、重试、usage 和请求类型适配。

## 职责与边界

- 公开入口是 `src/index.ts`；`types.ts` 拥有协议类型（`ChatRequest`/`ChatMessage`/`ChatResponse`/`StreamChunk`/`EmbedRequest`/`EmbedResponse`/`LlmClient`），`client.ts` 负责请求，`retry.ts` 负责有界重试，`schema.ts` 负责响应校验，`dsml-tool-calls.ts` 与 `dsml-stream-scanner.ts` 负责把供应商以文本返回的 DSML 工具调用恢复为结构化调用（含跨 chunk 切分），`transport-timing.ts` 是内部计时 helper（不导出）。
- **重试契约（UX-21）**：`maxAttempts` 是**总请求数**，默认 `DEFAULT_MAX_RETRIES + 1` = **首次请求 + 最多 5 次重试**（`maxRetries` 是等价写法，只在未传 `maxAttempts` 时生效）。`classifyFailure` 把失败分成 `transient`（网络失败、5xx、408、空 choices）、`rate_limited`（429）、`auth`（401/403）、`request`（其他 4xx）、`cancelled` 与 `unknown`，**只有前两类会被重放**；认证、参数、取消和无法判定的失败第一次就抛给上层（不盲目重试，也不重放可能已产生副作用的调用）。退避为指数 + 抖动，`Retry-After`（秒数或 HTTP 日期，来自 429/503）作为**下限**抬高本次等待，单次等待受 `maxDelayMs`（默认 30 s）封顶，因此 5 次重试的最坏等待约 15.5 s。等待期间监听 `AbortSignal`：取消后立即停止等待并抛 `AbortError`，不再发起下一次请求。每次重试前调用 `onRetry({ retry, maxRetries, delayMs, failureClass, status })`，供上层显示"第 n 次重试 / 最多 5 次"并记账；`attachTransportUsage` 同时给每次成功调用带上 `transportAttempt` 与 `observedAttemptCount`，隐藏重试不会被算成"单次调用"。
- DSML 的三层保护（CE-11 的现行契约，回归在 `client.test.ts`）：**完整且只含工具调用的信封**恢复为结构化调用，并把已流出的文本用 `reset` 撤回；**畸形/截断/不在授权工具内的标记**在流结束时以 `reset` + `LlmError(502)` 失败关闭，被撤回的文本不会成为模型回答；**围栏、行内与转义示例**保持惰性，既不触发撤回也不被解析成调用。流式扫描器只认 `calls`/`tool_calls` 开头（因此正文先流、随后到达的 `invoke` 会在结束时统一撤回），判定与发布边界共用 `containsUnquotedDsmlControlMarkup`，二者结论一致。
- 只负责 Provider 通信和协议归一化，不决定 Workflow、工具权限、Context 来源或长期状态。
- 禁止把供应商密钥写入日志、快照或错误正文。

## 依赖与数据

- 本包没有任何 workspace 依赖（`package.json` 只依赖 `zod`），协议类型自带于 `src/types.ts`；由上层 Context/Harness/Runner 决定何时调用。
- 不持久化会话，usage 只作为带来源的调用结果返回。

## 测试与修改定位

- 客户端、请求体、流式、中断、reasoning、DSML 恢复和重试测试位于 `src/client.test.ts`（含截断/畸形标记失败关闭、无信封 `invoke`、未注册工具与文档示例惰性的流式用例）；DSML 解析与增量扫描分别位于 `src/dsml-tool-calls.test.ts` 与 `src/dsml-stream-scanner.test.ts`。
- 重试策略本身在 `src/retry.test.ts`：默认首次请求 + 5 次重试、`onRetry` 的编号与计划等待、各类失败的分类与"不重放"断言、`Retry-After` 下限与 `maxDelayMs` 封顶、取消前不发起请求、退避期间取消立即返回（该用例用 5 s 退避 + 20 ms 取消，断言总耗时 < 1 s）。客户端测试的固定装置显式传 `retry: { maxAttempts: 3, baseDelayMs: 1, jitter: false }`，避免失败路径睡满生产退避。
- 新 Provider 差异优先通过能力声明和协议适配解决，不向上泄漏分支。
