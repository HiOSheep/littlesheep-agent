# Renderer 通用 UI
最后更新：2026-09-26 20:52:50

这里放跨领域复用的交互基元，而不是具体业务页面。

- `feedback.ts`、`feedback-notice.tsx`：异步操作反馈的唯一结构。`tone` 是字段而不是从文案里解析出来的（调用方知道成功还是失败就直说），`feedbackRole` 决定 `status` / `alert`，长 Runtime 错误在这里有界化并由视图折叠在“技术详情”里；`FeedbackNotice` 同时渲染色调、可选的重试动作和详情披露，`busy` 期间禁用重试以免重复提交同一事务。
- `presence.tsx`：淡入淡出、外部点击收回和存在状态；外部点击收回的 Escape 也走模态层仲裁，只有最上层会消费该键。
- `floating-help.tsx`、`overflowing-label.tsx`：延迟提示、定位，以及溢出标签的滚动测量。
- `transient.ts`、`resize.ts`：临时菜单事件和拖动生命周期。
- `icons.tsx`：统一图标集合；`browser-icons.tsx`、`file-glyph-icons.tsx` 是已拆出的浏览器历史和工作区文件/文件夹字形家族（`FolderGlyphIcon` 2026-09-26 从 `icons.tsx` 移入后者，`icons.tsx` 只保留再导出，冻结上限因此从 359 降到 350）。
- `display-frame.ts`、`display-synced-settle.ts`、`use-frame-coalesced-state.ts`：显示帧合并、布局收敛和高频状态合帧。
- `code-wrap-preference.ts`、`code-wrap-toggle.tsx`：代码“自动换行”偏好的唯一来源与共享可访问按钮（taskbook UX-23）。对话 Markdown 和工作区编辑器读同一个 `localStorage` 键，并通过同一 Renderer 内订阅立即同步；默认关闭＝横向滚动，存储不可用时回落默认值，不让偏好读取影响渲染。`Markdown.tsx` 的高亮与纯文本回退共用头部栏；真实窗口验收门为 `pnpm run verify:code-wrap-control`。
- `enter-confirm.ts`：Enter 确认语义的纯规则与输入法组词状态。普通 Enter 确认、Shift+Enter 换行、组词中的 Enter 交给输入法；主输入框与项目名输入框共用它，不要把 Enter 判断重新写回各自的 `onKeyDown`。
- `modal-layer.ts`、`modal-surface.ts`：分层 UI 的键盘语义。`modal-layer.ts` 是纯规则（Escape 归属最上层、Tab 循环索引），`modal-surface.ts` 提供 `useEscapeScope`（页面级作用域：弹层、菜单、平铺设置页）与 `useModalSurface`（真正的模态对话框：进入焦点、Tab 约束、关闭后焦点回到触发点）。
- `danger-confirm.tsx`：不可逆删除的最小确认层，展示对象、影响和保留项，初始焦点在“取消”，请求进行中禁用两个动作。

**平铺编辑页与模态对话框必须分开定义**：设置页里的编辑器、内嵌的渠道/技能页是页面级表面，只用 `useEscapeScope`，不捕获 Tab；只有真正覆盖其它内容、需要用户先处理的对话框才使用 `useModalSurface`。`active` 参数用于退出动画期间交还按键：只在下滑动画中存在的层不再消费 Escape，也不会重复触发已结算的操作。

## 状态样本

类名不同不等于视觉缺陷，但同一个角色必须用同一批 token。下表是当前样本的角色、真实类名与取值来源；`ui-state-consistency.test.ts` 直接测量样式源，任何一类重新写回字面值都会失败。

| 角色 | 类名 | 取值 |
| --- | --- | --- |
| 危险文本（错误面） | `dialog-error`、`archive-error`、`project-creator-error`、`feedback-notice[data-tone=error]`、`storage-settings-notice[data-tone=error]`、`plugin-page-error`、`plugin-list-error`、`web-source-errors`、`web-settings-notice.error`、`activity-tool-error`、`tool-live-err`、`runtime-event-notice.error`、`composer-error`、`channel-row.failure small` | `--feedback-danger-text`；带框面另外用 `--feedback-danger-border` |
| 危险控件 | `danger-btn`、`send-round.stop`、`checkpoint-recovery-actions button.danger` | `--danger-control-text`（比错误文本更亮，位于 `--danger-soft` 之上） |
| 行内通知几何 | `storage-settings-notice`、`plugin-page-notice`、`plugin-page-error`、`archive-error`、`project-creator-error` | `--notice-padding-block` / `--notice-padding-inline` / `--notice-font-size` |
| 常规控件 | `toggle-btn`、`close-btn`、`refresh-btn` | `--control-height-md` + `--control-font-size` |
| 提交控件 | `save-btn`、`reload-btn`、`danger-btn` | `--control-height-md` + `--control-font-size-strong` |
| 页头动作 | `plugin-reload-button`、`development-environments-refresh`、`archive-refresh` | `--control-height-md` + `--control-font-size`（UX-14 实机验收时 30px 与 32px 混用，已统一） |
| 段内紧凑动作 | `settings-policy-row button`、`storage-settings-row button`、`storage-settings-actions button`、`web-cache-clear`、`ms-feedback-action`、`memory-file-save`、`provider-remove` | `--control-height-row` + `--control-font-size`（29px 与 30px 混用，已统一） |
| 行内小动作 | `feedback-action` | `--control-height-sm` + `--control-font-size` |
| 禁用态 | 上面所有角色 + `dialog-close`，以及设置页/恢复页/记忆文件页的动作按钮 | `--control-disabled-opacity`；大块选择用 `--choice-disabled-opacity` |
| 空态与只读 | `dialog-hint`、`settings-module-empty`、`provider-empty`、`WorkspacePlaceholder` | 沿用既有 token；本轮未改动 |

**已知例外（不是漂移）**：`archive-action` 26px 与 `approval-action` 34px 是紧凑行操作和对话框主操作，`.provider-remove` 是 30px 胶囊（高度归段内动作，圆角仍是胶囊），`.provider-add` / `.profile-choice` 是 48px 大块选择；`.plugin-switch` 18px 是开关、`.provider-chip` 24px 是胶囊；圆角例外仍是 `--radius-icon: 3px`（`sidebar-toggle-btn`、`app-nav-btn`）。`.application-close-policy-list .profile-choice:disabled` 与 `.project-parent-picker:disabled` 保留更强的 `--choice-disabled-opacity`。

**未收敛范围（如实记录，不是已完成）**：侧栏导航/树行、工作区文件树与浏览器工具条、聊天历史“加载更早”、输入栏选择器这些密集行/工具条角色仍各自使用 0.3–0.72 的禁用透明度。它们与上面按钮角色的层级不同，任务书要求不做全仓机械替换，因此本轮没有改；要收敛需要各自的实机对照。

**UX-14 的取值变化与实机证据**：五处危险文本（`storage-settings-notice` 错误色 `#e8c5bd`、`web-source-errors` 与 `web-settings-notice.error` 的 `#f2b6b6`、`plugin-runtime-state.failed` 的 `#f0a9a9`、渠道失败明细 `#e5a6a6`）统一为 `--feedback-danger-text`（即对话框错误一直在用的 `#ffd2d2`）；`plugin-page-notice/.plugin-page-error` 的内边距 `7px 9px` → `8px 10px`、字号 `11px` → `12px`；页头动作 30px → 32px；段内动作 29px → 30px；共享控件与设置/对话框动作按钮的禁用态统一为 `--control-disabled-opacity: 0.42`，并补上此前完全没有禁用样式的 `close-btn`/`toggle-btn`/`refresh-btn`/`danger-btn`/`dialog-close`。以上均由 `pnpm run verify:shared-ui-roles` 在真实窗口里测量（对话框错误 13px 文本为 `rgb(255,210,210)`、插件通知 8px/10px/12px、禁用态 0.42、reduced-motion 下 0.14s/0.18s 动效塌到 0.001s）；源侧契约见 `ui-state-consistency.test.ts`。

所有临时浮层应支持点击其他区域收回；新增转场必须使用统一时长、可中断清理和 reduced-motion 兼容路径。

`icons.tsx` 是无状态声明式图标集合，350 行（`FolderGlyphIcon` 移入 `file-glyph-icons.tsx` 后由 359 降到 350，上限同步下调），冻结期间不得增长；浏览器历史与工作区文件字形家族已经独立成文件。代码换行图标由 `code-wrap-toggle.tsx` 的共享控件持有，沿用相同的 `sidebar-svg-icon` 视觉基元，避免扩张冻结的图标集合。**只有一个消费者的一次性图标就地画在使用处**：`app-shell/chat-view.tsx` 的"回到最新"向下箭头（`.chat-jump-to-latest-arrow`）写在组件内部，就是因为加进 `icons.tsx` 会让冻结热点继续增长——`check:repo` 的"核心组合热点未继续增长"会直接拦下这种增长，所以新图标要么进已拆出的家族文件，要么和唯一使用它的组件放一起。

**工作区文件与文件夹字形的形状语言**（`file-glyph-icons.tsx` + `styles/04-workspace.css`，2026-09-26）：每个字形都是一块**圆角实心板**——文件夹是带圆角页签和浅色横条的琥珀色板（`--workspace-folder-glyph`），文件是圆角纸张 + 浅色折角 + 该类型自己的标记；标记与颜色对齐各类型官方标识（HTML5 橙配 "5"、CSS3 蓝配 "3"、JavaScript 黄配 "JS"、TypeScript 蓝、Markdown 蓝配 "MD"、Go 青配 "Go"、Git 橙、PDF 红……），几何则在 14px 下重画以保证圆角不糊。`generic` 只有纸张没有标记；浅色底（JS 黄、JSON 黄）的标记用深色，其余用白色。改这里的形状或配色时同步 `icons.test.ts` 的标记断言（"MD"/"5"）与 `04-workspace.css` 的色表。
