# Renderer 对话
最后更新：2026-09-27 22:01:09



## 消息行与用量（2026-09-26）

每条消息下面的操作行按阅读方向排列：agent 回复为 `[复制][分叉][用量][时间]`、靠左；用户消息为 `[时间][分叉][复制]`、靠右。整行同进同退——光标停在这一行上、或焦点落进行内时才出现，详细数字仍在胶囊弹层。复制字形在 `ui/message-icons.tsx` 画成两张圆角纸，分叉字形画成一条路径分向两个端点。分叉按钮调用 `branchConversationFromMessage`：Main 在 `POST /sessions/:id/branch` 按选中的任意已保存用户消息或已完成助手回复截取原始历史，重绑新会话 ID，复制会话所属项目、工作区与权限模式，再打开新分支。

原先压在每条回复下面的那行数字（四种 token、两级缓存命中、速率）改成**一颗胶囊**：`turn-usage-card.tsx` 的 `TurnUsageButton` 打开参考图那样的卡片（供应商/模型、缓存命中、未缓存输入、缓存读取、缓存写入、输出、其中推理、用时、输出速率、请求数），逐调用缓存明细也搬进同一张卡。诚实规则原样保留并集中到 `turnUsageFigures`/`turnOutputRate`：缓存比例只有在每个请求都报了缓存 token 时才是百分比，否则说"部分提供/未提供"；未被上报的数字写"未提供"而不是 0；**统计不完整的回合不给速率**（`usageCompleteness === 'partial'` 直接返回 null），速率优先用 provider 自己计时的请求，没有才退回回合时长。
## 执行过程的展示（2026-09-26）

思考行（`reasoning-row.tsx`，从 `assistant-turn.tsx` 拆出、行内自带折叠状态；`activity-glyph.tsx` 保存各行的图形）在模型还在思考时**自己展开**，文字照旧流式写入同一份 Markdown；一旦读者自己点过，就以读者的选择为准（`reasoningOpenIds`）。这不是新数据源，只是让"思维链要看得到"这件事默认成立。

写入/编辑类工具行多了行数徽章：`tool-line-delta.ts` 从调用参数本身算——`write` 报新增、**不报删除**（被覆盖文件的旧行不在参数里，宁可少一个数字），`edit` 报两侧，补丁按 `+`/`-` 行逐行统计，其它工具**什么都不显示**而不是猜。数字用 `use-animated-count.ts` 从当前显示值继续走到新值（260ms、ease-out，`prefers-reduced-motion` 下直接给值），连续流式更新不会退回旧起点。这一处的红绿是**常显**的（`agent-flow-delta-add/remove`），与产出卡片"悬停才变色"的规则不同。

执行步骤与工具行可各自展开；即使工具没有可展示参数或输出，展开后仍给出明确空态。思考行仅在运行中自动展开，用户点击后由用户的选择控制，正文用流式 Markdown 渲染。以下后续段落保留各领域契约。

这里负责消息、执行过程和渐进式披露的展示，以及把一次流式 run 的事件归并为 UI 状态。

- `types.ts`：消息、步骤、工具、转录行和执行活动的 Renderer 类型。
- `assistant-turn.tsx`、`agent-tool-row.tsx`、`activity-visibility.ts`：回答与可折叠执行过程、工具行渲染，以及执行活动的渐进披露规则。步骤标题与最终回答都经 `../Markdown`；单行活动标签由 `../inline-markdown` 的有界扫描器渲染，因此活动行不必等待解析器、也不把 Markdown 插件链拉进入口依赖图。
- `run-actions.ts`：一次流式 run 的 SSE 顺序、审批桥、停止、用户追加更新和最终收尾；`run-event-handlers.ts` 把流式工具事件归并为实时活动，`run-result-reducer.ts` 把已结束的 run 落到当前回合，`assistant-delta-buffer.ts` 按显示帧合并高频文本增量。
- **失败在界面上不消失（CE-09 的现行契约，回归在 `run-actions.test.ts` / `run-result-reducer.test.ts`）**：`finally` 一定复位 `loading`，因此输入框不会永久停在运行中；确定性的流拒绝（`RunStreamServerError`，含服务端 `error` 帧）与"流结束却没有 result"都会把当前回合置为 `failed` 并原样带上 Runtime 的失败原因，同时把用户输入与附件还给输入栏；中止走 `aborted` 分支。失败回合的正文一律为空——流式预览会被撤回，Runtime 错误行是唯一的用户可见陈述，任何"道歉式"固定文案都不会被生成。
- `run-actions.ts` 的 `stop()` 对同一 run 只提交一次中断请求（重复点击直接被拒绝），本地流的 "正在停止" 展示由输入栏持有，run 结束即复位。
- `active-run-update.ts` 在 Runtime 接收运行中补充后按事件 id 将用户消息插入当前对话，重复响应不重复显示；真正执行由 Harness 的下一次模型请求决定。`verify:composer-stop-append` 以 Provider 请求记录确认补充进入同一 run。
- `activity-model.ts`、`task-progress-indicator.tsx`、`message-meta.tsx`、`chat-scroll-anchor.ts`、`conversation-display.ts`：活动数据变换、进度控件、消息页脚、滚动锚定和显示密度。
- **滚动位置只有一个所有者（UX-19）**：`use-chat-scroll-controller.ts` 持有底部吸附、阅读锚点与"回到最新"状态，`app-shell/chat-view.tsx` 只渲染它给出的 `onScroll`/`onClickCapture` 与按钮。读者在底部附近（`CHAT_STICKY_BOTTOM_THRESHOLD` 内）时视口变化按底边修复；**离开底部后锚点是"正在读的那条消息"而不是"离底部的距离"**——`selectChatVisibleAnchor` 记下第一条仍在视口内的 `data-message-key` 及其位置，`resolveAnchoredScrollTop` 在重排后把它放回原处，并用有界的 display-settle 逐帧收敛（宽度变化会在 ResizeObserver 通知之后继续重排，只测一次会留下尾部跳动）；锚点已不在（历史窗口替换）时不猜、不改动。新输出到达而读者不在底部时只置 `hasNewContent`，由 `.chat-jump-to-latest` 提供可达的返回入口，不把人拽到底部。**这个入口是一个圆形玻璃按钮**（2026-09-26）：与输入框同一种半透明磨砂材质、无描边、只画一个向下的天蓝箭头（`--jump-to-latest-arrow`），底边固定在**输入框可见上沿上方 3px**（`--composer-overlay-height` 从输入栏外壳量起，所以要减去外壳自己的 `--composer-shell-inset-top`；真实窗口实测 gap = 3px）。它从输入框边缘"长出来"、也"收回"输入框：`data-motion` 的三个值（`entering`/`settled`/`exiting`）由 `app-shell/chat-view.tsx` 的状态机给出，视图在 `readingAway` 变假后**多挂载一个动画时长（180 ms）**再卸载；判断"读者是否还在上面"要看 `data-motion` 或等元素消失，不要在退出窗口里按存在与否下结论（`verify:electron-ui-state-continuity` 因此把这步改成有界等待）。箭头是装饰（`pointer-events: none`），命中测试必须落在按钮本身（`verify:chat-reading-scenarios` 的 `hitIsButton` 会因此抓到图标抢命中）。**只有"换了一段对话"才重新贴底**：草稿会话在首次 run 里取得持久 id 时转写并没有换（真实窗口实测：这个瞬间重新贴底会把已经向上滚动的读者拽回底部），加载更早消息会改变首条消息 id 但会话没变——两者都必须保持读者位置；"有新内容"用消息数 + 末条 id + 末条正文长度判定，流式增长同样算新内容。**修复循环必须让位给读者**：hook 记住自己写过的 `scrollTop`，`onScroll` 看到不是自己写的滚动就立刻取消逐帧修复（真实验收里这条是必需项——不取消时"回到最新"会被旧锚点拉回，按钮永不消失）。回归：`chat-scroll-anchor.test.ts`（纯算术）与 `chat-scroll-controller-wiring.test.ts`（接线、让位规则与 CSS 契约）；真实窗口数字由 `verify:electron-ui-state-continuity` 与 `verify:chat-streaming-rendering` 记录。
- `activity-visibility.ts`：渐进披露规则。紧凑显示只折叠"无需关注"的已完成行；未成功的工具调用（含 Runtime 报告的权限拒绝）、失败或中止的准备行、失败的思考行、未通过的验证与失败／结果未知的步骤都必须继续可见（`compactTranscriptEntries` / `activityAttentionLine`），不得因为减少噪声而隐藏需要决定或修复的事实。**折叠只对"已不再运行"的回合生效**（`compactCompleted`），因此等待用户批准的运行中回合在两种模式下的渲染完全相同，"正在等待 write 的权限批准"这条事实在两种模式下都可读。
- `context-projections.ts`、`conversation-turn-fingerprint.ts`：上下文快照的有界无正文投影，以及跨文本、运行时、工作区和附件的稳定回合标识。
- `stream-text-integrity.test.ts`：流式文字完整性的分层探针（UX-20），用一份含标题/列表/链接/引用/代码围栏/中文标点/长段落的确定性样本驱动**真实**的 `consumeRunStream` + `assistant-delta-buffer` + `run-result-reducer`，固定住四条边界：正常流逐字节一致；畸形帧只被跳过、不连累邻居；**结果帧本身无法解析时仍以"结束却没有 result"拒绝，不静默成功**；`aborted`/`failed` 撤回预览而成功 run 用 settlement 文案覆盖预览。增删流式层的语义前先在这里改断言。

验证结论必须按 Runtime 记录呈现：`pass` 显示为“验证通过”，`unverified` 显示为“未验证”，不得渲染成“验证通过”。**两种显示模式都要能读到它**：验证结论属于活动而不是转录行，触发行 `.assistant-process-verification` 在两种模式下都渲染它（`activityVerificationLine`），紧凑模式再由注意力行复述一次。普通模式下每个已结算回合都是 `unverified`，因此这条陈述是常态而不是告警——但它必须存在，否则同一份 run 在一种显示模式下"从未验证过"这件事会完全消失。活动状态只有 `running / done / failed / aborted / paused / waiting_user`，没有 partial：需要"没做完"的说法时用 `aborted`（本轮已停止）、`paused`（本轮已暂停）或 `needs_replan`（验证：需要调整），不要为清单虚构状态。LLM、工具权限和执行状态的权威实现不放在 Renderer；新增事件必须先更新 shared contract 和特征测试。

**执行过程中的"说的话"按正文颜色渲染**：`.assistant-activity-flow` 整体用 `--muted`，好让步骤、工具与思考摘要退到背景；但转录里的散文行（`.agent-transcript-prose`，模型在工具调用之间说给用户的话）不是机械过程，必须显式取回 `--text`，否则用户读到的解释比最终回答更淡、像脚注。只把这一个类改回正文色，步骤/工具/摘要/运行中状态行仍然保持 muted。真实窗口实测：散文行计算色 `rgb(232, 232, 232)`（= `--text` = `.assistant-turn` = 正文），同一容器 `rgb(160, 160, 160)`（= `--muted`）。

`run-actions.ts` 为 337 行，略高于 300 行，因为一次 run 的 SSE 顺序、步骤/工具归并、审批、停止和最终收尾必须维持同一事务边界。后续只有在建立独立事件 reducer 特征测试后才继续拆分，当前不得继续增长。

本地 SSE 观察中断时，`run-transport-recovery.ts` 按 runId 等待权威日志结算，保留已有流式内容；若最终回读仍失败，已收到的预览文字继续保留并明确标记为失败。超大工具输入仍显示准确行数。

工具参数生成时显示可展开的动作行及有界目标摘要；真正的 `tool_start` 到来时，同名准备行原位变为可展开的执行行，避免重复出现“准备 write / exec”。

同模型只读任务对照后，完成的回合默认收起过程，只留“用时”和验证状态；运行中、失败或等待处理默认展开。读者手动展开或收起优先于自动状态，最终回答始终在过程外可见，工具和思考各自的展开仍独立。

- 传输恢复的接线集中在 `run-transport-recovery.ts`（2026-09-27）：`attemptStreamLossRecovery` 负责守卫（服务端流错误不算断流、会话已切走不再套用）、恢复期间的运行中活动行，以及把权威结果应用到会话；`run-actions.ts` 的每回合 catch 只保留调用与两个分支，文件因此回到登记上限以内。

## 一轮只说一遍：触发行、工具行与产出卡（2026-09-27）

**元信息合并到触发行。** 一轮收起后原本把同一件事说三遍：触发行“用时 1m11s / 验证：未验证”、过程末尾再一行验证结论、回答下面再一行“已思考 · N 次工具调用 · 0 条消息”。现在触发行一次说完：`用时 …` + `N 段思考 · N 次调用`（`turnCountsLine`）+ 验证结论；末尾两行删除，并且不再打印“0 条消息”这种零信息量字段。验证结论的显示条件从“仅 `done`”放宽到“只要不在运行中”，失败/中止的回合因此不会丢掉结论；紧凑模式的 `.agent-transcript-attention` 仍然独立保留。`legacy` 无转录的回合回退按 `activity.tools.length` 计数。

**思考必须被看见，所以计数里点名。** `turnCountsLine` 单独数 `kind === 'reasoning'` 的转录行：思考一旦存在，收起的回合也有一行“N 段思考”提示里面有东西可以展开。

**工具行压缩 + 路径独立成块。** `.agent-flow-row` 从 `min-height: 38px` / `padding: 4px` 降到 `32px` / `2px`（14 行常见回合省掉一条消息的高度）。搜索类工具原先把查询词和路径拼成一个字符串（`query · C://…`），现在摘要只留查询词，路径走 `.agent-flow-path` 自己的格子（`shortToolPath` 保留末尾三段），`.agent-tool-row` 的网格因此是 8 列。

**产出成果卡瘦身。** 头部曾是一个 58px 图标撑起 88px 的横幅，比它下面三个文件行还高。现在头部一行 30px（图标 20px），行高 46px→28px、差值按钮 38px→28px、“全部 N 个文件”48px→28px，三个文件的卡片从约 300px 降到约 120px。顺带把卡片里硬编码的 `#343436` / `#737376` / `#f4f4f5` / `#dedee0` 换成 `--surface-3` / `--border-strong` / `--text` / `--muted`，避免以后做亮色主题时整批失效。

## 折叠不再瞬开瞬关，任务行悬停只亮字（2026-09-27）

**每一处折叠都走同一个原语。** `docs/principles/ui-interaction-guidelines.md` 要求"展开/折叠表面使用 `disclosure-panel` 模式，不允许瞬间挂载或卸载"，但执行流里还有四处用原生 `<details>`（思考行、系统提示词、AgentStepGroup、工具参数准备行），过程折叠面则用 `hidden` 属性切 `display`——点一下就是瞬时切换，于是同一屏里工具行是平滑的、它上一行却是硬跳。这五处现在全部走 `chat/disclosure-panel.tsx` 的 `DisclosurePanel`：面板始终留在 DOM 里，`.agent-flow-disclosure` 用 `grid-template-rows: 0fr → 1fr` 配 `opacity` 过渡（`--motion-base` / `--motion-fast`），关闭态由 `inert` + `aria-hidden` 把子树移出 tab 顺序，`disclosure-panel:not(.open)` 继续持有 `interaction-visibility.test.ts` 断言的"关闭时禁指针"。`agent-tool-row.tsx` 里既有的 `agent-tool-details-panel` 是同一技术的既有实现，新的 `.agent-flow-disclosure` 就是它的共享名字。

**两条契约断言随之演进，方向是收紧而不是放宽。** `chat-layout-stability.test.ts` 与 `assistant-turn.test.ts` 原先断言的是**实现手段**——"过程正文必须带 `hidden={!processOpen}`"、"系统提示词必须是 `<details>`"。那两条断言恰好把修好这件事本身挡住了：它们钉住的正是要换掉的东西。现在改成断言新结构（`DisclosurePanel` + 常驻面板 + `disclosure-panel` 语义类），`interaction-visibility.test.ts` 的清单也把新面板纳入；"不许瞬时挂载/卸载"这条约束由此才真正可执行。

**任务行不再弹原生悬浮框。** `agent-tool-row.tsx` 的路径块与行数徽章原先是聊天区里两个漏网的 `title=`（原生悬浮提示）；仓库的悬浮提示统一在 `ui/floating-help.tsx`，聊天区不在其中。两处 `title` 已删除，`aria-label` 保留（无障碍名称不变），悬停反馈改成**只改文字色**——`button.agent-flow-row:hover` / `:focus-visible` 把 `.agent-flow-title`、`.agent-flow-summary`、`.agent-flow-meta`、`.agent-flow-path` 提到 `--text-strong`，不再铺 `rgba(255, 255, 255, 0.028)` 的背景块；已展开的工具行（`.agent-tool-call.open > .agent-tool-row`）同样只亮字。

**执行流的字号回到同一梯度。** `08-activity.css` 里 `.agent-flow-row` 曾硬编码 `font-size: 15px`——比对话正文（`--chat-message-font-size`，14px）还大，且与它所在容器 `.assistant-activity-flow` 的 13px 打架；行内 meta/path 12px、行数徽章 11px 也是散值。现在该文件的 **20 处 `font-size` 全部走 `:root` 的三个令牌**：行 13px（`--activity-row-font-size`）、元信息 12px（`--activity-meta-font-size`）、徽章 11px（`--activity-badge-font-size`）。

## 操作行整行同进同退，间距按字形量（2026-09-27）

**用量胶囊不再常显。** `05-chat-messages.css` 里 `.message-meta` 一直是 `opacity: 0`、靠 `:hover`/`:focus-within` 淡入，但后面跟了一条 `.message-meta:has(.message-meta-usage) { opacity: 1 }`：带用量胶囊的助手回复整行被钉住常显。结果同一行里胶囊永远亮着、复制/分叉/时间却随悬停闪进闪出——看起来不像同一层表面的东西，也是那一行里唯一无法让它消失的元素。那条例外已删除，复制、分叉、用量、时间**同进同退**。

`pointer-events` 即使 `opacity: 0` 也保持 `auto`：隐藏的行仍是一个活的命中面（鼠标要能落在它上面才能把它唤出来），不是一条死带。这条靠 `message-meta.test.ts` 守住——断言不是"存在一条 opacity 规则"，而是**枚举每一条设置该行自身 opacity 的规则**，要求只有"基础隐藏"和"共享的 hover/focus 显示"两种状态；把 `:has(...)` 例外加回去会立刻失败。

**间距从"命中盒之间"改到"字形之间"。** 图标按钮原本是 28×28 的盒子套 16px 字形，每边藏着 6px 看不见的内边距，于是行自己的 8px `gap` 渲染出来是：字形↔字形 20px、字形↔用量胶囊 14px、胶囊↔时间 8px——三级递减，同一行里三个不一样的节奏。现在按钮盒收到 **24×24**（字形仍 16px，每边 4px，24 也是这一行允许的最小点击目标），再用 `margin-inline: -4px` 把这 4px 交还给布局，行自己补 `padding-inline: 4px`，首尾图标因此与消息正文对齐。三处可见间距统一为 **8px**，且相邻命中盒正好相接、不重叠（悬停不会有死区，也不会有两块区域争同一次点击）。四个数字（盒 24、字形 16、行 padding 4、按钮负 margin -4）在 `message-meta.test.ts` 里一起断言，单独动其中一个就会破坏节奏。

## 关键状态不随过程一起折叠（O1，2026-09-27）

**注意力行搬出可折叠区。** `activityAttentionLine` 原先渲染在过程正文（`DisclosurePanel`）里面：紧凑模式折起正文时读者还能看到那一行，但**读者自己在普通模式点一下触发行把它折起来，同一批事实就一起消失了**——而"失败、权限拒绝、未验证、待决策始终可见"恰恰要在读者折叠之后也成立。现在这一行由 `chat/attention-row.tsx` 渲染在触发行与过程正文**之间**（`assistant-turn.tsx`），在两种显示模式下都只有一个位置，正文里不再有第二份；`AssistantTranscript` 因此不再需要 `activityAttentionLine`，也顺带去掉了它和触发行重复的那条页脚。`.agent-transcript-attention` 只加了两条布局属性（`max-width: 820px`、`margin: 4px 0 0`），因为它不再是正文里的一行、而要顶住其后正文的上边缘。

**"未完成的步骤"包括结果未知的那一种。** 原判据只数 `status === 'failed'` 的步骤。一轮在工具还没回报结果时结束时，Reducer 会把该步骤标成 `unknown`（`run-result-reducer.ts`）——那不是失败，但也不是完成；折起来读就是"缺失的结果"被当成"做完了"。现在 `failed` 与 `unknown` 一起计入，措辞从"N 个步骤失败"改成"N 个步骤未完成"（覆盖两种状态，且不把未知说成失败）。

**调用失败分"仍未解决"和"已由后续调用恢复"。** 记录在案的失败不会因为后续成功而消失，但"还在影响结果的问题"和"已经翻篇的历史失败"必须能分开读。判据直接沿用 Runtime 自己的规则：`harness/stages/verify/task-state.ts` 的 `runtimeExecutionEvidenceGap` 认为**同一步骤里更晚的一次成功调用**会顶掉这次未成功的调用；`classifyCallFailures` 用同一条规则把失败分成 `recovered` 与未解决，注意力行分别写成"N 次调用失败"和"N 次失败已由后续调用恢复"，两者同时成立时再补一句"本轮无未解决失败"。没带 `stepId` 的调用**永远算未解决**：没有可顶替的步骤，猜一条别的规则就会让未解决的问题读成历史。

**验证结论只留一个主位置。** 结论在触发行（`.assistant-process-verification`）渲染，两种模式下都在；紧凑模式的注意力行复述它，因为它属于"折起来也必须看得到"的那批事实。`verify:transcript-state-visibility` 的断言随结构一起改：它原先等的是 `[data-transcript-verification="true"]`，而那个元素在"元信息合并到触发行"（2026-09-27）时就已经不存在了，门因此**从那时起一直红在第一处等待上**（`timed out waiting for a settled turn with a verification verdict`），不是本轮引入的。同一条门新增第 6 类场景：在真实窗口里**点击触发行把过程折起来**，普通与紧凑两种模式各测一次，断言 `aria-hidden/inert` 真的落下、注意力行不是正文面板的后代、失败行仍在（折叠而不是丢弃）。
