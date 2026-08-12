# Renderer 拓展工作区

这里负责右侧拓展工作区的布局、标签、文件树、预览、终端、产物和工作区活动。

- `panel.tsx`、`add-menu.tsx`、`overview.tsx`：工作区壳和标签内容。
- `files.tsx`、`file-navigator.tsx`、`preview-pane.tsx`、`terminal.tsx`、`browser.tsx`：文件、终端和内置浏览器能力。
- `monaco-language-support.ts`、`monaco-theme.ts`：Monaco 的补充语言注册和 LS 中性黑灰高对比主题；主题底色、加载占位和状态栏必须保持一致且不引入蓝色背景偏向，普通代码、注释、行号和主要语法色不得退化为低对比或低饱和灰色。
- `tab-strip.tsx`：拓展工作区标签条；`use-browser-controller.ts`、`browser-persistence.ts` 和 `browser-tabs.ts`：浏览器标签状态、恢复元数据和有界导航历史。
- `resize-interaction.ts`、`use-workspace-layout-controller.ts`：独立于左侧栏的布局、拖动、折叠和恢复。
- `activity.ts`、`path-utils.ts`、`directory-cache.ts`、`types.ts`：纯数据与路径边界。

文件读写、终端进程和产物索引必须通过 Local App API；从文件树打开文件要创建标签，重启恢复只使用用户数据中的受控快照。

关闭当前标签时激活最近的剩余标签；关闭最后一个标签不会折叠面板，而是显示审查、产物、终端、空白浏览器和侧边聊天快捷启动空态。面板折叠后同时保留对话区右上角固定入口和右侧全高悬浮感应入口，二者共享同一折叠状态与过渡。

浏览器的前进、后退和刷新只作用于 `browser-history.ts` 管理的独立 URL 栈，最多保留 50 条 URL，不进入全局应用导航快照。网页内部链接和新窗口请求留在 LS 的 `webview` 中；地址加载、重定向、刷新和历史移动都会在导航事件完成后清理挂起状态，避免重复加载或重复写入历史。切换标签后 webview 可以重建，因此工具栏以后端的逻辑 URL 栈为准，不直接依赖 Chromium 的原生历史栈。网页绘制由 Chromium 当前显示器 VSync 调度，刷新率是有效帧率上限；静态页面不由 LS 发起持续重绘。窗口最小化时保留 webview 实例并依赖 Chromium 后台节流，避免恢复时丢失页面状态；只有用户主动折叠拓展工作区时才卸载当前视图。

文件预览按资源上限执行：代码、文本和 Markdown 进入 Monaco；Office/OpenDocument 只读提取正文或表格/幻灯片文本，主进程先检查文件大小，再限制 ZIP 条目数量和 XML 展开规模。完整排版、编辑和旧式二进制 Office 兼容不属于当前预览契约。

## 软上限说明

以下文件位于 300-600 行区间，暂按单一交互事务保留：

- `terminal.tsx`：PTY 生命周期、SSE、尺寸同步和命令历史必须共同清理。
- `terminal-fit.ts`：合并同一显示帧内的尺寸通知，并忽略尺寸未变化的 `ResizeObserver` 回调。
- `file-navigator.tsx`：目录缓存、筛选、展开路径和树行渲染共享同一导航状态。
- `preview-pane.tsx`：文件类型分派、编辑草稿、保存审批和预览错误共同组成一次文件打开事务。
- `files.tsx`、`panel.tsx`：分别只协调文件工作面和工作区标签壳。
- `use-workspace-layout-controller.ts`：统一拥有布局偏好、恢复镜像、标签/草稿持久化和拖动入口；两套长拖动算法已另行拆出。

这些文件不得吸收新的独立领域；达到 600 行前必须先补特征测试并再次拆分。
