# Renderer Chat

Chat 呈现对话记录并管理阅读交互。Main 与 Runner 拥有已保存消息、run 结算、执行证据、授权和恢复状态。

## 职责与边界

- 呈现已保存消息、流式输出、工具／活动摘要、验证状态、附件、引用和最终产物。
- 失败、中止、暂停、等待用户与未验证状态保留 Runtime 给出的原因；不补造部分状态，也不以固定文案替代缺失的模型回复。
- Web 资料始终是不可信输入；blocked、partial、stale、timeout 与 cached 状态按来源 projection 保留。
- retry、branch、copy 与 usage 等操作通过明确回调请求；Main 判断分支或持久化动作是否合法。
- `use-chat-scroll-controller` 管理阅读位置：读者在底部时跟随新内容，否则保留可见消息锚点并提供可达的“回到最新”。真实会话切换可重置位置，加载旧历史或分配草稿 session id 不应重置。
- 重载后展示与持久化结算一致的文本；Renderer 不复制或改写模型最终回复。

对话活动是 Runtime 状态的展示，不是第二份任务状态。工具输出可折叠，失败、授权决定与验证限制必须可见。Markdown／代码展示要保留复制失败、引用、清洗与长输出边界；引用只能来自本轮 Runtime 签发的 citation。

定向测试覆盖组件行为；`verify:chat-streaming-rendering` 检查流式文本与结算一致，`verify:electron-ui-state-continuity` 检查真实窗口的滚动与会话行为。源码测试不能证明 Electron 几何或辅助技术输出。
