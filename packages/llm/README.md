# @littlesheep/llm

最后更新：2026-09-22 12:47:49

提供 OpenAI-compatible 的聊天、流式输出、重试、usage 和请求类型适配。

## 职责与边界

- 公开入口是 `src/index.ts`；`types.ts` 拥有协议类型（`ChatRequest`/`ChatMessage`/`ChatResponse`/`StreamChunk`/`EmbedRequest`/`EmbedResponse`/`LlmClient`），`client.ts` 负责请求，`retry.ts` 负责有界重试，`schema.ts` 负责响应校验，`dsml-tool-calls.ts` 与 `dsml-stream-scanner.ts` 负责把供应商以文本返回的 DSML 工具调用恢复为结构化调用（含跨 chunk 切分），`transport-timing.ts` 是内部计时 helper（不导出）。
- 只负责 Provider 通信和协议归一化，不决定 Workflow、工具权限、Context 来源或长期状态。
- 禁止把供应商密钥写入日志、快照或错误正文。

## 依赖与数据

- 本包没有任何 workspace 依赖（`package.json` 只依赖 `zod`），协议类型自带于 `src/types.ts`；由上层 Context/Harness/Runner 决定何时调用。
- 不持久化会话，usage 只作为带来源的调用结果返回。

## 测试与修改定位

- 客户端、请求体、流式、中断、reasoning、DSML 恢复和重试测试位于 `src/client.test.ts`；DSML 解析与增量扫描分别位于 `src/dsml-tool-calls.test.ts` 与 `src/dsml-stream-scanner.test.ts`。
- 新 Provider 差异优先通过能力声明和协议适配解决，不向上泄漏分支。
