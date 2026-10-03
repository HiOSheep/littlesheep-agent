# Renderer App Shell

App Shell 组合桌面页面，并协调聊天、设置和扩展工作区之间的导航。它拥有跨页面展示状态，不拥有会话数据、权限或领域持久化。

## 所有权

- 功能状态留在各自区域：chat、composer、sidebar、settings、workspace、runtime readiness 或 runtime recovery。
- App Shell 负责挂载页面、投影活动会话／工作区，并把用户动作交回领域回调。
- 活动项目、会话工作区绑定、就绪状态、恢复和已保存布局以 Main 为准；不能从侧栏高亮项推断。
- 就绪状态与 checkpoint 恢复不同。可恢复故障不应阻塞可用的壳层；只有依赖未就绪 Runner 的动作显示不可用状态。
- 浮层与键盘焦点归还遵循共享焦点工具。
- `appearance-preferences.ts` 是 Renderer 外观偏好的单一契约：负责版本化校验、首帧恢复、系统明暗订阅与根级主题／字阶令牌；外观值不进入 Runtime 行为配置。
- 聊天用量卡的历史入口由 App Shell 回调导航到 Token 用量设置页；用量数据仍由 Usage／Main projection 提供。
- ChatView 组合固定顶部标题／目录、独立消息区和共享输入区；标题复用 RunningPill 的重命名与运行记录，关闭标题拖动，避免任务条覆盖正文。
- 空白对话与历史读取使用共享 `VoidRing` 品牌动效；活动任务条和思考行从真实 Runtime 活动切换状态，不创建第二份运行状态。

局部 reducer 与 projection adapter 由同目录测试覆盖；导航、会话／工作区恢复和窗口生命周期使用 `verify:electron-ui-state-continuity`。
