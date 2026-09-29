# @littlesheep/types

保存跨 package 的纯 TypeScript 契约，是运行时协议的唯一公共类型来源。公开入口为 `src/index.ts`；本包定义数据形状和端口，不实现文件系统、网络、Electron、Provider 或业务流程。

## 所有权边界

- Core Flow 当前可达状态图由 `stage-transitions.ts` 唯一声明；旧检查点格式和 retired stage 只可通过显式历史解析兼容，不能重新成为活动路由。
- `agent.ts`、`task.ts`、`message.ts` 和领域文件分别拥有 RunContext、任务、消息、工具、Memory、Web evidence、活动事件与运行状态契约。跨 package 应复用现有公共类型，不复制另一份相似 schema。
- 当前执行协议和历史读取协议分开：兼容类型供安全恢复旧记录，不扩展当前可执行能力。
- ToolContext 的文件观察与版本检查点是不同端口：前者记录本会话中模型读取的内容版本，后者服务于 run 副作用前像与回滚。
- 类型本身不拥有数据；生产者、消费者和持久化位置由对应领域 owner 说明。持久协议变更必须有兼容读取或明确迁移。
- Web durable projection 不保存网页正文、完整 query 或 Provider 原始响应；run-local 正文不得混入 checkpoint 或 execution log。

本包没有 workspace package 依赖。契约测试与源码同目录；修改公共字段时检查生产者、消费者、持久化、恢复与 Renderer projection。
