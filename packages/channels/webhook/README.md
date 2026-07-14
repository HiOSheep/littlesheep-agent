# @littlesheep/channel-webhook

把通用 HTTP Webhook 消息适配为插件渠道事件，并把 Agent 回复发送回调用方。

## 职责与边界

- 公开入口是 `src/index.ts`；插件实现位于 `plugin.ts`，配置校验位于 `options-schema.ts`。
- 只负责消息进出、会话绑定和渠道生命周期，不实现 Agent 规划、记忆或工具权限。
- 禁止让 Webhook 服务成为本地 UI 或 Runner 启动的必要条件。

## 依赖、数据与测试

- 只依赖插件、配置和公共渠道契约，不依赖 App/Harness 私有文件。
- 渠道配置属于用户数据；请求正文只按消息生命周期处理。
- 协议、鉴权、错误与生命周期测试位于 `src/plugin.test.ts`。
