# Electron Renderer
最后更新：2026-09-25 07:12:30

Renderer 负责聊天、导航、设置、记忆树、归档和拓展工作区的可视交互。会话列表只取索引，选中才读取消息；切换后的未完成读取保留在有界内存缓存中，不阻止新会话直接进入对话。

首屏依赖：Monaco、mermaid 与 `react-syntax-highlighter` 都必须按需加载（实测完整 Prism 构建单独求值约 380 ms、入口 chunk 因此少 936 KB、真实首帧早约 148 ms）；代码块在高亮 chunk 到达前用 `Markdown.tsx` 的等宽纯文本回退呈现，复用相同 class 与内联样式以避免布局跳动。`inline-markdown.tsx` 负责活动行的单行标签（有界扫描器，不引入解析器）。**注意：入口字节数在本应用里不是首帧的可靠代理**——Markdown 解析管线整条按需（入口 −400 KB）与 dompurify 按需（−49 KB）都实测无收益并已回退，新增加载态前必须以成对实测证明收益，详见 `docs/reference/cold-start-baseline/`。

## 入口与所有权

- `workspace/workspace-timing.ts`：CS-08 的两个可用性阶段（首个目录行、首个文件正文被绘制）上报；`api/workspace-files.ts` 的请求路径由 `LOCAL_APP_API_ROUTES` 插值构造并有 `workspace-client-paths.test.ts` 护栏（2026-09-24 曾因缺少 `${` 导致右侧完全不可用）。`workspace/layout-ownership.ts` 决定启动期草稿布局归属哪一段会话（由进入的第一段会话认领），判据见该目录 README。
- `main.tsx`：React 挂载；同时启动渲染器自报的首帧观察（`runtime-readiness/renderer-timing.ts`，仅在 `LITTLESHEEP_BOOTSTRAP_TIMING=1` 时有产出）。
- `App.tsx`：16 行兼容入口，装配 `app-shell` 控制器与就绪提示，不承载业务逻辑。
- `app-shell/`：顶层视图、导航历史和控制器组合。
- `runtime-readiness/`：执行就绪的唯一渲染器侧事实源（查询+订阅+补读）、启动阶段文字与渲染器自报首帧计时。窗口早于 Runner 出现，能力是否可用必须来自这里，不得由视图猜测（详见该目录 README）。正常启动的阶段文字由 `composer-readiness-hint` 就地显示在发送按钮旁，整窗条带只服务失败态（CS-09：不再有横跨整窗的启动状态条）。需要 Runner 才能做的工作（例如加载某段对话的历史）用 `runtime-readiness-state.ts` 的 `waitForExecutionReady()` 等待，而不是在未就绪窗口里发请求、再把 503 渲染成失败。
- `ui/display-frame.ts`、`ui/display-synced-settle.ts`：合并重复失效请求，并基于 `requestAnimationFrame` 时间戳进行有界布局收敛；当前显示器 VSync 是有效 FPS 上限，稳定后不再申请帧。
- `ui/feedback.ts`、`ui/feedback-notice.tsx`：异步操作反馈的唯一结构（`tone` 字段决定色调与 `status`/`alert`，长错误有界并折叠在“技术详情”里，重试动作在 pending 时禁用）。五类写操作的失败必须留在发起处：供应商保存、阈值保存、渠道重载、插件启停、文件保存——工作区文件保存的状态行还要跨过它自己触发的那次预览刷新（`已保存` 曾被同一次重置清掉）。真实窗口注入见 `pnpm run verify:async-feedback`。
- `ui/README.md` 的状态样本是共享角色的唯一清单：错误文本、危险控件、行内通知几何、常规/提交/页头/段内动作和禁用态各有唯一 token（`--feedback-danger-text`、`--notice-padding-*`/`--notice-font-size`、`--control-height-md|sm|row`、`--control-disabled-opacity`、`--choice-disabled-opacity`）。UX-14 的实机验收 `pnpm run verify:shared-ui-roles` 在真实窗口里逐条测量：对话框校验错误与五处历史浅红都是 `rgb(255, 210, 210)`、插件成功/失败通知都是 8px/10px/12px 且字号 12px、设置页头动作 32px、段内紧凑动作 30px、进行中的操作用 0.42 禁用并配文字（保存中/加载中/清除中）、`prefers-reduced-motion` 下 0.14s/0.18s 的动效塌到 0.001s；源侧契约由 `ui-state-consistency.test.ts` 守住。密集行、工具条与选择器角色**没有**收敛，取值与理由记在该目录 README。
- `approval/`、`chat/`、`composer/`、`runtime/`、`runtime-recovery/`、`runtime-readiness/`、`settings/`、`sidebar/`、`ui/`、`workspace/`：按责任域拆分的 Renderer 实现。
- `styles/`：跨领域样式。共享外壳的定位契约要当成布局事实读：`.workspace-files-navigator` 的 `position: absolute` 只适用于 `.workspace-shared-file-navigator` 这个 flex 占位项内部的普通目录导航；审阅标签的导航是 `.workspace-review` 的直接子元素，必须留在 flex 行内（`04-workspace.css` 的 `.workspace-files > .workspace-files-navigator` 规则），否则它会盖住 Diff 表面和标题行按钮（UX-18 实机验收记录：两个图标按钮与导航刷新按钮落在同一矩形，指针不可达）。**窄宽度下的布局切换用容器查询**：`07-overlays-settings.css` 在 560px 以下把供应商模型行从四列改为堆叠并显示每字段标签；实测 800×600 最小窗口下原布局只剩 62px/44px 两个可输入字段（UX-15）。窗口级与缩放级的可用性走查见 `pnpm run verify:narrow-high-dpi-forms`。
- `runtime-recovery/`：启动恢复入口与对话框。发现失败、损坏记录、待补充信息和待恢复任务是不同事实，收敛成同一个安静入口：失败可重试、聊天保持可用、不自动打开弹窗，重试只重读列表而不重跑已结算操作（详见该目录 README）。诊断文案的两个计数互斥：`invalidFiles` 是最近一次扫描读不出来的记录数，`warningCount` 只统计残留临时文件、目录读写异常等不属于这些记录的发现，因此一份坏记录不会被同时说成“无法读取”和“不完整”。
- `api.ts`：22 行 Local App API 兼容 barrel；领域客户端位于 `api/`。
- `TraceCard.tsx`、`MemoryTreeView.tsx`、`ArchiveManager.tsx`、`MemorySkills.tsx`、`ChannelConnections.tsx`：仍保留的独立领域视图，由 `settings/workspace.tsx` 的归档、技能和外部渠道页复用；其中记忆页只显示六份权威记忆文件并仅允许编辑 `SOUL.md`，不承载 Atom、向量或记忆写入入口。**一个功能只有一个名字**：`ChannelConnections.tsx` 的标题、空态、反馈文案与导航条目都写「外部渠道」（标题曾是「渠道连接」，与导航条目不一致，UX-12/UX-13 实机验收发现并统一）；三处入口的名称与返回位置由 `pnpm run verify:settings-navigation-terminology` 在真实窗口走查。
- `ArchiveManager.tsx`：归档项目的永久删除先经 `ui/danger-confirm.tsx` 确认，文案由 `deletion-impact.ts` 按 Local App API 的真实行为生成（删除项目记录会连同其归档对话和本地消息记录，磁盘项目文件夹保留）。删除期间确认动作单次提交，失败留在确认层内。可恢复的归档操作保持单次点击。**防重复必须是同步的 `deletingRef`，不能只靠 `deleting` state**：同一 task 内的两次点击都读到 state 的旧值，实测会在确认层上发出两次 DELETE（`verify:deletion-confirmation` 连点断言，回归在 `deletion-impact.test.ts`）。
- `MemorySkills.tsx`、`skill-catalog-state.ts`：技能页的加载中、成功为空、成功有数据和失败是四种不同结果；重新加载失败保留已有列表并标注未刷新，详情读取失败保留列表与当前选择并提供重试。状态规则是纯 reducer，可在无窗口环境下回归。**页头必须有可点的刷新入口**（`dialog-header` 里的"刷新"，复用 `ms-feedback-action` 样式）：否则"保留列表并标注未刷新"这条分支在界面上不可达——此前只有失败后才出现重载按钮，加载成功的页面无法再刷新（`verify:skills-catalog-states` 实机验收发现）。
- `deletion-impact.ts`：不可逆删除的对象、影响和保留项的唯一文案来源；供应商删除只描述配置条目移除，密钥仍留在系统密钥库，并提示当前选中模型是否来自该供应商。
- `channel-status.ts`：渠道总体状态的唯一派生口。总体标签由已加载渠道的真实 `running` 与失败项计数得出（未配置/未运行/部分运行/运行中），不把“列表非空”或“已配置”当成连接健康；列表标题与逐项标签使用同一批事实。**后端契约**：载荷里的 `channels` 只含正在运行的实例（`PluginHost.listChannels()` 读渠道管理器的运行表，`stop()` 移出条目、启动失败进 `failures`），因此"已加载但已停止"的条目在当前后端不可达——总体状态里那句不可达文案已按契约改成陈述配置事实（"已配置 N 个渠道（M 个启用），当前没有渠道在运行"），逐项 `running` 判定保留为防御路径。四种 fixture（空配置 / 全部停用 / 运行中含失败 / 全部运行）的标签、计数与取色核对见 `pnpm run verify:channel-entry-states`。
- `settings/models.tsx`、`settings/model-provider-editor.tsx`、`settings/model-provider-draft.ts`：模型供应商页的卡片视图、编辑对话框和纯校验；自定义供应商使用 OpenAI 兼容接口，密钥经 Main 写入系统密钥库，模型元数据（上下文窗口、最大输出、推理档位）只按用户声明使用，未声明即保持未知。**编辑会话与离开保护**（UX-06）：草稿放在模块内存的 `provider-editor-session.ts`（不落盘、不写日志），所以切页再回来时它还在——回到该页会**直接带着草稿重新打开编辑器**；`关闭/取消` 在有未保存修改时**先问再丢**（`provider-editor-discard`：继续编辑 / 丢弃修改），不会静默丢失，保存中则两者都禁用。真实窗口实测（`verify:provider-editor-draft`）：切页后草稿名仍在（脏状态标签优先于"已恢复…"），丢弃不发任何保存请求，注入 500 后失败原因与可修正内容都留在编辑器里。
- `composer/context-usage-indicator.tsx` 除上下文窗口占用外，还显示**会话累计缓存命中率**与 `缓存读取 / 输入` 原值（含冷启动，与验收账本同源）；展示层 `toFixed(1)` 四舍五入，判定层始终用精确值。
- `composer/runtime-availability.ts` 是"选择器里没有可选模型"的唯一判据，四种事实分开：读取中、读取失败（可重试）、还没有配置（给出配置入口）、供应商已保存但不可用（缺密钥或缺模型条目）、以及**供应商可用但还没选模型**（`no-selection`，只指向菜单里的模型列表）。最后一种此前被并入"不可用"，于是刚存好密钥和模型条目的用户被告知"可能缺少 API 密钥，或没有填写模型条目"（UX-11 实机验收发现）。真实窗口流程见 `pnpm run verify:no-model-config-loop`。
- `chat/assistant-turn.tsx`：一轮 Agent 的思考摘要、真实执行过程、验证和最终结果渐进披露。
- `Markdown.tsx`、`link-navigation.tsx`、`workspace/browser.tsx`：全局链接单击进入 LS 内置预览；网页由独立的有界 URL 历史驱动前进、后退和刷新，网页内部跳转不会污染全局应用导航。
- `workspace/preview-pane.tsx`、`workspace/code-editor.tsx` 与主进程 Office 预览服务：代码和普通文本使用共享内置编辑器；普通 Markdown 文件默认渲染，查看源码或编辑时才挂载共享 Monaco，而 Git 审阅中的 Markdown 仍显示源代码 Diff。普通文件和审阅主表面铺满拓展工作区的可用宽度与底部，不绘制外围圆角、边框或整面 hover 反馈；右侧文件导航贴边并仅保留左分隔线。普通查看和审阅统一保留舒适的行号/代码间距；审阅行号、增删计数与连续 5px 左缘使用不透明的 `#02A243` / `#DE352E`，代码行使用在 `#101010` 上合成为 `#1A2B1C` / `#371D17` 的单层 50% 透明底色；单列内联删除视图区也绘制整段连续红色左缘，字符级背景、整块 gutter 背景及会形成方块伪影的 Diff text border 均不绘制；Office/OpenDocument 以有界只读文本预览呈现，二进制正文不进入 Renderer。
- `workspace-persistence.ts`：会话现场的版本化布局（含 `fileNavigatorWidth` 与 `reviewNavigatorWidth` 两个独立导航宽度，UX-18）。hydrate/serialize 对两者分别按 `WORKSPACE_FILE_NAVIGATOR_WIDTH_*` clamp；旧快照缺 `reviewNavigatorWidth` 时回落到默认宽度，而不是继承文件导航的当前值。
- `chat/use-chat-scroll-controller.ts`：对话区滚动位置的唯一所有者（UX-19）。底部吸附、阅读锚点与"回到最新"状态都在这里，`app-shell/chat-view.tsx` 只渲染它给出的回调与按钮（该文件因此从 299 行降到 112 行，不再是热点候选）。判定用 `chat/chat-scroll-anchor.ts` 的纯函数：读者离开底部后，锚点是"正在读的那条消息"（`data-message-key` + 视口内位置），不是"离底部的距离"——后者会让任何视口高度变化把读者推移同样的像素数。真实窗口实测（`verify:electron-ui-state-continuity`）：视口高度变化后锚点位移 0.00 px、宽度重排后 0.29 px，而底边距离按视口变化量改变（1547.67 → 1667.67，+120）；"回到最新"点按后 `gapAfterReturn ≈ -0.33` 且按钮消失，贴底读者在同样的变化后仍为 `-0.33`。流式场景由 `verify:chat-streaming-rendering` 覆盖：读者在输出中途向上滚动后，**答案剩余部分到达期间锚点位移 0 px**、提示出现，点按返回后底边距离 1 px。
- `chat/use-chat-scroll-controller.ts` 的相邻规则：**只有真正的会话切换才重新贴底**。草稿会话在首次 run 中取得持久 id 时转写未变（真实窗口实测这一次重新贴底把向上滚动的读者拽回底部），加载更早消息会改变首条消息 id 但会话未变——两者都必须保持读者位置。

Renderer 拥有临时 UI 状态和交互编排，不拥有会话、记忆、项目、密钥或工作区文件的权威数据。

请求里的工作区目录是**默认值**，不是裁决：渲染器随每次 run 下发 Runtime 当前工作区（`chat/run-actions.ts`），而一个已绑定项目的会话按自己的目录运行，Main 侧因此会忽略这次下发（见 `src/main/local-app-api/README.md` 的 `resolveOwnedRunWorkspace`）。反过来，用户显式给当前项目会话换目录时，`app-shell/runtime-actions.ts` 的 `chooseWorkspacePath` 必须同时写入该会话（`api/sessions.ts` 的 `updateSessionWorkspace`），否则默认目录改了、会话却还在原处；独立会话没有这层绑定，只跟随默认目录。

**失败不会在界面上消失**（CE-09 的现行契约，回归在 `chat/run-actions.test.ts`、`chat/run-result-reducer.test.ts`、`shared/history-activity.test.ts`）：一次 run 的终态由 `finally` 复位 `loading`，所以输入框不会永久停在运行中；确定性的流拒绝、流结束却没有 result、`ok` 却没有已结算回复都变成当前回合的 `failed` 且原样带上 Runtime 原因，中止走 `aborted`；失败回合的正文为空，流式预览被撤回，Runtime 状态行是唯一的用户可见陈述。刷新或重开会话时由 `shared/history-activity.ts` 从持久化消息与执行日志重建同一状态，没有 assistant 消息的 run 也会得到一行不写入转录的 Runtime 状态行；启动恢复只重读列表、不自动弹窗（见 `runtime-recovery/README.md`）。这条契约的前提是"流本身没被单个坏帧打死"：SSE 解析层只跳过无法解析的帧（见 `api/README.md`），丢字的定性证据与分层探针在 `chat/stream-text-integrity.test.ts`。流式尾部反复解析、完成态整篇重渲染，以及代码块从纯文本回退切到高亮组件，都只是**待录屏取证的变色候选**，没有真实窗口证据前不得据此改样式。

用户可见的 Agent 自然语言也不由 Renderer 拼装：回复、澄清、任务说明、步骤摘要、验证说明和交付表达必须来自真实 LLM 调用，并结合运行时 `SOUL.md`、用户语言与已验证事实。Renderer 只呈现 Runtime 下发的最终文案，以及按钮、状态枚举、进度、路径、权限结果等机器事实；发布身份、幂等和去重由 Runtime 的持久化会话注册表负责，Renderer 不因措辞与上一回合相同而合并、改写或抑制消息，也不在回复为空时套用固定人格文案，只显示 Runtime 错误/状态。

## 依赖与禁止事项

- 只能通过 `api.ts` 或后续领域客户端访问主进程能力。
- 禁止直接使用 Node.js、读写用户数据、复制主进程索引或自行执行工具。
- 动画、浮层、导航和渐进式披露遵守 `docs/principles/ui-interaction-guidelines.md`。

## 测试与修改定位

- 纯状态、历史、布局和 Context 展示测试与实现同目录；跨域行为优先添加 shared contract 或 controller 特征测试。
- 视觉或交互变更还需构建、刷新桌面快捷方式并进行真实窗口验收。
