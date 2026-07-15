# Renderer 对话

这里负责消息、执行过程和渐进式披露的展示，以及把一次流式 run 的事件归并为 UI 状态。

- `types.ts`：消息、步骤、工具和执行活动的 Renderer 类型。
- `assistant-turn.tsx`：回答与可折叠执行过程。
- `run-actions.ts`：SSE 事件、审批回调、停止和最终消息归并。
- `activity-model.ts`、`task-progress-indicator.tsx`：活动数据变换和进度控件。

LLM、工具权限和执行状态的权威实现不放在 Renderer；新增事件必须先更新 shared contract 和特征测试。

`run-actions.ts` 略高于 300 行，因为一次 run 的 SSE 顺序、步骤/工具归并、审批、停止和最终收尾必须维持同一事务边界。后续只有在建立独立事件 reducer 特征测试后才继续拆分，当前不得继续增长。
