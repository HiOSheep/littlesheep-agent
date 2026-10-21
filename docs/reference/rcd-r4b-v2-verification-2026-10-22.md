# RCD R4-B 三维评测契约 V2 最终验收记录

**验收日期：** 2026-10-22

**代码基线：** `71fcb594`（R4-B3）之上的 R4-B4 工作树；本记录在 R4-B4 提交前生成，提交内容与受验文件一致。

**范围：** 全阶段离线。未调用真实付费 Provider；未修改 S3A/S3B 冻结任务集、冻结 Oracle、历史账本或历史成功条件；未自动推送 GitHub；未启动 R4-C/R4-D。

## 1. 受验交付物

| 层 | 交付物 |
|---|---|
| 契约 | `docs/reference/rcd-r4b-v2-contract-schema-2026-10-21.json`、`scripts/lib/r4b/contract.mjs`（运行时校验、指纹、冻结哈希、legacy 只读读取） |
| 任务 | `docs/reference/rcd-r4b-v2-task-suite-2026-10-21.json`、`scripts/lib/r4b/tasks.mjs`、四项任务：FILE-02-G / FILE-02-S / DELIV-01-G / DELIV-01-R |
| Oracle | `scripts/lib/r4b/oracles.mjs`（Goal / Contract / Mechanism 独立结算；纯函数，正负样例共用） |
| 执行 | `test/v2-task-adapters.test.ts`（真实 Runner/Harness/Tools + scripted Provider）、`scripts/eval-v2.mjs` |
| Trial/预算 | `scripts/lib/r4b/trials.mjs`、`ledger.mjs`、`record.mjs`、`budget.mjs`、`metrics.mjs` |
| 账本/报告 | `docs/reference/rcd-r4b-v2-records/`（20 条不可变记录）、`rcd-r4b-v2-ledger-2026-10-21.json`、`rcd-r4b-v2-report-2026-10-21.md` |

## 2. 验证命令与结果

| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm run typecheck` | exit 0 | `tsc -b tsconfig.workspace.json` |
| `pnpm run check:repo` | ok（35 passed / 3 advisory / 0 failed） | 仓库卫生 + TypeScript 项目引用 27 包 |
| `pnpm run test:v2` | **66 tests / 6 files passed**，185.8 s | contract 19、tasks 6、oracles 16、trial/budget 11、ledger/report 5、controlled E2E 9 |
| `node scripts/rcd-s0.mjs run --core` | exit 0，6/6 executed | 3 passed / 1 partially_completed / 2 correctly_blocked；0 blocked / 0 harness_error / 0 not_run |
| `pnpm run test:ci-recovery` | exit 0，188.3 s | 41 passed / 6 skipped 文件；200 passed / 7 skipped 用例（47 文件 / 207 用例） |
| `pnpm run verify:full` | **`[gate] full passed`**，792.8 s | 5 阶段实执行：check:repo 25.6 s、tests 697.6 s、typecheck 0.8 s、build 67.6 s、recovery 1.3 s；结构化报告 `status: passed` |

`verify:full` 为本地验证路径：`verify:app-recovery` 阶段读取本机真实数据根（非合成根）；托管 CI 使用隔离合成数据根，两者不可互相替代。本批次未运行 Electron GUI、WSL 终端、真实 Provider 与 Linux/macOS 专项，均在上表之外明确未运行。

## 3. 冻结核查

`scripts/lib/r4b/contract.test.mjs` 在每次 `test:v2` 中重新哈希以下冻结文件并断言未变：

| 文件 | 冻结 sha256 |
|---|---|
| `rcd-s3a-task-suite-2026-10-17.json` | `b210e505…a629ec` |
| `rcd-s3b-metrics-schema-2026-10-17.json` | `dac05d05…c994b65` |
| `rcd-s3b-adapter-extension-2026-10-17.json` | `8172bacd…b8b66e8` |
| `rcd-s3a-evaluation-protocol-2026-10-17.md` | `c84dd79f…6a259c` |
| `rcd-s0f-core-baseline-2026-10-16.json` | `05a4ac62…d60084` |

V2 任务集通过 `frozenAncestry.s3aTaskSuite.sha256` 引用同一冻结哈希；四项任务只读取 ancestry，不改写历史文件。

## 4. 三维度与分母纪律

受控数据集（4 任务 × Trial 1–5 = 20 条记录，批次 `r4b-offline-2026-10-21`）：

| 指标 | 分母 ID | n | 通过 | 失败 | 排除 |
|---|---|---:|---:|---:|---|
| Goal 完成率 | `A_runtime_deterministic:goal` | 20 | 20 | 0 | — |
| Contract 遵循率 | `A_runtime_deterministic:contract` | 5 | 5 | 0 | `not_applicable=15` |
| Mechanism 已触发成功率 | `A_runtime_deterministic:mechanism` | 5 | 5 | 0 | `not_exercised=15` |

- 20 条记录共用单一评测器指纹 `56d97aae…5748c4`；产品 SHA 记录为 `71fcb594…`（生成时 HEAD），`product.dirty=true`、`product.sourceDirty=false`（所有脏路径均为评测产物，不属于产品源码）。
- 历史结果只读展示，分母固定 `legacy-frozen-s3b`：受控历史 8 条、真实模型尝试 6 条（4 条有效 + 2 条错误模型 ID 各 8 请求 = **16 次失败请求**）；该 16 次请求保留在历史展示区，**不进入任何 V2 分母**。
- 受控与真实样本不混算；`populationClaim=false`；`not_exercised`、`unverified`、`not_applicable`、`blocked` 不计入已触发机制的成功/失败分母。

## 5. 负向能力证据

`test:v2` 中的负向样例不是只验证成功路径：

- FILE-02-G/S：错误 total、错误 items、错误顺序、错误类型、缺失/额外文件、字段名错误（Goal passed / Contract failed 独立结算）。
- DELIV-01-G/R：错误内容、额外文件、重复执行；未触发故障返回 `not_exercised`；已触发未恢复返回 `mechanism=failed`；权限阻断返回 `blocked`；重复副作用被产品以 `repeated_call_blocked/side_effect_replay` 阻断且 Oracle 记录零重复 Effect。
- Contract 层：未在模型可见任务文本出现的约束不能判为 Contract 违约；字段名错误不会被提升为 Goal 失败。
- Trial/账本：重复身份拒绝、写入中断无半写文件、trial 0/6 拒绝、并发请求不能绕过预算、重试/失败请求计入物理预算、Usage 缺失保持 `unavailable`。

## 6. 未运行与残余风险

- **未运行：** 真实付费 Provider（`real_provider_pending`，本批次不授权）；Electron GUI 真实显示器验收；WSL 终端专项（host-only opt-in）；Linux/macOS 构建与打包；性能 soak。
- 受控 scripted Provider 只验证评测基础设施与 Oracle 行为，**不代表模型能力或真实任务成功率**；N=5 只证明机制可支持五次独立、可复现运行，不构成对真实 API 的授权。
- 账本与报告是本地产物，不含签名；可信度依赖工作树/评测器指纹与冻结哈希的独立复核。
- 历史 S3B 失败归因分类器与 V2 不同尺度，报告已分列，不做相加或直接比较。
- 本记录生成后仅新增文档/账本/报告文件，未修改产品 Runtime/Harness/Tools/Prompt 或任何冻结评测输入。
