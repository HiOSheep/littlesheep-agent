# Harness 发布就绪与双路径对比记录 2026-09-11

记录日期：2026-09-11
最后更新：2026-09-11 12:15:00
结论：next Harness 的 durable 底座、恢复边界和灰度/回滚机制已具备当前证据；但发布门在结构上仍为 `blocked`，因此**保持双路径**，不把 next 设为默认。

这份记录只汇总当前工作树已经验证到的能力与仍然阻断的条目，供发布决定使用。它不把 `blocked`/`unavailable` 的条目写成完成，也不把本地夹具的命中率当成真实 Provider 证据。

## 1. 当前质量门证据

| 门 | 状态 | 证据 |
| --- | --- | --- |
| `check:repo` | passed | 33/33，28 个 project references |
| workspace typecheck | passed | `tsc -b tsconfig.workspace.json` |
| `verify:core` | passed | 3 executed / 3 skipped，13,308 ms，7 个文件 145 项 |
| `verify:full` | passed | 5 executed / 1 skipped，383,189 ms；全仓 434 个文件、2,993 项通过、1 项 skipped |
| App build | passed | `app-build-freshness` `ok`（electron 36.9.5） |
| recovery 源检查 | passed | 保留三条历史 warning：runtime workspace 缺失、3 个抽样 runId 缺执行日志、layout 非默认 roots |

## 2. 用户可见结算边界

- 每个用户可见回合只有一个 authoritative final settlement；未结算的 proposal 不会重放给 Renderer/CLI/渠道。
- `user-facing-reply` 契约有专门回归：注册表失败、空文案、缺 Provider provenance、重复超上限、重生成失败全部 fail closed，且不会写入 `reply`/`finalReplySettlement`——Runtime 不产出模板文案。
- 回复注册表支持跨重启去重、从完整 transcript 首次回填、并发只允许一次相同文案预约。
- `final-reply-identity` 有单测锁定：预约、FINALIZE 和 durable replay 对同一文案推出同一指纹与 settlementId。

## 3. 双路径成本/延迟/质量对比

`compareHarnessPaths`（`@littlesheep/harness`）把同一夹具在 `shadow`/`next`/`legacy`/`cutover` 下的 `CacheQualityReport` 归一成每条路径的：

请求数、prompt/completion/reasoning/cached token、Provider 命中率、P50/P95/max 延迟、received/failure 率、VERIFY passRate、release gate 状态，以及首尾两条路径的 delta。

缺证据语义：任何路径缺 usage、缺延迟或缺验证证据时，该指标保持 `undefined` 并进入 `incomplete`，delta 同样缺失，绝不补零或估算。Runner 侧已有端到端夹具：同一输入分别走 shadow/next，从真实 durable 投影与缓存观测生成两侧报告并对比。

## 4. 发布门状态

`buildCacheQualityReport` 的 `releaseGate` 只有 `blocked` 或 `unavailable` 两种取值，原因集合覆盖：

`no_observations`、`provider_usage_incomplete`、`context_cache_not_observed`、`memory_cache_not_observed`、`unexplained_cache_miss`、`latency_unavailable`、`cache_entries_unreadable`、`provider_token_totals_incomplete`、`quality_continuity_not_observed`、`verification_failures_present`，以及**无条件附加**的 `real_provider_reconciliation_not_verified`。

也就是说，只要没有真实 Provider 对账证据，状态在代码层面就无法变成 `ready`，本地夹具无法把它"刷绿"。这与任务书 CACHE-10 一致。

## 5. 灰度与回滚契约

- 灰度优先级：`session` > `origin` > `behavior profile` > 全局默认，四种覆盖都经 Local App API `GET/POST /runtime` 校验（非法值 400）。默认仍是 `shadow`。
- 回滚演练：同一 session 的 next → shadow → next 三回合验证回复无重复、第一回合 settlement 与 `run_completed` 保持完整、第三回合重新走 authoritative settlement。
- 运行中租约：有活动 run lease 时启动恢复不会接管该 run；单个 run 恢复失败只记录诊断，其它 run 仍按稳定顺序恢复，启动不中断。
- durable 事实：run/effect 两级 lease 的 acquire/reclaim/renew/release、真实子进程 `SIGKILL` 接管、inbox claim 过期重领、event store 跨进程并发 cursor 连续性、projection rebuild 与 live 相等、恢复中途崩溃的幂等补齐，均有真实文件或真实子进程夹具。

## 6. 仍未完成（阻断发布决定）

| 条目 | 状态 | 说明 |
| --- | --- | --- |
| 真实 Provider usage/成本对账 | 已完成（V4.1 精确计数已接线） | 2026-09-11：V4.1 framing、`deepseek-v4.1` tokenizer 资产（`dba1be0a…` / `c90dfa01…476b` / 6,367,257 字节）与 `deepseek-v41-provider-calibrated-tokenizer-v1` 已接入 `@littlesheep/context`；`@littlesheep/config` 把 `deepseek-flash`、`deepseek-v4-flash` 标为 `exact`。真实 Provider 工具矩阵（`pnpm run verify:deepseek-v4-tool-tokenizer -- --model=deepseek-flash`）**12/12 覆盖形状全部 0 误差**，另有 3 个 `history-only`（保留工具历史但去掉工具 schema）形状被显式判为不覆盖（实测差 1 个 token），因此不会给出接近但错误的计数。`deepseek-v4-pro` 在 2026-09-14 路由切换前仍走 V4 精确计数器 |
| 真实外部服务对账 | 已决策 A（已实现） | 2026-09-11 决定采用方案 A：工具用 `reconciliationKey` 申报一个有界、脱敏的恢复键，随 `effect_intent_created` 持久化并传入 `reconcileEffect`；机制、投影读取校验、Runner 透传和 `write` 工具接线均已完成并有测试，未声明键的工具保持保守 `unknown`。B（执行前写 tool-call 消息）已放弃，因为它会改变模型可见历史与缓存前缀 |
| 真实渠道重连 | 不适用（扩展范围） | 2026-09-11 决定：webhook/telegram/feishu/qqbot 属于可选拓展插件，不属于核心发布门；核心只在真实接入某个渠道时才验收该渠道 |
| 回答质量/成本对比（真实） | 进行中 | 报告能力与真实 Provider 凭证都已具备；计划用 `deepseek-flash` 跑固定任务集的 shadow/next 双路径对比，数字待写入本文档 |
| 资源成本（内存/磁盘） | unavailable | 有 runtime resource observation 机制，但没有形成可写入本记录的对比数字，故不声明 |

## 7. 真实双路径对比（2026-09-11）

### 7.1 扩大样本后的主结果（20 任务 × 2 轮）

方法同上，任务集扩到 20 个固定任务、每路径跑 2 轮。同 session 的 turn 一旦进入 `waiting_user` 就会阻塞后续 turn，因此脚本在遇到非 200 时**切换到新 session 继续**（shadow 用了 3 个 session，next 用了 2 个），最后按报告字段聚合（可加字段求和、比率按请求数加权、延迟取各 session 的 p95/max 最大值，缺字段保持 `undefined`）。

| 指标 | shadow（旧路径） | next（durable 路径） | 差值 (next − shadow) |
| --- | --- | --- | --- |
| 模型请求数 | 92 | 92 | 0 |
| prompt tokens | 169,893 | 172,726 | +2,833 (+1.7%) |
| completion tokens | 3,038 | 3,587 | +549 |
| cached prompt tokens | 90,112 | 85,376 | −4,736 |
| Provider 缓存命中率 | 52.8% | 49.2% | −3.6pp |
| 延迟 P50（各 session 中位数） | 724 ms | 792 ms | +68 ms |
| 延迟 P95（各 session 最大值） | 1,634 ms | 1,709 ms | +75 ms |
| received 率 / 失败率 | 1.0 / 0 | 1.0 / 0 | 0 |
| VERIFY passRate | 未观测（一侧 session 无验证记录） | 1.0 | 不可比 |
| release gate | blocked | blocked | — |

结论（按样本如实）：在请求数相同的条件下，next 的 prompt token 高约 1.7%、Provider 缓存命中率低约 3.6pp、延迟略高；失败率与 received 率两者相同且都为满分。**这组数字推翻了 6 任务小样本时"next 缓存更好"的印象**，说明小样本不足以支撑发布判断。VERIFY passRate 因 shadow 一侧缺验证记录而不可比，`reasoningTokens` 两侧都不完整，报告因此保留在 `incomplete`，没有补零。

### 7.2 首次实测（6 任务 × 1 轮，保留作对比）

方法：`scripts/verify-harness-path-comparison.mjs` 用隔离数据根各启动一次真实 Electron 应用，分别在 `durableHarnessMode: shadow` 与 `next` 下顺序执行同一组 6 个固定任务（同一个 session、`deepseek/deepseek-flash`、`reasoning: auto`），然后从生产路由 `GET /runtime/cache-quality` 取每条路径的报告，并用 `compareHarnessPaths` 归一比较。授权 scope 为 `permission=research`（应用的默认策略），shadow 记录 14 次模型请求、next 记录 16 次。

| 指标 | shadow（旧路径） | next（durable 路径） | 差值 (next − shadow) |
| --- | --- | --- | --- |
| 模型请求数 | 14 | 16 | +2 |
| prompt tokens | 24,884 | 33,390 | +8,506 |
| completion tokens | 521 | 499 | −22 |
| cached prompt tokens | 9,600 | 16,384 | +6,784 |
| Provider 缓存命中率 | 38.6% | 49.1% | +10.5pp |
| 延迟 P50 | 795 ms | 757 ms | −38 ms |
| 延迟 P95 | 1,425 ms | 1,397 ms | −28 ms |
| received 率 / 失败率 | 1.0 / 0 | 1.0 / 0 | 0 |
| VERIFY passRate | 1.0 | 1.0 | 0 |
| release gate | blocked | blocked | — |

读法（不夸大）：

- next 在这组任务上多发了 2 次请求、prompt token 总量高约 34%，但每请求 prompt 从 1,777 升到 2,087 的同时**缓存命中率更高**（+10.5pp），延迟略低；两条路径都没有失败、VERIFY 全过。
- 请求数不同，所以 token 总量不能直接当作"每条请求更贵"；需要看每请求均值或固定请求数夹具。
- 两条路径的 gate 都是 `blocked`，原因是报告无条件附加 `real_provider_reconciliation_not_verified`；这与本记录的保守发布门一致，不代表本次实测发现缺陷。
- 样本量很小（6 任务、每路径 1 个 session、1 次运行），`reasoningTokens` 因一侧缺失被记为 `incomplete` 而不是 0。要作为发布依据需要扩大任务集并重复运行。

## 8. 当前发布决定

2026-09-11 用户决定：**暂不发布**，先把前面的工作做完。因此继续双路径，默认 `shadow`；需要试用 next 时按 session / origin / profile 显式覆盖。

触发切默认的条件（更新后）：真实 Provider usage 对账在 V4.1 上重新校准通过、真实成本/质量对比结论可复现、`verify:full` 在切换树上重新通过。真实渠道重连不再是核心阻断项（拓展插件范围）；effect 对账方向已定为 A 并已实现。

回退方式：任何模式下出现 P0 安全、数据丢失、重复副作用、重复最终回复或缓存跨域泄露，立即把覆盖撤回全局 `shadow`；有 intent 无 settlement 的 run 进入 `unknown` 并请求用户决定，不用旧路径盲重做。
