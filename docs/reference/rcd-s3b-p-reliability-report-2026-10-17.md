# RCD S3B-P 真实模型评测复盘与可靠性收口报告

**批次：** LS RCD S3B-P（P01–P06）
**日期：** 2026-10-17（证据批次日期；本报告撰写于 2026-10-18）
**分支：** `codex/s3b-p-reliability-closure`（独立工作树）
**开发基线：** `7a29444afa98f1e249fc29e330d6ae81355aab74`（本地 `main`）
**前置成果：** S3B-R `b765b372`；冻结产品提交 `d5015136ca9cf9583423361263b5bacba257a385`
**性质：** 只读复盘 + 评测层（非产品层）修复。**未调用任何真实 Provider API，未联网，未修改生产 Runtime/Harness/Tools/Prompt，未合并 `main`，未推送远端，未启动 S3C。**

---

## 1. 可信结论

### 1.1 首批真实模型评测真正证明了什么

| # | 结论 | 置信度 | 依据 |
|---|---|---|---|
| C1 | 修正模型 ID 后，四项任务各完成 **1 次**有效真实 Runner/Harness 试跑，独立 Oracle 结果 **2 通过 / 2 失败**（CODE-01 `passed`、MULTI-01 `passed`、FILE-02 `failed`、DELIV-01 `failed`）。 | high | [P01 审计](rcd-s3b-p01-trajectory-audit-2026-10-17.md) §1、§3；批次 `counts` |
| C2 | 有效运行汇总为 **13 次逻辑/物理 Provider 请求、11 次工具提议、11 次工具执行、7 个已结算 Effect**（unknown Effect 0、拒绝 0、失败 0），逐项求和与批次汇总一致。 | high | P01 §1.2、§5.1；[P01 账本](rcd-s3b-p01-audit-ledger-2026-10-17.json) `aggregates` |
| C3 | **2/4 不是成功率**。每任务 n=1 不构成分布，批次 `validProviderModelIdPassRateNotClaimed = true`；合并 n=4 的 Wilson 95% 半宽约 ±0.35。 | high | P01 §7.2；[P06 协议](rcd-s3b-p06-round2-protocol-2026-10-17.md) §2.3 |
| C4 | 两个真实失败**都不是模型能力失败**，而是任务/Oracle 契约缺陷（见 §2）。 | high | [P02/P03 归因](rcd-s3b-p02-p03-failure-attribution-2026-10-17.md) §2、§3 |
| C5 | MULTI-01 是一次**货真价实的通过**：产物 `a.txt` = `sha256("hello")`、`b.txt` = `sha256("world")`，与用户输入逐字相符；模型两次调用 Runtime 的文件内容检查工具，持久化 Task Outcome 两项要求均 `passed`、inventory `complete`。 | high | P01 §3.1、§4.6；本报告独立复算哈希 |
| C6 | **评测基础设施本身没有失败**：4 次有效运行 `infrastructureStatus` 全为 `executed`、`runtimeStatus` 全为 `ok`、Provider HTTP 失败 0、禁网违规 0、清理失败 0。 | high | P01 §5.1、§7 |
| C7 | 首批真实运行**不能**证明模型稳定性、真实费用或端到端产品成功率。费用全程 `unavailable`；无 Electron/Renderer 验收。 | high | P01 §7；§4 未执行项 |

### 1.2 必须同时保留的负面事实

| # | 事实 | 依据 |
|---|---|---|
| N1 | 另有 **2 次错误模型 ID 的真实请求尝试**（CODE-01 trial 1、FILE-02 trial 1），各 8 个物理请求、**合计 16 个**，全部失败（FILE-02 trial 1 记录到 8 条 HTTP 400）。它们**不计入有效成功率，也不得假定无费用**。 | P01 §1.3、§5.2 |
| N2 | 另有 **2 次零模型请求的评测器分派诊断**（选错测试文件），账本把请求计数记为 `null` 而非 0。三类运行必须分开统计：**4 有效 / 2 错误模型 ID（16 请求）/ 2 零请求诊断**。 | P01 §5.3、§8.5 |
| N3 | 已记录物理请求合计 **29 = 13 + 16**，与批次 `allRecordedActualPhysicalProviderRequests` 一致；真实费用全部 `unavailable`。 | P01 §1.5、§4.7 |
| N4 | Agent 最终回复文本、首个有效产物延迟、人工干预次数在真实运行中**不可得**，已按 `evidence_insufficient` + `reason` 记录，未据汇总编造调用过程。 | P01 §9 |
| N5 | 首批评测器指纹在运行间**不一致**（4 个不同值），不存在单一字节级评测器版本。 | P01 §7.6；P06 §9.3 |

> **任务书笔误更正（Lead 复核）：** 任务书括号把「8 个 HTTP 400」归到 CODE-01 分派诊断。按账本字段，两次各 8 请求的失败尝试是 CODE-01 trial 1 与 FILE-02 trial 1；分派诊断的请求计数为 `null`。已按账本纠正，未修改任何账本（P01 §8.5）。

---

## 2. FILE-02 与 DELIV-01 的归因与证据等级

### 2.1 FILE-02（原 Oracle `failed`，保留）

**主要归因：任务/Oracle 契约缺陷。证据等级 high。**

- 用户原文（冻结任务集 `tasks[4].userInput`）只规定输出文件名、总量数值 5、items 按 sku 排序并保留数量，**从未规定 JSON 字段名**；`successConditions` 同样只作语义描述（"Total equals 5."）。
- Oracle 实现为 `JSON.stringify(parsed) === JSON.stringify(expected)`，其中 `expected = { total: 5, items: [{sku:'A',qty:2},{sku:'B',qty:3}] }`，因此额外固定了顶层字段名与键序。该约束**不存在于模型可见上下文中**：真实适配器原样传入 `task.userInput`，任务集解析器根本不读 `successConditions`/`oracle`，`write` 工具 Schema 仅为 `{file_path, content}`。
- 真实试跑实际产出为 `{"total_quantity":5,"items":[{"sku":"A","qty":2},{"sku":"B","qty":3}]}`：**数量、明细、排序、内层键名全部正确，无多余文件**。
- **精确化更正：** 归因方用产物 SHA-256 反向重建（135 字节唯一命中）证明**键顺序也没有不符**——唯一差异是顶层**字段名** `total_quantity` ≠ `total`。因此该失败面应从"格式与命名都不对"收窄为"单一未公开命名约定"。
- 该 Oracle 在受控与真实两条路径**重复实现**（`test/s3a-task-adapters.test.ts` 与 `test/s3b-live-task-trials.test.ts`），未来修 v2 必须同时覆盖两处。
- 次要归因（促成因素，非因果起点）：模型命名决策偏差（`total_quantity` 是对提示语 "total quantity" 的字面忠实）；缺少「Oracle 接受集 ⊆ successConditions」一致性校验。

### 2.2 DELIV-01（原 Oracle `failed`，保留）——双维度分离

| 维度 | 结论 | 证据等级 |
|---|---|---|
| **任务目标正确性** | **最终产物正确**：`result.txt` 内容恰为 `verified-output`（15 字节，`sha256 69188ece…` 由本机独立复算匹配），恰好执行一次写入，1 个已结算 Effect，无拒绝/失败调用 | high |
| **错误恢复能力** | **`not_exercised`（未行使）**：`validationFailure = false` 证明参数错误路径从未发生，模型首次即提出合法参数；**没有任何需要"恢复"的对象** | high |

**主要归因：任务/Oracle 契约缺陷。证据等级 high。** DELIV-01 的 `successConditions` 并列了两项**事件要求**（"An invalid proposal is rejected before execution."、"The Provider receives structured validation feedback."）与一项产物要求，Oracle 用 `&&` 串成单个布尔值。后果是**「越正确越失败」**：模型一次做对时事件要求必然为假，产物即使完全正确也无法通过。

**明确边界：** 该 `failed` **不是**模型恢复能力失败。把 `not_exercised` 解释为"不会纠错"是把"未观测"当成"未具备"。历史 Oracle 结果按冻结契约保留 `failed`。

**后续验证 S1A 的正确方式：** 设计独立专项场景 `S1A-PARAM-01`，由**评测器侧确定性注入**一条 schema-invalid 提议（经真实 `ToolExecutionService` 产生真实 `validation_failed` + `input_validation`），再提交修正提议；四项判据（无效提议零副作用 / Provider 收到有界结构化反馈 / 修正后恰好执行一次 / 独立回读字节匹配）全部由外部 Oracle 读取，且**机制维度永不作为任务成功前置条件**，独立账本记账。

### 2.3 三处评测器记账缺陷（本批已确认，历史账本不改）

| # | 缺陷 | 证据 | 处置 |
|---|---|---|---|
| D1 | DELIV-01 记录 `failureAttribution.primary = artifact_wrong_or_missing`（confidence high），与**同一记录**内 `contentMatches = true`、`validationFailure = false` 自相矛盾 | P01 §8.2 | **本批已修**（P04 第 9 项，见 §4） |
| D2 | 顶层 `productBaseline.productSourceDirty = true` 与逐记录 `records[i].source.productSourceDirty = false`（6/6）语义冲突；`dirtyPaths` 实际只含评测产物 | P01 §8.1 | 仅建议未来拆名（`productSourceDirty` / `evaluationArtifactsDirty`），本批不改账本 |
| D3 | 报告散文 `rcd-s3b-real-deepseek-report-2026-10-17.md:39` 把 FILE-02 写作"保留真实产物失败"，与产物证据冲突 | P02 §1.5 | 本批归因一律以源码与账本字段为准；不改历史报告 |

### 2.4 另一处待澄清观察（未决，需产品/评测负责人裁定）

`rcd-s3a-task-suite-2026-10-17.json` 中 MULTI-01 的 `successConditions` 描述的是**受控/脚本场景**（预置 `b.txt` 为 `goodbye` 的部分失败），与真实模型运行采用的 Oracle 语义不一致（真实运行按用户输入要求 `world`，判定 `passed/passed`）。**该不一致不影响 C5 的通过结论**——产物哈希与用户输入逐字相符；它是一处冻结任务集元数据与真实运行验收口径不一致的记录问题（P01 §8.3；P06 §13 P06-R0-2）。

---

## 3. DELIV-02 产品缺陷评审（结论摘要）

**评审结论：`partially sufficient`（部分足够）。** 结构化事实正确且可见——`packages/types/src/task-outcome.ts:186-188` 在契约层拒绝 inventory 非 `complete` 的结果成为 `completed`，Runtime 保守返回 `unknown`，卡片文案无虚假陈述。**缺陷在呈现层：正确的话说得太轻，且从不正面反驳模型声明。**

关键证据（详见 [P05 评审](rcd-s3b-p05-deliv-02-product-review-2026-10-17.md)）：

- 卡片渲染在模型最终回复**之后**且视觉更弱（`assistant-turn.tsx:167` vs `:171`；12px / muted 徽标）。
- `is-completed` / `is-unresolved` / `is-unknown` 只出现在 TSX，**任何 CSS 都没有对应规则** → 已验收与未解决之间没有卡片级视觉差异。
- `unknown` 且无成功文件写入时**整卡不渲染**（`task-outcome-presentation.ts:90`）。
- 唯一 `role="status"` 通道有意排除了 `unverified`（`activity-visibility.ts:121-123`）。
- 现有验收脚本只覆盖 3 个可解析场景，且从不在 UI 层覆盖 DELIV-02 形态。

**推荐最小修复（纯展示层，不重建 VERIFY Stage，本批未实施）：** 新增 `unverified` 徽标语气并固定为「未验收」；去掉 `unknown` 的"无文件写入即隐藏"门；在回复下增加声明对照行（"模型最终回复里的完成声明不构成验收通过"）；补齐卡片状态 CSS 规则与 `role="status"`。

**与上游解析的关系：** 严格文件要求解析器未识别 DELIV-02 的任务措辞（`task-outcome-request.ts:20` 的窄正则）→ inventory `unknown`。这是**覆盖不足**，与呈现层缺陷是两个独立问题；本批只做缺陷分析，未修改生产 Prompt 或 Runtime。

---

## 4. Provider 评测器修复与离线验证（P04）

### 4.1 已修问题

| # | 问题 | 修复 |
|---|---|---|
| 1 | 内部模型标识 → wire model id 只有隐式字符串裁剪，歧义无法拒绝 | 新增 `resolveProviderWireModel` 显式解析：provider 段/model 段必须与配置一致，拒绝前缀残留与嵌套路径；同时记录内部引用与 wire id |
| 2 | `--preflight` 恒 `exit 0`，预检与任务入口没有共同停止点 | 确定性配置错误 → `exit 1` + `state=configuration_error`（保留 `realProviderStatus=real_provider_pending` 旧语义、`liveCallsMade=false`）；`--run-real` 用同一 profile 与同一映射在网络发送前拒绝 |
| 3 | 模型 ID / Endpoint / 协议合法性校验不足 | 模型 ID 空值、空白、URL、斜杠前缀/后缀/空段、超长一律拒绝；endpoint 必须 HTTPS（仅回环允许 http）且不得含 userinfo |
| 4 | 确定性错误与"待授权"混同 | 两者分离；确定性错误 fail-fast，不进入重试或网络路径 |
| 5 | 认证/模型不存在/参数错误可能被盲目重放 | 固定 `[400,401,403,404,422]` 不可重放、`[429,500,502,503,504]` 可重放；**权威保证为构造期固定集合**（按逻辑调用在重试信封内判定，交错无法破坏），poison 层为第二道防线 |
| 6 | 失败请求是否占用预算不明确 | 所有物理尝试在**发送前**计入预算，失败/超时同样计入；被拦截请求单独记 `blockedPhysicalRequests` |
| 7 | Usage 缺失 | 保持 `unavailable`，token 字段为 `null`，不推算 |
| 8 | 秘密泄漏面 | 共享脱敏覆盖 `Authorization` / `api-key` / `x-api-key` / `*_token` / `Bearer` / `Basic` 与 Provider 回显正文 |
| 9 | 归因与 Oracle 证据矛盾（D1） | 归因启发式不再断言证据不支持的结论：Oracle 失败但产物证据匹配 → `primary: unknown`、`confidence: low` + 机器可读 `secondary` 码；仅在 details 正面证明产物错误时才给 `artifact_wrong_or_missing`。**既有枚举值未增删改**，`failureAttribution` 仍满足 `additionalProperties: false`（人类可读 reason 落在 record 根层） |

**范围声明：** 改动仅限评测覆盖层（`scripts/lib/s3b-provider-config.{mjs,d.mts}`、`scripts/s3b-eval.mjs`、`test/s3b-provider-metering*.ts`）；未修改 `packages/**`、未修改冻结指标 Schema（`metricsSchemaSha256` 仍为 `dac05d05…`）、未改写任何既有账本。

### 4.2 独立验证结论（对抗性，非复述）

| 项 | 结果 |
|---|---|
| 对抗性检查 | **49 组 / 83 个探针用例全部通过**（含"试图绕过"构造：provider 段不符、前缀残留、嵌套路径、空/空白/超长模型 ID、非回环 http、userinfo、放宽重试策略、交错逻辑调用、Provider 回显密钥、矛盾 details、畸形 details 等） |
| 回归门 | 10 项全部符合预期：S3A/S3B 评测器批量测试 exit 0（48 用例）；`--suite` 0；`--preflight` **1**（预期语义，`liveCallsMade=false`，fetch 调用 0）；`--verify-provider-metering` 0（36 用例，`externalNetwork=false`）；Runner/Tools/Outcome 回归 0（10 文件 / 84 用例）；`typecheck` 0；`check:repo` 0；`git diff --check` 0；`node --check` ×2 = 0 |
| 范围合规 | `packages/**` 零修改；task-3 未修改任何受跟踪的既有 `docs/reference` 文件；**无测试或安全断言被删除或弱化**（测试数 8 → 33 → 36，`expect()` 26 → 168） |
| 验证中发现并已修复 | **F1（medium）**：确定性 4xx 重放抑制可被交错逻辑调用绕过（原复现 `fetchCalls=3`、`[400,200,200]`、`A_resolved`）→ 改为构造期固定集合 + 按逻辑调用归属的 poison 层，复测 `fetchImplInvocations=2`、`[400,200]`、`suppressed=1`、`A_rejected`；**F2（low）**：`resolveProviderWireModel` 的注释与真实行为不符（含斜杠 wire id 不可表示）→ 注释更正 + 固定测试，**拒绝行为有意保留**（放宽会重开历史 `deepseek/deepseek-flash` 前缀残留缺陷） |
| 可判别性证据 | 变异探针：把计量层临时改回旧"全局当前调用指针"语义后，新增交错回归测试**失败**（`expected 'fulfilled' to be 'rejected'`），恢复后 36/36 通过且文件哈希与备份一致——证明该测试真的能判别该缺陷 |
| 机器可读证据 | [独立验证账本](rcd-s3b-p-verification-2026-10-17.json)；[P04 报告](rcd-s3b-p04-provider-guard-hardening-2026-10-17.md) §6 |

**已知限制（如实记录，不声称已解决）：** `--verify-provider-metering` 的 `outputSha256` 覆盖 vitest 每次运行都会变化的耗时文本，**不可跨运行复现**，该门复现应以退出码与用例数为判定依据。此外无运行时 Schema 校验器，Schema 合规为手工保证。

---

## 5. 下一轮真实模型试验协议要点（P06，未执行）

详见 [P06 协议](rcd-s3b-p06-round2-protocol-2026-10-17.md)。核心决策：

- **不变项：** 原四项任务、原 Oracle、原首批记录与历史结果一律不改；第二轮使用**新账本**，主口径分母只由第二轮构成，**禁止与首批混算成功率**。
- **重复次数 N = 5**（每任务；主口径 20 次）。理由：首批每任务 n=1 不可用；n=4 半宽 ±0.35 → n=20 收紧到 ±0.20，并首次让每任务成为 0..5 的分布。阶段二扩到 N=10 仅在通过率落在 [0.30,0.70]、预算未触顶且**重新授权**时。
- **独立性：** 每次运行独立子进程、独立临时 workspace（独占创建）、独立账本、独立 trial 序号（延续各任务首批最大值）；不得依据前一次结果自适应修改输入。**诚实声明：** 运行条件被冻结，但模型采样不可控，**不得声称"完全可复现"**。
- **预算：** 每 trial 8 物理请求 / 2048 输出 token / 120 秒 / `maxAttempts=1`（沿用首批配置以保持可比）；arm F 硬上限 160 请求 / 327,680 token；币种建议 CNY，**金额与单价一律「待授权时确定」**；**失败请求全额计入预算且不得假定无费用**。
- **模型版本记录：** 必须同时落盘内部引用、实际发送的 wire model id 与 Provider 响应回执中的模型标识；不一致或不回执的 trial **不计入主口径**并单列。
- **Oracle：** 外部 Oracle 独立从磁盘读取，不采信模型最终回复；arm F 用原版冻结 Oracle（历史可比），arm V 用 v2 Oracle（FILE-02 设计 B + DELIV-01 双维度解耦），**两臂分母互斥、不得合并或作差值显著性主张**。
- **失败轨迹保存：** 每次运行（含失败、配置错误、零请求诊断）一个独立账本，**不得覆盖既有文件**。
- **是否需要新的 Harness 对照版本：不需要。** 首批 0 次 Harness 控制流失败，失败主因是任务/Oracle 契约缺陷。需要的是**评测器对照版本**——第二轮必须冻结单一评测器指纹，且 P04 加固改变了归因语义，第二轮的 `failureAttribution` 与首批**不是同一尺度**，不得相加或直接比较。
- **授权闸门：** 用户明确书面授权 + `S3B_REAL_PROVIDER_AUTHORIZED` + `--authorize-live` 且预检通过，**三者缺一即不执行**；软件 guard 不替代用户授权。

### 执行前必须解决的阻塞项

| ID | 项 | 性质 |
|---|---|---|
| P06-R0-1 | `--trial` 上限为 3，而 CODE-01/FILE-02 首批已占用 trial 1/2 → **N=5 当前不可执行** | 评测器层阻塞，需在授权时一并批准提升上限（不触碰产品/Harness） |
| P06-R0-2 | MULTI-01 冻结 `successConditions` 与真实 Oracle 语义不一致（§2.4） | 需产品/评测负责人澄清 |
| P06-R0-3 | arm V 需要 v2 Oracle 实现 + 「接受集 ⊆ successConditions」一致性测试 | 前置开发 |
| P06-R0-6 | API Key 曾出现在对话中 | 授权前更换新 Key，仅进程环境，事后撤销 |

---

## 6. 证据支持的优先级建议

| 优先级 | 建议 | 依据 |
|---|---|---|
| **P0** | 在下一轮真实试跑前关闭 P06-R0-1（`--trial` 上限）与 P06-R0-6（凭据轮换）；否则第二轮无法按 N=5 执行或存在凭据风险 | P06 §13 |
| **P0** | 先落 **FILE-02-v2 设计 B** 与 **DELIV-01 双维度解耦**（含"接受集 ⊆ successConditions"一致性测试），再做第二轮 arm V——否则 v2 证据无法产生 | P02 §2、§3.3 |
| **P1** | 实施 P05 的最小展示层修复（`unverified` 徽标 + 声明对照行 + 状态 CSS + `role="status"`），使"模型声称完成"不再被读作"验收通过" | P05 §3、§4 |
| **P1** | 建立 `S1A-PARAM-01` 专项场景，把机制能力与任务成功彻底分离记账 | P02 §3.4 |
| **P2** | 未来评测 Schema 版本新增"任务条件未满足 / 契约缺陷"归因类目（本批为避免改变历史可比面，仅回退为 `unknown` + 机器可读 `secondary` 码） | P01 §8.2、P02 §1.4 |
| **P2** | 拆分 `productSourceDirty` / `evaluationArtifactsDirty` 语义；为第二轮冻结单一评测器指纹 | P01 §8.1、P06 §9.3 |
| **P3** | 补齐真实运行的最终回复文本、首个产物时间戳与人工干预计数（首批均为 `unavailable`） | P01 §9 |

---

## 7. 本批交付物与验证

### 7.1 交付物

1. 四项真实任务轨迹复盘报告：[rcd-s3b-p01-trajectory-audit-2026-10-17.md](rcd-s3b-p01-trajectory-audit-2026-10-17.md)
2. FILE-02 / DELIV-01 归因与证据等级：[rcd-s3b-p02-p03-failure-attribution-2026-10-17.md](rcd-s3b-p02-p03-failure-attribution-2026-10-17.md)
3. DELIV-02 产品缺陷评审：[rcd-s3b-p05-deliv-02-product-review-2026-10-17.md](rcd-s3b-p05-deliv-02-product-review-2026-10-17.md)
4. Provider 评测器修复与离线测试：[rcd-s3b-p04-provider-guard-hardening-2026-10-17.md](rcd-s3b-p04-provider-guard-hardening-2026-10-17.md)
5. 下一轮真实模型试验协议：[rcd-s3b-p06-round2-protocol-2026-10-17.md](rcd-s3b-p06-round2-protocol-2026-10-17.md)
6. 机器可读账本：[P01 审计账本](rcd-s3b-p01-audit-ledger-2026-10-17.json)、[P02/P03 归因账本](rcd-s3b-p02-p03-attribution-ledger-2026-10-17.json)、[独立验证账本](rcd-s3b-p-verification-2026-10-17.json)

### 7.2 验证结果（本报告最终冻结修订上执行）

| 命令 | 结果 |
|---|---|
| `pnpm exec vitest run test/s3a-task-adapters.test.ts test/s3b-task-adapters.test.ts test/s3b-live-task-trials.test.ts test/s3b-provider-metering.test.ts` | 通过（4 文件 / 48 用例） |
| `node scripts/s3b-eval.mjs --suite` | 通过（12 任务定义 / 8 适配器，任务集哈希 `b210e505…` 匹配） |
| `node scripts/s3b-eval.mjs --preflight`（无 S3B_* 配置） | 退出码 1（预期：`state=configuration_error`，未联网） |
| `node scripts/s3b-eval.mjs --verify-provider-metering` | 通过（36 用例，`externalNetwork=false`） |
| Runner/Tools/Outcome 定向回归 | 通过（10 文件 / 84 用例） |
| `pnpm run typecheck` | 通过 |
| `pnpm run check:repo` | 通过（35 passed / 3 advisory / 0 failed） |
| `git diff --check` | 通过 |

### 7.3 未执行 / 无法执行（不推断通过）

- **未调用任何真实 DeepSeek API，未联网**（本批限制）。
- **未执行任何 `--run-real`**；第二轮真实试跑必须另行获得明确授权。
- **未运行 Electron Main/Renderer 验收**：本工作树无 Electron 二进制；P05 的界面结论为代码路径推断，未在真实 Electron 中观测 DELIV-02 形态。
- **未运行 `verify:core` / `verify:full`**：本批按受影响边界选择定向回归；不声称更广的门已通过。
- **未做端到端 `--run-controlled` / `--run-real` 账本落盘验证**：会覆盖受跟踪账本且需要真实授权；`failureAttribution` 投影改为直接对冻结 Schema 校验，CLI 拒绝路径以临时输出路径在进程内验证。
- **Socket 级"无网络"证明不可用**：已证明该插桩无效，无网络结论依据为受校验的 fetch 计数器、`liveCallsMade=false` 与受校验的 `spawnSync` 计数器。
- **真实费用不可得**：29 个已记录物理请求无权威账单回执，成本全程 `unavailable`。

---

## 8. 冻结与不改动声明

- 未修改冻结 Oracle、冻结任务集（`rcd-s3a-task-suite-2026-10-17.json`，哈希 `b210e505…`）、冻结指标 Schema（`dac05d05…`）或任何历史账本/报告。
- 历史 Oracle 结果保持：CODE-01 trial 2 `passed`、MULTI-01 trial 1 `passed`、FILE-02 trial 2 `failed`、DELIV-01 trial 1 `failed`；未通过任何手段提高通过率。
- 未修改生产 Runtime、Harness、Tools、权限策略或 Prompt。
- 本批对评测层的改动、对 `scripts/README.md` 的接口说明更新、对新文档的索引登记，均属评测覆盖层，不影响 `productSourceDirty` 判定。
- 未合并 `main`，未推送远端，未启动 S3C。

**批次状态：S3B-P 完成（P01–P06 全部交付）。** 首批真实模型评测的可信结论已明确，已知的无效请求浪费风险已在评测层结构性消除；第二轮真实 API 试跑待另行授权。
