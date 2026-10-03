# Renderer Chat

Chat 呈现对话记录并管理阅读交互。Main 与 Runner 拥有已保存消息、run 结算、执行证据、授权和恢复状态。

## 职责与边界

- 呈现已保存消息、流式输出、工具／活动摘要、验证状态、附件、引用和最终产物。
- 失败、中止、暂停、等待用户与未验证状态保留 Runtime 给出的原因；不补造部分状态，也不以固定文案替代缺失的模型回复。
- Web 资料始终是不可信输入；blocked、partial、stale、timeout 与 cached 状态按来源 projection 保留。
- retry、branch、copy 与 usage 等操作通过明确回调请求；Main 判断分支或持久化动作是否合法。
- 单轮用量卡提供次级“查看历史用量”入口，并通过 App Shell 导航到设置中的 Token 用量页；日聚合仍只读取 Usage projection。
- `use-chat-scroll-controller` 管理阅读位置：读者在底部时跟随新内容，否则保留可见消息锚点并提供可达的“回到最新”。真实会话切换可重置位置，加载旧历史或分配草稿 session id 不应重置。
- 重载后展示与持久化结算一致的文本；Renderer 不复制或改写模型最终回复。
- 阅读布局由 `styles/20-chat-reading.css` 统一：标题与目录在固定顶部区，正文独立滚动，输入区在布局中实际占据底部高度；正文不会滚入或露出输入区底边，窄列允许控制行换行。
- 视觉语言自 2026-10-03 起是 DeepSeek-Harness 的平面化版本：对话只有一列有上限的阅读宽度（输入卡上限 780px，正文列是它减去 32px、上限 748px），只有用户自己的消息带底色气泡，助手回复是纯正文；过程行是同一条 24px 行盒上的单行文字，展开的详情是发丝线面板而不是卡片。`--chat-*` 令牌与材质角色见 `ui/README.md`。
- `navigation-model` 将问答合为一轮目录，支持按轮次与摘要搜索；选择后复用 scroll controller 跳转并收起，方向键、Esc 与外部点击管理列表和焦点。
- 运行／停止／失败／暂停／等待处理的过程保持可见，成功完成后才默认折叠；展开完整保留模型进展与工具顺序。思考默认单行预览、点击展开全文；工具行悬浮将图标换为同位置的展开箭头，文件按钮直接打开实际路径。最后一条与回复一致的文本只在主阅读区展示一次。已记录失败与验证限制不随折叠消失。
- 对话区（不含输入区）悬浮只高亮文字／图标，不创建悬浮说明框或原生 title 提示。用量、执行记录与目录由点击展开，支持关闭按钮、Esc 和焦点返回；字段／控件的可访问名称保留。


对话活动是 Runtime 状态的展示，不是第二份任务状态。工具输出可折叠，失败、授权决定与验证限制必须可见。Markdown／代码展示要保留复制失败、引用、清洗与长输出边界；引用只能来自本轮 Runtime 签发的 citation。

定向测试覆盖组件行为；`node scripts/verify-chat-reading-layout.mjs` 使用隔离 Electron 和本地 Provider 验证固定布局、目录搜索／键盘／跳转、窄列草稿、停止入口及失败折叠；`verify:chat-streaming-rendering` 检查流式文本与结算一致，`verify:electron-ui-state-continuity` 检查真实窗口的滚动与会话行为。源码测试不能证明 Electron 几何或辅助技术输出。上下文来源汇总为次级展开行；系统提示词只提供明确查看入口。手动展开过程、思考或工具时退出自动跟随，避免阅读位置被新输出拉走。

## DSH 对话呈现来源

2026-10-03 对照本机 `@deepseek-ai/dsh` 0.1.7-rc.2 前端分发源码：`dsh-client-ui-chat/lib/client.js` 的 ChatView／TurnProcessNodeView／ReasoningRow／MessageIconActions，`dsh-client-ui-tool/lib/client.js` 的 ToolRow，以及 primitives 的 DisclosureRow 和 conversation 的 InputBar。使用其布局与交互规则适配 LS 组件，没有引入 DSH 运行时、会话状态或模型回复文案。LS 的授权、失败和验证投影仍是唯一事实来源。主过程只对成功结束的回合开放整体折叠；思考和工具详情始终可分别展开。
