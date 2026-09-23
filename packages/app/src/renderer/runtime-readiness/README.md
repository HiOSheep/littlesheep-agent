# Renderer 运行就绪

最后更新：2026-09-23 10:20:43

窗口在 Runner 存在之前就已经可见，本目录只回答一个问题：现在能不能执行任务，如果不能，Main 报告的原因是什么。它不是进度条，也不拥有任何调度能力。

## 边界

- `use-runtime-readiness.ts`：先订阅 `window.littlesheep.onRuntimeReadiness`，再查询 `getRuntimeReadiness()` 补读，保证挂载前发生的状态变化不会丢失；卸载时退订。返回 `{ readiness, executable, reason }`，`executable` 只在 `state === 'ready'` 时为真。
- `runtime-readiness-notice.tsx`：未就绪时在标题栏下方显示一行真实状态，失败态改为 `role="assertive"`。没有百分比、没有预计时间、没有固定等待文案。
- 载荷类型与校验来自 `../../shared/runtime-readiness-contracts.ts`，通道名来自 `../../shared/runtime-readiness-ipc.ts`；本目录不新增协议。
- 输入草稿、焦点和当前会话不归本目录管理：就绪变化不得清空输入或切换会话，能力启用是原地发生的事件。

## 验证

- 修改后运行 `pnpm.cmd --filter @littlesheep/app run typecheck` 与 App 测试。
- 真实窗口下验证：慢初始化期间可连续输入、草稿保留；失败态显示 Runtime 给出的原因而不是通用错误页。
