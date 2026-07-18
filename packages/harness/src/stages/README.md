# Harness Stages

每个文件实现 Core Flow 的一个状态，状态转移仍由 Harness 统一控制。

## 所有权

- `classify.ts`、`decide.ts`：需求判断和 TaskBook；DECIDE 内部校准与重规划位于 `decide/`。
- `execute.ts`、`verify.ts`、`recover.ts`：步骤执行、验收和局部恢复；工具循环/步骤调度位于 `execute/`，结构验收/恢复路由位于 `verify/`。
- `evolve.ts`、`capture.ts`：结构化能力与运行流水意图；`memory-intent-gate.ts` 用真实步骤、工具和 VERIFY 证据决定是否提交；`evolve/reconciliation.ts` 处理重复 Atom 提案，`evolve/hierarchy.ts` 处理显式关系驱动的叶子 reparent，`evolve/subtree.ts` 与 `evolve/subtree-validation.ts` 处理有界非叶子子树移动，`evolve/revision.ts` 处理同陈述内容修订，`evolve/correction.ts` 与 `evolve/correction-validation.ts` 处理事实纠正/冲突替代；这些都是独立 Runtime 端口，模型没有存储修改权。
- `reply.ts`、`ask_user.ts`、`finalize.ts`：聊天、澄清和最终装配。
- `_shared.ts`：只放多个 stage 真正共享的纯 helper。

## 边界与测试

- Stage 通过 `HarnessContext` 和端口协作，不直接访问 App、渠道或用户数据文件。
- 禁止通过模型输出跳过权限、验证或收尾状态。
- 模型提出的 `invalidate/conflict` 只记录为待协调事项，不能在 EVOLVE/CAPTURE 直接破坏记忆。
- 普通 `merge` intent 同样不能旁路为写入；只有独立 `reconciliations` 协议可以进入 Atom 调和端口，模型始终没有存储修改权。
- 普通 `move` intent 同样不能旁路为写入；只有独立 `reparents` 协议可以进入层级端口，且单轮超额提案必须留下拒绝审计。
- 普通 `conflict`/`invalidate` intent 同样不能旁路为写入；只有独立 `corrections` 协议可以进入纠正端口，且旧 Atom 必须保留并以 superseded 投影表达替代关系。
- 用户可见自然语言必须在当次 run 中实时调用当前 Provider API，由 LLM 结合 `SOUL.md` 现场构思，不从模板库或预备文案池选取；发布前通过持久化会话级回复注册表做原子精确去重，重复时最多重新实时调用两次 API。`ReplyProvenance` 必须绑定真实 model request，`FINALIZE` 回查请求后才接受非空回复；注册表、模型或重新生成失败时 Runtime 返回错误状态，Renderer 不生成固定 Agent 文案。
- 每个复杂 stage 必须有同名测试；跨阶段行为由 Harness e2e 覆盖。
