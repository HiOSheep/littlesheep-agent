# Electron Renderer
最后更新：2026-09-22 13:10:04

Renderer 负责聊天、导航、设置、记忆树、归档和拓展工作区的可视交互。

## 入口与所有权

- `main.tsx`：React 挂载。
- `App.tsx`：7 行兼容入口，只装配 `app-shell` 控制器和视图。
- `app-shell/`：顶层视图、导航历史和控制器组合。
- `ui/display-frame.ts`、`ui/display-synced-settle.ts`：合并重复失效请求，并基于 `requestAnimationFrame` 时间戳进行有界布局收敛；当前显示器 VSync 是有效 FPS 上限，稳定后不再申请帧。
- `approval/`、`chat/`、`composer/`、`runtime/`、`settings/`、`sidebar/`、`ui/`、`workspace/`：按责任域拆分的 Renderer 实现。
- `api.ts`：22 行 Local App API 兼容 barrel；领域客户端位于 `api/`。
- `TraceCard.tsx`、`MemoryTreeView.tsx`、`ArchiveManager.tsx`、`MemorySkills.tsx`、`ChannelConnections.tsx`：仍保留的独立领域视图，由 `settings/workspace.tsx` 的归档、技能和外部渠道页复用；其中记忆页只显示六份权威记忆文件并仅允许编辑 `SOUL.md`，不承载 Atom、向量或记忆写入入口。
- `settings/models.tsx`、`settings/model-provider-editor.tsx`、`settings/model-provider-draft.ts`：模型供应商页的卡片视图、编辑对话框和纯校验；自定义提供方使用 OpenAI 兼容接口，密钥经 Main 写入系统密钥库，模型元数据（上下文窗口、最大输出、推理档位）只按用户声明使用，未声明即保持未知。
- `chat/assistant-turn.tsx`：一轮 Agent 的思考摘要、真实执行过程、验证和最终结果渐进披露。
- `Markdown.tsx`、`link-navigation.tsx`、`workspace/browser.tsx`：全局链接单击进入 LS 内置预览；网页由独立的有界 URL 历史驱动前进、后退和刷新，网页内部跳转不会污染全局应用导航。
- `workspace/preview-pane.tsx`、`workspace/code-editor.tsx` 与主进程 Office 预览服务：代码和普通文本使用共享内置编辑器；普通 Markdown 文件默认渲染，查看源码或编辑时才挂载共享 Monaco，而 Git 审阅中的 Markdown 仍显示源代码 Diff。普通文件和审阅主表面铺满拓展工作区的可用宽度与底部，不绘制外围圆角、边框或整面 hover 反馈；右侧文件导航贴边并仅保留左分隔线。普通查看和审阅统一保留舒适的行号/代码间距；审阅行号、增删计数与连续 5px 左缘使用不透明的 `#02A243` / `#DE352E`，代码行使用在 `#101010` 上合成为 `#1A2B1C` / `#371D17` 的单层 50% 透明底色；单列内联删除视图区也绘制整段连续红色左缘，字符级背景、整块 gutter 背景及会形成方块伪影的 Diff text border 均不绘制；Office/OpenDocument 以有界只读文本预览呈现，二进制正文不进入 Renderer。

Renderer 拥有临时 UI 状态和交互编排，不拥有会话、记忆、项目、密钥或工作区文件的权威数据。

用户可见的 Agent 自然语言也不由 Renderer 拼装：回复、澄清、任务说明、步骤摘要、验证说明和交付表达必须来自真实 LLM 调用，并结合运行时 `SOUL.md`、用户语言与已验证事实。Renderer 只呈现 Runtime 下发的最终文案，以及按钮、状态枚举、进度、路径、权限结果等机器事实；发布身份、幂等和去重由 Runtime 的持久化会话注册表负责，Renderer 不因措辞与上一回合相同而合并、改写或抑制消息，也不在回复为空时套用固定人格文案，只显示 Runtime 错误/状态。

## 依赖与禁止事项

- 只能通过 `api.ts` 或后续领域客户端访问主进程能力。
- 禁止直接使用 Node.js、读写用户数据、复制主进程索引或自行执行工具。
- 动画、浮层、导航和渐进式披露遵守 `docs/principles/ui-interaction-guidelines.md`。

## 测试与修改定位

- 纯状态、历史、布局和 Context 展示测试与实现同目录；跨域行为优先添加 shared contract 或 controller 特征测试。
- 视觉或交互变更还需构建、刷新桌面快捷方式并进行真实窗口验收。
