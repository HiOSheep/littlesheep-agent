# LLM Call Contract 边界

最后更新：2026-09-22 12:40:16

本目录定义 Core Flow 每种模型调用的版本化认知契约。

- `definitions.ts`：每种 purpose 的最小契约模板。当前真正发出的调用是 `execute_tool_loop`、`reply`、`capability_reply`、`ask_user`、`session_compaction`，以及明确禁止模型调用的 `finalize`；`classify`、`decide`、`decide_explicit_tool`、`execute_final_reply`、`recover`、`verify`、`evolve`、`capture` 只作为历史/兼容条目保留，让旧日志、重放投影和旧检查点仍能解析自己的 purpose——RECOVER 与 VERIFY 的模型调用已删除，确定性路由不消耗模型请求。
- `registry.ts`：把 stage 名或 purpose 归一化（`LEGACY_STAGE_PURPOSE`）并生成不可变的已解析契约（deep-freeze）；未注册工具、未知 purpose、被禁止的模型调用和输出预算越界都直接以 `LlmCallContractViolationError` 拒绝。

## 所有权与验证

本目录只拥有调用策略模板和解析，不拥有 Prompt 正文、Context 内容、工具实现或记忆存储。公共类型唯一来源是 `@littlesheep/types`，请求记录入口是 `../model-observability.ts`，契约校验与 reasoning 偏好在 `../model-request-contract.ts`，Context 强制执行位于 `@littlesheep/context`。

契约负责声明调用目的、允许输入、可作决定、输出结构、记忆意图、工具权限和预算。模型请求仍由 Context Engine 装配，工具执行和记忆提交仍只由运行时完成，持久记忆的写入方只剩压缩路径。每轮另有模型调用硬上限；用户可见的回复、任务说明、执行结论和澄清必须来自真实调用，模型已通过 `request_user_input` 写好的提问按原样发布、不再二次措辞，`FINALIZE` 明确禁止额外模型调用。定向验证位于 `../model-observability.test.ts`，多调用隔离由 `../e2e.test.ts` 覆盖。
