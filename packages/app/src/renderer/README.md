# Electron Renderer

Renderer 拥有可见交互和临时客户端状态。Main 仍是会话、项目、记忆、文件、权限、工具和持久配置的权威方。Renderer 通过领域 API client 请求能力并展示结果；不访问 Node.js、不直接读用户数据，也不决定授权。

## 结构

| 区域 | 职责 |
| --- | --- |
| `app-shell` | 组合页面，协调导航和活动会话的界面 projection。 |
| `chat` | 展示消息、活动、结算结果、对话阅读位置，以及会话内部的导航（左侧轮次标记条、首尾跳转与 Ctrl+Home／End）。 |
| `composer` | 管理草稿、模型就绪状态、焦点和 run 提交交互。 |
| `sidebar` | 导航会话与项目，呈现归档和任务控制。 |
| `settings` | 展示配置并通过 API 提交变更；外观偏好由 Renderer 单独版本化保存。 |
| `workspace` | 呈现文件、预览、review、浏览器与用户控制的终端，并让 Monaco／终端跟随应用主题。 |
| `approval` | 呈现待处理授权并收集用户选择；Main 重新判定授权。 |
| `runtime`、`runtime-events` | 保存显示选项元数据并投影运行期任务事件，不决定执行策略。 |
| `runtime-readiness`、`runtime-recovery` | 展示分阶段就绪状态和可操作的恢复信息。 |
| `usage` | 呈现有界的每日用量 projection。 |
| `ui`、`api` | 共享组件／token／焦点工具与 Local App API client；wire contract 在 `src/shared`。 |

应用级外观偏好由 `app-shell/appearance-preferences.ts` 校验、保存并在首帧前应用；它不进入 Runtime 配置或 Agent 提示词。聊天、设置、弹层、编辑器、终端和 Token 用量图表消费同一组语义色与字号令牌。

对话区（`chat` + `composer`）自 2026-10-03 起采用 DeepSeek-Harness 的设计语言：一整列有上限的阅读宽度、发丝线分隔、只有用户自己的消息带底色、过程行是单行文字、输入区是一整块实心卡片。它的 `--chat-*` 令牌定义在应用令牌层并从既有 surface／text 角色派生，因此自定义调色板仍然生效；具体契约见 `ui/README.md` 的材质角色表。

工作区路径选择只是请求；Main 按绑定的会话或项目重新检查范围。用户直接输入的交互终端不经过 Agent 审批。

## 交互契约

- 对话区沿用 DeepSeek-Harness 的平面化语言（发丝线、实心卡、单行过程流）；其它区域保留圆润半透明的视觉语言。两者都只消费共享 token 和组件。
- 空、加载、不可用、失败和有内容状态要明确区分。
- run 失败显示 Runtime 原因；Renderer 不编造状态或固定 Agent 回复。
- 焦点、键盘、减少动态效果和破坏性操作确认都属于交互契约。
- 会随内容出现滚动条的容器必须预留滚动条槽位（`scrollbar-gutter: stable`，内容居中的页面用 `both-edges`），否则内容会在有无滚动条之间左右跳动；只有声明不显示滚动条（`scrollbar-width: none`）的容器可以例外。
- 组件细节与真实窗口断言由对应 owner 和测试维护；不复制逐次运行日志或测量。

## 验证

局部行为使用 Renderer 定向测试和 typecheck。涉及 BrowserWindow、原生命中、拖动区、API 策略、进程恢复或真实布局时，运行 [脚本索引](../../../../scripts/README.md) 中对应 Electron 验收；先用 `pnpm run ensure:app-build` 更新构建。
