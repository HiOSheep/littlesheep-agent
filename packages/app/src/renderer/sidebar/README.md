# Renderer 侧边栏
最后更新：2026-09-22 22:00:01

这里负责项目树、会话树、搜索、折叠、重命名、归档/删除菜单和侧边栏专属过渡。

- `quick-nav.tsx`、`project-section.tsx`、`session-row.tsx`、`project-creator.tsx`、`types.ts`：导航树、行渲染和项目创建；项目名输入框的 Enter 提交与主输入框共用 `ui/enter-confirm.ts`，组词确认候选不会创建文件夹。
- `session-actions.ts`：会话重命名、置顶、归档、删除、切换与历史加载，并清理会话级审批记录；`project-actions.ts`：项目生命周期、项目内对话和工作区路径重绑定；独立对话和项目对话复用同一重命名协议。
- `list-drag.ts`、`resize-interaction.ts`：列表拖动排序、两层阈值拖动和折叠动画。
- `global-titlebar.tsx`、`feature-panel.tsx`、`action-menu.tsx`：全局入口和浮层。

项目排序与会话更新时间排序必须保持各自语义；不可删除的一级节点和可归档子级的边界由主进程数据契约决定。
