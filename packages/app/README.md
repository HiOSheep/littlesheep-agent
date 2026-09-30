# @littlesheep/app

Electron 桌面应用组合包。Main 拥有应用服务与策略执行；preload 暴露受限桥接；Renderer 负责界面；shared 定义跨进程契约。本包组合 Runner 与可选渠道适配器。

## 入口与所有权

- Main：`src/main/index.ts`，拥有 Local App API、窗口、数据根、权限、文件访问与 Runner 生命周期。见 [Main](src/main/README.md) 与 [Local App API](src/main/local-app-api/README.md)。
- Preload：`src/preload/index.ts`，只暴露白名单 IPC 能力。见 [Preload](src/preload/README.md)。
- Renderer：`src/renderer/main.tsx`，拥有临时界面状态，不拥有用户数据或工具权限。见 [Renderer](src/renderer/README.md)。
- 跨进程类型与路由契约：`src/shared`。见 [shared 契约](src/shared/README.md)。

应用数据根与用户选定的工作区是不同边界。Main 在执行时重新判定路径和授权；当前容器只是逻辑路径闸门，不是操作系统进程沙箱。用户交互终端不属于 Agent 执行。

## 开发与验证

- 开发：`pnpm run dev`；准备 Electron 构建：`pnpm run ensure:app-build`，保持输入与产物 fingerprint 一致。
- 类型：`pnpm --filter @littlesheep/app run typecheck`；定向测试：`pnpm exec vitest run packages/app`。
- 窗口、恢复、权限、工作区与发布包行为须运行对应的 `verify:*`，入口见 [脚本索引](../../scripts/README.md)。Renderer 单测不能证明真实 Electron 或发布包行为。

界面沿用圆润半透明的视觉语言；共享 token 与行为契约见 Renderer 文档。

外观偏好由 Renderer 本地持久化并在首帧应用；Main 只接收窄化的明暗事实，用于原生标题栏符号与不透明启动表面的对比同步。该桥接契约位于 `src/shared/window-appearance-contracts.ts`。
