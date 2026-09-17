# Renderer 应用壳

这里负责把各 Renderer 领域组合成一个应用界面，不拥有会话、记忆、项目或工作区的权威数据。

- `app-view.tsx`、`core-workspace-view.tsx`、`sidebar-view.tsx` 和 `overlays-view.tsx`：顶层视图组合。
- `use-app-controller.ts`：兼容控制器，协调领域动作并向视图提供运行时快照。
- `use-navigation-controller.ts`：有界的前进/后退历史、设置转场和全局路由。
- `preferences.ts`、`list-motion.ts`：Renderer 偏好和列表过渡的纯客户端辅助；工作区文件导航折叠状态与审阅 Monaco 单列/双列偏好使用独立 key，均为 best-effort 本地 UI 状态，不进入会话或任务恢复数据。

新增业务行为应进入对应领域控制器，不要继续扩大 `use-app-controller.ts`；修改导航时必须回归设置、拓展工作区、标签和重启恢复。

## 软上限说明

`use-app-controller.ts` 暂时保留 300-600 行兼容协调代码，因为它只负责装配各领域状态、启动恢复 effect 和公开视图所需快照。进一步拆分必须等 Runtime/附件 effect 的输入输出稳定；在此之前禁止把新的领域行为写回该文件，并由仓库质量检查锁定当前上限。
