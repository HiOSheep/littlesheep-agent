# Renderer 侧边栏
最后更新：2026-09-26 22:00:24

这里负责项目树、会话树、搜索、折叠、重命名、归档/删除菜单和侧边栏专属过渡。

- `quick-nav.tsx`、`project-section.tsx`、`session-row.tsx`、`project-creator.tsx`、`types.ts`：导航树、行渲染和项目创建；项目名输入框的 Enter 提交与主输入框共用 `ui/enter-confirm.ts`，组词确认候选不会创建文件夹。
- `session-actions.ts`：会话重命名、置顶、归档、删除、切换与历史加载，并清理会话级审批记录；`project-actions.ts`：项目生命周期、项目内对话和工作区路径重绑定；独立对话和项目对话复用同一重命名协议。列表只读索引，不预取未选中会话的消息。选中时先等执行就绪再取历史；切走后已启动的读取继续完成并保存在最多 6 个会话的内存缓存中，回来时复用，消息更新、强制刷新或删除时失效。手动切换会话会进入对话；启动恢复上次会话只加载历史和工作区，不覆盖持久化路由。切换会话只更新该视图和发送请求的有效工作区，不为会话选择改写全局默认工作区、重建 Runner。切回独立会话或打开新会话时恢复默认工作区；新会话直接打开空对话，不等待旧会话历史。
- `list-drag.ts`、`resize-interaction.ts`：列表拖动排序、两层阈值拖动和折叠动画。
- `global-titlebar.tsx`、`feature-panel.tsx`、`action-menu.tsx`：全局入口和浮层。

项目排序与会话更新时间排序必须保持各自语义；不可删除的一级节点和可归档子级的边界由主进程数据契约决定。

**会话行有三个快捷控件**（2026-09-26）：置顶、归档、以及"…"多功能菜单，按这个顺序排在行尾；归档从菜单里提出来做成一键按钮，是因为它是和置顶同一类的日常整理动作，走菜单要多两次点击却不产生任何决定（菜单里的"归档对话"仍然保留）。三个控件都用共享的 `.sidebar-section-action` 角色，`.session-row-actions` 的预留宽度相应改成三个控件的宽度（`(size * 3) + (gap * 2)` = 84px，标题栏因此少 29px）。真实窗口实测：控件顺序为 `session-pin-action` → `session-archive-action`（`aria-label="归档对话"`）→ `.sidebar-action-menu`，标题右边界 162px、控件区左边界 166px（不重叠），点击归档后该会话从列表消失。
侧边栏的玻璃材质里带一层**从上到下的淡蓝→淡紫晕色**（`--sidebar-tint-top` / `--sidebar-tint-bottom`，2026-09-26）：它只加在 `.sidebar-surface::before` 上，是共享填充之上的一层 `background-image` 线性渐变，所以右侧工作区面板保持无染色玻璃，两者继续共用同一条材质规则；不要把它并进 `--sidebar-glass-fill`，也不要给 `.sidebar-surface` 本体加 `background-image`（`chat-layout-stability.test.ts` 锁住"表面本体透明、材质在 `::before`"）。两个 alpha 都压在 0.2 以下：真机实测（1280×860、DPR 1.5，取侧边栏上/中/下三带像素均值）为顶部 `rgb(50, 58, 74)`、中部 `rgb(41, 42, 65)`、底部 `rgb(47, 39, 67)`，通道关系由"蓝>绿>红"过渡到"蓝>红>绿"；文字仍是 `--text` 落在深色底上，对比度远高于 AA。要更强或更弱只调这两个令牌。
