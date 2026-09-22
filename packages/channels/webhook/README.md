# @littlesheep/channel-webhook

把本机 HTTP Webhook 消息适配为插件渠道事件，并把 Agent 回复发送回调用方。

最后更新：2026-09-22 12:43:39

## 职责与边界

- 公开入口是 `src/index.ts`；插件实现位于 `plugin.ts`，配置校验位于 `options-schema.ts`。
- 只负责消息进出和渠道生命周期：仅监听 `127.0.0.1`，限制请求体大小，可选 HMAC-SHA256 验签与 Bearer 鉴权，并提供 `GET` 健康检查；会话绑定仍由共享渠道运行时拥有，插件不实现 Agent 规划、记忆或工具权限。
- 禁止让 Webhook 服务成为本地 UI 或 Runner 启动的必要条件。
- 回复通过 Runner 执行，权限判定仍由统一边界决定，渠道不做豁免。

## 依赖、数据与测试

- 只依赖插件 SDK、公共契约和 zod，不依赖 App/Harness 私有文件。
- 渠道配置属于用户数据；请求正文只按消息生命周期处理。
- 协议、鉴权、错误与生命周期测试位于 `src/plugin.test.ts` 和 `src/channel-integration.test.ts`。
