# LS 状态机重设计任务书 · 2026-09-18

最后更新：2026-09-18 02:45:00

本任务书把"重新设计 LS 的状态机"大目标拆成**可逐项执行、可验证、可回滚**的清单。
每一轮只做一项（或一项的一小步），**做完即勾选**。上下文/token 预算有限，因此规则是：
**先本地取证 → 改最小一处 → 全门 → 实机复测 → 提交并更新本文件的状态列。**

## 0. 总原则（不可违背）

1. **判断类决策交还模型**：要不要问用户、要不要重规划、要不要继续循环、要不要升级策略 —— 由模型判断；运行时**保留其结果并安全处置后果**，**不得**把判断结果当成协议违规（这是本次专项最大的教训）。
2. **安全类事实留在运行时闸门**：权限、副作用、幂等、发布可追溯、记忆撤销（HC-12）、检查点恢复一致性、每轮调用有界。
3. **状态机只保留"可恢复的最小事实"**。
4. **绝不静默收尾**：任何组装型阶段都不得以空文本结束一轮（`silentRuns === 0`，已入门禁）。
5. **一次只改一道门是不够的**：改判据前先确认"真正拒绝/拒绝点在哪里"，以及**所有**会再次调用该入口的下游阶段（例：`finalize` 会再次调用发布注册表）。

## 1. 测量规则（反复踩坑后固化）

| 规则 | 内容 |
| --- | --- |
| 口径 | 用**产品级预算**：`maxModelCallsPerRun = 32`（≠ 早期测量用的 8） |
| 指标 | `failedRuns` / `publishedRuns` / `pausedRuns` / **`silentRuns`(必须 0)** / 主对话命中率 / miss token 每调用 |
| 门结果解析 | **必须按 JSON 行解析**（`^{"check":...`），不要按关键字首行 —— 会抓到 pnpm 回显行，误报"失败"（已踩两次） |
| 小改动判定 | 效果 <5% 时**单次运行不可判定**；本地判据优先（忠实投影 `systemPromptProjection`），否则**两次样本 + stageCounts 相近** |
| UI 状态门 | 夹具已修（`6fdc566`）；若失败，**按 JSON 行**看是哪种签名，并先确认干净树是否同样失败 |
| 失败归因 | 优先用 `failure-fields.mjs`（打印失败 run 的**原始 `error` 字符串**）与 `silent-run-trace.mjs`（trace 的 `ok:false` 标记）——**不要猜** |

## 2. 已完成（有实机证据，勿重复动）

| # | 切片 | 提交 | 实测效果 |
| --- | --- | --- | --- |
| ✅ 1 | 延续歧义不再判死：`ambiguous` → 废弃检查点 + 当新任务跑 | `dad2939` | 失败 **22→4**，命中回升 69% |
| ✅ 2 | 重复发布按模型意图放行（穿透到**注册表**，本地检查不够） | `1510fa0` + `75070bd` + `e2d6149` | 该类 **6→0**；成功率 45%→**100%** |
| ✅ 3 | 澄清请求不再停放 run（= ASK_USER 阶段化的实质解除） | `7744548` | `pausedRuns` 0、`silentRuns` 0、命中 66.2%、miss/call ~900 |
| ✅ 4 | 静默收尾三处守卫（草稿兜底 / 空输出重试 / 空回复硬失败） | `f11ce37` `74c33ec` `f11236f` | `silentRuns` 长期 0 |
| ✅ 5 | 失败不再被 HTTP 200 掩盖 | `36b2f6f` | 失败第一次可见 |
| ✅ 6 | 测量口径与判据 | `80bf1dd` `ffe1450` `293f46d` `6fdc566` | 产品口径 / 指标拆分 / `silentRuns` 入门禁 / UI 门稳定 |

**当前基线（产品级 8×5 实机）**：`failedRuns` 0–1（偶发**传输层** `fetch failed`）、`publishedRuns` 39–40/40、`silentRuns` 0、`pausedRuns` 0、主对话命中 **66–67%**、`miss token/调用` **881–907**。

## 3. 待执行清单（按优先级；每项都写清"完成定义"）

### ✅ P1. `failedRuns` 拆分语义/传输（2026-09-18 完成）
- **改动**：比较脚本新增 `semanticFailures` / `transportFailures`（按 `error` 文本判定网络/DNS/socket 类），门新增 `semanticFailures === 0` 强制项，`transportFailures` 只报告不拦。
- **实测**：离线 8×5 `semanticFailures=0,0`、`transportFailures=0,0`、`silentRuns=0,0`、gate passed；`node --check` 通过。
- **意义**：此前一次 `fetch failed` 就把门判红（并在"无停放"确认轮掩盖了一次通过的验证），现在环境抖动与状态机回归不再混淆。

### ✅ P2. 恢复/重试状态机（recover）——本地取证结论：**无需改动**（2026-09-18）
- **取证**（读 `packages/harness/src/stages/recover.ts` 的四个 `ask_user` 出口）：
  1. `:54–61` 重试次数耗尽（`recoveryAttempts > maxRecoveryAttempts`）→ 强制升级 —— **安全上界**，保留；
  2. `:85–95` 恢复决策调用**传输失败**（`fetch failed` 等）→ 升级而不是让运行静默死掉 —— 保留；
  3. `:99–105` 决策**无法解码** → 保守升级 —— 保留；
  4. `:148–163` **模型自己选择 `escalate`** → 优先直接发布问题（`next: 'finalize'`），失败才回退 `ask_user` —— **判断归模型**，符合原则。
- **为什么无需改**：三处是"运行时无法决定 → 用一条正常回复问用户"（不再产生停放态，`7744548`），一处是模型自己的判断；配合预算与产品口径对齐（`80bf1dd`，32 调用/轮），恢复链不再撞预算。
- **实测佐证**（`live-nopark.txt`，产品级 8×5）：`semanticFailures = 0 / 0`、`pausedRuns = 0 / 0`、唯一失败为 `fetch failed`（传输层，已由 P1 分类）；无任何 recover 类失败，也无停放的升级。
- **留待日后（非本项）**：若需要"授权后继续"这类**可续跑**的升级，按 P5 以技能主动调用重建等待点。
- **完成定义达成**：本地证据 ✅ / 无需改动（0 行）✅ / 既有全门未受影响 ✅ / 实机佐证 ✅。

### ✅ P3. VERIFY / 重规划 ——本地取证结论：**无需改动**（2026-09-18）
- **取证**（读 `packages/harness/src/stages/verify/routing.ts:280–319`）：该出口只在**自动局部重规划达到上限且任务仍未达标**时触发 —— 写入一条 `fail` 判定（`source: 'structural'`）+ 一个**带选项**的用户问题（"保留已完成部分并说明现状 / 再尝试一次 / 停止任务"），随后 `next: 'ask_user'`。
- **为什么无需改**：这是**有界的运行时停止点**（安全类：不让自动重规划无限循环），其后果是**用一条正常回复问用户**（`7744548` 后不再产生停放态）；问题文本由运行时提供，因此即使模型组词为空，草稿兜底（`f11ce37`）也会把它正常发布。
- **实测佐证**：最近的保留数据根中 `semanticFailures = 0`、`pausedRuns = 0`，**没有任何 verify 类失败或停放**；重规划计数上界（`maxReplanAttempts = 2`）与每轮调用预算（产品口径 32）不冲突——此前那次"预算耗尽"来自测量配置里的 8（`80bf1dd` 已修）。
- **完成定义达成**：本地证据 ✅ / 无需改动（0 行）✅ / 既有全门未受影响 ✅ / 实机佐证 ✅。

### ✅ P4. 工具循环 ——本地取证结论：**参数均为安全/成本上界；记录一处可选细化**（2026-09-18）
- **审计结果**（`packages/harness/src/stages/execute/tool-loop.ts`）：
  | 机制 | 值 | 性质 | 处置 |
  | --- | --- | --- | --- |
  | 迭代上限 | `MAX_ITERATIONS = 20` | 成本/失控上界 | 保留（产品预算 32 调用/轮可容纳） |
  | 无进展闩锁 | `MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS = 2` | 成本/循环上界；触发后 `forceFinalResponse` 并**指示"用已有证据作答、说明不确定"** | 保留（**不代替模型下结论**，只要求停止调用工具） |
  | 证据指纹 | `MAX_EVIDENCE_FINGERPRINTS = 128`，按 `toolSource + 资源键/输入哈希` 判定 | 观测/去重 | 保留（已有测试覆盖"同内容不同来源算不同证据"、"不同成功副作用算进展"） |
  | 纯追加历史 | `_shared.ts` 只增不滑 + 12,000 字符预算 | 缓存前缀稳定 | 已于 10.108 落地并实测 |
- **为什么无需改**：三者都是**上界**且后果是"要求模型基于已有证据收尾"，而不是替模型编造结论或把判断判成违规；与"判断交还模型、安全留运行时"一致。
- **可选细化（记为 P4a，不阻塞）**：触发无进展闩锁时，当前提示是"停止调用工具并作答"；更贴合原则的写法是**陈述观察并交回选择**（"最近两轮按指纹判定没有新证据；你可以基于现有证据作答，或说明还缺什么"），同时**保留**强制收尾这个上界本身。属措辞级改动，收益低于单次测量分辨率，待其它项完成后再评估。
- **实测佐证**：最近样本 `semanticFailures = 0`、`silentRuns = 0`、`pausedRuns = 0`；无工具循环类失败。
- **完成定义达成**：审计报告 ✅ / 必要改动：无（0 行）+ 记录 P4a ✅ / 既有全门未受影响 ✅ / 实机佐证 ✅。

### P5. 澄清技能化（**下一个要写代码的项**）—— 取证完成，设计定稿，待实施
**取证结论（关键）：`7744548` 之后，生产代码里**没有任何地方再创建 `waiting_user`**。逐处核对：

| 位置 | 实际作用 |
| --- | --- |
| `run-checkpoint.ts:50` | **原创建点，已删除**（本轮专项） |
| `run-checkpoint-controller.ts:110` | `resolveWaitingUserHead` 里的**查询过滤**（读，不写） |
| `run-checkpoint-store.ts:56` | 状态校验白名单 |
| `runner.ts:1090`、`authoritative-reply.ts:232` | **读取**状态（续跑入口 / 运行态文案） |

⇒ **续跑机制整体目前在生产上不可达**（测试仍用夹具覆盖）。要保留"可续跑"能力，必须由一个**有意的触发点**去创建等待检查点；按目标原则，该触发点应当是**模型主动调用的技能**。

**设计（实施顺序）：**
1. **技能面**：注册一个有界技能（如 `request_user_input`），schema 限定 `field` / `prompt` / `required` / `options?`，与其它技能一样在 reply/execute 中**由模型主动调用**；
2. **运行时处置**：把问题作为**正常回复**发布（走既有 `finalize`），**同时**写入一个 durable 等待检查点 —— 这是**唯一**有意的 `waiting_user` 创建点，并记 `runtime_event` 记录技能调用；
3. **续跑**：完全复用现有路径（`runner.ts:1090` 起的 disposition 解析），含 `dad2939` 的"ambiguous → 废弃检查点 + 当新任务跑"安全处置；
4. **上界（安全类）**：每会话仅允许一个"等待头"（`resolveWaitingUserHead` 的 conflict 分支已保证），并给技能调用加**每轮上限**；
5. **验收判据**：`pausedRuns > 0` **只**发生在"模型提问且运行时确实停放"时；`silentRuns = 0`、`semanticFailures = 0`；续跑由既有 Electron 连续性场景 + 一条 runner 用例覆盖。

**完成定义**：技能注册 + 契约 + 运行时触发点 + 测试；`typecheck` / 全量 vitest / `check:repo` / 两条 Electron 门全绿；产品级 8×5 复测（`semanticFailures` 0、`silentRuns` 0、命中率与 miss/调用不回归）。

**落点清单（已侦察，实施时按此机械执行）：**

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `packages/tools/src/builtin/request_user_input.ts`（**新增**） | 仿 `builtin/session_status.ts` 的工厂形态：`createRequestUserInputTool(...)` 返回 `AgentTool`，输入 schema 限定 `field` / `prompt` / `required` / `options?`；执行**不做 IO**，只回一个结构化"请求提问"标记 |
| 2 | `packages/runner/src/infra.ts`（约 `:465` 组装 `createSessionStatusTool` 处） | 把新工具加入运行的工具集合（与其它内置工具同处） |
| 3 | **触发点**（harness 侧，工具调用结果处理处） | 识别该调用 → ① 把问题作为**正常回复**发布（走既有 `finalize`）；② 经 infra 的检查点控制器写入**唯一**一个 durable `waiting_user` 检查点 + 记 `runtime_event` |
| 4 | 提示词/契约面 | 工具规格文本自动进入工具列表；在 RESPOND/EXECUTE 指令里加一句"需要用户提供缺失信息时可调用它"，不改变既有输出契约 |
| 5 | 测试 | runner：模型调用 → 产出回复 + 写入等待检查点（且**只**一个等待头）；harness：问题文本被正常发布（含空输出的草稿兜底） |

**规模与顺序（更新：1、2a、2b 已完成）**：步骤 1（工厂）`6cfed7b`、2a（barrel 导出）`4dc3886`、2b（接入 `infra.ts` 工具集）`71c5cf4` —— **都是纯增量、行为未变**，已分别通过 `typecheck` / 聚焦测试 / 全量 3,281 通过 / `check:repo` 33/33 / continuity 门。

**步骤 3 的精确配方（下一轮执行；含一个决定实现形态的硬约束）：**

- **硬约束（关键）**：**不能用工具输出直接当回复发布**。`finalize` 只接受**可追溯到真实 Provider 请求**的文本（`f11ce37`/`36b2f6f` 两轮实测教训），而 `request_user_input` 的输出是**工具结果**、不是模型回复 ⇒ 若直接发布必然被拒（或落到空回复）。
- **因此步骤 3 = "识别调用 → 复用 ASK_USER 的组词路径 → 写等待检查点"**：
  1. 在 harness 的工具调用处理处识别 `request_user_input`（用 `REQUEST_USER_INPUT_TOOL_NAME` 常量），把 `field/prompt/required/options` 写进 `ctx.clarificationRequest`（沿用既有结构，`copySource` 标为 `model`——这是**模型主动**发起的提问，与运行时兜底区分）。**落点已侦察确定**：`packages/harness/src/stages/execute/tool-loop.ts:197` 一带 —— 那里正是**同款先例**（`response.toolCalls.filter((call) => call.function.name === WORK_POLICY_UPGRADE_TOOL_NAME)` 后做特殊处理并改变流程），照该模式加一个 `request_user_input` 分支即可；`ask_user`/`clarificationRequest` 的结构与 `updateClarificationRequest` 已在 `recover.ts` 有可直接照抄的用法；
  **可直接粘贴的分支（照 `:197–226` 的 `request_task_book` 形态）**：
  ```ts
  // 在 tool-loop.ts 第 197 行的 upgradeCalls 分支之前插入
  const inputRequests = response.toolCalls.filter(
    (call) => call.function.name === REQUEST_USER_INPUT_TOOL_NAME,
  );
  if (inputRequests.length > 0) {
    if (inputRequests.length !== 1 || response.toolCalls.length !== 1) {
      return { ok: false, content: '', toolResults, iterations: iteration,
        error: 'a user input request must be one standalone tool call' };
    }
    const userInputRequest = parseUserInputRequest(convertToolCall(inputRequests[0]!).input);
    if (!userInputRequest) {
      return { ok: false, content: '', toolResults, iterations: iteration,
        error: 'user input request failed Runtime schema validation' };
    }
    return { ok: true, content: '', toolResults, iterations: iteration,
      usage: response.usage, userInputRequest };
  }
  ```
  **配套四点（缺一不可）**：① `ToolLoopResult` 增加可选 `userInputRequest` 字段（`execute/contracts.ts`）；② `parseUserInputRequest` 校验器（照 `work-policy-upgrade.ts` 的 `parseWorkPolicyUpgradeProposal` 写，复用 `RequestInput` schema）；③ **调用方**（`task-step-runner.ts` / `execute`）收到该字段后：写 `ctx.clarificationRequest`（`copySource: 'model'`）并返回 `next: 'ask_user'`；④ ASK_USER 组词发布 + infra 写**唯一**等待检查点（照 `recover.ts:140–160`）。
  **调用方落点已确定**：`packages/harness/src/stages/execute/runners.ts:46` —— 那里正是**同款先例的消费者**（`if (result.workPolicyUpgradeProposal) { … buildWorkPolicyUpgradeRequest(…) }`）。companion 4 就在该处加一个并行分支：`if (result.userInputRequest) { 写 ctx.clarificationRequest（copySource: 'model'）→ return { stage: 'execute', next: 'ask_user', ok: true } }`。
  **已完成**：companion 1（`ToolLoopResult.userInputRequest` 字段）+ companion 3（工具循环识别分支）= `373622a`；companion 2（校验器）= `445c3b4`。**只剩 companion 4 + 两条测试 + 全门 + 8×5。**
  **✅ 已认证（2026-09-18，HEAD `b51a39b`）**：全部五道门在含 companion 1–3 的树上通过 —— `typecheck` clean、全量 vitest **460 文件 / 3,281 通过 / 1 跳过**、`check:repo` **33/33**、`verify:electron-continuity` **ok**、`verify:electron-ui-state-continuity` **ok**。因此 companion 1–3 的"纯增量"结论**已由全门背书**（此前只有 typecheck/check:repo/聚焦测试）。
  2. **转入既有 ASK_USER 阶段**：由它做**一次模型组词**（`ask_user.ts` 已经这样工作，并在空输出时回落到运行时草稿 `f11ce37`），随后 `finalize` 正常发布 —— 这样文本可追溯；
  3. **写唯一等待检查点**：经 `infra` 的检查点控制器写入 `waiting_user`（这是 `7744548` 之后**唯一**有意的创建点），并记 `runtime_event`（技能调用 + 问题 schema）；
  4. 上界：每会话仅一个等待头（`resolveWaitingUserHead` 的 conflict 分支已保证）；技能调用每轮上限（建议 1）。
- **验收**：`typecheck` / 全量 vitest / `check:repo` / **两条** Electron 门（按 JSON 行解析）；产品级 8×5 —— `pausedRuns` 仅在模型提问时为 1、`semanticFailures` 0、`silentRuns` 0、命中率与 miss/调用不回归；加两条测试（runner：恰一个等待头；harness：问题文本被正常发布）。
- **回滚**：只涉及"识别 + 转 ASK_USER + 写检查点"三处，删掉即回到步骤 2b 的纯增量状态。

### P6. 会话压缩 / 检查点续跑 / 工作策略升级 / 记忆写入
- **现状**：仅被"清单 + 不变量"覆盖，未逐个重设计。
- **方法**：每个都按"本地取证 → 最小改动 → 全门 → 8×5"四步，并在本文件追加一节。

### P7. 收尾：ASK_USER 阶段与澄清契约的代码清理
- **前置**：P5 决策完成。
- **完成定义**：删除不可达代码 + 同步测试与门；`check:repo` 与两条 Electron 门全绿。

## 4. 每轮的固定动作（模板）

1. 从本文件挑**最上面未勾选**的一项；
2. **本地取证**（零成本；用第 1 节的工具）；
3. 只改**一处**（可回滚；必要时拆成两轮）；
4. `pnpm run typecheck` → `pnpm exec vitest run`（460 文件）→ `pnpm run check:repo` → `verify:electron-continuity` → `verify:electron-ui-state-continuity`（**按 JSON 行**）；
5. **产品级 8×5 实机**确认（判据：`failedRuns` 不升、`silentRuns` 0、命中/成本不回归）；
6. 提交 + 在本文件勾选/补一行实测数字。

> 细则与证据链见 `docs/taskbooks/harness-lean-phase-c-implementation-taskbook-2026-09-14.md` 第十一章（11.1–11.26）。
