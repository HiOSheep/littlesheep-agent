# Renderer 拓展工作区

这里负责右侧拓展工作区的布局、标签、文件树、预览、终端、产物和 Git 审阅。

- `panel.tsx`、`add-menu.tsx`：工作区壳和标签内容。审阅不再装配第二个“现场”子页；Runtime 的任务恢复现场仍由 `runtime-recovery/` 独立负责。
- `navigator-frame.tsx`、`file-navigator.tsx`、`review-tree.tsx`：普通目录树与 Git 稀疏更改树共用同一个右侧导航外壳、折叠轨、工具栏高度、筛选框、树行缩进和选中/hover 契约；两种导航的数据源、缓存和刷新请求保持隔离，Git 刷新不会触发完整目录扫描。
- `directory-cache.ts`、`directory-preload.ts`、`preview-pane.tsx`、`terminal.tsx`、`browser.tsx`：文件、终端和内置浏览器能力；目录快照由有界的跨挂载 stale-while-revalidate 缓存统一拥有，同一路径的并发刷新必须合并，折叠或切换后先显示旧树再后台校准。`main.tsx` 只会在已持久化的工作区面板可见、文件导航展开且当前标签确实需要普通文件导航时，预热同一个根目录 in-flight 请求；审阅页、折叠面板和折叠导航不触发普通目录扫描，组件挂载后复用该请求。
- `code-editor.tsx`、`monaco-model-cache.ts`：工作区唯一的 Monaco 懒加载、主题、默认配置和模型生命周期基元；普通代码查看、编辑与 Git 审阅必须复用它，不得各自打包或初始化第二套编辑器运行时。运行时只加载 `editor.api` 核心，当前文件的 Monarch tokenizer 在模型创建前按语言惰性准备，不打包 TypeScript/JSON/CSS/HTML 语言服务 worker；模型和视图状态按最多 40 条/20 MiB 有界，活动编辑器模型不强制淘汰，离开后才按 LRU 收敛。代码区统一使用 `13px` 字号和 `23px` 行高，约比旧密度增加 30%；Markdown、Office 和图片预览不继承这组代码参数。
- `review.tsx`、`review-cache.ts`、`review-diff.tsx`、`review-diff-model.ts`：Git 变更快照、有界快照/Diff 缓存、分层审阅和 Monaco 差异模型；审阅保留 staged/unstaged/untracked 语义，主区域与普通文件查看同为编辑器表面，右侧为 Git 更改导航。重挂载先恢复同一快照版本的树与 Diff，再后台校准；Diff 缓存同时受条目数和估算字节预算约束。Main 快照返回 opaque revision，文件 Diff 必须绑定该 revision，旧版本返回 409 后由 Renderer 自动刷新；快速切换会取消无人等待的旧请求。审阅文件支持临时路径/状态过滤以及筛选框中的上下键和 Enter 导航，过滤条件不持久化；标题行图标按钮显式切换 Monaco 单列/双列，偏好由 `WORKSPACE_REVIEW_SIDE_BY_SIDE_KEY` 持久化。
- `file-preview-cache.ts`、`bounded-byte-lru.ts`：普通文件预览跨标签挂载共享，按 TTL、条目数和估算字节数有界；缓存命中先恢复旧正文，后台读取只在同一请求代次仍有效时覆盖，保存结果会优先于较早的读取响应。淘汰只作用于已完成数据，不保留无限增长的 Monaco 输入正文。
- `monaco-language-support.ts`、`monaco-language-loaders.ts`、`monaco-theme.ts`：Monaco 的 worker-free 语言着色注册、按需 tokenizer 映射和 LS 中性黑灰高对比主题；主题底色、加载占位和状态栏必须保持一致且不引入蓝色背景偏向，普通代码、审阅差异、注释、行号和主要语法色不得退化为低对比或低饱和灰色。生产构建只从 Monaco 官方基础语言模块保留 `conf`/`language` 词法定义，隔离其附带的完整编辑器贡献副作用，并硬拒绝语言 worker、建议记忆与代码动作服务回流，避免惰性语言加载增大产物或在已初始化的服务容器中产生未知服务错误；隔离 Electron 性能验收还会监听真实 Renderer 控制台并拒绝任何未知服务错误。
- `tab-strip.tsx`：拓展工作区标签条；`use-browser-controller.ts`、`browser-persistence.ts` 和 `browser-tabs.ts`：浏览器标签状态、恢复元数据和有界导航历史。
- `resize-interaction.ts`、`use-workspace-layout-controller.ts`：独立于左侧栏的布局、拖动、折叠和恢复。
- `path-utils.ts`、`types.ts`：纯数据与路径边界；`WorkspaceArtifactRef` 仍供聊天和产物入口使用，审阅活动聚合类型已删除。

文件读写、终端进程和产物索引必须通过 Local App API；从文件树打开文件要创建标签，重启恢复只使用用户数据中的受控快照。

关闭当前标签时激活最近的剩余标签；关闭最后一个标签不会折叠面板，而是显示审查、产物、终端、空白浏览器和侧边聊天快捷启动空态。面板折叠后同时保留对话区右上角固定入口和右侧全高悬浮感应入口，二者共享同一折叠状态与过渡。

浏览器的前进、后退和刷新只作用于 `browser-history.ts` 管理的独立 URL 栈，最多保留 50 条 URL，不进入全局应用导航快照。网页内部链接和新窗口请求留在 LS 的 `webview` 中；地址加载、重定向、刷新和历史移动都会在导航事件完成后清理挂起状态，避免重复加载或重复写入历史。切换标签后 webview 可以重建，因此工具栏以后端的逻辑 URL 栈为准，不直接依赖 Chromium 的原生历史栈。网页绘制由 Chromium 当前显示器 VSync 调度，刷新率是有效帧率上限；静态页面不由 LS 发起持续重绘。窗口最小化时保留 webview 实例并依赖 Chromium 后台节流，避免恢复时丢失页面状态；只有用户主动折叠拓展工作区时才卸载当前视图。

文件预览按资源上限执行：代码和文本进入共享 Monaco；Markdown 与 Office/OpenDocument 保留独立于应用 UI 的预览字体，Office/OpenDocument 只读提取正文或表格/幻灯片文本，主进程先检查文件大小，再限制 ZIP 条目数量和 XML 展开规模。完整排版、编辑和旧式二进制 Office 兼容不属于当前预览契约。

## 软上限说明

以下文件位于 300-600 行区间，暂按单一交互事务保留：

- `terminal.tsx`：PTY 生命周期、SSE、尺寸同步和命令历史必须共同清理。
- `terminal-fit.ts`：合并同一显示帧内的尺寸通知，并忽略尺寸未变化的 `ResizeObserver` 回调。
- `file-navigator.tsx`：目录缓存、筛选、展开路径和树行渲染共享同一导航状态；外壳由 `navigator-frame.tsx` 复用，根目录请求在首个可见布局提交前启动并受折叠状态保护。
- `preview-pane.tsx`：文件类型分派、编辑草稿、保存审批和预览错误共同组成一次文件打开事务。
- `panel.tsx`：只协调工作区标签壳；旧的单页 `files.tsx`、审阅“现场”页和重复活动聚合已由文件标签、共享导航器及独立 Runtime 恢复控制面取代，不得恢复第二套目录加载、预览或审阅活动状态。
- `use-workspace-layout-controller.ts`：统一拥有布局偏好、恢复镜像、标签/草稿持久化和拖动入口；两套长拖动算法已另行拆出。

这些文件不得吸收新的独立领域；达到 600 行前必须先补特征测试并再次拆分。
