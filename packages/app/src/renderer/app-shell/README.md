# Renderer 应用壳
最后更新：2026-09-22 23:39:50

这里负责把各 Renderer 领域组合成一个应用界面，不拥有会话、记忆、项目或工作区的权威数据。

- `app-view.tsx`：装配 `sidebar-view.tsx`、`core-workspace-view.tsx` 和 `overlays-view.tsx`；`chat-view.tsx` 承载消息列表、滚动锚定和跟踪卡，`composer-view.tsx`、`conversation-section-view.tsx`、`workspace-dock-view.tsx`、`sidebar-resizer-view.tsx` 是各区段的稳定表面。
- `composer-view.tsx`：输入栏表面。Enter 走 `ui/enter-confirm.ts` 的共享规则；运行中同时保留停止入口（请求发出后显示“正在停止当前任务”，直到 run 结束才复位）和草稿存在时的补充发送入口，两者不互相替换。停止的“一次请求”约束仍由 `chat/run-actions.ts` 持有。模型选择器在无可用模型时把 `openSettingsPage('api')` 与 `refreshRuntime` 交给 `RuntimePicker`，只做路由切换，不清空当前文字与附件；从设置返回后由既有的 `settingsOpen` 变化 effect 重新读取 Runtime。
- `use-app-controller.ts`：兼容控制器，协调领域动作；`use-app-view-controller.ts` 经 `app-controller-projections.ts` 投影出视图契约。
- `runtime-actions.ts`、`attachment-actions.ts`、`link-navigation-actions.ts`、`session-permission-mode.ts`：运行时刷新与模型补丁、附件与拖放、内外链接策略、按会话解析权限模式。`applyRuntimePatch` 保持布尔结果；`applyRuntimePatchReporting` 走同一事务但把失败文本返回给调用方，供设置页在原地显示失败并重试。
- `use-navigation-controller.ts`、`navigation.ts`、`types.ts`：有界的前进/后退历史、设置转场和全局路由。
- `persistent-state.ts`、`use-app-persistence.ts`：版本化恢复快照与有界写入节流；瞬态 UI 和授权只留在内存。
- `preferences.ts`、`list-motion.ts`：Renderer 偏好和列表过渡的纯客户端辅助；工作区文件导航折叠状态与审阅 Monaco 单列/双列偏好使用独立 key，均为 best-effort 本地 UI 状态，不进入会话或任务恢复数据。

新增业务行为应进入对应领域控制器，不要继续扩大 `use-app-controller.ts`；修改导航时必须回归设置、拓展工作区、标签和重启恢复。

## 软上限说明

`use-app-controller.ts` 已到 656 行，超过 600 行硬上限，只能按仓库质量检查的受控登记保留，因为它仍负责装配各领域状态、启动恢复 effect 和视图快照。进一步拆分必须等 Runtime/附件 effect 的输入输出稳定；在此之前禁止把新的领域行为写回该文件，并禁止继续增长。
