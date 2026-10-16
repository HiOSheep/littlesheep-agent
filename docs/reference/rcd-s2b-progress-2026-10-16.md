# RCD S2B — 实施进度与验收限制

**状态：** 未完成，不满足 S2B 出门条件。
**实施基线：** VRS V2B `28667f84`（独立工作树中的验证提交），其父提交为 S2A `1593f925`。
**工作分支：** `codex/rcd-s2b-continuity`。
**性质：** 同一进程内的有界执行段续接已实现；Runner 崩溃后的同一 Run 自动恢复尚未实现。

## 已完成的实现

- 配置新增 Run 级工具调用上限 `maxToolCallsPerRun`，默认 128；新增 Run 级工具循环上限 `maxToolLoopIterationsPerRun`，默认 30。已有单段上限保持 30，Run 总上限可由用户显式配置。
- `LoopBudgetSnapshot` 持久记录段序号、段内轮数、Run 累计轮数、工具额度及已预留请求身份。checkpoint codec 兼容缺少这些新字段的旧 checkpoint。
- 单段到限后，Harness 仅在 Run 预算、剩余模型额度、无进展、取消/暂停/澄清及副作用状态检查通过时，在原 Run 和原 Harness 循环内开始下一段。
- 新段状态和工具调用额度预留先写入 Runtime checkpoint，再发起后续 Provider 调用或工具副作用；checkpoint 写入失败时不执行相应工具。
- 默认 Run 总循环上限仍为 30。T01 明确配置 60 次总循环、64 次模型调用和 64 次工具调用，没有提高默认预算。

## 当前执行证据

| 用例 | 结果 | 可核验内容 |
|---|---|---|
| T01：35 项跨段执行 | 通过（受控 Runner + Harness） | 同一 `runId`；工具实际写入 35 个独立临时文件；35 次工具执行；checkpoint 显示第 2 段、段内 5 轮、Run 累计 35 轮/工具调用；Provider 请求数不超过显式上限。无用户追加“继续”。 |
| T02：Run 总工具预算耗尽 | 通过（受控 Runner + Harness） | 单段 30、Run 总循环 60、Run 工具上限 32；仅有 32 个文件副作用；checkpoint 显示第 2 段且累计/上限均为 32。额度没有在新段补充。 |
| T03：无进展 | 部分证据 | 现有 Harness 两轮无进展闩锁与恢复测试保留；尚无跨段故障恢复场景证明预算/闩锁在 Runner 重启后连续。 |
| T04：段间崩溃恢复 | **未通过 / 未实现** | 当前 Runner 恢复可修复已完成 Run 的最终回执，但不会将未完成的同一 Run 重新装配并续进 Harness。普通 checkpoint 用户续接会创建新的逻辑 Run 并重置该次尝试预算，因此不能替代 T04。 |
| T05：段边界取消 | 通过（受控 Runner） | 第 30 次工具操作提交运行中断；Runner 返回 `aborted`，仅保留 30 个文件；第二段没有启动。未覆盖撤销 Shell/Web 授权的 Electron 宿主流程。 |
| T08：Usage 与恢复 | 部分证据 | 现有 Runner / Provider usage 去重回归仍有效；尚无跨段后重启同一 Run 并证明物理回执只结算一次的执行。没有可靠 Provider usage 时继续为 unavailable。 |

### S0-F 六项核心场景回归

使用现有 `scripts/rcd-s0.mjs run --core` 重跑，六项评测基础设施全部 `executed`，清理全部成功，Provider 均为 scripted mock：

| 场景 | 本次结果 | 关键观察 |
|---|---|---|
| C02 | passed | 先拒绝错误参数，再执行修正后的参数；1 次实际工具执行。 |
| C08 | passed | 冻结语义保持；确认为合法 Shell 重执行，不被描述为重执行缺陷。 |
| R01 | passed | 执行中提出公开检索并获取 loopback 结果。 |
| R02 | correctly_blocked | 允许联网的配对控制发出 1 次 loopback 请求；明确禁止联网的用例额外请求数为 0。 |
| L01 | partially_completed | 原冻结预算仍为 30/35，停止原因 `single_segment_iteration_budget_exhausted`；本场景未改写为新 T01。 |
| X01 | correctly_blocked | 1 次副作用后受控异常，状态 `unknown`；并非真实进程崩溃。 |

机器记录为 [S2B 核心回归账本](rcd-s2b-core-regression-2026-10-16.json)，运行 ID `rcd-s0b-1792134077677`。它记录工作树指纹 `77724a81ff68dd9015cf084571a6ca7e5dae62ac833ff0835181041d73db4b8c` 和每项 Oracle、证据及清理状态。

以上仅是受控 Provider 和本地 fixture tool 的 Runner/Harness 测试，不代表真实 Provider、真实 Electron 或 OS 进程崩溃验收。T01/T02/T05 的工具副作用落在测试临时目录。

## 必须解决的恢复缺口

当前段切换只在单次 `runToolLoop` 调用存活期间续接。段起点和每次工具额度预留会保存 checkpoint，但这本身并不创建重启后重新进入 Harness 的生产路径。`recoverDurableRun` 的职责是恢复 durable projection 与已结算最终回复，不会重放尚未完成的执行。

因此本提交不能被描述为“同一 Run 支持可靠跨段恢复”或“完成 S2B”。T04 要求最小后续设计至少明确：

1. Runner 重启后如何在同一 `runId` 下取得原 Run lease，并保证不会与仍存活的执行并发。
2. 如何恢复原始 inbound、已持久化的 Harness Context、事件队列游标、循环预算、授权快照及副作用账本。
3. 未结算 Provider 请求或工具副作用如何转为 unknown 并阻止自动重放。
4. 如何让 durable event / final reply settlement 继续使用原 idempotency identity，避免重复完成事件或最终回复。
5. 如何处理续接前取消、暂停、用户 steering 和权限失效。

在这些机制有真实 Runner 故障注入测试之前，安全行为应是停止并保留 checkpoint，而不是自动创建新 Run 或重放工作。

## 验证记录

- Runner 定向测试：T01、T02、T05，3 项通过。
- 独立 `runner-segments.test.ts`：3/3 通过；实际由 Runner/Harness 路径创建和检查临时文件。
- Harness checkpoint 写入失败的定向测试：1 项通过；确认 checkpoint 无法持久化时工具未执行。
- Runner 原有完整测试文件：在独立分段测试文件拆分前 81/81 通过；分段测试文件随后 3/3 通过。
- Harness execute、model observability、Runner checkpoint、VRS evidence settlement / checkpoint compatibility 定向回归曾有一轮 146/147 通过；唯一失败为旧测试仍假设未初始化数组一定是 `[]`，修正为核验无调用/无副作用后，定向测试通过。其余 146 项在该轮通过。
- VRS 旧 VERIFY checkpoint 兼容和当前 Run checkpoint：15/15 通过。
- `pnpm run check:repo`：通过，35 个硬检查通过，3 条既有 advisory。
- `pnpm run typecheck`：通过。
- `git diff --check`：通过（最终提交前复核）。
- Runner/Harness workspace build：通过。
- S0-F 六项核心回归：评测基础设施 6/6 执行，产品结果 3 passed、1 partially completed、2 correctly blocked；所有临时目录清理成功。

尚未满足：T04 同 Run 崩溃恢复、T08 跨段恢复后的 Usage 去重、撤销授权/恢复/暂停的段边界端到端验收，以及 S1B-F 全套专项回归的再运行。S0-F 六项核心场景已在当前改动后重跑。

**验收结论：S2B 未完成。** 已建立进程内有界分段和 Run 预算的实现及 T01/T02/T05 证据；同一 Run 的崩溃恢复是当前出门阻塞项。本报告不启动 S2C 或 S3。
