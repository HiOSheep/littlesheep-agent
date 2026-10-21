# RCD R4-B 评测契约 V2 设计报告（B0）

**日期：** 2026-10-21

**基线：** `main` @ `c12fb52e031d70c29f5781a4ea843ba474b2df6a`（工作树干净；R4-A 与首次 GitHub 托管 CI 验收已完成）

**性质：** 离线设计报告。本批次不调用真实付费 Provider，不修改 S3A/S3B 冻结任务集、冻结 Oracle、历史账本或历史成功条件。

## 1. 现状核查

- S3B-P 已进入主线：`scripts/s3a-eval.mjs`、`scripts/s3b-eval.mjs`、`scripts/lib/s3b-provider-config.mjs`、`test/s3a-task-adapters.test.ts`、`test/s3b-task-adapters.test.ts`、`test/s3b-live-task-trials.test.ts`、`test/s3b-provider-metering.{ts,test.ts}` 与全部 `docs/reference/rcd-s3*-*` 均在 `c12fb52e` 中。
- 现有执行方式：评测 CLI 以子进程启动固定 vitest 适配器，适配器用真实 Runner/Harness/Tools + 受控 scripted Provider 执行任务，并把 observation JSON 写到环境变量指定路径；CLI 读取 observation 并写账本。任务定义在 `docs/reference/rcd-s3a-task-suite-2026-10-17.json`，可执行适配器在 `docs/reference/rcd-s3b-adapter-extension-2026-10-17.json`。
- 现有 Oracle 是每个适配器内的单个布尔判定（`oraclePassed`），随后投影为 `oracle.result` 枚举；证据（文件哈希、调用记录、Effect、请求计数）混在同一对象里，无法分别结算用户目标、明确约束与内部机制。
- 现有账本：`schemaVersion: 1`，记录含 `source.evaluatorFingerprint`、`productHead`、`provider`、`execution`、`oracle`、`failureAttribution`、`cleanup`；账本写入是 `writeFileSync`，**没有覆盖保护**。
- 现有 trial：仅真实试跑入口限制 `--trial` 为 1..3（`scripts/s3b-eval.mjs:174`）；记录身份是 `s3b-${Date.now()}-<task>-<trial>`，不解析、不唯一约束；工作区用临时目录但无 trial 级身份校验。S3B-P 已把该限制列为阻塞项（P06-R0-1），并建议 N=5。
- 现有计量：`test/s3b-provider-metering.ts` 的受控 transport 已在发送前按物理请求计数（含失败/重试），固定不可重放 4xx 集合、按逻辑调用 poison、输出 token 上限钳制、Usage 缺失标记 `unavailable`、凭据脱敏；`scripts/s3b-eval.mjs` 负责归因与账本投影。该能力可复用，不应重写。
- 现有缺口：没有 JSON Schema 运行时校验器，没有历史账本读取/兼容校验器，没有 pass-rate/denominator 计算，没有有效样本数，没有旧结果到新维度的自动映射。S3B-P 报告的 16 次错误模型请求与首批 4 次有效运行如果混入同一分母会制造虚假成功率。

## 2. 设计目标与非目标

**目标：**

1. 建立版本化的 V2 Evaluation Contract：每次评测独立记录 Goal / Contract / Mechanism 三个维度，缺失证据不能变成成功。
2. 四项独立新任务：`FILE-02-G`、`FILE-02-S`、`DELIV-01-G`、`DELIV-01-R`，各自有任务定义、Oracle、账本和 ID。
3. Trial 1–5 的独立身份、workspace 隔离、写一次账本与预算边界；重复运行不覆盖历史。
4. 机器可读账本 + 报告：历史结果按原契约展示，V2 结果按三维度展示；受控与真实样本分母分离，报告有效样本数。
5. 全部验证离线完成，不执行任何真实付费请求。

**非目标：**

- 不改善模型成绩，不重跑或改写历史结果。
- 不重构生产 Runner/Harness/Prompt/工具系统；不改 `scripts/s3a-eval.mjs`、`scripts/s3b-eval.mjs` 与 `docs/reference/rcd-s3*` 冻结输入。
- 不建立第二套任务执行框架：V2 复用现有 vitest 适配器模式、受控 Transport、脱敏与归因能力，只新增契约、Oracle、账本与报告层。

## 3. V2 数据结构

### 3.1 Evaluation Record（单次 trial，immutable）

```json
{
  "schemaVersion": 2,
  "contractVersion": "2.0.0",
  "recordId": "v2:<batchId>:<taskId>:trial:<n>",
  "batchId": "r4b-offline-2026-10-21",
  "taskId": "FILE-02-G",
  "taskVersion": "2.0.0",
  "trial": 1,
  "evidenceTier": "A_runtime_deterministic",
  "ancestry": { "taskId": "FILE-02", "relation": "goal_only", "frozenTaskSuiteSha256": "b210e505…" },
  "product": { "sha": "c12fb52e…", "treeFingerprint": "…", "dirty": false, "dirtyPaths": [] },
  "evaluator": { "fingerprint": "<sha256>", "contractSha256": "…", "taskSuiteSha256": "…" },
  "modelConfig": { "providerId": "scripted", "wireModelId": null, "simulated": true },
  "userGoal": { "textSha256": "…", "text": "…", "constraintVersion": "2.0.0" },
  "dimensions": {
    "goal": { "status": "passed", "evidenceRefs": ["…"], "rejectionReasons": [], "missingFields": [] },
    "contract": { "status": "not_applicable", "constraintVisible": true, "evidenceRefs": [], "rejectionReasons": [], "missingFields": [] },
    "mechanism": { "status": "not_exercised", "triggered": false, "evidenceRefs": [], "rejectionReasons": [], "missingFields": [] }
  },
  "legacyOracle": null,
  "providerUsage": { "status": "unavailable", "reason": "no authoritative receipt", "inputTokens": null, "outputTokens": null },
  "execution": { "precision": {}, "requests": { "logical": 3, "physical": 0, "budget": 0, "retries": 0 }, "tooling": {}, "effects": {} },
  "credibility": { "level": "direct_evidence", "missingFields": [] },
  "cleanup": { "attempted": true, "succeeded": true, "residuals": [] }
}
```

**状态枚举：**

| 维度 | 允许状态 |
|---|---|
| Goal | `passed` / `failed` / `not_applicable` / `unverified` |
| Contract | `passed` / `failed` / `not_applicable` / `unverified` |
| Mechanism | `passed` / `failed` / `not_exercised` / `blocked` / `unverified` |

**运行时硬约束（不满足即拒绝记录）：**

1. 只有同时具备证据且无缺失字段时，Goal/Contract 才能为 `passed`；`passed` 不得与 `rejectionReasons`/`missingFields` 并存。
2. Contract 为 `passed`/`failed` 时必须证明约束对模型可见（`constraintVisible === true` 且 `constraintRef` 来自任务定义）；仅 Oracle 知道的约束不能判为模型不遵循。
3. Mechanism 的 `not_exercised` 必须 `triggered === false`；`passed` 必须 `triggered === true` 且触发与恢复均有证据；`blocked` 必须有权限/执行边界证据；`unverified` 必须有缺失原因。
4. 记录不得有覆盖三维度的综合布尔值或综合状态；`legacyOracle` 只能作为兼容展示字段，且 `legacyMapped === false`。
5. `cleanup.succeeded !== true` 时 Goal/Contract 不得为 `passed`（该 trial 失去可信环境）。
6. 物理请求计数必须 ≤ 记录的预算；Usage 缺失必须 `status: "unavailable"` 且为 `null`，不得记 0。
7. `recordId` 必须匹配 `v2:<batchId>:<taskId>:trial:<1..5>`，且 `(taskId, trial)` 在账本内唯一。

### 3.2 Ledger（批次汇总）

```json
{
  "schemaVersion": 2,
  "contractVersion": "2.0.0",
  "suiteId": "LS-RCD-R4B-V2",
  "batchId": "…",
  "generatedAt": "…",
  "evidenceTier": "A_runtime_deterministic",
  "records": ["…"],
  "legacy": { "records": [], "note": "原契约结果，只读展示，不映射到三维度" },
  "metrics": { "…": { "denominatorId": "…", "n": 5, "numerator": 4, "denominator": 5, "excluded": {} } },
  "exclusions": { "mixedEvidenceTier": false, "invalidLegacyAttempts": [] }
}
```

账本本身可由不可变记录重新生成；`records/` 下的单 trial 文件写一次，已存在默认拒绝覆盖。

## 4. 版本管理

- `schemaVersion`：记录/账本结构版本，当前 `2`；旧记录保持 `1`，读取器按版本分支。
- `contractVersion`：契约语义版本，当前 `2.0.0`；三状态枚举、验收规则或证据要求变化时递增。
- `taskVersion`：每项任务定义版本，当前 `2.0.0`；任务文本、seed、Oracle 输入或验收集变化时递增。
- `evaluatorFingerprint`：V2 模块（contract、task suite、oracles、ledger、CLI）的 sha256；同一批次的全部记录必须一致，否则该 trial 作废并单列。
- `product.sha`：评测时产品提交；`taskSuiteSha256`/`contractSha256` 均落盘；不写完整 Prompt，只写 `userGoal.textSha256` 与任务定义哈希。
- **旧任务隔离：** 新任务使用独立 ID（`FILE-02-G` 等），`ancestry` 仅记录历史来源与冻结哈希；不修改 `rcd-s3a-task-suite-2026-10-17.json`、`rcd-s3b-*` 或历史账本；旧结果只按原 schemaVersion 读取并原样展示，禁止自动映射为新维度结果。

## 5. 四项 V2 任务与验收规则

| ID | 维度 | 目标/契约 | Oracle 规则（确定性、事先定义） |
|---|---|---|---|
| `FILE-02-G` | Goal | 原 FILE-02 目标：读 `inventory.csv`，写 `inventory-summary.json`，总量 5、按 sku 排序保留数量 | 接受集：JSON 顶层对象；总量字段可为 `total`/`totalQuantity`/`total_quantity` 之一（数值 5，冲突即失败）；`items` 为数组，元素含 `sku` 与数值 `qty`，集合恰为 `{A:2,B:3}` 且按 sku 升序；workspace 文件集合恰为两个文件 |
| `FILE-02-S` | Goal + Contract | 任务文本明确要求字段名 `total`、`items` 元素结构（`sku` 字符串、`qty` 数值）与排序；Goal 只看语义数据，Contract 严格检查字段名/结构/类型 | Goal 与 FIELD-02-G 相同语义规则；Contract 在模型可见任务文本给出 schema 后，严格检查顶层仅 `total`/`items`、类型与排序；**字段名错误只判 Contract failed，不改变 Goal 语义判定** |
| `DELIV-01-G` | Goal | 原目标：用 fixture writer 创建 `result.txt`，内容恰为 `verified-output`；允许首次调用即正确 | 文件字节精确匹配；workspace 无额外文件；恰有一个成功的 `result.txt` 写 Effect；无重复/未知副作用 |
| `DELIV-01-R` | Goal + Mechanism | 同一目标在受控故障注入下执行：第一次工具提议经真实 ToolExecutionService 返回一次参数校验错误，Agent 需理解并修正；不预告参数名，不预设后续调用序列 | Goal 同上；Mechanism：`triggered` 仅由真实 `validation_failed`/`input_validation` 记录决定；`passed` 要求一次修正后恰好一次成功执行且无重复 Effect；未触发 → `not_exercised`；权限阻断 → `blocked` |

四项任务各自有独立任务定义、Oracle、记录与账本；不得修改历史 FILE-02/DELIV-01 冻结结果。

## 6. Trial N=5、隔离与预算

- 现有上限设计依据：`scripts/s3b-eval.mjs:174` 的真实试跑 guard 硬编码 1..3，目的是限制单批次付费请求；该 guard 不适用于离线受控 V2 试验。V2 新增独立 trial 机制，支持 1..5，不修改旧 guard。
- 身份：`recordId = v2:<batchId>:<taskId>:trial:<n>`；`taskId` 与 `trial` 共同构成唯一身份；trial 1/2 历史账本不被读取为可覆盖目标，重复运行写不同批次/路径。
- 隔离：每 trial 用 `mkdtemp` 创建独立 workspace 与 runtime data；trial 前后校验工作树指纹；清理后校验无残留；清理失败 → 记录 `harness_error`，不得计为模型失败。
- 账本：单 trial 文件原子写入（临时文件 + rename），已存在则拒绝覆盖；批次汇总由记录重新生成，默认不覆盖既有汇总。
- 预算：复用现有受控 Transport 的物理请求在发送前计数（含失败/重试）、4xx 不可重放、按逻辑调用隔离、输出 token 钳制；V2 记录每次 trial 的 `logical/physical/retries/blocked` 与请求、输出 token 的 `requested/effective/observed` 边界；并发请求共享同一计数器，不得绕过批次上限；Usage 无权威回执记 `unavailable`。
- 保留 S3B-P 已实现的模型映射（歧义即拒绝）、确定性 4xx 阻断、凭据脱敏与逻辑调用隔离；V2 只用本地模拟 HTTP Provider 验证，不发送真实请求。

## 7. 报告与指标

- 同时展示历史 S3B 结果（原 schemaVersion/原 Oracle 结果，只读）与 V2 三维度结果；历史结果不映射、不并入 V2 分母。
- 指标：Goal 完成率、Contract 遵循率、已触发 Mechanism 成功率；分母只含可判定样本：
  - Goal/Contract：`passed + failed`；`unverified`/`not_applicable` 单列，不计入。
  - Mechanism：`passed + failed`；`not_exercised`/`unverified` 不计入，`blocked` 单列。
- 每个指标报告 `denominatorId`、`n`、`numerator`、`denominator`、排除项与 `populationClaim: false`；受控与真实样本分表；批次中若混入两种 evidenceTier，账本校验拒绝。
- 每项记录至少展示：schema/contract/taskVersion、产品 SHA、evaluatorFingerprint、taskId/trial、原始目标哈希与约束版本、三维度状态、证据与拒绝原因、Provider 逻辑/物理请求与 Usage、工具提议/执行/Effect、可信度与缺失字段、环境/安全/清理状态。

## 8. 复用与不重复建设

| 能力 | 复用方式 |
|---|---|
| 任务执行 | 新增 `test/v2-task-adapters.test.ts`，沿用 Runner/Harness/Tools + scripted Provider + observation 文件模式；不新写执行器框架 |
| Provider 计量/4xx/脱敏 | V2 测试直接复用 `test/s3b-provider-metering.ts` 与 `scripts/lib/s3b-provider-config.mjs` |
| 源码/环境指纹 | V2 新模块独立计算（覆盖 V2 文件），不改旧 evaluator |
| 旧账本 | 新 `history` 读取器按 `schemaVersion` 只读解析，展示层隔离 |

## 9. 测试与验证矩阵

- Contract：正/负 schema、非法状态组合拒绝、缺失证据不能通过、legacy 不映射、fingerprint/version 校验、历史读取兼容。
- Oracle：四项任务的正确/错误数据、错误字段、错误结构、重复/禁止副作用、故障未触发、故障已触发但未恢复；不能只测成功样本。
- Trial/Budget：trial 1–5 身份与 workspace 隔离、trial 0/6 拒绝、重复记录拒绝、账本中断不产生半写文件、并发不绕过预算、失败/重试请求计数、Usage unavailable、16 次历史错误模型请求不进入新分母。
- E2E：`node scripts/eval-v2.mjs --run-controlled` 四项任务受控运行并写账本/报告。
- 回归：`typecheck`、`check:repo`、RCD 六项冻结核心（`node scripts/rcd-s0.mjs run --core`）、`pnpm run test:ci-recovery`、`pnpm run verify:full`；未运行的 Electron GUI、真实 Provider、跨平台专项明确标注未运行。

## 10. 交付物与提交计划

1. `R4-B1`：`rcd-r4b-evaluation-contract-v2` schema + 运行时校验 + 正负测试。
2. `R4-B2`：四项 V2 任务、Oracle、适配器与正负测试。
3. `R4-B3`：Trial N=5、隔离、预算、账本写一次 + 测试。
4. `R4-B4`：机器账本、报告、指标与最终验收记录。

全部提交保留本地，不推送。

## 11. 风险与未决

- 受控 scripted Provider 不能代表真实模型能力；V2 报告明确 `populationClaim: false`，真实 Provider 仍为未执行。
- 受控适配器需要真实 Runner 进程；重负载下仍可能受宿主机资源影响，记录基础设施状态而不误判为模型失败。
- 历史账本没有校验器；V2 只做容错只读展示，不修复历史字段。
- N=5 只证明机制可支持五次独立运行，不授权、也不执行真实付费试验。
