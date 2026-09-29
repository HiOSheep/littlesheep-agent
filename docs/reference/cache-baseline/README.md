# 缓存基线数据

此目录保存缓存验收使用的真实 Provider 账本及结构探针输出。正式判定口径和不得采用的做法见[缓存验收规程](../cache-95-acceptance.md)；运行时现状见[项目状态](../../decision/project-status.md)。

## 自动验收输入

- `long-interval-task-L1-2026-09-22.json`：长任务与 45 分钟空闲续接的 Provider 账本。
- `real-long-task-baseline-pinned-interval-2026-09-22.json`：冻结任务清单的真实 Provider 回归账本。

`pnpm run check:cache-acceptance` 默认读取以上两份 JSON。它们的原始节点和请求汇总是机器验收输入；不要用展示用 Markdown 替代或删去。

## 结构探针

[`latest.md`](latest.md) 由 Harness 探针生成，记录请求字符数、字面共享前缀、稳定头和工具目录摘要。探针不调用 Provider，因此不证明 token 数、缓存命中率、成本或性能。它只用于理解请求形状；长任务实际命中由上面的 Provider 账本和缓存验收规程判定。

其余 JSON 是诊断或较早批次记录；默认门只读取上面列出的两个账本，显式输入目录的规则见验收规程。逐次 Markdown 渲染和过期的 pre-fix 对比正文已退役，Git 历史可恢复。
