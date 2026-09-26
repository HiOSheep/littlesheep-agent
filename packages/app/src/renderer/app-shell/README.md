# Renderer 应用壳
最后更新：2026-09-27 02:33:27

这里负责把各 Renderer 领域组合成一个应用界面，不拥有会话、记忆、项目或工作区的权威数据。

- `app-view.tsx`：装配 `sidebar-view.tsx`、`core-workspace-view.tsx` 和 `overlays-view.tsx`；`chat-view.tsx` 承载消息列表和跟踪卡，**不再自己拥有滚动状态**——滚动位置、底部吸附、阅读锚点与"回到最新"入口都来自 `chat/use-chat-scroll-controller.ts`（UX-19），视图只渲染 `.messages`、`onScroll`/`onClickCapture` 和那个按钮；`composer-view.tsx`、`conversation-section-view.tsx`、`workspace-dock-view.tsx`、`sidebar-resizer-view.tsx` 是各区段的稳定表面。**"回到最新"是一个从输入框边缘长出来的圆形玻璃按钮**（2026-09-26）：只显示向下箭头（`--jump-to-latest-arrow` 天蓝），几何与材质见 `styles/05-chat-messages.css`；为了让"先长出来、再收回输入框"这个过渡能放完，它在 `readingAway` 变假之后**多挂载一个 `JUMP_MOTION_MS`**（180 ms），用 `data-motion`（`entering` / `settled` / `exiting`）驱动，退出期间 `tabIndex=-1` + `aria-hidden`，所以 DOM 里短暂存在的只是一个不可聚焦的收尾动画，不要据此判断"读者还在上面"——判断要么等它消失，要么读 `data-motion`。计时用 `setTimeout` 而不是 `requestAnimationFrame`：不被合成的窗口不派发帧。
- `composer-view.tsx`：输入栏表面。Enter 走 `ui/enter-confirm.ts` 的共享规则；运行中同时保留停止入口（请求发出后显示“正在停止当前任务”，直到 run 结束才复位）和草稿存在时的补充发送入口，两者不互相替换。停止的“一次请求”约束仍由 `chat/run-actions.ts` 持有。模型选择器在无可用模型时把 `openSettingsPage('api')` 与 `refreshRuntime` 交给 `RuntimePicker`，只做路由切换，不清空当前文字与附件；从设置返回后由既有的 `settingsOpen` 变化 effect 重新读取 Runtime。发送入口另受 `runtime-readiness/use-runtime-readiness` 的就绪事实约束：未就绪时原地禁用并使用 Runtime 的原因，草稿与焦点保持不变（`scripts/verify-desktop-cold-start-interaction.mjs` 在真实窗口上验证该契约）。正常启动的阶段文字由 `runtime-readiness/composer-readiness-hint` 就地渲染在 `.composer-right` 内（发送按钮左侧），因此普通启动不会出现横跨整窗的状态条；只有失败才回到整窗条带。
- `use-app-controller.ts`：兼容控制器，协调领域动作，并持有有界会话首屏历史缓存、持久化默认工作区与当前选中会话的工作区覆盖；`use-app-view-controller.ts` 经 `app-controller-projections.ts` 投影出视图契约。启动恢复上次会话时使用保留路由的加载路径，避免覆盖持久化的设置页；普通手动切换仍进入对话。`runtime-actions.ts` 刷新配置和模型时更新默认工作区并保留当前会话的视图覆盖；用户显式选目录仍通过配置事务保存。标题栏胶囊要的那份状态不在这里拼：`titlebar-task.ts` 把会话列表、转录与聊天时钟折成 `titlebarTask`（标题 / 是否有会话 / 最新 run 活动 / 时钟）并导出 `latestRunActivity`，胶囊与 composer 因此读同一份"最新活动"，组合面也不必为一个展示关注点继续增长。
- `runtime-actions.ts`、`attachment-actions.ts`、`link-navigation-actions.ts`、`session-permission-mode.ts`：运行时刷新与模型补丁、附件与拖放、内外链接策略、按会话解析权限模式。`applyRuntimePatch` 保持布尔结果；`applyRuntimePatchReporting` 走同一事务但把失败文本返回给调用方，供设置页在原地显示失败并重试。`chooseWorkspacePath` 是目录选择器的动作：项目会话按项目目录运行，保存默认目录并不会搬动它，所以用户这一次显式选择同时写入该会话的目录（`PATCH /sessions/:id`），独立会话仍只跟随默认目录。
- `use-navigation-controller.ts`、`navigation.ts`、`types.ts`：有界的前进/后退历史、设置转场和全局路由。
- `persistent-state.ts`、`use-app-persistence.ts`：版本化恢复快照与有界写入节流；瞬态 UI 和授权只留在内存。
- `preferences.ts`、`list-motion.ts`：Renderer 偏好和列表过渡的纯客户端辅助；工作区文件导航折叠状态与审阅 Monaco 单列/双列偏好使用独立 key，均为 best-effort 本地 UI 状态，不进入会话或任务恢复数据。
- `use-app-controller.ts`、`app-controller-projections.ts`、`workspace-dock-view.tsx` 把会话现场的**两个**导航宽度转发给拓展工作区（UX-18）：`workspaceFileNavigatorWidth` 与 `workspaceReviewNavigatorWidth`（以及各自 setter）。投影字段列表必须成对保留，否则审阅宽度会退回共享的 `fileNavigatorWidth`，拖宽审阅列表就会连带移动文件导航。

新增业务行为应进入对应领域控制器，不要继续扩大 `use-app-controller.ts`；修改导航时必须回归设置、拓展工作区、标签和重启恢复。

`runtime-actions.test.ts` 固定目录选择落点的四条：项目会话同时写会话与默认目录且先写会话（失败不留半应用状态）、独立会话只改默认目录、取消选择或窗口已卸载什么都不做、会话写入失败时报错且不改默认目录。

## 软上限说明

`use-app-controller.ts` 曾到 656 行，超过 600 行硬上限，只能按仓库质量检查的受控登记保留，因为它仍负责装配各领域状态、启动恢复 effect 和视图快照。目录选择的动作已按这条规则下沉到 `runtime-actions.ts` 的 `chooseWorkspacePath`，文件因此保持在 656 行；进一步拆分必须等 Runtime/附件 effect 的输入输出稳定，在此之前禁止把新的领域行为写回该文件，并禁止继续增长。
