# Renderer 输入栏
最后更新：2026-09-28 21:24:54

这里负责用户输入、附件、工作区上下文、权限模式、模型/推理选择和上下文占用展示。

- `add-menu.tsx`、`message-files.tsx`、`workspace-chip.tsx`：输入辅助控件、附件预览与消息正文装配。
- `message-artifacts-card.tsx`、`use-artifact-deltas.ts`：一轮产物显示为参考图式的单张宽卡片：图标与文件总数在头部，文件路径逐行排列，行数在右侧，超过 4 行时展开。**点文件行 → 拓展工作区预览**，**点行数 → 该文件审阅**。行数默认使用中性色，仅指针悬停或键盘聚焦到该行数按钮时变为红绿色。无可用工作区路径或 Git 无法计数时仍显示卡片与文件入口，省略行数。附件保留紧凑条带。
- `mode-picker.tsx`：三档权限模式选择，以及切到完全访问时的危险确认。**焦点归属不在这里**：确认层走 `ui/focus-ownership.ts`（打开时接管焦点 → 逐帧重试直到落点成功或 500 ms 到期 → 关闭时归还），所以鼠标点选"完全访问"后**打开那一帧**焦点就已经在对话框里（实测 `landedAfterMs: 12`，聚焦在对话框自己的动作上），紧接着的 Enter/Space 不会落到后台控件（实测：43 个后台控件全部被监听，`started: []`）。选项列表的聚焦可见性由 `06-composer.css` 的 `.mode-picker-panel .option-picker-list` 内边距保证：列表会滚动，因而**按内边距盒裁剪**，而应用级焦点环画在选项边框盒**外** 2px，所以列表必须留出这 2px，否则聚焦项的环会被剪掉——实测环解析为真实的 `2px solid`，而左右与上侧的像素覆盖仍是 **0**，补上 2px 后四边都有覆盖。布局断言在 `mode-picker.test.ts`（把 `padding` 改回 `0` 会红），像素断言在 `scripts/verify-focus-ownership.mjs`。
- `runtime-picker.tsx`、`context-usage-indicator.tsx`：模型与推理档位选择、上下文占用展示。选择器不再自己算可用性，而是渲染 `use-model-availability.ts` 给出的那一份（`availability` prop），因此它和发送入口不可能对同一份配置给出不同结论。
- `runtime-availability.ts`：无可用模型时的唯一状态来源。区分“配置读取中”“读取失败（可重试）”“还没有配置（给出配置入口）”“已保存但不可用（缺密钥或缺模型条目）”“供应商可用但还没选模型（`no-selection`）”，并用设置页同一个 `isConfiguredProvider` 判定“已配置”，因此选择器与供应商页不会对同一份配置给出不同结论；`runtime-picker.tsx` 的空菜单据此显示“配置模型 / 检查供应商配置 / 重试读取”，并保留当前草稿不动。**`no-selection` 与 `unusable` 必须分开**：供应商已保存、密钥和模型条目都在、只是还没选模型时，选择器要说“还没有选择模型”并指向菜单里的模型列表；说成“可能缺少 API 密钥，或没有填写模型条目”会把用户送回设置页去改一份本来正确的配置（UX-11 实机验收发现并修掉）。
- `use-model-availability.ts`：可用性的唯一一次计算（控制器调用，`modelAvailability` 字段同时投影给 composer 与 chat）。三个表面共用它：选择器、发送入口、空对话文案。
- `send-readiness.ts`：**发送是否必须被拒绝**的唯一判据，把 Runtime 就绪原因与上面的可用性合成一个决定（`blocked` / `reason` / `executionReason` / `modelReason` / `action`）。没有可用模型时发送被拒**并且说明原因**：默认模型引用 (`openai/gpt-5.6`) 指向没有密钥的供应商，实测那一轮停在工作态 1 分 14 秒、零字符、无错误也无结算，而 ChatGPT / Cursor / VS Code 都拒绝这种提交并把人指向模型设置。`composer-view.tsx` 的按钮与 Enter 是同一条入口，两者按同一判据拒绝；`send-block-notice.tsx` 把原因就地写在控件旁（启动阶段的文字仍归 `runtime-readiness/composer-readiness-hint`，两者互斥；它用自己的 `.composer-send-block` 类，**不借用** `.composer-readiness-hint`，只共享 `../styles/11-runtime-readiness.css` 里那条选择器列表的外观——一个类名在 DOM 里只能有一个含义），禁用控件的可访问名携带同一句原因；`app-shell/chat-view.tsx` 的空对话文案也用同一句，不再邀请一次发不出去的任务。真实窗口门 `pnpm run verify:composer-send-gate`（未配置时拒绝且不产生 run，配置好后照常发送并结算）。
- `context-usage-indicator.tsx` 的弹层同时给出上下文占用与会话累计缓存命中（`formatSessionCache`）；usage 未上报的请求会在文案里标注，不把局部读数当成完整读数。
- `input-size.ts`、`focus-routing.ts`：输入框高度同步和输入焦点归属判定。`focus-routing.ts` 还导出一次性的 `COMPOSER_FOCUS_REQUEST_EVENT` 与它的判断函数 `shouldTakeComposerFocus`：`launch`（窗口刚可用）只在没有任何元素持有焦点时取走光标，`new-session`（用户刚新建对话）除非有对话框/审批/弹层打开、或用户正在别的文本表面里输入，否则取走；两种意图都在**事件触发时**重读实时焦点，而不是在请求发出时。
- `menu-focus-return.ts`：**输入栏菜单关闭后的光标归属**（I1，2026-09-29）。`ui/focus-ownership.ts` 管的是模态那一半（打开时接管、关闭时归还）；这里管弹层欠下的那一半，而且只有一小条：弹层打开时从不取走光标（`ui/focus-ownership.ts` 已明确"页面级表面不得使用它"），所以关闭时只能**归还它本来就持有的**光标。判据是 `shouldReturnMenuCaret`：只有"关闭前光标在菜单里"且"关闭后光标落在页面 body（或仍停在这个即将被浏览器修正的菜单里）"才归还给触发器；焦点被一次外部点击移到真实元素上时（`elsewhere`）不动它。触发器是归还目标，因为这三个控件本来就是菜单按钮（`aria-haspopup="menu"` + `role="menu"` + `aria-expanded`），ARIA 菜单按钮模式与 ChatGPT／VS Code／Linear／Cursor 的既有做法都是"关闭后焦点回到打开它的按钮"，也与 R2 的"还给打开前持有光标的元素"一致。真实窗口实测（2026-09-29，1100×760，真指针 + 真按键）：
  - **改前**：四条关闭路径——添加菜单按 Escape、权限菜单按 Escape、点选权限项、点选模型——`document.activeElement` 全部是 `BODY`（面板与状态同一次提交里变成 `inert`，Chromium 于是把焦点丢到 body），下一次按键落不到任何控件上。
  - **改后**：四条路径都回到各自的触发器（`.add-menu-trigger`／`.mode-picker-trigger`／`.runtime-picker-trigger`）。
  - 三个菜单各自只有**一条**关闭路径（`closeMenu()`／`closePicker()`），先 `captureMenuCaret()` 再改变 `open`：光标位置只有在菜单还在渲染时才读得到。判别实验：把某条关闭路径还原成原来的多入口 `setOpen(false)` → `menu-focus-return.test.ts` 转红（`expected 3 to be 1`）；只删掉 `captureMenuCaret()` 一行 → 同一文件转红（`the close path must capture the caret before it closes`）；字节还原后 7/7 绿。
  - **未覆盖**：真实窗口探针不是产品门禁（`scripts/` 下没有对应 gate）；`window` 外点击落在不可聚焦区域时会回到触发器，其余情况不动。
- `use-composer-focus.ts`：把上面两条焦点请求接到输入框上——挂载时请求 `launch` 光标，收到新建对话的窗口事件时请求 `new-session`。`new-session` 会在**有界**（250 ms、每 25 ms 一次）的窗口内反复问同一个判据，因为发起它的那条命令同时也在关闭别的东西（侧栏面板要走完自己的退场、刚结算的提示下一两帧才离开层栈），只看一眼就会读到"正在离场"的表面而把光标丢在地上；每次都用同一个守卫，所以活着的对话框或用户自己移走的光标仍然赢。真实窗口门 `pnpm run verify:composer-focus`：新窗口无点击即可收到真实按键；新建对话把光标交还输入框（并且命令确实执行：它关掉了自己打开的那个面板）；完全访问确认对话框打开时、侧栏搜索框正在输入时、运行中的审批提示打开时，光标都留在原处。
- 发送入口的可用性：`app-shell/composer-view.tsx` 同时参考 Runtime 就绪事实（`runtime-readiness/use-runtime-readiness`）。窗口早于 Runner 出现，未就绪时发送必须在原地禁用并使用 Runtime 给出的原因，草稿与焦点不变；不得只凭“草稿非空”就放出可点击的发送入口。

输入栏的 Enter、Shift+Enter 与输入法组词规则位于 `../ui/enter-confirm.ts`，由 `app-shell/composer-view.tsx` 使用；不要在这里或视图中另写 Enter 判断。

**输入栏弹出的面板与输入框是同一块磨砂玻璃，且这次真的生效**（2026-09-27）：`styles/06-composer.css` 里有一条共享规则，把 `.add-menu-panel`、`.model-picker-panel`（权限选择器是它的一个变体）、`.runtime-menu-shell .runtime-picker-panel` 与其 `.runtime-submenu` 统一成 `background: var(--composer-surface)`（`rgba(32, 32, 32, 0.75)`）+ `backdrop-filter: blur(18px) saturate(135%)` + `border: 0`。**此前这条规则只有声明是对的**：`.composer` 自己带着 `backdrop-filter`，于是它是所有后代的 *backdrop root*——后代的模糊只能采样这个根里已经画出来的内容，而添加菜单与权限选择器是它的后代、又整个浮在它的盒子外面，背后什么都没画，`blur(18px)` 因此是彻底的空操作，两个面板读成"清晰页面透过 0.75 深色填充"而不是玻璃；模型选择器被 portal 到 `document.body`（backdrop root 是文档）所以早就正常——三个菜单这才互不一致。Chromium 152 实测（高对比条纹背景、条纹节距 16px、填充 0.75 下条纹残留约 64/255）：条纹在 `.add-menu-panel` / `.model-picker-panel` 内部保留约 60/255 的相邻亮度差，而输入框本身只有约 1/255；把完全相同的标记移出 `.composer` 立刻回到约 1/255，唯一变量就是 backdrop root。修法是把材质从 `.composer` 挪到内缩的 `.composer::before`（`inset: 0` + `z-index: -1` + `border-radius: var(--radius-composer-input)` + `corner-shape: var(--corner-shape)`）：`.composer` 变透明、不再是 backdrop root，三个弹层的模糊这才采到真实页面，而 `::before` 自己的模糊照旧。`z-index: -1` 让这层玻璃落在内容之下，`.composer` 只给 `position: relative`、不给 `z-index`，因此不新增堆叠上下文、弹层与 `.task-progress-anchor` 的相对次序不变；这层负层级能盖在页面背景之上，靠 `.composer-shell` 的 `z-index: 40`（`chat-layout-stability.test.ts` 钉住）。同时把三个弹层的圆角从 `var(--radius-ui)`（10px）对齐到输入框的 `var(--radius-composer-input)`（14px），并把 `.model-picker-panel` 的阴影从 `0 20px 54px rgba(0,0,0,0.46)` 收敛到与其余弹层一致的 `0 22px 54px rgba(0,0,0,0.44)`。各面板的几何仍归自己所有，**材质只在这一处声明**——新增输入栏弹层时把它加进那条共享规则的选列表，不要在面板体里另写背景或边框。

模型能力和权限策略来自 shared/runtime 配置；这里不保存密钥，不自行执行文件或工具操作。

## 文件入口：一次按下只有一个动作（O3，2026-09-29）

**隐含的单/双击语义已取消。** `message-files.tsx` 的 `MessageFileLink`（用户消息里的附件卡）原先把单击**延迟 230ms** 再打开预览，并把双击解释成"用系统应用打开"：一次打开要等一个计时器，而第二个动作没有任何提示，只有恰好双击的人才会发现它。现在卡片是普通按钮——按下立刻 `onOpen()`，双击只是两次打开同一个预览（幂等，不再触发别的动作）；"用系统默认应用打开"成为它旁边一个**显式**的次级控件 `.message-file-open-system`（`ExternalOpenIcon`、可访问名 `用系统默认应用打开 <文件名>`、`title` 同义，24px 圆形目标，与 `.message-meta-copy` 同一角色、同进 `12-squircle-corners.css` 的圆形豁免清单）。两者一起放在 `.message-file-entry` 里，卡片保留既有的悬停/焦点样式。

真实窗口（`o3.single-press-opens-immediately-and-once`、`o3.double-press-does-not-trigger-a-second-action`、`o3.system-open-has-an-explicit-secondary-entry`、`o3.secondary-entry-opens-with-the-system-once`，均在真实指针按下 + `WM_NCHITTEST` = `HTCLIENT` 的前提下取证）：改前单次按下 **349-357ms** 才出现预览、双击发出 **1 次** `POST /workspace/open`；改后单次按下 **116ms**、双击 **0 次** `open`，次级控件按下发出**恰好 1 次** `/workspace/open`（同一测量用 `window.fetch` 记录路由，且按 pathname 精确匹配，避免把 `/workspace/open-with` 误记为系统打开）。未覆盖：附件缓存目录里的文件在系统打开时会落到默认应用（本批只验证请求次数与目标，不验证外部应用真的启动）；`_blank` 类正文超链接（`Markdown.tsx`）仍是单击内开、双击系统打开，不在本项范围内。

## 输入与选择流程的三种状态（I1，2026-09-29）

真实 Electron 窗口（1100×760 与最小窗 800×620，窗口**显示在屏幕上**后测量；真指针按键 + `WM_NCHITTEST`），除上面的光标归还外还取证了三条既有契约，**没有改动**：

- **运行中保留停止与补充发送**：最小窗 800×620 下跑一轮流式回答并留下草稿，`.composer-run-actions .send-round.stop` 与 `:not(.stop)` 同时存在；停止键始终在 `.composer` 与 `.chat` 矩形内、矩形完全落在窗口内，中心点 `elementFromPoint` 命中按钮自身，`WM_NCHITTEST` = `HTCLIENT`（1）。工作区面板**同时停靠**（chat 列 299px，触发 520px 容器查询）时停止键仍在 composer 内可点；但此时控件行 `scrollWidth 421 > clientWidth 255`，工作区 chip 与模型选择器、上下文占用与权限选择器互相重叠——已记录，本项未改（不在本项验收点内）。
- **等待决定**：审批提示打开时 `.approval-layer` 是命中层，composer 没有被 `inert`／`aria-hidden`，停止键仍在 DOM 里但点击不穿透；提示自身给出 `拒绝／本对话允许／仅本次`，选"拒绝"后层消失、run 结算、光标回到输入框。
- **选择模型不隐式改变权限**：点选另一个模型只发出 `POST /runtime {"model":…,"reasoning":…}`（**没有** `permissionMode` 字段），权限选择器的可访问名逐字不变，随后那一轮的 `POST /run/stream` 仍带 `"permissionMode":"research"`。`applyModelPatch` 的类型本来就只收 `Pick<RuntimePatch,'model'|'reasoning'>`，这条是取证而非改动。
