# Shared Renderer UI

This area owns reusable visual roles, focus primitives, icons, notices, state views and interaction tokens. Domain components should consume these primitives instead of creating another local style system.

`FileGlyphIcon` / `FolderGlyphIcon` 统一供文件树、审查树、文件标签、附件和记忆文件入口使用。文件格式使用本地 SVG 标志，保留格式的识别形状和颜色；文件夹与未知文件使用轻量轮廓，16px 图标不再依赖字体渲染微型缩写。素材来源、固定版本和许可见 [图标素材说明](file-glyph-assets/README.md)，归类与共享图标契约由 `icons.test.ts`、`icon-actions.test.ts` 和 `workspace-glyph-legibility.test.ts` 验证。

`VoidRing` 是品牌动效的共享入口，实时绘制：`mark.png` 作为贴图交给一个片元着色器（`void-ring-renderer.ts`），黑色球体保持不动，只重新点亮外圈日冕——呼吸外扩、缓慢漂移的光丝、颜色始终取自母图本身。状态由 `void-ring-motion.ts` 的纯函数模型逐帧推进：待机是不规则的呼吸并偶尔“张望”；加载是一颗带拖尾的彗星沿边缘奔跑；思考是沿边缘蠕动的细丝与脉动。状态切换在约 0.3 秒内交叉过渡，不硬切。模型第一帧的所有运动量为 0，画面与 `mark.png` 完全一致，所以静态图换成实时画布不会闪（2026-10-03 反馈）。所有图标共用一个隐藏的 WebGL 画布和一个 requestAnimationFrame，避免浏览器 WebGL 上下文数量上限；`static` 状态在回到原图后停止绘制。`voidRingStateForActivity` 只把真实活动投影为待机、加载、思考或静态。系统减少动态效果、页面隐藏、离开视口或 WebGL 不可用时只显示透明的 `mark.png`。`main.tsx` 启动时调用 `warmVoidRingMotion()` 预先编译着色器并上传贴图。

空白对话的大图标通过 `interactive` 变成按钮：指针在附近（约两个图标宽度内）时，日冕会转向指针、朝向指针的一侧变亮，整体轻微倾向指针；按下时被压扁、松开回弹略过头；点击或 Enter／Space 放出一道光环并闪亮一下，短时间内连点四次会转一圈。键盘聚焦时日冕会变亮。交互只影响局部视觉，不发消息、不改变 Runtime 状态；任务条和思考行的小图标保持被动。运动模型由 `void-ring-motion.test.ts` 覆盖，真实窗口行为由 `scripts/verify-void-ring.mjs` 验证。

## 材质角色与分层（V1）

`SplitButton` 的选中菜单项提供主按钮图标，领域组件提供同一当前选择对应的名称、提示和执行回调；不可用选项不能成为主按钮目标。选择状态由领域持有，控件不额外复制一份选中状态。文件打开方式和终端 Shell 共用这一契约。

### 滚动条规范

- 应用内原生滚动条由 `styles/03-shell-sidebar.css` 的 `--scrollbar-*` 令牌统一：纵横轨道均为 8px、透明轨道、圆角滑块；静止／悬浮／拖动分别使用前景色的 28%／46%／60%，随浅色、深色及自定义主题变化。
- 纵向滑块右侧和横向滑块底部不留透明边框；仅在靠内容的一侧留 2px，避免文字贴住滑块。轨道贴合所拥有滚动区域的最近边界，内容留白不能成为轨道的外侧空隙。
- 面板自身滚动时保留自身 padding；带内边距的外层菜单包着滚动列表时，仅补偿列表所在方向的父级内边距，不整体删除内容 padding。权限菜单、侧栏列表、设置导航、搜索、记忆文件与对话目录已经应用此规则；尺寸适配集中于 `styles/21-scrollbar-adapters.css`。
- 每个区域只保留一个滚动所有者；分页、锚点、稳定 gutter、轮转与键盘焦点契约继续由各组件负责，不通过全局改写 overflow 改变它们。标签条、活动标签带等刻意隐藏的滚动条保留原有行为。
- Monaco 使用 8px 原生配置，Monaco／xterm 的 DOM 滑块通过同一颜色及圆角令牌适配；Git 对比保留唯一同步轨道并复用全局样式。嵌入浏览器中的第三方网页及 PDF／Office 自带阅读器的内部滚动条由对应内容引擎拥有，LS 只统一外层容器，不注入页面样式。
- 审查覆盖聊天、输入菜单／模型／权限选择、附件、对话目录／记录、侧栏／搜索、设置／直接页面／用量、记忆文件、恢复／批准／错误／工具详情、文件树／预览、Git Review、终端、右键菜单、外观色盘与表格横向滚动。验收需实际窗口确认轨道边界、长列表末项／横向末端可达和键盘焦点，源码断言只验证契约。

`ContextMenuSurface` 为应用窗口提供统一右键菜单：18px 外圆角、11px 选项圆角，沿用菜单背景、边框、阴影与主题色；窗口边缘自动翻转定位，方向键／Home／End 导航，Escape／Tab 退出，点击外部、滚动和失焦关闭。原生输入、选中文字、链接和图片动作来自 Main 的能力投影；文件树与预览通过 `openContextMenu` 提供已有领域操作。执行前恢复原焦点，失败明确显示，不用 DOM 编辑替代原生撤销或剪贴板。

Glass identifies a floating surface. Long reading surfaces, code and dense settings remain on stable opaque surfaces. Keep the established rounded visual language; use one blur layer per visual surface and shared tokens for fill, border, shadow and radius. The conversation area (2026-10-03) combines DeepSeek-Harness's measured reading column, hairline separation, tinted reader bubble and flat detail panels with a translucent frosted composer overlay. The transcript scrolls behind this input surface and clips at its bottom edge. Its tokens (`--chat-*`, defined in `styles/03-shell-sidebar.css` and refined per theme in `styles/17-appearance-theme.css`) derive from the existing surface/text roles, so the custom palette keeps working.

| Role | Use |
| --- | --- |
| Floating panel | Sidebar and workspace surfaces that sit above the application canvas. |
| Composer and menu | Frosted input overlay, floating task strip, transcript navigation, pickers and action menus. |
| Workspace tab | A lighter glass layer for the active tab above the chat column. |
| Scrim | Darkens the background behind a modal; it is not a content surface. |
| Stable surface | Messages, conversation panels, code, settings canvas, lists and other dense reading areas. |

The visual source lives in Renderer styles. The material-role test inventories backdrop-filter declarations so a new blur surface must have an explicit role.

## 状态矩阵（V3）

| State | Required behavior |
| --- | --- |
| Hover / pressed | Shared role tokens distinguish pointer-over and active press. |
| Focus | Every focused control stays visible. Buttons, links and the ARIA roles take the app-wide ring; a text field or a slider shows focus on its own surface instead (a border or fill step on the field, or a `:focus-within` fill on the rounded shell that contains it). |
| Disabled | Use semantic disabled state, default cursor and the owning role opacity. |
| Busy | Expose aria-busy and a visible progress cue where the action takes time. |
| Reduced motion | Honor the system preference for transitions and spinner animation. |

Text fields deliberately do not draw the app-wide rectangle (reported 2026-10-02): Chromium matches `:focus-visible` for a text input however focus arrived, including a plain pointer click, so the ring framed every field on the first click and read as a second, square box inside the rounded shell that already contained it. A field that suppresses the outline must name its substitute: `focus-ownership.test.ts` asserts that pairing over these stylesheets, and `verify-settings-focus-ring.mjs` measures the settings search field's `:focus-within` fill against a real window, with the rule deleted and restored in the same session so the gate can come out red.

State colors are not the only distinction: shape and text identify status. Prefer shared StateView for loading, empty, unavailable and failure. Unavailable requires a visible reason; failure can expose a retry only when retry is real. Empty means a successful result with no entries.

Focus ownership, destructive confirmation, split buttons, feedback notices, state view and icons are shared primitives. Their source-level behavior is covered by ui tests; real Electron checks are required for hit targets, window chrome, DPI and computed visual output.

Current state-view consumers include the scheduled page (unavailable), plugins and channels (loading / empty), archived items and workspace artifacts (loading / empty / failure), skills, and daily Token usage. Each caller supplies only states it can prove from its own data source.
