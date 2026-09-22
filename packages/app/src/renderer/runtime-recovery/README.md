# Renderer 启动恢复
最后更新：2026-09-22 23:12:16

这里负责启动时的未完成任务发现、安静的恢复入口、现场查看、续跑和放弃；恢复的权威判定仍在 Runtime，本目录只做展示与请求编排。

- `use-checkpoint-recovery.ts`：启动发现、续跑流式订阅、停止、放弃和错误/忙碌状态；发现失败单独记录为 `discoveryFailed`，不与“没有待恢复任务”混同。
- `checkpoint-recovery-state.ts`：纯状态与文案。`checkpointRecoveryEntry` 把发现失败、正在恢复、待补充信息、待恢复任务和损坏记录收敛成一个安静入口，`checkpointRecoveryDiagnosticText` 统一不可读记录的说明。
- `checkpoint-recovery.tsx`：入口按钮与恢复对话框；诊断说明与重试在没有任何有效 checkpoint 时也必须可见。对话框使用共享模态层：进入焦点在“稍后处理”，Tab 约束在对话框内，关闭后焦点回到入口，Escape 只关闭当前层（等同“稍后处理”），绝不会放弃任务。
- `checkpoint-recovery-request.ts`：恢复请求的稳定身份，避免不确定传输后重复提交同一回合。

## 边界

- 启动发现失败时保持聊天可用，只显示安静入口并允许受控重试；不自动打开恢复弹窗，也不把失败显示成“没有待处理现场”。
- 重试只重新读取 checkpoint 列表，不重新执行已结算操作；可安全续跑的任务仍由启动 effect 静默续跑，结果归原会话。
- 只有 Runtime 返回的有效 checkpoint、诊断计数和续跑结果可以作为状态事实；本目录不推断磁盘内容，也不改写 Runtime 文案。

## 验证

`checkpoint-recovery-state.test.ts` 覆盖入口派生（发现失败、损坏记录、等待补充、待恢复、恢复中、完全干净）与文案；`checkpoint-recovery-request.test.ts` 覆盖恢复回合身份。真实窗口的发现失败与损坏记录场景仍需实机验收。
