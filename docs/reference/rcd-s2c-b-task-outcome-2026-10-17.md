# LS RCD S2C-B — Task Outcome 最小可信证据与持久化

**日期：** 2026-10-17

**基线：** 本地 `main`，`d2c5b3d2193549057fe9e3511f66f3b2d510f0b0`

**实施分支：** `codex/rcd-s2c-b`（从指定基线创建的隔离工作树）

**范围：** S2C-B；未启动 S2C-C/D/E 或 S3
**结论：** 窄范围的可信 Task Outcome 记录、文件内容验收、Durable 投影和本机读取已实现；通用要求抽取、恢复故障窗口全覆盖与 Renderer 交付仍未完成。

## 1. 契约和所有权

新增的 `TaskOutcome` 将 `execution.status`、逐项 `requirement.status` 和整体 `taskOutcome.status` 分开表达。VRS 的 `verification.verdict` 没有被改写或提升成要求通过状态。正常结束的 Runtime 只说明执行状态；要求只有取得可信、可解析的独立检查证据后才会成为 `passed` 或 `failed`。

本批只识别一个明确且完整的用户要求形状：根目录文件名及精确内容约束，例如“创建 result.txt，内容必须为 hello。”。从实际 inbound 消息取得 `sourceMessageId`，用 Run、消息和文件名生成稳定 requirement ID。额外说明、歧义文本、路径穿越和不支持的要求都不会被猜测性抽取；没有识别出要求时，清单为 `unknown`，整体结果不会成为 `completed`。

## 2. 可信文件检查与证据

Runner 只在上述受支持要求存在时安装一个 run-scoped、只读的 `runtime_check_file_content` 工具。模型不能提供目标路径或期望内容；二者由 Runtime 从原始用户消息形成的闭包提供。检查器经现有 ToolExecutionService、workspace path guard 和文件读取授权，打开临时工作区的实际文件并比较实际字节。单文件上限为 1 MiB，原始要求内容上限为 16 KiB。结果只返回有界状态、相对资源引用和 SHA-256，不返回文件正文。

成功的 `write` 结果新增相对工作区资源及 create/modify 元数据，不记录写入正文。Outcome 证据引用只从以下可信来源构造：

- 实际检查工具结果和 InvocationRecord。
- 检查器读取的文件状态身份、SHA-256 和 requirement check 结果。
- 同一 Run 中匹配资源的成功写入及已结算 Effect。

检查结果若后续被同一 Run 的写入改变，会从最终 Outcome 中剔除。没有本 Run 的已结算写入、存在 unknown/pending Effect、Provider 请求未结算、检查被阻断，或持久证据目标无法解析时，都不会生成 passed。证据数量有界（最多 64 项），Requirement 和 Artifact 各最多 32 项；Durable 事件仍受既有 64 KiB payload 限制。

## 3. 判定和持久化

Outcome 由 Runtime 确定性构造，不调用模型进行第二次验收，也不接受模型直接提交的状态。文件内容错误时，工具写入与 Effect 仍如实记录成功，Requirement 为 `failed`，Outcome 为 `partially_completed`。内容匹配且工具结果、文件状态和写入 Effect 均可解析时，Requirement 为 `passed`；只有该单一且明确的要求清单被可靠识别时，整体才可为 `completed`。没有独立检查时为 `unverified`，未识别的要求清单保持 `unknown`。

一个 `task_outcome_settled` Durable Event 在 Run 级保存不可变 Outcome。正常顺序是 FINALIZE proposal → Task Outcome → ExecutionLog 写入 → final reply settlement → `run_completed`。相同幂等身份与相同内容按重复事件处理；身份相同但内容不同会报告冲突；同一 Run 的第二个逻辑 Outcome 会被拒绝。若恢复看到已提议回复却缺少 Outcome，只写入保守 `unknown`，再继续现有回复对账；不会从回复文本推断任务通过。

ExecutionLog 兼容字段缺失时返回 `unknown`。新结果读取时会验证证据目标是否仍在 ToolCall、Invocation 和 settled Effect 中；目标缺失或不匹配会降级为 unknown。`Runner.replayTaskOutcome` 只有在 Run 终态且 Durable 投影与 ExecutionLog 一致时才返回已结算结果；非终态或不一致状态返回 unknown。Durable Event Store 与 ExecutionLog 不是跨存储事务：如果 Outcome 已写而本机证据日志缺失，读取端宁可降级为 unknown，也不展示 verified。

## 4. 验收结果

### S2C-B 定向用例

`pnpm exec vitest run` 的 7 个定向测试文件共 **77 项通过**。其中核心文件检查用例通过真实 `createRunner` → Harness → ToolExecutionService 路径，使用受控模型和隔离临时工作区：

| 场景 | 结果 | 证据边界 |
|---|---|---|
| B-T01：写入成功、内容错误 | 通过 | 实际文件读取不匹配；write Effect succeeded；Requirement failed，Outcome partially_completed |
| B-T02：写入正确、检查通过 | 通过 | 实际读取的字节匹配；Outcome completed |
| B-T03：未执行独立检查 | 通过 | 成功写入仍为 unverified，不产生检查证据 |
| B-T04：要求清单不完整 | 通过 | 不支持/扩展文本不被自动抽取；inventory unknown，不能 completed |
| B-T05：Unknown Effect / Provider | 通过 | 相关 Requirement blocked，不将其作为已验证成果 |
| B-T06：跨段与进程恢复 | 通过 | 真实 Runner 子进程在第 30 项后被 SIGKILL；新 Runner 接管同一 Run，完成剩余 5 项并读取真实文件；恢复后 Outcome 与 ExecutionLog 回放均为 completed/passed，35 个写入 Effect 唯一、检查 Effect 仅一次、ingress 与 Outcome 事件各一次 |
| B-T07：Outcome 与最终回复故障窗口 | 组件级通过 | Durable Kernel 测试验证缺失 Outcome 时保守补 unknown、已结算 Outcome 保持不变、事件顺序及重复结算保护；不是跨进程多存储故障注入 |
| B-T08：旧数据兼容 | 通过 | 缺字段的旧 ExecutionLog 返回 unknown；证据目标缺失会降级为 unknown |

同一执行身份上相同内容可以幂等重放；内容冲突和第二个 Outcome 均有负向测试。持久事件落在最终回复结算之前。

### RCD、VRS、S2B 及安全回归

| 验证 | 结果 |
|---|---|
| S2C-B 定向组 | 7 个文件、77 项通过 |
| B-T06 真实跨进程恢复 | 1 个测试通过；同一 Run 跨 SIGKILL 恢复后完成 35/35，检查证据与最终 Outcome 持久读取一致 |
| S1A/S1B-F/S1C、VRS、S2B 保护组 | 18 个文件、297 项通过；在最终代码版本上重跑；包含真实 Runner 子进程终止/重建、段恢复、Provider/Effect unknown、累计预算、无进展、取消、Shell/Web 权限和旧 VRS checkpoint |
| `pnpm run typecheck` | 通过 |
| Runner/Harness/Tools/Types workspace 构建 | 通过；构建闭包 20 个 workspace 包 |
| `pnpm run check:repo` | 35 项通过、3 项 advisory、0 失败；advisory 为仓库文件规模/拆分地图提示 |
| `node scripts/rcd-s0.mjs validate` | 通过；24 个定义，suite SHA-256 `7f36e4f399b3c752b6b73621c63676f2c4af39e3643cadc4b8c186d7e5d1c940` |
| `node scripts/rcd-s0.mjs run --core --timeout-ms=120000` | 六项基础设施均 executed，0 blocked、0 harness error、0 not_run；产品结果 3 passed、1 partially_completed、2 correctly_blocked；清理均成功 |
| `git diff --check` | 通过 |

冻结的六项 RCD 结果未改变：C02 passed；C08 passed（不能据此宣称相同 Shell 命令被阻断）；R01 passed；R02 correctly_blocked；L01 partially_completed（30/35，停止原因为单段预算）；X01 correctly_blocked（在副作用后、结算前通过受控异常注入并重启，不是真实 OS 崩溃）。RCD 受控 Provider 的 usage/cost 字段为 unavailable。原有 S0-F 账本和历史报告未修改；本轮核心运行摘要写入机器账本，原始临时证据保存在仓库外临时位置。

机器可读摘要：[rcd-s2c-b-task-outcome-2026-10-17.json](rcd-s2c-b-task-outcome-2026-10-17.json)。

## 5. 当前边界与后续批次

- 自然语言要求完整抽取未实现；只有单条精确根目录文件内容要求支持生产检查。
- 无通用文件格式验收器、测试/构建通用结论或 TaskBook 自动可信化。
- 没有 Renderer UI；普通 Run/AgentResult 的结构化读取接口已具备，展示留给 S2C-C。
- B-T06 已覆盖真实 Runner 跨段 SIGKILL 恢复及 Outcome 持久读取；B-T07 仍为 Durable Kernel 组件级故障窗口测试，尚未覆盖跨多个持久存储的进程级崩溃注入，后续继续加强。
- 没有真实 Provider、Electron Renderer 交互或用户数据工作区验收。
- VRS `unverified` 不被改写；S2B 恢复资格、权限、预算和 Effect 语义未修改。

这些边界意味着本次证明的是一类明确文件要求的可信检查与持久记录，不是 LS 对任意用户任务的完成率或通用验收能力。

## 6. Git 交付

三个本地提交均基于指定 `main` HEAD，没有推送：

1. `50e8616f8eb079e46540e13779dccc46b5ca8fcc` — `feat(rcd): add task outcome evidence checker`
2. `3d4f8e9f60dbc6ba81660d3dee47e481eacd43fd` — `feat(rcd): persist task outcomes in durable runs`
3. 本报告、机器账本、兼容与定向测试提交 — `test(rcd): verify task outcome settlement and compatibility`（完整哈希见最终交付，避免报告自引用）。

工作在隔离分支 `codex/rcd-s2c-b` 完成。原始 checkout 中的 Renderer 在研修改动未被触碰。
