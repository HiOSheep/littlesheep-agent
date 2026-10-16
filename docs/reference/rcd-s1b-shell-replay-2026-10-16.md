# LS RCD S1B — Shell 合法重执行与恢复幂等语义复核

**日期：** 2026-10-16
**范围：** S1B；只复核 Shell fresh invocation 与 Runner recovery replay，不进入 S1C/S2。
**结论：** 未发现成功后的合法 Shell 调用被误判成 Runner 恢复重放。相同成功 Shell 输入被拦截是 `exec` 的既有不透明副作用策略：没有可证明的资源键，也未声明可重跑能力。安全恢复保护通过。没有修改生产代码、授权范围或 Shell 隔离策略。

## 执行摘要

S1B 用真实内置 `exec`、Harness `ToolExecutionService` 和 Runner durable event/recovery 路径执行 B01–B05。Provider 为脚本化模拟 Provider，只用于给生产控制流提供固定回复；它不替 Runtime 做执行决定。Shell 命令仅在每个用例创建的系统临时目录中运行，未访问公网或真实用户工作区。

| 用例 | 基础设施 | 被测行为 | 结果 |
|---|---|---|---|
| B01 | executed | 相同成功 Shell 输入；受控文件从 v1 变为 v2 后再调用 | `correctly_blocked`：命令第二次未启动，确认为不透明 Shell 策略限制 |
| B02 | executed | 相同成功 Shell 输入、状态未变化 | `correctly_blocked`：第二次未启动，账本仍只有第一次成功记录 |
| B03 | executed | 成功结算后故意丢失 `run_completed` 回执，再由 Runner 恢复 | `passed`：原 effect ID/成功结算保留；恢复只补 run 完成回执，不重放工具 |
| B04 | executed | 副作用完成后注入异常，再重启 Runner 恢复 | `passed`：effect 保持 `unknown`，恢复不重放；这是受控异常注入，不是真实 OS 崩溃 |
| B05 | executed | 权限拒绝、一次性授权范围、预先取消 | `passed`：拒绝不因新逻辑调用绕过；一次授权不覆盖第二条命令；取消调用无副作用 |

机器结果： [rcd-s1b-shell-replay-2026-10-16.json](rcd-s1b-shell-replay-2026-10-16.json)。其中 B01/B02 的 `correctly_blocked` 表示 Runtime 按当前安全策略拒绝重放，不表示用户要求的第二次观察已完成。

## 生产身份与结算路径

### 账本如何识别重复

`describeSideEffect` 用工具名和稳定序列化后的完整输入计算 SHA-256：`tool:<toolName>:<inputHash>`。账本是当前 Run 的状态；持久化事件的 event/idempotency ID 再加上 `runId` 前缀。相同命令、cwd 和参数在同一 Run 中因此命中相同基础 effect key。

- `inputHash` / 基础 effect key：识别同一工具输入的重复副作用尝试。它不证明工具语义上的资源相同或工作区内容没有改变。
- `resourceKeys`：来自工具可信的 Runtime 资源访问声明，用于判断某次后续成功写入是否改变了相同资源。仅写资源进入列表。
- `callId`：将一次工具调用与结算证据关联；它不改变基础幂等 key，也不能仅凭模型生成的新 call ID 取得新执行资格。
- Retry attempt key：已知 `failed`/`cancelled` 结果可以产生 `:retryN`；未知/进行中状态不重试。成功结果只有在工具明确声明 `reRunnableAfterResourceChange` 且 Runtime 账本能证明同资源后续成功写入时才有资源变更 warrant。
- effect ID：durable event 的 intent、settlement 与恢复投影关联键。恢复从持久化事件重建该身份，不创建新的逻辑工具调用。

`exec` 没有声明可重跑，且 ToolExecutionService 不为不透明 Shell 推导可证明的写资源，因此其 effect kind 是 `external`、资源键为空。一个 `succeeded` effect 后，相同输入会得到 `side_effect_replay` 拒绝；没有可用的资源变更 warrant。`exec` 的模型说明也明确了相同成功命令会被拒绝。B01/B02 实际复现了该策略。

### Shell 授权身份不是账本身份

Main 的 `authorizeShellBatch` 为每个精确调用生成随机 `invocationId`，准备并验证绑定命令、cwd、Shell 可执行文件身份、workspace/session/run、权限、环境指纹、超时和目录身份的执行计划。授权 grant 存于进程内 WeakMap，单次消费；启动前重新读取 Main 策略并验证执行事实。grant 不持久化，也不会从 checkpoint 恢复。因此新 call ID 不会重用先前 grant；Runner 恢复也不会恢复 Shell 执行能力。

Shell `invocationId`、模型工具 `callId` 与账本 effect ID 各自服务于授权、调用结算关联和幂等恢复。当前没有把 Shell 授权 invocation ID 写进 durable effect intent 的跨记录证明链；不过这不会授予恢复重放权限，因为 grant 本身不持久化，且 effect ledger 在调用 Shell 前已保守登记 intent。未来若要允许成功后的不透明 Shell 重新执行，需要 Main 可信的操作身份/授权设计和可证明的资源/副作用边界，不能以命令变形、模型声明或新 call ID 绕过账本。

## B01–B05 证据

### B01 — 成功、文件变化、相同命令再次调用

在独立临时目录中创建 `input.txt=v1`，用真实 `powershell.exe -NoProfile -Command` 启动完全相同的 `node check.mjs` 命令。第一进程读取并记录 `v1`，exit code 0；受控 fixture 工具将同一文件改为 `v2`，并采集修改前后不同的 SHA-256。第二次调用使用不同 call ID，但相同命令、cwd、完整输入哈希；Runtime 返回 `side_effect_replay`，没有启动第二进程。

观察到的 effect 仍只有一条：`callId=b01-shell-1`、`status=succeeded`、`effectKind=external`、`resourceKeys=[]`，且没有 `reRunnable=true`。所以这是已知的不透明 Shell 限制，而不是恢复 ID 与新调用身份混淆。该限制意味着当前 Runtime 无法完成“成功后依赖状态变化再观察”的 Shell 模式；安全理由是 Shell 可访问的不透明副作用无法由 Runtime 证明文件修改与命令副作用之间的边界。

### B02 — 成功后状态不变

同一临时脚本和完全相同的 Shell 输入第二次调用时，实际进程日志仅一条 `ran`，第二个不同 call ID 得到 `side_effect_replay`；账本只保留一项成功结算。这与产品对相同成功 Shell 调用的既有说明一致，未发现意外的恢复分支。

### B03 — 成功结算后 Runner 恢复

通过 Runner 运行一个只写临时文件的 fixture 工具。测试在副作用成功结算后注入 `run_completed` 回执写入失败，使持久化状态需要恢复；intent 与 `succeeded` settlement 的 `effectId` 相同。Runner 重启后第一次恢复只补齐 `run_completed`；第二次恢复无动作。工具执行次数仍为 1，`effect_settled` 仍只有一条。该故障点验证了真实 Runner durable recovery 的幂等路径。

### B04 — 副作用后结果未知

fixture 工具真实写入临时文件后，在返回工具结果前抛出受控异常。Runner 重启恢复保留 `unknown` 及其错误摘要 hash，恢复投影中有一个 unknown effect，工具执行次数保持 1，settlement 事件保持一条。它复用 X01 的故障注入机制，但不是杀进程或 OS 级崩溃。

### B05 — 拒绝、一次性授权和取消

两次不同逻辑 Run 对同一受控命令请求授权，Main fixture 两次都拒绝，均未产生目标文件。另一条路径只对一条精确命令返回一次性授权；该命令写入 `allowed` 标记。新命令再次经过 Main 请求并被拒绝，未写入 `forbidden` 标记。对预先取消的 Run，工具调用记为 `aborted`，`cancelled` 标记未写入。

## 冻结回归

使用 `scripts/rcd-s0.mjs run --core` 重跑 S0-F 六项，结果保持：

| 场景 | 结果 | 关键证据 |
|---|---|---|
| C02 | passed | S1A 参数修正仍通过 |
| C08 | passed | 原语义保持：相同命令第一次 `v1:1`，状态变化后第二次 `v2:0`；这是已知失败后的合法 retry，不证明成功 Shell 可重跑 |
| R01 | failed | 仍是公开查证需求触发缺陷；本批未修复 |
| R02 | correctly_blocked | 禁止联网保护仍通过 |
| L01 | partially_completed | 固定循环预算仍部分完成 |
| X01 | correctly_blocked | unknown 副作用恢复不重放；仍是受控异常注入 |

6/6 基础设施执行成功，6/6 临时目录清理成功。机器报告：[rcd-s1b-core-regression-2026-10-16.json](rcd-s1b-core-regression-2026-10-16.json)。

## 验收结果与限制

- 生产行为修复：无。B01/B02 归为现有安全策略的有意限制（C），没有放宽 opaque Shell 重放保护。
- 授权：没有改变 Main 授权、拒绝优先级、单次 grant 消费、Shell 执行计划校验或隔离冻结。
- 恢复：成功 effect 复用原 effect ID/settlement；unknown 不自动重放；没有创建伪造新逻辑调用。
- 外部副作用：没有测试真实网络、付费 Provider、操作系统进程被强杀、主机断电或 Shell 命令对 workspace 外资源的影响。Shell 隔离仍是既有宿主执行边界，不构成 OS sandbox。
- 测试层级：B01/B02/B05 走 Harness `ToolExecutionService` 与真实内置 Shell 授权/执行；B03/B04 走真实 Runner durable event/recovery，Provider 为确定性模拟器；B04 故障由受控异常触发。
- usage/cost：脚本化 Provider 未提供真实用量或成本，记为 unavailable。

## 实际运行的检查

- `pnpm exec vitest run test/rcd-s1b-shell-replay.test.ts packages/tools/src/shell-authorization.test.ts packages/harness/src/stages/execute/side-effect-ledger.test.ts packages/runner/src/runner.test.ts` — 4 files、127 tests passed；Runner 79 tests，完整执行约 333 秒。
- `node scripts/rcd-s0.mjs run --core --output=docs/reference/rcd-s1b-core-regression-2026-10-16.json` — 六项基础设施执行 6，失败/阻断 0；产品结果 2 passed、1 failed、1 partially completed、2 correctly blocked。
- `node scripts/rcd-s1b.mjs run --all` — B01–B05 5/5 executed。
- `pnpm run typecheck` — passed。
- `pnpm run check:repo` — passed：35 项通过，0 项失败；3 条既有 advisory。
- `git diff --check` — 本报告提交前执行。

## Git 与交付

本批仅新增 S1B 执行器、B01–B05 回归适配器和报告/账本。没有编辑生产 Runtime 文件。提交只包含 S1B 路径；其他 Renderer 与专项改动保持原样；本批不推送远端。
