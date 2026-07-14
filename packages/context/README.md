# @littlesheep/context

为单次 LLM 调用选择、预算和装配 Context，并生成可追溯的请求快照。

## 职责与边界

- 公开入口是 `src/index.ts`，当前核心实现位于 `src/engine.ts`。
- 拥有候选规范化、优先级、预算、淘汰、计数和快照；不拥有记忆或会话存储。
- 禁止直接调用 Provider、扫描用户文件或把保守估算展示为真实 token usage。

## 依赖与数据

- 依赖配置、LLM 计数能力和公共契约；由 Harness 组织候选后调用。
- `ContextSnapshot` 是执行证据，正文权威来源仍属于原领域。

## 测试与修改定位

- 行为测试在 `src/engine.test.ts`。
- 修改预算算法时必须覆盖未知计数器、必需内容超限、淘汰顺序和脱敏快照。
