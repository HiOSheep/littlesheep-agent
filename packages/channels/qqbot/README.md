# @littlesheep/channel-qqbot

把 QQ Bot 网关事件适配为插件渠道事件，并发送 Agent 回复。

最后更新：2026-09-22 12:43:39

## 职责与边界

- 公开入口是 `src/index.ts`；插件实现位于 `plugin.ts`，配置校验位于 `options-schema.ts`。
- 只负责 QQ Bot 协议侧：access token、WebSocket 网关握手、心跳与重连、群/单聊消息映射、被动回复和渠道生命周期，不承担任务规划、记忆或工具执行。
- 禁止让渠道轮询、连接或错误阻塞本地 Agent 核心启动；渠道是可选连接器，本地 UI 不依赖它。
- 回复通过 Runner 执行，权限判定仍由统一边界决定，渠道不做豁免。

## 依赖、数据与测试

- 只依赖插件 SDK、公共契约和 zod，通过 PluginHost 接入，不使用 QQ SDK。
- App 凭证属于安全配置，不写入源码、日志或执行记录。
- 消息、鉴权、失败恢复和生命周期测试位于 `src/plugin.test.ts`。
