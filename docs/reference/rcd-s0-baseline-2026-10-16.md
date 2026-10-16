# RCD S0 基线报告

日期：2026-10-16（香港时间）
结果：**部分完成。场景目录、证据盘点和离线测试基线已建立；24 个端到端夹具尚未可执行，因此 S0 出门条件未全部满足。**

## 基线版本与工作树

- 分支：`main`
- HEAD：`23955356bf80abdc574326b6fc64dfa44e30666e`
- 开始时工作树非干净：存在 38 个用户已有 Renderer 文件改动/新增，集中于界面、样式和相关测试；本专项没有编辑这些文件，也没有清理或暂存它们。
- 基线机读记录：[rcd-s0-baseline-2026-10-16.json](rcd-s0-baseline-2026-10-16.json)。它保存 HEAD、工作树路径清单与跟踪差异哈希、Node/pnpm、lockfile 及场景集哈希。`trackedDiffSha256` 代表 HEAD 相对当前工作树的总跟踪差异，包含本专项新增文件；该哈希不是干净主线源码快照。
- 环境：Node `v26.4.0`；仓库声明最低 Node `20.9.0`；pnpm `11.9.0`。
- 用户任务书依据中提到 `ls-agent-product-audit-2026-10-15.md`，但该文件不在当前 `docs/` 树中，本报告没有把该审计当作已核实证据。旧 Runtime autonomy 任务书和现有源码/测试仅作为当前仓库证据。

## 既有证据链盘点

| 证据 | 当前实现与入口 | S0 可复用数据 | 缺口/限制 |
|---|---|---|---|
| Run 与工具调用 | `packages/runner/src/execution-log.ts` 按 run 保存阶段、工具调用及结果、状态、耗时、模型请求和调用记录 | `runId`、时间、工具调用数、逐调用结果、`durationMs`、模型请求 | 执行日志可能包含用户输入和工具内容；评测不得把原日志复制到仓库，需只投影安全元数据/引用 |
| Durable checkpoint / 恢复 | `packages/runner/src/run-checkpoint.ts`、`run-checkpoint-codec.ts` | 当前 taskBook/taskExecution、循环预算快照、运行控制、事件游标、side effects、verification history、上下文快照引用 | checkpoint 是运行恢复快照，不等同于跨多个执行段的权威目标清单；某些缺失项也不能靠 S0 生成 |
| 工具失败/授权/副作用 | `packages/types/src/runtime-contracts.ts`、`packages/harness/src/stages/execute/side-effect-ledger.ts`、`packages/tools/src/tool-execution-service.ts` | 调用身份、失败/拒绝结果、审批记录及副作用结算状态在已有执行路径中记录 | S0 应从受控合成夹具读证据；unknown 状态、执行前校验错误、授权拒绝必须分开计数 |
| Provider usage | `packages/runner/src/provider-usage-live-recording.test.ts` 及 Runner usage 记录代码 | Provider 回执中的实际 prompt/completion/缓存 token；缺字段保持错误/不可用语义 | 测试通过不代表本次调用真实 Provider；费用不能在没有版本化可靠价格表时计算 |
| Context Inspector / 模型请求 | `packages/context/src/context-trace.ts`、Runner execution log 的 context/model snapshots | 请求和上下文快照元信息、上下文证据引用 | 快照可能承载内容；报告只应记录快照 ID、状态、计数或哈希，不能拷贝文本 |
| VERIFY | `packages/harness/src/stages/verify*`、durable verification codec 与执行记录 | 结构化验证结果和状态（包括 `unverified`） | 不足以单独判定用户目标；每个任务需要独立、外部的 artifact/test oracle |
| 用户批准/拒绝/取消/继续 | Runtime event queue、runtime control、tool invocation/approval 与 conversation continuation 证据 | 已记录事件和控制状态可追踪部分运行决策 | 目前未有针对 RCD 指标的去重聚合器；继续次数、首次有效成果时间需要基于事件序列与场景 Oracle 明确定义 |
| 既有实验设施 | `scripts/experiment-autonomy-sandbox*.mjs`、`scripts/lib/experiment-ledger.mjs` 与旧 RT/SB 任务书 | 已有版本/配置哈希、逐次账本、Usage/干预/拒绝和结果汇总经验 | 旧任务集和运行协议不覆盖 RCD 24 个场景；不能直接重用其既有 run 结果充当 RCD 基线 |

## 固定任务集

新增场景集 [`scripts/rcd-s0-scenarios.json`](../../scripts/rcd-s0-scenarios.json)，SHA-256：`7f36e4f399b3c752b6b73621c63676f2c4af39e3643cadc4b8c186d7e5d1c940`。结构检查命令 `node scripts/rcd-s0.mjs validate` 通过：24 个唯一场景，C=8、F=4、R=4、L=4、X=4；覆盖 positive、safe_block、recovery 三种判定类型。

每项定义了输入、环境描述、允许工具/权限、外部 Oracle、可接受停止方式、禁止行为和重置说明。**限制：重置目前是描述性协议，不是逐场景可运行的 initializer/reset 命令。** 所以重复初始化、自动清理和 24 场景 end-to-end 可运行条件仍未满足。

## 离线基线结果

运行命令：

```powershell
pnpm exec vitest run packages/harness/src/stages/execute/side-effect-ledger.test.ts packages/harness/src/stages/execute/tool-failure-disposition.test.ts packages/harness/src/retrieval-intent.test.ts packages/tools/src/tool-execution-service.test.ts packages/harness/src/stages/verify.test.ts packages/harness/src/stages/verify/structural-evidence.test.ts packages/harness/src/stages/verify/evidence-gap.test.ts packages/runner/src/run-checkpoint.test.ts packages/runner/src/run-checkpoint-store.test.ts packages/runner/src/execution-log.test.ts packages/runner/src/provider-usage-live-recording.test.ts packages/context/src/context-trace.test.ts
```

结果：**12 个测试文件通过，176 个测试通过，0 失败**；Vitest `2.1.9`，总计约 32.74 秒。另，`node scripts/rcd-s0.mjs validate` 通过。

此结果是确定性单元/组件契约基线，不是 RCD 固定任务成功率，也不是本地 Electron/Runtime 端到端结果。命令中 usage recording 测试使用其测试替身，没有外部 Provider 请求。真实 Provider 测试 `not_run`，没有启用付费服务。

## 指标可得性

| 指标 | 当前来源 | 本次基线 |
|---|---|---|
| 外部 Oracle 成功/失败/部分、正确拒绝、安全阻断、未验证要求数量 | 固定场景逐次 artifact/test oracle | unavailable：尚无场景运行账本 |
| 非必要停止、用户“继续”次数、停止原因 | Runtime status/event 与 conversation continuation，需投影聚合 | unavailable：没有 RCD 场景运行 |
| 参数错误修正、合法重复执行、恢复重复副作用 | tool invocation + side-effect settlement + fixture oracle | unavailable：已有测试覆盖部分机制，但不是该场景的运行率 |
| 模型调用/工具调用/审批/拒绝 | execution log/modelRequests/toolInvocations/approval record | 逐次运行时可读；本批任务场景无运行数 |
| Provider token usage | 真实 Provider usage receipt | unavailable：本次无真实 Provider run |
| 成本 | 需命中可审计、可版本化价格依据 | unavailable；未估算 |
| 首个有效成果、总耗时 | 实际工具事件时间 + 外部 Oracle 判定 + run duration | unavailable：尚无 task run |
| 模型/协议/配置/版本/环境/重复编号 | 现有实验脚本部分支持；RCD manifest 记录源码/环境/场景哈希 | 本地代码与环境已记录；Provider 配置与重复编号不适用 |

## S0 出门条件状态

| 条件 | 状态 | 证据/说明 |
|---|---|---|
| 24 个场景定义并有独立 Oracle | 通过（定义层） | 场景 JSON 与结构校验通过 |
| 可重复初始化和清理环境 | 未通过 | 当前仅有每场景重置说明，没有可执行初始化/清理夹具 |
| 基线关联明确代码与配置版本 | 部分 | HEAD/工作树/运行时版本/lockfile/场景哈希已固定；场景配置尚无逐次运行记录 |
| 区分失败、安全阻断、未验证 | 通过（协议层） | `kind`、acceptableStops 与 Oracle 定义分列；无运行样本 |
| 复用可靠指标，不建重复存储 | 通过（设计） | 使用 execution log、checkpoint、provider usage、context snapshot；RCD 只需脱敏投影 |
| 不影响正常产品行为 | 通过 | 仅新增评测规格/脚本/文档，未改生产包 |
| S0 报告与原始数据 | 部分 | 报告与可追溯 manifest 已交付；没有任务运行原始账本，因为场景未运行 |

## 下一步与边界

S0 仍需完成场景初始化/清理和实际场景驱动器，再运行确定性离线与本地 Runtime 层并生成逐次脱敏账本。真实 Provider 层需要独立冻结模型、协议、配置、权限和预算；未授权前保持 `not_run`。本次没有修改 S1–S3 生产行为，Shell/网络/Memory 权限边界未变化。
