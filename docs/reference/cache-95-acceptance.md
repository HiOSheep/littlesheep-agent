# 缓存 95% 冻结负载验收规程

最后更新：2026-09-21 07:05:00

本文件把 `docs/taskbooks/lean-v2-cache-95-plan-2026-09-20.md` 第 6 节的实测步骤写成可重复执行的规程，供最终验收直接照做。它是验收方法，不是达成声明：在两组冻结负载都跑出完整 usage 之前，95% 一律标记为未验证。

## 1. 冻结什么

一次有效的对比要求两组运行使用完全相同的下列输入，任何一项不同即作废重跑：

| 项 | 冻结值 | 出处 |
| --- | --- | --- |
| 任务集 | 脚本内 `TASKS` 列表（20 条短对话任务） | `scripts/verify-harness-path-comparison.mjs` |
| 模型 | 正式对比用配置中的当前 Provider 模型；离线自检用 `acceptance/slow-a` | 同上（`OFFLINE` 分支） |
| 轮数 | `LITTLESHEEP_COMPARISON_ROUNDS`（默认正式 2、离线 1） | 同上 |
| 会话组织 | `LITTLESHEEP_COMPARISON_SHARED_SESSION=1` 时同一会话连续多轮；`LITTLESHEEP_COMPARISON_UNIQUE_TURNS=1` 区分重复轮 | 同上 |
| 压缩阈值 | 默认配置；若本轮覆盖压缩场景则 `LITTLESHEEP_COMPARISON_COMPACTION=1` | 同上 |
| 数据根 | 每次运行使用隔离数据根，用户数据不受影响 | 同上 |

## 2. 两组对比怎么跑

1. 在 `ff59df5`（本方案动工前的旧实现）上创建工作树，用同一把 `DEEPSEEK_API_KEY`、同一任务集、同一模型、同一轮数与会话组织跑一次负载，保留隔离数据根。
2. 在 `main`（新实现）上用完全相同的参数跑一次。
3. 对两个数据根分别执行 `node scripts/audit-cache-usage.mjs <dataDir>`（或 `--latest`），保存脱敏汇总；需要机器可读结果时加 `--json`。
4. 报告顺序：先按场景（普通短对话、连续工具工作、冷启动、压缩、重启）分别报告，再报告包含全部场景与辅助调用的总体值；热缓存子集不能当作总体达标。

## 3. 测量规则

- 命中率：`hit = sum(cached_input_tokens) / sum(input_tokens)`，不取每请求百分比平均。
- 所有模型用途进入总账：路由、规划、主循环、压缩、重试、取消与失败调用都不排除。
- 未知 usage 明确计数（`requestsWithoutInputOrCachedUsage`、`runsWithIncompleteUsage` 等），并使 `target.conclusion` 变为 `unavailable (incomplete usage)`；**不按零补齐**。
- 按 provider/model 分组后同时报告总体，不能用一组覆盖另一组。
- 同时报告每任务未缓存输入、总输入/输出、请求数、时延、首个工具动作或用户可见输出时间、语义成功率与失败/中断情况；无法测到的动作时间标记 `unavailable`。
- 费用只在有对应价格依据时计算，不从命中率推导。

## 4. 不允许的做法

不得通过填充上下文、重复请求预热、排除失败或辅助调用、延长会话或只统计热缓存子集来凑到 95%。删除冗余后若比例暂时下降，不恢复无必要能力。

## 5. 当前离线能力与缺口

- `node scripts/verify-harness-path-comparison.mjs --offline` 使用确定性验收 Provider，可验证消息前缀稳定、工具配对、缺失 usage 处理、审批拒绝、同一发布防重、取消与副作用恢复；它**不能**证明供应商真实命中率。
- 真实对比的唯一缺口是凭据：需要 `DEEPSEEK_API_KEY` 环境变量。密钥不得写入仓库、日志或本文档。
- 脱敏历史样本与基线位于 `docs/taskbooks/lean-v2-cache-95-audit-baseline-2026-09-20.json`，只作诊断参照，不替代冻结负载重跑。

### 5.1 离线彩排记录（2026-09-21）

已按本规程跑通一次 `--offline` 彩排，用于确认流程本身可用，并固定"无法测得命中率时必须如实标注"的行为：

- 前置：`pnpm run build:app` 重建打包产物（脚本会拒绝在 App 产物过期时开跑）；旧实现工作树（`git worktree add <path> ff59df5`，detached HEAD）已创建，正式对比时直接复用。
- 结果：脚本退出码 0，两侧各 4 个 run 全部 `status: 200`；`comparison.deltas` 中 `requestCount`/`promptTokens`/`completionTokens` 均为 0，`latencyP95Ms` 为 -4ms，`verificationPassRate` 为 0。
- **关键行为**：确定性 Provider 不报告 `cachedPromptTokens`，因此报告的 `incomplete` 明确列出 `reasoningTokens`、`cachedPromptTokens`、`cacheHitRatio`，两侧 `stageCacheSplit.main.hitRatio` 显示 0 且 `releaseGate.status` 为 `blocked`。这正是测量规则要求的"未知 usage 明确计数并使完整达标结论不可用"，**不得**把这个 0 当作真实命中率，也不得据此宣称或否定 95%。

### 5.2 真实 Provider 实测结果（2026-09-21，未达标）

在真实 DeepSeek Provider 下按本规程跑了两组冻结负载对比（`deepseek/deepseek-flash`，2 轮 × 20 任务，每条路径 40 个 run，全部 `status: 200`）：

| 路径 | 输入 tokens | 缓存命中 tokens | 命中率 | 每次调用未缓存 |
| --- | --- | --- | --- | --- |
| 旧实现（`ff59df5`） | 220,938 | 208,000 | 94.144% | 323.4 |
| 新实现 | 220,376 | 207,360 | **94.094%** | 325.4 |

- **结论：两组均低于 95%，目标未达成**。新实现比旧实现低约 0.05 个百分点；`promptTokens` 少 562、`completionTokens` 少 52、`latencyP95Ms` 低 169ms。
- **损失来源已逐请求定位（2026-09-21 复核，更正上一版结论）**：对保留数据根（`--keep-data`，20 个请求）逐条读取 `cache-observations` 后，未缓存量**不是**均匀分布的尾部，而是由**每个会话首个请求的冷启动**主导：
  - 暖请求（19 条）：`101,760 / 105,699 = 96.273%`，**已高于 95%**；单条命中率区间 93.9%–97.6%。
  - 冷启动（1 条）：`256 / 5,137 = 4.983%`，即 4,881 tokens 全部未命中。
  - 冷启动单独把总体从 96.27% 拖到 `102,016 / 110,836 = 92.04%`，**拉低 4.23 个百分点**。
  - 这解释了 2 轮运行下的 94.09%：冷启动固定 1 次/会话，摊到 40 个请求后拖累减半。
- 旧实现同样承担这次冷启动（`4,879` tokens 未命中，首条命中率同为 5.0%），因此两条路径的总体差仅约 0.05 个百分点。
- `prefixChangeReasons` 为空，`invalidationReasons` 仅 `prompt_version_changed`（未造成失效），即**不存在跨请求前缀抖动**。
- 冷启动成本与「前缀大小」成正比：该请求付费的正是稳定的 system prompt + 工具 schema（14,849 字节）。因此缩短前缀能直接提高总体命中率；本轮的工具 schema 门控已把冻结负载任务实际广播的工具从 10 个（5,843 字节）降到 6 个（2,113 字节），即冷启动少付约 3,730 字节（约 933 tokens）。
- `incomplete` 只剩 `reasoningTokens`（Provider 未报告）；`cachedPromptTokens` 与 `cacheHitRatio` 均为真实数值。
- **不得隐藏冷启动**：若只报暖请求的 96.27%，就是方案第 1 节明令禁止的"只统计热缓存子集"。完成条件按含冷启动的总体判定。

## 6. 完成条件

冻结负载两组总体命中率均 `>=95%` 且 usage 完整；总成本与每任务未缓存量不以保留冗余为代价；保留范围的任务验收（正确读取、写后读回、拒绝时零副作用、重启不重复执行、记忆可回溯、压缩后目标连续）通过。未达到时报告实际结果与剩余损失来源，不改小目标、不隐藏冷启动；"能力裁剪完成"与"95% 达成"分别标记。

**当前状态标记：能力裁剪已完成（P0–P4）；95% 未达成（实测 94.09%）。**
