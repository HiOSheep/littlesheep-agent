# Renderer 通用 UI
最后更新：2026-09-22 23:57:19

这里放跨领域复用的交互基元，而不是具体业务页面。

- `feedback.ts`、`feedback-notice.tsx`：异步操作反馈的唯一结构。`tone` 是字段而不是从文案里解析出来的（调用方知道成功还是失败就直说），`feedbackRole` 决定 `status` / `alert`，长 Runtime 错误在这里有界化并由视图折叠在“技术详情”里；`FeedbackNotice` 同时渲染色调、可选的重试动作和详情披露，`busy` 期间禁用重试以免重复提交同一事务。
- `presence.tsx`：淡入淡出、外部点击收回和存在状态；外部点击收回的 Escape 也走模态层仲裁，只有最上层会消费该键。
- `floating-help.tsx`、`overflowing-label.tsx`：延迟提示、定位，以及溢出标签的滚动测量。
- `transient.ts`、`resize.ts`：临时菜单事件和拖动生命周期。
- `icons.tsx`：统一图标集合；`browser-icons.tsx`、`file-glyph-icons.tsx` 是已拆出的浏览器历史和文件类型图标家族。
- `display-frame.ts`、`display-synced-settle.ts`、`use-frame-coalesced-state.ts`：显示帧合并、布局收敛和高频状态合帧。
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
| 行内小动作 | `feedback-action` | `--control-height-sm` + `--control-font-size` |
| 空态与只读 | `dialog-hint`、`settings-module-empty`、`provider-empty`、`WorkspacePlaceholder` | 沿用既有 token；本轮未改动 |

**已知例外（不是漂移）**：`archive-action` 26px 与 `approval-action` 34px 是紧凑行操作和对话框主操作，`.provider-remove` 是 30px 胶囊，`.provider-add` / `.profile-choice` 是 48px 大块选择；圆角例外仍是 `--radius-icon: 3px`（`sidebar-toggle-btn`、`app-nav-btn`）。

**UX-14 收敛的取值变化（需要实机确认，未截图验证）**：`storage-settings-notice[data-tone=error]` 的 `#e8c5bd`、`web-source-errors` 与 `web-settings-notice.error` 的 `#f2b6b6`、`plugin-runtime-state.failed` 的 `#f0a9a9`、渠道失败明细的 `#e5a6a6` 统一为 `--feedback-danger-text`（即对话框错误一直在用的 `#ffd2d2`）；`plugin-page-notice/.plugin-page-error` 的 `7px 9px` 内边距统一为行内通知角色的 `8px 10px`，字号 `11px` 统一为 `12px`。其余替换都是零计算变化的 token 化。

所有临时浮层应支持点击其他区域收回；新增转场必须使用统一时长、可中断清理和 reduced-motion 兼容路径。

`icons.tsx` 是无状态声明式图标集合，359 行，但不含业务状态、网络调用或跨域依赖；浏览器历史与文件类型两族已经独立成文件，不得再回流合并。
