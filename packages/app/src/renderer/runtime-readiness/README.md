# Renderer 运行就绪

最后更新：2026-09-23 16:31:13

窗口在 Runner 存在之前就已经可见，本目录只回答一个问题：现在能不能执行任务，如果不能，Main 报告的原因是什么。它不是进度条，也不拥有任何调度能力。

## 边界

- `runtime-readiness-state.ts`：非 React 的就绪事实与订阅（`currentRuntimeReadiness` / `subscribeRuntimeReadiness` / `isExecutionReady`），以及 `waitForExecutionReady(timeoutMs)`：给"必须有 Runner 才能做"的调用者用（例如加载某段对话的历史），先查一次 bridge（缓存是异步填充的，否则首次调用会误判为未知），再进行等待；已就绪/已失败立即返回，就绪**未知**（无 bridge，如单测或非 Electron 宿主）也立即返回，不新增阻塞。先订阅再补读，保证挂载前发生的状态变化不会丢失。启动恢复等非视图消费者订阅它，避免把就绪沿组件属性链传递。
- `use-runtime-readiness.ts`：React 视图，返回 `{ readiness, executable, reason }`，`executable` 只在 `state === 'ready'` 时为真。
- `runtime-readiness-notice.tsx`：未就绪时在标题栏下方显示一行真实状态，失败态改为 `role="assertive"`。没有百分比、没有预计时间、没有固定等待文案。
- `renderer-timing.ts`：仅在 `LITTLESHEEP_BOOTSTRAP_TIMING=1` 下有产出的启动计时标（`renderer-first-mount`、`renderer-first-frame`）。真实首帧由渲染器自己上报：调试器在导航后附加时 Chromium 的 paint 条目可能已被回收，实测第一版基线因此拿不到 FCP。载荷只含白名单阶段名与有界毫秒数。
- 载荷类型与校验来自 `../../shared/runtime-readiness-contracts.ts`，通道名与阶段白名单来自 `../../shared/runtime-readiness-ipc.ts`；本目录不新增协议。
- 输入草稿、焦点和当前会话不归本目录管理：就绪变化不得清空输入或切换会话，能力启用是原地发生的事件。

## 验证

- 修改后运行 `pnpm.cmd --filter @littlesheep/app run typecheck` 与 App 测试。
- 真实窗口下验证：慢初始化期间可连续输入、草稿保留；在未就绪窗口里打开另一段对话不产生错误横幅（`pnpm run verify:desktop-cold-start-interaction` 覆盖）；失败态显示 Runtime 给出的原因而不是通用错误页。
- 五指标计时与逐次原始样本见 `docs/reference/cold-start-baseline/`。
