# App Shared Contracts

保存 Electron main 与 renderer 共同使用的纯数据模型和无副作用规则。

## 边界

- 当前包含权限模式、模型能力、会话/项目、工作区、运行时、数据根、记忆控制面、附件、插件/渠道和历史活动等共享规则。
- 只能依赖纯 TypeScript 契约，不依赖 Electron、React、文件系统或网络。
- 跨 package 的稳定协议应进入 `@littlesheep/types`；仅 App 两侧共享的模型留在此处。

主要契约：`session-project-contracts.ts`、`workspace-contracts.ts`、`runtime-api-contracts.ts`、`memory-control-contracts.ts`、`attachment-contracts.ts`、`plugin-control-contracts.ts`、`channel-control-contracts.ts` 和 `local-app-api-routes.ts`。

## 测试与修改定位

- 每个共享模块均应有同目录测试。
- 修改持久化字段时同时检查 main 生产者、renderer 消费者和旧快照兼容。
