# @littlesheep/harness

最后更新：2026-09-22 16:46:08

实现 LittleSheep 的核心 Agent Runtime：硬控制流状态机负责活动路由、单一主循环执行、验证、Runtime 恢复、澄清和收尾。

## 职责与边界

- 公开入口是 `src/index.ts`；阶段实现在 `src/stages/`，装配在 `default-harness.ts`，唯一的驱动是 `durable-harness.ts`（`createNextHarness`）。
- 活动路由只产出两条路径：所有会话与任务进入单一主循环（`stages/execute/tool-loop.ts` + `runners.ts`），能力/状态询问进入最小 Runtime 事实契约的 `reply`。DECIDE、验证模型调用、RECOVER 模型调用与 CAPTURE 已删除；`classify`、`decide`、`evolve`、`capture` 只作为历史 stage 名、LLM Call Contract 条目和检查点兼容字段存活，`checkpoint-resume.ts` 的 `resolveCheckpointResumeStage` 把入口为 `decide` 的检查点改派到 `execute`。ASK_USER 不可路由：它由主循环内模型发起的 `request_user_input`，或由 RECOVER 的权限拒绝/预算耗尽升级到达。
- 已持久化的 TaskBook 是只读历史（降级策略为 `bounded_loop`）：没有第二个执行器、没有 TaskBook 步骤调度器、没有直接工具提议路径，也没有步骤级并行；多步骤工作在同一循环内串行完成。
- 请求装配：system 消息恰好是缓存边界以上的 prompt sections（`stableText`/`stableSegments`）；边界以下的 bootstrap、Runtime facts、检索意图契约和压缩摘要由追加式尾部账本 `run-tail-ledger.ts` 各自成消息，因此循环第 N 次请求是第 N+1 次的字节前缀。可见工具目录在整个会话区间内固定（`catalogTools = explicitTools ?? ctx.tools`）；被收回的能力在**执行**时拒绝（`admittedTools` 是执行范围，不是可见性）。
- 任务区间回放（`model-history.ts`，已启用）：把会话 transcript 里的 assistant 工具调用（含 Provider 原始参数串、文本前言与 reasoning）与其 tool 结果（含模型当时看到的有界文本）配对重放，Runtime 尾部与控制消息（`runtimeTail` 标记，带 `runtimeTailId`）按发送位置一起回放，因此新 run 的第一个请求逐消息等于上一 run 最后一个请求的前缀。实测同一冻结清单 12 次运行：平均会话累计命中率 73.4%→84.2%，9/12 次的两个回合边界逐消息一致。`run-tail-ledger.ts` 用转录里已有的尾部条目预置账本，未变化的尾部不再重复发送（实测每回合约 1.2k tokens 的重复被消除）；`buildRunRequestCandidates` 的 `historyChatCount` 负责"历史占用的请求消息数 ≠ history 条目数"时的主用户回合定位。Runtime 尾部不占用 `keepRecent` 会话窗口（`trimToRecentConversation`），否则每轮约 10 条尾部会把整轮挤出窗口并让回放从中间开始。
- 观测模块：`model-observability.ts`（请求记录）、`model-request-contract.ts`（契约校验与 reasoning 偏好）、`cache-observability.ts` 与 `cache-prefix-split.ts`（可缓存头部切分）、`cache-observation-store.ts`、`cache-observation-persistence.ts`、`model-activity.ts`、`model-observability-state.ts`、`system-prompt-transcript.ts`、`runtime-awareness.ts`、`memory-known-state.ts`、`memory-context-working-set.ts`、`context-candidates.ts`、`profile-prompt.ts`；工具证据与转录在 `stages/execute/tool-result-persistence.ts`、`side-effect-ledger.ts`、`model-transcript.ts`。
- 自动记忆演化（Atom 调和 / reparent / 子树移动 / 修订 / 纠正编排）、自动 Skill 创建与 CAPTURE 总结均已删除。持久记忆只有一个写入方——压缩路径（`runner-finalize` → `compactSessionAfterRun` → `memoryService.write`，经 `resolveMemoryWriteEpistemic`）：后置压力触发、默认 400/200/background false、以原子 predecessor + sourceHash 提交、失败保留上一版摘要；模型没有可调用的记忆写入工具（`memory_tree` 只有只读动作）。
- `response-continuity*.ts` 依据 LS 实际发布的最终回答判断记忆是否连续，并从 `ReplyProvenance` 回查真正进入模型请求的近期历史、版本化摘要和 active/adopted Atom。保存、检索或注入成功都不是充分条件；明确追问的历史值必须在最终回答中逐项正确出现，漏答、答错、否认记得或来源未进入请求都不能判为 `supported`。判定不连续时只允许一次有界纠正（`stages/reply/continuity-repair.ts`），纠正以追加的"前缀扩展"形式发出，不重写 system 提示或工具目录。`session-summary-fidelity-text.ts` 只解析 Runtime 拥有的摘要精确字段封套，不负责会话压缩或存储。
- 用户显式点名工具时，`explicit-tool-instruction.ts` 解析出有界的已注册工具集（最多 4 个、schema 有大小上限）交给同一主循环，执行仍逐项经过统一 Tool Execution Service 的权限门；缺少副作用声明的工具由 Runtime 保守判定为 `external`/`unknown`。
- 对话区的回复、澄清和交付表达必须由实时 LLM 调用结合运行时 `SOUL.md` 构思并由 Harness 发布：发布前在会话级持久注册表原子占用 settlement 身份（run + 规范化文案指纹），同一 settlement 不得发布不同文案；模型已通过 `request_user_input` 写好的提问按原样发布并绑定产出它的请求 id，重复措辞同样按原样发布、不再调用模型改写，也不存在任何重新生成路径。文案为空、缺少真实 model request 证据或注册表不可用时失败可见，Runtime 不伪造人格文案。
- 禁止依赖 Electron、CLI、具体渠道或 App 私有实现，也不直接拥有文件系统生命周期。

## 依赖与数据

- 依赖领域公开契约；Runner 是它的主要上层应用服务。
- run 状态和执行证据由调用方持久化，Harness 不另造用户数据副本。

## 测试与修改定位

- 总体回归在 `src/default-harness.test.ts`、`src/e2e.test.ts`；追加式前缀与固定工具目录由 `src/run-tail-ledger.test.ts`、`src/request-prefix-append-only.test.ts`、`src/tool-catalog-stability.test.ts` 覆盖；回答级连续性与摘要字段解析分别在 `src/response-continuity.test.ts`、`src/session-summary-fidelity-text.test.ts`，各阶段测试与实现同目录。
- 路由必须指向驱动实际注册的 stage：`src/stage-routing-registry.test.ts` 扫描 `src/stages/` 的 `next` 目标并与 `default-harness.ts` 的注册表比对，退役 stage 名（`decide`/`evolve`/`capture`）既不能作为路由目标，也不能重新注册。
- 修改状态转移先更新 stage 契约和特征测试，再调整实现。
