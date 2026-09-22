# @littlesheep/context

最后更新：2026-09-22 19:30:44

为单次 LLM 调用选择、预算和装配 Context，并生成可追溯的请求快照。

## 职责与边界

- 公开入口是 `src/index.ts`；`src/engine.ts` 是稳定 facade（`ContextEngine.prepare`），候选、契约过滤、预算、装配、淘汰、计数、复用缓存和快照实现位于 `src/context-engine/`；`src/request-prefix-diff.ts` 提供只含 id/kind/hash/计数/原因的脱敏请求差异。
- 拥有候选规范化、优先级、预算、淘汰、计数和快照；不拥有记忆或会话存储。
- 主循环的预算淘汰在 `evictionScope: 'appended-only'` 下运行：可以丢弃本次请求追加的内容，绝不移动已经发出的消息；若已发送的前缀本身超出模型窗口，请求以 `ContextBudgetExceededError` 显式失败，而不是静默抽掉中间消息。
- **淘汰必须报告压力**：`fitRequestToBudget` 回报淘汰前的 `promptTokensBeforeFit`，`compressionRecommended` 在"淘汰前的提示词超过**模型窗口**"时为真；否则淘汰后的提示词必然在比例线以下，会话就会每回合挤掉一点而永不触发压缩。**阶段软目标**（`budget.maxPromptTokens`）导致的淘汰**不**建议压缩——那是窄阶段的要求，不是模型窗口的压力（两种情形各有测试）。
- 禁止直接调用 Provider、扫描用户文件或把保守估算展示为真实 token usage。

## 依赖与数据

- 依赖配置、LLM 计数能力和公共契约；由 Harness 组织候选后调用。
- `ContextSnapshot` 是执行证据，正文权威来源仍属于原领域。
- 模型专用精确 tokenizer 使用固定 revision、大小和 SHA-256 校验；Runner 创建时只装配惰性计数器。首次真实 Agent run 才 single-flight 准备本地资源，未就绪或准备失败时使用保守请求预算，失败重试带退避，不阻塞应用启动或普通工作区浏览。

## 测试与修改定位

- 行为测试在 `src/engine.test.ts`，请求差异在 `src/request-prefix-diff.test.ts`，DeepSeek V4 资源、编码与惰性生命周期在 `src/tokenizers/deepseek-v4-counter.test.ts`、`src/tokenizers/deepseek-v4-encoding.test.ts`，内部所有权说明见 `src/context-engine/README.md`。
- 修改预算算法时必须覆盖未知计数器、必需内容超限、淘汰顺序和脱敏快照。
