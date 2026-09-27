# Renderer 输入栏
最后更新：2026-09-28 00:09:10

这里负责用户输入、附件、工作区上下文、权限模式、模型/推理选择和上下文占用展示。

- `add-menu.tsx`、`message-files.tsx`、`workspace-chip.tsx`：输入辅助控件、附件预览与消息正文装配。
- `message-artifacts-card.tsx`、`use-artifact-deltas.ts`：一轮产物显示为参考图式的单张宽卡片：图标与文件总数在头部，文件路径逐行排列，行数在右侧，超过 4 行时展开。**点文件行 → 拓展工作区预览**，**点行数 → 该文件审阅**。行数默认使用中性色，仅指针悬停或键盘聚焦到该行数按钮时变为红绿色。无可用工作区路径或 Git 无法计数时仍显示卡片与文件入口，省略行数。附件保留紧凑条带。
- `mode-picker.tsx`：三档权限模式选择，以及切到完全访问时的危险确认。
- `runtime-picker.tsx`、`context-usage-indicator.tsx`：模型与推理档位选择、上下文占用展示。选择器不再自己算可用性，而是渲染 `use-model-availability.ts` 给出的那一份（`availability` prop），因此它和发送入口不可能对同一份配置给出不同结论。
- `runtime-availability.ts`：无可用模型时的唯一状态来源。区分“配置读取中”“读取失败（可重试）”“还没有配置（给出配置入口）”“已保存但不可用（缺密钥或缺模型条目）”“供应商可用但还没选模型（`no-selection`）”，并用设置页同一个 `isConfiguredProvider` 判定“已配置”，因此选择器与供应商页不会对同一份配置给出不同结论；`runtime-picker.tsx` 的空菜单据此显示“配置模型 / 检查供应商配置 / 重试读取”，并保留当前草稿不动。**`no-selection` 与 `unusable` 必须分开**：供应商已保存、密钥和模型条目都在、只是还没选模型时，选择器要说“还没有选择模型”并指向菜单里的模型列表；说成“可能缺少 API 密钥，或没有填写模型条目”会把用户送回设置页去改一份本来正确的配置（UX-11 实机验收发现并修掉）。
- `use-model-availability.ts`：可用性的唯一一次计算（控制器调用，`modelAvailability` 字段同时投影给 composer 与 chat）。三个表面共用它：选择器、发送入口、空对话文案。
- `send-readiness.ts`：**发送是否必须被拒绝**的唯一判据，把 Runtime 就绪原因与上面的可用性合成一个决定（`blocked` / `reason` / `executionReason` / `modelReason` / `action`）。没有可用模型时发送被拒**并且说明原因**：默认模型引用 (`openai/gpt-5.6`) 指向没有密钥的供应商，实测那一轮停在工作态 1 分 14 秒、零字符、无错误也无结算，而 ChatGPT / Cursor / VS Code 都拒绝这种提交并把人指向模型设置。`composer-view.tsx` 的按钮与 Enter 是同一条入口，两者按同一判据拒绝；`send-block-notice.tsx` 把原因就地写在控件旁（启动阶段的文字仍归 `runtime-readiness/composer-readiness-hint`，两者互斥），禁用控件的可访问名携带同一句原因；`app-shell/chat-view.tsx` 的空对话文案也用同一句，不再邀请一次发不出去的任务。真实窗口门 `pnpm run verify:composer-send-gate`（未配置时拒绝且不产生 run，配置好后照常发送并结算）。
- `context-usage-indicator.tsx` 的弹层同时给出上下文占用与会话累计缓存命中（`formatSessionCache`）；usage 未上报的请求会在文案里标注，不把局部读数当成完整读数。
- `input-size.ts`、`focus-routing.ts`：输入框高度同步和输入焦点归属判定。`focus-routing.ts` 还导出一次性的 `COMPOSER_FOCUS_REQUEST_EVENT` 与它的判断函数 `shouldTakeComposerFocus`：`launch`（窗口刚可用）只在没有任何元素持有焦点时取走光标，`new-session`（用户刚新建对话）除非有对话框/审批/弹层打开、或用户正在别的文本表面里输入，否则取走；两种意图都在**事件触发时**重读实时焦点，而不是在请求发出时。
- `use-composer-focus.ts`：把上面两条焦点请求接到输入框上——挂载时请求 `launch` 光标，收到新建对话的窗口事件时下一轮请求 `new-session`。真实窗口门 `pnpm run verify:composer-focus`：新窗口无点击即可收到真实按键；新建对话把光标交还输入框；完全访问确认对话框打开时、侧栏搜索框正在输入时、运行中的审批提示打开时，光标都留在原处。
- 发送入口的可用性：`app-shell/composer-view.tsx` 同时参考 Runtime 就绪事实（`runtime-readiness/use-runtime-readiness`）。窗口早于 Runner 出现，未就绪时发送必须在原地禁用并使用 Runtime 给出的原因，草稿与焦点不变；不得只凭“草稿非空”就放出可点击的发送入口。

输入栏的 Enter、Shift+Enter 与输入法组词规则位于 `../ui/enter-confirm.ts`，由 `app-shell/composer-view.tsx` 使用；不要在这里或视图中另写 Enter 判断。

**输入栏弹出的面板与输入框是同一块磨砂玻璃，且这次真的生效**（2026-09-27）：`styles/06-composer.css` 里有一条共享规则，把 `.add-menu-panel`、`.model-picker-panel`（权限选择器是它的一个变体）、`.runtime-menu-shell .runtime-picker-panel` 与其 `.runtime-submenu` 统一成 `background: var(--composer-surface)`（`rgba(32, 32, 32, 0.75)`）+ `backdrop-filter: blur(18px) saturate(135%)` + `border: 0`。**此前这条规则只有声明是对的**：`.composer` 自己带着 `backdrop-filter`，于是它是所有后代的 *backdrop root*——后代的模糊只能采样这个根里已经画出来的内容，而添加菜单与权限选择器是它的后代、又整个浮在它的盒子外面，背后什么都没画，`blur(18px)` 因此是彻底的空操作，两个面板读成"清晰页面透过 0.75 深色填充"而不是玻璃；模型选择器被 portal 到 `document.body`（backdrop root 是文档）所以早就正常——三个菜单这才互不一致。Chromium 152 实测（高对比条纹背景、条纹节距 16px、填充 0.75 下条纹残留约 64/255）：条纹在 `.add-menu-panel` / `.model-picker-panel` 内部保留约 60/255 的相邻亮度差，而输入框本身只有约 1/255；把完全相同的标记移出 `.composer` 立刻回到约 1/255，唯一变量就是 backdrop root。修法是把材质从 `.composer` 挪到内缩的 `.composer::before`（`inset: 0` + `z-index: -1` + `border-radius: var(--radius-composer-input)` + `corner-shape: var(--corner-shape)`）：`.composer` 变透明、不再是 backdrop root，三个弹层的模糊这才采到真实页面，而 `::before` 自己的模糊照旧。`z-index: -1` 让这层玻璃落在内容之下，`.composer` 只给 `position: relative`、不给 `z-index`，因此不新增堆叠上下文、弹层与 `.task-progress-anchor` 的相对次序不变；这层负层级能盖在页面背景之上，靠 `.composer-shell` 的 `z-index: 40`（`chat-layout-stability.test.ts` 钉住）。同时把三个弹层的圆角从 `var(--radius-ui)`（10px）对齐到输入框的 `var(--radius-composer-input)`（14px），并把 `.model-picker-panel` 的阴影从 `0 20px 54px rgba(0,0,0,0.46)` 收敛到与其余弹层一致的 `0 22px 54px rgba(0,0,0,0.44)`。各面板的几何仍归自己所有，**材质只在这一处声明**——新增输入栏弹层时把它加进那条共享规则的选列表，不要在面板体里另写背景或边框。

模型能力和权限策略来自 shared/runtime 配置；这里不保存密钥，不自行执行文件或工具操作。
