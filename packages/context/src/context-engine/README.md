# Context Engine 内部边界

本目录实现 `ContextEngine` 背后的确定性上下文装配基元，外部调用方继续使用 `../engine.ts`。

- `contracts.ts`：公开常量、类型和错误契约。
- `candidates.ts`：候选推导、校验、排序和来源分类。
- `contract-policy.ts`：按单次 `LlmCallContract` 过滤候选与 Prompt segment；必需来源缺失或越权时默认拒绝组装请求。
- `assembly.ts`：根据候选与淘汰集合装配最终请求。
- `budget.ts`：模型窗口、输出保留量、压缩阈值和模型引用解析。
- `eviction.ts`：按优先级与稳定顺序淘汰可选候选。
- `counting.ts`：精确计数器能力匹配和不可展示的保守安全估算。
- `snapshots.ts`：Context 与模型请求的有界、脱敏、可追溯快照，并持久化本次完整调用契约。

Context Engine 不拥有会话、记忆、附件或工具结果，只消费调用方显式提供的候选。新增来源时必须明确 `kind`、`source`、`scope`、优先级、是否必需和敏感性；没有可验证 tokenizer 时，不得把字符估算展示成实际 token 占用。测试位于 `../engine.test.ts`，必须覆盖候选级和 segment 级契约隔离。
