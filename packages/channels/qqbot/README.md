# @littlesheep/channel-qqbot

把 QQ Bot 事件适配为插件渠道事件，并发送 Agent 回复。

## 职责与边界

- 公开入口是 `src/index.ts`；插件实现位于 `plugin.ts`，配置校验位于 `options-schema.ts`。
- 只负责 QQ Bot 协议、消息映射和渠道生命周期，不承担任务规划、记忆或工具执行。
- 禁止让渠道轮询、连接或错误阻塞本地 Agent 核心启动。

## 依赖、数据与测试

- 只依赖插件、配置和公共契约，通过 PluginHost 接入。
- App 凭证属于安全配置，不写入源码、日志或执行记录。
- 消息、鉴权、失败恢复和生命周期测试位于 `src/plugin.test.ts`。
