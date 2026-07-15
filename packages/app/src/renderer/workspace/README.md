# Renderer 拓展工作区

这里负责右侧拓展工作区的布局、标签、文件树、预览、终端、产物和工作区活动。

- `panel.tsx`、`add-menu.tsx`、`overview.tsx`：工作区壳和标签内容。
- `files.tsx`、`file-navigator.tsx`、`preview-pane.tsx`、`terminal.tsx`：文件与终端能力。
- `resize-interaction.ts`、`use-workspace-layout-controller.ts`：独立于左侧栏的布局、拖动、折叠和恢复。
- `activity.ts`、`path-utils.ts`、`directory-cache.ts`、`types.ts`：纯数据与路径边界。

文件读写、终端进程和产物索引必须通过 Local App API；从文件树打开文件要创建标签，重启恢复只使用用户数据中的受控快照。

## 软上限说明

以下文件位于 300-600 行区间，暂按单一交互事务保留：

- `terminal.tsx`：PTY 生命周期、SSE、尺寸同步和命令历史必须共同清理。
- `file-navigator.tsx`：目录缓存、筛选、展开路径和树行渲染共享同一导航状态。
- `preview-pane.tsx`：文件类型分派、编辑草稿、保存审批和预览错误共同组成一次文件打开事务。
- `files.tsx`、`panel.tsx`：分别只协调文件工作面和工作区标签壳。
- `use-workspace-layout-controller.ts`：统一拥有布局偏好、恢复镜像、标签/草稿持久化和拖动入口；两套长拖动算法已另行拆出。

这些文件不得吸收新的独立领域；达到 600 行前必须先补特征测试并再次拆分。
