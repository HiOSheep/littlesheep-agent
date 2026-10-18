# RCD S3B-P02/P03 失败归因复盘：FILE-02 字段契约 与 DELIV-01 双维度

**日期：** 2026-10-17（复盘撰写于 2026-10-18）

**工作树：** 仓库独立工作树（分支 `codex/s3b-p-reliability-closure`，基线 `7a29444afa98f1e249fc29e330d6ae81355aab74`）

**性质：** 只读归因复盘。**未修改**冻结 Oracle、冻结任务集、冻结账本或任何历史报告；历史 Oracle 结果一律保留 `failed`。

**机器可读账本：** [rcd-s3b-p02-p03-attribution-ledger-2026-10-17.json](rcd-s3b-p02-p03-attribution-ledger-2026-10-17.json)（`unchangedHistory: true`）

**证据方法：** 全部结论只引用两类来源——(a) 源码/任务集的文件路径 + 行号；(b) 历史账本的字段路径。此外对三处产物做了独立 SHA-256 重建（见 §1.3），用于从哈希反推被删除的临时工作区内容。无网络访问，无真实 API 调用。

---

## 1. 独立复核：Lead 硬事实的核对结果

Lead 在 `task-2` 描述中给出的硬事实逐条复核如下。**三条成立、一条表述需修正、两条需补充**。

| # | Lead 硬事实 | 复核结论 | 证据 |
|---|---|---|---|
| F1 | FILE-02 `userInput` 原文，且用户从未规定 JSON 字段名 | **成立** | `docs/reference/rcd-s3a-task-suite-2026-10-17.json:75` |
| F2 | FILE-02 `successConditions` 仅要求 JSON 可解析 / total=5 / items 恰为 A:2、B:3 且有序 / 无多余文件 | **成立** | 同文件 `:79` |
| F3 | FILE-02 Oracle 用 `JSON.stringify` 精确相等，`expected = {total:5, items:[{sku:'A',qty:2},{sku:'B',qty:3}]}`，同时约束字段名、键顺序与对象内键顺序 | **成立** | `test/s3a-task-adapters.test.ts:161-162` |
| F4 | 受控（脚本 Provider）FILE-02 直接写入 `'{"total":5,"items":[...]}'`，受控运行是"构造性通过" | **成立，且已由哈希字节级证明** | 脚本内容 `test/s3a-task-adapters.test.ts:152`；受控账本 `rcd-s3b-controlled-baseline-2026-10-17.json → records[taskId=FILE-02].oracle.details.evidence[0]`（sha256 `947ffda8…`，62 bytes）；S3A 基线同哈希 `rcd-s3a-baseline-2026-10-17.json → records[taskId=FILE-02].oracle` |
| F5 | 真实试跑 FILE-02 trial 2 写入 `total_quantity: 5`，SKU 顺序与数量正确，Oracle failed | **成立，但"仅字段名/键序不符"的表述不准确** | `rcd-s3b-real-deepseek-FILE-02-trial-2-2026-10-17.json → records[0].oracle.details.actual`（`:299-311`）与 `expected`（`:286-298`） |
| F6 | DELIV-01 Oracle 实现：`oraclePassed = validationFailure && actualExecutions === 1 && bytes === 'verified-output'` | **成立** | `test/s3a-task-adapters.test.ts:204-205` |
| F7 | 真实试跑未出现前置参数错误 → 恢复机制 `not_exercised` | **成立** | `rcd-s3b-real-deepseek-DELIV-01-trial-1-2026-10-17.json → records[0].oracle.details.validationFailure = false`（`:241`） |

### 1.1 修正 1（对 F5）：键顺序**没有**不符，唯一差异是顶层字段名

`records[0].oracle.details.actual` 显示 `{ total_quantity: 5, items: [ {sku:'A',qty:2}, {sku:'B',qty:3} ] }`。由于 `JSON.parse` 保留字符串键的插入顺序，`actual` 的**键序**为 `total_quantity` → `items`，与 `expected` 的 `total` → `items` 相对顺序一致；`items` 内层键序 `sku` → `qty` 也与 `expected` 一致；数组顺序 A→B 一致；数量 2/3 一致。

我用记录的产物 SHA-256 做了独立重建（§1.3），从 79 个候选序列化中**唯一命中**：

```
{
  "total_quantity": 5,
  "items": [
    { "sku": "A", "qty": 2 },
    { "sku": "B", "qty": 3 }
  ]
}
```

（`JSON.stringify(obj, null, 2)` + 尾随 `\n`，135 bytes，sha256 = `5485876851623ab60783b25e41b4bc9e805057a5a492469b9baec50669f3f488`，与账本 `:319-320` 完全一致。）

**结论：唯一失败原因是顶层键名 `total_quantity` ≠ `total`。** 键顺序（顶层与对象内层）在 trial 2 中已经符合 Oracle 要求，因此"Oracle 同时约束键顺序"这一实现事实成立，但它在本次失败中并未成为触发因素。该精确化对归因很重要：它把 FILE-02 的失败面从"格式与命名都不对"收窄为"单一未公开命名约定"。

### 1.2 修正 2：同一 Oracle 在真实试跑适配器中**重复实现**

Lead 只引用了 `test/s3a-task-adapters.test.ts:147-170`。真实试跑路径 `test/s3b-live-task-trials.test.ts:247-255` 内联了**同一份** `JSON.stringify` 精确比较（`:253-254`），DELIV-01 亦然（`:260-261` 对 `:204-205`）。

含义：契约缺陷不是"受控适配器独有"，而是被复制进了真实模型评测路径。修 v2 Oracle 时必须同时覆盖两处，否则真实试跑仍会复现同一误判。

### 1.3 独立哈希重建（方法与本轮结果）

在本机对候选字节串计算 SHA-256，与账本记录比对；不访问网络、不读取被清理的临时目录：

| 目标 | 重建结果 | 账本记录 | 结论 |
|---|---|---|---|
| DELIV-01 `result.txt` | `sha256('verified-output')` = `69188ece3b5874fdca30429af10e9c357002ac68e48883f29d825d51501664b0`，15 bytes | `rcd-s3b-real-deepseek-DELIV-01-trial-1-2026-10-17.json:247-248`；受控同值 `rcd-s3b-controlled-baseline-2026-10-17.json → records[taskId=DELIV-01].oracle.details.evidence[0]` | **精确匹配**：文件内容为 `verified-output`，无尾随换行 |
| FILE-02 受控产物 | `JSON.stringify({total:5,items:[{sku:'A',qty:2},{sku:'B',qty:3}]})` + `\n` = `947ffda8…`，62 bytes | `rcd-s3b-controlled-baseline-2026-10-17.json → records[taskId=FILE-02].oracle.details.evidence[0]` | **精确匹配**：受控产物与 `test/s3a-task-adapters.test.ts:152` 的脚本字符串逐字节相同 → 构造性通过确认 |
| FILE-02 trial 2 产物 | 见 §1.1，`5485876851…`，135 bytes | `rcd-s3b-real-deepseek-FILE-02-trial-2-2026-10-17.json:319-320` | **唯一匹配**：反推出完整键序与缩进格式 |

### 1.4 补充 3：失败分类枚举缺少"契约缺陷"类目

`scripts/s3b-eval.mjs:181-198` 的 `classifyFailure()` 在无显式归因时，对任何 `oracle.result === 'failed'` 走兜底分支 `:198` → `artifact_wrong_or_missing`，且 `evidenceRefs` 非空时置信度直接给 `high`。因此 FILE-02 与 DELIV-01 的历史账本都被标为该主因。这不是数据伪造，而是**分类枚举与 Oracle 语义之间的表达力缺口**：该枚举（协议 `rcd-s3a-evaluation-protocol-2026-10-17.md:54`）没有"任务/Oracle 规格缺陷"这一项。

### 1.5 补充 4：报告散文不得作为 Oracle 语义依据

`docs/reference/rcd-s3b-real-deepseek-report-2026-10-17.md:39` 将 FILE-02 描述为"保留真实产物失败"。按 §1.1，产物数据（总量、明细、排序、内层键名）全部正确，仅在 Oracle 事后定义的顶层键名上不符——用"产物失败"概括会掩盖契约缺陷。同理 `:31`、`:32` 的措辞（"Oracle 条件未满足"）虽不含错误，但读者容易读成模型能力失败。**本次归因一律以源码与账本字段为准，不引用报告结论句。**

---

## 2. P02 — FILE-02 归因（逐条回答，含证据等级）

### Q1. 原始用户是否明确规定 `total` 字段？——**没有。证据等级：high**

`userInput`（`rcd-s3a-task-suite-2026-10-17.json:75`）原文：

> Read inventory.csv and create inventory-summary.json with total quantity 5 and items sorted by sku, preserving each quantity.

用户只规定了：目标文件名、总量数值 5、items 按 sku 排序、保留各自数量。**没有任何字面要求**出现 `total` 键、`items` 键或 `sku`/`qty` 键名；短语 "total quantity" 是对数量的自然语言描述，而不是字段名。

补充反证：`successConditions`（`:79`）同样只写 "Total equals 5." 与 "Items are exactly A:2 and B:3 in sorted order."，是**语义**表述而非键名表述。用户契约与成功条件都没有要求精确键名。

### Q2. 模型实际上下文是否包含该字段约束？——**不包含任何字段名/Schema 约束。证据等级：high**

三条独立证据：

1. 真实试跑适配器把任务文本**原样**传给 Runner：`test/s3b-live-task-trials.test.ts:229` `text: task.userInput`；运行文本取自 `readTaskSuite()`，而该函数声明的类型只解析 `{ id, userInput, seed, allowedTools }`（`:60-63`）——`successConditions` 与 `oracle` **根本没有进入运行上下文**。
2. 运行前只播种 CSV：`:192` `seedTask(env.workspace, task.seed)`；`seed` 仅为 `inventory.csv`（`rcd-s3a-task-suite-2026-10-17.json:76`）。
3. 工具上下文只有通用写工具：`:234` 用 `toolFilter` 把可用工具限制为任务 `allowedTools`（`:77` = `read`/`write`）。`write` 的输入 Schema 是 `packages/tools/src/builtin/write.ts:30-33`：`file_path: z.string()` + `content: z.string()`，描述为 "Content to write."（`:37`）——对 JSON 结构零约束。

结论：Oracle 的 `expected` 对象只存在于评测器内部（`test/s3a-task-adapters.test.ts:161`、`test/s3b-live-task-trials.test.ts:253`）。**模型上下文里不存在"必须叫 total"这一事实**，因此也不存在被违反的模型可见 Schema。

### Q3. 工具或任务契约是否存在歧义？——**存在结构性歧义。证据等级：high**

- 工具侧：无 Schema 约束的通用 `write`（`write.ts:30-33`）——任何合法 JSON 文本都能通过工具层校验并成功落盘（trial 2 的 `write` 记录为 `succeeded`，`rcd-s3b-real-deepseek-FILE-02-trial-2-2026-10-17.json:222-225`）。
- 任务侧：`successConditions`（`:79`）用语义语言描述验收。
- Oracle 侧：`JSON.stringify(parsed) === JSON.stringify(expected)`（`test/s3a-task-adapters.test.ts:162`）把验收提升为**精确字节级等价**，额外固定了顶层键名、顶层键序与内层键序。

于是同一个 Run 里存在两套互不包含的验收标准：工具层"任意 JSON 均可写"、Oracle 层"只有一种键名/键序可通过"。模型无法从任何可见信息推断出后者。这正是歧义的来源，且歧义**全部**落在 Oracle 一侧。

### Q4. Oracle 是否正确反映原任务？——**没有。Oracle 严格强于 successConditions。证据等级：high**

| 维度 | `successConditions`（`:79`） | Oracle 实际约束（`test/s3a-task-adapters.test.ts:161-162`） | 是否超纲 |
|---|---|---|---|
| JSON 可解析 | "JSON parses." | `JSON.parse` 成功 | 否 |
| 总量 | "Total equals 5." | 顶层键名必须恰为 `total` 且值为 5 | **是（键名）** |
| items | "exactly A:2 and B:3 in sorted order" | 键名必须为 `items`；内层键必须恰为 `sku`/`qty`；内层键序固定 | **是（键名 + 键序）** |
| 文件集合 | "No unrelated output file is created." | `files` 必须逐项等于 `['inventory-summary.json','inventory.csv']` | 否（语义等价） |

`JSON.stringify` 精确比较使 Oracle 成为**字符串契约检查器**，而任务集与用户文本给出的都是**语义契约**。Oracle 未反映原任务，且这一超纲并未写入 `successConditions`，构成规格缺陷（非模型缺陷）。

### Q5. 模型是否在已有正确数据的情况下"违反输出 Schema"？——**数据正确，仅顶层键名不符；"Schema"由 Oracle 事后定义。证据等级：high**

- 数量正确：`total_quantity: 5`（`:300`），对应 "Total equals 5."
- 明细与排序正确：`items = [{sku:'A',qty:2},{sku:'B',qty:3}]`（`:301-310`），恰为 A:2、B:3 且按 sku 升序
- 无多余文件：`files = ['inventory-summary.json','inventory.csv']`（`:312-315`）
- 工具与副作用：3 次工具调用全部 `succeeded`（`:217-230`），1 个 `write` 副作用 `succeeded`（`:231-237`），无拒绝、无校验失败（`deniedToolCalls: 0`、`failedToolCalls: 0`，`:185-186`）
- 唯一差异：顶层键名（§1.1，哈希级证明）

一个值得记录的细节：模型为内层对象选择了 `sku`/`qty`，与 CSV 表头（`rcd-s3a-task-suite-2026-10-17.json:76` `"sku,qty\nB,3\nA,2\n"`）一致；顶层则从提示语 "total quantity" 取词得到 `total_quantity`。这是**对提示语的字面忠实**，而非随意命名。把该选择判为"理解或推理错误"缺乏证据。

### P02 主要归因与次要归因

**主要归因：任务/Oracle 规格缺陷（contract defect）——证据等级 high**

因果上最早失败点不在模型，而在验收定义：`userInput` 与 `successConditions` 都未规定键名，Oracle 却以 `JSON.stringify` 强制唯一键名与键序，且该要求对模型不可见（Q1+Q2+Q4）。模型交付的数据满足全部已声明成功条件；只有 Oracle 事后定义的键名不满足。

**次要归因（促成因素，非因果起点）：**

1. **模型决策偏差（naming choice）——证据等级 high，但非主因。** 模型选择了 `total_quantity` 而非评测器内部约定的 `total`。在存在真实下游消费者的场景中，字段命名确实是模型应主动澄清或对齐的决策点；本次它没有澄清，也没有额外证据表明它尝试过确认字段名。然而：用户从未要求 `total`，模型的选择与提示语一致，且**任何**命名都无法保证命中 Oracle 的未公开约定——因此它是促成因素，不是充分原因。
2. **Oracle 与 successConditions 之间缺少一致性校验——证据等级 high。** 评测协议要求 Oracle 引用证据（`rcd-s3a-evaluation-protocol-2026-10-17.md:54`），但没有任何机制要求 Oracle 的接受集与 `successConditions` 对齐。该缺口让超纲约束长期未被发现，并同时存在于受控与真实两条路径（§1.2）。
3. **失败分类枚举表达力不足——证据等级 high。** `classifyFailure()` 兜底把失败一律记为 `artifact_wrong_or_missing`（`scripts/s3b-eval.mjs:198`），无法表达"契约缺陷"，导致账本与报告的归因面被系统性偏向"产物错误"。

**归因边界（必须区分）：** 本结论是"任务/Oracle 规格缺陷为主因 + 模型命名决策偏差为次因"，**不是**"模型理解或推理失败"。证据等级 high。历史 Oracle 结果保留 `failed`，不因本次归因而改写。

### FILE-02-v2 未来独立改进版本（不落地到历史）

**v2 任务文本（若采用设计 A）：**

> Read inventory.csv and create inventory-summary.json. The file must be a JSON object with a top-level field named exactly `total` whose numeric value is the total quantity, and a top-level field named exactly `items` whose value is an array of objects with exactly the fields `sku` and `qty`, sorted ascending by `sku`, preserving each quantity. Do not create any other file.

**v2 Oracle 语义化判据（无论 A/B 都必须满足）：**

1. 独立从磁盘读取 `inventory-summary.json`，`JSON.parse` 必须成功。
2. 总量：存在唯一一个语义总量字段，其数值 `=== 5`（按选定设计判定字段名集合）。
3. items：数组，元素为对象，且**语义等价**于序列 `[{sku:'A',qty:2},{sku:'B',qty:3}]`——比较对象时**不得**使用 `JSON.stringify`（改用逐键比较，键序无关），数组顺序必须按 `sku` 升序（这是 `successConditions` 的明确要求）。
4. 文件集合恰为 `{inventory-summary.json, inventory.csv}`，无多余产物。
5. Oracle 必须显式声明其接受集，并与 `successConditions` 逐条对应（新增契约一致性校验）。

#### 设计 A：在任务文本中显式规定字段名

- **做法：** 把 `total` / `items` / `sku` / `qty` 写进 `userInput`；Oracle 断言文本中已明示的契约。
- **代价：** (a) 改变了任务性质——从"自然语言理解 + 数据变换"变成"显式 Schema 遵从"，测到的是指令跟随而非理解；(b) 必须新增任务版本号（如 `FILE-03`）而不能原地改写冻结定义；(c) 仍需同步修改两份 Oracle 实现。
- **对历史可比性的影响：** 与 FILE-02 的历史记录**不可比**（任务定义哈希变化，评测器哈希变化）。必须在独立账本中记录为不同任务/版本，不得回填。

#### 设计 B：Oracle 接受语义等价的字段名/键序

- **做法：** 保留原始 `userInput`；Oracle 改为语义比较：总量字段接受等价命名（如 `total`、`total_quantity`，或"唯一数值为 5 的顶层数值字段"规则），items 数组按 `sku` 升序语义比较，对象内键序无关；仍要求无多余文件。
- **代价：** (a) Oracle 变宽，不再捕获"键名不符合下游消费者"的问题——若确实存在消费者契约，必须另行显式声明；(b) 需要明确、可审计的别名/语义规则，否则会出现"接受集不透明"的新歧义；(c) 同样需要新 Oracle 版本，`JSON.stringify` 比较必须删除。
- **对历史可比性的影响：** 原始任务文本不变 → 模型理解维度与 FILE-02 历史记录**语义可比**（同一提示语）；但 Oracle 版本变化使"通过率"**不可比**，必须标注版本并在独立账本中记账。

#### 推荐选择

**推荐设计 B 作为 FILE-02-v2 的默认方案**，理由：缺陷的实质是"未公开的键名要求"，而用户从未要求键名；B 直接消除该不可推断要求，同时保留任务的原意与提示语，使理解维度仍与历史可比。设计 A 仅在**存在真实下游消费者且确实要求精确键名**时采用；此时应把它作为**独立的新任务**（如 `FILE-03`，明确标注为"显式 Schema 遵从"场景），而不是把 FILE-02 改写掉。

**两种设计共同的强制项：** Oracle 必须删除 `JSON.stringify` 对象比较（`test/s3a-task-adapters.test.ts:162`、`test/s3b-live-task-trials.test.ts:254` 两处），并新增"Oracle 接受集 ⊆ successConditions"的一致性测试。

---

## 3. P03 — DELIV-01 双维度复盘

### 3.1 维度一：任务目标正确性 —— **最终产物正确。证据等级：high**

| 断言 | 账本证据 | 独立复核 |
|---|---|---|
| `result.txt` 内容恰为 `verified-output` | `rcd-s3b-real-deepseek-DELIV-01-trial-1-2026-10-17.json → records[0].oracle.details.contentMatches = true`（`:243`） | `sha256('verified-output')` = `69188ece3b5874fdca30429af10e9c357002ac68e48883f29d825d51501664b0`，与账本 `:247` **精确匹配**；`bytes = 15`（`:248`）与无换行内容一致 |
| 恰好执行一次写入 | `:242` `fixtureExecutions = 1`；`:157` `toolExecutions = 1`；`:160` `settledEffects = 1` | 与 `:190-195` `invocationEvidence = [{fixture_write_exact, succeeded}]`、`:196-202` `effectEvidence = [{fixture_write_exact, succeeded}]` 一致 |
| 无未结算/拒绝副作用 | `:158-161` `deniedToolCalls = 0`、`failedToolCalls = 0`、`unknownEffects = 0` | — |
| 运行本身正常 | `:144` `infrastructureStatus = "executed"`、`:145` `runtimeStatus = "ok"`、`:226` `error = null` | — |

**结论：** 在"用户要求的产物是否被正确交付"这一维度上，DELIV-01 trial 1 **成功**。模型一次提出有效工具调用，Runtime 结算一次写入，独立回读字节完全匹配。

### 3.2 维度二：错误恢复能力 —— **`not_exercised`。证据等级：high**

Oracle 实现（`test/s3a-task-adapters.test.ts:204-205`，真实路径同构于 `test/s3b-live-task-trials.test.ts:260-261`）：

```js
const validationFailure = calls.some((call) => call.status === 'validation_failed' && call.errorKind === 'input_validation');
const oraclePassed = validationFailure && actualExecutions === 1 && bytes.toString('utf8') === 'verified-output';
```

真实试跑证据：`validationFailure = false`（`rcd-s3b-real-deepseek-DELIV-01-trial-1-2026-10-17.json:241`），且 `invocationEvidence` 仅有一条成功记录（`:190-195`）、`toolCallProposals = 1`（`:156`）。

**因此参数错误路径从未发生**：没有 `validation_failed` + `input_validation` 调用，没有结构化校验反馈被送回 Provider，模型也就没有任何需要"恢复"的对象。恢复机制评价必须记为 **`not_exercised`（未行使）**。

**这不是模型恢复能力失败。** 恰恰相反：模型**首次即提出合法参数**，避免了错误路径。把 `not_exercised` 解释为"模型不会纠错"是把"未观测"当成"未具备"，属于无证据推断。原 Oracle 结果按冻结契约保留 `failed`（`:229`），因为冻结的成功条件确实未被满足——但失败原因是"条件未被行使"，不是"能力缺失"。

### 3.3 耦合缺陷：把"交付正确产物"与"经历并恢复参数错误"压进同一个 Oracle

DELIV-01 的 `successConditions`（`rcd-s3a-task-suite-2026-10-17.json:149`）并列了三项：

1. "An invalid proposal is rejected before execution."（**事件**要求）
2. "The Provider receives structured validation feedback."（**事件**要求）
3. "A corrected proposal executes once and the independently read file matches."（产物要求）

Oracle 用 `&&` 把三者串成一个布尔值（`:205`）。后果是：**模型若一次做对，第 1、2 项必然为假，于是第 3 项即使完全成立也无法通过。** 一次完美交付在结构上被判为任务失败——这是一个"越正确越失败"的判定反转。

该反转不是模型缺陷，而是**评测设计的耦合缺陷**：把"机制是否可用"（能力/基础设施维度）与"目标是否达成"（结果维度）混入同一判定。协议本身要求"评测基础设施状态与产品结果必须正交"（`rcd-s3a-evaluation-protocol-2026-10-17.md:52`），DELIV-01 的 Oracle 违反了这一原则的精神：恢复机制的行使与否是机制维度事实，不应成为任务成功的前置条件。

**次要缺陷（评测器记账）：** 同一记录还断言 `failureAttribution = { primary: "artifact_wrong_or_missing", confidence: "high" }`（`:253-259`），与同块内 `contentMatches: true`（`:243`）**自相矛盾**——被判定为"产物错误或缺失"的产物，其字节内容恰恰被独立验证为正确。根因即 §1.4 的 `classifyFailure()` 兜底（`scripts/s3b-eval.mjs:198`）。这是评测器的**误归因记录缺陷**，已在独立账本 `evaluatorDefects` 中单列（修复工作由 `task-3` 负责；本次仅记录，不改历史）。

### 3.4 独立专项场景：S1A 参数纠错能力验证设计（不落地到历史）

**设计目标：** 在不要求模型先犯错、也不把任务成功绑定到错误事件的前提下，确定性地验证 S1A 参数纠错机制。

**场景 ID：** `S1A-PARAM-01`（新增；不复用冻结的 `C02`，后者是 S1A 的机制前置场景，见 `docs/reference/rcd-s3a-scenario-audit-2026-10-17.json → scenarios[id=C02]` 与 `docs/reference/rcd-s1a-core-regression-2026-10-16.json → records[scenarioId=C02]`）。

**注入方式（确定性、不依赖模型行为）：**

1. 工具：`fixture_write_exact`，`inputSchema: z.object({ path: z.string(), content: z.string() }).strict()`（沿用 `test/s3a-task-adapters.test.ts:183` / `test/s3b-live-task-trials.test.ts:215` 的既有夹具定义）。
2. **评测器侧 driver 注入**一条 schema-invalid 提议 `{ filepath: 'result.txt', content: 'verified-output' }`（缺必填 `path`、含未知键 `filepath`），经由**真实** `ToolExecutionService` 处理，从而产生真实的 `validation_failed` + `input_validation`——注入由评测器确定性触发，**不是**伪造 Schema 错误，也不要求模型先犯错。
3. driver 随后提交修正提议 `{ path: 'result.txt', content: 'verified-output' }`，验证修正路径。
4. **可选（tier B，真实模型）：** 以同一任务文本运行真实模型。若模型直接提出有效提议，`recoveryMechanismEvaluation` 记 `not_exercised`，且**不影响**该 Run 的任务成功判定。

**判据（四个独立断言，全部由外部 Oracle 从账本/磁盘读取）：**

| # | 断言 | 判据 | 证据来源 |
|---|---|---|---|
| 1 | 无效提议**零副作用** | 首条调用记录为 `{status:'validation_failed', errorKind:'input_validation'}`；该调用无 `validatedAt`/`startedAt`；`sideEffects.malformedInputExecutions === 0`；此刻 `actualExecutions === 0` | ToolInvocationRecord + 副作用账本 + 磁盘 |
| 2 | Provider 收到**结构化校验反馈** | 下一轮请求的 tool 消息包含 `source: 'runtime_schema'` 与有界 `issues`（`code`/`path`/`expected`/`received`/`keys`），且**不含**收到的原始字段值 | `packages/tools/src/tool-execution-service.ts:802-813`、`packages/harness/src/stages/execute/tool-validation-projection.ts:1-24`；对照 `packages/harness/src/stages/execute/tool-failure-disposition.test.ts:259` |
| 3 | 修正后**恰好执行一次** | `actualExecutions === 1`、`settledEffects === 1`，无重复副作用 | 副作用账本 |
| 4 | **独立回读** | `result.txt` 字节 === `verified-output`，sha256 = `69188ece3b5874fdca30429af10e9c357002ac68e48883f29d825d51501664b0` | 外部 Oracle 直接读磁盘 |

**记账隔离方式：**

- 新场景写入**独立账本**（如 `rcd-s3b-p-s1a-param-01-<date>.json`），`scenarioId = S1A-PARAM-01`，不并入 S3B 四项任务的成功率统计。
- DELIV-01 历史记录**不动**：`oracle.result` 保持 `failed`，`recoveryMechanismEvaluation` 保持 `not_exercised`。
- `C02` 在 S0-F 的 `failed` 与 S1A 回归中的 `passed` 均保持原值，不被新场景覆盖。
- 新场景区分两个维度并**分别记账**：`taskGoalCorrectness`（产物维度）与 `recoveryMechanismEvaluation`（机制维度）；机制维度取值为 `exercised_and_recovered` / `exercised_and_failed` / `not_exercised`，**永不**作为任务成功的前置条件。
- 本场景不改变工具权限、Shell/Web 策略、Memory 控制或 Runner/Harness 架构（与 S1A 边界一致，见 `docs/taskbooks/runtime-continuity-delivery-taskbook-2026-10-16.md:60`）。

---

## 4. 溯源索引

| 结论 | 来源 |
|---|---|
| FILE-02 用户输入 / 种子 / 成功条件 | `docs/reference/rcd-s3a-task-suite-2026-10-17.json:75`、`:76`、`:79` |
| FILE-02 受控 Oracle 与脚本产物 | `test/s3a-task-adapters.test.ts:152`、`:161-162` |
| FILE-02 真实试跑 Oracle（重复实现） | `test/s3b-live-task-trials.test.ts:247-255`（比较式 `:253-254`） |
| 真实运行只接收 userInput | `test/s3b-live-task-trials.test.ts:60-63`、`:192`、`:229`、`:234` |
| `write` 工具无 JSON 结构约束 | `packages/tools/src/builtin/write.ts:30-33`、`:37` |
| DELIV-01 用户输入 / 成功条件 | `docs/reference/rcd-s3a-task-suite-2026-10-17.json:145`、`:149` |
| DELIV-01 Oracle 表达式 | `test/s3a-task-adapters.test.ts:204-205`；`test/s3b-live-task-trials.test.ts:260-261` |
| DELIV-01 严格夹具 Schema | `test/s3a-task-adapters.test.ts:183`；`test/s3b-live-task-trials.test.ts:215` |
| 结构化校验反馈生成/投影 | `packages/tools/src/tool-execution-service.ts:802-813`；`packages/harness/src/stages/execute/tool-validation-projection.ts:1-24` |
| FILE-02 trial 2 实测 | `rcd-s3b-real-deepseek-FILE-02-trial-2-2026-10-17.json → records[0]`（expected `:286-298`、actual `:299-311`、files `:312-315`、evidence `:316-322`、oracle `:273-275`、invocation `:217-230`） |
| DELIV-01 trial 1 实测 | `rcd-s3b-real-deepseek-DELIV-01-trial-1-2026-10-17.json → records[0]`（validationFailure `:241`、fixtureExecutions `:242`、contentMatches `:243`、evidence `:244-250`、invocation `:190-195`、effect `:196-202`、failureAttribution `:253-259`） |
| 受控/S3A 构造性通过 | `rcd-s3b-controlled-baseline-2026-10-17.json → records[taskId=FILE-02].oracle`、`records[taskId=DELIV-01].oracle`；`rcd-s3a-baseline-2026-10-17.json → records[taskId=FILE-02|DELIV-01].oracle` |
| 失败分类兜底 | `scripts/s3b-eval.mjs:181-198`（兜底 `:198`） |
| 协议：结果与基础设施正交 / 失败枚举 | `docs/reference/rcd-s3a-evaluation-protocol-2026-10-17.md:52`、`:54` |
| S1A 机制与 C02 边界 | `docs/taskbooks/runtime-continuity-delivery-taskbook-2026-10-16.md:19`、`:55-61`；`rcd-s1a-core-regression-2026-10-16.json → records[scenarioId=C02]`；`rcd-s3a-scenario-audit-2026-10-17.json → scenarios[id=C02]` |
| 报告散文（不作为依据） | `docs/reference/rcd-s3b-real-deepseek-report-2026-10-17.md:31-32`、`:39` |

---

## 5. 冻结与不改动声明

- 未修改 `test/s3a-task-adapters.test.ts`、`test/s3b-live-task-trials.test.ts`、`scripts/s3b-eval.mjs`、`docs/reference/rcd-s3a-task-suite-2026-10-17.json` 或任何历史账本/报告。
- 本次只新增两个文件：本文件与同目录的归因账本 JSON。
- 历史 Oracle 结果保持：FILE-02 trial 2 = `failed`；DELIV-01 trial 1 = `failed`。
- DELIV-01 的恢复机制评价记为 `not_exercised`，**不**表述为模型恢复能力失败。
- 无网络访问；无真实 Provider API 调用；所有哈希重建在本机离线完成。
