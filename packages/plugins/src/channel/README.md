# Plugin Channel Runtime

这里实现渠道插件的会话绑定、准入策略、生命周期和消息调度。

最后更新：2026-09-22 12:43:39

## 所有权

- `types.ts`：渠道运行时内部契约（`ChannelPlugin`、`ChannelContext`、进出站消息）。
- `session-binding.ts`：外部会话到 LS 会话的稳定映射，支持按渠道级联解绑。
- `policy.ts`：会话准入策略（open/allowlist/pairing/disabled）与内存配对状态。
- `manager.ts`：注册、启动、停止、移除（含级联删除会话）与 `runAgent`；`lifecycle.ts` 只提供插件退避用的 `abortableDelay`。

## 边界与测试

- 具体协议留在 `packages/channels/*`，这里不依赖 Telegram、飞书、QQ 或 Webhook 私有实现。
- 渠道只负责消息进出，不拥有 Agent Workflow 或本地 UI 生命周期；`runAgent` 仍走 Runner 的统一权限边界，渠道不豁免审批。
- 渠道是可选连接器，本地 UI 不依赖任何渠道启动。
- 每个运行时模块（binding/policy/lifecycle/manager）均有同目录测试；修改绑定格式时验证重启恢复和渠道隔离。
