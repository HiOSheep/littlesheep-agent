# Renderer Runtime 就绪状态

本目录展示“现在能否执行任务，以及 Main 给出的原因”。窗口可以早于 Runner 显示；本目录不拥有调度或 readiness 真相。

## 契约

- `runtime-readiness-state.ts` 提供非 React 状态查询、订阅与有界等待；`use-runtime-readiness.ts` 将它投影给界面。没有 preload bridge 的非 Electron 环境不新增等待。
- `runtime-readiness-notice.tsx` 只展示失败原因和 Main 允许的重试入口。重试权限与次数由 Main 决定；Renderer 不重置 Runtime 状态。
- 正常启动阶段不在 Composer 中显示文字提示，也不显示整窗等待遮罩；发送按钮的可用状态仍由 Runtime 就绪状态决定。
- 就绪变化不清空草稿、改变会话或窃取焦点。当前会话和输入状态由其 owner 管理。
- 启动时间投影只在明确 opt-in 时产生，阶段名和有界 payload 由 shared readiness contract 校验；业务组件不扩展协议。

就绪状态、IPC 阶段名与 payload 在 `packages/app/src/shared` 定义。局部状态由同目录测试覆盖；慢启动／恢复使用 `verify:desktop-cold-start-interaction`，提示布局使用 `verify:desktop-readiness-placement`。
