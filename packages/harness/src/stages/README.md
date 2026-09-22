# Harness Stages

最后更新：2026-09-22 12:40:16

每个文件实现 Core Flow 的一个状态，状态转移仍由 Harness 统一控制。

## 所有权

- `classify.ts`：确定性活动路由，不发出模型请求，只产出 `execute`（能力/状态询问以外的所有请求）与 `reply`（能力/状态询问）；`clarify` 不再可路由，缺少信息由回复本身追问。
- `execute.ts` + `execute/`：唯一主循环；`verify.ts` + `verify/`：结构化验收与恢复路由；`recover.ts` + `recover/`：Runtime 恢复，不调用恢复模型。
- `reply.ts`（含 `reply/continuity-repair.ts`）、`ask_user.ts`（含 `clarification-message.ts`）、`finalize.ts`：能力/状态回复、澄清与最终装配。
- `enter.ts` 提供入口状态；`_shared.ts` 只放多个 stage 真正共享的纯 helper；`memory-epistemic-policy.ts` 只把模型描述的来源转成压缩路径写入时用的 Runtime 认识论元数据。
- DECIDE、它的规划模块和 TaskBook 步骤执行器已随第二执行体系删除；`decide` 只作为旧检查点的兼容 stage 名保留，驱动会把恢复入口映射到主循环。运行结束时的自动沉淀（CAPTURE）与自动演化（EVOLVE 编排、自动 Skill 创建）同样已删除。

## 边界与测试

- Stage 通过 `RunContext` 和端口协作，不直接访问 App、渠道或用户数据文件。
- 禁止通过模型输出跳过权限、验证或收尾状态。
- 持久记忆只有一个写入方——压缩路径；stage 不再拥有任何记忆写入端口，模型始终没有存储修改权。
- 用户可见自然语言必须在当次 run 中实时调用当前 Provider API，由 LLM 结合 `SOUL.md` 现场构思，不从模板库或预备文案池选取；发布前通过持久化会话级回复注册表原子占用 settlement 身份，重复措辞按原样发布且不重新调用模型，没有任何改写或重新生成路径。`ReplyProvenance` 必须绑定真实 model request，`FINALIZE` 回查请求后才接受非空回复；注册表、模型或文案为空时 Runtime 返回错误状态，Renderer 不生成固定 Agent 文案。
- 每个复杂 stage 必须有同名测试；跨阶段行为由 Harness e2e 覆盖。
