# Harness Stages

每个文件实现 Core Flow 的一个状态，状态转移仍由 Harness 统一控制。

## 所有权

- `classify.ts`：确定性活动路由，不发出模型请求。DECIDE、它的规划模块和 TaskBook 步骤执行器已随第二执行体系删除；`decide` 只作为旧检查点的兼容 stage 名保留，驱动会把恢复入口映射到主循环。
- `execute.ts`、`verify.ts`、`recover.ts`：单一主循环、验收和 Runtime 恢复；工具循环位于 `execute/`，结构验收/恢复路由位于 `verify/`。
- 运行结束时的自动沉淀（CAPTURE）与自动演化（EVOLVE 编排、自动 Skill 创建）均已删除：持久记忆只由明确写入与压缩路径产生。
- `reply.ts`、`ask_user.ts`、`finalize.ts`：聊天、澄清和最终装配。
- `_shared.ts`：只放多个 stage 真正共享的纯 helper。

## 边界与测试

- Stage 通过 `HarnessContext` 和端口协作，不直接访问 App、渠道或用户数据文件。
- 禁止通过模型输出跳过权限、验证或收尾状态。
- 模型提出的 `invalidate/conflict` 只记录为待协调事项，不能在 CAPTURE 直接破坏记忆。
- 普通 `merge` intent 同样不能旁路为写入；只有独立 `reconciliations` 协议可以进入 Atom 调和端口，模型始终没有存储修改权。
- 普通 `move` intent 同样不能旁路为写入；只有独立 `reparents` 协议可以进入层级端口，且单轮超额提案必须留下拒绝审计。
- 普通 `conflict`/`invalidate` intent 同样不能旁路为写入；只有独立 `corrections` 协议可以进入纠正端口，且旧 Atom 必须保留并以 superseded 投影表达替代关系。
- 用户可见自然语言必须在当次 run 中实时调用当前 Provider API，由 LLM 结合 `SOUL.md` 现场构思，不从模板库或预备文案池选取；发布前通过持久化会话级回复注册表做原子精确去重，重复时最多重新实时调用两次 API。`ReplyProvenance` 必须绑定真实 model request，`FINALIZE` 回查请求后才接受非空回复；注册表、模型或重新生成失败时 Runtime 返回错误状态，Renderer 不生成固定 Agent 文案。
- 每个复杂 stage 必须有同名测试；跨阶段行为由 Harness e2e 覆盖。
