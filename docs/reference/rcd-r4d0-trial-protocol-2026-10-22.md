# RCD R4-D0 真实模型评测准备与协议冻结

**协议版本：** `1.0.0`　**冻结日期：** 2026-10-22

**基线：** `4ebc1e67`（R4-C 完成点）。本协议不调用真实 Provider、不启用真实授权、不修改历史 Oracle、不调整任务 Prompt；如无用户明确批准，不得进入 R4-D1 付费试跑，也不得推送 GitHub。

## 1. 基线核查

| 项 | 事实 |
|---|---|
| 本地 `main` | `4ebc1e67`，工作树干净（本协议提交前） |
| `origin/main` | `c12fb52e`；R4-B/R4-C 的 7 个本地提交尚未推送，**缺少托管 CI 证据** |
| R4-B V2 评测器指纹 | `56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4` |
| V2 合同 / Schema | `2.0.0` / `2`；状态枚举与运行时不变式由 `scripts/lib/r4b/contract.mjs` 校验 |
| V2 任务集 | `docs/reference/rcd-r4b-v2-task-suite-2026-10-21.json`，sha256 `dc124fce7cb6d9a05955e90f9e9e832e12cee1ee31d64b8a89f54cc2317306f1` |
| V2 Oracle | `scripts/lib/r4b/oracles.mjs`，sha256 `4b03bb3ecd003e82bd44d3a0f1173d0399f70e628b5858c04ddb2a8dd3f82a6e` |
| 冻结历史输入 | S3A/S3B 任务集、metrics schema、adapter extension、protocol、S0-F 基线哈希均由 `test:v2` 重新校验且未变 |
| 历史记录 | R4-B 20 条受控记录、S3B-R 真实试跑记录均只读，未被本协议修改 |

### 三套契约必须分开

| 契约 | 任务 | 证据层级 | 能否与其它成功率合并 |
|---|---|---|---|
| S3B-R 历史真实四项试跑 | 历史 S3B 任务（含 DELIV-02 等） | `B_real_model`（历史） | **否**；Oracle/分类器与 V2 不同，只能只读展示 |
| R4-B V2 四项任务 | FILE-02-G/S、DELIV-01-G/R | `A_runtime_deterministic`（已录制）/ `B_real_model`（未来真实试验） | 只能在 V2 内部按三维度统计；不得当作历史任务的配对复现 |
| R4-C DELIV-02 交付回归 | DELIV-02 展示一致性 | 真实 Electron + 受控 Provider | **否**；这是界面契约回归，不是模型任务成绩 |

因此在真实试验报告中，V2 三维度成功率只使用 V2 的 `B_real_model` 试验；S3B-R 结果单列且不参与分母；R4-C 只作为可信交付前置条件。

## 2. 真实试验矩阵（N=5，共 20 个计划试验）

| Task ID | 测试目标 | 维度 |
|---|---|---|
| FILE-02-G | 数据处理正确性（聚合、计数、明细、排序、类型、文件集合） | Goal |
| FILE-02-S | 明确 JSON Schema 遵循（字段名 `total` 在用户可见任务文本中） | Goal + Contract |
| DELIV-01-G | 文件交付正确性（首次调用成功是合法路径） | Goal |
| DELIV-01-R | 确定性参数错误后的恢复能力 | Goal + Mechanism |

- 每个任务固定执行 Trial 1–5，共 **20** 个计划试验；本批不执行真实试验。
- 每个试验固定：任务定义与版本、workspace 种子、权限预设、允许工具、产品 SHA、评测器指纹、模型配置（Provider/wire model/协议/温度/最大输出/超时/重试）、预算包络。
- **Trial 隔离：** 每次试验独立临时 workspace、独立 Runner/session、独立记录文件与 Effect 账本；禁止共享可变 workspace、会话记忆、结果文件或已结算 Effect。`(batchId, taskId, trial)` 是唯一身份；已存在记录默认拒绝覆盖。
- Trial 1–5 是**独立重复**，不是对同一轨迹的续跑；不得把 trial 间的记忆或产物串用。

任务与种子指纹见 `rcd-r4d0-preflight-2026-10-22.json` 的 `protocol.tasks`（每项含 `definitionSha256`、`userInputSha256`、`seedSha256`）。

## 3. 真实 Provider 离线预检

预检工件：`docs/reference/rcd-r4d0-preflight-2026-10-22.json`（20 项检查全部通过；不联网、不设置真实授权）。

| 检查 | 协议结论 |
|---|---|
| 模型映射 | 内部 `deepseek/deepseek-chat` → wire `deepseek-chat`；provider 段不匹配、嵌套路径、残留前缀、model 段不匹配均确定性拒绝 |
| API 协议 | 仅 `openai-chat-completions`、`openai-responses`、`anthropic-messages`；V2 任务要求 `supportsToolCalls=true` |
| Prompt/工具 Schema 指纹 | 任务集、合同 Schema、任务模块、Oracle、`eval-v2`、V2 adapter、Provider 配置均记录 sha256；真实 adapter 尚未接入，属于 D1 前置条件 |
| 物理请求预算 | 每 trial ≤8，批次 ≤160；超限即停止，不得为提高 N 而加预算 |
| 输出 Token | 每请求 ≤2048，批次 ≤40960；Provider 返回 Usage 时才记录实际值 |
| 输入 Token 计量 | 以 Provider usage receipt 为准；缺失时 `unavailable`，不按字符/历史估算 |
| 非法模型/认证/确定性 4xx | `[400,401,403,404,422]` 不重试，发出请求前或首次响应后立即停止；`[429,500,502,503,504]` 受 `maxAttempts≤2` 限制 |
| Usage 缺失 | `unavailable`/null，不推断 token 或费用 |
| 凭据/网络 | 凭据脱敏、不写入记录或日志；受控评测网络 denied；真实请求必须独立授权 |
| 费用上限 | **Provider 侧 USD/CNY 硬上限必须由用户确认实际已配置**；本地请求数和 Token 上限不能代替真实美元费用封顶；离线预检无法验证 Provider 控制台，`providerSideVerified=false` |

## 4. 中止规则（事先冻结）

| 条件 | 停止码 | 行为 |
|---|---|---|
| 配置/模型映射非法 | `CONFIG_INVALID` / `MODEL_MAPPING_INVALID` | 发出任何请求之前停止 |
| 认证失败/模型不存在/确定性 4xx | `AUTH_FAILED` / `MODEL_NOT_FOUND` / `DETERMINISTIC_4XX` | 立即停止批次，不重试 |
| 请求或 Token 预算耗尽 | `BUDGET_REQUESTS_EXHAUSTED` / `BUDGET_TOKENS_EXHAUSTED` | 停止后续真实请求；不得自动加预算 |
| 费用上限未确认 | `BUDGET_COST_UNCONFIRMED` | 不启动付费批次 |
| 重复 trial 身份 | `DUPLICATE_TRIAL_IDENTITY` | 拒绝写入/继续，保留原记录 |
| 账本无法持久化 | `LEDGER_WRITE_FAILED` | 停止批次，保留已产生证据 |
| Provider 临时异常耗尽重试 | `PROVIDER_TRANSIENT_EXHAUSTED` | 停止批次并记录失败物理请求 |
| 授权边界变化 | `AUTHORIZATION_CHANGED` | 立即停止 |
| Usage 缺失 | `USAGE_UNAVAILABLE` | 继续但记录 unavailable，不推断 |
| 网络/安全违规 | `SAFETY_NETWORK_DENIED` | 停止并保留证据 |

失败的物理请求也必须计数并保留证据；不得为了完成 N=5 而提高预算、跳过失败或补齐样本。

## 5. 指标与统计协议

| 指标 | 分母 | 排除（单列，不入分母） | 说明 |
|---|---|---|---|
| Goal | Goal `passed` + `failed` | `not_applicable`、`unverified` | 目标正确性 |
| Contract | Contract `passed` + `failed` | `not_applicable`、`unverified` | 明确约束遵循 |
| Mechanism | Mechanism `passed` + `failed` | `not_exercised`、`blocked`、`unverified` | 仅统计实际触发的机制 |

每个试验同时记录：

- Provider 逻辑请求、物理请求（含失败/重试）、重试、阻塞；
- Provider Usage（输入/输出/缓存）与费用；缺失为 `unavailable`；
- 工具提议、执行、拒绝、失败；已结算 Effect、重复 Effect、未知 Effect；
- 实际文件（hash/存在性）、Git/终端副作用（可观测则记录，否则 `unavailable`）；
- 端到端耗时；首产物延迟（当前 adapter 未记录，保持 `unavailable`）；
- 未验证、权限拒绝、中断、基础设施错误；
- 单次试验的独立 Oracle 结果、拒绝原因与证据引用。

每项指标报告分母、通过/失败数、排除项和 trial 身份。**N=5 是初步故障发现样本**；`populationClaim=false`，不得声称稳定的总体任务成功率或模型排名。

## 6. 离线演练

`node scripts/rehearse-r4d0.mjs --rehearse` 使用本地 scripted Provider 执行 4 任务 × Trial 1–5，并演练：

- 批次调度、trial 身份隔离、记录落盘、汇总；
- 能力失败检测（wrong-field → Goal passed / Contract failed；no-recovery → Goal+Mechanism failed）；
- 基础设施失败分类（无效任务/适配器失败 → 不计入能力分母）；
- 重复运行拒绝；预算超限停止；授权门保持关闭。

演练结果与限制见 `rcd-r4d0-offline-rehearsal-2026-10-22.md`。该演练是证据层级 A，不代表真实模型能力。

## 7. 真实试验授权清单（Go/No-Go）

启动付费试验前必须同时满足：

- [ ] 用户明确指定 Provider 与 wire model（不使用内部引用歧义）；
- [ ] 用户批准 4 任务 × 5 trial 的范围（20 个计划真实试验）；
- [ ] 用户批准物理请求上限与输出 Token 上限；
- [ ] 用户在 Provider 侧实际配置并确认 USD/CNY 费用硬上限、币种与金额；
- [ ] V2 真实模型 adapter 已实现并通过离线 dry-run（当前仅有受控 scripted 路径）；
- [ ] R4-B/R4-C 本地提交获得托管 CI 证据，或用户明确豁免；
- [ ] 记录 R4-C 可信交付回归作为前置条件（DELIV-02 界面契约不得回退）。

当前 Go/No-Go：**No-Go（未具备付费试验条件）**。技术准备、协议、预算与离线演练已就绪，但真实授权、Provider 费用上限确认、V2 真实 adapter 与托管 CI 证据尚缺；不得自动进入 R4-D1。

## 8. 参考

- R4-B 契约设计/任务集/账本：[rcd-r4b-v2-contract-design-2026-10-21.md](rcd-r4b-v2-contract-design-2026-10-21.md)、[rcd-r4b-v2-task-suite-2026-10-21.json](rcd-r4b-v2-task-suite-2026-10-21.json)、[rcd-r4b-v2-ledger-2026-10-21.json](rcd-r4b-v2-ledger-2026-10-21.json)
- R4-C 交付一致性：[rcd-r4c-delivery-consistency-report-2026-10-22.md](rcd-r4c-delivery-consistency-report-2026-10-22.md)
- 冻结预检工件：[rcd-r4d0-preflight-2026-10-22.json](rcd-r4d0-preflight-2026-10-22.json)
- 离线演练：[rcd-r4d0-offline-rehearsal-2026-10-22.md](rcd-r4d0-offline-rehearsal-2026-10-22.md)
