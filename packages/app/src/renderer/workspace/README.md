# Renderer 拓展工作区
最后更新：2026-09-25 15:05:00

这里负责右侧拓展工作区的布局、标签、文件树、预览、终端、产物和 Git 审阅。

- `panel.tsx`、`add-menu.tsx`：工作区壳和标签内容。审阅不再装配第二个“现场”子页；Runtime 的任务恢复现场仍由 `runtime-recovery/` 独立负责。标签入口里尚未接通的“侧边聊天”只声明未接入（空态写“侧边聊天尚未接入”），不承诺后续能力，也不提供无效控件。
- `artifacts.tsx`、`file-view.tsx`、`file-close.ts`、`empty-launcher.tsx`：产物列表与筛选、单个文件标签的缓存加载/保存审批/预览交接、关闭恢复，以及空工作区的快捷启动入口。
- `navigator-frame.tsx`、`file-navigator.tsx`、`review-tree.tsx`：普通目录树与 Git 稀疏更改树共用同一个右侧导航外壳、折叠轨、工具栏高度、筛选框、树行缩进和选中/hover 契约；两种导航的数据源、缓存和刷新请求保持隔离，Git 刷新不会触发完整目录扫描；目录树仍按已展开行全量渲染，尚未做虚拟化，这是当前的已知缺口。**两种导航的宽度互不覆盖**（UX-18）：普通目录树用会话现场的 `fileNavigatorWidth`，审阅更改树用同一现场的 `reviewNavigatorWidth`（`WORKSPACE_FILE_NAVIGATOR_WIDTH_*` 同一组上下限，默认都是 214），`panel.tsx` 把审阅标签接到后者，因此拖宽审阅列表不会移动文件导航；两个字段都随会话现场持久化并在重启后恢复，旧快照缺 `reviewNavigatorWidth` 时回落到默认值而不是继承文件导航的宽度。**审阅导航占据布局空间**（UX-18 实机验收发现并修复）：普通导航由 `.workspace-shared-file-navigator` 这个 flex 项占位，而审阅导航是 `.workspace-review` 的直接子元素，只有 `position: absolute` 时它会被画出 flex 行、盖住 Diff 表面——实机测得 Diff 标题行的两个图标按钮与导航自己的刷新按钮落在同一个矩形上，指针点不到，Diff 代码也被树压住；`04-workspace.css` 因此让 `.workspace-files > .workspace-files-navigator` 回到行内（`position: relative` + `flex: 0 0 var(--workspace-files-navigator-width)`），折叠时再按共享外壳的规则收缩到折叠轨宽度。真实窗口验收：`pnpm run verify:review-navigator-width`。
- `directory-cache.ts`、`directory-preload.ts`、`preview-pane.tsx`、`preview-actions.tsx`、`terminal.tsx`、`browser.tsx`：文件、终端和内置浏览器能力；目录快照由有界的跨挂载 stale-while-revalidate 缓存统一拥有，同一路径的并发刷新必须合并，折叠或切换后先显示旧树再后台校准。`main.tsx` 只会在已持久化的工作区面板可见、文件导航展开且当前标签确实需要普通文件导航时，预热同一个根目录 in-flight 请求；审阅页、折叠面板和折叠导航不触发普通目录扫描，组件挂载后复用该请求。普通文件标签中的 Markdown 默认使用共享 `Markdown` 组件渲染；标题栏的“查看源代码”位于“编辑”左侧并按需挂载共享 Monaco，点击“编辑”会直接进入可编辑源码。渲染预览始终使用当前草稿正文，因此未保存改动可在预览与源码之间往返且仍走原有保存审批；按钮、提示与可访问性属性由 `preview-actions.tsx` 维护，文件内容和草稿状态继续只由 `preview-pane.tsx` 持有；`terminal-input-controller.ts` 拥有交互终端的原始输入队列。
- `code-editor.tsx`、`monaco-model-cache.ts`：工作区唯一的 Monaco 懒加载、主题、默认配置和模型生命周期基元；普通代码查看、编辑与 Git 审阅必须复用它，不得各自打包或初始化第二套编辑器运行时。运行时只加载 `editor.api` 核心，当前文件的 Monarch tokenizer 在模型创建前按语言惰性准备，不打包 TypeScript/JSON/CSS/HTML 语言服务 worker；模型和视图状态按最多 40 条/20 MiB 有界，活动编辑器模型不强制淘汰，离开后才按 LRU 收敛。代码区统一使用 `13px` 字号和 `23px` 行高，约比旧密度增加 30%；行号至少预留 4 个字符，行号与代码之间保留 12px 装饰间距，滚动条采用轻量尺寸；Markdown、Office 和图片预览不继承这组代码参数。
- `review.tsx`、`review-cache.ts`、`review-diff.tsx`、`review-diff-model.ts`：Git 变更快照、有界快照/Diff 缓存、分层审阅和 Monaco 差异模型；审阅保留 staged/unstaged/untracked 语义，主区域与普通文件查看同为边到边、无外围圆角/边框/整面 hover 的编辑器表面，右侧文件导航贴边且只保留左分隔线。重挂载先恢复同一快照版本的树与 Diff，再后台校准；Diff 缓存同时受条目数和估算字节预算约束。Main 快照返回 opaque revision，文件 Diff 必须绑定该 revision，旧版本返回 409 后由 Renderer 自动刷新；快速切换会取消无人等待的旧请求。审阅文件支持临时路径/状态过滤以及筛选框中的上下键和 Enter 导航，过滤条件不持久化；标题行图标按钮显式切换 Monaco 单列/双列，偏好由 `WORKSPACE_REVIEW_SIDE_BY_SIDE_KEY` 持久化。审阅关闭精简构建中会退化为小方块的 Monaco 内置增删指示符，也不设置会把零宽变化画成方框的 Diff text border；增删变化行各自只绘制一层柔和的 50% 透明底色，字符级 Diff 背景保持透明，左侧用连续的 5px 纯色色带表达增删；单列模式的内联删除视图区必须复用整段红色左缘，不能按代码行断开。Git 审阅中的 Markdown 不走渲染预览，仍优先显示带 Markdown 词法着色、原始行号和红绿增减背景的 Monaco 源代码 Diff。
- `line-comments.tsx`、`line-comment-surface.tsx`、`line-comment-model.ts`、`line-comment-gesture.ts`、`line-comment-view-zones.ts`、`review-line-comments.ts`、`review-inline-deleted-comments.tsx`、`review-inline-deleted-line-numbers.ts`：普通文件与 Git 审阅共用的 Monaco 行评论交互、行号映射、view zone 和发布边界。评论在行手势或选中后创建，发布时经 `line-comment-attachments.ts` 归并进 composer 附件（`AttachmentRef.lineComments`），删除附件会同步清理面板内的临时视图状态；没有独立的评论存储或第二份评论数据。审阅评论绑定当前快照的 layer 与修改前/后侧别，并把所选源码摘录写入附件上下文，源码行号到模型行号的投影由 `review-inline-deleted-line-numbers.ts` 维护。
- `file-preview-cache.ts`、`bounded-byte-lru.ts`：普通文件预览跨标签挂载共享，按 TTL、条目数和估算字节数有界；缓存命中先恢复旧正文，后台读取只在同一请求代次仍有效时覆盖，保存结果会优先于较早的读取响应。淘汰只作用于已完成数据，不保留无限增长的 Monaco 输入正文。
- `monaco-language-support.ts`、`monaco-language-loaders.ts`、`monaco-theme.ts`：Monaco 的 worker-free 语言着色注册、按需 tokenizer 映射和 LS 中性黑灰高对比主题；主题底色、加载占位和状态栏必须保持一致且不引入蓝色背景偏向，普通代码、审阅差异、注释、行号和主要语法色不得退化为低对比或低饱和灰色。审阅的变化行号、增删计数和连续 5px 左缘使用不透明的 `#02A243` 与 `#DE352E`；代码行表面分别使用 `#23452780` 与 `#5D291D80`，在 `#101010` 编辑器底色上合成为参考图的 `#1A2B1C` 与 `#371D17`。字符级背景和整块 gutter 背景透明，避免同一代码行叠出多重色块。生产构建只从 Monaco 官方基础语言模块保留 `conf`/`language` 词法定义，隔离其附带的完整编辑器贡献副作用，并硬拒绝语言 worker、建议记忆与代码动作服务回流，避免惰性语言加载增大产物或在已初始化的服务容器中产生未知服务错误；隔离 Electron 性能验收还会监听真实 Renderer 控制台并拒绝任何未知服务错误，并校验文件/审阅主表面的边到边几何、无外围框计算样式、文件导航单一左分隔线、真实 Diff 行号、单层底色及单列删除左缘。
- `tab-strip.tsx`：拓展工作区标签条；`use-browser-controller.ts`、`browser-persistence.ts` 和 `browser-tabs.ts`：浏览器标签状态、恢复元数据和有界导航历史。
- `resize-interaction.ts`、`use-workspace-layout-controller.ts`、`use-workspace-session-layouts.ts`：独立于左侧栏的布局、拖动、折叠和恢复；按会话分桶、草稿采纳和镜像恢复由 `use-workspace-session-layouts.ts` 拥有。
- `layout-ownership.ts`：**启动期草稿布局归属哪一段会话**的纯规则。窗口在会话选定前就可用，此时打开的文件落在 `__draft__` 桶，而侧栏已经高亮某段会话，所以"进入的第一段会话"要把它认领过去（CS-08 实机缺陷的修复）；判据是**用户真正产生的内容**——默认标签之外的新标签、指向文件的 `openRequest`、未保存草稿或浏览器标签；切换会话时应用自己写入的那一个 `expandedPaths` 对齐项不算内容（实机实测形状见基线文档的 CS-08 补充），空草稿永不带过去，已有自己内容的会话永不被覆盖。
- `path-utils.ts`、`types.ts`：纯数据与路径边界；`WorkspaceArtifactRef` 仍供聊天和产物入口使用，审阅活动聚合类型已删除。

`workspace-timing.ts`：CS-08 的两个可用性指标——`reportWorkspaceEntriesVisible()`（首个目录行绘制后）与 `reportWorkspacePreviewVisible()`（首个文件正文绘制后，占位/错误/空面板不发布）；每个渲染器只发布一次，仅在 `LITTLESHEEP_BOOTSTRAP_TIMING=1` 时有产出。
文件读写、终端进程和产物索引必须通过 Local App API；从文件树打开文件要创建标签，重启恢复只使用用户数据中的受控快照。

关闭当前标签时激活最近的剩余标签；关闭最后一个标签不会折叠面板，而是显示审查、产物、终端、空白浏览器和侧边聊天快捷启动空态。面板折叠后同时保留对话区右上角固定入口和右侧全高悬浮感应入口，二者共享同一折叠状态与过渡。

浏览器的前进、后退和刷新只作用于 `browser-history.ts` 管理的独立 URL 栈，最多保留 50 条 URL，不进入全局应用导航快照。网页内部链接和新窗口请求留在 LS 的 `webview` 中；地址加载、重定向、刷新和历史移动都会在导航事件完成后清理挂起状态，避免重复加载或重复写入历史。切换标签后 webview 可以重建，因此工具栏以后端的逻辑 URL 栈为准，不直接依赖 Chromium 的原生历史栈。网页绘制由 Chromium 当前显示器 VSync 调度，刷新率是有效帧率上限；静态页面不由 LS 发起持续重绘。窗口最小化时保留 webview 实例并依赖 Chromium 后台节流，避免恢复时丢失页面状态；只有用户主动折叠拓展工作区时才卸载当前视图。

文件预览按资源上限执行：代码和普通文本进入共享 Monaco；Markdown 普通查看默认渲染，只有查看源码或编辑时才按需挂载同一个 Monaco，Git 审阅则始终优先显示源代码 Diff；Markdown 与 Office/OpenDocument 保留独立于应用 UI 的预览字体。Office/OpenDocument 只读提取正文或表格/幻灯片文本，主进程先检查文件大小，再限制 ZIP 条目数量和 XML 展开规模。完整排版、编辑和旧式二进制 Office 兼容不属于当前预览契约。

## 软上限说明

以下文件是当前体积最大、暂按单一交互事务保留的生产文件：

- `terminal.tsx`：PTY 生命周期、SSE、尺寸同步和命令历史必须共同清理。
- `line-comments.tsx`：Monaco 行评论的交互、view zone、草稿状态和附件发布共享同一套行号映射，拆分前必须先补特征测试。
- `file-navigator.tsx`：目录缓存、筛选、展开路径和树行渲染共享同一导航状态；外壳由 `navigator-frame.tsx` 复用，根目录请求在首个可见布局提交前启动并受折叠状态保护。
- `preview-pane.tsx`：文件类型分派、编辑草稿、保存审批和预览错误共同组成一次文件打开事务。保存结果只有一条状态行：失败留在原地并保留草稿（`文件保存失败，请稍后重试。`，原因进 console.debug），成功显示 `已保存`——而一次成功的保存会重新读取文件（`modifiedAt` 变化）并触发本组件的重置，所以成功提示必须跨过这次由它自己引起的刷新（`savedStatusPathRef` 只豁免这一次；切换文件或外部改动仍会清空），否则用户根本看不到确认（UX-09 实机验收发现并修掉）。
- `panel.tsx`：只协调工作区标签壳；旧的单页 `files.tsx`、审阅“现场”页和重复活动聚合已由文件标签、共享导航器及独立 Runtime 恢复控制面取代，不得恢复第二套目录加载、预览或审阅活动状态。
- `use-workspace-layout-controller.ts`：统一拥有布局偏好、恢复镜像、标签/草稿持久化和拖动入口；两套长拖动算法已另行拆出。

这些文件不得吸收新的独立领域；达到 600 行前必须先补特征测试并再次拆分。
