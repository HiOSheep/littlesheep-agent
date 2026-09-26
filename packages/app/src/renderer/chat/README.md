## 执行过程的展示（2026-09-26）

思考行（`reasoning-row.tsx`，从 `assistant-turn.tsx` 拆出、行内自带折叠状态；`activity-glyph.tsx` 保存各行的图形）在模型还在思考时**自己展开**，文字照旧流式写入同一份 Markdown；一旦读者自己点过，就以读者的选择为准（`reasoningOpenIds`）。这不是新数据源，只是让"思维链要看得到"这件事默认成立。

写入/编辑类工具行多了行数徽章：`tool-line-delta.ts` 从调用参数本身算——`write` 报新增、**不报删除**（被覆盖文件的旧行不在参数里，宁可少一个数字），`edit` 报两侧，补丁按 `+`/`-` 行逐行统计，其它工具**什么都不显示**而不是猜。数字用 `use-animated-count.ts` 从旧值走到新值（260ms、ease-out，`prefers-reduced-motion` 下直接给值），因为参数是流式到达的：`content`/`new_string` 一边长，计数一边跟着长，读者看到的是"这次编辑正在累加"，而不是最后突然蹦出一个数。这一处的红绿是**常显**的（`agent-flow-delta-add/remove`），与产出卡片"悬停才变色"的规则不同：这是agent刚对文件做了什么的那一行，绿/红就是它的读法。# Renderer 对话
最后更新：2026-09-27 04:12:59

这里负责消息、执行过程和渐进式披露的展示，以及把一次流式 run 的事件归并为 UI 状态。

- `types.ts`：消息、步骤、工具、转录行和执行活动的 Renderer 类型。
- `assistant-turn.tsx`、`agent-tool-row.tsx`、`activity-visibility.ts`：回答与可折叠执行过程、工具行渲染，以及执行活动的渐进披露规则。步骤标题与最终回答都经 `../Markdown`；单行活动标签由 `../inline-markdown` 的有界扫描器渲染，因此活动行不必等待解析器、也不把 Markdown 插件链拉进入口依赖图。
- `run-actions.ts`：一次流式 run 的 SSE 顺序、审批桥、停止、用户追加更新和最终收尾；`run-event-handlers.ts` 把流式工具事件归并为实时活动，`run-result-reducer.ts` 把已结束的 run 落到当前回合，`assistant-delta-buffer.ts` 按显示帧合并高频文本增量。
- **失败在界面上不消失（CE-09 的现行契约，回归在 `run-actions.test.ts` / `run-result-reducer.test.ts`）**：`finally` 一定复位 `loading`，因此输入框不会永久停在运行中；确定性的流拒绝（`RunStreamServerError`，含服务端 `error` 帧）与"流结束却没有 result"都会把当前回合置为 `failed` 并原样带上 Runtime 的失败原因，同时把用户输入与附件还给输入栏；中止走 `aborted` 分支。失败回合的正文一律为空——流式预览会被撤回，Runtime 错误行是唯一的用户可见陈述，任何"道歉式"固定文案都不会被生成。
- `run-actions.ts` 的 `stop()` 对同一 run 只提交一次中断请求（重复点击直接被拒绝），本地流的 "正在停止" 展示由输入栏持有，run 结束即复位。
- `active-run-update.ts` 在 Runtime 接收运行中补充后按事件 id 将用户消息插入当前对话，重复响应不重复显示；真正执行由 Harness 的下一次模型请求决定。`verify:composer-stop-append` 以 Provider 请求记录确认补充进入同一 run。
- `activity-model.ts`、`task-progress-indicator.tsx`、`message-meta.tsx`、`chat-scroll-anchor.ts`、`conversation-display.ts`：活动数据变换、进度控件、消息页脚、滚动锚定和显示密度。
- **滚动位置只有一个所有者（UX-19）**：`use-chat-scroll-controller.ts` 持有底部吸附、阅读锚点与"回到最新"状态，`app-shell/chat-view.tsx` 只渲染它给出的 `onScroll`/`onClickCapture` 与按钮。读者在底部附近（`CHAT_STICKY_BOTTOM_THRESHOLD` 内）时视口变化按底边修复；**离开底部后锚点是"正在读的那条消息"而不是"离底部的距离"**——`selectChatVisibleAnchor` 记下第一条仍在视口内的 `data-message-key` 及其位置，`resolveAnchoredScrollTop` 在重排后把它放回原处，并用有界的 display-settle 逐帧收敛（宽度变化会在 ResizeObserver 通知之后继续重排，只测一次会留下尾部跳动）；锚点已不在（历史窗口替换）时不猜、不改动。新输出到达而读者不在底部时只置 `hasNewContent`，由 `.chat-jump-to-latest` 提供可达的返回入口，不把人拽到底部。**这个入口是一个圆形玻璃按钮**（2026-09-26）：与输入框同一种半透明磨砂材质、无描边、只画一个向下的天蓝箭头（`--jump-to-latest-arrow`），底边固定在**输入框可见上沿上方 3px**（`--composer-overlay-height` 从输入栏外壳量起，所以要减去外壳自己的 `--composer-shell-inset-top`；真实窗口实测 gap = 3px）。它从输入框边缘"长出来"、也"收回"输入框：`data-motion` 的三个值（`entering`/`settled`/`exiting`）由 `app-shell/chat-view.tsx` 的状态机给出，视图在 `readingAway` 变假后**多挂载一个动画时长（180 ms）**再卸载；判断"读者是否还在上面"要看 `data-motion` 或等元素消失，不要在退出窗口里按存在与否下结论（`verify:electron-ui-state-continuity` 因此把这步改成有界等待）。箭头是装饰（`pointer-events: none`），命中测试必须落在按钮本身（`verify:chat-reading-scenarios` 的 `hitIsButton` 会因此抓到图标抢命中）。**只有"换了一段对话"才重新贴底**：草稿会话在首次 run 里取得持久 id 时转写并没有换（真实窗口实测：这个瞬间重新贴底会把已经向上滚动的读者拽回底部），加载更早消息会改变首条消息 id 但会话没变——两者都必须保持读者位置；"有新内容"用消息数 + 末条 id + 末条正文长度判定，流式增长同样算新内容。**修复循环必须让位给读者**：hook 记住自己写过的 `scrollTop`，`onScroll` 看到不是自己写的滚动就立刻取消逐帧修复（真实验收里这条是必需项——不取消时"回到最新"会被旧锚点拉回，按钮永不消失）。回归：`chat-scroll-anchor.test.ts`（纯算术）与 `chat-scroll-controller-wiring.test.ts`（接线、让位规则与 CSS 契约）；真实窗口数字由 `verify:electron-ui-state-continuity` 与 `verify:chat-streaming-rendering` 记录。
- `activity-visibility.ts`：渐进披露规则。紧凑显示只折叠"无需关注"的已完成行；未成功的工具调用（含 Runtime 报告的权限拒绝）、失败或中止的准备行、失败的思考行、未通过的验证与失败步骤都必须继续可见（`compactTranscriptEntries` / `activityAttentionLine`），不得因为减少噪声而隐藏需要决定或修复的事实。**折叠只对"已不再运行"的回合生效**（`compactCompleted`），因此等待用户批准的运行中回合在两种模式下的渲染完全相同，"正在等待 write 的权限批准"这条事实在两种模式下都可读。
- `context-projections.ts`、`conversation-turn-fingerprint.ts`：上下文快照的有界无正文投影，以及跨文本、运行时、工作区和附件的稳定回合标识。
- `stream-text-integrity.test.ts`：流式文字完整性的分层探针（UX-20），用一份含标题/列表/链接/引用/代码围栏/中文标点/长段落的确定性样本驱动**真实**的 `consumeRunStream` + `assistant-delta-buffer` + `run-result-reducer`，固定住四条边界：正常流逐字节一致；畸形帧只被跳过、不连累邻居；**结果帧本身无法解析时仍以"结束却没有 result"拒绝，不静默成功**；`aborted`/`failed` 撤回预览而成功 run 用 settlement 文案覆盖预览。增删流式层的语义前先在这里改断言。

验证结论必须按 Runtime 记录呈现：`pass` 显示为“验证通过”，`unverified` 显示为“未验证”，不得渲染成“验证通过”。**两种显示模式都要能读到它**：验证结论属于活动而不是转录行，紧凑模式由 `.agent-transcript-attention` 承载，普通模式由 `activityVerificationLine` 单独渲染成一行（`data-transcript-verification`，中性样式，不带危险色）。普通模式下每个已结算回合都是 `unverified`，因此这一行是常态而不是告警——但它必须存在，否则同一份 run 在一种显示模式下"从未验证过"这件事会完全消失。活动状态只有 `running / done / failed / aborted / paused / waiting_user`，没有 partial：需要"没做完"的说法时用 `aborted`（本轮已停止）、`paused`（本轮已暂停）或 `needs_replan`（验证：需要调整），不要为清单虚构状态。LLM、工具权限和执行状态的权威实现不放在 Renderer；新增事件必须先更新 shared contract 和特征测试。

**执行过程中的"说的话"按正文颜色渲染**：`.assistant-activity-flow` 整体用 `--muted`，好让步骤、工具与思考摘要退到背景；但转录里的散文行（`.agent-transcript-prose`，模型在工具调用之间说给用户的话）不是机械过程，必须显式取回 `--text`，否则用户读到的解释比最终回答更淡、像脚注。只把这一个类改回正文色，步骤/工具/摘要/运行中状态行仍然保持 muted。真实窗口实测：散文行计算色 `rgb(232, 232, 232)`（= `--text` = `.assistant-turn` = 正文），同一容器 `rgb(160, 160, 160)`（= `--muted`）。

`run-actions.ts` 为 337 行，略高于 300 行，因为一次 run 的 SSE 顺序、步骤/工具归并、审批、停止和最终收尾必须维持同一事务边界。后续只有在建立独立事件 reducer 特征测试后才继续拆分，当前不得继续增长。
