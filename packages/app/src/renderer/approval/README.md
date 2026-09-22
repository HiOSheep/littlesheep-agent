# Renderer 审批
最后更新：2026-09-22 12:41:58

这里仅负责审批提示的展示契约和 UI，不决定权限，也不绕过主进程的授权策略。

- `types.ts`：待审批提示的数据形状。
- `prompt.tsx`：审批、脏文件关闭和风险说明视图。
- `use-approval-controller.ts`：待审批提示的 UI 状态与会话级批准记录，草稿会话使用独立 scope；记录存储本身位于 `../approval-grants.ts`。

权限判断和实际执行归 `packages/safety`、Runner 和主进程所有；Renderer 的批准结果只是输入，Main 会在执行前重新计算范围。任何新按钮都必须明确动作、路径、风险和批准粒度。
