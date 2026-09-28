# Renderer 应用壳
最后更新：2026-09-28 20:46:32

Beta 的标题栏与侧栏共用同一个 L 形底层材质，子区域不再各叠一层玻璃；交接处没有色差或分隔。两种窗口布局均已移除标题栏里的 LittleSheep 文字和小羊图标，侧栏自身内容不受影响。

窗口结构现在按原生状态切换：use-window-chrome.ts 通过 preload 订阅 Main，在根节点投影 data-window-layout 与 data-native-backdrop。app-view.tsx 保持同一组组件，14-window-layout.css 将最大化/全屏映射为 Beta（整宽标题栏、侧栏下移一行），普通窗口使用下面描述的 Chali；切换不丢失会话、输入或面板状态。

这里负责把各 Renderer 领域组合成一个应用界面，不拥有会话、记忆、项目或工作区的权威数据。

**普通窗口的 Chali 结构（2026-09-28）**：`app-view.tsx` 把标题栏移进 `.app` 网格，侧栏那一列因此整列贯通窗口顶边，32px 顶部条只从侧栏右边缘开始、到窗口右边缘结束。`app-view.tsx` 同时渲染新的 `WindowDragRegion`（`.window-drag-band`，占 `grid-column: 1; grid-row: 1`），与标题栏一起拼出整条可拖拽顶边——折叠侧栏时它宽度归零，标题栏自动接管整条边。设置交接的 `aria-hidden` / `inert` 从 `.app` 移到新的 `.app-panels`（`display: contents`，只包侧栏与工作区），所以设置打开时拖拽带仍然可用：这是 alpha 里整宽标题栏一直享有的契约。
**三个窗口导航控件是壳层固定层（2026-09-28）**：`WindowNavControls`（`../sidebar/global-titlebar.tsx`）由 `app-view.tsx` 渲染为 `.window-shell` 的直接子元素，位置在 `.primary-workspace` **之前**——顺序是有意的，工作区面板的角标与窗口开关共用 `.sidebar-toggle-btn`，把控件放在面板之前才保住"裸类名查询 = 窗口开关"这条既有约定。它必须留在 `.primary-workspace` 之外：该容器是 `z-index: 1` 的堆叠上下文，设置浮层（1000/1001）永远画在它上面，控件若在面板里就不可能停在设置侧栏覆盖的那块左上角。完整坐标、`z-index` 层级与实测数字见 `../README.md` 与 `../sidebar/README.md`。

`chat-view.tsx` 在普通消息与带执行过程的助手回合两条渲染路径上，都向产出卡片传入工作区路径和文件审阅动作；缺少工作区路径只影响 Git 行数读取，不应退回旧的文件网格。

同一视图也为用户消息和助手回复接入分叉动作；用量胶囊由助手回复组件交给消息操作行，位于分叉与时间之间。

侧边栏品牌只留名字（2026-09-26）：`sidebar-view.tsx` 的 `.brand-block` 里只有 `.brand-title`「LittleSheep」，原来那行「本地 Agent 工作台」连同 `.brand-subtitle` 规则一起删除，下边距从 16px 收到 12px——**不给人去楼空的高度**。真实窗口实测：`.brand-subtitle` 数量 0，`.brand-block` 高 31px（标题行盒 19 + 下边距 12），快捷导航紧接着从块的底边开始。

- `app-view.tsx`：装配 `sidebar-view.tsx`、`core-workspace-view.tsx` 和 `overlays-view.tsx`；`chat-view.tsx` 承载消息列表和跟踪卡，**不再自己拥有滚动状态**——滚动位置、底部吸附、阅读锚点与"回到最新"入口都来自 `chat/use-chat-scroll-controller.ts`（UX-19），视图只渲染 `.messages`、`onScroll`/`onClickCapture` 和那个按钮；`composer-view.tsx`、`conversation-section-view.tsx`、`workspace-dock-view.tsx`、`sidebar-resizer-view.tsx` 是各区段的稳定表面。**"回到最新"是一个从输入框边缘长出来的圆形玻璃按钮**（2026-09-26）：只显示向下箭头（`--jump-to-latest-arrow` 天蓝），几何与材质见 `styles/05-chat-messages.css`；为了让"先长出来、再收回输入框"这个过渡能放完，它在 `readingAway` 变假之后**多挂载一个 `JUMP_MOTION_MS`**（180 ms），用 `data-motion`（`entering` / `settled` / `exiting`）驱动，退出期间 `tabIndex=-1` + `aria-hidden`，所以 DOM 里短暂存在的只是一个不可聚焦的收尾动画，不要据此判断"读者还在上面"——判断要么等它消失，要么读 `data-motion`。计时用 `setTimeout` 而不是 `requestAnimationFrame`：不被合成的窗口不派发帧。
- `composer-view.tsx`：输入栏表面。Enter 走 `ui/enter-confirm.ts` 的共享规则；运行中同时保留停止入口（请求发出后显示“正在停止当前任务”，直到 run 结束才复位）和草稿存在时的补充发送入口，两者不互相替换。停止的“一次请求”约束仍由 `chat/run-actions.ts` 持有。模型选择器在无可用模型时把 `openSettingsPage('api')` 与 `refreshRuntime` 交给 `RuntimePicker`，只做路由切换，不清空当前文字与附件；从设置返回后由既有的 `settingsOpen` 变化 effect 重新读取 Runtime。发送入口受两条 Runtime 事实约束，且合成**一个**决定（`composer/send-readiness.ts` 的 `describeComposerSendReadiness`）：执行是否可用（`runtime-readiness/use-runtime-readiness`）与是否选中了可用模型（控制器算出的 `modelAvailability`）。按钮与 Enter 是同一条入口、按同一判据拒绝；禁用控件的可访问名与就地显示的 `ComposerSendBlockNotice` 都是 Runtime 自己的那句话，草稿与焦点保持不变（`scripts/verify-desktop-cold-start-interaction.mjs` 与 `scripts/verify-composer-send-gate.mjs` 分别在真实窗口上验证就绪前与无模型两种契约）。正常启动的阶段文字由 `runtime-readiness/composer-readiness-hint` 就地渲染在 `.composer-right` 内（发送按钮左侧），因此普通启动不会出现横跨整窗的状态条；只有失败才回到整窗条带。光标的归属由 `composer/use-composer-focus.ts` 接管（挂载时的 `launch`、新建对话的 `new-session`）：对话框、审批提示和用户自己移走的焦点都不被抢。
- `chat-view.tsx` 的空对话文案来自同一条 `sendReadiness`：没有可用模型时它说的就是那条原因并指向模型设置，而不是邀请一次发不出去的任务（`chat` 投影为此新增 `modelAvailability` 字段）。
- `composer-drafts.ts`、`use-composer-drafts.ts`：**草稿属于一个对话**（P1，2026-09-28）。一份草稿是文字加它旁边的附件卡片，而卡片携带的是添加它们的那个对话的工作区路径；此前这两样都是控制器里的单一全局值，`session-actions.ts` 的 `switchSession` / `newSession` 都不碰它们，唯一的清空在发送时——实测在全新对话里打一段草稿再点侧栏另一个对话，转录切换了（那一行变 `.active`）而输入栏仍握着上一个对话的草稿且发送可用，按 Enter（光标本来就在输入框里）就把它发到错误的线程。现在 `composer-drafts.ts` 持有按 `currentSession ?? 'draft'` 分槽的地图，只有两个迁移：`activate`（显式导航：`switchSession`、`newSession`）显示**目标对话自己的**草稿，没有就是空的，切回来原样恢复；`adopt`（没人导航的迁移：运行结算成它刚创建的会话、当前对话被归档或删除、项目工作区切换）把用户手里的草稿**带走**而不是丢掉，目标槽已有草稿时以目标为准。发送仍经控制器自己的 setter 清空，所以只清被发送的那个对话；`use-app-persistence.ts` 继续只持久化它原来那一条草稿记录，分槽地图只活在运行时。真实窗口门：`pnpm run verify:composer-draft-scope`（切换后必须是空的输入栏、禁用的发送控件与 0 个附件卡片，切回来逐字恢复；并断言未发送的草稿从未到达 Provider）。
- `use-app-controller.ts`：兼容控制器，协调领域动作，并持有有界会话首屏历史缓存、持久化默认工作区与当前选中会话的工作区覆盖；`use-app-view-controller.ts` 经 `app-controller-projections.ts` 投影出视图契约。启动恢复上次会话时使用保留路由的加载路径，避免覆盖持久化的设置页；普通手动切换仍进入对话。`runtime-actions.ts` 刷新配置和模型时更新默认工作区并保留当前会话的视图覆盖；用户显式选目录仍通过配置事务保存。`chat` 投影新增 `openReviewInWorkspace`、`projectPath`、`branchConversationFromMessage` 三个字段（产出卡片的双跳转与消息行的分叉按钮要用），只加字段、不加逻辑；`modelAvailability` 由 `composer/use-model-availability.ts` 算一次后同时进入 `composer` 与 `chat` 投影（选择器、发送入口、空对话文案共用，视图不得各自再算一份）。任务胶囊要的那份状态不在这里拼：`titlebar-task.ts` 把会话列表、转录与聊天时钟折成 `titlebarTask`（标题 / 是否有会话 / 最新 run 活动 / 时钟）并导出 `latestRunActivity`，胶囊与 composer 因此读同一份"最新活动"，组合面也不必为一个展示关注点继续增长。胶囊本身（2026-09-27 起）由 `chat-view.tsx` 渲染在聊天列顶边的 `.running-pill-shell` 浮层里（不再占标题栏），所以 `titlebarTask` 连同它要调用的 `renameSession`、`stop`、`setControlTip` 都走 `chat` 投影，`app` 投影不再持有 `titlebarTask`。
- **失败回合的重试走同一份发送入口（2026-09-28）**：`chat` 投影再新增两个字段——`retryFailedTurn`（`chat/run-actions.ts` 的 `retryFailedTurn(instruction)`，即 `send()` 带上这一轮自己的指令）与 `loading`（它决定按钮此刻能不能按）。视图不新开动作通道，也不在壳层重算运行状态：`chat-view.tsx` 把这两个字段原样交给每个助手回合，由回合自己按 `activity.status === 'failed'` 决定是否渲染重试。
- `runtime-actions.ts`、`attachment-actions.ts`、`link-navigation-actions.ts`、`session-permission-mode.ts`：运行时刷新与模型补丁、附件与拖放、内外链接策略、按会话解析权限模式。`applyRuntimePatch` 保持布尔结果；`applyRuntimePatchReporting` 走同一事务但把失败文本返回给调用方，供设置页在原地显示失败并重试。`chooseWorkspacePath` 是目录选择器的动作：项目会话按项目目录运行，保存默认目录并不会搬动它，所以用户这一次显式选择同时写入该会话的目录（`PATCH /sessions/:id`），独立会话仍只跟随默认目录。
- `use-navigation-controller.ts`、`navigation.ts`、`types.ts`：有界的前进/后退历史、设置转场和全局路由。
- `persistent-state.ts`、`use-app-persistence.ts`：版本化恢复快照与有界写入节流；瞬态 UI 和授权只留在内存。
- `preferences.ts`、`list-motion.ts`：Renderer 偏好和列表过渡的纯客户端辅助；工作区文件导航折叠状态与审阅 Monaco 单列/双列偏好使用独立 key，均为 best-effort 本地 UI 状态，不进入会话或任务恢复数据。
- `use-app-controller.ts`、`app-controller-projections.ts`、`workspace-dock-view.tsx` 把会话现场的**两个**导航宽度转发给拓展工作区（UX-18）：`workspaceFileNavigatorWidth` 与 `workspaceReviewNavigatorWidth`（以及各自 setter）。投影字段列表必须成对保留，否则审阅宽度会退回共享的 `fileNavigatorWidth`，拖宽审阅列表就会连带移动文件导航。

新增业务行为应进入对应领域控制器，不要继续扩大 `use-app-controller.ts`；修改导航时必须回归设置、拓展工作区、标签和重启恢复。

`runtime-actions.test.ts` 固定目录选择落点的四条：项目会话同时写会话与默认目录且先写会话（失败不留半应用状态）、独立会话只改默认目录、取消选择或窗口已卸载什么都不做、会话写入失败时报错且不改默认目录。

## 软上限说明

`use-app-controller.ts` 曾到 656 行，超过 600 行硬上限，只能按仓库质量检查的受控登记保留，因为它仍负责装配各领域状态、启动恢复 effect 和视图快照。目录选择的动作已按这条规则下沉到 `runtime-actions.ts` 的 `chooseWorkspacePath`；模型可用性下沉到 `composer/use-model-availability.ts`（控制器只留一次调用，顺带把两处 memo 收成一行）；草稿下沉到 `use-composer-drafts.ts`。这几次下沉之后实测 651 行，回到了 655 的热点上限以内；下一次改动仍不得让它继续增长。
