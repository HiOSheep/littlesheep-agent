# Renderer 通用 UI
最后更新：2026-09-28 21:24:54

设置菜单 .settings-select-menu 纳入 float-glass 材质角色，沿用 blur(18px) saturate(135%) 与菜单阴影；实现由 settings/select.tsx 拥有，并使用已有 useEscapeScope 加入浮层栈。设置页其他内容采用实体卡片，不新增正文模糊。

窗口布局层 14-window-layout.css 取消工作区面板的背景模糊（新增显式 none 覆盖），工作区保持稳定实体底色；侧栏和 Beta 标题栏的应用外模糊由系统 Acrylic/vibrancy 提供，不新增 CSS blur 配方。ui-material-roles.test.ts 同步维护覆盖清单。

这里放跨领域复用的交互基元，而不是具体业务页面。

`message-icons.tsx` 的分叉图标使用一条输入路径向两个端点分流的轮廓，16px 下保留清晰的分叉方向；消息行控制的尺寸和悬停状态在 `styles/05-chat-messages.css`。

- `feedback.ts`、`feedback-notice.tsx`：异步操作反馈的唯一结构。`tone` 是字段而不是从文案里解析出来的（调用方知道成功还是失败就直说），`feedbackRole` 决定 `status` / `alert`，长 Runtime 错误在这里有界化并由视图折叠在“技术详情”里；`FeedbackNotice` 同时渲染色调、可选的重试动作和详情披露，`busy` 期间禁用重试以免重复提交同一事务。
- `presence.tsx`：淡入淡出、外部点击收回和存在状态；外部点击收回的 Escape 也走模态层仲裁，只有最上层会消费该键。
- `floating-help.tsx`、`overflowing-label.tsx`：延迟提示、定位，以及溢出标签的滚动测量。
- `transient.ts`、`resize.ts`：临时菜单事件和拖动生命周期。
- `icons.tsx`：统一图标集合；`browser-icons.tsx`、`file-glyph-icons.tsx` 是已拆出的浏览器历史和工作区文件/文件夹字形家族（`FolderGlyphIcon` 2026-09-26 从 `icons.tsx` 移入后者，`icons.tsx` 只保留再导出，冻结上限因此从 359 降到 350）。
- `display-frame.ts`、`display-synced-settle.ts`、`use-frame-coalesced-state.ts`：显示帧合并、布局收敛和高频状态合帧。
- `code-wrap-preference.ts`、`code-wrap-toggle.tsx`：代码“自动换行”偏好的唯一来源与共享可访问按钮（taskbook UX-23）。对话 Markdown 和工作区编辑器读同一个 `localStorage` 键，并通过同一 Renderer 内订阅立即同步；默认关闭＝横向滚动，存储不可用时回落默认值，不让偏好读取影响渲染。`Markdown.tsx` 的高亮与纯文本回退共用头部栏；真实窗口验收门为 `pnpm run verify:code-wrap-control`。
- `enter-confirm.ts`：Enter 确认语义的纯规则与输入法组词状态。普通 Enter 确认、Shift+Enter 换行、组词中的 Enter 交给输入法；主输入框与项目名输入框共用它，不要把 Enter 判断重新写回各自的 `onKeyDown`。
- `modal-layer.ts`、`modal-surface.ts`：分层 UI 的键盘语义。`modal-layer.ts` 是纯规则（Escape 归属最上层、Tab 循环索引），`modal-surface.ts` 提供 `useEscapeScope`（页面级作用域：弹层、菜单、平铺设置页）与 `useModalSurface`（模态对话框的按键契约：Escape 归属、Tab 约束）；**焦点生命周期不在这里**，见下一条。
- `focus-ownership.ts`：**“谁持有焦点”的唯一归属**（架构候选 A2）。三条规则写在该文件头部，改它之前先读那段：
  - **R1 打开即接管焦点**：优先用调用方声明的 `initialFocusRef`，否则用容器内第一个可聚焦元素；**逐帧重试直到落点成功或 `ENTRY_FOCUS_TIMEOUT_MS`（500ms）到期**。这是三处缺陷的共同根因：`useModalSurface` 原来只在 `active` 变化的那一次 effect 里聚焦一次，而经 `presence.tsx` 打开的浮层在那一帧渲染 `null`（`presence.tsx:88`），两个 ref 都还是空 → 焦点从未落地且**无人重试**（实测：完全访问警告打开后 `document.activeElement` 仍是 `BODY`，随后的 Enter 激活了后台控件并静默关掉警告）。同步挂载的表面（`danger-confirm.tsx`、`approval/prompt.tsx`）第一次就成功，不会多排一帧。
  - **R2 关闭归还焦点**：回到打开前持有焦点的元素（仍可聚焦时才还）；**这个表面若从未真正取到焦点就不还**——没动过焦点的地方不许把焦点搬走。
  - **R3 聚焦的控件必须看得见焦点**：控件要么显示环、要么显示填充。关掉全局 `:focus-visible` 环的规则必须给出替代，且**外层滚动容器不许把替代剪掉**——权限选择器 `.option-picker-list` 曾把每个聚焦项左右两侧的环剪到 **0.00** 覆盖。
- `focus-indicator-rules.ts`：R3 的**样式表读法**（纯文本进、判断出，无 DOM）：这条规则是否把控件推进了焦点态、是否关掉 outline、是否画了可见替代，以及“这个滚动容器的内边距容不容得下里面控件的环”。R3 的两半分由 `focus-ownership.test.ts`（样式源 + 例外清单，**例外本身也要被验证**）与 `scripts/lib/focus-visibility.mjs`（真实窗口像素：聚焦帧 vs 同一批像素失焦帧，按控件自身边框盒分为环/填充，并给出环的**逐边覆盖**）断言——只有像素能发现“画了却被剪掉或被盖住”的环。两者都应作为**可调用**能力复用，不要重新手写一遍。
- `danger-confirm.tsx`：不可逆删除的最小确认层，展示对象、影响和保留项，初始焦点在“取消”，请求进行中禁用两个动作并发布 `aria-busy`，失败行带共享失败字形。
- `state-view.ts`、`state-view.tsx`、`state-icons.tsx`：**四种状态视图**（加载／无数据／不可用／失败）的状态表、结构与字形家族。四种状态的 role／busy／disabled／字形两两不同，`unavailable` 的原因在类型上必填（"这里不能用"不会渲染成"这里没有数据"）；状态标记独立成族，不增长冻结的 `icons.tsx`。契约见 `state-view.test.ts`，样式与整体矩阵见 `styles/13-interaction-states.css` 与 `ui-state-matrix.test.ts`。

**平铺编辑页与模态对话框必须分开定义**：设置页里的编辑器、内嵌的渠道/技能页是页面级表面，只用 `useEscapeScope`，不捕获 Tab；只有真正覆盖其它内容、需要用户先处理的对话框才使用 `useModalSurface`。`active` 参数用于退出动画期间交还按键：只在下滑动画中存在的层不再消费 Escape，也不会重复触发已结算的操作。

**焦点归属只有一处，新浮层不要自己写聚焦**：需要"打开时接管焦点、关闭时归还"的表面一律走 `focus-ownership.ts`（`useModalSurface` 已经接上）。不要再写 `ref.current?.focus()` 这种一次性聚焦——那正是本批三处缺陷的共同形状：经 `presence.tsx` 打开的浮层在打开那一帧还没有子节点，一次性聚焦必然落空且不会重试。第 3 条规则（R3）的已知缺口登记在 `focus-ownership.test.ts` 的例外清单里（清单里的 `compensated` 条目会被反过来验证，写成假的不通过）；往清单里加控件必须同时写清原因并改动该名单，不允许把新缺陷静默吸收进去。真实窗口的像素验收门是 `scripts/verify-focus-ownership.mjs`。

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
| 禁用态 | 上面所有角色 + `dialog-close`，以及设置页/恢复页/记忆文件页的动作按钮 | `--control-disabled-opacity`，由 `styles/13-interaction-states.css` 的**一条** `:is(...):disabled` 规则统一施加（本轮之前是 21 条逐角色复制，其中 `.danger-btn:disabled` 还用了字面量 `0.5`）；大块选择用 `--choice-disabled-opacity`；输入区自己的控件用 `--composer-control-disabled-opacity`（`0.48`）；密集行动作用 `--row-action-disabled-opacity`（`0.55`） |
| 空态与只读 | `dialog-hint`、`settings-module-empty`、`provider-empty`、`WorkspacePlaceholder` | 沿用既有 token；四种状态视图的共享件见下文「四种状态视图」 |

**已知例外（不是漂移）**：`archive-action` 26px 与 `approval-action` 34px 是紧凑行操作和对话框主操作，`.provider-remove` 是 30px 胶囊（高度归段内动作，圆角仍是胶囊），`.provider-add` / `.profile-choice` 是 48px 大块选择；`.plugin-switch` 18px 是开关、`.provider-chip` 24px 是胶囊；圆角例外仍是 `--radius-icon: 3px`（`sidebar-toggle-btn`、`app-nav-btn`）。`.application-close-policy-list .profile-choice:disabled` 与 `.project-parent-picker:disabled` 保留更强的 `--choice-disabled-opacity`。

**未收敛范围（如实记录，不是已完成）**：侧栏导航/树行、工作区文件树与浏览器工具条、聊天历史“加载更早”这些密集行/工具条角色仍各自使用字面量禁用透明度——本轮实测：`.app-nav-btn` `0.35`、`.workspace-browser-nav button` `0.3`、`.workspace-browser-toolbar button` `0.35`、`.workspace-artifacts-filter`/`.workspace-files-text-btn`/`.workspace-line-comment-editor-actions button` `0.45`、`.runtime-menu-item` `0.5`、`.sidebar-section-action`/`.session-rename-input` `0.72`、`.runtime-readiness-retry` `0.7`（危险条上的动作，需要更高可读性）。它们与上面按钮角色的层级不同，任务书要求不做全仓机械替换，因此本轮只把**完全同值**的两簇收敛成令牌（输入区控件 `0.48`、密集行动作 `0.55`，见上表），其余保留原值并在这里登记：要收敛需要各自的实机对照。`--row-action-disabled-opacity: 0.55` 与 `--composer-control-disabled-opacity: 0.48` 都取自本轮实测值，因此这次没有改动任何像素。

**UX-14 的取值变化与实机证据**：五处危险文本（`storage-settings-notice` 错误色 `#e8c5bd`、`web-source-errors` 与 `web-settings-notice.error` 的 `#f2b6b6`、`plugin-runtime-state.failed` 的 `#f0a9a9`、渠道失败明细 `#e5a6a6`）统一为 `--feedback-danger-text`（即对话框错误一直在用的 `#ffd2d2`）；`plugin-page-notice/.plugin-page-error` 的内边距 `7px 9px` → `8px 10px`、字号 `11px` → `12px`；页头动作 30px → 32px；段内动作 29px → 30px；共享控件与设置/对话框动作按钮的禁用态统一为 `--control-disabled-opacity: 0.42`，并补上此前完全没有禁用样式的 `close-btn`/`toggle-btn`/`refresh-btn`/`danger-btn`/`dialog-close`。以上均由 `pnpm run verify:shared-ui-roles` 在真实窗口里测量（对话框错误 13px 文本为 `rgb(255,210,210)`、插件通知 8px/10px/12px、禁用态 0.42、reduced-motion 下 0.14s/0.18s 动效塌到 0.001s）；源侧契约见 `ui-state-consistency.test.ts`。

**设置页正文的字号不是另一套体系**（2026-09-27）：设置正文的 11 个尺寸令牌（`--settings-page-title-font-size` 26px、`--settings-page-desc-font-size` 14px、`--settings-group-title-font-size` 15px、`--settings-row-title-font-size` 14px、`--settings-row-desc-font-size` 13px、`--settings-meta-font-size` 12px、`--settings-row-min-height` 68px、`--settings-switch-width/-height/-knob/-travel` 40/22/16/18px）与上面的控件令牌并列定义在 `03-shell-sidebar.css` 的 `:root`。设置页的**行动作**仍属于上表的「段内紧凑动作」角色（`--control-height-row` + `--control-font-size`），不再被某个后写的参考图规则改成 42px / 16px。上表里 `plugin-runtime-state.failed` 的浅红之外，`.plugin-diagnostics > strong`（曾为 `#f0b2b2`）与 `.plugin-diagnostics small`（曾为 `#d89c9c`）也统一到 `--feedback-danger-text`，`.plugin-trust-confirmation-inner strong` 与 `.plugin-trust-actions button.danger` 的 `#ffd6d6` 分别落到 `--feedback-danger-text` 与 `--danger-control-text`。契约与"最终生效值"断言见 `settings-typography.test.ts`。

## 材质角色与分层（V1）

玻璃只是四种材质里的一种，而且**只用在承担"浮层身份"的四个区域**：浮动面板、输入区、浮动任务条、菜单。长正文、代码、表格和密集设置内容一律走稳定底色——它们是阅读面，模糊只会降低对比度并强制合成。下表是"角色 → 令牌 → 使用位置"对照表；`ui-material-roles.test.ts` 从样式源里**推导**所有声明 `backdrop-filter` 的规则并与本表逐条比对，所以新增玻璃面必须同时改这里，模糊配方也不再允许逐页自选。

| 角色 | 令牌与配方 | 使用位置 |
| --- | --- | --- |
| 面板玻璃（浮动卡片） | 填充 `--sidebar-glass-fill`（`color-mix(surface 36%)`）+ `blur(20px) saturate(145%)`；边框 `--floating-panel-border-width` / `--floating-panel-frame-color`；阴影 `--floating-panel-shadow`；圆角 `--radius-floating-panel`（内层 `--floating-panel-inner-radius`） | `.sidebar-surface::before`、`.workspace-panel-surface::before`（`styles/03-shell-sidebar.css`）；角形由 `styles/12-squircle-corners.css` 下发给同一层 |
| 浮动区与菜单玻璃 | 填充 `--composer-surface`（`rgba(32,32,32,0.75)`）+ `blur(18px) saturate(135%)`；无描边 | 输入区 `.composer::before`；浮动任务条 `.running-pill` 与其展开面板 `.running-pill-panel`；回到最新 `.chat-jump-to-latest`；菜单 `.split-button-menu`、`.sidebar-menu-panel`（它有自己的 `--sidebar-menu-surface`）、`.add-menu-panel` / `.model-picker-panel` / `.runtime-menu-shell .runtime-picker-panel` / `.runtime-submenu`（`styles/06-composer.css` 里的一条共享规则） |
| 工作区页签玻璃 | 填充 `--workspace-tab-glass-fill`（`color-mix(control-hover 74%)`）+ `blur(12px) saturate(135%)` | `.workspace-active-item`：26px 页签压在聊天列之上，需要比浮层更轻的一档配方 |
| 遮罩（不是材质） | `.overlay`：`rgba(0,0,0,0.7)` + `blur(8px)`；`.project-creator-scrim`：`rgba(12,12,12,0.46)` + `blur(5px)` | 模态背板与项目创建背板：只压暗，不承载内容，因此保持各自的两档 |
| 稳定底色（明确不是玻璃） | `--workspace-code-surface`、`--surface` / `--surface-2` / `--surface-3`、`--control*`；`.message.user` 只借 `--composer-surface` 的填充、不带模糊 | 聊天正文与代码（`.message`、`.code-toolbar`）、设置页画布 `.settings-page-transition`、工作区与归档列表 |

**同一视觉层只允许一层玻璃**：面板与输入区的材质都画在内缩 `::before` 上，元素本身保持透明，因此它们**不是** backdrop root，面板里弹出的菜单才采得到真实背景（`composer/README.md` 记录的实测：条纹节距 16px 时菜单内部残余约 60/255，而输入框自身约 1/255）。只有两处显式关掉模糊：列拖拽期间（整列模糊要逐帧重采样）与设置页自己的透明 `.overlay`（设置是页面、不是模态）。

阴影同样按层收敛，不再逐面板写字面量：

| 层 | 令牌 | 使用位置 |
| --- | --- | --- |
| 对话框 | `--shadow`（`0 18px 46px rgba(0,0,0,0.38)`） | `.dialog` 等 7 处 |
| 浮层菜单 / 选择器 | `--shadow-menu`（`0 22px 54px rgba(0,0,0,0.44)`） | `.running-pill-panel`、`.split-button-menu` 与输入区 5 个面板——本轮把 7 份重复字面量收敛成这一条令牌 |
| 浮动卡片静止态 | `--floating-panel-shadow`（`0 6px 18px`） | `.sidebar-surface`、`.workspace-panel-surface` |
| 尺寸随动的小浮标 | 各自一处（任务条 `0 8px 24px`、回到最新 `0 10px 26px`、重开标签 `0 14px 36px`、输入区 `0 16px 38px`） | 阴影随控件尺寸缩放，不并入上面三层 |

**本轮合并/删除的重复规则**（每条都保持最终生效值不变）：`.settings-sidebar-track`（07，两处合并为一处）、`.profile-choice-list`（07，删掉重复的 `width`/`gap` 覆盖）、`.settings-module-kicker`（07，把后写的 `display: none` 并入自己的规则）、`.workspace-files-root span`（04，删掉重复 `display` 的空操作）、`.workspace-terminal-shell`（04，两处合并）、`.workspace-review-tree-branch`（04 与 10 两处合并到 04）、`.runtime-provider-option small` / `.runtime-reasoning-option small`（06，两处合并）、以及 21 条逐角色禁用规则合并为状态层的一条。仍然保留的两处"同名规则"是**有意分层**（`03` 画材质、`12` 下角形；`*` 与 `:root` 分属重置与角政策），不动。两处**故意没合并**：`.model-picker-trigger`（`composer/control-surface-style.test.ts` 逐条钉住两个规则体的声明顺序，合并要连另一包的断言一起改）与 `.settings-page-transition`（`font-rendering.test.ts` 钉住 `round(nearest …)` 的居中写法，但后写的 `margin-inline: auto` 实际覆盖了它——见"未验证与遗留"）。

**按下层的实测边界（本轮真实窗口探针）**：`ui/` 之外仍有两类控件没有按下反馈——工作区文件树/浏览器/审阅的动作按钮（属于工作区工作包）与 `app-nav-btn` 之外的 `.app-nav-controls` 组合；`settings-entry-btn`/`sidebar-toggle-btn`/`app-nav-btn` 三个窗口镶边控件在基线探针里 `mousePressed` 中心像素差为 0，本轮已补进状态层（重测见下方证据）。`disabled` 只覆盖上面列出的角色族；密集行/工具条的禁用透明度是登记过的未收敛项。

## 状态矩阵（V3）

悬停之外，控件还必须有**按下**与**忙碌**，否则"点下去了吗""还在跑吗"只能靠猜。本轮实测到的缺口：真实 `mousePressed` 在四个探针控件（`sidebar-toggle-btn`、`settings-entry-btn`、`composer-tab-control`、`app-nav-btn`）上**中心像素差为 0**；`.plugin-switch` 完全没有悬停/按下；禁用色被复制进 21 条规则，`.danger-btn:disabled` 还用字面量 `0.5` 覆盖了自己角色令牌的 `0.42`。

| 角色 | 悬停 | 聚焦 | 按下 | 禁用 | 忙碌 |
| --- | --- | --- | --- | --- | --- |
| 常规控件（`toggle-btn`、`close-btn`、`refresh-btn`、`dialog-close`、`icon-btn`、`plugin-reload-button`） | `--control-hover`（各自域文件） | 全局 `:focus-visible` 环（`03-shell-sidebar.css`） | `--control-active`（`styles/13-interaction-states.css`） | `--control-disabled-opacity`（同文件一条规则） | `[aria-busy='true']` → `cursor: progress` |
| 提交控件（`save-btn`、`reload-btn`） | `--accent-hover` | 同上 | 回落到 `--accent` | 同上 | 同上 |
| 危险控件（`danger-btn`、`active-run-actions button.danger`、`archive-action.danger`） | `color-mix(--danger-soft 65%, --control-active)` | 同上 | `color-mix(--danger-soft 88%, --control-active)` | 同上（字面量 `0.5` 已删） | 同上 |
| 填充型动作（`feedback-action`、`ms-feedback-action`） | `--control-active` | 同上 | `--control-pressed` | 同上 | 同上 |
| 发送控键（`send-round`，含 `.stop`） | 无悬停（`transition: none`，发送/停止不逐帧动画） | 同上 | 向底色压一档（`color-mix(accent 82%, bg)`；停止态向 `--danger` 压） | `--control-disabled-opacity` | 同上 |
| 玻璃面上的行（`sidebar-nav-button`、`session-item`、`settings-nav-item`、`settings-overview-row`、`settings-entry-btn`、`sidebar-section-action`、`sidebar-search-result`、`sidebar-menu-item`） | `--sidebar-interaction-hover` | 同上 | `--sidebar-interaction-active` | 除 `sidebar-section-action`（0.72，见未收敛）外走 token | 同上 |
| 窗口镶边控件（`sidebar-toggle-btn`、`app-nav-btn`） | `--control-hover` | 全局环 | `--control-active` | 未统一（见未收敛） | 同上 |
| 菜单 / 选择器行（`split-button-menu-item`、`runtime-menu-item`、`model-option`） | `--composer-picker-option-hover` | 同上 | `--composer-picker-option-active` | `--control-disabled-opacity` | 同上 |
| 开关（`plugin-switch`） | 本轮新增 `filter: brightness(1.12)` | 同上 | `filter: brightness(0.94)` | `--control-disabled-opacity` | 同上 |
| 输入区触发器（`composer-tab-control`、`model-picker-trigger`、`runtime-picker-trigger`、`pill-select`） | `--control-hover`（打开态 `--control-active`） | 同上 | `--control-active` | `--composer-control-disabled-opacity`（`0.48`）+ `cursor: default` | 同上 |
| 浮动任务条（`running-pill`） | 与 `--control-hover` 混合 | 全局环 | 再深一档混合 | — | 同上 |
| 两段式控件（`split-button`，`ui/split-button.tsx`） | `--control-hover` | 全局环 | `--control-active` | `--control-disabled-opacity` + 可查原因（`disabledReason`） | `.busy` 底边进度条 + `aria-busy`，且工作中**不**套用禁用透明度 |
| 工作区文件树/浏览器/审阅动作、`app-nav-btn`、`.workspace-review-icon-button` | 各自域文件 | 各自 `:focus-visible` | 未统一（见未收敛） | 0.3–0.72 字面量（见未收敛） | `[aria-busy='true']` 全局生效 |

禁用态现在只有一条共享规则（`styles/13-interaction-states.css` 的 `:is(...):disabled`），它同时给出 `cursor: default` 与角色 token；`.split-button-primary`/`.split-button-chevron`/`.split-button-menu-item`/`.pill-select` 之前漏掉的 `cursor: default` 一并补上（禁用控件不再显示"可点"的手型）。`aria-disabled="true"` 的角色控件（`sidebar-section-action`、`web-source-row`）同样走 `cursor: default`。

**焦点可见性**：应用级 `:focus-visible` 环（`03-shell-sidebar.css`）本轮从 `button`/`input`/`textarea` 扩展到 `a[href]`、`summary` 以及 `[role='button'|'menuitem'|'menuitemradio'|'option'|'switch'|'tab']`——这些角色如果落在 `div` 上（例如 `workspace/tab-strip.tsx` 的 `role="tab"`），此前只有 UA 的默认行为，键盘用户看不到焦点在哪。自己画焦点的面（`.workspace-active-item`、`.composer-tab-control`、`.sidebar-toggle-btn` 等）保持原样：它们的 `:focus-visible` 规则在更晚的域文件里，优先级相同而顺序在后，仍然赢。

### 四种状态视图

| 状态 | 形状（不依赖颜色） | ARIA | 文案与动作 |
| --- | --- | --- | --- |
| 加载 `loading` | 旋转圆环 `.state-view-ring`（复用 `plugin-loading-spin`） | `role="status"` + `aria-busy="true"` | 说明正在做什么；**不给动作**（区域已经在工作） |
| 无数据 `empty` | 托盘字形 `EmptyIcon`，中性底色 | `role="status"` | 说明"确实没有"，可以给本区域唯一的主动作 |
| 不可用 `unavailable` | 斜杠圆 `UnavailableIcon` + 虚线框 | `role="status"` + `aria-disabled="true"` | **原因必填**（类型上必填），显示成一句可见文字；不给动作 |
| 失败 `failure` | 叉号圆 `FailureIcon` + danger 底色 | `role="alert"` | 原因 + 重试动作；长错误仍可折叠展开 |

`ui/state-view.ts` 是状态表的唯一来源：四种状态的 `role`/`busy`/`disabled`/字形/是否必填原因两两不同，`ui/state-view.test.ts` 直接断言"四个签名互不相同""四个字形互不相同"，所以"不可用"不可能退化成"空数据"。`ui/state-view.tsx` 渲染结构（`props.state === 'unavailable'` 时才读 `props.reason`，类型上是必填），`ui/state-icons.tsx` 提供六个字形（失败/警告/成功/信息/不可用/无数据），刻意不放进冻结的 `icons.tsx`。

**已经落地的位置**：失败态——`FeedbackNotice`（`ui/feedback-notice.tsx`，每个 tone 都有自己的字形，失败不再只靠红色）与不可逆删除确认（`ui/danger-confirm.tsx` 的错误行带失败图标，并发布 `aria-busy`）；忙碌态——`ui/split-button.tsx`（`aria-busy` + 底边进度条 + 禁用原因）、`runtime-recovery/checkpoint-recovery.tsx`、`workspace/browser.tsx` 已有的 `aria-busy` 现在有统一样式；不可用态——`sidebar-section-action[aria-disabled="true"]` 与 `web-source-row[aria-disabled="true"]` 有统一样式。

**尚未接入（需要各自工作包接线，本包只提供共享件）**：设置模块空态（`settings-module-empty`，现为图标+标题+说明，语义等同 `empty`）、插件/渠道加载中（`plugin-loading-indicator`，等同 `loading`）、Runtime 未就绪（`runtime-readiness-notice`，等同 `unavailable`，已有原因文案）、聊天空会话与工作区空列表（`workspace-empty-launcher-item`）。这些面当前的类名与结构各自成立，但**没有**能力区分"没有数据"和"不能用"；把它们换成 `StateView` 属于对应页面的改动。

所有临时浮层应支持点击其他区域收回；新增转场必须使用统一时长、可中断清理和 reduced-motion 兼容路径。

`icons.tsx` 是无状态声明式图标集合，350 行（`FolderGlyphIcon` 移入 `file-glyph-icons.tsx` 后由 359 降到 350，上限同步下调），冻结期间不得增长；浏览器历史与工作区文件字形家族已经独立成文件。代码换行按钮由 `code-wrap-toggle.tsx` 的共享控件持有，沿用相同的 `sidebar-svg-icon` 视觉基元，避免扩张冻结的图标集合；它**按状态画两个不同图标**（`data-wrap-icon="off"`：中间那条线直着伸出右边缘、箭头朝外＝不换行；`"on"`：同一条线折到下一行、箭头折回＝自动换行），切换时同步替换 SVG，因此按钮自身的图形就能说明当前状态，不只靠 `aria-pressed`。契约断言在 `code-wrap-preference.test.ts`（每个状态画哪个图标）。**只有一个消费者的一次性图标就地画在使用处**：`app-shell/chat-view.tsx` 的"回到最新"向下箭头（`.chat-jump-to-latest-arrow`）写在组件内部，就是因为加进 `icons.tsx` 会让冻结热点继续增长——`check:repo` 的"核心组合热点未继续增长"会直接拦下这种增长，所以新图标要么进已拆出的家族文件，要么和唯一使用它的组件放一起。

**文件字形在 16px 下要能看清**（2026-09-26）：`.workspace-tree-glyph-icon` 从 14px 提到 **16px**（正好填满行网格里那一列），类型标记的字号从 5px 提到 **7px**——14px 下的 5px 标记等于 4.4px，就是一团糊。字形宽度有上限（"MD" 在 7px 时量到 12px，比 11px 的纸面还宽），所以字样本身偏宽的标记降一档到 **6px**（`markdown` / `pdf` / `database` / `git`），YAML 的标记由 `YML` 改成 **`YL`**（与参考一致，也才放得下）。真实窗口实测：字形 16×16、标记 `font-size: 6–7px`（"MD" 10.4px、"JS" 8.5px、"TS" 9.3px、"YL" 8.9px、`{}` 5.3px），行高仍是 26px。门禁在 `workspace-glyph-legibility.test.ts` 与 `icons.test.ts` 里钉住几何与标记。
**两段式控件 `split-button.tsx`**（2026-09-26）：左段是"当前选择"的图标、点一下就立即用当前选择做事，右段是箭头、点开列出其它选择；菜单通过 portal 渲染成 `.split-button-menu`（图标 + 文案 + 当前项高亮 + 可选的分隔线行），整块只有 30px 高、比"标签 + 下拉 + 独立按钮"省一行。它被终端头的 Shell 选择与预览工具栏的"打开方式"共用；用法上的约定是 **左段只做当前这件事、选择留在右段的列表里**，`onPrimary` 与 `items[].onSelect` 都由调用方提供。
**工作区文件与文件夹字形的形状语言**（`file-glyph-icons.tsx` + `styles/04-workspace.css`，2026-09-26）：每个字形都是一块**圆角实心板**——文件夹是带圆角页签和浅色横条的琥珀色板（`--workspace-folder-glyph`），文件是圆角纸张 + 浅色折角 + 该类型自己的标记；标记与颜色对齐各类型官方标识（HTML5 橙配 "5"、CSS3 蓝配 "3"、JavaScript 黄配 "JS"、TypeScript 蓝、Markdown 蓝配 "MD"、Go 青配 "Go"、Git 橙、PDF 红……），几何则在 14px 下重画以保证圆角不糊。`generic` 只有纸张没有标记；浅色底（JS 黄、JSON 黄）的标记用深色，其余用白色。改这里的形状或配色时同步 `icons.test.ts` 的标记断言（"MD"/"5"）与 `04-workspace.css` 的色表。
