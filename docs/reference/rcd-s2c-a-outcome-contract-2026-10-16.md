# LS RCD S2C-A — 主线集成与 Task Outcome 契约设计

**日期：** 2026-10-16
**阶段：** 第一批，完成主线集成审查与契约设计
**集成提交：** `89a3dc6cac3f1ad53492abff875c8c75f1d9dd0e`
**结果：** S2B 已集成到本地 main；S2C-A 契约已冻结为后续实现输入。本报告不代表已实现 S2C-B/C。

## 1. 主线集成

### Git 关系与处理

集成前 main 为 `b8519bf28f26718eeb14bf0fdc48d883477c517f`，S2B-G 分支为 `652e1c794df711e7e09d060bed5326a13f72ea3f`。VRS V2B `28667f84295f71c57fa983ad3556545ef22877ec` 是 S2B 分支与 main 的共同祖先，也是 S2B 的基础提交；VRS 没有重复应用。

两边各有独立提交，不能快进：main 侧有 7 个提交，S2B 侧有 9 个提交。以普通 merge 保留双方历史，生成提交 `89a3dc6c`，父提交为原 main 与 S2B-G。main 上的 LCDA、VRS 后续文档、Renderer 及其他已提交变更均保留。相关 VRS 与 S2B 工作树在集成前均干净。

唯一内容冲突位于 `packages/runner/src/runner.ts`：main 已迁移至 VRS 当前 `writeRunTaskState` 契约；S2B 增加了跨段预算恢复和同 Run 恢复上下文。合并保留 S2B 的预算参数和恢复逻辑，并将恢复状态写入 VRS 当前任务状态入口；移除了对已退役 Replan 写入接口及 revision-feedback 状态的依赖。没有改动 S2B 的恢复资格、权限、Effect 或 unknown 阻断条件。

S1A、S1B-F、S1C 和 VRS V2B 均在集成后 main 的祖先链中。当前 main 相对 `origin/main` ahead 25；本批没有推送。

### main 验证

| 验证 | 结果 |
|---|---|
| `pnpm run typecheck` | 通过 |
| `pnpm run check:repo` | 35 项通过、3 组 advisory、0 失败；advisory 包含大文件/拆分地图计数提示 |
| `pnpm run ensure:app-build` | 通过；Electron 44.4.5，构建新鲜 |
| `node scripts/rcd-s0.mjs validate` | 24 个场景定义通过；SHA-256 `7f36e4f399b3c752b6b73621c63676f2c4af39e3643cadc4b8c186d7e5d1c940` |
| `node scripts/rcd-s0.mjs run --core` | 6/6 场景基础设施实际执行，0 blocked、0 harness error；产品结果 3 passed、1 partially completed、2 correctly blocked |
| `pnpm exec vitest run`：Harness/Runner/Tools/Main 定向组 | 17 个文件、207 项通过；包括 35/35 单 Run 分段、同 Run 跨进程恢复、总体预算、取消、unknown Effect/Provider、旧 VERIFY checkpoint、Main Permission V2、S1A 参数纠错、Shell/Web 保护 |
| `pnpm exec vitest run`：FINALIZE/Kernel/E2E 定向组 | 4 个文件、53 项通过；覆盖 Durable Kernel、主循环、EXECUTE → FINALIZE 与最终回复结算 |
| `node scripts/verify-electron-s2b-recovery.mjs` | 真实 Electron Main + Local App API + Runner + Harness 通过；第 30 项安全段 checkpoint 后终止并恢复同一 Run，35 个唯一 Effect、原 ingress 1 次、run budget 未重置、最终回复与 `run_completed` 各结算 1 次 |
| `node scripts/verify-desktop-permission-v2.mjs` | 真实 Electron Renderer/Main/Runner 通过，27 条断言；本地 Provider fixture，无公网请求 |
| `git diff --check` | 通过 |

RCD 核心结果保持既有语义：C02 passed、C08 passed、R01 passed、R02 correctly_blocked、L01 partially_completed（30/35）、X01 correctly_blocked（受控异常注入的 unknown，不是 OS 崩溃）。详细场景和恢复边界见 [S2B-G Electron 验收报告](rcd-s2b-g-electron-acceptance-2026-10-16.md)。

真实 Electron 用例使用临时数据目录和 loopback Provider，没有使用真实付费 Provider、公网检索或用户工作区数据。Renderer Permission V2 的 27 项验收与 35 项自动恢复是不同测试路径。

## 2. 当前执行与交付数据审计

### 2.1 EXECUTE 结算不等于用户目标验收

`packages/harness/src/stages/execute/main-loop.ts` 在离开 EXECUTE 前调用 `packages/harness/src/stages/execute/evidence-settlement.ts`。它从 Runtime 拥有的模型工具调用、工具结果、`ToolInvocationRecord`、side-effect ledger 和最终回复 provenance 检查身份与结算一致性。遇到缺口时清除回复状态并进入 RECOVER。

结构证据完整时，当前 VRS 结算写入 `VerificationRecord.verdict = 'unverified'`；存在已知缺口时写 `fail`。历史 `pass` 仅为兼容保留。`evidence-settlement.test.ts` 明确锁定“运行证据完整不代表用户任务已验收”。这条结算仍是本阶段唯一的运行证据门，不应复制为另一套 VERIFY。

Durable `verification_recorded` 投影只保留 verdict、source、reason hash/length 和 failed step IDs；它没有用户要求与证据之间的逐条映射。

### 2.2 Runner、持久结果与最终回复

`packages/runner/src/runner-support.ts` 将 Harness 结果装配为 `AgentResult`。当前 `status: 'ok'` 表示 Runtime 阶段正常结束；它不表示用户目标完成。`packages/runner/src/durable-runner-segment-recovery-policy.ts` 与 Durable Kernel 保持 Run 完成和安全恢复的执行语义：`run_completed` 必须已有 settled final reply，并且没有未结算模型请求或 Effect。它也不表达任务验收。

`packages/harness/src/stages/finalize.ts` 不再调用模型；它要求最终回复具有可追溯的 Provider provenance，先写入 Session transcript 和 `final_reply_proposed`，再由 Runner 完成 `final_reply_settled` 与 `run_completed`。Durable recovery 可以补齐已持久化回复的结算，但不会重新生成一个新的逻辑回复。FINALIZE 当前没有 Task Outcome 输入或输出。

`AgentResult` / `ExecutionLog` 已有运行状态、TaskBook、旧 `TaskExecutionResult`、`verificationHistory`、模型请求、工具调用结果、工具 invocations、side effects、Runtime control、回复和 usage 等局部证据来源。ExecutionLog 在当前严格持久化路径中先于最终回复 settlement 写入；DurableRunProjection 则保留 Run 状态、stage transitions、model/provider usage、effects、final reply 与历史 verification 的紧凑投影。`packages/harness/src/stages/recover/policy.ts` 也记录了当前单主循环已没有稳定写入 `taskExecution` 的生产路径，因此不把旧 TaskExecutionResult 当作逐要求验收来源。

这些来源分工不同：ExecutionLog 可供本机历史和 Runner/API 读取，但不等同于 DurableRunProjection；Durable projection 具有事件幂等与恢复语义，但目前没有 TaskBook、完整 ToolResult 或 Task Outcome。旧 `TaskExecutionResult` 类型包含步骤和 `toolCallIds`，但当前单主循环没有稳定、逐要求填充该字段的生产写入者，不能作为新契约的权威完成证明。

### 2.3 产物证据与 Renderer

Renderer 的 `buildArtifactsFromToolCalls` 根据成功的 `write` / `edit` 调用及其参数推导文件路径，并在结果卡片显示为“产出成果”。这能呈现某次工具调用所指向的路径，不能证明当前文件存在、内容符合用户要求或已通过独立检查。`WorkspaceArtifactRef` 目前只含 path、name、action 与可选 toolName。

通用 `ExecutionEvidenceKind` 已声明 `file_state`、`command_exit`、`verification`，但本次源码搜索没有找到这些类别的生产者。当前 `ExecutionLog` 构造器实际生成的是从 tool invocation 映射出的 `tool_result` 概览，不应把类型声明当作已有文件状态或验收能力。

Renderer 目前把 Run 状态 `ok` 显示为“完成”，并在流程区显示工具/步骤活动和 VRS verification label；`activityAttentionLine` 会保留失败、取消、等待用户和未通过状态。没有按用户要求呈现的 Task Outcome 结构，也没有逐项“已验证/未验证”证据列表。

## 3. S2C-A 最小契约

Task Outcome 是一次 Run 的结果描述，不是新执行循环、规划器或 VERIFY Stage。它必须与 Runtime 执行状态、VRS 证据完整性保持独立。

### 3.1 三个独立维度

| 维度 | 建议状态 | 由什么事实决定 |
|---|---|---|
| `execution.status` | `completed` / `failed` / `cancelled` / `blocked` / `unknown` | Run 的可信终态、Runtime control、权限/安全拒绝和持久事件；同时保留底层 RunStatus 与 RuntimeFinalStatus 作为来源 |
| 单项 `requirement.status` | `passed` / `failed` / `unverified` / `blocked` | 用户可追溯要求、针对该要求的可信检查及其证据引用 |
| `taskOutcome.status` | `completed` / `partially_completed` / `blocked` / `cancelled` / `unknown` | 对要求覆盖、检查结果、执行终态和未结工作作保守归纳 |

不能由 `execution.status = completed` 自动填充 requirement 的 passed，也不能把 VRS `unverified` 改写为 task acceptance passed。

### 3.2 建议的数据形状

```ts
interface TaskOutcome {
  version: 1;
  runId: string;
  status: 'completed' | 'partially_completed' | 'blocked' | 'cancelled' | 'unknown';
  execution: {
    status: 'completed' | 'failed' | 'cancelled' | 'blocked' | 'unknown';
    runStatus: RunStatus;
    runtimeStatus?: RuntimeFinalStatus;
    controlState?: RuntimeControlSnapshot['state'];
  };
  requirementInventory: 'complete' | 'partial' | 'unknown';
  requirements: Array<{
    id: string;
    sourceMessageId: string;
    origin: 'user_explicit' | 'runtime_derived';
    status: 'passed' | 'failed' | 'unverified' | 'blocked';
    evidenceRefs: string[];
    reasonCode?: string;
  }>;
  artifacts: Array<{
    resourceRef: string;
    action: 'created' | 'modified' | 'attached';
    effectRef?: string;
    evidenceRefs: string[];
    verification: 'passed' | 'failed' | 'unverified' | 'blocked';
  }>;
  remaining: Array<{ requirementId?: string; reasonCode: string; evidenceRefs: string[] }>;
}
```

这是契约草案，不是本批新增的生产类型。Requirement statement 可以从其 `sourceMessageId` 回到用户原消息；Durable 诊断事件优先持久化引用、状态和 hash，不重复写入用户原文、Memory 内容或工具输出正文。

### 3.3 保守判定规则

- 只有与原始用户消息可追溯的要求可进入用户要求清单。运行时/模型从任务中派生的标准应标记 `runtime_derived`；派生本身不是用户授权的验收条件。
- `requirementInventory` 在不能证明要求清单完整时必须为 `partial` 或 `unknown`。不能因为 TaskBook 看起来完整就假定已覆盖全部用户要求。
- `passed` / `failed` 必须有与该要求关联的可信检查结果；模型的完成声明、工具调用成功、Shell 退出码为 0、文件路径被 Renderer 展示，均不足以单独证明任意用户目标。
- 没有独立检查时记录 `unverified`。因权限、取消或环境阻断而不能执行检查时记录 `blocked` 并保留原因。
- `taskOutcome.status = completed` 仅当执行正常结束、要求清单完整、所有适用的用户明确要求均有通过证据，且没有 unknown Effect/未结 Provider/安全阻断时成立。
- 若有可信部分成果但有失败、未验证或未完成要求，结果为 `partially_completed`。没有可信任务要求或结果无法重建时为 `unknown`。安全/权限阻断且没有可交付进展时为 `blocked`。明确取消时为 `cancelled`，但仍保留取消前逐项成果。
- Unknown Effect 不得当作已成功产物；相关 requirement 只能保持 blocked/unknown，执行状态可为 blocked。

## 4. 持久化及消费者边界

建议在 S2C-B/C 实现时只增加一个 Run 级 TaskOutcome reducer，不增加第二 Harness 或验证 Stage：

1. **生成：** 在 Runner 现有的最终发布/结算边界，根据可信 Run 状态、VRS 结算事实、ToolExecutionService invocation、已结算 Effect、实际工具结果与明确的独立检查结果构造 TaskOutcome。模型只可提供候选说明，不直接写状态。
2. **本地读取：** 将同一结构附加到 `AgentResult` 与 `ExecutionLog`，供运行结果、历史活动及 Renderer 消费。跨 Segment/安全恢复使用原 Run ID 和现有 Run 记录，不按段累计重复证据。
3. **Durable replay：** 增加一个小型 `task_outcome_settled` durable event / projection，按 Run ID 幂等，只保存有界的状态、要求来源引用、证据 ID、产物引用和 reason code。该事件必须在最终回复 settlement 或 Runtime terminal status 之前可靠落盘；FINALIZE/RECOVER 只能读取或补齐同一 outcome，不能重新评估或重复发布。
4. **旧数据：** 没有该事件或来源引用的旧 ExecutionLog/checkpoint 投影为 `unknown`/`unverified`；不回填 passed，不改变 S2B 安全恢复资格。
5. **VRS 边界：** `verification_recorded` 继续只表示执行证据完整性；TaskOutcome 是独立的结果事实，引用 VRS 和实际工具证据，不把它替换或复制成另一条验收流水线。
6. **Renderer：** 复用现有助手结果/历史活动，在任务型运行显示简洁的“已完成、已验证、未验证、剩余工作”区块。普通聊天不显示复杂卡片。该结构结果来自 Runtime 的 TaskOutcome；模型正文仍是回复内容，不能覆盖或升级结构化状态。

`task_outcome_settled` 是 S2C-B/C 的建议持久接口，当前尚未新增 durable event、类型字段、API 或 UI。实施时需同步更新 `packages/types/src/durable-harness.ts`、Durable Kernel codec/projection、Runner recorder/replay、`AgentResult` / `ExecutionLog` 和 Renderer 历史投影，并为旧事件的缺省状态编写兼容测试。

## 5. 后续 T06/T07 接口与实施拆分

| 场景 | 独立 Oracle 与预期 Outcome |
|---|---|
| T06 命令成功、文件内容错误 | 在隔离 workspace 中由测试 Oracle 直接读取文件并比较用户明确要求；Runtime 工具成功事实保留，但 requirement 为 failed、Task Outcome 不得 completed |
| T07 多项要求部分完成 | 由测试夹具分别提供一个可信通过项、一个未完成/未验证项；保留每项 evidenceRefs，Outcome 为 partially_completed，不能由模型总结覆盖 |
| 执行完成但无独立验收 | execution completed；要求为 unverified，整体不得 completed |
| 取消、预算耗尽、权限拒绝 | execution 与 taskOutcome 分开记录，保留取消前已确认成果及未完成项 |
| Unknown Effect / Provider 未结算 | 执行安全阻断或未知；不得产生 passed 或已验证产物 |
| 跨段/安全恢复 | 同一 Run、event ID 与 evidence ID 去重；恢复后只结算一次 TaskOutcome 与最终回复 |

S2C-B 只接入上述最小类型、证据引用、持久记录和现有结果消费者。S2C-C 再落实结果与 Renderer 的最终交付表现。之后的 S2C-D/E 用实际 Runner/Harness 路径完成 T06/T07 与恢复、取消、预算、权限、unknown 及最终回执崩溃测试。当前已有 `evidence-settlement.test.ts` 覆盖运行完整但仍 `unverified` 的保护；本批没有为尚未实现的 Outcome 新增会使仓库变红的测试。

## 6. 本批结论与未完成项

- main 集成完成，S2B 与 VRS 没有重复迁移；主线 TypeScript、仓库、VRS/恢复、RCD 六项与真实 Electron 关键验收均通过。
- 已确认 FINALIZE 结算的是可追溯回复和运行终态，不是用户目标验收。当前 VRS 的 `unverified` 语义正确，应保留。
- 可复用的权威来源是原 Session 用户消息引用、Run/Durable terminal 状态、VRS evidence settlement、ToolExecutionService invocation、side-effect ledger、实际工具结果，以及未来由受控检查产生的证据。
- 当前缺少单项要求的可靠完整清单、文件状态/命令退出证据生产者、TaskOutcome durable projection 和 Renderer 结果视图。因此现有 `status: ok`、`run_completed`、成功工具调用及产物卡片均不能作为 TaskOutcome completed。
- 本批只完成设计和集成；没有实施 S2C-B/C，不改变 VRS VERIFY、FINALIZE、Runner 恢复、Shell/Web/Memory 权限或任务执行行为。
- 真实付费 Provider、任意崩溃窗口、跨主机恢复、OS Shell 隔离和开放式自然语言要求完整抽取仍不在本批证明范围内。

## 7. Git 与工作区

- 当前分支：`main`
- 集成提交：`89a3dc6cac3f1ad53492abff875c8c75f1d9dd0e`
- S2C-A 文档另行提交；提交后 main 本地领先 `origin/main`，没有推送。
- Electron 构建输出和验收数据位于忽略目录/临时目录；Renderer 与其他专项工作树未被本批重置或清理。
