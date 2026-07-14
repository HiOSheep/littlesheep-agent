# @littlesheep/channel-telegram

把 Telegram Bot 更新适配为插件渠道事件，并发送 Agent 回复。

## 职责与边界

- 公开入口是 `src/index.ts`；插件实现位于 `plugin.ts`，配置校验位于 `options-schema.ts`。
- 只负责 Telegram 协议、消息映射和渠道生命周期，不复制 Runner、会话或权限逻辑。
- 禁止在未配置渠道时导入或启动 Telegram 实现。

## 依赖、数据与测试

- 只依赖插件、配置和公共契约；通过 PluginHost 接入核心。
- Bot token 属于安全配置，不写入日志或仓库。
- 消息、重试、生命周期和失败隔离测试位于 `src/plugin.test.ts`。
