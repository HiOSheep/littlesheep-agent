# Renderer 对话
最后更新：2026-09-23 14:02:49

这里负责消息、执行过程和渐进式披露的展示，以及把一次流式 run 的事件归并为 UI 状态。

- `types.ts`：消息、步骤、工具、转录行和执行活动的 Renderer 类型。
- `assistant-turn.tsx`、`agent-tool-row.tsx`、`activity-visibility.ts`：回答与可折叠执行过程、工具行渲染，以及执行活动的渐进披露规则。步骤标题与最终回答都经 `../Markdown`；单行活动标签由 `../inline-markdown` 的有界扫描器渲染，因此活动行不必等待解析器、也不把 Markdown 插件链拉进入口依赖图。
- `run-actions.ts`：一次流式 run 的 SSE 顺序、审批桥、停止、用户追加更新和最终收尾；`run-event-handlers.ts` 把流式工具事件归并为实时活动，`run-result-reducer.ts` 把已结束的 run 落到当前回合，`assistant-delta-buffer.ts` 按显示帧合并高频文本增量。
- `run-actions.ts` 的 `stop()` 对同一 run 只提交一次中断请求（重复点击直接被拒绝），本地流的 “正在停止” 展示由输入栏持有，run 结束即复位。
- `activity-model.ts`、`task-progress-indicator.tsx`、`message-meta.tsx`、`chat-scroll-anchor.ts`、`conversation-display.ts`：活动数据变换、进度控件、消息页脚、滚动锚定和显示密度。
- `activity-visibility.ts`：渐进披露规则。紧凑显示只折叠“无需关注”的已完成行；未成功的工具调用（含 Runtime 报告的权限拒绝）、失败或中止的准备行、失败的思考行、未通过的验证与失败步骤都必须继续可见（`compactTranscriptEntries` / `activityAttentionLine`），不得因为减少噪声而隐藏需要决定或修复的事实。
- `context-projections.ts`、`conversation-turn-fingerprint.ts`：上下文快照的有界无正文投影，以及跨文本、运行时、工作区和附件的稳定回合标识。

验证结论必须按 Runtime 记录呈现：`pass` 显示为“验证通过”，`unverified` 显示为“未验证”，不得渲染成“验证通过”。LLM、工具权限和执行状态的权威实现不放在 Renderer；新增事件必须先更新 shared contract 和特征测试。

`run-actions.ts` 为 336 行，略高于 300 行，因为一次 run 的 SSE 顺序、步骤/工具归并、审批、停止和最终收尾必须维持同一事务边界。后续只有在建立独立事件 reducer 特征测试后才继续拆分，当前不得继续增长。
