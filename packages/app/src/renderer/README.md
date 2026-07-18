# Electron Renderer

Renderer 负责聊天、导航、设置、记忆树、归档和拓展工作区的可视交互。

## 入口与所有权

- `main.tsx`：React 挂载。
- `App.tsx`：7 行兼容入口，只装配 `app-shell` 控制器和视图。
- `app-shell/`：顶层视图、导航历史和控制器组合。
- `ui/display-frame.ts`、`ui/display-synced-settle.ts`：合并重复失效请求，并基于 `requestAnimationFrame` 时间戳进行有界布局收敛；当前显示器 VSync 是有效 FPS 上限，稳定后不再申请帧。
- `approval/`、`chat/`、`composer/`、`runtime/`、`settings/`、`sidebar/`、`ui/`、`workspace/`：按责任域拆分的 Renderer 实现。
- `api.ts`：21 行 Local App API 兼容 barrel；领域客户端位于 `api/`。
- `TraceCard.tsx`、`MemoryTreeView.tsx`、`ArchiveManager.tsx`、`Settings.tsx`：仍保留的独立领域视图；其中记忆页只显示六份记忆文件并仅允许编辑 `SOUL.md`，不承载 Atom 管理。
- `chat/assistant-turn.tsx`：一轮 Agent 的思考摘要、真实执行过程、验证和最终结果渐进披露。
- `Markdown.tsx`、`link-navigation.tsx`、`workspace/browser.tsx`：全局链接单击进入 LS 内置预览；网页由独立的有界 URL 历史驱动前进、后退和刷新，网页内部跳转不会污染全局应用导航。
- `workspace/preview-pane.tsx` 与主进程 Office 预览服务：代码/文本/Markdown 使用内置编辑器，Office/OpenDocument 以有界只读文本预览呈现；二进制正文不进入 Renderer。

Renderer 拥有临时 UI 状态和交互编排，不拥有会话、记忆、项目、密钥或工作区文件的权威数据。

用户可见的 Agent 自然语言也不由 Renderer 临时拼装：回复、澄清、任务说明、步骤摘要、验证说明和交付表达必须由真实 LLM 调用结合运行时 `SOUL.md`、用户语言与已验证事实生成。Renderer 只稳定呈现已在持久化会话注册表中通过原子精确去重的文案，以及按钮、状态枚举、进度、路径、权限结果等机器事实；同一文案只能用于同一 UI 回合的更新、日志和持久化，不能再次发送为重复消息。模型不可用、注册表不可用、空回复或重复改写耗尽时，Renderer 只呈现 Runtime 错误/状态，不呈现固定人格降级文案。

## 依赖与禁止事项

- 只能通过 `api.ts` 或后续领域客户端访问主进程能力。
- 禁止直接使用 Node.js、读写用户数据、复制主进程索引或自行执行工具。
- 动画、浮层、导航和渐进式披露遵守 `docs/principles/ui-interaction-guidelines.md`。

## 测试与修改定位

- 纯状态、历史、布局和 Context 展示测试与实现同目录；跨域行为优先添加 shared contract 或 controller 特征测试。
- 视觉或交互变更还需构建、刷新桌面快捷方式并进行真实窗口验收。
