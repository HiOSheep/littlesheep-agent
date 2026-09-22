# Renderer 应用壳
最后更新：2026-09-22 12:41:58

这里负责把各 Renderer 领域组合成一个应用界面，不拥有会话、记忆、项目或工作区的权威数据。

- `app-view.tsx`：装配 `sidebar-view.tsx`、`core-workspace-view.tsx` 和 `overlays-view.tsx`；`chat-view.tsx` 承载消息列表、滚动锚定和跟踪卡，`composer-view.tsx`、`conversation-section-view.tsx`、`workspace-dock-view.tsx`、`sidebar-resizer-view.tsx` 是各区段的稳定表面。
- `use-app-controller.ts`：兼容控制器，协调领域动作；`use-app-view-controller.ts` 经 `app-controller-projections.ts` 投影出视图契约。
- `runtime-actions.ts`、`attachment-actions.ts`、`link-navigation-actions.ts`、`session-permission-mode.ts`：运行时刷新与模型补丁、附件与拖放、内外链接策略、按会话解析权限模式。
- `use-navigation-controller.ts`、`navigation.ts`、`types.ts`：有界的前进/后退历史、设置转场和全局路由。
- `persistent-state.ts`、`use-app-persistence.ts`：版本化恢复快照与有界写入节流；瞬态 UI 和授权只留在内存。
- `preferences.ts`、`list-motion.ts`：Renderer 偏好和列表过渡的纯客户端辅助；工作区文件导航折叠状态与审阅 Monaco 单列/双列偏好使用独立 key，均为 best-effort 本地 UI 状态，不进入会话或任务恢复数据。

新增业务行为应进入对应领域控制器，不要继续扩大 `use-app-controller.ts`；修改导航时必须回归设置、拓展工作区、标签和重启恢复。

## 软上限说明

`use-app-controller.ts` 已到 656 行，超过 600 行硬上限，只能按仓库质量检查的受控登记保留，因为它仍负责装配各领域状态、启动恢复 effect 和视图快照。进一步拆分必须等 Runtime/附件 effect 的输入输出稳定；在此之前禁止把新的领域行为写回该文件，并禁止继续增长。
