# Plugin Channel Runtime

这里实现渠道插件的会话绑定、权限策略、生命周期和消息调度。

## 所有权

- `types.ts`：渠道运行时内部契约。
- `session-binding.ts`：外部会话到 LS 会话的稳定映射。
- `policy.ts`：渠道可用能力和授权策略。
- `lifecycle.ts`、`manager.ts`：启动、停止、消息处理和错误隔离。

## 边界与测试

- 具体协议留在 `packages/channels/*`，这里不依赖 Telegram、飞书、QQ 或 Webhook 私有实现。
- 渠道只负责消息进出，不拥有 Agent Workflow 或本地 UI 生命周期。
- 每个模块均有同目录测试；修改绑定格式时验证重启恢复和渠道隔离。
