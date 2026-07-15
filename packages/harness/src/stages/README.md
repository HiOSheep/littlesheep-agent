# Harness Stages

每个文件实现 Core Flow 的一个状态，状态转移仍由 Harness 统一控制。

## 所有权

- `classify.ts`、`decide.ts`：需求判断和 TaskBook；DECIDE 内部校准与重规划位于 `decide/`。
- `execute.ts`、`verify.ts`、`recover.ts`：步骤执行、验收和局部恢复；工具循环/步骤调度位于 `execute/`，结构验收/恢复路由位于 `verify/`。
- `evolve.ts`、`capture.ts`：结构化能力与运行流水意图；`memory-intent-gate.ts` 用真实步骤、工具和 VERIFY 证据决定是否提交。
- `reply.ts`、`ask_user.ts`、`finalize.ts`：聊天、澄清和最终装配。
- `_shared.ts`：只放多个 stage 真正共享的纯 helper。

## 边界与测试

- Stage 通过 `HarnessContext` 和端口协作，不直接访问 App、渠道或用户数据文件。
- 禁止通过模型输出跳过权限、验证或收尾状态。
- 模型提出的 `invalidate/conflict` 只记录为待协调事项，不能在 EVOLVE/CAPTURE 直接破坏记忆。
- 每个复杂 stage 必须有同名测试；跨阶段行为由 Harness e2e 覆盖。
