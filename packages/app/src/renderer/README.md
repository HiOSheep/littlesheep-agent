# Electron Renderer

Renderer 拥有可见交互和临时客户端状态。Main 仍是会话、项目、记忆、文件、权限、工具和持久配置的权威方。Renderer 通过领域 API client 请求能力并展示结果；不访问 Node.js、不直接读用户数据，也不决定授权。

## 结构

| 区域 | 职责 |
| --- | --- |
| `app-shell` | 组合页面，协调导航和活动会话的界面 projection。 |
| `chat` | 展示消息、活动、结算结果和对话阅读位置。 |
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

工作区路径选择只是请求；Main 按绑定的会话或项目重新检查范围。用户直接输入的交互终端不经过 Agent 审批。

## 交互契约

- 保持圆润半透明的视觉语言，复用共享 token 和组件。
- 空、加载、不可用、失败和有内容状态要明确区分。
- run 失败显示 Runtime 原因；Renderer 不编造状态或固定 Agent 回复。
- 焦点、键盘、减少动态效果和破坏性操作确认都属于交互契约。
- 组件细节与真实窗口断言由对应 owner 和测试维护；不复制逐次运行日志或测量。

## 验证

局部行为使用 Renderer 定向测试和 typecheck。涉及 BrowserWindow、原生命中、拖动区、API 策略、进程恢复或真实布局时，运行 [脚本索引](../../../../scripts/README.md) 中对应 Electron 验收；先用 `pnpm run ensure:app-build` 更新构建。
