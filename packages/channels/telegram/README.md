# @littlesheep/channel-telegram

把 Telegram Bot 更新适配为插件渠道事件，并发送 Agent 回复。

最后更新：2026-09-22 12:43:39

## 职责与边界

- 公开入口是 `src/index.ts`；插件实现位于 `plugin.ts`，配置校验位于 `options-schema.ts`。
- 只负责 Telegram 协议侧：token 校验、`getUpdates` 长轮询、消息映射、分段回复和渠道生命周期，不复制 Runner、会话或权限逻辑。
- 禁止在未配置渠道时导入或启动 Telegram 实现；渠道是可选连接器，本地 UI 不依赖它。
- 回复通过 Runner 执行，权限判定仍由统一边界决定，渠道不做豁免。

## 依赖、数据与测试

- 只依赖插件 SDK、公共契约和 zod，通过 PluginHost 接入核心，不使用 Telegram SDK。
- Bot token 属于安全配置，不写入日志或仓库。
- 消息、重试、生命周期和失败隔离测试位于 `src/plugin.test.ts`。
