# @littlesheep/types

保存跨 package 的纯 TypeScript 契约，是运行时协议的唯一公共类型来源。

## 职责与边界

- 公开入口是 `src/index.ts`；`task.ts` 独立拥有需求校准、TaskBook、步骤执行与验证契约，`agent.ts` 拥有状态机、RunContext 与 Hook 契约，`web-retrieval.ts` 拥有 provider 无关、可序列化且有界的网络策略、搜索、抓取、引用、错误和证据投影契约，其余消息、会话、工具、记忆和运行协议也按领域文件分组。
- 只定义稳定数据结构和端口，不实现文件系统、网络、Electron、Provider 或业务流程。
- 禁止依赖其他 workspace package，禁止放入只被单一文件使用的内部实现类型。

## 数据所有权

- 类型不拥有数据；生产者、消费者和持久化位置必须在对应领域说明中明确。
- 版本化持久协议变更必须保留兼容解析或显式迁移。
- `FetchedDocument.content` 只用于 run-local 证据；`ToolResult`、checkpoint 和 execution log 只能持久化不含正文和原始 query 的 `WebEvidenceProjection`。

## 测试与修改定位

- 运行契约测试位于 `src/runtime-contracts.test.ts`。
- 修改公共字段时搜索所有生产者、消费者、日志、恢复路径和 renderer 类型投影。
