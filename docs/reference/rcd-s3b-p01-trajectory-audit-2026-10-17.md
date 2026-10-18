# RCD S3B-P01 实际轨迹审计报告

**审计日期：** 2026-10-17（证据批次日期；本报告实际生成于 2026-10-18T14:57:05+08:00）

**审计工作树：** 仓库独立工作树（分支 `codex/s3b-p-reliability-closure`，基线 `7a29444afa98f1e249fc29e330d6ae81355aab74`）

**机器可读账本：** [P01 审计账本](rcd-s3b-p01-audit-ledger-2026-10-17.json)

**审计性质：** 只读。未修改任何既有账本、Oracle、任务集或历史报告；未联网；未调用真实 DeepSeek API（`realProviderCallsMade: 0`）。

---

## 1. 结论

1. 四项真实 DeepSeek 任务在修正模型 ID 后各有一次有效试跑：CODE-01 trial 2 `passed`、FILE-02 trial 2 `failed`、DELIV-01 trial 1 `failed`、MULTI-01 trial 1 `passed`，即 2/4。该比例**不可作为成功率主张**（`counts.validProviderModelIdPassRateNotClaimed: true`）。
2. 有效运行汇总事实经逐项求和复核后与账本汇总完全一致：**13 次逻辑模型请求、13 次物理 Provider 请求、11 次工具提议、11 次工具执行、7 个已结算 Effect、0 个 unknown Effect**；Usage 为 input 38,093 / output 1,794 / cached input 26,240 tokens；总时长 32,831 ms；Provider HTTP 失败 0；Agent Web 请求 0；禁网违规 0；清理失败 0。
3. 另有 **2 次错误模型 ID 的真实请求尝试**（CODE-01 trial 1、FILE-02 trial 1），各消耗 **8 个物理请求，合计 16 个**，全部为真实、在原则上可计费的请求，**不计入有效任务成功率，也不得假定无费用**。
4. 另有 **2 次零模型请求的评测器分派诊断**（CODE-01、FILE-02），账本把模型请求计数留为 `null` 而不是 `0`，属 `harness_error`，与上述 16 个请求的尝试是**不同类别**。
5. 29 个已记录物理请求 = 13（有效）+ 16（错误模型 ID 尝试），与 `counts.allRecordedActualPhysicalProviderRequests: 29` 一致。
6. 证据充分性分级：`strong` 4 条（四次有效运行）、`partial` 3 条（两次错误模型 ID 尝试 + DELIV-02 受控记录）、`insufficient` 2 条（两次分派诊断）。
7. 发现 **2 条已确认的字段级缺陷**（顶层脏源布尔字段语义冲突、DELIV-01 失败归因标签与同账本 Oracle 证据冲突）与 5 条待澄清观察，详见第 8 节。历史账本保持原样。
8. Agent 最终回复文本、首个有效产物延迟、人工干预次数在真实运行中**均不可得**，已按 `evidence_insufficient` 记录并附 `reason`，未据汇总编造调用过程。

---

## 2. 审计范围与证据源

| 证据源 | 用途 |
|---|---|
| [DeepSeek 批次结果](rcd-s3b-real-deepseek-batch-2026-10-17.json) | 6 条 `records`、`dispatchDiagnostics`、`counts`、`attempts`、`productBaseline`、`provider` |
| [CODE-01 trial 1](rcd-s3b-real-deepseek-CODE-01-trial-1-2026-10-17.json) / [trial 2](rcd-s3b-real-deepseek-CODE-01-trial-2-2026-10-17.json) / [FILE-02 trial 1](rcd-s3b-real-deepseek-FILE-02-trial-1-2026-10-17.json) / [trial 2](rcd-s3b-real-deepseek-FILE-02-trial-2-2026-10-17.json) / [DELIV-01 trial 1](rcd-s3b-real-deepseek-DELIV-01-trial-1-2026-10-17.json) / [MULTI-01 trial 1](rcd-s3b-real-deepseek-MULTI-01-trial-1-2026-10-17.json) | 逐次原始账本（与批次 `records` 对应） |
| [CODE-01 分派诊断](rcd-s3b-real-deepseek-CODE-01-dispatch-diagnostic-2026-10-17.json) / [FILE-02 分派诊断](rcd-s3b-real-deepseek-FILE-02-dispatch-diagnostic-2026-10-17.json) | 2 次零模型请求诊断 |
| [S3B 受控基线](rcd-s3b-controlled-baseline-2026-10-17.json) | `recordId s3b-1792220493421-deliv-02-1`（DELIV-02，A 层脚本 Provider） |
| [真实试跑报告](rcd-s3b-real-deepseek-report-2026-10-17.md)、[评测报告](rcd-s3b-evaluation-report-2026-10-17.md)、[评测协议](rcd-s3b-provider-evaluation-2026-10-17.md) | 方法学、限制与既有结论 |
| [S3A 任务集](rcd-s3a-task-suite-2026-10-17.json)（冻结，`suiteSha256 b210e505…`） | `userInput`、`allowedTools`、`oracle`、`successConditions` |
| [S3A 基线](rcd-s3a-baseline-2026-10-17.md)、[评测协议](rcd-s3a-evaluation-protocol-2026-10-17.md)、[场景审计](rcd-s3a-scenario-audit-2026-10-17.json) | 证据层级与审计口径 |

审计账本共 9 条 `perAttempt`：4 条 `valid`、2 条 `invalid_model_id`、2 条 `dispatch_diagnostic`、1 条 `controlled_baseline`。

---

## 3. 逐任务轨迹表（4 次有效运行）

| 任务 | 有效试跑 | 请求模型（线上） | 响应模型 | 逻辑/物理请求 | 工具提议/执行 | 已结算 Effect | Usage (in/out/cached) | Oracle | 产物哈希 | 总时长 |
|---|---|---|---:|---:|---:|---:|---:|---|---|---:|
| CODE-01 | trial 2 | `deepseek-flash` | `deepseek-flash` | 4 / 4 | 3 / 3 | 1 | 11780 / 471 / 8704 | `passed` | `src/label.mjs` `3bb26706…`（47 B） | 9631 ms |
| FILE-02 | trial 2 | `deepseek-flash` | `deepseek-flash` | 4 / 4 | 3 / 3 | 1 | 11852 / 708 / 8832 | `failed` | `inventory-summary.json` `54858768…`（135 B） | 9800 ms |
| DELIV-01 | trial 1 | `deepseek-flash` | `deepseek-flash` | 2 / 2 | 1 / 1 | 1 | 5218 / 193 / 2432 | `failed` | `result.txt` `69188ece…`（15 B） | 4430 ms |
| MULTI-01 | trial 1 | `deepseek-flash` | `deepseek-flash` | 3 / 3 | 4 / 4 | 4 | 9243 / 422 / 6272 | `passed` | `a.txt` `2cf24dba…`、`b.txt` `486ea462…`（各 5 B） | 8970 ms |
| **合计** | 4 | — | — | **13 / 13** | **11 / 11** | **7** | **38093 / 1794 / 26240** | 2 passed / 2 failed | — | **32831 ms** |

字段来源：`records[4]`（CODE-01/2）、`records[5]`（FILE-02/2）、`records[2]`（DELIV-01/1）、`records[3]`（MULTI-01/1）的 `provider.parameters.observed[*]`、`execution.*`、`oracle.details`。逐项求和与 `counts.validProviderModelId*` 一致（见账本 `aggregates.crossCheckWithBatchCounts.match = true`）。

### 3.1 逐任务行为要点

- **CODE-01（`records[4]`）**：工具序列为 `read` → `write` → `read`（`execution.invocationEvidence`），仅 1 个写入 Effect（`tool:write:05350d9b…`）。Oracle 期望 `ready`、实际 `ready`，产物 47 字节。
- **FILE-02（`records[5]`）**：同样 `read` → `write` → `read`，1 个写入 Effect（`tool:write:d905b99d…`）。`oracle.details.actual` 为 `{"total_quantity":5,"items":[{"sku":"A","qty":2},{"sku":"B","qty":3}]}`，而 `expected` 要求键 `total`；SKU 顺序与数量正确，失败原因是输出字段名不符。
- **DELIV-01（`records[2]`）**：`fixture_write_exact` 提议 1 次、执行 1 次、结算 1 次；`oracle.details.validationFailure = false`、`fixtureExecutions = 1`、`contentMatches = true`。失败原因是任务条件“先出现参数校验失败再修正”未被满足，而不是产物问题（另见第 8.2 节归因缺陷）。
- **MULTI-01（`records[3]`）**：工具序列为 `write`、`write`、`runtime_check_file_content`、`runtime_check_file_content`，4 个 Effect 全部结算；`oracle.details.requirementStatuses = ["passed","passed"]`、`taskOutcomeStatus = completed`。

---

## 4. 逐字段核查（对应任务书 7 项）

### 4.1 产品与评测器 Git SHA

- 冻结产品提交：`d5015136ca9cf9583423361263b5bacba257a385`（`productBaseline.frozenProductHead`；6/6 `records[i].source.frozenProductHead` 一致）。
- 评测分支 HEAD：`edf35ef7cbe38aca901976623310ce5de6207bac`（`productBaseline.evaluationBranchHead`；6/6 `records[i].source.productHead` 一致）。
- 评测器指纹按运行不同：`records[0] 768c0fa1…`、`records[1] 670917da…`、`records[2]/[3] bae9c5cf…`、`records[4]/[5] 924484012…`；工作树指纹相应为 `94bed4e5…`、`ba8f67e2…`、`d6292574…`、`2a09d5f9…`。
- `productSourceDirty`：**逐记录均为 `false`**（6/6 `records[i].source.productSourceDirty`），且 `unclassifiedDirtyPaths`、`unclassifiedCommittedPaths` 均为空；`dirty` 均为 `true` 且 `dirtyPaths` 只含评测产物。顶层 `productBaseline.productSourceDirty` 为 `true`，语义冲突见第 8.1 节。

### 4.2 用户原始任务文本与实际 Prompt

| 任务 | 冻结 `userInput`（`rcd-s3a-task-suite-2026-10-17.json`） |
|---|---|
| CODE-01 | `In src/label.mjs, change taskLabel() so it returns the exact string "ready".`（`tasks[0].userInput`） |
| FILE-02 | `Read inventory.csv and create inventory-summary.json with total quantity 5 and items sorted by sku, preserving each quantity.`（`tasks[4].userInput`） |
| DELIV-01 | `Use the fixture writer to create result.txt containing exactly verified-output. Correct any parameter validation error before stopping.`（`tasks[9].userInput`） |
| MULTI-01 | `创建 a.txt，内容必须为 hello。\n创建 b.txt，内容必须为 world。`（`tasks[11].userInput`） |
| DELIV-02 | `Create result.txt containing exactly hello and independently check the file contents before you say it is complete.`（`tasks[10].userInput`） |

**实际传入 Prompt：`unavailable`（全部 9 条）**，`reason`：账本不保存请求正文，评测协议明确不在报告中保存完整 Prompt（[评测协议](rcd-s3b-provider-evaluation-2026-10-17.md) 第 17、32 行）。等价证据仅限：冻结 `userInput` + `records[*].environment.evaluatorCommand`（如 `node scripts/s3b-eval.mjs --run-real --task=CODE-01 --trial=2`）+ `records[*].execution.executionLayer`。**未推测任何消息序列或系统提示词内容。**

### 4.3 请求模型 ID 与响应模型标识

- 权威来源为 `attempts[]`：`attempts[0]`/`attempts[1]` 的 `internalModelRef` 与 `providerModelIdSent` 均为 `deepseek/deepseek-flash`；`attempts[2..5]` 的 `providerModelIdSent` 为 `deepseek-flash`（`internalModelRef` 仍为 `deepseek/deepseek-flash`）。
- 与 `records[*].provider.parameters.observed[*].model` 一致：`records[0]`/`records[1]` 的 5 个观测请求 `model` 均为 `deepseek/deepseek-flash`；`records[2..5]` 为 `deepseek-flash`，并另记 `requestedModelRef = deepseek/deepseek-flash`。
- Provider 响应模型标识：`records[2..5].execution.modelResponseModels = ["deepseek-flash"]`；`records[0]`/`records[1]` 为 `null`（无成功响应）。
- 运行参数：`thinking: enabled`（`records[4]`/`records[5].provider.parameters.observed[*].thinking`），`temperature: null`，`topP: null`，`seed: null`，`unsupported: ["top_p","seed"]`；未把 Provider 默认值伪装成显式设置。

### 4.4 工具提议与实际执行

| 试跑 | 提议（`toolCallProposals`） | 执行（`toolExecutions`） | 逐调用证据（`invocationEvidence`） |
|---|---:|---:|---|
| CODE-01/2 `records[4]` | 3 | 3 | `read`/`write`/`read`，均 `succeeded` |
| FILE-02/2 `records[5]` | 3 | 3 | `read`/`write`/`read`，均 `succeeded` |
| DELIV-01/1 `records[2]` | 1 | 1 | `fixture_write_exact`，`succeeded` |
| MULTI-01/1 `records[3]` | 4 | 4 | `write`×2、`runtime_check_file_content`×2，均 `succeeded` |
| CODE-01/1、FILE-02/1 | 0 | 0 | `invocationEvidence: []` |

合计 11 次提议、11 次执行，`deniedToolCalls = 0`、`failedToolCalls = 0`。未用提议数替代执行数（评测协议第 25 行口径）。

### 4.5 工具返回、Effect 结算与最终产物

- 已结算 Effect 合计 **7**：CODE-01/2 = 1、FILE-02/2 = 1、DELIV-01/1 = 1、MULTI-01/1 = 4，`unknownEffects` 全为 0。逐项 `effectEvidence` 均带 `idempotencyKey`（如 `tool:write:a6614e6c…`）。
- 最终产物哈希（`oracle.details.evidence`）：CODE-01/2 `src/label.mjs 3bb26706…`（47 B）；FILE-02/2 `inventory-summary.json 54858768…`（135 B）；DELIV-01/1 `result.txt 69188ece…`（15 B）；MULTI-01/1 `a.txt 2cf24dba…`、`b.txt 486ea462…`（各 5 B）。
- 两次错误模型 ID 尝试的产物：CODE-01/1 为种子原样 `src/label.mjs 0fb101e1…`（45 B，`actual: "old"`）；FILE-02/1 为 `inventory-summary.json e3b0c442…`（0 B，空文件），`files` 仅 `["inventory.csv"]`。

### 4.6 Agent 最终回复与独立 Oracle

- **Agent 最终回复：`unavailable`**。6 次真实 Runner/Harness 账本均无回复文本字段，`records[*].oracle.falseCompletionClaim` 全为 `null`，`counts.validProviderModelIdFalseCompletionClaims.status = unavailable`，`reason: "The Runner result exposed no final reply string to the live task observation adapter."`
- 独立 Oracle 结果：`records[2] failed`、`records[3] passed`、`records[4] passed`、`records[5] failed`；两次错误模型 ID 尝试均为 `failed`；两次分派诊断为 `unverified`（`method: "Oracle did not report an outcome"`）。
- Oracle 方法（`oracle.method`）分别为：CODE-01 独立 Node 进程导入模块并断言 `taskLabel()`；FILE-02 独立磁盘读取 + JSON 解析 + 精确值与文件集合检查；DELIV-01 独立文件读取 + `ToolInvocationRecord` 校验；MULTI-01 独立磁盘读取 + 持久化 Task Outcome 要求检查（模型摘要被忽略）。
- 对照：受控 DELIV-02 记录因脚本 Provider 路径不同而取得 `falseCompletionClaim: true`（`records[7].oracle.falseCompletionClaim`，`checkerInvoked: false`，`actual: "goodbye"`）。

### 4.7 Usage、物理请求、失败请求与成本

| 指标 | 有效运行（4 次） | 错误模型 ID 尝试（2 次） | 分派诊断（2 次） |
|---|---:|---:|---:|
| 逻辑模型请求 | 13 | 10 | `null` |
| 物理 Provider 请求 | 13 | 16（各 8） | `null` |
| 失败请求 | 0 | 16（各 8） | `null` |
| 发送前被拦截 | 0 | 2（各 1） | 0 |
| Usage (in/out/cached) | 38093 / 1794 / 26240 | `unavailable`（`responseCount: 0`） | `unavailable` |
| 成本 | `unavailable` | `unavailable`（**不得假定无费用**） | `unavailable` |

- `cost.status` 在全部 9 条 `perAttempt` 中保持 `unavailable`，`reason` 为无权威账单回执、未据 token 或余额变化推算费用；`provider.budget.providerBillingReceipt = "unavailable"`。
- FILE-02/1 记录了 8 条 HTTP 400（`records[1].execution.providerHttpResponses`，`attempt 1..8`，`endpointOrigin https://api.deepseek.com`）；CODE-01/1 **未**记录逐请求状态，仅有 `network.providerHttpFailures = 8`（见第 9.5 节）。
- 有效运行 `providerHttpFailures = 0`，逐请求状态均为 200（`records[2..5].execution.providerHttpResponses`）。
- 审批：`records[2].execution.approvals.count = 1`，来源为测试适配器可信回调，**不是**人工审批（`notes[3]`）。人工干预次数 `unavailable`。

---

## 5. 必须保留的汇总事实

1. **首批有效运行：13 次 Provider 请求、11 次工具提议、11 次工具执行、7 个已结算 Effect**，另 0 个 unknown Effect、0 次拒绝调用、0 次失败调用。逐项求和与 `counts.validProviderModelId*` 一致。
2. **两次失败试跑各 8 次物理请求（合计 16）**：CODE-01 trial 1（`records[0]`，`attempts[0].physicalProviderRequests = 8`）与 FILE-02 trial 1（`records[1]`，`attempts[1].physicalProviderRequests = 8`）。二者为真实请求尝试，`cost.status` 为 `unavailable`，**不计入有效任务成功率，且不得假定无费用**。FILE-02 trial 1 记录了 8 个 HTTP 400。
3. **两次分派诊断为零模型请求诊断**：`records[0].execution.physicalProviderRequests = null`、`counts.physicalProviderRequests = null`、`executionLayer = "not recorded"`，`failureAttribution.primary = "evaluation_infrastructure"`。账本未记录请求数，**不把 `null` 当 0，也不据汇总编造调用过程**。
4. 三类运行必须分开统计：**4 次有效 / 2 次错误模型 ID（16 请求）/ 2 次零请求分派诊断**。任务书括号中把 8 个 HTTP 400 归到 CODE-01 dispatch diagnostic 属笔误，已按账本字段纠正（见第 8.5 节）。
5. 未修改冻结 Oracle，未重写任何历史账本来提高通过率；FILE-02 与 DELIV-01 的真实失败保持为失败，Runtime `ok` 不被当作任务通过。

---

## 6. 证据充分性分级

分级定义见账本 `evidenceLevelDefinitions`。

| 分级 | 条数 | 对象 | 依据 |
|---|---:|---|---|
| `strong` | 4 | CODE-01/2、FILE-02/2、DELIV-01/1、MULTI-01/1 | 独立原始账本齐备：逻辑/物理请求、工具提议与执行、Effect、可用 Usage 回执、确定 Oracle 结果与产物哈希 |
| `partial` | 3 | CODE-01/1、FILE-02/1、DELIV-02/1（受控） | 有原始账本但关键字段缺失：错误模型 ID 尝试无 Usage、无成功响应模型标识；CODE-01/1 还缺逐请求状态；DELIV-02 的 `invocationEvidence`/`effectEvidence` 为空且 Provider 为脚本 |
| `insufficient` | 2 | CODE-01 分派诊断、FILE-02 分派诊断 | 模型请求、工具提议、工具执行、Effect 计数均为 `null`，无逐调用证据，Oracle `unverified`，无法重建调用过程 |

---

## 7. 限制说明

1. 本审计为**只读字段级取证**，未重新执行产品运行时、未复现任何试跑。
2. 样本为 4 项任务各 1 次修正后试跑，**不能**作为模型成功率估计；`validProviderModelIdPassRateNotClaimed = true`。
3. 无 Electron Main/Renderer 验收；`approvals` 回调来自测试适配器自动返回允许。
4. 未取得 Agent 最终回复文本、首个有效产物延迟与人工干预次数，相关指标保持 `unavailable`。
5. 无权威账单回执，29 个已记录物理请求的真实费用未知；本审计未联网核实 DeepSeek 官方文档或账户余额。
6. 评测器指纹在运行间不一致（4 个值），不存在单一字节级评测器版本，行为对照只能以任务结果与产品基线为准。
7. 受控基线账本共 8 条记录，本审计仅逐字段展开任务书点名的 DELIV-02 记录；其余 7 条不在 P01 真实轨迹审计范围内。

---

## 8. 发现的不一致与缺陷

### 8.1 顶层 `productSourceDirty` 与逐记录语义冲突（已确认）

- 字段路径：`rcd-s3b-real-deepseek-batch-2026-10-17.json:productBaseline.productSourceDirty = true`；而 `records[i].source.productSourceDirty = false`（i=0..5，6/6）。
- 同时 `records[i].source.dirty = true` 且 `dirtyPaths` 非空（6/6），`unclassifiedDirtyPaths = []`、`unclassifiedCommittedPaths = []`、`fingerprintStableDuringTrial = true`（6/6）。
- **审计结论：** 逐记录的产品源码纯度有支持——所有 `dirtyPaths` 均可归类为评测产物（`docs/reference` 账本、`scripts/lib/s3b-provider-config.*`、`scripts/s3b-eval.mjs`、`test/s3b-*.test.ts`），且无未分类脏路径。顶层布尔字段复用了同名 `productSourceDirty` 却表达不同含义（工作树整体是否干净），**不得读作“产品源码被修改”**。
- **建议：** 未来新增或改名以区分两种含义（如 `evaluationArtifactsDirty` / `productSourceDirty`）。本次**不修改**既有账本。
- 相关：[真实试跑报告](rcd-s3b-real-deepseek-report-2026-10-17.md) 第 52 行“所有运行均报告 `productSourceDirty: false`”与逐记录字段一致，但与顶层布尔字段不一致。

### 8.2 DELIV-01 失败归因标签与同账本 Oracle 证据冲突（已确认）

- `records[2].failureAttribution = { primary: "artifact_wrong_or_missing", secondary: [], confidence: "high" }`。
- 同一试跑账本 `records[2].oracle.details`：`contentMatches = true`、`validationFailure = false`、`fixtureExecutions = 1`，产物 `result.txt` `sha256 69188ece3b5874fdca30429af10e9c357002ac68e48883f29d825d51501664b0`（15 字节）。
- **审计结论：** 该次尝试的产物存在、内容匹配且哈希已记录，失败原因是任务条件未满足（未出现“参数校验失败后再修正”的证据），**不是**产物错误或缺失。`artifact_wrong_or_missing` 对本次尝试在事实上不成立，属评测器归因标签缺陷。
- **建议：** 评测器应把“产物内容匹配但任务条件未满足”映射到独立归因类别（如 `task_condition_not_met`）。修复由 task-3 负责；历史账本保持原样。
- 相关：[真实试跑报告](rcd-s3b-real-deepseek-report-2026-10-17.md) 第 39 行已正确区分“工具副作用成功”与“任务条件未满足”。

### 8.3 MULTI-01 冻结 `successConditions` 与真实运行 Oracle 语义不一致（待澄清）

- `rcd-s3a-task-suite-2026-10-17.json:tasks[11].successConditions = ["a.txt is hello and passes its check.", "b.txt is deliberately goodbye and fails its check.", "Overall task outcome is partial, and no model summary upgrades b.txt."]`，但 `tasks[11].userInput` 要求 b.txt 为 `world`。
- 真实运行 `records[3].oracle.result = passed`、`details.requirementStatuses = ["passed","passed"]`、`details.taskOutcomeStatus = completed`，方法为“独立磁盘读取 + 持久化 Task Outcome 要求检查”。
- **结论：** 冻结 `successConditions` 描述的是受控/脚本场景（预置 b.txt 为 `goodbye` 的部分失败），与真实模型运行采用的 Oracle 方法不一致，需产品/评测负责人澄清。未修改冻结任务集与 Oracle。

### 8.4 DELIV-02 在冻结任务集中标记 `not_run`，但存在受控运行记录（待澄清）

- `tasks[10].adapter = { status: "not_run", layer: null, providerSimulated: null }`；而受控基线 `records[7].recordId = s3b-1792220493421-deliv-02-1`，`infrastructureStatus = executed`。
- **结论：** 冻结任务集为 S3A 时期快照，早于 S3B 受控适配器实现；该记录是 A 层脚本 Provider（`provider.kind = "scripted"`，物理请求 0），不改变“DELIV-02 无真实模型试跑”的事实。

### 8.5 任务书对 8 请求尝试与分派诊断的混写（已纠正）

- 分派诊断账本 `records[0].execution.physicalProviderRequests = null`、`counts.physicalProviderRequests = null`、`executionLayer = "not recorded"`。
- 两次各 8 个物理请求的失败尝试是 `records[0]`（CODE-01 trial 1）与 `records[1]`（FILE-02 trial 1），见 `attempts[0]`/`attempts[1].physicalProviderRequests = 8`；8 条 HTTP 400 位于 `records[1].execution.providerHttpResponses`。
- **结论：** 按账本字段纠正为“4 次有效 / 2 次错误模型 ID（16 请求）/ 2 次零请求分派诊断”，未修改任何账本。

### 8.6 其他观察

- **评测器指纹与工作树指纹在运行间不一致**（`evaluationSourceFingerprintsVaryAcrossAttempts = true`）；顶层指纹数组只覆盖 6 条 `records`，未包含 2 条分派诊断的指纹（`cfb1acfe…`、`52c50617…` 与工作树 `56f6ed71…`、`a6f6f5d7…`），属范围说明而非缺陷。
- **`approvals.count = 1` 不是人工审批**：来源为 `trusted Runner approve callback invocation count`，`counts.validProviderModelIdHumanInterventions` 保持 `unavailable`。

---

## 9. 证据缺口（`evidence_insufficient`）

| ID | 缺口 | 范围 | 字段路径 | reason |
|---|---|---|---|---|
| `gap-agent-final-reply` | Agent 最终回复文本不可得 | 4 有效 + 2 错误模型 ID | `counts.validProviderModelIdFalseCompletionClaims.status`、`records[*].oracle.falseCompletionClaim = null` | The Runner result exposed no final reply string to the live task observation adapter. |
| `gap-first-artifact-latency` | 首个有效产物时间不可得 | 4 有效 | `counts.validProviderModelIdFirstEffectiveArtifactLatencyMs.status`、`records[*].execution.durationMs` | The Runner/Harness adapter records total duration but not first artifact timestamp. |
| `gap-human-interventions` | 人工干预次数不可得 | 4 有效 | `counts.validProviderModelIdHumanInterventions.status`、`records[*].execution.approvals.source` | No interactive user message/approval UI is connected to this test adapter. |
| `gap-prompt-text` | 实际 Prompt 文本未记录 | 全部 9 条 | `perAttempt[*].promptAvailability.status`、`records[*].environment.evaluatorCommand` | 账本不保存请求正文；评测协议第 17、32 行明确不保存完整 Prompt。 |
| `gap-code01-trial1-http-statuses` | CODE-01 trial 1 未记录逐请求 HTTP 状态 | 1 条 | `records[0].execution.network.providerHttpFailures = 8`，无 `providerHttpResponses` | 只有汇总失败计数，无法逐条核实状态码。 |
| `gap-billing-receipt` | 无权威账单回执 | 全部 9 条 | `records[*].execution.cost.status = unavailable`、`provider.budget.providerBillingReceipt` | Provider returned no authoritative billing receipt; no cost was inferred from tokens. |
| `gap-controlled-deliv02-invocation-evidence` | DELIV-02 受控记录缺逐调用证据 | 1 条 | `records[7].execution.invocationEvidence = []`、`effectEvidence = []`，而 `toolExecutions = 1` | 只能给出计数，无法逐项核对工具与 Effect。 |

---

## 10. 复现与校验

```powershell
# JSON 可被解析
$j = Get-Content "docs\reference\rcd-s3b-p01-audit-ledger-2026-10-17.json" -Raw | ConvertFrom-Json
$j.perAttempt.Count            # 9
$j.aggregates.validRuns.physicalProviderRequests   # 13
$j.aggregates.validRuns.toolCallProposals          # 11
$j.aggregates.validRuns.toolExecutions             # 11
$j.aggregates.validRuns.settledEffects             # 7
$j.aggregates.invalidModelIdAttempts.physicalProviderRequests  # 16
$j.aggregates.allRecordedActualPhysicalProviderRequests        # 29
```

本次审计已执行该校验：JSON 解析通过；`perAttempt` = 9（valid 4 / invalid_model_id 2 / dispatch_diagnostic 2 / controlled_baseline 1）；逐项求和结果 13 / 13 / 11 / 11 / 7 / 0，Usage 38093 / 1794 / 26240，总时长 32831 ms，错误模型 ID 尝试 16 请求 / 16 失败 / 2 拦截，与批次 `counts` 及本报告全部汇总数字一致。

**未执行：** 真实 DeepSeek API 调用、任何网络访问、任何对既有账本/Oracle/任务集/历史报告的写入。
