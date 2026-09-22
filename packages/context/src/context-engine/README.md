# Context Engine 内部边界

最后更新：2026-09-22 19:30:44

本目录实现 `ContextEngine` 背后的确定性上下文装配基元，外部调用方继续使用 `../engine.ts`。

- `contracts.ts`：公开常量、类型和错误契约，含 `evictionScope` 与 `ContextBudgetExceededError`。
- `candidates.ts`：候选推导、校验、排序和来源分类。
- `contract-policy.ts`：按单次 `LlmCallContract` 过滤候选与 Prompt segment；必需来源缺失或越权时默认拒绝组装请求。
- `assembly.ts`：根据候选与淘汰集合装配最终请求。
- `budget.ts`：模型窗口、输出保留量、压缩阈值、淘汰范围和模型引用解析。
- `append-only.ts`：`appended-only` 下"已投递单元"的账本，为调用方保护已经发出的候选。
- `eviction.ts`：按优先级与稳定顺序淘汰可选候选，同 `evictionGroup` 的成员一起淘汰；**`pinned` 的候选不参与淘汰**（只有调用契约能按 kind 丢弃它）。两者是不同的问题：契约决定一次调用"能读什么"，淘汰只负责把超目标的提示词压回目标以内；任务区间被 `pinned` 之后，超阶段软目标但仍在硬窗口内的请求原样发出，而不是悄悄失去前缀。
- `fit.ts`：把已装配请求拟合进 token 预算；精确计数与保守估算不可互换，两者按同一顺序丢弃同一批可选单元，宁可见失败也不静默缩减调用方已发送的内容。它同时回报淘汰前的 `promptTokensBeforeFit`，让调用方判断这次淘汰是**模型窗口**造成的（应建议压缩）还是**阶段软目标**造成的（不应建议）。
- `reuse-cache.ts`：内容寻址的本地复用缓存；装配输入字节一致时复用淘汰决策、计数和估算结果。
- `counting.ts`：精确计数器能力匹配和不可展示的保守安全估算。
- `snapshots.ts`：Context 与模型请求的有界、脱敏、可追溯快照，并持久化本次完整调用契约。

Context Engine 不拥有会话、记忆、附件或工具结果，只消费调用方显式提供的候选。新增来源时必须明确 `kind`、`source`、`scope`、优先级、是否必需和敏感性；没有可验证 tokenizer 时，不得把字符估算展示成实际 token 占用。测试位于 `../engine.test.ts`，必须覆盖候选级和 segment 级契约隔离。
