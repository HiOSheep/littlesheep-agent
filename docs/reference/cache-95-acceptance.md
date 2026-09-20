# 缓存 95% 冻结负载验收规程

最后更新：2026-09-21 00:10:00

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

## 6. 完成条件

冻结负载两组总体命中率均 `>=95%` 且 usage 完整；总成本与每任务未缓存量不以保留冗余为代价；保留范围的任务验收（正确读取、写后读回、拒绝时零副作用、重启不重复执行、记忆可回溯、压缩后目标连续）通过。未达到时报告实际结果与剩余损失来源，不改小目标、不隐藏冷启动；"能力裁剪完成"与"95% 达成"分别标记。
