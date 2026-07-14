# @littlesheep/channel-feishu

把飞书事件和消息 API 适配为插件渠道事件，并发送 Agent 回复。

## 职责与边界

- 公开入口是 `src/index.ts`；插件实现位于 `plugin.ts`，配置校验位于 `options-schema.ts`。
- 只负责飞书验签、事件映射、回复和生命周期，不承担 Agent 核心职责。
- 禁止把飞书特有字段泄漏进 Runner 公共输入，未启用时不得启动实现。

## 依赖、数据与测试

- 只依赖插件、配置和公共契约。
- App 凭证属于安全配置，渠道临时状态由插件生命周期管理。
- 验签、消息、错误和生命周期测试位于 `src/plugin.test.ts`。
