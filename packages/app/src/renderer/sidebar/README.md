# Renderer 侧边栏

这里负责项目树、会话树、搜索、折叠、重命名、归档/删除菜单和侧边栏专属过渡。

- `quick-nav.tsx`、`project-section.tsx`、`session-row.tsx`：导航树。
- `session-actions.ts`、`project-actions.ts`：会话重命名及会话/项目生命周期动作；独立对话和项目对话复用同一重命名协议。
- `resize-interaction.ts`：两层阈值拖动和折叠动画。
- `global-titlebar.tsx`、`feature-panel.tsx`、`action-menu.tsx`：全局入口和浮层。

项目排序与会话更新时间排序必须保持各自语义；不可删除的一级节点和可归档子级的边界由主进程数据契约决定。
