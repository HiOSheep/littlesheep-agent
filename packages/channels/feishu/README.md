# @littlesheep/channel-feishu

把飞书长连接事件适配为插件渠道事件，并发送 Agent 回复。

最后更新：2026-09-22 12:43:39

## 职责与边界

- 公开入口是 `src/index.ts`；插件实现位于 `plugin.ts`，配置校验位于 `options-schema.ts`。
- 只负责飞书侧传输：tenant_access_token、长连接（WebSocket）建连与重连、事件解密与 verification token 校验、消息映射、回复发送和生命周期，不承担 Agent 核心职责。
- App 凭证只在插件内部持有与刷新，禁止把飞书特有字段泄漏进 Runner 公共输入；未启用时不得启动实现。
- 回复通过 Runner 执行，权限判定仍由统一边界决定，渠道不做豁免。

## 依赖、数据与测试

- 只依赖插件 SDK、公共契约和 zod；不使用飞书 SDK，HTTP 与 WebSocket 走运行时内置能力。
- App 凭证属于安全配置，不写入源码、日志或执行记录；渠道临时状态由插件生命周期管理。
- 长连接、事件映射、错误和生命周期测试位于 `src/plugin.test.ts`。
