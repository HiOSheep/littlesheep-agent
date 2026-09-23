# Harness Stages

最后更新：2026-09-24 01:25:00

每个文件实现 Core Flow 的一个状态，状态转移仍由 Harness 统一控制。

## 所有权

- `classify.ts`：确定性活动路由，不发出模型请求，只产出 `execute`（能力/状态询问以外的所有请求）与 `reply`（能力/状态询问）；`clarify` 不再可路由，缺少信息由回复本身追问。
- `execute.ts` + `execute/`：唯一主循环；`verify.ts` + `verify/`：结构化验收与恢复路由；`recover.ts` + `recover/`：Runtime 恢复，不调用恢复模型。VERIFY 把"不可用证据"（调用被拒/校验失败/未知工具、结果缺失、输出截断、未结算副作用）交给恢复，把"已记录的负结果"（失败/超时/中止的调用）留在验证记录里并让该 run 停在 `unverified`：失败永远不会变成 `pass`，也不会让 Runtime 用追问替换模型已经给出的回答。**"结果缺失"只有一个成立条件**——有 invocation 记录却没有同 callId 的结果；续跑 run 继承的终态副作用由检查点自身作证，不再被误报为"没有对应工具调用"（取证矩阵见 `verify/evidence-gap.test.ts`）。
- `reply.ts`（含 `reply/continuity-repair.ts`）、`ask_user.ts`（含 `clarification-message.ts`）、`finalize.ts`：能力/状态回复、澄清与最终装配。`reply.ts` 与 `execute/prompt.ts` 读同一个 run 级工作区事实（`ctx.cwd`）渲染 `# Workspace`；`reply.ts` 在回复发布成功后才把本轮投递过的环境简报记入 transcript，失败的回合不记，因为模型可能从未读到它。
- `enter.ts` 提供入口状态；`_shared.ts` 只放多个 stage 真正共享的纯 helper；`memory-epistemic-policy.ts` 只把模型描述的来源转成压缩路径写入时用的 Runtime 认识论元数据。
- 升级到用户时（`recover/escalation.ts`）必须带上原因类别、已完成部分与所需动作三件事实，而不是把同一句三选一原样再问一遍；`ask_user.ts` 仍用真实模型调用组织可见文案，Runtime 只提供事实。**预算耗尽的失败不重试**：上限记录在 run 上，重试同一轮只会再次撞上它（实机一次白跑 4 轮 execute），所以 `recover/policy.ts` 命中 Runtime 自己的上限文案时第一次就升级。
- 用户语言与声音边界同时覆盖两条路径：`reply`/`ask_user` 用 `buildUserFacingVoiceAddon` 声明"措辞归模型、事实归 Runtime"，主循环用提示自带的执行契约（用户的语言、代码与路径不翻译、清晰低风险目标按合理默认直接开工，只在缺关键事实/目标冲突/不可逆/缺权限时提一次问）。两条路径的 SOUL 都来自同一份 bootstrap。
- DECIDE、它的规划模块和 TaskBook 步骤执行器已随第二执行体系删除；`decide` 只作为旧检查点的兼容 stage 名保留，驱动会把恢复入口映射到主循环。运行结束时的自动沉淀（CAPTURE）与自动演化（EVOLVE 编排、自动 Skill 创建）同样已删除。
- 任何 `next` 目标都必须是驱动注册的 stage：局部重规划与恢复重试分别回到 `execute`，退役 stage 名不能作为路由目标（`src/stage-routing-registry.test.ts` 守住这条）。

## 边界与测试

- Stage 通过 `RunContext` 和端口协作，不直接访问 App、渠道或用户数据文件。
- 禁止通过模型输出跳过权限、验证或收尾状态。
- 持久记忆只有一个写入方——压缩路径；stage 不再拥有任何记忆写入端口，模型始终没有存储修改权。
- 用户可见自然语言必须在当次 run 中实时调用当前 Provider API，由 LLM 结合 `SOUL.md` 现场构思，不从模板库或预备文案池选取；发布前通过持久化会话级回复注册表原子占用 settlement 身份，重复措辞按原样发布且不重新调用模型，没有任何改写或重新生成路径。`ReplyProvenance` 必须绑定真实 model request，`FINALIZE` 回查请求后才接受非空回复；注册表、模型或文案为空时 Runtime 返回错误状态，Renderer 不生成固定 Agent 文案。
- 每个复杂 stage 必须有同名测试；跨阶段行为由 Harness e2e 覆盖。
- 工具结果对模型的投影只保留可据以决策的字段（无 `status`/`durationMs` 包装），重复的相同 payload 改为引用会话里仍在的早先结果；这两项按冻结真实任务实测分别占工具结果字符的 20% 与 7%。
- 请求字节的稳定性是各 stage 的共同责任：Runtime 尾部与控制消息按位置持久化，强制收尾不得改写工具可见性或 `tool_choice`（provider 在 `none` 下不渲染工具目录，实测少 1.8k–2.0k tokens 且缓存从第 0 个 token 起失效）。可见工具目录就是本次会话的注册目录（`execute/runners.ts` 的 `catalogTools = ctx.tools`）：用户显式点名的工具只与 Runtime 检索范围取交集后收窄本轮的 `admittedTools`，既不改变模型所见 schema，也不放宽检索范围；越权调用在执行边界被拒，拒绝文案按收窄成因选择。
- 跨 run 的请求装配由 `cross-run-continuation.test.ts` 守住：`modelHistory` 存在时，新 run 的请求必须先在字节上重复上一 run 的请求（工具配对含原始参数串与模型看到的工具结果文本），`historyChatCount` 负责把主用户回合标在正确位置。
