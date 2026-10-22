# RCD R4-D0 Go/No-Go 与真实试验授权清单

**日期：** 2026-10-22　**协议版本：** `1.0.0`

**结论：**
- **D0 技术准备：Go。** 协议、指纹、预算/停止规则、离线预检与端到端演练已完成并通过回归。
- **真实付费试验（R4-D1）：No-Go。** 尚未取得用户对模型、范围、请求/Token 预算与 Provider 侧费用硬上限的明确批准，且真实模型执行适配器与托管 CI 证据仍缺。**不得自动启动 R4-D1，不得调用真实 API。**

## 1. 冻结基线

| 项 | 值 |
|---|---|
| R4-C 基线 | `4ebc1e67` |
| 协议冻结工件 | `rcd-r4d0-preflight-2026-10-22.json`（协议 `1.0.0`，20 项离线预检全通过） |
| 离线演练基线 | `7606f124`（工作树干净；演练记录 `product.dirty=false`、`sourceDirty=false`） |
| 评测器指纹 | `56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4` |
| V2 任务集 sha256 | `dc124fce7cb6d9a05955e90f9e9e832e12cee1ee31d64b8a89f54cc2317306f1` |
| V2 Oracle sha256 | `4b03bb3ecd003e82bd44d3a0f1173d0399f70e628b5858c04ddb2a8dd3f82a6e` |
| 证据层级 | 演练为 `A_runtime_deterministic`；真实试验必须为 `B_real_model`，不得混算 |

三套契约（S3B-R 历史真实试跑 / R4-B V2 任务 / R4-C DELIV-02 回归）按协议第 1 节分列，禁止合并成功率。

## 2. 离线演练结果

工件：`rcd-r4d0-offline-rehearsal-2026-10-22.json` / `.md`。

| 项 | 结果 |
|---|---|
| 计划 / 执行 | 20 / 20（4 任务 × Trial 1–5） |
| 能力通过 / 失败 / 未解决 / 基础设施失败 | 20 / 0 / 0 / 0（scripted Provider 均为 canonical 路径；**不代表真实模型能力**） |
| Goal 分母 | 20（20 passed） |
| Contract 分母 | 5（5 passed；15 个 `not_applicable` 排除） |
| Mechanism 分母 | 5（5 passed；15 个 `not_exercised` 排除） |
| 逻辑请求 / 物理请求 / 观测输出 Token | 55 / 0 / 0（scripted Provider 不发 HTTP；物理预算由 R4-B 计量测试与本演练的合成超限停止共同覆盖） |
| 失败分类演练 | Contract 失败、Goal+Mechanism 失败、基础设施失败不计能力分母，3/3 通过 |
| 重复运行拒绝 | 同 `(batch, task, trial)` 第二次运行被拒绝，未覆盖历史记录 |
| 预算停止 | 合成超限触发 `BUDGET_REQUESTS_EXHAUSTED`，无自动加预算路径 |
| 授权门 | `mayCallRealProvider=false`、`realProviderAuthorized=false` |
| 演练 drills 合计 | 6/6 通过 |

**限制：** scripted Provider 是确定性夹具；20/20 只证明调度、隔离、记录与分类机制，不是模型成功率。首产物延迟、真实 Usage/费用仍为 `unavailable`。

## 3. 回归结果

| 验证 | 结果 |
|---|---|
| R4-D0 单元（protocol/preflight） | 10 tests passed |
| Runner/Tools/Outcome 定向测试（3 文件） | 66 tests passed |
| R4-B 三维评测（`test:v2`） | 66 tests / 6 files passed |
| `pnpm run typecheck` | exit 0 |
| `pnpm run check:repo` | ok（35 passed / 3 advisory / 0 failed） |
| `pnpm run verify:full` | **`[gate] full passed`**，817.4 s；check:repo 4.3 s、tests 730.5 s、typecheck 0.9 s、build 81.0 s、recovery 0.8 s |

## 4. 真实试验授权清单（全部未完成）

- [ ] 用户明确指定 Provider 与 wire model；
- [ ] 用户批准 4 任务 × 5 trial（20 个计划真实试验）范围；
- [ ] 用户批准物理请求上限（协议默认每 trial 8 / 批次 160）与输出 Token 上限（每请求 2048 / 批次 40960）；
- [ ] 用户确认 **Provider 侧** USD/CNY 费用硬上限已实际配置，并提供币种与金额；本地请求/Token 限制不代替费用封顶；
- [ ] V2 真实模型执行适配器已实现并通过离线 dry-run（当前只有受控 scripted 路径）；
- [ ] R4-B/R4-C 本地提交取得托管 CI 证据，或用户明确豁免；
- [ ] 用户明确授权启动 R4-D1，并确认失败请求保留计数、不自动加预算。

## 5. 技术判断

- **可启动真实试验的技术条件：部分具备。** 任务/Oracle/指纹、trial 隔离、记录不可覆盖、三维度统计、预算停止与失败分类已冻结并演练通过。
- **阻塞项：** (1) 无真实授权；(2) Provider 侧费用硬上限未确认；(3) V2 真实模型 adapter 尚未接入（现有 `eval-v2` 仅受控 scripted）；(4) 本地 R4-B/C 提交尚无托管 CI 证据（`origin/main` 仍为 `c12fb52e`）。
- 因此当前结论为 **No-Go（付费试验）**；只有上述清单全部满足并由用户明确批准后，才可进入 R4-D1。R4-D0 到此停止，不推送 GitHub，不启动 D1。
