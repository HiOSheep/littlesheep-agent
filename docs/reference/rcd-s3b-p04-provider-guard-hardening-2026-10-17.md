# RCD S3B-P04 真实 Provider 评测器防护强化

- 日期：2026-10-17（记录日）
- 工作树：仓库独立工作树
- 分支：`codex/s3b-p-reliability-closure`，基线 `7a29444a`
- 范围：S3B 真实 Provider 评测层（evaluator guard / metering），**不修改生产 Runtime、Harness、Tools、Prompt**

## 0. 范围与不可违反声明

1. **未修改任何生产代码。** 本批改动只落在评测层：`scripts/lib/s3b-provider-config.mjs`、`scripts/lib/s3b-provider-config.d.mts`、`scripts/s3b-eval.mjs`、`test/s3b-provider-metering.ts`、`test/s3b-provider-metering.test.ts`，以及本报告。
2. **未调用真实 DeepSeek API，也未联网。** 所有正/负向用例都注入 `fetchImpl` 或本地回环 fixture；`--verify-provider-metering` 输出的 `externalNetwork=false`。`--preflight` 只读环境变量。
3. **未修改 `docs/reference/rcd-s3b-metrics-schema-2026-10-17.json`。** 该文件的 sha256 是历史可比性面（`metricsSchemaSha256` 写进每份账本），保持原样。
4. **既有枚举值既未新增也未改名。** `failureAttribution.primary` 的 13 个取值、`confidence` 的 3 个取值原样保留；`secondary` 只承载字符串，未引入新枚举。
5. **未删除或弱化任何既有测试/安全断言。** 原 8 个用例逐字保留，只做增量扩充（8 → 33 个用例）。
6. **未改写任何既有账本。** 本批没有运行 `--run-controlled` / `--run-real`，`docs/reference` 下既有 `rcd-s3b-*` 文件未被触碰。

## 1. 问题清单（本批修复）

| # | 问题 | 影响 |
|---|---|---|
| 1 | 内部模型标识 → Provider wire model id 只有隐式字符串裁剪，无显式解析函数，歧义（provider 段不符、嵌套路径、前缀残留）无法被拒绝 | 可能把内部 ref 原样发给 Provider，或静默发错模型 |
| 2 | `--preflight` 即使配置缺失也 `exit 0`，`state` 恒为 `real_provider_pending`；预检与 `--run-real` 入口没有共同的确定性停止点 | 确定性配置错误被当成"等待授权"，掩盖真实故障 |
| 3 | 模型 ID 无格式校验；endpoint 只校验协议，userinfo 与畸形 URL 只落到同一句模糊提示 | 非法配置可以一路走到网络边界 |
| 4 | "确定性配置错误"与"待授权"混在同一个 `missing` 列表里，无机器可读区分 | 无法 fail-fast，也无法自动判定该不该重试/等待 |
| 5 | 计量层未固定可重试状态集合，完全继承生产默认；对 400/401/403/404/422 没有"禁止重放"的独立防线 | 一旦生产重试策略放宽，评测会重复发送确定性 4xx，白烧物理请求 |
| 6 | 预算计数语义未文档化，缺"失败/超时请求也占用预算"的测试 | 失败请求可能被漏计，实际物理请求数超过预算 |
| 7 | "成功但无 usage → unavailable" 只有实现，没有测试 | 回归无保护 |
| 8 | 脱敏正则 `[^\s,;]+` 在 `Authorization: Bearer <key>` 上只吃掉 `Bearer`，密钥原样泄漏；Provider 回显的密钥可能进入错误消息/快照 | 密钥可能被序列化进账本或日志 |
| 9 | **（P01 证据审查发现）** `classifyFailure()` 的启发式兜底：Oracle `result=failed` 时无条件给出 `artifact_wrong_or_missing` + `confidence=high`，即使 Oracle 自己的 details 证明产物正确 | 账本结论被伪造：`rcd-s3b-real-deepseek-DELIV-01-trial-1-2026-10-17.json` 中 `details.contentMatches=true`、`validationFailure=false`、`fixtureExecutions=1`，却记录 `artifact_wrong_or_missing / high` |

### 1.1 问题 9 的证据（P01 证据审查，未改写原账本）

`docs/reference/rcd-s3b-real-deepseek-DELIV-01-trial-1-2026-10-17.json` `records[0]`：

- `oracle.result = "failed"`，`oracle.details.contentMatches = true`，`oracle.details.validationFailure = false`，`oracle.details.fixtureExecutions = 1`，产物 sha256 已记录
- `failureAttribution = { primary: "artifact_wrong_or_missing", confidence: "high" }`

即：Oracle 明确判定产物内容匹配，评测器却以高置信度断言"产物错误或缺失"。原账本是历史记录，**本批不重写**；修复只影响后续运行的分类结果。

## 2. 修复内容

### 2.1 `scripts/lib/s3b-provider-config.mjs`（共享防护库，单一事实来源）

- 新增 `resolveProviderWireModel(internalModelRef, providerId, configuredModel)`：输入内部 ref（`provider/model` 或裸 wire id）与配置的 provider/model，输出**唯一确定**的 wire model id，并同时返回 `internalModelRef` 与 `wireModelId` 两个字段。拒绝的歧义：
  - provider 段与配置 providerId 不一致；
  - model 段与配置 model 不一致；
  - provider 段之后仍有嵌套路径（`provider/model/extra`）；
  - wire id 仍带 `providerId/` 前缀残留（`provider/provider/model`）；
  - 空 model 段、含空白、含 URL scheme、超长。
- 新增 `modelIdFacts()`：模型 ID 非空、无空白、无 `://`、无前导/尾随/重复斜杠、长度上限 200，字符集受限。**实际规则（独立验证后修正说明）**：含内部斜杠的模型 ID 能通过本函数，但无法通过 `resolveProviderWireModel`——provider 前缀之后的 model 段必须不含斜杠，因此 `meta-llama/Llama-3` 这类模型会被判为嵌套路径 / 前缀残留而拒绝。**S3B 目前只支持不含斜杠的 wire model id**。该 fail-closed 拒绝是有意的：内部斜杠会让 `provider/model` 真正歧义，放宽还会重新打开历史 `deepseek/deepseek-flash` 前缀残留缺陷。见固定测试 `pins that a wire model id containing an interior slash is rejected as ambiguous`。
- `endpointFacts()` 扩展：显式区分 userinfo（`endpointHasUserinfo`）、协议不允许、URL 非法三类原因；userinfo 端点不再产生可序列化的 origin。
- `resolveS3bProviderProfile()` 新增机器可读字段（全部为**新增**，既有字段一个未删）：
  - `state: 'ready' | 'configuration_error'`、`deterministicFailure`、`configurationErrors`、`authorizationPending`；
  - `provider.internalModelRef` / `provider.wireModelId` / `provider.modelMapping`；
  - `provider.supportedProtocols` / `provider.endpointHasUserinfo` / `provider.nonRetryableStatuses` / `provider.retryableStatuses`；
  - 可选 `S3B_MODEL_REF`：显式内部 ref；未设置时派生为 `${providerId}/${model}`（保持既有行为）。
  - `missing` 仍是原字段与原文案，确定性错误照旧进入 `missing`（向后兼容）。
- 新增 `NON_RETRYABLE_PROVIDER_STATUSES = [400,401,403,404,422]`、`RETRYABLE_PROVIDER_STATUSES = [429,500,502,503,504]`（**固定**，不继承生产默认）、`isNonRetryableProviderStatus()`。
- 新增 `sanitizeS3bText(value, secret)`：精确密钥替换 + 凭据头/字段（`Authorization`、`api-key`、`x-api-key`、`*-token`，含 JSON 引号形式与 `Bearer`/`Basic` scheme）+ 裸 `Bearer/Basic <token>`。可单独单测。
- `classifyFailure()` 移入本库（原来在 `scripts/s3b-eval.mjs` 内且不可导入）：使其可在不执行 CLI 入口的前提下被单测。启发式兜底改为：
  - Oracle 自带 `failureAttribution` 优先（原逻辑保留）；
  - 观测优先级（网络/权限/未知副作用/工具参数）原样保留；
  - 仅在 `result=failed` 且 details **正面证明产物错误**（`contentMatches=false` / `artifactMatches=false` / `validationFailure=true` / `artifactMissing=true` / `artifactPresent=false` / `fixtureExecutions=0`）时才给 `artifact_wrong_or_missing`（置信度规则同旧）；
  - 产物匹配或没有产物证据时 → `primary='unknown'`、`confidence='low'`，`secondary` 用机器可读 snake_case 码（`oracle_failed_on_unmet_task_precondition` + `artifact_content_matched`，或 `oracle_failed_without_artifact_wrongness_evidence`）。

### 2.2 `scripts/lib/s3b-provider-config.d.mts`

为上述新增导出与字段补齐类型；`S3bFailureAttribution.reason` 明确注释：**不得**写进 `failureAttribution` 对象（该对象 `additionalProperties:false`）。

### 2.3 `scripts/s3b-eval.mjs`

- 删除本地 `classifyFailure`，改为从共享库导入；`sanitizeOutput` 变为 `sanitizeS3bText` 的薄包装（同一个脱敏规则覆盖 stdout/stderr 与 Provider 错误文本）。
- `--preflight`：确定性错误时输出 `state='configuration_error'` 且 `process.exitCode = 1`，仍然 `liveCallsMade=false`；新增 `realProviderStatus='real_provider_pending'` 以保留旧状态语义，新增 `deterministicConfigurationError`、`authorizationPending`。既有字段 `provider.ready` / `provider.missing` 原样保留。
- `checkLiveAuthorization()`：在授权闸门之后、任何网络路径之前，用**同一个** profile 与 `modelMapping` 判定确定性配置错误并拒绝（消息明确 "refusing before any Provider request"）。授权缺失仍是独立的第一道闸门（消息不变）。
- `normalizeRecord()`：`failureAttribution` 严格投影为 `{primary, secondary, evidenceRefs, confidence}`（满足冻结 schema 的 `additionalProperties:false`），人类可读的 `reason` 记录在 `failureAttributionReason`（record 根层，schema 允许额外属性），**不进入** `failureAttribution`。

### 2.4 `test/s3b-provider-metering.ts`（受计量 Provider 边界）

- `prepareRequest` 改用 `resolveProviderWireModel`（S3B-R 已修的 `${providerId}/` 前缀裁剪逻辑保留，本批在其上建立显式、拒绝歧义的映射）；映射失败在**任何物理请求之前**抛出，并记入 `modelMappingRejections`。`observedParameters` 同时记录 `requestedModelRef`（既有字段名）与 `internalModelRef` / `wireModelId` / `mappingStatus` / `mappingReason`（新增）。
- **权威（结构性）保证**：在 `createLlmClient` 处显式传入固定的 `retryableStatuses: [429,500,502,503,504]`（`retry: { maxAttempts, retryableStatuses }`）。该判定由重试信封**按逻辑调用**决定（`protocol-transport.ts` 用 `retry.retryableStatuses.includes(status)` 推导错误的 `retryable`），因此不依赖任何评测层簿记，也不会被交错的逻辑调用破坏。
- **第二道防线（poison）**：一次逻辑调用收到不可重试状态后，该调用自身的后续物理尝试被拒绝并计 `suppressedNonRetryableReplays`。归属通过 `node:async_hooks` 的 `AsyncLocalStorage` 按逻辑调用传播（不再使用"全局当前调用指针"），因此 A 调用的重试不会被在其重试窗口内启动的 B 调用清除或窃取。仅测试用注入点改名为 `retryOverrides`（可模拟被放宽的重试策略或零退避）；权威保证不依赖该注入点。
- 预算计数：仍在发送前自增 `physicalProviderRequests`，失败/超时/被拒绝同样计入；预算拦截单独计 `blockedPhysicalRequests` 并置 `budgetExhausted`；被 poison 拒绝的重放不计物理请求、不计预算。
- 快照/错误脱敏：错误消息经 `sanitizeS3bText` 后再抛出（必要时保留 `status`/`retryable`/`retryAfterMs`）；Provider 回显在 `error.code/type/param` 里的密钥先脱敏再通过字符集校验；`responseModelIds` 也先脱敏再截断。

### 2.5 `test/s3b-provider-metering.test.ts`

原 8 个用例逐字保留；新增 28 个用例（含 `it.each` 展开），共 36 个。

## 3. 需求 → 测试映射

| 需求 | 测试用例 |
|---|---|
| 1 显式内部 ref→wire id 映射，拒绝歧义，记录两个字段 | `resolves exactly one Provider wire model id per internal ref and records both fields`；`records the internal ref and the resolved wire id on every metered request`；`refuses an ambiguous per-request model ref before any Provider request`；`rejects an ambiguous internal model ref in the shared preflight profile` |
| 2 预检与任务入口同一套校验/同一映射结果；确定性错误在网络前拒绝 | `shares one validation and one wire-model mapping between --preflight and the live task entry`；`exits non-zero with state=configuration_error and stays offline when preflight finds a deterministic error`；`refuses --run-real before any Provider request when the configuration is deterministically wrong` |
| 3 模型 ID / endpoint / 协议合法性 | `rejects malformed model ids, endpoints and protocols before any request`；`pins that a wire model id containing an interior slash is rejected as ambiguous`（固定"含斜杠 wire id 不可表达"这一有意行为） |
| 4 确定性配置错误 fail-fast，与待授权分离 | `classifies deterministic configuration errors separately from pending authorization`；`refuses to build a metered Provider from a configuration_error profile without any fetch`；`keeps direct user authorization a separate gate from configuration validity` |
| 5 400/401/403/404/422 不重放、不产生额外物理请求 | `pins the replayable status set so a deterministic 4xx can never be replayed`；`keeps one physical request per logical call for a pinned non-retryable status under interleaving`；`keeps one physical request per logical call when a widened retry overlaps another logical call`；`actively suppresses a replay that a widened retry policy would re-send (HTTP 400/404/422)`；`never re-sends HTTP 401/403 even when the retry policy is widened to allow it` |
| 6 所有物理尝试（含失败）计入预算；预算拦截单独计 | `charges failed physical attempts to the request budget before they are sent`；`meters every retried physical attempt even when each attempt fails`；既有 `blocks the next physical request before dispatch after the configured budget` |
| 7 成功但无 usage → `unavailable` 且 token 为 null | `keeps usage unavailable with null tokens when a successful response carries no usage` |
| 8 不记录密钥/认证头，快照与错误消息都脱敏 | `redacts Authorization, api-key, x-api-key and Bearer secrets from text`；`never serializes the API key even when the Provider echoes it in an error body`；既有 `preflights provider identity and budgets without exposing the API key` |
| 9 启发式归因不得与 Oracle 证据矛盾 | `stops claiming artifact_wrong_or_missing when the oracle details show the artifact matched`；`records unknown/low with an explicit code when the oracle gives no artifact-wrongness evidence`；`still attributes artifact_wrong_or_missing when the artifact is genuinely wrong`；`preserves declared attributions and the observation precedence order` |

关于 `classifyFailure` 可测性：它原先不可导入（`scripts/s3b-eval.mjs` 在模块顶层执行 `main`，导入即产生副作用）。最小改动是把它移入已在写范围内的共享库 `scripts/lib/s3b-provider-config.mjs` 并导出，而不是给 CLI 入口加 `import.meta.main` 之类的执行守卫。`s3b-eval.mjs` 的指纹与入口语义因此保持不变。

## 4. 命令与结果（本批实测）

| 命令 | 结果 |
|---|---|
| `node --check scripts/s3b-eval.mjs` | 通过，退出码 0（无输出）；另跑 `node --check scripts/lib/s3b-provider-config.mjs` 亦为 0 |
| `node scripts/s3b-eval.mjs --preflight`（无任何 S3B_* 配置） | 退出码 **1**；`state="configuration_error"`、`realProviderStatus="real_provider_pending"`、`liveCallsMade=false`、`provider.ready=false`、`deterministicConfigurationError=true`、`provider.missing` 9 项（`S3B_PROVIDER_ID`…`S3B_PROVIDER_BILLING_CAP_CONFIRMED=true`）；未联网 |
| `node scripts/s3b-eval.mjs --suite` | 退出码 0；`taskDefinitions=12`、`adapterCount=8`、`s3aTaskSuiteSha256=b210e505c89a8c795fbae62693295cd2527a50d04c355e6e9c43dd7e54a629ec`、`extensionSha256=8172bacd72be40ac49de357467da5c4c214e23256b6ca686e9bb87af1b8b66e8` |
| `node scripts/s3b-eval.mjs --verify-provider-metering` | 退出码 0；`{"externalNetwork":false,"exitCode":0,"outputSha256":"c7cc21f022475c5723429cdf02e8851ae3981435f13068099c1b85e86c20b799"}`；`Tests 36 passed (36)`；输出中不含 API key。**注意：** `outputSha256` 覆盖 vitest 每次运行都会变化的耗时文本，因此**不可跨运行复现**，只用于标识本次运行；该门复现时应以退出码与用例数为判定依据（独立验证已记录该限制，见 §6） |
| `pnpm exec vitest run test/s3b-provider-metering.test.ts test/s3b-task-adapters.test.ts` | `Test Files 2 passed (2)`、`Tests 40 passed (40)`（metering 36 + task-adapters 4） |
| `pnpm run typecheck` | 退出码 0（`tsc -b tsconfig.workspace.json --pretty false`，无诊断输出） |

### 4.2 独立验证发现后的复跑（本批第二轮）

| 命令 | 结果 |
|---|---|
| `pnpm exec vitest run test/s3b-provider-metering.test.ts test/s3b-task-adapters.test.ts` | `Test Files 2 passed (2)`、`Tests 40 passed (40)` |
| `node scripts/s3b-eval.mjs --verify-provider-metering` | 退出码 0；`{"externalNetwork":false,"exitCode":0,"outputSha256":"c7cc21f022475c5723429cdf02e8851ae3981435f13068099c1b85e86c20b799"}`；`Tests 36 passed (36)` |
| `node --check scripts/s3b-eval.mjs` | 退出码 0 |
| `pnpm run typecheck` | 退出码 0 |
| `node scripts/s3b-eval.mjs --preflight` / `--suite` | preflight 退出码 1（`configuration_error`，`liveCallsMade=false`）；suite 退出码 0（12 定义 / 8 适配器） |
| 变异探针（证明回归测试可判别） | 临时把计量层改回"全局当前调用指针"旧语义后，`keeps one physical request per logical call when a widened retry overlaps another logical call` **失败**（`expected 'fulfilled' to be 'rejected'`：A 的重放被错误派发）；恢复实现后 36/36 通过，文件哈希与备份一致 |

### 4.1 `--preflight` 退出码语义变更的消费方排查

对 `--preflight` 做了全仓 grep（`*.ts`、`*.mjs`、`*.json`、`*.md`、`*.yml`、`*.ps1`）：

- **没有任何测试、脚本、CI 或 `package.json` 命令依赖旧的"恒为 0"行为**：除本批新增的 `test/s3b-provider-metering.test.ts`（显式断言新语义）外，`--preflight` 只出现在 `scripts/s3b-eval.mjs` 自身（用法文本、模式分派）与文档中。
- 文档引用仅描述"脱敏检查、不联网"，未承诺退出码，因此不构成契约冲突：
  - `scripts/README.md:9`
  - `docs/reference/rcd-s3b-provider-evaluation-2026-10-17.md:15,36`
  - `docs/reference/rcd-s3b-evaluation-report-2026-10-17.md:55`
- 这些文档属于既有 `rcd-s3b-*` 冻结记录或不在本批写范围内，**未修改**；其中 `--preflight` 的环境变量清单尚未列出可选的 `S3B_MODEL_REF`（见剩余风险 R3）。

## 5. 剩余风险与不确定项

- **R1（低）** `failureAttribution` 的 `reason` 投影位置：`reason` 放在 record 根层 `failureAttributionReason`（根 schema `additionalProperties:true`），未放入 `failureAttribution`（该对象 `additionalProperties:false`）。若后续希望把人类可读原因放到 `oracle` 对象内，属等价合规的另一种摆放方式，可一行调整。
- **R2（低）** `classifyFailure` 的启发式现在更保守：Oracle 判 failed 但 details 不含任何产物证据时给出 `unknown/low` 而非 `artifact_wrong_or_missing`。这会改变**未来**运行的部分归因分布（历史账本未改写）。这是本批的意图，但会让"按主因聚合"的计数与旧账本不完全可比。
- **R3（低，文档债，部分已由 Lead 解决）** `scripts/README.md:9` 已由 **Lead** 更新，明确记录 `--preflight` 确定性配置错误以退出码 1 + `state=configuration_error` 结束，并用 `realProviderStatus=real_provider_pending` 保留"待授权"语义（**该文件为 Lead 所有，本批未编辑**）。仍存的历史文档债：冻结记录 `docs/reference/rcd-s3b-provider-evaluation-2026-10-17.md:15` 的环境变量清单未列可选的 `S3B_MODEL_REF`（该文件是历史记录，本批不修改）。
- **R4（低）** 冻结 schema 未校验运行期账本（无 `ajv` 校验器）；本批按契约手工保证 `failureAttribution` 形状合规，但没有自动化 schema 校验兜底。
- **R5（信息）** 权威的非重放保证是构造期固定的 `retryableStatuses`（按逻辑调用生效），poison 层是第二道防线且已按逻辑调用归属（`AsyncLocalStorage`）。对 401/403，`packages/llm` 的 `classifyFailure` 已把它们硬编码为 `auth` 类、永不重放，因此测试中 `suppressedNonRetryableReplays=0`；400/404/422 在策略被放宽时由 poison 层主动抑制（测试中为 1）。五者均"不产生额外物理请求"。
- **R6（低）** `sanitizeS3bText` 为 fail-closed 脱敏，可能过度脱敏（例如任何 `token: value` 文本）。这是有意的安全取舍，不影响机器可读字段。
- **R7（推荐，未执行）** 若希望把"归因原因"作为 `failureAttribution` 的一等字段，需要修订 `rcd-s3b-metrics-schema-2026-10-17.json` 并接受 `metricsSchemaSha256` 变化。本批**未**做此修改，仅作为建议上报。

## 6. 独立验证发现与修复（第二轮）

### 6.1 发现 1（中）：非重放保证此前不是结构性的

- **现象**：budget=8、maxAttempts=2、把 400 加入可重试集合后，调用 A 收到 400 并安排重试；120 ms 后调用 B 启动并返回 200；A 的重试随后被派发 → `fetchCalls=3`、状态 `[400,200,200]`、`suppressedNonRetryableReplays=0`。
- **根因**：计量层用"全局当前调用指针"归属 poison，并在每次新逻辑调用时清除，因此任何在 A 重试窗口内启动的逻辑调用都会清掉 A 的 poison。全局指针在原理上无法归属属于更早调用的重试。
- **修复**：
  1. **结构性权威保证**：在 `createLlmClient` 处显式传入固定 `retryableStatuses: [429,500,502,503,504]`；该判定在重试信封内部按逻辑调用生效，不受交错影响，也不依赖评测层簿记。未修改 `packages/llm`。
  2. **poison 层改为按逻辑调用归属**：用 `node:async_hooks` 的 `AsyncLocalStorage` 把每个逻辑调用的 poison 状态沿其自身的异步链传播，替换"全局当前调用指针"；因此被放宽的策略下 A 的重试也会被正确抑制。代码注释明确：权威保证是构造期固定集合，poison 是第二道防线（不再声称它单独提供保证）。
- **回归测试**：`keeps one physical request per logical call for a pinned non-retryable status under interleaving`（固定集合下两个交错逻辑调用各 1 次物理请求）；`keeps one physical request per logical call when a widened retry overlaps another logical call`（策略被放宽 + 交错，A 的重试被抑制，`suppressedNonRetryableReplays=1`，总计 2 次物理请求）。
- **可判别性证据**：临时把实现改回旧的"全局当前调用指针"语义后，放宽场景的回归测试**失败**（A 被错误地判定为 fulfilled）；恢复后 36/36 通过，恢复文件哈希与备份一致。

### 6.2 发现 2（低）：注释与真实行为不符

- **现象**：`modelIdFacts()` 注释称"单个内部分隔斜杠是合法的（vendor/model 是真实约定）"，但实际上 `S3B_MODEL='meta-llama/Llama-3'` 的默认 ref、裸 ref、双重前缀 ref 全部被拒绝，含斜杠的 wire id 不可表达。
- **处理**：拒绝行为本身**正确且保留**（fail-closed；放宽会重新打开历史前缀残留缺陷，且需要额外的配置侧拒绝设计，超出低风险发现范围）。修改注释为真实规则（provider 前缀之后的 model 段必须不含斜杠 → S3B 目前只支持不含斜杠的 wire model id），并新增固定测试 `pins that a wire model id containing an interior slash is rejected as ambiguous`（三种 ref 形态的拒绝原因 + profile 不 ready + "任何被接受的映射都不会产出含斜杠的 wire id"）。**未放宽映射。**
