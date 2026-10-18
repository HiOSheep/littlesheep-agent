# RCD S3B-P06 第二轮真实模型试验协议（设计稿，未执行）

**协议日期：** 2026-10-17（证据批次日期；本协议实际撰写于 2026-10-18）

**工作树：** 仓库独立工作树（分支 `codex/s3b-p-reliability-closure`，基线 `7a29444afa98f1e249fc29e330d6ae81355aab74`）

**性质：** 纯设计文档。本协议**未执行任何真实 Provider 请求**（`realProviderCallsMade: 0`）、**未联网**、**未修改任何既有文件**；本批次只新增本文件。

**输入依据（全部为已存在的只读产物）：**

- [P01 轨迹审计](rcd-s3b-p01-trajectory-audit-2026-10-17.md) + [P01 审计账本](rcd-s3b-p01-audit-ledger-2026-10-17.json)
- [P02/P03 失败归因复盘](rcd-s3b-p02-p03-failure-attribution-2026-10-17.md) + [P02/P03 归因账本](rcd-s3b-p02-p03-attribution-ledger-2026-10-17.json)
- [DeepSeek 真实试跑报告](rcd-s3b-real-deepseek-report-2026-10-17.md) + [DeepSeek 批次结果](rcd-s3b-real-deepseek-batch-2026-10-17.json) + 6 个逐次账本 + 2 个分派诊断
- [S3B 真实模型评测协议](rcd-s3b-provider-evaluation-2026-10-17.md)、[S3A 真实任务评测协议](rcd-s3a-evaluation-protocol-2026-10-17.md)、[S3B 指标 Schema](rcd-s3b-metrics-schema-2026-10-17.json)
- 交叉引用（非本任务必读输入）：[P05 DELIV-02 产品评审](rcd-s3b-p05-deliv-02-product-review-2026-10-17.md)（仅在 §7.1 用于支撑"模型完成声明 ≠ 可信验收"的记录纪律）
- P04 防护强化：[P04 真实 Provider 评测器防护强化](rcd-s3b-p04-provider-guard-hardening-2026-10-17.md)（报告已落盘），涉及 `scripts/lib/s3b-provider-config.mjs`、`scripts/lib/s3b-provider-config.d.mts`、`scripts/s3b-eval.mjs`、`test/s3b-provider-metering*.ts`。**其代码改动在本协议撰写时仍为工作树未提交状态**（`git status` 显示 `M`），本协议只引用其可观测的防护能力，并在 §13 P06-R0-7 把它列为执行前必须确认的前置项。

> **硬声明（重复三处，见 §1、§10、§15）：** 第二轮真实 API 试跑必须**另行获得用户明确授权**；本批次**没有执行任何真实请求**。本协议中的预算金额与部分运行参数标注为「待授权时确定」，不得被解读为已批准额度。

---

## 0. 摘要与关键建议

| 项 | 建议 | 一句话依据 |
|---|---|---|
| 每任务重复次数 N | **N=5**（主口径 20 次有效试跑），可选阶段二扩展到 N=10 | 首批 4 次有效试跑的 Wilson 95% 半宽约 ±0.35；N=5 收紧到 ±0.20，且首次让"每任务"从单点观测变为 0..5 的分布（§2） |
| 主口径 Oracle | **原版冻结 Oracle**（历史可比性） | 保持原四项任务、原 Oracle、原首批记录不变（§1、§7） |
| 次级口径 | **v2 Oracle 独立账本**（FILE-02-v2 设计 B；DELIV-01 双维度解耦），**永不并入主口径分母** | P02 §2 推荐设计 B；P02 §3.3 的耦合缺陷（§4、§7） |
| 预算 | 每 trial 8 物理请求 / 2048 输出 token；主口径批次上限 **160 请求 / 327,680 输出 token**；币种建议 **CNY**，金额**待授权时确定** | 首批 `actualRunConfiguration` 实测配置（§5） |
| 费用 | 仍记 `unavailable`；失败请求**不得假定无费用** | 首批无权威账单回执（§5） |
| 新 Harness 对照版本 | **不需要**；需要的是**评测器对照版本**（单一冻结指纹） | 首批 4 次有效运行 0 harness_error、失败归因指向任务/Oracle 契约缺陷（§9） |
| 授权闸门 | 三重条件缺一不可；无授权即不执行 | §10 |

---

## 1. 不变项声明

### 1.1 一律不改（冻结项）

| 冻结项 | 冻结值 / 位置 | 依据 |
|---|---|---|
| 产品源码基线 | `d5015136ca9cf9583423361263b5bacba257a385` | 批次 `productBaseline.frozenProductHead`；6/6 记录一致（P01 §4.1） |
| S3A 任务集 | `docs/reference/rcd-s3a-task-suite-2026-10-17.json`，`taskSuiteSha256 = b210e505c89a8c795fbae62693295cd2527a50d04c355e6e9c43dd7e54a629ec` | 批次 `productBaseline.taskSuiteSha256`；P01 §2 |
| 12 项任务定义与 4 项真实试跑任务 | `CODE-01` / `FILE-02` / `DELIV-01` / `MULTI-01` | `scripts/s3b-eval.mjs:178` 限定真实试跑为原四项 |
| 原版 Oracle | `test/s3a-task-adapters.test.ts`、`test/s3b-live-task-trials.test.ts` 中的既有实现 | P02 §1.2（同一 Oracle 在两处重复实现） |
| 首批全部账本、报告、诊断 | `docs/reference/rcd-s3b-real-deepseek-*`、`rcd-s3b-controlled-baseline-*`、`rcd-s3a-baseline-*` | P01 §10、P02 §5 的"未修改"声明 |
| 首批 Oracle 结果 | FILE-02 trial 2 = `failed`；DELIV-01 trial 1 = `failed` | P02 §5 |

第二轮**不得**：改写任务文本、放宽或收紧原版 Oracle、回填历史账本、把 Runtime `ok` 当作任务通过、用 v2 结果覆盖原版失败。

### 1.2 第二轮必须新建的部分

1. **新账本**：每次运行一个独立文件，另加一份批次汇总；文件与 `recordId` 都带第二轮批次标识（§8）。
2. **新分母**：主口径分母只由第二轮的 arm F 运行构成（§7.3）。
3. **新评测器指纹**：第二轮全部 trial 必须共享**同一个**评测器覆盖层指纹；任何一次运行出现不同指纹，该 trial 作废并在汇总中单列（§2.4、§9）。

### 1.3 混算禁令

- **禁止**把首批 4 次有效运行与第二轮任何运行合并为一个成功率。报告若引用首批数字，只能作为**历史背景**，并标注 `denominatorId: round1-frozen`。
- **禁止**把 v2 Oracle 臂（arm V）的通过数加入原版 Oracle 臂（arm F）的分母，反之亦然（§7.3）。
- **禁止**把机制专项场景（`S1A-PARAM-01`）的结果并入四项任务成功率（§4.3）。

---

## 2. 同一模型配置下的重复试验

### 2.1 模型内部引用与 Provider 线上 ID 的映射规则

| 项 | 第二轮固定值 | 依据 |
|---|---|---|
| `S3B_PROVIDER_ID` | `deepseek` | 批次 `provider.id` |
| `S3B_MODEL`（线上裸 ID） | `deepseek-flash` | 批次 `provider.model`；P01 §4.3 |
| `S3B_MODEL_REF`（内部引用） | `deepseek/deepseek-flash` | 批次 `attempts[*].internalModelRef` |
| 请求体内实际发送的 wire model id | `deepseek-flash`（**不得**带 `deepseek/` 前缀） | P01 §4.3；首批 trial 1 因带前缀消耗 16 个物理请求（P01 §1.3） |
| `S3B_API_PROTOCOL` | `openai-chat-completions` | 批次 `provider.protocol` |
| `S3B_BASE_URL` 源站 | `https://api.deepseek.com`（必须 HTTPS） | 批次 `provider.endpointOrigin`；协议第 15 行 |

**映射规则（唯一解析，歧义即拒绝）：** 内部引用形如 `provider/model` 时，provider 段必须等于配置的 provider、model 段必须等于配置的 model，且解析结果不得残留 `provider/` 前缀；任何歧义都是**确定性配置错误**，必须在发出任何 Provider 请求、重试或预算递增**之前**终止该 trial。当前工作树已提供该防护能力（`scripts/lib/s3b-provider-config.mjs:119-163` `resolveProviderWireModel`；`scripts/s3b-eval.mjs` 在 `--run-real` 入口前置拒绝），并在 P04 报告中作为"确定性配置错误 fail-fast"记录（P04 §1 问题 1/4、§2.1、§3）。**该加固的代码改动尚未提交**，第二轮执行前必须确认其已冻结（§13 P06-R0-7）。

**配置变更即新子批次：** 第二轮期间若必须更换 provider、wire model id、协议或端点源站，则变更前后的运行属于不同子批次，**不得**合并统计；必须在汇总中以 `modelConfigId` 区分。

### 2.2 重复次数 N 的建议与理由

**建议：主口径每任务 N=5；阶段二可在满足 §10 重新授权的前提下扩展到 N=10。**

理由（分三层，全部可核验）：

1. **首批样本量的硬限制。** 首批是"4 项任务各 1 次有效试跑"（P01 §1.1、§7.2），每任务 n=1 不构成任何分布；`counts.validProviderModelIdPassRateNotClaimed: true` 已明确拒绝成功率主张。合并 4 次的点估计即使写作 2/4，其 Wilson 95% 区间半宽也达 **±0.35**（最坏情况 p=0.5），无法支撑"稳定成功率"结论。
2. **N=5 的边际收益。** 合并分母 n=20 时半宽收紧到 **±0.20**；同时每任务从"单点"变成 0..5 的离散分布，可以观察"是否至少失败一次"这一基本稳定性问题——这正是首批完全无法回答的问题。N=3（n=12，±0.25）也能改善，但每任务仍只有 3 个观测点，且**当前评测器 `--trial` 上限为 3**（`scripts/s3b-eval.mjs:174`），而首批已占用 CODE-01 trial 1/2、FILE-02 trial 1/2（批次 `attempts`），故 N=3 在不改 guard 的前提下对 CODE-01/FILE-02 只剩 1 个可用序号（trial 3），实际上不可执行（§13 P06-R0-1）。
3. **为什么不再更大。** N=10（n=40）半宽仅从 ±0.20 收紧到 ±0.15，而物理请求与费用线性增长；在**费用单价未知**（首批成本 `unavailable`）的情况下，先把 N=5 跑完再决定是否追加，是风险更低的顺序。**扩展规则（设计判断，非实证推导）：** 仅当阶段一合并通过率落在 [0.30, 0.70] 区间（精度最敏感区）、且预算未触顶、且用户重新授权时，才扩展到 N=10。

### 2.3 样本量与统计口径（明确不得声称的内容）

| 合并分母 n | 最坏情况（p=0.5）Wilson 95% 半宽 | 对应设计 |
|---:|---:|---|
| 4（首批） | ±0.35 | 历史背景，不构成主张 |
| 12 | ±0.25 | N=3（当前 guard 下对 CODE-01/FILE-02 不可行） |
| **20** | **±0.20** | **建议主口径（N=5）** |
| 40 | ±0.15 | 阶段二扩展（N=10） |

每任务 N=5 的 Wilson 95% 区间示例：5/5 → **[0.57, 1.00]**；0/5 → **[0.00, 0.43]**。

**报告必须遵守的口径纪律：**

- 允许：报告每任务通过数/总数、合并通过率及其区间、逐次轨迹事实、失败归因分布。
- **不允许**：用"成功率""稳定性""可靠完成"等措辞描述 N=5 的结果而不附区间与样本量；**不允许**把 5/5 表述为"该任务已通过"；**不允许**把不同任务合并成一个"模型能力"结论；**不允许**跨证据层级（A/B/C）合并（S3A 协议第 17 行）。
- 每条结论必须携带 `denominatorId`、`n`、`oracleVersion`、`modelConfigId`、`evaluatorFingerprint`。

### 2.4 重复试验之间的独立性要求

1. **进程独立**：每次 trial 一个独立评测器子进程，不复用上一 trial 的内存状态。
2. **工作区独立**：每次 trial 一个独占临时工作区（§3）。
3. **账本独立**：每次 trial 一个独立账本文件，序号不复用（§8.1）。
4. **序号独立**：trial 序号必须延续各任务首批已用最大值（CODE-01/FILE-02 从 3 起，DELIV-01/MULTI-01 从 2 起），避免与既有文件重名或语义冲突。
5. **不得自适应**：不得依据前一次 trial 的 Oracle 结果修改 Prompt、任务文本、Oracle、工具集或预算；每次 trial 的输入必须与首次完全相同。
6. **冻结一致性**：整个第二轮内产品 SHA、任务集哈希、原版 Oracle 版本、评测器覆盖层指纹必须保持单一且不变。
7. **采样不可固定的诚实声明**：首批未发送 `temperature`（Provider 默认），`top_p` 与 `seed` 被 Harness 契约标记为不支持/未设置（P01 §4.3；协议第 17 行）。因此重复试验**不是严格意义上的同条件重复**：运行条件被冻结，但模型采样不可控。报告**不得**声称"完全可复现"，只能声称"运行条件冻结、模型采样不可控"。

---

## 3. 每次运行独立 workspace

### 3.1 命名与创建

- 命名规则：`<系统临时目录>\s3b-round2-<batchId>-<taskId>-t<N>-<nonce>`；示例 `%TEMP%\s3b-round2-r2-2026-10-17-CODE-01-t3-a1b2c3`。
  - `batchId` 形如 `r2-<授权日期>`（**待授权时确定**，授权时写入账本）。
  - `<nonce>` 必须由独占创建原语（`mkdtemp` 语义）生成，不得由时间戳拼接代替。
- 只播种该任务冻结定义中的 `seed`（如 FILE-02 的 `inventory.csv`）；不得把仓库工作树、用户数据根、真实文件或记忆作为任务输入（S3A 协议第 58 行）。
- 任务网络策略 `denied` 对 Agent 工具生效；`web_search`/`web_fetch` 禁用；Shell 不提供（协议第 44 行）。Provider API 是**单独授权并计量**的评测基础设施流量，必须与 Agent 网络分开记账（协议第 28 行）。

### 3.2 隔离保证

- 每次 trial 的工作区互不可见、互不复用；不得在同一目录内连续运行两个 trial。
- 运行前后各取一次源码指纹；`source.productSourceDirty` 必须为 `false`，且 `unclassifiedDirtyPaths` / `unclassifiedCommittedPaths` 必须为空（P01 §4.1）。任何产品源码差异使该记录失去冻结版本资格（S3A 协议第 7 行）。
- 账本必须落盘 `cleanup = { attempted, succeeded, residuals }`（S3B 指标 Schema 必填）。

### 3.3 清理与残留检查

- 每次 trial 结束后删除临时工作区，并**独立检查**该批次临时根下无残留目录。
- `cleanup.succeeded = false` 或 `residuals` 非空 ⇒ 该次记录 `infrastructureStatus = harness_error`（`scripts/s3b-eval.mjs:201`），**不得**计入模型失败，且触发提前停止条件 #6（§10.3）。
- 首批清理失败为 0（P01 §1.2），第二轮以"0 残留"为验收线；出现残留必须逐项列出路径（协议第 21 行）。

### 3.4 并发

**第二轮默认串行（并发度 = 1）。** 理由：

1. 成本上限是**账户级共享余额**，软件侧无法独立保证货币费用上限（协议第 19 行）；并发会削弱超预算停止策略的可控性。
2. 首批为串行执行，保持可比性。
3. 预算计数器与账本写入没有并发保护；并发会产生不可审计的交错。

若用户明确要求并发，必须同时满足并在授权清单中显式批准：并发度 ≤ 2；每 run 独立预算计数器；账本文件互斥写入；每 run 独立工作区；以及并发期间的成本上限按**账户级**而非 run 级判定。

---

## 4. 任务目标正确性与专项机制能力分离

### 4.1 直接引用 task-2 的结论

- DELIV-01 的 Oracle 用 `&&` 把"事件要求"（先出现参数校验失败、Provider 收到结构化反馈）与"产物要求"（修正后恰好执行一次且字节匹配）压成一个布尔值（P02 §3.3，Oracle 表达式见 `test/s3a-task-adapters.test.ts:204-205`、真实路径 `test/s3b-live-task-trials.test.ts:260-261`）。
- 后果是"越正确越失败"：模型首次即提出合法参数时，事件要求必然为假，产物即使完全正确也无法通过（P02 §3.3）。
- 真实试跑 `validationFailure = false` ⇒ 恢复机制评价必须是 **`not_exercised`（未行使）**，**不得**表述为"模型恢复能力失败"（P02 §3.2）。
- 同一记录的 `failureAttribution.primary = artifact_wrong_or_missing` 与同块 `contentMatches = true` 自相矛盾，属评测器误归因缺陷（P01 §8.2、P02 §3.3）。

### 4.2 第二轮强制规则

| 规则 | 内容 |
|---|---|
| R1 | **机制维度永不作为任务成功前置条件**：`recoveryMechanismEvaluation ∈ {exercised_and_recovered, exercised_and_failed, not_exercised}` 只作观测记录，不参与 `oraclePassed` 判定 |
| R2 | 任务目标正确性由**产物/目标维度**独立判定（外部 Oracle 从磁盘读取，§7） |
| R3 | 冻结 Oracle 沿用原版时（arm F），必须**另记**结构缺陷观测字段：`contractDefectObservation = { kind, taskGoalCorrectness, recoveryMechanismEvaluation, oracleVersion: 'frozen' }`。DELIV-01 的 `kind = 'deliv01_event_precondition_coupling'`；FILE-02 的 `kind = 'file02_unpublished_field_name_contract'`（P02 §1.1、§2） |
| R4 | 报告**不得**把 arm F 中 FILE-02/DELIV-01 的 `failed` 解读为模型能力失败；也不得因此把结果改写为通过（P02 §5） |
| R5 | arm F 的冻结 Oracle 结果**照原样计入**主口径分母（保证历史可比），同时以 R3 的独立字段说明其成因；调整后的视角只能作为**非权威**附属视图，且必须标注 `nonAuthoritative: true` |

### 4.3 机制验证走独立专项场景

- 场景 ID：**`S1A-PARAM-01`**（新增；不复用冻结的 `C02`）——设计见 P02 §3.4。
- 注入方式为**评测器侧 driver 确定性注入**一条 schema-invalid 提议，经真实 `ToolExecutionService` 产生真实的 `validation_failed` + `input_validation`；**不伪造** Schema 错误，也**不要求模型先犯错**（P02 §3.4）。
- 四个独立断言（零副作用 / 结构化校验反馈 / 修正后恰好一次执行 / 独立回读字节匹配）全部由外部 Oracle 从账本与磁盘读取（P02 §3.4）。
- **记账隔离：** 独立账本（如 `rcd-s3b-p06-round2-s1a-param-01-<date>.json`），`scenarioId = S1A-PARAM-01`，**不并入**四项任务成功率；`taskGoalCorrectness` 与 `recoveryMechanismEvaluation` 分别记账（P02 §3.4）。
- 机制臂默认**不消耗 Provider 请求**（tier A 确定性注入）；可选 tier B（真实模型）必须单独授权并单独计预算（§5.4、§11）。

---

## 5. 预算

### 5.1 每 trial 参数（冻结，保持与首批可比）

| 参数 | 第二轮值 | 依据 |
|---|---:|---|
| 每 trial 物理 Provider 请求上限 | **8** | 批次 `provider.actualRunConfiguration.maxPhysicalRequestsPerTrial = 8`；首批有效运行实测最大 4（CODE-01/FILE-02 各 4），保留 2× 余量 |
| 每请求输出 token 上限 | **2,048** | 批次 `maxOutputTokens = 2048`；P04 防护允许至 16,384（`scripts/lib/s3b-provider-config.mjs:18`），第二轮**不上调**以保持可比 |
| 超时 | **120 秒** | 批次 `timeoutSeconds = 120`；协议第 15 行默认值 |
| 单次尝试数 `maxAttempts` | **1** | 批次 `maxAttempts = 1`；P04 防护允许 1..3，第二轮保持 1（重试会放大请求计数与费用不确定性） |
| 单次运行软件上限 | 128 请求 / 16,384 输出 token | 当前工作树 `scripts/lib/s3b-provider-config.mjs:17-18`（P04 加固；代码改动未提交）——仅作附加防护，不替代本协议的 8/2048 口径 |

### 5.2 计入口径（含失败请求与被拦截请求）

- **物理请求**：在注入的 `fetch` 边界计数，**包含重试**；每一次真实发出的 HTTP 请求（含 4xx/5xx 失败）都计入预算消耗（协议第 23 行）。
- **发送前被拦截**：单独字段计数（首批口径：有效运行 0、错误模型 ID 尝试各 1，P01 §4.7）。第二轮采取**保守口径**：被拦截请求同样递增软件预算计数器，但记入 `network.preSendInterceptions`，**不计入** Provider 侧物理请求数。
- **逻辑模型请求**（`chat`/`chatStream` 调用）与物理请求**分别**统计，不得互相替代（协议第 24 行）。
- **工具提议 ≠ 工具执行**，`deniedToolCalls`、`failedToolCalls`、`unknownEffects` 分别落盘（协议第 25-26 行）。
- **零请求的诊断类失败**：若模型请求计数为 `null`，账本必须保留 `null`，**不得当 0**，也不得据此编造调用过程（P01 §5.3）。
- **P04 对计量口径的加固（第二轮必须生效）：** 所有物理尝试（含失败/超时/被预算拒绝前）在发送前即计入请求预算；确定性 4xx 状态集合 `[400,401,403,404,422]` 被固定为**不可重放**，重试仅限 `[429,500,502,503,504]`，并有 poison 抑制确保同一逻辑调用内不产生额外物理请求（P04 §1 问题 5/6、§2.4、§3）。该防护使"失败请求成规模重复消耗预算"这一首批风险（16 个请求全部失败，P01 §1.3）在第二轮被结构性遏制；但**不改变**失败请求可能计费的结论（§5.6）。

### 5.3 费用上限

- **币种：建议 CNY。** 依据：首批唯一被验证的硬停止机制是账户预付余额耗尽（批次 `provider.budget.hardStopBasis = "provider rejects further API use when prepaid account balance is exhausted"`），且该余额以 CNY 计量（`provider.budget.currency = "CNY"`, `amount = 12.1`，`scope = shared provider-account prepaid balance`）。
- **金额：待授权时确定。** 必须同时满足：(a) 与 Provider 侧**实际硬限制**一致；(b) 环境变量 `S3B_MAX_COST_CNY` 与命令行 `--max-cost-cny` **完全相等**（`scripts/s3b-eval.mjs:175-177`）；(c) `S3B_PROVIDER_BILLING_CAP_CONFIRMED=true` 且 `S3B_PROVIDER_BILLING_CAP_BASIS` 说明所依据的硬限制机制（协议第 15、19 行）。
- **不得沿用首批 12.10 CNY 作为第二轮额度。** 首批那是**整个授权批次共享的账户预付余额**，不是每任务预算，且首批已消耗其中一部分（真实金额 `unavailable`）；第二轮额度必须重新确认（待授权时确定）。
- **成本仍记 `unavailable`：** 除非 Provider 返回权威费用回执，否则不得由 token 数或余额变化推算费用（协议第 19 行；P01 §7.5）。**费用单价亦为待授权时确定**——本协议不给出任何未经证据支持的单价或金额。

### 5.4 批次上限

| 臂 | trial 数 | 物理请求上限 | 输出 token 上限 |
|---|---:|---:|---:|
| arm F（主口径，4 任务 × N=5） | 20 | 160 | 327,680 |
| arm V（v2 Oracle，FILE-02 + DELIV-01 × N=5） | 10 | 80 | 163,840 |
| arm M（S1A-PARAM-01，tier A 确定性） | — | 0 | 0 |
| arm M-opt（可选 tier B，真实模型） | ≤5 | ≤40 | ≤81,920 |
| **合计硬上限（含可选 tier B）** | ≤35 | **≤280** | **≤573,440** |

- 硬上限按**每 trial 8 请求 × 2048 输出 token** 逐项相乘得出（8×20=160；8×10=80；8×5=40）。
- **外推的期望消耗（非约束值，不得作为预算依据）：** 按首批 4 次有效运行均值 3.25 物理请求/trial（13 ÷ 4，P01 §3）外推，arm F 约 65 请求、arm V 约 33 请求。该数字仅为量级参考，**不构成保证**，因为失败与配置错误路径可能按上限消耗（首批两次错误模型 ID 尝试各消耗 8 请求，合计 16，P01 §1.3）。

### 5.5 超预算停止策略

按顺序判定，任一触发即**停止后续 trial**（不重试、不追加）：

1. 批次物理请求计数 ≥ 160（arm F）或 ≥ 80（arm V）；
2. 批次输出 token 计数 ≥ 327,680（arm F）或 ≥ 163,840（arm V）；
3. Provider 返回 402（余额耗尽）或任何等价硬限制拒绝；
4. 单个 trial 内部达到 8 请求仍未取得 Oracle 判定；
5. 费用上限（`S3B_MAX_COST_CNY`，金额待授权时确定）被触达或无法确认剩余额度。

停止后：已完成的 trial 照常入账；未开始的 trial 记 `not_run`；汇总必须写明触发的是上述哪一条，并给出当时的计数快照。归因使用协议既有类别 `budget_or_no_progress`（S3A 协议第 54 行）。

### 5.6 失败请求是否计费的**不确定性**声明

首批两次错误模型 ID 尝试的 16 个物理请求（各 8 个，含 FILE-02 trial 1 记录的 8 条 HTTP 400）真实发出，`cost.status` 为 `unavailable`，且 P01 §5.2 明确要求**不得假定无费用**。因此：

- 第二轮预算必须**为失败请求预留额度**（本协议已按物理请求上限全额计入，§5.4）；
- 失败请求的费用在获得权威账单回执前一律记 `unavailable`；
- 报告**不得**写"失败请求不产生费用"或"失败请求已确认免费"；
- 若 Provider 在授权时能提供账单导出/回执，应在授权清单中声明该能力；否则第二轮结束后费用仍为 `unavailable`。

---

## 6. Provider 实际模型版本记录

### 6.1 必须同时落盘的四个字段

| 字段 | 含义 | 首批对应位置 |
|---|---|---|
| `provider.internalModelRef` | 内部引用（`provider/model`） | `attempts[*].internalModelRef = deepseek/deepseek-flash` |
| `provider.wireModelId` / `parameters.observed[*].model` | **请求体内实际发送**的线上模型 ID | 首批有效运行均为 `deepseek-flash`；trial 1 为 `deepseek/deepseek-flash`（错误） |
| `execution.modelResponseModels` / `provider.modelVersion` | **Provider 响应回执**中的模型标识 | 首批有效运行 `["deepseek-flash"]`；错误尝试为 `null` |
| `parameters.observed[*]` | 每次请求的实际参数（`temperature`/`thinking`/`maxOutputTokens`/`stream` 等） | 首批 `thinking: enabled`、`temperature: null`、`unsupported: ["top_p","seed"]` |

`provider.modelVersion` 是 S3B 指标 Schema 的**必填**字段（`rcd-s3b-metrics-schema-2026-10-17.json` → `provider.required`），第二轮不得留空。

### 6.2 两者不一致时的处置

1. 该 trial 标记 `modelVersionStatus = 'mismatch'`，账本同时保留 wire id 与回执标识的**原值**，不得静默归一化。
2. 该 trial 的 Oracle 结果照常记录，但**不计入主口径分子与分母**，在汇总中单列为 `excluded: model_version_mismatch`。
3. **不自动重试**；触发提前停止条件 #1（§10.3），须由用户重新授权后才可继续。
4. 若 Provider **未回执**模型标识（如首批错误尝试 `null`），标记 `modelVersionStatus = 'unverified'`，同样不计入主口径，并以 `unavailable` + `reason` 落盘。
5. 报告必须原样列出每个 trial 的 `(internalModelRef, wireModelId, responseModel)` 三元组，使"是否真的跑的是同一个模型版本"可被外部复核。

---

## 7. Oracle 独立验收

### 7.1 独立读取要求

- 外部 Oracle 必须**独立从磁盘/账本读取**产物与调用记录，**不采信模型最终回复**作为成功依据（S3A 协议第 5、21 行；P02 §1.5 明确"报告散文不得作为 Oracle 语义依据"）。
- Oracle 必须**引用证据**（协议第 54 行）；每条判定附产物路径 + SHA-256 + 字节数，或调用/副作用记录引用。
- 首批已证明该路径可行：CODE-01 独立 Node 进程导入模块断言；FILE-02 独立磁盘读取 + JSON 解析；DELIV-01 独立文件读取 + `ToolInvocationRecord` 校验；MULTI-01 独立磁盘读取 + 持久化 Task Outcome 检查（P01 §4.6）。
- **最终回复文本在首批不可得**（`gap-agent-final-reply`，P01 §9）。第二轮必须要求适配器暴露该文本；若仍不可得，必须以 `unavailable` + `reason` 落盘，**不得**留空或推测（§8.3）。产品侧的同一风险已有独立评审：[P05 DELIV-02 评审](rcd-s3b-p05-deliv-02-product-review-2026-10-17.md) §2、§9 指出"模型完成声明 ≠ 可信验收通过"在界面上尚未被正面否定——这正是第二轮必须把最终回复文本与 Oracle 判定**分列记录**、不得互相替代的原因。

### 7.2 第二轮使用哪一版 Oracle

| 臂 | Oracle 版本 | 用途 | 依据 |
|---|---|---|---|
| **arm F（主口径）** | **原版冻结 Oracle**（`test/s3a-task-adapters.test.ts` + `test/s3b-live-task-trials.test.ts` 内联实现） | 历史可比性；与首批同一判定语义 | §1.1；P02 §1.2 |
| **arm V（次级口径，独立账本）** | **v2 Oracle**：FILE-02-v2 **设计 B**（保留原 `userInput`，语义化比较，删除 `JSON.stringify` 对象比较）；DELIV-01 双维度解耦 Oracle（`taskGoalCorrectness` 与 `recoveryMechanismEvaluation` 分离） | 新证据；消除已确认的契约缺陷 | P02 §2 推荐设计 B；P02 §3.3、§3.4 |
| arm V 不采用 | 设计 A（把字段名写进任务文本） | 仅在存在真实下游消费者且确实要求精确键名时，作为**独立新任务**（如 FILE-03）另行提出 | P02 §2 "推荐选择" |

**v2 强制项（两处实现都必须改）：** 删除 `JSON.stringify` 对象比较（`test/s3a-task-adapters.test.ts:162` 与 `test/s3b-live-task-trials.test.ts:254` 两处，P02 §1.2、§2），并新增"Oracle 接受集 ⊆ `successConditions`"的一致性测试（P02 §2 强制项）。

### 7.3 二者不可混算（分母纪律）

- arm F 与 arm V 各自持有独立 `denominatorId`（如 `r2-armF-frozen-oracle`、`r2-armV-v2-oracle`）。
- 报告中两臂必须**并排**展示，每行标注 `oracleVersion`、`denominatorId`、`n`。
- 禁止：把 arm V 的通过数加到 arm F 的分母；用 arm V 的结果改写 arm F 的 `failed`；对两臂做合并成功率或差值显著性主张（v2 的任务文本不变但 Oracle 变化，P02 §2 已明确"通过率不可比"）。
- 首批数字只能作为历史背景出现，且与第二轮任何数字**分表**呈现。

---

## 8. 失败轨迹保存

### 8.1 文件与序号规则

- 每次运行（含失败、配置错误、零请求诊断）**一个独立账本文件**：`docs/reference/rcd-s3b-p06-round2-<taskId>-trial-<N>-<date>.json`。
- 批次汇总：`docs/reference/rcd-s3b-p06-round2-batch-<date>.json`。
- **不得覆盖任何既有文件**；trial 序号延续各任务首批最大值（CODE-01/FILE-02 从 3 起，DELIV-01/MULTI-01 从 2 起），`recordId` 含 `round2` 与批次标识，避免与首批 `recordId` 冲突。
- 失败轨迹与成功轨迹同等对待：**不得**只保留成功运行，**不得**因失败而删除或重写账本（协议第 21 行）。

### 8.2 必须落盘的字段（S3B 指标 Schema 必填 + 本协议增补）

| 分组 | 字段 |
|---|---|
| 标识 | `schemaVersion`、`recordId`、`taskId`、`trial`、`evidenceTier`、`batchId`、`denominatorId`、`arm` |
| 源码 | `source.productHead`、`source.frozenProductHead`、`source.productTreeFingerprint`、`source.evaluatorFingerprint`、`source.workingTreeFingerprint`、`source.productSourceDirty`、**新增** `source.evaluationArtifactsDirty`、`source.dirtyPaths`、`source.unclassifiedDirtyPaths`、`source.unclassifiedCommittedPaths`、`source.fingerprintStableDuringTrial` |
| Provider | `provider.kind`、`simulated`、`id`、`model`、`apiProtocol`、`endpointOrigin`、`modelVersion`、`internalModelRef`、`wireModelId`、`parameters.observed[*]`、`parameters.unsupported`、`limits.*`、`physicalUsageSource`（`credential` 必须为脱敏/省略） |
| 执行 | `execution.infrastructureStatus`、`runtimeStatus`、`startedAt`、`endedAt`、`durationMs`、`logicalModelRequests`、`physicalProviderRequests`、`toolCallProposals`、`toolExecutions`、`deniedToolCalls`、`failedToolCalls`、`settledEffects`、`unknownEffects`、`invocationEvidence`、`effectEvidence`、`providerHttpResponses`（仅状态码，不存正文）、`segments`、`usage`、`cost`、`network`、`approvals` |
| Oracle | `oracle.result`、`oracle.method`、`oracle.evidenceRefs`、`oracle.details`（含 expected/actual/files/evidence）、`oracle.falseCompletionClaim`、**新增** `oracle.version`、`oracle.denominatorId` |
| 归因 | `failureAttribution.{primary,secondary,evidenceRefs,confidence}`（Schema 为 `additionalProperties: false`，不得新增属性）；**新增独立字段** `contractDefectObservation`、`recoveryMechanismEvaluation`、`modelVersionStatus` |
| 清理 | `cleanup.{attempted,succeeded,residuals}` |
| 证据缺口 | 每个不可得字段必须 `status: unavailable` + `reason`（禁止留空、禁止推测） |

### 8.3 必须在第二轮关闭的首批证据缺口

| 缺口 | 首批状态 | 第二轮要求 |
|---|---|---|
| `gap-agent-final-reply` | `unavailable`（适配器未暴露最终回复） | 适配器必须暴露最终回复文本；不可得则 `unavailable` + `reason` |
| `gap-first-artifact-latency` | `unavailable`（只记总时长） | 记录首个有效产物时间戳；不可得则 `unavailable` + `reason` |
| `gap-human-interventions` | `unavailable`（无交互审批 UI） | 分别记录 `approvals.count` 与人工干预；测试适配器回调**不得**当作人工审批（P01 §8.6） |
| `gap-prompt-text` | 全部 `unavailable` | 继续**不保存**完整 Prompt（协议第 32 行）；但必须保存可核验的等价证据：冻结 `userInput` + `evaluatorCommand` + 任务集哈希 |
| `gap-code01-trial1-http-statuses` | 只有汇总失败计数 | 每个物理请求都必须有 `providerHttpResponses` 状态记录（仅状态码） |
| `gap-billing-receipt` | `unavailable` | 无回执则继续 `unavailable`，不得推算 |

### 8.4 账本字段缺陷的处置

- 首批顶层 `productBaseline.productSourceDirty = true` 与逐记录 `records[i].source.productSourceDirty = false` 语义冲突（P01 §8.1）。第二轮必须拆成两个不同名语义：`productSourceDirty`（产品源码）与 `evaluationArtifactsDirty`（评测产物/覆盖层）。历史账本**不改**。
- 首批 `failureAttribution.primary = artifact_wrong_or_missing` 与同块 Oracle 证据冲突（P01 §8.2）。第二轮归因由加固后的分类器产生；**必须标注分类器版本**，且与首批归因值不同尺度、不可直接比较（§9.3）。

---

## 9. 是否需要新的 Harness 对照版本

### 9.1 结论

**不需要新的 Harness 对照版本。** 第二轮继续使用同一冻结产品提交 `d5015136ca9cf9583423361263b5bacba257a385` 下的 Runner/Harness，不建立第二套 Harness 对照分支。

### 9.2 理由（基于第一批证据）

1. 首批 4 次有效运行的 `runtimeStatus` 全为 `ok`、`infrastructureStatus` 全为 `executed`、`providerHttpFailures = 0`、`deniedToolCalls = 0`、`failedToolCalls = 0`、`unknownEffects = 0`、清理失败 0（P01 §1.2、§5.1）——**没有任何一次是 Harness 控制流失败**。
2. 首批两次"分派诊断"是**评测器分派**问题（选错测试文件），两次错误模型 ID 是**评测器出口配置**问题；报告已明确二者均属评测器侧（报告第 43-44 行；P01 §1.3、§1.4、§8.5）。
3. 两个真实失败的主因是**任务/Oracle 契约缺陷**（P02 §2 主要归因：`contract defect`），不是 Harness 行为。
4. 因此第二轮若要提高证据质量，应加固**评测器覆盖层**，而不是引入新的 Harness 对照版本。

### 9.3 但必须建立"评测器对照版本"

- 首批评测器指纹在运行间**不一致**（4 个不同值：`768c0fa1…`、`670917da…`、`bae9c5cf…`、`924484012…`），不存在单一字节级评测器版本，故行为对照只能以任务结果与产品基线为准（批次 `productBaseline.evaluationSourceFingerprintsVaryAcrossAttempts = true`；P01 §7.6）。
- 第二轮必须：冻结**单一**评测器覆盖层指纹并全程一致；把该指纹写入每次运行账本；任何一次运行出现不同指纹 ⇒ 该 trial 作废并单列。
- **P04 加固改变了归因语义**：加固后的 `classifyFailure` 对"Oracle 失败但产物证据匹配"（DELIV-01 形态）返回 `primary: 'unknown'`、`confidence: 'low'` 并附 `secondary: ['oracle_failed_on_unmet_task_precondition','artifact_content_matched']`（当前工作树 `scripts/lib/s3b-provider-config.mjs:313-349`；P04 §1 问题 9、§2.1）。P04 报告本身也承认该变化"会让按主因聚合的计数与旧账本不完全可比"（P04 §5 R2）。因此**第二轮的 `failureAttribution` 与首批不是同一尺度**，报告中必须版本标注、分列呈现，**不得**把两批归因计数相加或直接比较。
- 该加固属评测器层，**不触碰产品/Harness**，与 §1.1 的冻结要求不冲突。

### 9.4 若用户仍要求 Harness 对照（不推荐在第二轮并行）

- 对照维度：同一冻结产品 SHA 下的 Harness 版本/配置差异（例如控制流、阶段划分、缓存策略）。
- 成本：需要另建对照分支并**为每个维度重复整套运行**——预算翻倍（arm F 的 160 请求 → 320 请求，若两版本各跑 N=5）；且两版本必须共享同一冻结任务集、同一 Oracle 版本、同一模型配置，否则不可比。
- 建议：把 Harness 对照留到 v2 Oracle 落地、且主口径已有 N=5 基线之后，作为独立批次另行授权。

---

## 10. 授权与停止条件

### 10.1 硬闸门（无授权即不执行）

第二轮真实 API 试跑必须**同时**具备：

1. 用户在本任务/本会话中的**明确书面授权**（说明范围、任务、N、预算）；
2. 环境变量 `S3B_REAL_PROVIDER_AUTHORIZED=I_AUTHORIZE_THIS_EVALUATION_RUN`（`scripts/lib/s3b-provider-config.mjs:277-279`）；
3. 命令行 `--authorize-live` 且预检通过（`scripts/s3b-eval.mjs:158-180`）。

**三者缺一即不执行。** 软件 guard 只是附加防护，**不替代**用户直接授权（协议第 19 行）。仅以下只读/本地命令可在无授权下运行：`--preflight`（不联网）、`--suite`（校验任务集）、`--verify-provider-metering`（本地假 HTTP）。

### 10.2 授权所需的最小信息清单

授权请求中必须一次性给出：

| # | 项 | 说明 |
|---|---|---|
| 1 | 授权范围 | 任务清单（arm F 四项；arm V 两项）、每任务 N、是否启用 arm V / arm M-opt |
| 2 | Provider 与模型 | `deepseek` / wire id `deepseek-flash` / 内部引用 `deepseek/deepseek-flash` / `openai-chat-completions` / `https://api.deepseek.com` |
| 3 | 请求与 token 上限 | 每 trial 8 请求、2048 输出 token、120 秒、`maxAttempts=1`；批次上限 160（arm F）/ 80（arm V） |
| 4 | 币种与费用上限 | **CNY**；金额**待授权时确定**；必须与 Provider 侧硬限制一致并给出 `S3B_PROVIDER_BILLING_CAP_BASIS` |
| 5 | 失败请求计费口径确认 | 用户确认"失败请求可能计费、费用可能不可得"（§5.6） |
| 6 | 凭据提供方式 | 仅进程环境变量 `S3B_API_KEY`；不得写入源码/账本/工作区；建议使用新生成并事后撤销的 Key（报告第 24 行） |
| 7 | 账本输出路径 | 新账本目录/文件名（§8.1）；确认不覆盖既有文件 |
| 8 | 并发许可 | 默认串行；如需并发须显式批准并发度与账户级判定（§3.4） |
| 9 | 评测器 guard 改动许可 | 是否批准把 `--trial` 上限从 3 提升到已授权 N（§13 P06-R0-1） |
| 10 | 未决项确认 | MULTI-01 冻结 `successConditions` 语义澄清结论（§13 P06-R0-2）；FILE-02/DELIV-01 是否启用 arm V |
| 11 | 停止与责任人 | 触发提前停止后的联系人、是否允许用剩余额度重跑失败 trial（默认**不允许**自动重跑） |

### 10.3 提前停止条件

| # | 条件 | 依据 / 性质 |
|---|---|---|
| 1 | 任一次运行出现 `modelVersionStatus = 'mismatch'` 或 `'unverified'` | §6.2；防止把错误模型版本混入主口径 |
| 2 | 任一次运行达到 8 请求上限仍未取得 Oracle 判定 | §5.5；继续只会放大不确定费用 |
| 3 | 连续 4 个 trial 中出现 ≥1 次 Provider HTTP 4xx/5xx | **协议设计阈值（设计判断，非实证推导）**；首批错误模型 ID 路径的 16/16 全部失败，说明配置类错误会成规模重复（P01 §1.3）。P04 已把 `[400,401,403,404,422]` 固定为不可重放（P04 §2.1），可防止单次 4xx 被重放放大，但不能防止"每个 trial 各错一次" |
| 4 | 任一次出现 Agent Web 请求 > 0 或 `forbiddenRequests > 0` | 网络策略违规；首批为 0（P01 §1.2），零容忍 |
| 5 | 任一次 `cleanup.succeeded = false` 或 `residuals` 非空 | §3.3；属评测基础设施失败 |
| 6 | 批次请求/输出 token/费用任一触顶，或 Provider 返回 402 | §5.5 |
| 7 | 产品源码指纹在任一 trial 中变为 dirty，或评测器指纹与冻结值不一致 | §1.2、§2.4；使该记录失去可比资格 |

停止后必须：保留已完成 trial 的账本、把未开始 trial 记 `not_run`、在汇总中写明触发条件与计数快照、并把停止原因归入协议既有类别（`evaluation_infrastructure` / `network_or_external_service` / `budget_or_no_progress`，S3A 协议第 54 行）。

---

## 11. 运行矩阵（任务 × 重复 × 预算）

**批次标识：** `batchId = r2-<授权日期>`（待授权时确定）｜**模型配置：** `modelConfigId = deepseek/deepseek-flash → deepseek-flash`（§2.1）｜**并发：** 1（串行）

### 11.1 arm F — 主口径（原版冻结 Oracle，历史可比）

| 任务 | 起始 trial | 重复 N | 每 trial 请求上限 | 每 trial 输出 token 上限 | 任务请求上限 | 任务输出 token 上限 | Oracle 版本 | 备注 |
|---|---|---:|---:|---:|---:|---:|---|---|
| CODE-01 | 3 | 5 | 8 | 2,048 | 40 | 81,920 | frozen | 首批已用 trial 1/2（`attempts`）；需提升 `--trial` 上限（§13 P06-R0-1） |
| FILE-02 | 3 | 5 | 8 | 2,048 | 40 | 81,920 | frozen | 已知契约缺陷；失败不解读为模型能力（§4.2 R4） |
| DELIV-01 | 2 | 5 | 8 | 2,048 | 40 | 81,920 | frozen | 已知事件/产物耦合缺陷；另记 `recoveryMechanismEvaluation`（§4.2 R3） |
| MULTI-01 | 2 | 5 | 8 | 2,048 | 40 | 81,920 | frozen | 冻结 `successConditions` 与真实 Oracle 语义不一致未澄清（§13 P06-R0-2） |
| **小计** | — | **20** | — | — | **160** | **327,680** | — | 主口径分母 `denominatorId = r2-armF-frozen-oracle` |

### 11.2 arm V — 次级口径（v2 Oracle，独立账本，不并入 arm F 分母）

| 任务 | 起始 trial | 重复 N | 每 trial 请求上限 | 任务请求上限 | 任务输出 token 上限 | Oracle 版本 | 备注 |
|---|---|---:|---:|---:|---:|---|---|
| FILE-02 | 3 | 5 | 8 | 40 | 81,920 | v2（设计 B） | 保留原 `userInput`；语义化比较；删除 `JSON.stringify`（P02 §2） |
| DELIV-01 | 2 | 5 | 8 | 40 | 81,920 | v2（双维度解耦） | `taskGoalCorrectness` 与 `recoveryMechanismEvaluation` 分离（P02 §3.4） |
| **小计** | — | **10** | — | **80** | **163,840** | — | `denominatorId = r2-armV-v2-oracle` |

### 11.3 arm M — 机制专项（独立账本，不并入任何成功率）

| 场景 | tier | 重复 N | 请求消耗 | 记账 |
|---|---|---:|---:|---|
| S1A-PARAM-01 | A（评测器确定性注入） | 1 | 0 | 独立账本；`taskGoalCorrectness` 与 `recoveryMechanismEvaluation` 分列 |
| S1A-PARAM-01 | B（真实模型，可选） | 5 | ≤40 | **待授权时确定**；单独授权、单独计预算 |

### 11.4 批次合计

| 项 | arm F | arm V | arm M | arm M-opt | 合计 |
|---|---:|---:|---:|---:|---:|
| trial 数 | 20 | 10 | 1 | ≤5 | **≤36** |
| 物理请求硬上限 | 160 | 80 | 0 | ≤40 | **≤280** |
| 输出 token 硬上限 | 327,680 | 163,840 | 0 | ≤81,920 | **≤573,440** |
| 费用上限 | 待授权时确定（CNY，须与 Provider 侧硬限制一致） | 同左 | 0 | 同左 | **待授权时确定** |

> 矩阵中所有"上限"数字均由 §5.1 的每 trial 参数逐项相乘得到（8 请求 × 2048 token）；唯一外推值（期望约 65/33 请求）已在 §5.4 标注为**非约束参考**。

---

## 12. 数字依据表

| 数字 | 值 | 依据 |
|---|---|---|
| 首批有效试跑数 | 4（每任务 1 次） | P01 §1.1、§3 |
| 首批有效物理请求 | 13 | P01 §1.2、§5.1 |
| 首批错误模型 ID 请求 | 16（各 8） | P01 §1.3、§5.2 |
| 首批分派诊断 | 2（零请求，计数 `null`） | P01 §1.4、§5.3 |
| 首批已记录物理请求合计 | 29 | P01 §1.5 |
| 首批通过 | 2/4（不得作为成功率） | P01 §1.1；`counts.validProviderModelIdPassRateNotClaimed: true` |
| Wilson 95% 半宽 | n=4 ±0.35；n=12 ±0.25；n=20 ±0.20；n=40 ±0.15 | 本协议 §2.3 计算（最坏情况 p=0.5 的 Wilson 区间） |
| 建议 N | 5（可选扩至 10） | §2.2 的三层理由 |
| 每 trial 物理请求上限 | 8 | 批次 `provider.actualRunConfiguration.maxPhysicalRequestsPerTrial` |
| 每请求输出 token 上限 | 2,048 | 批次 `maxOutputTokens` |
| 超时 / maxAttempts | 120 秒 / 1 | 批次 `timeoutSeconds` / `maxAttempts` |
| 单次运行软件上限 | 128 请求 / 16,384 token | 工作树 `scripts/lib/s3b-provider-config.mjs:17-18`（P04 加固；代码改动未提交） |
| arm F / arm V 请求上限 | 160 / 80 | 8 × 20 / 8 × 10（§11） |
| 批次输出 token 上限 | 327,680 / 163,840 | 160×2048 / 80×2048（§11） |
| 币种 | CNY（建议） | 批次 `provider.budget.currency`、`hardStopBasis` |
| 费用上限金额 / 单价 | **待授权时确定** | 首批无权威账单回执（P01 §7.5）；协议第 19 行 |
| 首批共享余额 | 12.10 CNY（**不是**每任务预算） | 批次 `provider.budget.amount`、`scope` |
| 首批评测器指纹个数 | 4（不一致） | 批次 `productBaseline.evaluationFingerprints`；P01 §7.6 |
| 冻结产品 SHA | `d5015136…` | 批次 `frozenProductHead` |
| 任务集哈希 | `b210e505…` | 批次 `taskSuiteSha256` |
| 起始 trial 序号 | CODE-01/FILE-02 = 3；DELIV-01/MULTI-01 = 2 | 批次 `attempts[*].trial` 最大值 + 1 |
| `--trial` 当前上限 | 3 | `scripts/s3b-eval.mjs:174` |
| 并发度 | 1（串行） | §3.4 的三条理由（设计判断） |
| 提前停止阈值（连续 4 trial 内 ≥1 次 4xx/5xx） | 1 次 | §10.3 #3（**设计判断，非实证推导**） |

---

## 13. 前置改动与未决项

| ID | 项 | 类型 | 处置 |
|---|---|---|---|
| P06-R0-1 | `--trial` 上限为 3，无法容纳 N=5 且首批已占用 CODE-01/FILE-02 的 1、2 | **阻塞**（评测器层） | 需在授权时一并批准把上限提升到已授权 N（`scripts/s3b-eval.mjs:174`）；不触碰产品/Harness |
| P06-R0-2 | MULTI-01 冻结 `successConditions` 描述受控/脚本场景（b.txt 为 `goodbye`），与真实运行 Oracle 语义不一致 | **未决**（需产品/评测负责人澄清） | 默认处置：仍运行，Oracle 结果按冻结契约记录，但标注 `frozen_contract_semantics_mismatch_unresolved` 并单列，**不并入主口径分母**；最终口径**待授权时确定**（P01 §8.3） |
| P06-R0-3 | arm V 需要 v2 Oracle 实现 + "接受集 ⊆ successConditions"一致性测试 | 前置开发 | P02 §2 强制项；两处实现都必须改（`test/s3a-task-adapters.test.ts:162`、`test/s3b-live-task-trials.test.ts:254`） |
| P06-R0-4 | 顶层 `productSourceDirty` 语义冲突 | 前置记账 | 第二轮账本拆分为 `productSourceDirty` 与 `evaluationArtifactsDirty`（P01 §8.1 建议）；历史账本不改 |
| P06-R0-5 | 最终回复文本 / 首个产物时间戳 / 人工干预计数不可得 | 前置适配器改动 | 属评测器适配层；不可得则 `unavailable` + `reason`（P01 §9） |
| P06-R0-6 | API Key 曾在对话中出现 | 安全前置 | 授权前使用新生成 Key，仅进程环境；事后撤销（报告第 24 行） |
| P06-R0-7 | P04 加固（wire model 解析、归因分类器、不可重放状态、预算计量）**报告已落盘但代码改动仍未提交** | 前置确认 | 第二轮执行前必须确认其已提交/冻结并有测试覆盖（P04 §4 记录 33 个 metering 用例、37 个用例全通过、typecheck 通过）；否则不得声称该防护在第二轮生效。**注意：** 冻结 `metricsSchemaSha256` 未变（P04 §0.3），故加固不改变账本 schema 兼容性 |

---

## 14. 复现与校验（全部离线）

以下命令**不联网、不调用真实 Provider**，可在无授权状态下运行：

```powershell
# 1) 任务集与适配器校验（不发请求）
node scripts/s3b-eval.mjs --suite

# 2) 本地假 HTTP 响应校验计量链路（不访问公网；P04 后为 33 个用例）
node scripts/s3b-eval.mjs --verify-provider-metering

# 3) 预检（只读环境变量，不发请求；需要已配置环境变量）
#    注意：P04 后确定性配置错误会以退出码 1 + state="configuration_error" 结束（仍不联网）
node scripts/s3b-eval.mjs --preflight

# 4) 首批账本可解析性复核（只读）
$j = Get-Content "docs\reference\rcd-s3b-real-deepseek-batch-2026-10-17.json" -Raw | ConvertFrom-Json
$j.counts.validProviderModelIdPhysicalProviderRequests          # 13
$j.counts.allRecordedActualPhysicalProviderRequests             # 29
$j.counts.validProviderModelIdPassRateNotClaimed                # True
$j.productBaseline.evaluationSourceFingerprintsVaryAcrossAttempts  # True
$j.productBaseline.taskSuiteSha256                              # b210e505...
$j.provider.actualRunConfiguration.maxPhysicalRequestsPerTrial  # 8
$j.provider.actualRunConfiguration.maxOutputTokens              # 2048
```

**真实试跑入口（本批次未执行，且未授权前禁止执行）：**

```powershell
# 需要：用户明确授权 + S3B_REAL_PROVIDER_AUTHORIZED + --authorize-live + 正数预算与费用上限
node scripts/s3b-eval.mjs --run-real --task=<CODE-01|FILE-02|DELIV-01|MULTI-01> --trial=<N> --authorize-live --max-cost-cny=<CNY>
```

---

## 15. 本批未执行任何真实请求的声明

1. **本协议批次（P06 设计批次）未执行任何真实 Provider 请求**：`realProviderCallsMade: 0`；未联网；未调用 DeepSeek 或任何其他 Provider API；未运行 `--run-real`。
2. **未修改任何既有文件**：本批次只新增本文件 `docs/reference/rcd-s3b-p06-round2-protocol-2026-10-17.md`；冻结任务集、原版 Oracle、首批账本与历史报告全部保持原样。
3. **第二轮真实 API 试跑必须另行获得用户明确授权**（§10.1 三重条件），且授权所需信息清单（§10.2）必须一次性给出。**无授权即不执行。**
4. 本协议中的预算金额、批次日期、`batchId`、arm V/arm M-opt 是否启用、MULTI-01 口径等，凡未标注具体依据者一律为**「待授权时确定」**，不构成任何已批准额度或已确认安排。
5. 本协议不声称第二轮的任何通过率、成功率或稳定性结论；这些只能由第二轮实际运行的账本与独立 Oracle 结果支持，并受 §2.3 的口径纪律约束。

---

## 附：溯源索引

| 结论 | 来源 |
|---|---|
| 首批 4 次有效 / 2 次错误模型 ID（16 请求）/ 2 次零请求诊断；13/13/11/11/7；29 请求 | P01 §1、§3、§5 |
| 不得据小样本主张成功率 | P01 §1.1、§7.2；批次 `validProviderModelIdPassRateNotClaimed` |
| 失败请求不得假定无费用；成本 `unavailable` | P01 §5.2、§7.5；协议第 19 行 |
| 顶层 `productSourceDirty` 冲突 | P01 §8.1 |
| DELIV-01 归因标签与 Oracle 证据冲突 | P01 §8.2 |
| MULTI-01 `successConditions` 与真实 Oracle 不一致 | P01 §8.3 |
| FILE-02 主因 = 任务/Oracle 契约缺陷；唯一差异为顶层字段名 | P02 §1.1、§2（Q1-Q5、主要归因） |
| FILE-02-v2 推荐设计 B；`JSON.stringify` 两处必须删除 | P02 §2 |
| DELIV-01 产物正确 + 恢复 `not_exercised`；耦合缺陷"越正确越失败" | P02 §3.1-3.3 |
| S1A-PARAM-01 设计与独立记账 | P02 §3.4 |
| Oracle 从磁盘独立读取、不采信模型回复；结果与基础设施正交；失败枚举 | S3A 协议第 5、21、52、54 行 |
| 计量约定（物理请求含重试、提议≠执行、usage 只取回执） | 协议第 23-29 行 |
| 授权三重条件与软件 guard 不替代用户授权 | 协议第 19 行；`scripts/s3b-eval.mjs:158-180`；`scripts/lib/s3b-provider-config.mjs:277-279` |
| 真实试跑限原四项任务；`--trial` 1..3 | `scripts/s3b-eval.mjs:174`、`:178` |
| 单次运行软件上限 128 请求 / 16,384 token | `scripts/lib/s3b-provider-config.mjs:17-18`（P04 加固；代码未提交） |
| wire model 唯一解析与歧义拒绝 | `scripts/lib/s3b-provider-config.mjs:119-163`（P04 加固；代码未提交） |
| 归因分类器对"Oracle 失败但产物匹配"返回 `unknown`/`low` | `scripts/lib/s3b-provider-config.mjs:313-349`（P04 加固；代码未提交） |
| P04 加固范围、问题清单、测试与剩余风险 | [P04 防护强化](rcd-s3b-p04-provider-guard-hardening-2026-10-17.md) §0-§5 |
| 不可重放 4xx 集合、失败请求计入预算、poison 抑制 | P04 §1 问题 5/6、§2.1、§2.4、§3 |
| 账本必填字段与 `failureAttribution` 不可扩展 | `rcd-s3b-metrics-schema-2026-10-17.json` |
| 评测器指纹不一致（4 个值）；冻结产品 SHA；任务集哈希 | 批次 `productBaseline`；P01 §7.6 |
| 首批运行配置与预算范围 | 批次 `provider.actualRunConfiguration`、`provider.budget` |
